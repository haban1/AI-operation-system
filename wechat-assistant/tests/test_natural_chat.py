from tests.llm_fakes import tool_call
from app.llm.client import ChatCompletion

import pytest

from app.agent.service import AgentService
from app.api.schemas import ChatResponse
from app.core.config import Settings
from app.llm.faq_orchestrator import FAQOrchestrator
from app.models.entities import ChatMessage, ChatSession, FAQEntry, FAQQueryLog, MessageRole, Role, User
from tests.test_document_knowledge import NoEmbedding, index
from app.knowledge.service import DocumentKnowledgeService


class ChatClient:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def complete(self, messages, **kwargs):
        self.calls.append(messages)
        return next(self.responses)

    def complete_with_tools(self, messages, **kwargs):
        self.calls.append(messages)
        return next(self.responses, None)


@pytest.mark.parametrize("message,reply", [
    ("在吗", "在的，有什么想咨询的？"),
    ("哈喽呀", "哈喽！有什么可以帮你？"),
    ("谢谢你", "不客气，有问题随时来问。"),
    ("先这样，拜拜", "好的，回头见！"),
    ("你是谁呀", "我是课程客服智能助教，可以帮你了解课程。"),
    ("结束对话", "好的，需要帮助时随时来找我。"),
])
def test_social_messages_use_model_reply_and_keep_history(db, message, reply):
    user = User(username="natural-chat", password_hash="x", role=Role.student)
    db.add(user)
    db.flush()
    session = ChatSession(user_id=user.id)
    db.add(session)
    db.flush()
    db.add(ChatMessage(
        session_id=session.id, user_id=user.id, role=MessageRole.assistant,
        content="请问你想咨询周周有课，还是付费课程？",
    ))
    db.commit()
    client = ChatClient(ChatCompletion(content=reply))
    settings = Settings(_env_file=None, assistant_role_prompt="你是课程客服智能助教。")
    result = AgentService(faq_orchestrator=FAQOrchestrator(client=client, settings=settings)).answer(
        db, user=user, message=message, session_id=session.id,
    )

    ChatResponse(**result)
    assert result["answer"] == reply
    assert result["intent"] == "none"
    assert result["decision"] == "ACCEPT"
    assert result["sources"] == ["LLM_REPLY"]
    assert result["matched_fact_ids"] == []
    assert result["retrieval_queries"] == [[]]
    assert result["llm_used"] and not result["rewrite_used"]
    assert db.query(FAQQueryLog).count() == 0
    assert db.query(ChatMessage).count() == 3
    assert len(client.calls) == 1
    assert client.calls[0][0]["content"].startswith(settings.assistant_role_prompt)
    assert client.calls[0][1:-1]


