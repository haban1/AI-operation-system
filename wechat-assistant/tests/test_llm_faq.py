import json

from tests.llm_fakes import native_response

from app.agent.service import AgentService
from app.faq.service import FAQCandidate, FAQService
from app.intent.models import IntentCandidate, IntentDecision, IntentDecisionType
from app.intent.router import IntentRouter
from app.llm.faq_orchestrator import FAQOrchestrator
from app.models.entities import ChatMessage, FAQEntry, FAQQueryLog, Role, User


class FakeChatClient:
    def __init__(self, responses: list[str | None]) -> None:
        self.responses = iter(responses)
        self.calls: list[list[dict[str, str]]] = []

    def complete(self, messages: list[dict[str, str]], *, temperature: float = 0.0) -> str | None:
        self.calls.append(messages)
        return next(self.responses)

    def complete_with_tools(self, messages, **kwargs):
        self.calls.append(messages)
        return native_response(next(self.responses, None))



class StubEmbeddingFAQService:
    def __init__(self, entry: FAQEntry, score: float = 0.7) -> None:
        self.entry = entry
        self.score = score

    def rank(self, db, question, **kwargs):
        return [
            FAQCandidate(
                entry=self.entry,
                score=self.score,
                match_type="embedding",
            )
        ]


def _user(db) -> User:
    user = User(username="multi-user", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _faq(
    db,
    *,
    question: str,
    answer: str,
    course_code: str = "general",
    intent_code: str = "general",
) -> FAQEntry:
    entry = FAQEntry(
        question=question,
        answer=answer,
        course_code=course_code,
        course_name="周周有课" if course_code == "weekly_course" else "跨课程咨询",
        intent_code=intent_code,
        category=intent_code,
        intent_id=(
            f"{course_code}.{intent_code}"
            if course_code != "general"
            else f"course.{intent_code}"
        ),
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def test_llm_orchestrator_splits_questions_from_tool_calls():
    client = FakeChatClient(['```json\n{"questions":["怎么报名？","可以退款吗？"]}\n```'])
    orchestrator = FAQOrchestrator(client=client)

    plan = orchestrator.plan("怎么报名，可以退款吗？")

    assert plan.questions == ["怎么报名？", "可以退款吗？"]
    assert plan.llm_used is True


def test_agent_queries_course_catalog_when_model_selects_it(db):
    user = _user(db)
    client = FakeChatClient([json.dumps({
        "mode": "knowledge", "reply": None, "questions": [{
            "original_query": "你们有什么课", "standalone_query": "你们有什么课",
            "target": "course_catalog",
        }],
    })])

    result = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="你们有什么课",
        session_id=None,
    )

    assert result["decision"] == "ACCEPT"
    assert result["domain"] == "system"
    assert result["course_code"] == ""
    assert result["intent_code"] == "none"
    assert result["intent"] == "none"
    assert result["candidates"] == []
    assert result["sources"] == ["LLM_TOOL_CALL", "COURSE_REGISTRY"]
    assert "周周有课" in result["answer"]
    assert "付费课程" in result["answer"]
    assert result["matched_fact_ids"] == []
    assert len(client.calls) == 2


def test_llm_orchestrator_contextualizes_query_and_preserves_original_branch():
    client = FakeChatClient(
        [
            (
                '{"questions":[{'
                '"original_query":"那退款呢？",'
                '"standalone_query":"Claude Code课程报名后可以退款吗？",'
                '"strategies":["contextualize"],'
                '"retrieval_variants":["Claude Code课程退款政策是什么？"]'
                "}]}"
            )
        ]
    )
    orchestrator = FAQOrchestrator(client=client)

    plan = orchestrator.plan(
        "那退款呢？",
        history=[
            {"role": "user", "content": "Claude Code课程怎么报名？"},
            {"role": "assistant", "content": "请填写报名表。"},
        ],
    )

    assert plan.questions == ["Claude Code课程报名后可以退款吗？"]
    assert plan.original_queries == ["那退款呢？"]
    assert plan.retrieval_queries == [
        [
            "Claude Code课程报名后可以退款吗？",
            "那退款呢？",
        ]
    ]
    assert plan.rewrite_strategies == [["contextualize"]]
    assert plan.rewrite_used is True
    assert client.calls[0][1]["content"] == "Claude Code课程怎么报名？"


def test_llm_orchestrator_rejects_rewrite_that_drops_constraints():
    client = FakeChatClient(
        [
            (
                '{"questions":[{'
                '"original_query":"不是7天内退款吗？",'
                '"standalone_query":"可以退款吗？",'
                '"strategies":["normalize"],'
                '"retrieval_variants":[]'
                "}]}"
            )
        ]
    )

    plan = FAQOrchestrator(client=client).plan("不是7天内退款吗？")

    assert plan.questions == ["不是7天内退款吗？"]
    assert plan.retrieval_queries == [["不是7天内退款吗？"]]
    assert plan.rewrite_strategies == [["direct"]]
    assert plan.rewrite_used is False


def test_llm_orchestrator_rejects_rewrite_that_invents_constraints():
    client = FakeChatClient(
        [
            (
                '{"questions":[{'
                '"original_query":"那退款呢？",'
                '"standalone_query":"Claude Code课程支持14天内退款吗？",'
                '"strategies":["contextualize"],'
                '"retrieval_variants":[]'
                "}]}"
            )
        ]
    )

    plan = FAQOrchestrator(client=client).plan(
        "那退款呢？",
        history=[{"role": "user", "content": "Claude Code课程怎么报名？"}],
    )

    assert plan.questions == ["那退款呢？"]
    assert plan.retrieval_queries == [["那退款呢？"]]
    assert plan.rewrite_used is False


def test_llm_orchestrator_generates_contextual_reply_without_facts():
    answer = (
        "暂时没有检索到可确认的本期课程信息。"
        "你更想了解课程主题、课程大纲，还是实操内容？"
    )
    client = FakeChatClient([json.dumps({"answer": answer}, ensure_ascii=False)])

    composed = FAQOrchestrator(client=client).compose_without_facts(
        original_question="周周有课上有什么课",
        standalone_question="周周有课本期有什么课程",
        retrieval_queries=[
            "周周有课上有什么课",
            "周周有课本期有什么课程",
        ],
        course_name="周周有课",
        intent_name="课程内容",
        intent_description="用户询问课程主题、教学内容或课程大纲。",
    )

    assert composed.answer == answer
    assert composed.llm_used is True
    payload = json.loads(client.calls[0][1]["content"])
    assert payload["original_question"] == "周周有课上有什么课"
    assert payload["standalone_question"] == "周周有课本期有什么课程"
    assert payload["retrieval_queries"] == [
        "周周有课上有什么课",
        "周周有课本期有什么课程",
    ]
    assert payload["retrieved_facts"] == []


def test_router_preserves_intent_and_uses_contextual_reply_when_no_fact_is_recalled(db):
    class EmptyFactService:
        def rank_facts_rrf(self, db, queries, **kwargs):
            return []

    answer = (
        "当前没有检索到可确认的课程内容信息。"
        "你想了解本期课程主题、课程大纲，还是实操内容？"
    )
    matcher = FAQOrchestrator(
        client=FakeChatClient([json.dumps({"answer": answer}, ensure_ascii=False)])
    )
    candidate = IntentCandidate(
        faq_id="weekly_course.course_content",
        question="课程内容",
        course_code="weekly_course",
        course_name="周周有课",
        intent_code="course_content",
        domain="course",
        intent_id="weekly_course.course_content",
        score=0.91,
        match_type="exact",
        risk_level="low",
        handoff_required=False,
        description="用户询问课程主题、教学内容或课程大纲。",
    )
    decision = IntentDecision(
        course_code="weekly_course",
        course_name="周周有课",
        intent_code="course_content",
        domain="course",
        intent_id="weekly_course.course_content",
        decision=IntentDecisionType.accept,
        answer="",
        confidence=0.91,
        margin=0.3,
        candidates=[candidate],
        sources=["EXACT"],
        match_type="exact",
    )

    result = IntentRouter(
        faq_service=EmptyFactService(),
        semantic_matcher=matcher,
    )._retrieve_facts(
        db,
        question="周周有课本期有什么课程",
        original_question="周周有课上有什么课",
        queries=[
            "周周有课上有什么课",
            "周周有课本期有什么课程",
        ],
        decision=decision,
    )

    assert result.decision == IntentDecisionType.clarify
    assert result.course_code == "weekly_course"
    assert result.intent_id == "weekly_course.course_content"
    assert result.answer == answer
    assert result.clarification_question == answer
    assert result.matched_fact_ids == []
    assert result.sources == ["EXACT", "NO_FACT", "LLM_NO_FACT_RESPONSE"]


def test_no_fact_reply_rejects_fabricated_business_details():
    client = FakeChatClient(
        [
            json.dumps(
                {
                    "answer": (
                        "没有检索到相关信息，但课程定于9月1日10:00开始，费用为99元。"
                    )
                },
                ensure_ascii=False,
            )
        ]
    )

    composed = FAQOrchestrator(client=client).compose_without_facts(
        original_question="什么时候上课",
        standalone_question="周周有课什么时候上课",
        retrieval_queries=["什么时候上课", "周周有课什么时候上课"],
        course_name="周周有课",
        intent_name="时间地点",
        intent_description="用户询问课程日期、时间、地点或具体安排。",
    )

    assert composed.llm_used is False
    assert composed.answer == ""



def test_agent_matches_each_llm_question_and_composes_answers(db):
    user = _user(db)
    registration = _faq(
        db,
        question="周周有课怎么报名？",
        answer="请填写报名表。",
        course_code="weekly_course",
        intent_code="registration",
    )
    refund = _faq(
        db,
        question="周周有课可以退款吗？",
        answer="付款后七天内可以申请退款。",
        course_code="weekly_course",
        intent_code="pricing",
    )
    client = FakeChatClient(
        [
            '{"questions":["周周有课怎么报名？","周周有课可以退款吗？"]}',
            (
                '{"sections":['
                '{"title":"报名","answer":"请填写报名表。"},'
                '{"title":"退款","answer":"付款后七天内可以申请退款。"}'
                "]}"
            ),
        ]
    )

    result = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="周周有课怎么报名？周周有课可以退款吗？",
        session_id=None,
    )

    assert result["question_count"] == 2
    assert result["llm_used"] is True
    assert result["match_type"] == "multi"
    assert result["decision"] == "ACCEPT"
    assert result["sources"] == ["LLM_TOOL_CALL", "QUERY_REWRITE", "EXACT", "LLM_COMPOSE"]
    assert result["sub_questions"][0]["matched_faq_id"] == registration.id
    assert result["sub_questions"][1]["matched_faq_id"] == refund.id
    assert "请填写报名表" in result["answer"]
    assert "七天内可以申请退款" in result["answer"]
    assert db.query(FAQQueryLog).count() == 2
    assert db.query(ChatMessage).count() == 2
    assert db.get(FAQEntry, registration.id).hit_count == 1
    assert db.get(FAQEntry, refund.id).hit_count == 1


