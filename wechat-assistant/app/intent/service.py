from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.faq.service import normalize_text
from app.intent.embeddings import IntentEmbeddingService, cosine_similarity
from app.intent.taxonomy import (
    default_course_definitions,
    default_intent_definitions,
)
from app.models.entities import CourseDefinition, IntentDefinition
from app.retrieval.bm25 import rank_bm25


@dataclass(frozen=True)
class CourseCandidate:
    course_code: str
    course_name: str
    score: float
    match_type: str
    bm25_rank: int | None = None


@dataclass(frozen=True)
class IntentRecallCandidate:
    definition: IntentDefinition
    score: float
    rrf_score: float
    match_type: str
    lexical_score: float | None = None
    embedding_score: float | None = None
    lexical_rank: int | None = None
    embedding_rank: int | None = None


class IntentService:
    def __init__(
        self,
        *,
        embedding_service: IntentEmbeddingService | None = None,
    ) -> None:
        self.settings = get_settings()
        self.embedding_service = embedding_service or IntentEmbeddingService(
            settings=self.settings
        )

    def ensure_default_definitions(self, db: Session) -> list[IntentDefinition]:
        self.ensure_default_courses(db)
        existing = {
            definition.intent_id: definition
            for definition in db.scalars(select(IntentDefinition))
        }
        changed = False
        for payload in default_intent_definitions():
            if payload["intent_id"] in existing:
                continue
            definition = IntentDefinition(**payload)
            db.add(definition)
            existing[definition.intent_id] = definition
            changed = True
        if changed:
            db.commit()
        return list(existing.values())

    def ensure_default_courses(self, db: Session) -> list[CourseDefinition]:
        existing = {
            course.course_code: course
            for course in db.scalars(select(CourseDefinition))
        }
        changed = False
        for payload in default_course_definitions():
            if payload["course_code"] in existing:
                continue
            course = CourseDefinition(**payload)
            db.add(course)
            existing[course.course_code] = course
            changed = True
        if changed:
            db.commit()
        return list(existing.values())

    def list_active_courses(
        self,
        db: Session,
        *,
        include_general: bool = True,
    ) -> list[CourseDefinition]:
        courses = [
            course
            for course in self.ensure_default_courses(db)
            if course.is_active
            and not course.is_deleted
            and (
                include_general
                or course.course_code not in {"general", "conversation"}
            )
        ]
        courses.sort(key=lambda course: course.created_at)
        return courses

    def rank_courses(
        self,
        db: Session,
        queries: list[str],
    ) -> list[CourseCandidate]:
        definitions = self.ensure_default_definitions(db)
        courses = self.list_active_courses(db)
        definitions_by_course: dict[str, list[IntentDefinition]] = {}
        for definition in definitions:
            if definition.is_active:
                definitions_by_course.setdefault(
                    definition.course_code,
                    [],
                ).append(definition)

        candidates: list[CourseCandidate] = []
        course_documents = [
            _course_document(course, definitions_by_course.get(course.course_code, []))
            for course in courses
        ]
        course_terms = [
            value
            for course in courses
            for value in (
                course.display_name,
                *(course.aliases or []),
            )
        ]
        bm25_ranks_by_query = [
            {
                courses[hit.index].course_code: rank
                for rank, hit in enumerate(
                    rank_bm25(
                        query,
                        course_documents,
                        custom_terms=course_terms,
                    ),
                    start=1,
                )
            }
            for query in queries
        ]
        for course in courses:
            definitions_for_course = definitions_by_course.get(
                course.course_code,
                [],
            )
            score = 0.0
            match_type = "similar"
            explicit_score = 0.0
            bm25_rank: int | None = None
            for query_index, query in enumerate(queries):
                normalized_query = normalize_text(query)
                if not normalized_query:
                    continue
                query_bm25_rank = bm25_ranks_by_query[query_index].get(
                    course.course_code
                )
                if query_bm25_rank is not None:
                    bm25_rank = min(
                        bm25_rank or query_bm25_rank,
                        query_bm25_rank,
                    )
                for alias in (course.display_name, *(course.aliases or [])):
                    normalized_alias = normalize_text(alias)
                    if normalized_query == normalized_alias:
                        explicit_score = max(explicit_score, 1.0)
                    elif normalized_alias and normalized_alias in normalized_query:
                        coverage = len(normalized_alias) / max(
                            1,
                            len(normalized_query),
                        )
                        explicit_score = max(
                            explicit_score,
                            0.9 + 0.09 * min(1.0, coverage),
                        )
                course_score = _best_text_score(
                    normalized_query,
                    (
                        course.display_name,
                        course.description,
                        *(course.aliases or []),
                    ),
                )
                example_score = max(
                    (
                        _best_text_score(
                            normalized_query,
                            definition.positive_examples or [],
                        )
                        for definition in definitions_for_course
                    ),
                    default=0.0,
                )
                score = max(score, course_score, example_score)
            if explicit_score:
                score = explicit_score
                match_type = (
                    "course_exact"
                    if explicit_score == 1.0
                    else "course_contains"
                )
            elif score > 0:
                match_type = (
                    "course_bm25"
                    if bm25_rank is not None
                    else "course_text"
                )
            if score >= self.settings.intent_course_recall_threshold:
                candidates.append(
                    CourseCandidate(
                        course_code=course.course_code,
                        course_name=course.display_name,
                        score=score,
                        match_type=match_type,
                        bm25_rank=bm25_rank,
                    )
                )

        explicit_candidates = [
            candidate
            for candidate in candidates
            if candidate.match_type in {"course_exact", "course_contains"}
        ]
        if explicit_candidates:
            explicit_candidates.sort(
                key=lambda candidate: candidate.score,
                reverse=True,
            )
            return explicit_candidates

        candidates.sort(
            key=lambda candidate: (
                candidate.score,
                -(candidate.bm25_rank or 10_000),
            ),
            reverse=True,
        )
        return candidates

    def rank_intents(
        self,
        db: Session,
        queries: list[str],
        *,
        course_code: str,
        domain: str = "course",
        limit: int | None = None,
    ) -> list[IntentRecallCandidate]:
        self.ensure_default_definitions(db)
        definitions = list(
            db.scalars(
                select(IntentDefinition)
                .where(
                    IntentDefinition.is_active.is_(True),
                    IntentDefinition.is_deleted.is_(False),
                    IntentDefinition.domain == domain,
                    IntentDefinition.course_code == course_code,
                )
                .order_by(IntentDefinition.intent_id)
            )
        )
        if not definitions:
            return []

        unique_queries = _intent_queries(
            queries,
            db.get(CourseDefinition, course_code),
        )
        exact: dict[str, IntentRecallCandidate] = {}
        lexical: dict[str, tuple[float, float, int]] = {}
        embedding: dict[str, tuple[float, float, int]] = {}
        rrf_k = max(1, self.settings.intent_rrf_k)
        text_weight = max(0.0, self.settings.intent_rrf_text_weight)
        vector_weight = max(0.0, self.settings.intent_rrf_vector_weight)

        for query in unique_queries:
            ranked = self._lexical_ranking(query, definitions)
            for rank, (definition, score, match_type) in enumerate(
                ranked[: self.settings.intent_candidate_pool_limit],
                start=1,
            ):
                if match_type == "exact":
                    exact.setdefault(
                        definition.intent_id,
                        IntentRecallCandidate(
                            definition=definition,
                            score=1.0,
                            rrf_score=1.0,
                            match_type="exact",
                            lexical_score=score,
                            lexical_rank=rank,
                        ),
                    )
                _keep_best(
                    lexical,
                    definition.intent_id,
                    contribution=text_weight / (rrf_k + rank),
                    raw_score=score,
                    rank=rank,
                )

        candidate_limit = limit or self.settings.intent_candidate_limit
        if exact:
            values = list(exact.values())
            values.sort(key=lambda candidate: candidate.definition.intent_id)
            return values[:candidate_limit]

        vectors = self.embedding_service.ensure_embeddings(db, definitions)
        vector_available = False
        for query in unique_queries:
            if not vectors:
                break
            query_vector = self.embedding_service.embed_query(query)
            if query_vector is None:
                continue
            vector_available = True
            ranked = [
                (
                    definition,
                    cosine_similarity(
                        query_vector,
                        vectors[definition.intent_id],
                    ),
                )
                for definition in definitions
                if definition.intent_id in vectors
            ]
            ranked = [
                item
                for item in ranked
                if item[1] >= self.settings.intent_embedding_min_similarity
            ]
            ranked.sort(key=lambda item: item[1], reverse=True)
            for rank, (definition, score) in enumerate(
                ranked[: self.settings.intent_candidate_pool_limit],
                start=1,
            ):
                _keep_best(
                    embedding,
                    definition.intent_id,
                    contribution=vector_weight / (rrf_k + rank),
                    raw_score=score,
                    rank=rank,
                )

        active_vector_weight = vector_weight if vector_available else 0.0
        maximum_rrf = (text_weight + active_vector_weight) / (rrf_k + 1)
        candidates: list[IntentRecallCandidate] = []
        for definition in definitions:
            lexical_value = lexical.get(definition.intent_id)
            embedding_value = embedding.get(definition.intent_id)
            if not lexical_value and not embedding_value:
                continue
            rrf = (lexical_value[0] if lexical_value else 0.0) + (
                embedding_value[0] if embedding_value else 0.0
            )
            lexical_score = lexical_value[1] if lexical_value else None
            embedding_score = embedding_value[1] if embedding_value else None
            raw_score = max(
                lexical_score or 0.0,
                embedding_score or 0.0,
            )
            if lexical_score is not None and embedding_score is not None:
                raw_score = min(
                    1.0,
                    raw_score + self.settings.intent_consensus_bonus,
                )
            candidates.append(
                IntentRecallCandidate(
                    definition=definition,
                    score=raw_score,
                    rrf_score=min(rrf / maximum_rrf, 1.0)
                    if maximum_rrf
                    else 0.0,
                    match_type=(
                        "intent_rrf"
                        if lexical_score is not None and embedding_score is not None
                        else "intent_text"
                        if lexical_score is not None
                        else "intent_embedding"
                    ),
                    lexical_score=lexical_score,
                    embedding_score=embedding_score,
                    lexical_rank=lexical_value[2] if lexical_value else None,
                    embedding_rank=embedding_value[2] if embedding_value else None,
                )
            )
        candidates.sort(
            key=lambda candidate: (
                candidate.rrf_score,
                candidate.score,
            ),
            reverse=True,
        )
        return candidates[:candidate_limit]

    def _lexical_ranking(
        self,
        query: str,
        definitions: list[IntentDefinition],
    ) -> list[tuple[IntentDefinition, float, str]]:
        normalized_query = normalize_text(query)
        exact_matches: list[tuple[IntentDefinition, float, str]] = []
        confidence_by_id: dict[str, tuple[float, str]] = {}
        for definition in definitions:
            positive_values = (
                definition.display_name,
                definition.description,
                *(definition.positive_examples or []),
            )
            score, match_type = _best_text_match(
                normalized_query,
                positive_values,
            )
            negative_score = _best_text_score(
                normalized_query,
                definition.negative_examples or [],
            )
            if negative_score >= 0.84 and negative_score >= score:
                continue
            confidence_by_id[definition.intent_id] = (score, match_type)
            if match_type == "exact":
                exact_matches.append((definition, score, match_type))
        if exact_matches:
            exact_matches.sort(key=lambda item: item[0].intent_id)
            return exact_matches

        documents = [_intent_document(definition) for definition in definitions]
        custom_terms = [
            value
            for definition in definitions
            for value in (
                definition.course_name,
                definition.display_name,
                *(definition.positive_examples or []),
            )
        ]
        ranked: list[tuple[IntentDefinition, float, str]] = []
        for hit in rank_bm25(
            query,
            documents,
            custom_terms=custom_terms,
        ):
            definition = definitions[hit.index]
            confidence = confidence_by_id.get(definition.intent_id)
            if confidence is None:
                continue
            score, _ = confidence
            if score < self.settings.intent_text_min_similarity:
                continue
            ranked.append((definition, score, "bm25"))
        return ranked