@pytest.mark.parametrize("preamble", [None, "你好！"])
def test_greeting_with_business_question_still_retrieves_documents(db, preamble):
    user = User(username="mixed-chat", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    service = DocumentKnowledgeService(embedding_client=NoEmbedding())
    index(db, user, service, "周周有课本期课程免费。")
    chunk = service.search(db, "周周有课多少钱")[0]
    client = ChatClient(
        ChatCompletion(content=preamble, tool_calls=[tool_call("search_knowledge", {"query": "周周有课多少钱"})]),
        ChatCompletion(content=f"本期课程免费。[来源:{chunk['chunk_id']}]"),
    )
    result = AgentService(document_service=service, faq_orchestrator=FAQOrchestrator(client=client)).answer(
        db, user=user, message="在吗，周周有课多少钱？", session_id=None,
    )
    assert result["matched_faq_id"] is None
    assert "本期课程免费。" in result["answer"]
    assert result["citations"]
    assert "LLM_REPLY" not in result["sources"]


def test_explicit_handoff_is_selected_by_model(db):
    user = User(username="handoff-chat", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    client = ChatClient(ChatCompletion(tool_calls=[tool_call("request_human_handoff", {})]))
    result = AgentService(faq_orchestrator=FAQOrchestrator(client=client)).answer(
        db, user=user, message="你好，请转人工客服", session_id=None,
    )
    assert result["decision"] == "HANDOFF"
    assert result["answer"] == "好的，我会为你转接人工客服。"
    assert len(client.calls) == 1
    assert result["sources"] == ["LLM_HANDOFF"]
    assert result["retrieval_queries"] == [[]]
    assert db.query(FAQQueryLog).count() == 0


@pytest.mark.parametrize("raw", [None, ChatCompletion(content="")])
def test_failed_planning_preserves_business_query(raw):
    plan = FAQOrchestrator(client=ChatClient(raw)).plan("周周有课多少钱？")
    assert plan.direct_reply is None
    assert plan.questions == ["周周有课多少钱？"]


@pytest.mark.parametrize("message,reply", [
    ("不需要转人工", "好的，你可以继续在这里咨询。"),
    ("你能转人工吗", "可以，需要我帮你转接吗？"),
    ("别人说‘找老师’，这是什么意思", "你是指哪句话里的‘找老师’？"),
])
def test_handoff_keywords_do_not_override_model_reply(db, message, reply):
    user = User(username="no-handoff", password_hash="x", role=Role.student)
    db.add(user)
    db.flush()
    client = ChatClient(ChatCompletion(content=reply))
    result = AgentService(faq_orchestrator=FAQOrchestrator(client=client)).answer(
        db, user=user, message=message, session_id=None,
    )
    assert result["decision"] == "ACCEPT"
    assert result["answer"] == reply
    assert result["sources"] == ["LLM_REPLY"]
    assert len(client.calls) == 1


def test_handoff_confirmation_uses_previous_offer(db):
    user = User(username="confirm-handoff", password_hash="x", role=Role.student)
    db.add(user)
    db.flush()
    client = ChatClient(
        ChatCompletion(content="可以，需要我帮你转接吗？"),
        ChatCompletion(tool_calls=[tool_call("request_human_handoff", {})]),
    )
    agent = AgentService(faq_orchestrator=FAQOrchestrator(client=client))
    first = agent.answer(db, user=user, message="你能转人工吗", session_id=None)
    second = agent.answer(db, user=user, message="好的", session_id=first["session_id"])
    assert second["decision"] == "HANDOFF"
    assert second["answer"] == "好的，我会为你转接人工客服。"
    history = client.calls[1][1:-1]
    assert history[-1] == {"role": "assistant", "content": first["answer"]}
    assert db.query(ChatMessage).count() == 4


@pytest.mark.parametrize("message", ["周周有课上", "我想了解一下周周有课上", "星空训练营"])
def test_incomplete_queries_use_model_clarification_without_retrieval(db, message):
    user = User(username="clarify-chat", password_hash="x", role=Role.student)
    db.add(user)
    db.flush()
    reply = "你想具体了解这门课的哪方面？"
    client = ChatClient(ChatCompletion(content=reply))
    result = AgentService(faq_orchestrator=FAQOrchestrator(client=client)).answer(
        db, user=user, message=message, session_id=None,
    )
    ChatResponse(**result)
    assert result["decision"] == "ACCEPT"
    assert result["answer"] == reply
    assert result["retrieval_queries"] == [[]]
    assert result["matched_fact_ids"] == []
    assert result["sources"] == ["LLM_REPLY"]
    assert db.query(FAQQueryLog).count() == 0
    assert len(client.calls) == 1


@pytest.mark.parametrize("calls", [
    [tool_call("unknown", {})],
    [tool_call("request_human_handoff", {"reply": "已转接"})],
    [tool_call("search_knowledge", {"query": "多少钱", "target": "delete"})],
    [tool_call("search_knowledge", {"query": "多少钱", "target": []})],
    [tool_call("search_knowledge", {"query": ""})],
    [tool_call("request_human_handoff", {}), tool_call("search_knowledge", {"query": "多少钱"}, "call-2")],
])
def test_invalid_tools_preserve_original_query_for_repair_without_handoff(calls):
    plan = FAQOrchestrator(client=ChatClient(ChatCompletion(tool_calls=calls))).plan("周周有课多少钱？")
    assert plan.llm_used
    assert plan.mode == "invalid_tools"
    assert plan.questions == ["周周有课多少钱？"]
    assert plan.direct_reply is None


def test_catalog_and_business_question_are_both_answered(db):
    user = User(username="catalog-and-pricing", password_hash="x", role=Role.student)
    db.add(user)
    db.flush()
    service = DocumentKnowledgeService(embedding_client=NoEmbedding())
    index(db, user, service, "目前开设周周有课和付费课程。周周有课本期免费。")
    client = ChatClient(ChatCompletion(tool_calls=[
        tool_call("search_knowledge", {"query": "开设哪些课程"}, "catalog"),
        tool_call("search_knowledge", {"query": "周周有课多少钱"}, "pricing"),
    ]), None)
    result = AgentService(document_service=service, faq_orchestrator=FAQOrchestrator(client=client)).answer(
        db, user=user, message="都开了哪些课？周周有课多少钱？", session_id=None,
    )
    assert result["question_count"] == 2
    assert "付费课程" in result["answer"]
    assert "本期免费" in result["answer"]
    assert result["matched_fact_ids"] == []
    assert "DOCUMENT_RETRIEVAL" in result["sources"]
    assert db.query(FAQQueryLog).count() == 0