def test_independent_intent_registry_routes_different_wording_before_fact_retrieval(db):
    user = _user(db)
    refund = _faq(
        db,
        question="报名后是否支持退款？",
        answer="付款后七天内可以申请退款。",
        course_code="weekly_course",
        intent_code="pricing",
    )
    refund.aliases = ["周周有课交的钱还能退回来吗"]
    db.commit()
    client = FakeChatClient(
        ['{"questions":["周周有课交的钱还能退回来吗？"]}']
    )

    result = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="周周有课交的钱还能退回来吗？",
        session_id=None,
    )

    assert result["answer"] == refund.answer
    assert result["matched_faq_id"] == refund.id
    assert result["intent"] == "weekly_course.pricing"
    assert result["match_type"] == "exact"
    assert result["sources"] == ["LLM_TOOL_CALL", "EXACT"]
    assert result["llm_used"] is True
    log = db.query(FAQQueryLog).one()
    assert log.intent_id == "weekly_course.pricing"
    assert log.matched_faq_id == refund.id


def test_independent_intent_registry_rejects_out_of_scope_question(db):
    user = _user(db)
    _faq(
        db,
        question="报名后是否支持退款？",
        answer="付款后七天内可以申请退款。",
        course_code="weekly_course",
        intent_code="pricing",
    )
    answer = (
        "我还没有识别到你具体想咨询的方向。"
        "你可以选择周周有课的课程内容、时间地点或报名方式，"
        "也可以回复“转人工客服”。"
    )
    client = FakeChatClient(
        [
            '{"questions":["公司食堂今天吃什么？"]}',
            json.dumps({"answer": answer}, ensure_ascii=False),
        ]
    )

    result = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="公司食堂今天吃什么？",
        session_id=None,
    )

    assert result["matched_faq_id"] is None
    assert result["decision"] == "OUT_OF_SCOPE"
    assert result["answer"] == answer
    assert result["sources"] == [
        "LLM_TOOL_CALL",
        "LLM_OUT_OF_SCOPE_RESPONSE",
    ]
    assert result["llm_used"] is True
    guidance_payload = json.loads(client.calls[1][1]["content"])
    available_intents = guidance_payload["available_intents"]
    assert any(
        option["intent_id"] == "weekly_course.course_content"
        for option in available_intents
    )
    assert all(
        option["intent_id"] != "conversation.greeting"
        for option in available_intents
    )


