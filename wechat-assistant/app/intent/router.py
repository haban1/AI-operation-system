from __future__ import annotations

import re
from dataclasses import replace
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.faq.service import FAQCandidate, FAQService
from app.intent.models import IntentCandidate, IntentDecision, IntentDecisionType
from app.intent.service import CourseCandidate, IntentRecallCandidate, IntentService
from app.intent.taxonomy import intent_label
from app.llm.faq_orchestrator import (
    FAQOrchestrator,
    SemanticFAQSelection,
    SemanticIntentSelection,
)
from app.models.entities import FAQEntry, FAQQueryLog, User


class IntentRouter:
    def __init__(
        self,
        *,
        faq_service: FAQService | None = None,
        semantic_matcher: FAQOrchestrator | None = None,
        intent_service: IntentService | None = None,
    ) -> None:
        self.settings = get_settings()
        self.faq_service = faq_service or FAQService()
        self.semantic_matcher = semantic_matcher
        self.intent_service = (
            intent_service
            if intent_service is not None
            else IntentService()
            if isinstance(self.faq_service, FAQService)
            else None
        )

    def route(
        self,
        db: Session,
        *,
        user: User,
        message: str,
        original_query: str | None = None,
        retrieval_queries: list[str] | None = None,
        rewrite_strategies: list[str] | None = None,
        rewrite_version: str | None = None,
        query_target: str = "facts",
    ) -> IntentDecision:
        raw_original = (original_query or message).strip()
        queries = _clean_retrieval_queries(message, retrieval_queries)
        if query_target == "course_catalog" and self.intent_service:
            decision = self._course_catalog_decision(db)
        elif self.intent_service:
            decision = self._route_registered_intent(
                db,
                message=message,
                queries=queries,
            )
        else:
            decision = self._route_legacy_faq_intent(
                db,
                message=message,
                queries=queries,
            )

        if (
            decision.decision == IntentDecisionType.accept
            and decision.domain in {"course", "conversation"}
        ):
            decision = self._retrieve_facts(
                db,
                question=message,
                original_question=raw_original,
                queries=queries,
                decision=decision,
            )

        rewrite_used = any(
            _normalized_query(query) != _normalized_query(raw_original)
            for query in queries
        )
        if rewrite_used:
            decision = replace(
                decision,
                sources=["QUERY_REWRITE", *decision.sources],
            )
        self._record_decision(
            db,
            user=user,
            message=message,
            original_query=raw_original,
            retrieval_queries=queries,
            rewrite_strategies=rewrite_strategies or ["direct"],
            rewrite_version=rewrite_version or self.settings.query_rewrite_version,
            decision=decision,
        )
        return decision

    def _course_catalog_decision(self, db: Session) -> IntentDecision:
        assert self.intent_service is not None
        courses = self.intent_service.list_active_courses(
            db,
            include_general=False,
        )
        if not courses:
            return self._out_of_scope(candidates=[])

        answer_lines = ["目前提供以下课程："]
        answer_lines.extend(
            f"{index}. {course.display_name}：{course.description}"
            for index, course in enumerate(courses, start=1)
        )
        return IntentDecision(
            course_code="",
            course_name="",
            intent_code="none",
            domain="system",
            intent_id="none",
            decision=IntentDecisionType.accept,
            answer="\n".join(answer_lines),
            confidence=1.0,
            margin=1.0,
            candidates=[],
            sources=["COURSE_REGISTRY"],
            match_type="course_registry",
            router_version=self.settings.faq_router_version,
            taxonomy_version=self.settings.faq_taxonomy_version,
        )

    def _route_registered_intent(
        self,
        db: Session,
        *,
        message: str,
        queries: list[str],
    ) -> IntentDecision:
        assert self.intent_service is not None
        course_candidates = self.intent_service.rank_courses(db, queries)
        course = self._select_course(course_candidates)
        if isinstance(course, IntentDecision):
            return course

        intent_pool = self.intent_service.rank_intents(
            db,
            queries,
            course_code=course.course_code,
            limit=self.settings.intent_candidate_limit,
        )
        candidates = [_to_registered_intent_candidate(item) for item in intent_pool]
        decision = self._decision_from_registered_intents(intent_pool, candidates)
        if (
            self.semantic_matcher
            and decision.decision
            in {IntentDecisionType.clarify, IntentDecisionType.out_of_scope}
        ):
            selection = self.semantic_matcher.select_intent(message, candidates)
            decision = self._decision_from_intent_semantic(
                fallback=decision,
                selection=selection,
                intent_pool=intent_pool,
                candidates=candidates,
            )
        return decision

    def _select_course(
        self,
        candidates: list[CourseCandidate],
    ) -> CourseCandidate | IntentDecision:
        if not candidates:
            return self._out_of_scope(candidates=[])

        top = candidates[0]
        margin = (
            top.score
            if len(candidates) == 1
            else max(0.0, top.score - candidates[1].score)
        )
        exact = top.match_type in {"course_exact", "course_contains"}
        if exact or (
            top.score >= self.settings.intent_course_accept_threshold
            and margin >= self.settings.intent_course_margin_threshold
        ):
            return top

        if len(candidates) >= 2:
            clarification = (
                f"请问你想咨询的是“{candidates[0].course_name}”，"
                f"还是“{candidates[1].course_name}”？"
            )
            return IntentDecision(
                course_code="unknown",
                course_name="未识别",
                intent_code="unknown",
                domain="course",
                intent_id="unknown",
                decision=IntentDecisionType.clarify,
                answer=clarification,
                confidence=top.score,
                margin=round(margin, 4),
                sources=["COURSE_RECALL"],
                match_type=top.match_type,
                clarification_question=clarification,
                router_version=self.settings.faq_router_version,
                taxonomy_version=self.settings.faq_taxonomy_version,
            )
        return top

    def _decision_from_registered_intents(
        self,
        intent_pool: list[IntentRecallCandidate],
        candidates: list[IntentCandidate],
    ) -> IntentDecision:
        if not intent_pool:
            return self._out_of_scope(candidates=[])

        top = intent_pool[0]
        margin = _intent_recall_margin(intent_pool)
        exact = top.match_type == "exact"
        if exact or (
            top.score >= self.settings.intent_accept_threshold
            and margin >= self.settings.intent_margin_threshold
        ):
            return self._accepted_registered_intent(
                top,
                candidates=candidates,
                margin=margin,
            )

        if top.score >= self.settings.intent_clarify_threshold:
            clarification = _registered_intent_clarification(intent_pool)
            definition = top.definition
            return IntentDecision(
                course_code=definition.course_code,
                course_name=definition.course_name,
                intent_code=definition.intent_code,
                domain=definition.domain,
                intent_id=definition.intent_id,
                decision=IntentDecisionType.clarify,
                answer=clarification,
                confidence=top.score,
                margin=margin,
                candidates=candidates,
                sources=[top.match_type.upper()],
                match_type=top.match_type,
                risk_level=definition.risk_level,
                clarification_question=clarification,
                router_version=self.settings.faq_router_version,
                taxonomy_version=self.settings.faq_taxonomy_version,
            )
        return self._out_of_scope(
            candidates=candidates,
            confidence=top.score,
            margin=margin,
        )

    def _decision_from_intent_semantic(
        self,
        *,
        fallback: IntentDecision,
        selection: SemanticIntentSelection,
        intent_pool: list[IntentRecallCandidate],
        candidates: list[IntentCandidate],
    ) -> IntentDecision:
        if not selection.llm_used:
            return fallback
        selected = next(
            (
                candidate
                for candidate in intent_pool
                if candidate.definition.intent_id == selection.intent_id
            ),
            None,
        )
        if (
            not selected
            or selection.confidence < self.settings.intent_semantic_accept_threshold
        ):
            return replace(
                fallback,
                sources=[*fallback.sources, "LLM_INTENT_REJECT"],
            )
        promoted = replace(
            selected,
            score=selection.confidence,
            match_type="semantic_intent",
        )
        return self._accepted_registered_intent(
            promoted,
            candidates=candidates,
            margin=_intent_recall_margin(intent_pool),
            sources=["LLM_INTENT"],
        )

    def _accepted_registered_intent(
        self,
        top: IntentRecallCandidate,
        *,
        candidates: list[IntentCandidate],
        margin: float,
        sources: list[str] | None = None,
    ) -> IntentDecision:
        definition = top.definition
        return IntentDecision(
            course_code=definition.course_code,
            course_name=definition.course_name,
            intent_code=definition.intent_code,
            domain=definition.domain,
            intent_id=definition.intent_id,
            decision=IntentDecisionType.accept,
            answer="",
            confidence=top.score,
            margin=margin,
            candidates=candidates,
            sources=sources or [top.match_type.upper()],
            match_type=top.match_type,
            risk_level=definition.risk_level,
            requires_confirmation=definition.risk_level.lower() == "high",
            router_version=self.settings.faq_router_version,
            taxonomy_version=self.settings.faq_taxonomy_version,
        )

    def _route_legacy_faq_intent(
        self,
        db: Session,
        *,
        message: str,
        queries: list[str],
    ) -> IntentDecision:
        rank_intents = getattr(self.faq_service, "rank_intents", None)
        if callable(rank_intents):
            semantic_pool = rank_intents(
                db,
                queries,
                limit=self.settings.faq_semantic_candidate_limit,
            )
        else:
            rank_many = getattr(self.faq_service, "rank_many", None)
            if len(queries) > 1 and callable(rank_many):
                semantic_pool = rank_many(
                    db,
                    queries,
                    limit=self.settings.faq_semantic_candidate_limit,
                    include_zero=True,
                )
            else:
                semantic_pool = self.faq_service.rank(
                    db,
                    message,
                    limit=self.settings.faq_semantic_candidate_limit,
                    include_zero=True,
                )
        faq_candidates = [
            candidate for candidate in semantic_pool if candidate.score > 0
        ][: self.settings.faq_candidate_limit]
        candidates = [_to_intent_candidate(candidate) for candidate in faq_candidates]
        decision = self._decision_from_candidates(faq_candidates, candidates)
        if (
            self.semantic_matcher
            and decision.decision
            in {IntentDecisionType.clarify, IntentDecisionType.out_of_scope}
        ):
            selection = self.semantic_matcher.select_faq(message, semantic_pool)
            decision = self._decision_from_semantic(
                fallback=decision,
                selection=selection,
                semantic_pool=semantic_pool,
            )
        return decision

    def _retrieve_facts(
        self,
        db: Session,
        *,
        question: str,
        original_question: str,
        queries: list[str],
        decision: IntentDecision,
    ) -> IntentDecision:
        rank_facts_rrf = getattr(self.faq_service, "rank_facts_rrf", None)
        rank_many = getattr(self.faq_service, "rank_many", None)
        fact_pool: list[FAQCandidate] = []
        if callable(rank_facts_rrf):
            fact_pool = rank_facts_rrf(
                db,
                queries,
                limit=self.settings.faq_fact_candidate_limit,
                course_code=decision.course_code,
                intent_code=decision.intent_code,
            )
        elif callable(rank_many):
            try:
                fact_pool = rank_many(
                    db,
                    queries,
                    limit=self.settings.faq_fact_candidate_limit,
                    include_zero=False,
                    course_code=decision.course_code,
                    intent_code=decision.intent_code,
                )
            except TypeError:
                fact_pool = []

        if not fact_pool and decision.matched_faq_id:
            entry = db.get(FAQEntry, decision.matched_faq_id)
            if entry:
                fact_pool = [
                    FAQCandidate(
                        entry=entry,
                        score=decision.confidence,
                        match_type=decision.match_type,
                    )
                ]
        if not fact_pool:
            intent_candidate = next(
                (
                    candidate
                    for candidate in decision.candidates
                    if candidate.intent_id == decision.intent_id
                ),
                None,
            )
            intent_name = (
                intent_candidate.question
                if intent_candidate
                else intent_label(decision.intent_code)
            )
            intent_description = (
                intent_candidate.description if intent_candidate else ""
            )
            compose_without_facts = getattr(
                self.semantic_matcher,
                "compose_without_facts",
                None,
            )
            composed = (
                compose_without_facts(
                    original_question=original_question,
                    standalone_question=question,
                    retrieval_queries=queries,
                    course_name=decision.course_name,
                    intent_name=intent_name,
                    intent_description=intent_description,
                )
                if callable(compose_without_facts)
                else None
            )
            answer = composed.answer if composed else ""
            sources = [*decision.sources, "NO_FACT"]
            if composed and composed.llm_used:
                sources.append("LLM_NO_FACT_RESPONSE")
            return replace(
                decision,
                answer=answer,
                decision=IntentDecisionType.clarify,
                sources=sources,
                matched_faq_id=None,
                matched_question=None,
                matched_fact_ids=[],
                matched_facts=[],
                clarification_question=answer,
            )

        selected = _select_fact_candidates(
            question,
            fact_pool,
            min_similarity=self.settings.faq_fact_min_similarity,
            relative_margin=self.settings.faq_fact_relative_margin,
            limit=self.settings.faq_fact_answer_limit,
        )
        composed = (
            self.semantic_matcher.compose_facts(question=question, facts=selected)
            if self.semantic_matcher
            else None
        )
        answer = composed.answer if composed else _fallback_fact_answer(selected)
        sources = list(decision.sources)
        if any(candidate.match_type == "rrf" for candidate in selected):
            sources.append("RRF")
        if composed and composed.llm_used:
            sources.append("LLM_FACT_COMPOSE")
        primary = selected[0]
        matched_facts = [
            {
                "id": candidate.entry.id,
                "fact_name": candidate.entry.fact_name or candidate.entry.question,
                "statement": candidate.entry.answer,
                "image_url": candidate.entry.image_url,
                "score": round(candidate.score, 4),
                "match_type": candidate.match_type,
                "lexical_score": (
                    round(candidate.lexical_score, 4)
                    if candidate.lexical_score is not None
                    else None
                ),
                "embedding_score": (
                    round(candidate.embedding_score, 4)
                    if candidate.embedding_score is not None
                    else None
                ),
                "lexical_rank": candidate.lexical_rank,
                "embedding_rank": candidate.embedding_rank,
            }
            for candidate in selected
        ]
        return replace(
            decision,
            answer=answer,
            sources=sources,
            matched_faq_id=primary.entry.id,
            matched_question=primary.entry.question,
            matched_fact_ids=[candidate.entry.id for candidate in selected],
            matched_facts=matched_facts,
        )

    def _decision_from_semantic(
        self,
        *,
        fallback: IntentDecision,
        selection: SemanticFAQSelection,
        semantic_pool: list[FAQCandidate],
    ) -> IntentDecision:
        if not selection.llm_used:
            return fallback

        selected = next(
            (candidate for candidate in semantic_pool if candidate.entry.id == selection.faq_id),
            None,
        )
        if not selected:
            rejected = self._out_of_scope(
                candidates=fallback.candidates,
                confidence=fallback.confidence,
                margin=fallback.margin,
            )
            return replace(
                rejected,
                sources=[*fallback.sources, "LLM_SEMANTIC_REJECT"],
            )

        entry = selected.entry
        threshold = (
            self.settings.faq_semantic_high_risk_accept_threshold
            if entry.risk_level.lower() == "high"
            else self.settings.faq_semantic_accept_threshold
        )
        if selection.confidence < threshold:
            return replace(
                fallback,
                sources=[*fallback.sources, "LLM_SEMANTIC_REJECT"],
            )

        promoted = FAQCandidate(entry=entry, score=selection.confidence, match_type="semantic")
        remaining = [candidate for candidate in semantic_pool if candidate.entry.id != entry.id]
        semantic_candidates = [promoted, *remaining][: self.settings.faq_candidate_limit]
        return self._accepted(
            top=promoted,
            candidates=[_to_intent_candidate(candidate) for candidate in semantic_candidates],
            margin=_margin(semantic_candidates),
            decision=(
                IntentDecisionType.handoff
                if entry.handoff_required
                else IntentDecisionType.accept
            ),
            sources=["LLM_SEMANTIC"],
        )

    def _decision_from_candidates(
        self,
        faq_candidates: list[FAQCandidate],
        candidates: list[IntentCandidate],
    ) -> IntentDecision:
        if not faq_candidates:
            return self._out_of_scope(candidates=[])

        top = faq_candidates[0]
        margin = _margin(faq_candidates)
        entry = top.entry
        high_risk = entry.risk_level.lower() == "high"
        embedding_match = top.match_type == "embedding"
        if embedding_match:
            accept_threshold = (
                self.settings.faq_embedding_high_risk_accept_threshold
                if high_risk
                else self.settings.faq_embedding_accept_threshold
            )
            margin_threshold = (
                self.settings.faq_embedding_high_risk_margin_threshold
                if high_risk
                else self.settings.faq_embedding_margin_threshold
            )
        else:
            accept_threshold = (
                self.settings.faq_high_risk_accept_threshold if high_risk else self.settings.faq_accept_threshold
            )
            margin_threshold = (
                self.settings.faq_high_risk_margin_threshold if high_risk else self.settings.faq_margin_threshold
            )
        exact = top.match_type == "exact"

        if entry.handoff_required and (exact or top.score >= self.settings.faq_clarify_threshold):
            return self._accepted(
                top=top,
                candidates=candidates,
                margin=margin,
                decision=IntentDecisionType.handoff,
            )
        if exact or (top.score >= accept_threshold and margin >= margin_threshold):
            return self._accepted(
                top=top,
                candidates=candidates,
                margin=margin,
                decision=IntentDecisionType.accept,
            )
        if top.score >= self.settings.faq_clarify_threshold:
            clarification = _clarification_question(faq_candidates)
            return IntentDecision(
                course_code=entry.course_code,
                course_name=entry.course_name,
                intent_code=entry.intent_code,
                domain=entry.domain,
                intent_id=entry.intent_id,
                decision=IntentDecisionType.clarify,
                answer=clarification,
                confidence=top.score,
                margin=margin,
                candidates=candidates,
                sources=[top.match_type.upper()],
                match_type=top.match_type,
                risk_level=entry.risk_level,
                clarification_question=clarification,
                router_version=self.settings.faq_router_version,
                taxonomy_version=entry.taxonomy_version,
            )
        return self._out_of_scope(candidates=candidates, confidence=top.score, margin=margin)

    def _accepted(
        self,
        *,
        top: FAQCandidate,
        candidates: list[IntentCandidate],
        margin: float,
        decision: IntentDecisionType,
        sources: list[str] | None = None,
    ) -> IntentDecision:
        entry = top.entry
        return IntentDecision(
            course_code=entry.course_code,
            course_name=entry.course_name,
            intent_code=entry.intent_code,
            domain=entry.domain,
            intent_id=entry.intent_id,
            decision=decision,
            answer=entry.answer,
            confidence=top.score,
            margin=margin,
            candidates=candidates,
            sources=sources or [top.match_type.upper()],
            matched_faq_id=entry.id,
            matched_question=entry.question,
            matched_fact_ids=[entry.id],
            matched_facts=[
                {
                    "id": entry.id,
                    "fact_name": entry.fact_name or entry.question,
                    "statement": entry.answer,
                    "image_url": entry.image_url,
                    "score": round(top.score, 4),
                    "match_type": top.match_type,
                }
            ],
            match_type=top.match_type,
            risk_level=entry.risk_level,
            requires_confirmation=entry.risk_level.lower() == "high",
            router_version=self.settings.faq_router_version,
            taxonomy_version=entry.taxonomy_version,
        )

    def _out_of_scope(
        self,
        *,
        candidates: list[IntentCandidate],
        confidence: float = 0.0,
        margin: float = 0.0,
    ) -> IntentDecision:
        return IntentDecision(
            course_code="unknown",
            course_name="未识别",
            intent_code="unknown",
            domain="unknown",
            intent_id="unknown",
            decision=IntentDecisionType.out_of_scope,
            answer="",
            confidence=confidence,
            margin=margin,
            candidates=candidates,
            sources=[],
            router_version=self.settings.faq_router_version,
            taxonomy_version=self.settings.faq_taxonomy_version,
        )

    @staticmethod
    def _record_decision(
        db: Session,
        *,
        user: User,
        message: str,
        original_query: str,
        retrieval_queries: list[str],
        rewrite_strategies: list[str],
        rewrite_version: str,
        decision: IntentDecision,
    ) -> None:
        matched_ids = decision.matched_fact_ids or (
            [decision.matched_faq_id] if decision.matched_faq_id else []
        )
        for fact_id in dict.fromkeys(matched_ids):
            entry = db.get(FAQEntry, fact_id)
            if entry:
                entry.hit_count += 1
        review_status = (
            "pending"
            if decision.decision in {IntentDecisionType.clarify, IntentDecisionType.out_of_scope}
            else "not_required"
        )
        db.add(
            FAQQueryLog(
                user_id=user.id,
                question=message.strip(),
                original_query=original_query,
                retrieval_queries=retrieval_queries,
                rewrite_strategies=rewrite_strategies,
                rewrite_version=rewrite_version,
                matched_faq_id=decision.matched_faq_id,
                matched_fact_ids=decision.matched_fact_ids,
                matched_facts=decision.matched_facts,
                match_score=decision.confidence,
                margin=decision.margin,
                decision=decision.decision.value,
                course_code=decision.course_code,
                course_name=decision.course_name,
                intent_code=decision.intent_code,
                domain=decision.domain,
                intent_id=decision.intent_id,
                match_type=decision.match_type,
                candidates=[candidate.as_dict() for candidate in decision.candidates],
                sources=decision.sources,
                router_version=decision.router_version,
                taxonomy_version=decision.taxonomy_version,
                review_status=review_status,
                reviewed_at=datetime.now(UTC) if review_status == "not_required" else None,
            )
        )
        db.commit()


