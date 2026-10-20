import json

import httpx
import pytest

from app.agent.service import AgentService
from app.api.schemas import ChatResponse
from app.core.config import Settings
from app.intent.models import IntentDecision, IntentDecisionType
from app.llm.faq_orchestrator import FAQOrchestrator
from app.models.entities import ChatMessage, MessageRole, Role, User
from tests.llm_fakes import tool_call
from tests.test_tool_calling import native_client


def fact(answer="请填写报名表。", *, intent="registration"):
    return IntentDecision(
        course_code="weekly_course", course_name="周周有课", intent_code=intent, domain="course",
        intent_id=f"weekly_course.{intent}", decision=IntentDecisionType.accept,
        answer=answer, confidence=1.0, margin=1.0, sources=["EXACT"], match_type="exact",
        matched_fact_ids=[f"fact-{intent}"], matched_facts=[{"statement": answer}],
    )


class Router:
    def __init__(self, *results):
        self.results = iter(results)
        self.calls = []

    def route(self, db, **kwargs):
        self.calls.append(kwargs)
        result = next(self.results)
        if isinstance(result, Exception):
            raise result
        return result


def run(db, monkeypatch, responses, outcomes, *, message="周周有课怎么报名", **settings):
    user = User(username="tool-chain", password_hash="x", role=Role.student)
    db.add(user)
    db.flush()
    client, requests = native_client(monkeypatch, *responses)
    router = Router(*outcomes)
    agent = AgentService(
        intent_router=router,
        faq_orchestrator=FAQOrchestrator(client=client, settings=Settings(_env_file=None, **settings)),
    )
    result = agent.answer(db, user=user, message=message, session_id=None)
    ChatResponse(**result)
    return result, requests, router


def search(query, call_id):
    return {"tool_calls": [tool_call("search_knowledge", {"query": query}, call_id)]}


def test_list_then_query_uses_real_tool_context_and_preserves_complete_transcript(db, monkeypatch):
    catalog = IntentDecision(
        course_code="", course_name="", intent_code="none", domain="system", intent_id="none",
        decision=IntentDecisionType.accept, answer="Python课程", confidence=1, margin=1,
        match_type="course_registry", sources=["COURSE_REGISTRY"],
    )
    result, requests, router = run(db, monkeypatch, [
        {"tool_calls": [tool_call("search_knowledge", {"query": "有哪些课程"}, "catalog")]},
        search("Python课程怎么报名", "registration"),
        {"content": "Python课程：请填写报名表。"},
    ], [catalog, fact()], message="你们有哪些课程，怎么报名？")
    assert result["answer"] == "Python课程：请填写报名表。"
    assert result["tool_rounds"] == result["tool_call_count"] == 2
    assert result["tool_stop_reason"] == "completed"
    assert [c["query_target"] for c in router.calls] == ["facts", "facts"]
    assert router.calls[1]["message"] == "Python课程怎么报名"
    outputs = [m for m in requests[2]["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in outputs] == ["catalog", "registration"]
    assert json.loads(outputs[0]["content"])["answer"] == "Python课程"
    assert len(requests) == 3
    assert db.query(ChatMessage).count() == 2
    assert db.query(ChatMessage).filter(ChatMessage.role == MessageRole.assistant).one().content == result["answer"]


def test_later_matching_fact_resolves_earlier_clarification(db, monkeypatch):
    missing = IntentDecision(
        course_code="weekly_course", course_name="周周有课", intent_code="registration", domain="course",
        intent_id="weekly_course.registration", decision=IntentDecisionType.clarify,
        answer="暂时没有检索到可确认的报名信息。", confidence=0, margin=0,
    )
    result, _, router = run(db, monkeypatch, [
        search("周周有课报名", "first"), search("周周有课报名入口", "refined"),
        {"content": "请填写报名表。"},
    ], [missing, fact()])
    assert len(router.calls) == 2
    assert result["decision"] == "ACCEPT"
    assert result["clarification_question"] is None
    assert result["answer"] == "请填写报名表。"
    assert len(result["tool_trace"]) == 2
    assert result["question_count"] == 1


def test_duplicate_query_reuses_result_and_forces_final_answer(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        search("周周有课怎么报名", "first"), search("周周有课怎么报名？", "repeat"),
        {"content": "请填写报名表。"},
    ], [fact()])
    assert len(router.calls) == 1
    assert result["tool_trace"][-1]["status"] == "cached"
    assert result["tool_stop_reason"] == "repeated_query"
    assert requests[-1]["tool_choice"] == "none"
    outputs = [m for m in requests[-1]["messages"] if m["role"] == "tool"]
    assert [m["tool_call_id"] for m in outputs] == ["first", "repeat"]


def test_invalid_followup_returns_error_and_model_can_correct_it(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        search("周周有课报名", "first"),
        {"tool_calls": [tool_call("search_knowledge", {"unexpected": True}, "bad")]},
        search("周周有课报名入口", "fixed"),
        {"content": "请填写报名表。"},
    ], [fact(), fact()])
    assert len(router.calls) == 2
    assert result["tool_trace"][1]["status"] == "invalid_arguments"
    error = next(m for m in requests[2]["messages"] if m.get("tool_call_id") == "bad")
    assert json.loads(error["content"])["status"] == "error"
    assert requests[-1]["tool_choice"] == "none"
    assert result["tool_stop_reason"] == "round_limit"