def test_out_of_scope_guidance_requires_intent_and_handoff_prompt():
    available_intents = [
        {
            "intent_id": "weekly_course.course_content",
            "course_name": "周周有课",
            "intent_name": "课程内容",
            "description": "用户询问课程主题和教学内容。",
        }
    ]
    client = FakeChatClient(
        [
            json.dumps(
                {
                    "answer": (
                        "我还没有识别到你具体想咨询的方向。"
                        "你可以了解周周有课的课程内容。"
                    )
                },
                ensure_ascii=False,
            )
        ]
    )

    composed = FAQOrchestrator(client=client).compose_out_of_scope(
        original_question="随便问问",
        standalone_question="随便问问",
        retrieval_queries=["随便问问"],
        available_intents=available_intents,
    )

    assert composed.answer == ""
    assert composed.llm_used is False


def test_embedding_fact_match_preserves_curated_statement(db):
    user = _user(db)
    refund = _faq(
        db,
        question="报名后是否支持退款？",
        answer="付款后七天内可以申请退款。",
    )
    client = FakeChatClient(
        [
            '{"questions":["交的钱还能退回来吗？"]}',
            '{"answer":"付款后七天内可以申请退款。"}',
        ]
    )

    result = AgentService(
        faq_service=StubEmbeddingFAQService(refund),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="交的钱还能退回来吗？",
        session_id=None,
    )

    assert result["answer"] == refund.answer
    assert result["match_type"] == "embedding"
    assert result["sources"] == ["LLM_TOOL_CALL", "EMBEDDING", "LLM_COMPOSE"]
    assert result["matched_fact_ids"] == [refund.id]
    assert result["matched_facts"][0]["statement"] == refund.answer
    assert result["sub_questions"][0]["answer"] == result["answer"]
    assert result["llm_used"] is True