def _to_intent_candidate(candidate: FAQCandidate) -> IntentCandidate:
    entry = candidate.entry
    return IntentCandidate(
        faq_id=entry.id,
        question=entry.question,
        fact_name=entry.fact_name or "",
        course_code=entry.course_code,
        course_name=entry.course_name,
        intent_code=entry.intent_code,
        domain=entry.domain,
        intent_id=entry.intent_id,
        score=candidate.score,
        match_type=candidate.match_type,
        risk_level=entry.risk_level,
        handoff_required=entry.handoff_required,
    )


def _to_registered_intent_candidate(
    candidate: IntentRecallCandidate,
) -> IntentCandidate:
    definition = candidate.definition
    return IntentCandidate(
        faq_id=definition.intent_id,
        question=definition.display_name,
        course_code=definition.course_code,
        course_name=definition.course_name,
        intent_code=definition.intent_code,
        domain=definition.domain,
        intent_id=definition.intent_id,
        score=candidate.score,
        match_type=candidate.match_type,
        risk_level=definition.risk_level,
        handoff_required=False,
        description=definition.description,
        rrf_score=candidate.rrf_score,
        lexical_score=candidate.lexical_score,
        embedding_score=candidate.embedding_score,
        lexical_rank=candidate.lexical_rank,
        embedding_rank=candidate.embedding_rank,
    )


