import json

import httpx
import pytest

from app.agent.service import AgentService
from app.core.config import Settings
from app.intent.models import IntentDecision, IntentDecisionType
from app.llm.client import DashScopeChatClient
from app.llm.faq_orchestrator import FAQOrchestrator
from app.llm.tools import CONVERSATION_TOOLS
from app.models.entities import FAQEntry, FAQQueryLog, Role, User
from tests.llm_fakes import tool_call


def native_client(monkeypatch, *messages):
    responses = iter(messages)
    requests = []

    def post(url, **kwargs):
        requests.append(kwargs["json"])
        value = next(responses)
        if isinstance(value, Exception):
            raise value
        return httpx.Response(200, request=httpx.Request("POST", url), json={
            "choices": [{"finish_reason": "tool_calls" if value.get("tool_calls") else "stop", "message": value}],
        })

    monkeypatch.setattr("app.llm.client.httpx.post", post)
    settings = Settings(_env_file=None, llm_enabled=True, dashscope_api_key="test-key")
    return DashScopeChatClient(settings=settings), requests


def test_native_knowledge_round_trip_preserves_call_ids_and_document_results(db, monkeypatch):
    from app.knowledge.service import DocumentKnowledgeService
    from tests.test_document_knowledge import NoEmbedding, index
    user = User(username="native-roundtrip", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    service = DocumentKnowledgeService(embedding_client=NoEmbedding())
    index(db, user, service, "周周有课报名方式：请填写报名表。")
    chunk = service.search(db, "周周有课怎么报名")[0]
    call = tool_call("search_knowledge", {"query": "周周有课怎么报名"}, "native-id-42")
    client, requests = native_client(monkeypatch,
        {"role": "assistant", "content": "我来查一下。", "tool_calls": [call]},
        {"role": "assistant", "content": f"请填写报名表。[来源:{chunk['chunk_id']}]"},
    )
    result = AgentService(document_service=service, faq_orchestrator=FAQOrchestrator(client=client)).answer(
        db, user=user, message="周周有课怎么报名", session_id=None,
    )
    assert "请填写报名表。" in result["answer"]
    assert result["citations"][0]["chunk_id"] == chunk["chunk_id"]
    assert requests[0]["tools"] == CONVERSATION_TOOLS
    assert requests[0]["tool_choice"] == "auto"
    output = next(item for item in requests[1]["messages"] if item["role"] == "tool")
    assert output["tool_call_id"] == "native-id-42"
    assert json.loads(output["content"])["document_chunks"][0]["text"] == chunk["text"]
    assert db.query(FAQQueryLog).count() == 0


def test_native_plain_reply_needs_only_one_request(monkeypatch):
    client, requests = native_client(monkeypatch, {"content": "在的，有什么可以帮你？"})
    plan = FAQOrchestrator(client=client).plan("在吗")
    assert plan.direct_reply == "在的，有什么可以帮你？"
    assert not plan.tool_messages
    assert len(requests) == 1


def test_tool_followup_timeout_is_transport_option_only(monkeypatch):
    timeouts = []
    def post(url, **kwargs):
        timeouts.append(kwargs["timeout"])
        assert "timeout_seconds" not in kwargs["json"]
        return httpx.Response(200, request=httpx.Request("POST", url), json={
            "choices": [{"message": {"content": "回复"}, "finish_reason": "stop"}],
        })
    monkeypatch.setattr("app.llm.client.httpx.post", post)
    settings = Settings(_env_file=None, llm_enabled=True, dashscope_api_key="test-key", llm_timeout_seconds=20)
    client = DashScopeChatClient(settings=settings)
    client.complete_with_tools([], tools=CONVERSATION_TOOLS)
    client.complete_with_tools([], tools=CONVERSATION_TOOLS, timeout_seconds=45)
    assert timeouts == [20, 45]


@pytest.mark.parametrize("arguments", ["not-json", "[]", '{}', '{"query":"多少钱","target":"facts","extra":1}'])
def test_invalid_native_arguments_never_execute_a_tool(monkeypatch, arguments):
    call = tool_call("search_knowledge", {})
    call["function"]["arguments"] = arguments
    client, _ = native_client(monkeypatch, {"content": None, "tool_calls": [call]})
    plan = FAQOrchestrator(client=client).plan("周周有课多少钱？")
    assert plan.mode == "invalid_tools"
    assert plan.tool_messages
    assert plan.questions == ["周周有课多少钱？"]


@pytest.mark.parametrize("calls", [
    [tool_call("request_human_handoff", {}, "duplicate"), tool_call("search_knowledge", {}, "duplicate")],
    [{"type": "function", "function": {"name": "request_human_handoff", "arguments": "{}"}}],
    [{"id": "bad", "type": "function", "function": {"name": "request_human_handoff", "arguments": {}}}],
])
def test_malformed_native_envelope_is_rejected(monkeypatch, calls):
    client, _ = native_client(monkeypatch, {"content": None, "tool_calls": calls})
    assert client.complete_with_tools([], tools=CONVERSATION_TOOLS) is None


def test_timeout_keeps_original_query_and_does_not_handoff(monkeypatch):
    client, _ = native_client(monkeypatch, httpx.ReadTimeout("timeout"))
    plan = FAQOrchestrator(client=client).plan("不要转人工，周周有课多少钱")
    assert not plan.llm_used
    assert plan.mode == "knowledge"
    assert plan.questions == ["不要转人工，周周有课多少钱"]


@pytest.mark.parametrize("choice", [
    {"finish_reason": "length", "message": {"tool_calls": [tool_call("request_human_handoff", {})]}},
    {"finish_reason": "stop", "message": {"content": "回复", "tool_calls": {}}},
])
def test_incomplete_or_malformed_completion_never_becomes_an_action(monkeypatch, choice):
    def post(url, **kwargs):
        return httpx.Response(200, request=httpx.Request("POST", url), json={"choices": [choice]})
    monkeypatch.setattr("app.llm.client.httpx.post", post)
    settings = Settings(_env_file=None, llm_enabled=True, dashscope_api_key="test-key")
    result = DashScopeChatClient(settings=settings).complete_with_tools([], tools=CONVERSATION_TOOLS)
    assert result is None


def test_excess_calls_are_rejected_as_a_whole(monkeypatch):
    calls = [tool_call("search_knowledge", {"query": "课程介绍"}, str(i)) for i in range(6)]
    client, _ = native_client(monkeypatch, {"tool_calls": calls})
    plan = FAQOrchestrator(client=client, settings=Settings(_env_file=None, llm_max_questions=5)).plan("课程介绍")
    assert plan.mode == "invalid_tools"
    assert plan.tool_call_ids


def test_catalog_questions_use_document_search_without_rewrite(monkeypatch):
    client, requests = native_client(monkeypatch, {"tool_calls": [
        tool_call("search_knowledge", {"query": "你们有什么课"}),
    ]})
    plan = FAQOrchestrator(client=client, settings=Settings(_env_file=None, query_rewrite_enabled=False)).plan("你们有什么课")
    assert plan.questions == ["你们有什么课"]
    assert plan.query_targets == ["facts"]
    assert not plan.rewrite_used
    assert plan.retrieval_queries == [["你们有什么课"]]
    assert {t["function"]["name"] for t in requests[0]["tools"]} == {"search_knowledge", "request_human_handoff"}


def test_retired_catalog_tool_is_rejected(monkeypatch):
    client, _ = native_client(monkeypatch, {"tool_calls": [tool_call("list_courses", {})]})
    assert FAQOrchestrator(client=client).plan("你们有什么课").mode == "invalid_tools"


@pytest.mark.parametrize("args", [{"query": "课程列表"}, {"target": "course_catalog"}])
def test_list_courses_rejects_unexpected_arguments(monkeypatch, args):
    client, _ = native_client(monkeypatch, {"tool_calls": [tool_call("list_courses", args)]})
    plan = FAQOrchestrator(client=client).plan("你们有哪些课？")
    assert plan.mode == "invalid_tools"
    assert plan.tool_call_ids


def test_catalog_call_does_not_hide_lost_constraints_in_fact_query(monkeypatch):
    client, _ = native_client(monkeypatch, {"tool_calls": [
        tool_call("search_knowledge", {"query": "你们有哪些课程"}, "catalog"),
        tool_call("search_knowledge", {"query": "周周有课可以退款吗"}, "facts"),
    ]})
    original = "你们有哪些课程？周周有课不是7天内退款吗？"
    plan = FAQOrchestrator(client=client).plan(original)
    assert plan.questions[1] == original
    assert plan.query_targets == ["facts", "facts"]
    assert plan.tool_call_ids == ["catalog", "facts"]
    assert plan.retrieval_queries == [[original], [original]]


def test_multiple_native_results_match_calls_and_keep_subqueries_separate(monkeypatch):
    calls = [
        tool_call("search_knowledge", {"query": "周周有课多少钱"}, "weekly"),
        tool_call("search_knowledge", {"query": "付费课程多少钱"}, "paid"),
    ]
    client, requests = native_client(monkeypatch, {"tool_calls": calls}, {"content": "周周有课免费，付费课程99元。"})
    orchestrator = FAQOrchestrator(client=client)
    plan = orchestrator.plan("周周有课多少钱？付费课程多少钱？")
    assert plan.retrieval_queries == [["周周有课多少钱"], ["付费课程多少钱"]]
    decisions = [IntentDecision(
        course_code="", course_name="", intent_code="pricing", domain="course", intent_id="none",
        decision=IntentDecisionType.accept, answer=answer, confidence=1.0, margin=1.0,
        matched_fact_ids=[call_id], matched_facts=[{"statement": answer}],
    ) for call_id, answer in [("weekly", "周周有课免费"), ("paid", "付费课程99元")]]
    result = orchestrator.compose(original_message="两门课价格", questions=plan.questions, decisions=decisions, plan=plan)
    assert result.llm_used
    outputs = [item for item in requests[1]["messages"] if item["role"] == "tool"]
    assert [item["tool_call_id"] for item in outputs] == ["weekly", "paid"]
    assert [json.loads(item["content"])["answer"] for item in outputs] == [d.answer for d in decisions]


@pytest.mark.parametrize("final_message", [
    {"content": "价格是99元"},
    {"content": None, "tool_calls": [tool_call("request_human_handoff", {})]},
    httpx.ReadTimeout("timeout"),
])
def test_no_fact_result_cannot_invent_facts_or_execute_more_tools(monkeypatch, final_message):
    client, requests = native_client(monkeypatch,
        {"tool_calls": [tool_call("search_knowledge", {"query": "周周有课多少钱"})]},
        final_message,
    )
    orchestrator = FAQOrchestrator(client=client)
    plan = orchestrator.plan("周周有课多少钱")
    decision = IntentDecision(
        course_code="weekly_course", course_name="周周有课", intent_code="pricing", domain="course",
        intent_id="weekly_course.pricing", decision=IntentDecisionType.clarify,
        answer="暂时没有检索到可确认的费用信息。", confidence=0, margin=0,
    )
    result = orchestrator.compose(original_message="周周有课多少钱", questions=plan.questions, decisions=[decision], plan=plan)
    assert result.answer == decision.answer
    assert not result.llm_used
    assert len(requests) == 2