def test_embedding_grounded_generation_falls_back_when_protected_fact_is_missing(db):
    user = _user(db)
    refund = _faq(
        db,
        question="报名后是否支持退款？",
        answer="付款后七天内可以申请退款，详情见 https://example.com/refund。",
    )
    client = FakeChatClient(
        [
            '{"questions":["交的钱还能退回来吗？"]}',
            '{"answer":"可以申请退款。"}',
        ]
    )

    result = AgentService(
        faq_service=StubEmbeddingFAQService(refund),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="交的钱还能退回来吗？",
        session_id=None,
    )

    assert result["answer"] == refund.answer
    assert result["sources"] == ["LLM_TOOL_CALL", "EMBEDDING"]
    assert "LLM_GROUNDED_ANSWER" not in result["sources"]


def test_llm_composition_rejects_modified_standard_answer(db):
    user = _user(db)
    _faq(
        db,
        question="周周有课怎么报名？",
        answer="请填写报名表。",
        course_code="weekly_course",
        intent_code="registration",
    )
    _faq(
        db,
        question="周周有课可以退款吗？",
        answer="付款后七天内可以申请退款。",
        course_code="weekly_course",
        intent_code="pricing",
    )
    client = FakeChatClient(
        [
            '{"questions":["周周有课怎么报名？","周周有课可以退款吗？"]}',
            (
                '{"sections":['
                '{"title":"报名","answer":"请直接联系我们报名。"},'
                '{"title":"退款","answer":"付款后七天内可以申请退款。"}'
                "]}"
            ),
        ]
    )

    result = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=FAQOrchestrator(client=client),
    ).answer(
        db,
        user=user,
        message="周周有课怎么报名？周周有课可以退款吗？",
        session_id=None,
    )

    assert "请直接联系我们报名" not in result["answer"]
    assert result["answer"].startswith(
        "1. 周周有课怎么报名？\n请填写报名表。"
    )
    assert "LLM_COMPOSE" not in result["sources"]


