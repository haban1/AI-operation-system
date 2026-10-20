from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.faq.embeddings import FAQEmbeddingService, cosine_similarity
from app.models.entities import FAQEntry
from app.retrieval.bm25 import rank_bm25


@dataclass(frozen=True)
class FAQCandidate:
    entry: FAQEntry
    score: float
    match_type: str
    lexical_score: float | None = None
    embedding_score: float | None = None
    lexical_rank: int | None = None
    embedding_rank: int | None = None


@dataclass(frozen=True)
class FAQMatch:
    entry: FAQEntry | None
    score: float
    match_type: str
    candidates: list[FAQCandidate]
    margin: float


class FAQService:
    def __init__(
        self,
        *,
        threshold: float | None = None,
        embedding_service: FAQEmbeddingService | None = None,
    ) -> None:
        self.settings = get_settings()
        self.threshold = threshold if threshold is not None else self.settings.faq_match_threshold
        self.embedding_service = embedding_service or FAQEmbeddingService(settings=self.settings)

    def match(self, db: Session, question: str) -> FAQMatch:
        candidates = self.rank(db, question)
        if not candidates:
            return FAQMatch(entry=None, score=0.0, match_type="none", candidates=[], margin=0.0)
        best = candidates[0]
        margin = _candidate_margin(candidates)
        if best.score < self.threshold:
            return FAQMatch(
                entry=None,
                score=best.score,
                match_type="none",
                candidates=candidates,
                margin=margin,
            )
        return FAQMatch(
            entry=best.entry,
            score=best.score,
            match_type=best.match_type,
            candidates=candidates,
            margin=margin,
        )

    def rank(
        self,
        db: Session,
        question: str,
        *,
        limit: int | None = None,
        include_zero: bool = False,
        course_code: str | None = None,
        intent_code: str | None = None,
    ) -> list[FAQCandidate]:
        normalized_question = normalize_text(question)
        if not normalized_question:
            return []

        stmt = select(FAQEntry).where(FAQEntry.is_active.is_(True))
        if course_code is not None:
            stmt = stmt.where(FAQEntry.course_code == course_code)
        if intent_code is not None:
            stmt = stmt.where(FAQEntry.intent_code == intent_code)
        entries = list(
            db.scalars(
                stmt.order_by(
                    FAQEntry.priority.desc(),
                    FAQEntry.hit_count.desc(),
                    FAQEntry.created_at.desc(),
                )
            )
        )
        lexical_scores = {
            entry.id: self._score_entry(normalized_question, entry)
            for entry in entries
        }
        has_exact_match = any(match_type == "exact" for _, match_type in lexical_scores.values())
        embedding_vectors: dict[str, list[float]] = {}
        query_embedding: list[float] | None = None
        if self.settings.faq_embedding_enabled and entries and not has_exact_match:
            embedding_vectors = self.embedding_service.ensure_embeddings(db, entries)
            if embedding_vectors:
                query_embedding = self.embedding_service.embed_query(question)

        candidates: list[FAQCandidate] = []
        for entry in entries:
            score, match_type = lexical_scores[entry.id]
            entry_embedding = embedding_vectors.get(entry.id)
            if query_embedding is not None and entry_embedding is not None:
                embedding_score = cosine_similarity(query_embedding, entry_embedding)
                if (
                    embedding_score >= self.settings.faq_embedding_min_similarity
                    and embedding_score > score
                ):
                    score = embedding_score
                    match_type = "embedding"
            if score > 0 or include_zero:
                candidates.append(FAQCandidate(entry=entry, score=score, match_type=match_type))
        candidates.sort(
            key=lambda candidate: (
                candidate.score,
                candidate.entry.priority,
                candidate.entry.hit_count,
            ),
            reverse=True,
        )
        candidate_limit = limit if limit is not None else get_settings().faq_candidate_limit
        return candidates[:candidate_limit]

    def rank_many(
        self,
        db: Session,
        queries: list[str],
        *,
        limit: int | None = None,
        include_zero: bool = False,
        course_code: str | None = None,
        intent_code: str | None = None,
    ) -> list[FAQCandidate]:
        unique_queries = _unique_query_values(queries)
        if not unique_queries:
            return []
        if len(unique_queries) == 1:
            return self.rank(
                db,
                unique_queries[0],
                limit=limit,
                include_zero=include_zero,
                course_code=course_code,
                intent_code=intent_code,
            )

        candidate_limit = limit if limit is not None else self.settings.faq_candidate_limit
        pool_limit = max(candidate_limit, self.settings.faq_semantic_candidate_limit)
        fused: dict[str, tuple[FAQCandidate, int]] = {}
        for index, query in enumerate(unique_queries):
            branch = self.rank(
                db,
                query,
                limit=pool_limit,
                include_zero=include_zero if index == 0 else False,
                course_code=course_code,
                intent_code=intent_code,
            )
            for candidate in branch:
                previous = fused.get(candidate.entry.id)
                hit_count = (previous[1] if previous else 0) + int(candidate.score > 0)
                best = previous[0] if previous and previous[0].score >= candidate.score else candidate
                fused[candidate.entry.id] = (best, hit_count)

        candidates = [
            FAQCandidate(
                entry=best.entry,
                score=min(
                    1.0,
                    best.score
                    + (
                        self.settings.query_rewrite_fusion_bonus * max(0, hit_count - 1)
                        if best.score > 0
                        else 0.0
                    ),
                ),
                match_type=best.match_type,
            )
            for best, hit_count in fused.values()
        ]
        candidates.sort(
            key=lambda candidate: (
                candidate.score,
                candidate.entry.priority,
                candidate.entry.hit_count,
            ),
            reverse=True,
        )
        return candidates[:candidate_limit]

    def rank_facts_rrf(
        self,
        db: Session,
        queries: list[str],
        *,
        limit: int | None = None,
        course_code: str,
        intent_code: str,
    ) -> list[FAQCandidate]:
        if not self.settings.faq_rrf_enabled:
            return self.rank_many(
                db,
                queries,
                limit=limit,
                include_zero=False,
                course_code=course_code,
                intent_code=intent_code,
            )

        unique_queries = _unique_query_values(queries)
        if not unique_queries:
            return []

        entries = self._active_entries(
            db,
            course_code=course_code,
            intent_code=intent_code,
        )
        if not entries:
            return []

        exact_matches: dict[str, FAQCandidate] = {}
        lexical_contributions: dict[str, tuple[float, float, int]] = {}
        embedding_contributions: dict[str, tuple[float, float, int]] = {}
        rrf_k = max(1, self.settings.faq_rrf_k)
        text_weight = max(0.0, self.settings.faq_rrf_text_weight)
        configured_vector_weight = max(0.0, self.settings.faq_rrf_vector_weight)
        pool_limit = max(
            limit or self.settings.faq_fact_candidate_limit,
            self.settings.faq_rrf_pool_limit,
        )
        for query in unique_queries:
            lexical_ranked = self._lexical_ranking(query, entries)
            for rank, (entry, lexical_score, match_type) in enumerate(
                lexical_ranked[:pool_limit],
                start=1,
            ):
                if match_type == "exact":
                    exact_matches.setdefault(
                        entry.id,
                        FAQCandidate(
                            entry=entry,
                            score=1.0,
                            match_type="exact",
                            lexical_score=lexical_score,
                            lexical_rank=rank,
                        ),
                    )
                contribution = text_weight / (rrf_k + rank)
                _keep_best_contribution(
                    lexical_contributions,
                    entry.id,
                    contribution=contribution,
                    raw_score=lexical_score,
                    rank=rank,
                )

        candidate_limit = limit if limit is not None else self.settings.faq_fact_candidate_limit
        if exact_matches:
            return list(exact_matches.values())[:candidate_limit]

        embedding_vectors: dict[str, list[float]] = {}
        if self.settings.faq_embedding_enabled:
            embedding_vectors = self.embedding_service.ensure_embeddings(db, entries)
        vector_channel_available = False
        for query in unique_queries:
            if not embedding_vectors:
                break
            query_embedding = self.embedding_service.embed_query(query)
            if query_embedding is None:
                continue
            vector_channel_available = True
            embedding_ranked = self._embedding_ranking(
                query_embedding,
                entries,
                embedding_vectors,
            )
            for rank, (entry, embedding_score) in enumerate(
                embedding_ranked[:pool_limit],
                start=1,
            ):
                contribution = configured_vector_weight / (rrf_k + rank)
                _keep_best_contribution(
                    embedding_contributions,
                    entry.id,
                    contribution=contribution,
                    raw_score=embedding_score,
                    rank=rank,
                )

        vector_weight = (
            configured_vector_weight
            if vector_channel_available
            else 0.0
        )
        maximum_rrf = (text_weight + vector_weight) / (rrf_k + 1)
        fused: list[FAQCandidate] = []
        for entry in entries:
            lexical = lexical_contributions.get(entry.id)
            embedding = embedding_contributions.get(entry.id)
            if not lexical and not embedding:
                continue
            rrf_score = (lexical[0] if lexical else 0.0) + (
                embedding[0] if embedding else 0.0
            )
            fused.append(
                FAQCandidate(
                    entry=entry,
                    score=min(rrf_score / maximum_rrf, 1.0) if maximum_rrf else 0.0,
                    match_type="rrf",
                    lexical_score=lexical[1] if lexical else None,
                    embedding_score=embedding[1] if embedding else None,
                    lexical_rank=lexical[2] if lexical else None,
                    embedding_rank=embedding[2] if embedding else None,
                )
            )
        fused.sort(
            key=lambda candidate: (
                candidate.score,
                candidate.entry.priority,
                candidate.entry.hit_count,
            ),
            reverse=True,
        )
        return fused[:candidate_limit]

    @staticmethod
    def _active_entries(
        db: Session,
        *,
        course_code: str,
        intent_code: str,
    ) -> list[FAQEntry]:
        return list(
            db.scalars(
                select(FAQEntry)
                .where(
                    FAQEntry.is_active.is_(True),
                    FAQEntry.course_code == course_code,
                    FAQEntry.intent_code == intent_code,
                )
                .order_by(
                    FAQEntry.priority.desc(),
                    FAQEntry.hit_count.desc(),
                    FAQEntry.created_at.desc(),
                )
            )
        )

    def _lexical_ranking(
        self,
        query: str,
        entries: list[FAQEntry],
    ) -> list[tuple[FAQEntry, float, str]]:
        normalized_query = normalize_text(query)
        confidence_by_id = {
            entry.id: self._score_entry(normalized_query, entry)
            for entry in entries
        }
        exact_matches = [
            (entry, score, match_type)
            for entry in entries
            for score, match_type in [confidence_by_id[entry.id]]
            if match_type == "exact"
        ]
        if exact_matches:
            exact_matches.sort(
                key=lambda item: (
                    item[0].priority,
                    item[0].hit_count,
                ),
                reverse=True,
            )
            return exact_matches

        documents = [_fact_document(entry) for entry in entries]
        custom_terms = [
            value
            for entry in entries
            for value in (
                entry.course_name,
                entry.category,
                entry.fact_name,
                *(entry.keywords or []),
            )
        ]
        hits = rank_bm25(
            query,
            documents,
            custom_terms=custom_terms,
        )
        ranked = []
        for hit in hits:
            entry = entries[hit.index]
            confidence, _ = confidence_by_id[entry.id]
            if confidence < self.settings.faq_fact_min_similarity:
                continue
            ranked.append((entry, confidence, "bm25"))
        return ranked

    def _embedding_ranking(
        self,
        query_embedding: list[float],
        entries: list[FAQEntry],
        embedding_vectors: dict[str, list[float]],
    ) -> list[tuple[FAQEntry, float]]:
        ranked = [
            (
                entry,
                cosine_similarity(query_embedding, embedding_vectors[entry.id]),
            )
            for entry in entries
            if entry.id in embedding_vectors
        ]
        ranked = [
            item
            for item in ranked
            if item[1] >= self.settings.faq_embedding_min_similarity
        ]
        ranked.sort(
            key=lambda item: (
                item[1],
                item[0].priority,
                item[0].hit_count,
            ),
            reverse=True,
        )
        return ranked

    @staticmethod
    def _score_entry(question: str, entry: FAQEntry) -> tuple[float, str]:
        candidates = [
            entry.fact_name,
            entry.question,
            *(entry.aliases or []),
            entry.answer,
        ]
        best_score = 0.0
        best_type = "similar"

        for candidate in candidates:
            normalized_candidate = normalize_text(candidate)
            if not normalized_candidate:
                continue
            if question == normalized_candidate:
                return 1.0, "exact"

            candidate_score = SequenceMatcher(None, question, normalized_candidate).ratio()
            candidate_type = "similar"
            if _contains_meaningful_text(question, normalized_candidate):
                shorter = min(len(question), len(normalized_candidate))
                longer = max(len(question), len(normalized_candidate))
                candidate_score = max(candidate_score, 0.84 + 0.12 * shorter / longer)
                candidate_type = "contains"

            overlap = _ngram_overlap(question, normalized_candidate)
            if overlap > candidate_score:
                candidate_score = overlap
                candidate_type = "similar"

            if candidate_score > best_score:
                best_score = candidate_score
                best_type = candidate_type

        normalized_keywords = [normalize_text(keyword) for keyword in (entry.keywords or []) if normalize_text(keyword)]
        if normalized_keywords:
            matched_keywords = sum(keyword in question for keyword in normalized_keywords)
            keyword_coverage = matched_keywords / len(normalized_keywords)
            if matched_keywords and keyword_coverage >= 0.5:
                keyword_score = 0.64 + 0.24 * keyword_coverage
                if keyword_score > best_score:
                    best_score = keyword_score
                    best_type = "keyword"

        priority_bonus = min(max(entry.priority, 0), 20) * 0.002
        return min(best_score + priority_bonus, 1.0), best_type


