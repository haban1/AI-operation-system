from io import BytesIO

from fastapi import UploadFile
from openpyxl import Workbook
from starlette.datastructures import Headers

from app.agent.service import AgentService
from app.api.faqs import (
    correct_query_log,
    create_faq,
    disable_faq,
    get_faq_image,
    get_faq_taxonomy,
    import_faqs,
    list_faqs,
    list_unmatched_questions,
    permanently_delete_faq,
    update_faq,
    upload_faq_image,
)
from app.api.schemas import FAQCorrectionRequest, FAQCreate, FAQUpdate
from app.faq.service import FAQCandidate, FAQService
from app.intent.models import IntentDecisionType
from app.intent.router import IntentRouter, _to_intent_candidate
from app.llm.faq_orchestrator import SemanticFAQSelection
from app.models.entities import ChatMessage, FAQEmbedding, FAQEntry, FAQQueryLog, Role, User


def _user(db, *, username: str, role: Role) -> User:
    user = User(username=username, password_hash="x", role=role)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _faq(db, *, question: str, answer: str, aliases=None, keywords=None, priority=0) -> FAQEntry:
    entry = FAQEntry(
        question=question,
        answer=answer,
        aliases=aliases or [],
        keywords=keywords or [],
        priority=priority,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def test_faq_matches_exact_question_and_alias(db):
    entry = _faq(
        db,
        question="如何联系人工客服？",
        answer="工作时间内回复“人工客服”即可。",
        aliases=["怎么转人工", "人工客服在哪"],
    )
    service = FAQService(threshold=0.62)

    exact = service.match(db, "如何联系人工客服")
    alias = service.match(db, "怎么转人工？")

    assert exact.entry.id == entry.id
    assert exact.match_type == "exact"
    assert alias.entry.id == entry.id
    assert alias.match_type == "exact"


def test_faq_can_match_keywords(db):
    entry = _faq(
        db,
        question="发票开具流程",
        answer="请在订单详情中申请电子发票。",
        keywords=["发票", "开具", "订单"],
    )

    match = FAQService(threshold=0.62).match(db, "我的订单怎么开发票")

    assert match.entry.id == entry.id
    assert match.match_type == "keyword"


def test_faq_rank_many_can_recall_with_rewritten_query(db):
    entry = _faq(
        db,
        question="Claude Code课程报名后可以改期吗？",
        answer="开课前可以申请改期一次。",
    )

    candidates = FAQService(threshold=0.62).rank_many(
        db,
        ["那改期呢？", "Claude Code课程报名后可以改期吗？"],
        limit=3,
        include_zero=True,
    )

    assert candidates[0].entry.id == entry.id
    assert candidates[0].score == 1.0
    assert candidates[0].match_type == "exact"


def test_agent_returns_standard_answer_and_persists_messages(db):
    user = _user(db, username="student", role=Role.student)
    entry = _faq(
        db,
        question="退款流程是什么？",
        answer="请提交订单号，由人工客服审核退款。",
        aliases=["周周有课可以退款吗"],
    )
    entry.course_code = "weekly_course"
    entry.course_name = "周周有课"
    entry.intent_code = "pricing"
    entry.intent_id = "weekly_course.pricing"
    db.commit()

    result = AgentService(faq_service=FAQService(threshold=0.62)).answer(
        db,
        user=user,
        message="周周有课可以退款吗",
        session_id=None,
    )

    assert result["answer"] == entry.answer
    assert result["matched_faq_id"] == entry.id
    assert result["match_type"] == "exact"
    assert result["decision"] == "ACCEPT"
    assert result["domain"] == "course"
    assert result["course_code"] == "weekly_course"
    assert result["intent_code"] == "pricing"
    assert result["intent"] == "weekly_course.pricing"
    assert result["candidates"][0]["intent_id"] == "weekly_course.pricing"
    assert result["candidates"][0]["faq_id"] == "weekly_course.pricing"
    assert result["citations"] == []
    assert len(db.query(ChatMessage).all()) == 2
    assert db.get(FAQEntry, entry.id).hit_count == 1
    assert db.query(FAQQueryLog).one().matched_faq_id == entry.id


def test_agent_returns_contextual_fallback_and_records_unmatched_question(db):
    user = _user(db, username="student", role=Role.student)

    result = AgentService(faq_service=FAQService(threshold=0.62)).answer(
        db,
        user=user,
        message="一个知识库里完全没有的问题",
        session_id=None,
    )

    assert result["answer"] == ""
    assert result["matched_faq_id"] is None
    assert result["match_type"] == "none"
    assert result["decision"] == "OUT_OF_SCOPE"
    log = db.query(FAQQueryLog).one()
    assert log.matched_faq_id is None
    assert log.review_status == "pending"


def test_query_log_candidates_include_fact_name(db):
    entry = _faq(
        db,
        question="课程发票怎么开",
        answer="请在订单详情申请发票。",
    )
    entry.fact_name = "发票开具"
    entry.course_code = "weekly_course"
    entry.course_name = "周周有课"
    entry.intent_code = "pricing"
    entry.intent_id = "weekly_course.pricing"
    db.commit()

    candidate = _to_intent_candidate(
        FAQCandidate(
            entry=entry,
            score=0.8,
            match_type="similar",
        )
    )

    assert candidate.as_dict()["fact_name"] == "发票开具"


def test_router_retrieves_and_combines_facts_within_recognized_intent(db):
    user = _user(db, username="fact-user", role=Role.student)
    topic = _faq(
        db,
        question="课程主题",
        answer="周周有课主要讲解智能体应用开发。",
        aliases=["主要讲什么"],
    )
    practice = _faq(
        db,
        question="实操安排",
        answer="周周有课包含现场实操。",
        aliases=["会实操吗"],
    )
    schedule = _faq(
        db,
        question="上课地点",
        answer="周周有课在培训教室上课。",
        aliases=["在哪里上课"],
    )
    for entry in (topic, practice):
        entry.course_code = "weekly_course"
        entry.course_name = "周周有课"
        entry.intent_code = "course_content"
        entry.category = "课程内容"
        entry.domain = "course"
        entry.intent_id = "weekly_course.course_content"
    schedule.course_code = "weekly_course"
    schedule.course_name = "周周有课"
    schedule.intent_code = "schedule_location"
    schedule.category = "时间地点"
    schedule.domain = "course"
    schedule.intent_id = "weekly_course.schedule_location"
    db.commit()

    decision = IntentRouter(faq_service=FAQService(threshold=0.62)).route(
        db,
        user=user,
        message="介绍一下周周有课的课程内容",
        retrieval_queries=["周周有课主要讲什么", "周周有课会实操吗"],
    )

    assert decision.decision == IntentDecisionType.accept
    assert decision.intent_id == "weekly_course.course_content"
    assert set(decision.matched_fact_ids) == {topic.id, practice.id}
    assert topic.answer in decision.answer
    assert practice.answer in decision.answer
    assert schedule.answer not in decision.answer
    assert db.get(FAQEntry, topic.id).hit_count == 1
    assert db.get(FAQEntry, practice.id).hit_count == 1
    log = db.query(FAQQueryLog).one()
    assert set(log.matched_fact_ids) == {topic.id, practice.id}
    assert len(log.matched_facts) == 2


def test_router_returns_only_the_specific_fact_for_a_precise_question(db):
    user = _user(db, username="specific-fact-user", role=Role.student)
    topic = _faq(
        db,
        question="课程主题",
        answer="周周有课主要讲解智能体应用开发。",
        aliases=["主要讲什么"],
    )
    practice = _faq(
        db,
        question="实操安排",
        answer="周周有课包含现场实操。",
        aliases=["会实操吗"],
    )
    for entry in (topic, practice):
        entry.course_code = "weekly_course"
        entry.course_name = "周周有课"
        entry.intent_code = "course_content"
        entry.category = "课程内容"
        entry.domain = "course"
        entry.intent_id = "weekly_course.course_content"
    db.commit()

    decision = IntentRouter(faq_service=FAQService(threshold=0.62)).route(
        db,
        user=user,
        message="周周有课会实操吗",
    )

    assert decision.decision == IntentDecisionType.accept
    assert decision.matched_fact_ids == [practice.id]
    assert decision.answer == practice.answer


def test_router_uses_independent_intent_registry_instead_of_fact_intent_aggregation(db):
    user = _user(db, username="registry-user", role=Role.student)
    fact = _faq(
        db,
        question="实操安排",
        answer="周周有课包含现场实操。",
        aliases=["会实操吗"],
    )
    fact.course_code = "weekly_course"
    fact.course_name = "周周有课"
    fact.intent_code = "course_content"
    fact.category = "课程内容"
    fact.domain = "course"
    fact.intent_id = "weekly_course.course_content"
    db.commit()

    class NoFactIntentAggregationService(FAQService):
        def rank_intents(self, db, queries, *, limit=None):
            raise AssertionError("Intent recognition must not aggregate FAQ facts")

    decision = IntentRouter(
        faq_service=NoFactIntentAggregationService(threshold=0.62),
    ).route(
        db,
        user=user,
        message="周周有课会实操吗",
        retrieval_queries=["周周有课会实操吗", "会实操吗"],
    )

    assert decision.decision == IntentDecisionType.accept
    assert decision.intent_id == "weekly_course.course_content"
    assert decision.matched_fact_ids == [fact.id]


def test_router_clarifies_course_before_independent_intent_classification(db):
    user = _user(db, username="registry-course-user", role=Role.student)
    weekly = _faq(db, question="周周有课报名方式", answer="填写周周有课报名表。")
    weekly.course_code = "weekly_course"
    weekly.course_name = "周周有课"
    weekly.intent_code = "registration"
    weekly.intent_id = "weekly_course.registration"
    db.commit()

    decision = IntentRouter(faq_service=FAQService(threshold=0.62)).route(
        db,
        user=user,
        message="怎么报名",
    )

    assert decision.decision == IntentDecisionType.clarify
    assert decision.intent_id == "unknown"
    assert "周周有课" in decision.answer
    assert "付费课程" in decision.answer
    assert decision.matched_fact_ids == []


def test_course_catalog_is_answered_from_independent_course_registry(db):
    user = _user(db, username="catalog-user", role=Role.student)

    decision = IntentRouter(faq_service=FAQService(threshold=0.62)).route(
        db,
        user=user,
        message="你们有什么课",
        query_target="course_catalog",
    )

    assert decision.decision == IntentDecisionType.accept
    assert decision.domain == "system"
    assert decision.course_code == ""
    assert decision.intent_code == "none"
    assert decision.intent_id == "none"
    assert decision.candidates == []
    assert decision.match_type == "course_registry"
    assert decision.sources == ["COURSE_REGISTRY"]
    assert "周周有课" in decision.answer
    assert "付费课程" in decision.answer
    assert decision.matched_fact_ids == []


def test_router_clarifies_when_top_candidates_are_close(db):
    user = _user(db, username="student", role=Role.student)
    refund = _faq(db, question="报名后可以退款吗？", answer="退款说明")
    reschedule = _faq(db, question="报名后可以改期吗？", answer="改期说明")
    refund.course_code = "paid_course"
    refund.course_name = "付费课程"
    refund.intent_code = "pricing"
    refund.category = "费用说明"
    reschedule.course_code = "paid_course"
    reschedule.course_name = "付费课程"
    reschedule.intent_code = "schedule_location"
    reschedule.category = "时间地点"
    db.commit()

    class StubFAQService:
        def rank(self, db, question, **kwargs):
            return [
                FAQCandidate(entry=refund, score=0.73, match_type="similar"),
                FAQCandidate(entry=reschedule, score=0.69, match_type="similar"),
            ]

    decision = IntentRouter(faq_service=StubFAQService()).route(db, user=user, message="报名后怎么处理")

    assert decision.decision == IntentDecisionType.clarify
    assert decision.margin == 0.04
    assert decision.answer == "关于付费课程，你想了解“费用说明”，还是“时间地点”？"
    log = db.query(FAQQueryLog).one()
    assert log.decision == "CLARIFY"
    assert len(log.candidates) == 2


def test_router_clarifies_course_before_intent_when_candidates_cross_courses(db):
    user = _user(db, username="course-user", role=Role.student)
    weekly = _faq(db, question="周周有课怎么报名？", answer="周周有课报名说明")
    paid = _faq(db, question="付费课程怎么报名？", answer="付费课程报名说明")
    weekly.course_code = "weekly_course"
    weekly.course_name = "周周有课"
    weekly.intent_code = "registration"
    weekly.category = "报名方式"
    paid.course_code = "paid_course"
    paid.course_name = "付费课程"
    paid.intent_code = "registration"
    paid.category = "报名方式"
    db.commit()

    class StubFAQService:
        def rank(self, db, question, **kwargs):
            return [
                FAQCandidate(entry=weekly, score=0.73, match_type="similar"),
                FAQCandidate(entry=paid, score=0.70, match_type="similar"),
            ]

    decision = IntentRouter(faq_service=StubFAQService()).route(
        db,
        user=user,
        message="怎么报名",
    )

    assert decision.decision == IntentDecisionType.clarify
    assert decision.answer == "请问你想咨询的是“周周有课”，还是“付费课程”？"


def test_router_returns_out_of_scope_when_llm_rejects_ambiguous_candidates(db):
    user = _user(db, username="student", role=Role.student)
    advanced = _faq(db, question="后续有进阶课程吗？", answer="进阶课程说明")
    schedule = _faq(db, question="每周六都有这个课程吗？", answer="课程安排说明")

    class StubFAQService:
        def rank(self, db, question, **kwargs):
            return [
                FAQCandidate(entry=advanced, score=0.72, match_type="embedding"),
                FAQCandidate(entry=schedule, score=0.70, match_type="embedding"),
            ]

    class RejectingSemanticMatcher:
        def select_faq(self, question, candidates):
            return SemanticFAQSelection(faq_id=None, confidence=0.91, llm_used=True)

    decision = IntentRouter(
        faq_service=StubFAQService(),
        semantic_matcher=RejectingSemanticMatcher(),
    ).route(db, user=user, message="你们有什么课")

    assert decision.decision == IntentDecisionType.out_of_scope
    assert decision.answer == ""
    assert decision.matched_faq_id is None
    assert decision.sources == ["EMBEDDING", "LLM_SEMANTIC_REJECT"]
    assert [candidate.faq_id for candidate in decision.candidates] == [advanced.id, schedule.id]
    assert db.query(FAQQueryLog).one().decision == "OUT_OF_SCOPE"


def test_knowledge_router_does_not_infer_handoff_from_keywords(db):
    user = _user(db, username="student", role=Role.student)
    decision = IntentRouter().route(db, user=user, message="不需要转人工客服")
    assert decision.decision != IntentDecisionType.handoff
    assert "RULE" not in decision.sources


def test_router_does_not_short_circuit_stop_message(db):
    user = _user(db, username="stop-user", role=Role.student)

    decision = IntentRouter().route(db, user=user, message="结束对话")

    assert decision.match_type != "rule"
    assert "RULE" not in decision.sources
    assert decision.intent_id != "conversation.stop"


def test_router_no_longer_uses_legacy_conversation_greeting_intent(db):
    user = _user(db, username="greeting-user", role=Role.student)
    db.add(
        FAQEntry(
            fact_name="助教打招呼",
            question="你好",
            answer="我是课程智能助教。",
            aliases=["您好", "你是谁"],
            keywords=["你好", "助教"],
            course_code="conversation",
            course_name="对话服务",
            intent_code="greeting",
            category="打招呼",
            domain="conversation",
            intent_id="conversation.greeting",
        )
    )
    db.commit()

    decision = IntentRouter().route(db, user=user, message="你好")

    assert decision.intent_id != "conversation.greeting"
    assert not decision.matched_fact_ids


def test_router_no_longer_uses_legacy_conversation_company_profile(db):
    user = _user(db, username="company-profile-user", role=Role.student)
    entry = FAQEntry(
        fact_name="公司介绍",
        question="你们是做什么的？",
        answer="我们专注人工智能应用落地与 AI 人才能力建设。",
        aliases=["介绍一下你们公司", "你们公司简介", "贵公司介绍"],
        keywords=["公司介绍", "智慧驱动", "机构"],
        course_code="conversation",
        course_name="对话服务",
        intent_code="company_profile",
        category="公司介绍",
        domain="conversation",
        intent_id="conversation.company_profile",
    )
    db.add(entry)
    db.commit()

    decision = IntentRouter().route(
        db,
        user=user,
        message="介绍一下你们公司",
        retrieval_queries=[
            "介绍一下你们公司",
            "你们公司简介",
            "贵公司介绍",
        ],
    )

    assert decision.intent_id != "conversation.company_profile"
    assert decision.matched_faq_id is None


def test_faq_can_be_created_without_manual_question(db):
    admin = _user(db, username="fact-name-only-admin", role=Role.admin)

    entry = create_faq(
        FAQCreate(
            fact_name="课程产出",
            answer="可以完成一个可运行的 Claude Code 业务小助手。",
            image_url="https://example.com/course-qrcode.png",
            course_code="weekly_course",
            intent_code="course_content",
        ),
        db=db,
        current_user=admin,
    )

    assert entry.question == "课程产出"
    assert entry.image_url == "https://example.com/course-qrcode.png"
    assert entry.fact_name == "课程产出"
    assert entry.answer == "可以完成一个可运行的 Claude Code 业务小助手。"


def test_faq_can_store_and_serve_uploaded_image(db):
    admin = _user(db, username="image-admin", role=Role.admin)
    entry = _faq(
        db,
        question="报名入口",
        answer="请填写报名信息。",
    )
    uploaded = UploadFile(
        file=BytesIO(b"fake-png"),
        filename="signup.png",
        headers=Headers({"content-type": "image/png"}),
    )

    saved = upload_faq_image(
        entry.id,
        file=uploaded,
        db=db,
        current_user=admin,
    )
    image_response = get_faq_image(entry.id, db)

    assert saved.image_data == b"fake-png"
    assert saved.image_filename == "signup.png"
    assert saved.image_content_type == "image/png"
    assert image_response.media_type == "image/png"
    assert image_response.body == b"fake-png"


def test_admin_can_manage_faqs_and_review_unmatched_questions(db):
    admin = _user(db, username="admin", role=Role.admin)
    entry = create_faq(
        FAQCreate(
            fact_name="服务时间",
            question="服务时间是什么时候？",
            answer="工作日 9:00-18:00。",
            aliases=["几点上班"],
            keywords=["服务时间"],
            course_code="weekly_course",
            intent_code="schedule_location",
            priority=5,
        ),
        db=db,
        current_user=admin,
    )

    updated = update_faq(
        entry.id,
        FAQUpdate(
            fact_name="客服服务时间",
            answer="每天 9:00-18:00。",
            priority=10,
        ),
        db=db,
        current_user=admin,
    )
    db.add(FAQQueryLog(user_id=admin.id, question="周末有人吗", match_score=0.2))
    db.commit()

    rows = list_faqs(include_inactive=True, db=db, current_user=admin)
    unmatched = list_unmatched_questions(limit=100, db=db, current_user=admin)

    assert rows[0].answer == "每天 9:00-18:00。"
    assert rows[0].fact_name == "客服服务时间"
    assert rows[0].question == "服务时间是什么时候？"
    assert rows[0].aliases == ["几点上班"]
    assert rows[0].priority == 10
    assert rows[0].course_code == "weekly_course"
    assert rows[0].course_name == "周周有课"
    assert rows[0].intent_code == "schedule_location"
    assert rows[0].domain == "course"
    assert rows[0].intent_id == "weekly_course.schedule_location"
    assert unmatched[0].question == "周末有人吗"

    disable_faq(entry.id, db=db, current_user=admin)
    assert db.get(FAQEntry, entry.id).is_active is False


def test_admin_can_read_hierarchical_faq_taxonomy(db):
    admin = _user(db, username="taxonomy-admin", role=Role.admin)

    taxonomy = get_faq_taxonomy(current_user=admin)

    assert taxonomy.version == "faq-taxonomy-v3"
    assert [item.code for item in taxonomy.domains] == [
        "course",
        "support",
    ]
    assert taxonomy.courses[0].code == "weekly_course"
    assert taxonomy.courses[0].label == "周周有课"
    assert any(item.code == "paid_course" for item in taxonomy.courses)
    assert any(item.code == "course_content" for item in taxonomy.intents)


def test_admin_can_permanently_delete_faq_and_preserve_query_logs(db):
    admin = _user(db, username="admin", role=Role.admin)
    entry = _faq(db, question="部署验证问题", answer="部署验证答案")
    db.add(
        FAQEmbedding(
            faq_id=entry.id,
            model="test-embedding",
            source_hash="hash",
            dimension=2,
            vector=[1.0, 0.0],
        )
    )
    matched_log = FAQQueryLog(
        user_id=admin.id,
        question="部署验证",
        matched_faq_id=entry.id,
        decision="ACCEPT",
        review_status="not_required",
    )
    corrected_log = FAQQueryLog(
        user_id=admin.id,
        question="部署测试",
        corrected_faq_id=entry.id,
        decision="OUT_OF_SCOPE",
        review_status="reviewed",
    )
    db.add_all([matched_log, corrected_log])
    db.commit()

    permanently_delete_faq(entry.id, db=db, current_user=admin)

    assert db.get(FAQEntry, entry.id) is None
    assert db.get(FAQEmbedding, entry.id) is None
    db.refresh(matched_log)
    db.refresh(corrected_log)
    assert matched_log.matched_faq_id is None
    assert matched_log.decision == "ACCEPT"
    assert corrected_log.corrected_faq_id is None
    assert corrected_log.review_status == "reviewed"


def test_admin_correction_can_add_query_as_alias(db):
    admin = _user(db, username="admin", role=Role.admin)
    entry = _faq(db, question="怎么报名？", answer="请填写报名表。")
    log = FAQQueryLog(
        user_id=admin.id,
        question="我想报课",
        decision="CLARIFY",
        review_status="pending",
        candidates=[],
        sources=[],
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    corrected = correct_query_log(
        log.id,
        FAQCorrectionRequest(
            corrected_faq_id=entry.id,
            correction_note="人工确认属于报名咨询",
            add_as_alias=True,
        ),
        db=db,
        current_user=admin,
    )

    assert corrected.review_status == "reviewed"
    assert corrected.corrected_faq_id == entry.id
    assert "我想报课" in db.get(FAQEntry, entry.id).aliases


def test_admin_can_import_wecom_faq_workbook(db):
    admin = _user(db, username="admin", role=Role.admin)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "快捷回复列表"
    sheet.append(["分类", "标准问题", "相似问法", "标准答案"])
    sheet.append(["报名试听", "怎么报名？", "报名入口\n我要报名", "请填写报名表。"])
    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)

    result = import_faqs(
        file=UploadFile(file=buffer, filename="faqs.xlsx"),
        db=db,
        current_user=admin,
    )

    entry = db.query(FAQEntry).one()
    assert result.created == 1
    assert entry.question == "怎么报名？"
    assert entry.fact_name == "报名入口"
    assert entry.aliases == ["报名入口", "我要报名"]
    assert entry.answer == "请填写报名表。"
