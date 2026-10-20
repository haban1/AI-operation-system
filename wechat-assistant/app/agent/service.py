import logging

from collections.abc import Iterable
from dataclasses import replace

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.memory import ShortTermMemory
from app.agent.tool_chain import handoff_decision, run_tool_chain, tool_error_decision
from app.faq.service import FAQService
from app.intent.models import IntentDecision, IntentDecisionType
from app.intent.router import IntentRouter
from app.llm.faq_orchestrator import FAQOrchestrator, QuestionPlan
from app.models.entities import IntentDefinition, MessageRole, User
from app.knowledge.service import DocumentKnowledgeService
from app.knowledge.tianhe import TianheKnowledgeService
from app.core.config import get_settings
from app.knowledge.answers import resolve_citations


logger = logging.getLogger(__name__)


class AgentService:
    def __init__(
        self,
        *,
        memory: ShortTermMemory | None = None,
        faq_service: FAQService | None = None,
        intent_router: IntentRouter | None = None,
        faq_orchestrator: FAQOrchestrator | None = None,
        document_service: DocumentKnowledgeService | None = None,
    ) -> None:
        self.memory = memory or ShortTermMemory()
        self.faq_service = faq_service or FAQService()
        self.faq_orchestrator = faq_orchestrator or FAQOrchestrator()
        # Explicit router injection is retained for legacy tests/integrations.
        # The deployed assistant exclusively retrieves uploaded documents.
        self.intent_router = intent_router
        self.document_service = document_service or (TianheKnowledgeService() if get_settings().tianhe_knowledge_enabled else DocumentKnowledgeService())

    def answer(self, db: Session, *, user: User, message: str, session_id: str | None) -> dict:
        session = self.memory.get_or_create_session(db, user=user, session_id=session_id)
        history = self.memory.to_prompt_messages(db, session=session)
        plan = self.faq_orchestrator.plan(message, history=history)
        questions = plan.questions if plan.questions else [message.strip()]
        original_queries = (
            plan.original_queries
            if len(plan.original_queries) == len(questions)
            else questions
        )
        retrieval_queries = (
            plan.retrieval_queries
            if len(plan.retrieval_queries) == len(questions)
            else [[question] for question in questions]
        )
        rewrite_strategies = (
            plan.rewrite_strategies
            if len(plan.rewrite_strategies) == len(questions)
            else [["direct"] for _ in questions]
        )
        rewrite_version = plan.rewrite_version
        plan = replace(
            plan, questions=questions, original_queries=original_queries,
            retrieval_queries=retrieval_queries, rewrite_strategies=rewrite_strategies,
            query_targets=plan.query_targets or ["facts"] * len(questions),
        )
        chain = None
        if plan.mode == "handoff":
            decisions = [handoff_decision()]
        elif plan.direct_reply:
            decisions = [IntentDecision(
                course_code="", course_name="", intent_code="", domain="",
                intent_id="none", decision=IntentDecisionType.accept,
                answer=plan.direct_reply, confidence=1.0, margin=0.0,
                sources=["LLM_REPLY"], match_type="model_reply",
            )]
        elif plan.tool_messages:
            chain = run_tool_chain(
                orchestrator=self.faq_orchestrator, initial=plan, original=message,
                history=history, execute=lambda batch, index: self._query_decision(db, user, batch, index),
            )
            plan, decisions = chain.plan, chain.decisions
            questions, original_queries = plan.questions, plan.original_queries
            retrieval_queries, rewrite_strategies = plan.retrieval_queries, plan.rewrite_strategies
        else:
            decisions = [self._query_decision(db, user, plan, index) for index in range(len(questions))]
        composed = chain.composed if chain else self.faq_orchestrator.compose(
            original_message=message, questions=questions, decisions=decisions, history=history,
        )
        answer = composed.answer
        answer, citations = resolve_citations(answer, [c for d in decisions for c in d.document_chunks])
        primary = _primary_decision(decisions)
        sources = _combined_sources(
            decisions, bool(plan.llm_used and plan.mode == "knowledge"), composed.llm_used,
        )

        self.memory.add_message(
            db,
            session=session,
            user=user,
            role=MessageRole.user,
            content=message,
        )
        self.memory.add_message(
            db,
            session=session,
            user=user,
            role=MessageRole.assistant,
            content=answer,
        )
        return {
            "session_id": session.id,
            "answer": answer,
            "tool_rounds": chain.rounds if chain else int(plan.mode == "handoff"),
            "tool_call_count": chain.call_count if chain else int(plan.mode == "handoff"),
            "tool_stop_reason": chain.stop_reason if chain else "handoff" if plan.mode == "handoff" else "direct_reply" if plan.direct_reply else "planning_fallback",
            "tool_trace": chain.trace if chain else [{"round": 1, "tool": "request_human_handoff", "status": "handoff"}] if plan.mode == "handoff" else [],
            "used_general_knowledge": False,
            "llm_used": (
                plan.llm_used
                or composed.llm_used
                or any(source.startswith("LLM_") for decision in decisions for source in decision.sources)
            ),
            "rewrite_used": plan.rewrite_used,
            "original_query": message.strip(),
            "retrieval_queries": retrieval_queries,
            "rewrite_strategies": rewrite_strategies,
            "rewrite_version": rewrite_version,
            "question_count": len(questions),
            "sub_questions": [
                {
                    "question": question,
                    "original_query": original_query,
                    "retrieval_queries": query_group,
                    "rewrite_strategies": strategies,
                    "answer": decision.answer,
                    "course_code": decision.course_code,
                    "course_name": decision.course_name,
                    "intent_code": decision.intent_code,
                    "intent": decision.intent_id,
                    "decision": decision.decision.value,
                    "matched_faq_id": decision.matched_faq_id,
                    "matched_question": decision.matched_question,
                    "matched_fact_ids": decision.matched_fact_ids,
                    "matched_facts": decision.matched_facts,
                    "confidence": round(decision.confidence, 4),
                }
                for question, original_query, query_group, strategies, decision in zip(
                    questions,
                    original_queries,
                    retrieval_queries,
                    rewrite_strategies,
                    decisions,
                    strict=True,
                )
            ],
            "intent": _combined_value(decisions, "intent_id"),
            "intent_source": ",".join(sources) or primary.match_type,
            "citations": citations,
            "matched_faq_id": primary.matched_faq_id,
            "matched_question": primary.matched_question,
            "matched_fact_ids": [
                fact_id
                for decision in decisions
                for fact_id in decision.matched_fact_ids
            ],
            "matched_facts": [
                {**fact, "sub_question": question}
                for question, decision in zip(questions, decisions, strict=True)
                for fact in decision.matched_facts
            ],
            "match_score": round(_average(decision.confidence for decision in decisions), 4),
            "match_type": "multi" if len(decisions) > 1 else primary.match_type,
            "course_code": _combined_value(decisions, "course_code"),
            "course_name": _combined_value(decisions, "course_name"),
            "intent_code": _combined_value(decisions, "intent_code"),
            "domain": _combined_value(decisions, "domain"),
            "decision": _aggregate_decision(decisions).value,
            "confidence": round(_average(decision.confidence for decision in decisions), 4),
            "margin": round(_average(decision.margin for decision in decisions), 4),
            "candidates": [
                {**candidate.as_dict(), "sub_question": question}
                for question, decision in zip(questions, decisions, strict=True)
                for candidate in decision.candidates
            ],
            "sources": sources,
            "risk_level": _highest_risk(decisions),
            "requires_confirmation": any(decision.requires_confirmation for decision in decisions),
            "clarification_question": _combined_clarification(decisions),
            "router_version": primary.router_version,
            "taxonomy_version": primary.taxonomy_version,
        }


    def _query_decision(self, db: Session, user: User, plan: QuestionPlan, index: int) -> IntentDecision:
        question = plan.questions[index]
        try:
            if self.intent_router is None:
                return self.document_service.query(db, question)
            decision = self.intent_router.route(
                db, user=user, message=question, original_query=plan.original_queries[index],
                retrieval_queries=plan.retrieval_queries[index], rewrite_strategies=plan.rewrite_strategies[index],
                rewrite_version=plan.rewrite_version, query_target=plan.query_targets[index],
            )
            decision = self.faq_orchestrator.ground_embedding_answers(questions=[question], decisions=[decision])[0]
            return _compose_out_of_scope_reply(
                db=db, orchestrator=self.faq_orchestrator, original_question=plan.original_queries[index],
                standalone_question=question, retrieval_queries=plan.retrieval_queries[index], decision=decision,
            )
        except Exception as exc:
            db.rollback()
            logger.warning("Knowledge tool failed (%s)", type(exc).__name__)
            return tool_error_decision()