def normalize_text(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.lower(), flags=re.UNICODE)


def _fact_document(entry: FAQEntry) -> str:
    values = [
        entry.course_name,
        entry.category,
        entry.fact_name,
        entry.question,
        *(entry.aliases or []),
        *(entry.keywords or []),
        entry.answer,
    ]
    return "\n".join(value.strip() for value in values if value.strip())


def _unique_query_values(values: list[str]) -> list[str]:
    queries: list[str] = []
    seen: set[str] = set()
    for value in values:
        query = value.strip()
        normalized = normalize_text(query)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        queries.append(query)
    return queries


def _keep_best_contribution(
    values: dict[str, tuple[float, float, int]],
    entry_id: str,
    *,
    contribution: float,
    raw_score: float,
    rank: int,
) -> None:
    previous = values.get(entry_id)
    if previous is None or contribution > previous[0]:
        values[entry_id] = (contribution, raw_score, rank)


def _contains_meaningful_text(left: str, right: str) -> bool:
    shorter, longer = sorted((left, right), key=len)
    return len(shorter) >= 4 and shorter in longer


def _ngram_overlap(left: str, right: str, size: int = 2) -> float:
    left_grams = _ngrams(left, size)
    right_grams = _ngrams(right, size)
    if not left_grams or not right_grams:
        return 0.0
    return len(left_grams & right_grams) / len(left_grams | right_grams)


def _ngrams(value: str, size: int) -> set[str]:
    if len(value) < size:
        return {value} if value else set()
    return {value[index : index + size] for index in range(len(value) - size + 1)}


def _candidate_margin(candidates: list[FAQCandidate]) -> float:
    if not candidates:
        return 0.0
    if len(candidates) == 1:
        return candidates[0].score
    return max(0.0, candidates[0].score - candidates[1].score)