def _clean_retrieval_queries(message: str, values: list[str] | None) -> list[str]:
    queries: list[str] = []
    seen: set[str] = set()
    for value in [*(values or []), message]:
        query = value.strip()
        normalized = _normalized_query(query)
        if not query or normalized in seen:
            continue
        seen.add(normalized)
        queries.append(query)
    return queries


def _normalized_query(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.lower(), flags=re.UNICODE)


def _margin(candidates: list[FAQCandidate]) -> float:
    if not candidates:
        return 0.0
    if len(candidates) == 1:
        return round(candidates[0].score, 4)
    return round(max(0.0, candidates[0].score - candidates[1].score), 4)


def _intent_recall_margin(candidates: list[IntentRecallCandidate]) -> float:
    if not candidates:
        return 0.0
    if len(candidates) == 1:
        return round(candidates[0].score, 4)
    return round(max(0.0, candidates[0].score - candidates[1].score), 4)


def _registered_intent_clarification(
    candidates: list[IntentRecallCandidate],
) -> str:
    top = candidates[:2]
    if len(top) >= 2:
        return (
            f"关于{top[0].definition.course_name}，你想了解"
            f"“{top[0].definition.display_name}”，还是"
            f"“{top[1].definition.display_name}”？"
        )
    definition = top[0].definition
    return (
        f"请问你想了解{definition.course_name}的"
        f"“{definition.display_name}”吗？你也可以补充更多信息。"
    )