def _primary_decision(decisions: list[IntentDecision]) -> IntentDecision:
    priority = {
        IntentDecisionType.handoff: 4,
        IntentDecisionType.clarify: 3,
        IntentDecisionType.accept: 2,
        IntentDecisionType.reject: 1,
        IntentDecisionType.out_of_scope: 0,
    }
    return max(decisions, key=lambda decision: priority[decision.decision])


def _aggregate_decision(decisions: list[IntentDecision]) -> IntentDecisionType:
    kinds = {decision.decision for decision in decisions}
    if IntentDecisionType.handoff in kinds:
        return IntentDecisionType.handoff
    if IntentDecisionType.clarify in kinds:
        return IntentDecisionType.clarify
    if kinds == {IntentDecisionType.out_of_scope}:
        return IntentDecisionType.out_of_scope
    if IntentDecisionType.accept in kinds:
        return IntentDecisionType.accept
    return _primary_decision(decisions).decision


def _combined_sources(decisions: list[IntentDecision], planned_by_llm: bool, composed_by_llm: bool) -> list[str]:
    sources: list[str] = []
    if planned_by_llm:
        sources.append("LLM_TOOL_CALL")
    for decision in decisions:
        fallback_sources = [] if decision.match_type == "none" else [decision.match_type.upper()]
        for source in decision.sources or fallback_sources:
            if source and source not in sources:
                sources.append(source)
    if composed_by_llm:
        sources.append("LLM_COMPOSE")
    return sources