def test_llm_failure_falls_back_to_numbered_standard_answers(db):
    user = _user(db)
    _faq(
        db,
        question="周周有课怎么报名？",
        answer="请填写报名表。",
        course_code="weekly_course",
        intent_code="registration",
    )
    _faq(
        db,
        question="周周有课可以退款吗？",
        answer="付款后七天内可以申请退款。",
        course_code="weekly_course",
        intent_code="pricing",
    )
    client = FakeChatClient([None, None])
    orchestrator = FAQOrchestrator(client=client)

    result = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=orchestrator,
    ).answer(
        db,
        user=user,
        message="周周有课怎么报名？周周有课可以退款吗？",
        session_id=None,
    )

    assert result["question_count"] == 2
    assert result["llm_used"] is False
    assert result["answer"].startswith("1. 周周有课怎么报名？")
    assert "2. 周周有课可以退款吗？" in result["answer"]


def test_agent_uses_history_rewrite_and_dual_query_retrieval(db):
    user = _user(db)
    _faq(
        db,
        question="Claude Code课程怎么报名？",
        answer="请填写报名表。",
        course_code="weekly_course",
        intent_code="registration",
    )
    reschedule = _faq(
        db,
        question="Claude Code课程报名后可以改期吗？",
        answer="开课前可以申请改期一次。",
        course_code="weekly_course",
        intent_code="pricing",
    )
    client = FakeChatClient(
        [
            (
                '{"questions":[{'
                '"original_query":"Claude Code课程怎么报名？",'
                '"standalone_query":"Claude Code课程怎么报名？",'
                '"strategies":["direct"],'
                '"retrieval_variants":[]'
                "}]}"
            ),
            '{"answer":"请填写报名表。"}',
            (
                '{"questions":[{'
                '"original_query":"那改期呢？",'
                '"standalone_query":"Claude Code课程报名后可以改期吗？",'
                '"strategies":["contextualize"],'
                '"retrieval_variants":[]'
                "}]}"
            ),
            '{"answer":"开课前可以申请改期一次。"}',
        ]
    )
    service = AgentService(
        faq_service=FAQService(threshold=0.62),
        faq_orchestrator=FAQOrchestrator(client=client),
    )

    first = service.answer(
        db,
        user=user,
        message="Claude Code课程怎么报名？",
        session_id=None,
    )
    second = service.answer(
        db,
        user=user,
        message="那改期呢？",
        session_id=first["session_id"],
    )

    assert second["answer"] == reschedule.answer
    assert second["matched_faq_id"] == reschedule.id
    assert second["rewrite_used"] is True
    assert second["retrieval_queries"] == [
        ["Claude Code课程报名后可以改期吗？", "那改期呢？"]
    ]
    assert second["sources"] == [
        "LLM_TOOL_CALL",
        "QUERY_REWRITE",
        "EXACT",
        "LLM_COMPOSE",
    ]
    assert client.calls[2][1]["content"] == "Claude Code课程怎么报名？"
    assert client.calls[3][1]["content"] == "Claude Code课程怎么报名？"
    tool_result = next(item for item in client.calls[3] if item["role"] == "tool")
    assert json.loads(tool_result["content"])["facts"][0]["statement"] == reschedule.answer

    log = (
        db.query(FAQQueryLog)
        .filter(FAQQueryLog.original_query == "那改期呢？")
        .one()
    )
    assert log.question == "Claude Code课程报名后可以改期吗？"
    assert log.retrieval_queries == [
        "Claude Code课程报名后可以改期吗？",
        "那改期呢？",
    ]
    assert log.rewrite_strategies == ["contextualize"]