def test_first_invalid_batch_can_be_repaired_before_any_query_executes(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        {"tool_calls": [tool_call("search_knowledge", {}, "bad")]},
        search("周周有课怎么报名", "fixed"),
        {"content": "请填写报名表。"},
    ], [fact()])
    assert len(router.calls) == 1
    assert result["tool_trace"][0]["status"] == "invalid_arguments"
    error = next(m for m in requests[1]["messages"] if m["role"] == "tool")
    assert error["tool_call_id"] == "bad"
    assert result["answer"] == "请填写报名表。"


def test_repeated_invalid_tools_stop_with_nonempty_fallback(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        {"tool_calls": [tool_call("unknown", {}, "bad-1")]},
        {"tool_calls": [tool_call("unknown", {}, "bad-2")]},
        httpx.ReadTimeout("timeout"),
    ], [], llm_max_tool_rounds=2)
    assert not router.calls
    assert result["answer"]
    assert requests[-1]["tool_choice"] == "none"
    assert result["decision"] != "HANDOFF"


def test_tool_exception_can_be_retried_once_and_does_not_leak_error(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        search("周周有课怎么报名", "first"), search("周周有课怎么报名", "retry"),
        {"content": "请填写报名表。"},
    ], [RuntimeError("private database details"), fact()])
    assert len(router.calls) == 2
    assert result["decision"] == "ACCEPT"
    assert result["answer"] == "请填写报名表。"
    error = next(m for m in requests[1]["messages"] if m["role"] == "tool")
    assert json.loads(error["content"])["status"] == "error"
    assert "private" not in error["content"]


def test_tool_failure_cannot_be_retried_more_than_once(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        search("周周有课怎么报名", "first"), search("周周有课怎么报名", "retry"),
        search("周周有课怎么报名", "cached"), {"content": "暂时无法查询这条信息，请稍后再试。"},
    ], [RuntimeError("first failure"), RuntimeError("second failure")])
    assert len(router.calls) == 2
    assert result["tool_trace"][-1]["status"] == "cached"
    assert requests[-1]["tool_choice"] == "none"


def test_round_limit_blocks_further_execution_even_if_model_ignores_it(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        search("周周有课怎么报名", "first"), search("周周有课报名入口", "refined"),
        search("周周有课报名流程", "ignored"),
    ], [fact(), fact()], llm_max_tool_rounds=2)
    assert len(router.calls) == 2
    assert len(requests) == 3
    assert requests[-1]["tool_choice"] == "none"
    assert result["tool_stop_reason"] == "round_limit"
    assert "请填写报名表。" in result["answer"]


def test_batch_over_remaining_call_budget_is_not_partially_executed(db, monkeypatch):
    result, requests, router = run(db, monkeypatch, [
        search("周周有课报名", "first"),
        {"tool_calls": [
            tool_call("search_knowledge", {"query": "有哪些课程"}, "catalog"),
            tool_call("search_knowledge", {"query": "周周有课报名入口"}, "detail"),
        ]},
        {"content": "请填写报名表。"},
    ], [fact()], llm_max_tool_calls=2)
    assert len(router.calls) == 1
    assert result["tool_call_count"] == 1
    assert result["tool_stop_reason"] == "call_limit"
    outputs = [m for m in requests[-1]["messages"] if m["role"] == "tool"][-2:]
    assert all(json.loads(m["content"])["error"] == "call_limit" for m in outputs)


def test_model_timeout_after_lookup_returns_existing_result(db, monkeypatch):
    result, _, router = run(db, monkeypatch, [
        search("周周有课报名", "first"), httpx.ReadTimeout("timeout"),
    ], [fact()])
    assert len(router.calls) == 1
    assert result["tool_stop_reason"] == "model_error"
    assert result["answer"] == "请填写报名表。"


def test_conditional_handoff_after_lookup_returns_handoff_once(db, monkeypatch):
    missing = IntentDecision(
        course_code="weekly_course", course_name="周周有课", intent_code="registration", domain="course",
        intent_id="weekly_course.registration", decision=IntentDecisionType.clarify,
        answer="暂时没有检索到可确认的报名信息。", confidence=0, margin=0,
    )
    result, requests, router = run(db, monkeypatch, [
        search("周周有课怎么报名", "first"),
        {"tool_calls": [tool_call("request_human_handoff", {}, "handoff")]},
    ], [missing], message="周周有课怎么报名，查不到就帮我转人工")
    assert len(router.calls) == 1
    assert len(requests) == 2
    assert result["decision"] == "HANDOFF"
    assert result["answer"] == "好的，我会为你转接人工客服。"
    assert result["tool_stop_reason"] == "handoff"
    assert result["tool_rounds"] == 2


def test_no_fact_chain_can_end_with_natural_clarification(db, monkeypatch):
    answer = "暂时没有检索到可确认的安排，请问你想了解哪一期课程？"
    missing = IntentDecision(
        course_code="weekly_course", course_name="周周有课", intent_code="schedule_location", domain="course",
        intent_id="weekly_course.schedule_location", decision=IntentDecisionType.clarify,
        answer="暂时没有检索到可确认的安排。", confidence=0, margin=0,
    )
    result, _, _ = run(db, monkeypatch, [search("周周有课安排", "first"), {"content": answer}], [missing])
    assert result["answer"] == answer
    assert result["decision"] == "CLARIFY"
    assert result["tool_stop_reason"] == "completed"