def _combined_value(decisions: list[IntentDecision], field: str) -> str:
    values = list(dict.fromkeys(str(getattr(decision, field)) for decision in decisions))
    return ",".join(values)


def _average(values: Iterable[float]) -> float:
    items = list(values)
    return sum(items) / len(items) if items else 0.0


def _highest_risk(decisions: list[IntentDecision]) -> str:
    levels = {"low": 0, "medium": 1, "high": 2}
    return max((decision.risk_level for decision in decisions), key=lambda value: levels.get(value.lower(), 0))


def _combined_clarification(decisions: list[IntentDecision]) -> str | None:
    values = [decision.clarification_question for decision in decisions if decision.clarification_question]
    return "\n".join(values) or None


def _compose_out_of_scope_reply(
    *,
    db: Session,
    orchestrator: FAQOrchestrator,
    original_question: str,
    standalone_question: str,
    retrieval_queries: list[str],
    decision: IntentDecision,
) -> IntentDecision:
    if decision.decision != IntentDecisionType.out_of_scope:
        return decision

    composed = orchestrator.compose_out_of_scope(
        original_question=original_question,
        standalone_question=standalone_question,
        retrieval_queries=retrieval_queries,
        available_intents=_available_intent_options(db),
    )
    sources = list(decision.sources)
    if composed.llm_used:
        sources.append("LLM_OUT_OF_SCOPE_RESPONSE")
    return replace(
        decision,
        answer=composed.answer,
        sources=sources,
        clarification_question=composed.answer,
    )


def _available_intent_options(db: Session) -> list[dict[str, str]]:
    definitions = list(
        db.scalars(
            select(IntentDefinition)
            .where(
                IntentDefinition.is_active.is_(True),
                IntentDefinition.is_deleted.is_(False),
                IntentDefinition.intent_code.not_in(("greeting", "stop")),
            )
            .order_by(
                IntentDefinition.course_name,
                IntentDefinition.display_name,
                IntentDefinition.intent_id,
            )
        )
    )
    return [
        {
            "intent_id": definition.intent_id,
            "course_name": definition.course_name,
            "intent_name": definition.display_name,
            "description": definition.description,
        }
        for definition in definitions
    ]