def _best_text_match(
    normalized_query: str,
    values,
) -> tuple[float, str]:
    best_score = 0.0
    best_type = "similar"
    for value in values:
        normalized_value = normalize_text(value)
        if not normalized_value:
            continue
        if normalized_query == normalized_value:
            return 1.0, "exact"
        score = SequenceMatcher(None, normalized_query, normalized_value).ratio()
        match_type = "similar"
        shorter, longer = sorted((normalized_query, normalized_value), key=len)
        if len(shorter) >= 3 and shorter in longer:
            score = max(score, 0.84 + 0.12 * len(shorter) / len(longer))
            match_type = "contains"
        overlap = _ngram_overlap(normalized_query, normalized_value)
        if overlap > score:
            score = overlap
            match_type = "similar"
        if score > best_score:
            best_score = score
            best_type = match_type
    return best_score, best_type


def _best_text_score(normalized_query: str, values) -> float:
    return _best_text_match(normalized_query, values)[0]


def _course_document(
    course: CourseDefinition,
    definitions: list[IntentDefinition],
) -> str:
    values = [
        course.display_name,
        course.description,
        *(course.aliases or []),
        *(
            example
            for definition in definitions
            for example in (definition.positive_examples or [])
        ),
    ]
    return "\n".join(value.strip() for value in values if value.strip())


