from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass

from app.intent.models import IntentDecision, IntentDecisionType
from app.llm.faq_orchestrator import ComposedAnswer, FAQOrchestrator, QuestionPlan
from app.llm.tools import CONVERSATION_TOOLS


def handoff_decision() -> IntentDecision:
    return IntentDecision(
        course_code="", course_name="", intent_code="handoff", domain="support",
        intent_id="support.handoff", decision=IntentDecisionType.handoff,
        answer="好的，我会为你转接人工客服。", confidence=1.0, margin=0.0,
        sources=["LLM_HANDOFF"], match_type="model_handoff",
    )


def tool_error_decision() -> IntentDecision:
    return IntentDecision(
        course_code="", course_name="", intent_code="", domain="", intent_id="none",
        decision=IntentDecisionType.clarify,
        answer="暂时无法查询这条信息，请稍后再试。", confidence=0.0, margin=0.0,
        sources=["TOOL_ERROR"], match_type="tool_error",
    )


@dataclass
class ToolChainResult:
    plan: QuestionPlan
    decisions: list[IntentDecision]
    composed: ComposedAnswer
    rounds: int
    call_count: int
    stop_reason: str
    trace: list[dict]


def run_tool_chain(
    *, orchestrator: FAQOrchestrator, initial: QuestionPlan, original: str,
    history: list[dict[str, str]], execute: Callable[[QuestionPlan, int], IntentDecision],
) -> ToolChainResult:
    """Execute bounded batches, preserving the native assistant/tool transcript."""
    max_rounds = max(1, orchestrator.settings.llm_max_tool_rounds)
    max_calls = max(1, orchestrator.settings.llm_max_tool_calls)
    cache: dict[tuple[str, str], IntentDecision] = {}
    attempts: dict[tuple[str, str], int] = {}
    records: list[tuple[QuestionPlan, int, IntentDecision]] = []
    trace: list[dict] = []
    pending: QuestionPlan | None = None if initial.mode == "invalid_tools" else initial
    messages = initial.tool_messages
    rounds = call_count = 0
    stop_reason = "completed"
    response = None

    while True:
        rounds += 1
        calls = messages[-1]["tool_calls"]
        over_budget = len(calls) > max_calls - call_count
        new_queries = 0
        if over_budget or pending is None:
            status = "call_limit" if over_budget else "invalid_arguments"
            if not over_budget:
                call_count += len(calls)
            for call in calls:
                messages = [*messages, {
                    "role": "tool", "tool_call_id": call["id"],
                    "content": json.dumps({
                        "status": "error", "error": status,
                        "message": "工具调用未执行，请检查工具名称、参数和调用数量；转人工须单独调用。",
                    }, ensure_ascii=False),
                }]
                trace.append({"round": rounds, "tool": call["function"]["name"], "status": status})
        else:
            call_count += len(calls)
            if pending.mode == "handoff":
                decision = handoff_decision()
                trace.append({"round": rounds, "tool": "request_human_handoff", "status": "handoff"})
                return ToolChainResult(
                    pending, [decision], ComposedAnswer(decision.answer, False),
                    rounds, call_count, "handoff", trace,
                )
            batch = []
            for index, (question, target) in enumerate(zip(pending.questions, pending.query_targets, strict=True)):
                key = (target, _query_key(question) if target == "facts" else "")
                cached = key in cache
                if cached and "TOOL_ERROR" in cache[key].sources and attempts[key] < 2:
                    cached = False
                if not cached:
                    decision = execute(pending, index)
                    cache[key] = decision
                    attempts[key] = attempts.get(key, 0) + 1
                    records.append((pending, index, decision))
                    new_queries += 1
                decision = cache[key]
                batch.append(decision)
                trace.append({
                    "round": rounds,
                    "tool": "list_courses" if target == "course_catalog" else "search_knowledge",
                    "query": question if target == "facts" else "",
                    "status": "cached" if cached else "error" if "TOOL_ERROR" in decision.sources else "ok",
                })
            messages = [*messages, *orchestrator.tool_results(pending, batch)]
            handoff = next((d for d in batch if d.decision == IntentDecisionType.handoff), None)
            if handoff:
                plan, decisions = _combine_records(records, initial)
                return ToolChainResult(
                    plan, decisions, ComposedAnswer(handoff.answer, False),
                    rounds, call_count, "handoff", trace,
                )

        stop_reason = (
            "call_limit" if over_budget or call_count >= max_calls
            else "round_limit" if rounds >= max_rounds
            else "repeated_query" if pending is not None and not new_queries
            else "completed"
        )
        final_only = stop_reason != "completed"
        messages = orchestrator.tool_followup_messages(
            messages, final_only=final_only, remaining_calls=max_calls - call_count,
        )
        response = orchestrator.client.complete_with_tools(
            messages, tools=CONVERSATION_TOOLS,
            tool_choice="none" if final_only else "auto", temperature=0.2,
            timeout_seconds=orchestrator.settings.llm_tool_followup_timeout_seconds,
        )
        if response is None:
            stop_reason = "model_error"
            break
        if not response.tool_calls:
            break
        if final_only:
            break
        pending = orchestrator.parse_followup_tools(
            response, messages=messages, original=original, history=history,
        )
        messages = [*messages, response.as_message()]

    plan, decisions = _combine_records(records, initial)
    composed = orchestrator.finish_tool_answer(response, questions=plan.questions, decisions=decisions)
    if response and response.content and not composed.llm_used and stop_reason == "completed":
        stop_reason = "answer_validation"
    return ToolChainResult(plan, decisions, composed, rounds, call_count, stop_reason, trace)


def _combine_records(
    records: list[tuple[QuestionPlan, int, IntentDecision]], initial: QuestionPlan,
) -> tuple[QuestionPlan, list[IntentDecision]]:
    if not records:
        return QuestionPlan(
            questions=[initial.questions[0]], original_queries=[initial.original_queries[0]],
            retrieval_queries=[[]], rewrite_strategies=[["direct"]], llm_used=True,
            rewrite_version=initial.rewrite_version,
        ), [tool_error_decision()]
    # A later successful lookup for the same course/intent resolves an earlier
    # clarification. Keep the attempt in the trace, but not as a pending question.
    effective = []
    for pos, record in enumerate(records):
        plan, index, decision = record
        resolved = decision.decision in {IntentDecisionType.clarify, IntentDecisionType.out_of_scope} and any(
            later.decision == IntentDecisionType.accept and (later.matched_fact_ids or later.document_chunks)
            and (
                _query_key(later_plan.questions[later_index]) == _query_key(plan.questions[index])
                or (
                    decision.course_code not in {"", "unknown"}
                    and decision.intent_code not in {"", "unknown", "none"}
                    and (decision.course_code, decision.intent_code) == (later.course_code, later.intent_code)
                )
            )
            for later_plan, later_index, later in records[pos + 1:]
        )
        if not resolved:
            effective.append(record)
    return QuestionPlan(
        questions=[p.questions[i] for p, i, _ in effective], llm_used=True,
        original_queries=[p.original_queries[i] for p, i, _ in effective],
        retrieval_queries=[p.retrieval_queries[i] for p, i, _ in effective],
        rewrite_strategies=[p.rewrite_strategies[i] for p, i, _ in effective],
        rewrite_used=any(p.rewrite_used for p, _, _ in records), rewrite_version=initial.rewrite_version,
    ), [decision for _, _, decision in effective]


def _query_key(query: str) -> str:
    return re.sub(r"[\s？?。！!]+", "", query).casefold()