def _clarification_question(candidates: list[FAQCandidate]) -> str:
    top_candidates = candidates[:2]
    course_names = list(
        dict.fromkeys(candidate.entry.course_name for candidate in top_candidates)
    )
    if len(course_names) >= 2:
        return f"请问你想咨询的是“{course_names[0]}”，还是“{course_names[1]}”？"

    intent_names = list(
        dict.fromkeys(candidate.entry.category for candidate in top_candidates)
    )
    if len(intent_names) >= 2:
        return f"关于{course_names[0]}，你想了解“{intent_names[0]}”，还是“{intent_names[1]}”？"

    fact_names = [
        candidate.entry.fact_name or candidate.entry.question
        for candidate in top_candidates
    ]
    if len(fact_names) >= 2:
        return f"请问你想咨询的是“{fact_names[0]}”，还是“{fact_names[1]}”？"
    return f"请问你想咨询的是“{fact_names[0]}”吗？你也可以补充更多信息。"


def _select_fact_candidates(
    question: str,
    candidates: list[FAQCandidate],
    *,
    min_similarity: float,
    relative_margin: float,
    limit: int,
) -> list[FAQCandidate]:
    if not candidates:
        return []
    exact = [candidate for candidate in candidates if candidate.match_type == "exact"]
    if exact and not _is_broad_fact_query(question):
        return exact[: max(1, limit)]
    if candidates[0].match_type == "rrf" and not _is_broad_fact_query(question):
        return candidates[:1]

    top_score = candidates[0].score
    score_floor = max(min_similarity, top_score - relative_margin)
    selected = [
        candidate
        for candidate in candidates
        if candidate.score >= score_floor
    ][: max(1, limit)]
    return selected or candidates[:1]


def _is_broad_fact_query(question: str) -> bool:
    normalized = _normalized_query(question)
    terms = (
        "有什么",
        "有哪些",
        "主要",
        "整体",
        "全部",
        "介绍",
        "包括",
        "分别",
        "讲什么",
        "学什么",
    )
    return any(term in normalized for term in terms)


def _fallback_fact_answer(candidates: list[FAQCandidate]) -> str:
    statements = list(
        dict.fromkeys(
            candidate.entry.answer.strip()
            for candidate in candidates
            if candidate.entry.answer.strip()
        )
    )
    if not statements:
        return ""
    if len(statements) == 1:
        return statements[0]
    return "\n".join(f"- {statement}" for statement in statements)