def _intent_document(definition: IntentDefinition) -> str:
    values = [
        definition.course_name,
        definition.display_name,
        definition.description,
        *(definition.positive_examples or []),
    ]
    return "\n".join(value.strip() for value in values if value.strip())


def _ngram_overlap(left: str, right: str, size: int = 2) -> float:
    left_grams = _ngrams(left, size)
    right_grams = _ngrams(right, size)
    if not left_grams or not right_grams:
        return 0.0
    return len(left_grams & right_grams) / len(left_grams | right_grams)


def _ngrams(value: str, size: int) -> set[str]:
    if len(value) < size:
        return {value} if value else set()
    return {
        value[index : index + size]
        for index in range(len(value) - size + 1)
    }


def _unique_queries(values: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = normalize_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(value.strip())
    return result


def _intent_queries(
    values: list[str],
    course: CourseDefinition | None,
) -> list[str]:
    if course is None:
        return _unique_queries(values)

    aliases = sorted(
        {
            normalize_text(course.display_name),
            *(normalize_text(alias) for alias in (course.aliases or [])),
        },
        key=len,
        reverse=True,
    )
    stripped: list[str] = []
    for value in values:
        normalized = normalize_text(value)
        for alias in aliases:
            if alias:
                normalized = normalized.replace(alias, "")
        if normalized:
            stripped.append(normalized)
    return _unique_queries(stripped) or _unique_queries(values)


def _keep_best(
    values: dict[str, tuple[float, float, int]],
    intent_id: str,
    *,
    contribution: float,
    raw_score: float,
    rank: int,
) -> None:
    previous = values.get(intent_id)
    if previous is None or contribution > previous[0]:
        values[intent_id] = (contribution, raw_score, rank)
