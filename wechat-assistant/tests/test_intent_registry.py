import pytest

from app.api.faqs import (
    create_course_definition,
    create_course_intent,
    create_faq,
    delete_course_definition,
    delete_course_intent,
    list_course_definitions,
    list_course_intents,
    update_course_definition,
    update_course_intent,
)
from app.api.schemas import (
    CourseDefinitionCreate,
    CourseDefinitionUpdate,
    CourseIntentCreate,
    CourseIntentUpdate,
    FAQCreate,
)
from app.intent.models import IntentDecisionType
from app.intent.router import IntentRouter
from app.intent.service import IntentService
from app.intent.taxonomy import COURSES, default_course_definitions, default_intent_definitions
from app.models.entities import (
    CourseDefinition,
    FAQEntry,
    IntentDefinition,
    Role,
    User,
)


class StubIntentEmbeddingService:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self.vectors = vectors

    def ensure_embeddings(self, db, definitions, *, force=False):
        return {
            definition.intent_id: self.vectors[definition.intent_id]
            for definition in definitions
        }

    def embed_query(self, query):
        return [1.0, 0.0]


def _user(db, *, username: str, role: Role) -> User:
    user = User(username=username, password_hash="x", role=role)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_default_intent_registry_does_not_include_system_course_catalog():
    definitions = default_intent_definitions()

    assert len(definitions) == 18
    assert all(definition["course_code"] not in {"general", "conversation"} for definition in definitions)
    assert all(course["course_code"] not in {"general", "conversation"} for course in default_course_definitions())
    assert all(course.code not in {"general", "conversation"} for course in COURSES)
    assert all(
        definition["intent_id"] != "course.course_catalog"
        for definition in definitions
    )


def _definition(
    *,
    intent_id: str,
    intent_code: str,
    display_name: str,
    description: str,
) -> IntentDefinition:
    return IntentDefinition(
        intent_id=intent_id,
        domain="course",
        course_code="weekly_course",
        course_name="周周有课",
        intent_code=intent_code,
        display_name=display_name,
        description=description,
        positive_examples=[],
        negative_examples=[],
        confusing_intents=[],
    )


def test_intent_registry_rrf_fuses_independent_text_and_vector_rankings(db):
    lexical_first = _definition(
        intent_id="weekly_course.lexical",
        intent_code="lexical",
        display_name="文本意图",
        description="文本排名靠前",
    )
    balanced = _definition(
        intent_id="weekly_course.balanced",
        intent_code="balanced",
        display_name="双路意图",
        description="文本与向量都相关",
    )
    vector_first = _definition(
        intent_id="weekly_course.vector",
        intent_code="vector",
        display_name="向量意图",
        description="向量排名靠前",
    )
    db.add_all([lexical_first, balanced, vector_first])
    db.commit()

    service = IntentService(
        embedding_service=StubIntentEmbeddingService(
            {
                lexical_first.intent_id: [0.6, 0.8],
                balanced.intent_id: [1.0, 0.0],
                vector_first.intent_id: [0.8, 0.6],
            }
        )
    )
    service.ensure_default_definitions = lambda db: []
    service._lexical_ranking = lambda normalized_query, definitions: [
        (lexical_first, 0.9, "similar"),
        (balanced, 0.8, "similar"),
        (vector_first, 0.7, "similar"),
    ]

    candidates = service.rank_intents(
        db,
        ["这门课是什么意图"],
        course_code="weekly_course",
        limit=3,
    )

    assert [candidate.definition.intent_id for candidate in candidates] == [
        balanced.intent_id,
        lexical_first.intent_id,
        vector_first.intent_id,
    ]
    assert candidates[0].match_type == "intent_rrf"
    assert candidates[0].lexical_rank == 2
    assert candidates[0].embedding_rank == 1
    assert candidates[0].lexical_score == pytest.approx(0.8)
    assert candidates[0].embedding_score == pytest.approx(1.0)


def test_intent_registry_uses_negative_examples_as_boundaries(db):
    content = _definition(
        intent_id="weekly_course.course_content",
        intent_code="course_content",
        display_name="课程内容",
        description="询问课程讲什么",
    )
    content.positive_examples = ["课程讲什么"]
    content.negative_examples = ["什么时候上课"]
    schedule = _definition(
        intent_id="weekly_course.schedule_location",
        intent_code="schedule_location",
        display_name="时间地点",
        description="询问什么时候上课",
    )
    schedule.positive_examples = ["什么时候上课"]
    db.add_all([content, schedule])
    db.commit()

    service = IntentService(
        embedding_service=StubIntentEmbeddingService(
            {
                content.intent_id: [0.0, 1.0],
                schedule.intent_id: [1.0, 0.0],
            }
        )
    )
    service.ensure_default_definitions = lambda db: []

    candidates = service.rank_intents(
        db,
        ["什么时候上课"],
        course_code="weekly_course",
    )

    assert candidates[0].definition.intent_id == schedule.intent_id
    assert all(
        candidate.definition.intent_id != content.intent_id
        for candidate in candidates
    )


def test_explicit_course_alias_overrides_shared_intent_examples(db):
    weekly_fact = FAQEntry(
        question="周周有课报名",
        answer="周周有课报名说明。",
        course_code="weekly_course",
        course_name="周周有课",
        intent_code="registration",
        intent_id="weekly_course.registration",
    )
    paid_fact = FAQEntry(
        question="付费课程报名",
        answer="付费课程报名说明。",
        course_code="paid_course",
        course_name="付费课程",
        intent_code="registration",
        intent_id="paid_course.registration",
    )
    db.add_all([weekly_fact, paid_fact])
    db.commit()

    candidates = IntentService().rank_courses(
        db,
        ["周周有课怎么报名"],
    )

    assert len(candidates) == 1
    assert candidates[0].course_code == "weekly_course"
    assert candidates[0].match_type == "course_contains"


def test_intent_ranking_removes_locked_course_aliases(db):
    candidates = IntentService().rank_intents(
        db,
        ["周周有课主要讲什么", "周周有课会实操吗"],
        course_code="weekly_course",
    )

    assert candidates[0].definition.intent_id == "weekly_course.course_content"
    assert candidates[0].match_type == "exact"


def test_admin_can_create_custom_course_intent(db):
    admin = _user(db, username="intent-admin", role=Role.admin)

    created = create_course_intent(
        CourseIntentCreate(
            course_code="weekly_course",
            intent_code="certificate_service",
            display_name="证书服务",
            description="用户询问课程证书和领取方式。",
            positive_examples=["有证书吗", "证书怎么领取"],
            negative_examples=["报名需要什么证件"],
        ),
        db=db,
        current_user=admin,
    )
    definitions = list_course_intents(db=db, current_user=admin)

    assert created.intent_id == "weekly_course.certificate_service"
    assert created.display_name == "证书服务"
    assert created.positive_examples == ["有证书吗", "证书怎么领取"]
    assert any(
        definition.intent_id == created.intent_id
        for definition in definitions
    )


def test_custom_intent_can_own_facts_and_participate_in_routing(db):
    admin = _user(db, username="custom-intent-admin", role=Role.admin)
    student = _user(db, username="custom-intent-student", role=Role.student)
    create_course_intent(
        CourseIntentCreate(
            course_code="weekly_course",
            intent_code="certificate_service",
            display_name="证书服务",
            positive_examples=["有证书吗", "证书怎么领取"],
        ),
        db=db,
        current_user=admin,
    )
    fact = create_faq(
        FAQCreate(
            fact_name="结业证书",
            question="有证书吗",
            answer="完成课程后可以领取电子结业证书。",
            aliases=["课程结束会发证书吗"],
            course_code="weekly_course",
            intent_code="certificate_service",
        ),
        db=db,
        current_user=admin,
    )

    decision = IntentRouter().route(
        db,
        user=student,
        message="周周有课有证书吗",
    )

    assert fact.intent_code == "certificate_service"
    assert fact.category == "证书服务"
    assert fact.intent_id == "weekly_course.certificate_service"
    assert decision.decision == IntentDecisionType.accept
    assert decision.intent_id == "weekly_course.certificate_service"
    assert decision.answer == "完成课程后可以领取电子结业证书。"


def test_admin_can_create_course_intent_and_fact_hierarchy(db):
    admin = _user(db, username="hierarchy-admin", role=Role.admin)
    student = _user(db, username="hierarchy-student", role=Role.student)
    course = create_course_definition(
        CourseDefinitionCreate(
            course_code="agent_bootcamp",
            display_name="智能体训练营",
            description="面向智能体应用开发的系统训练课程。",
            aliases=["智能体班", "Agent训练营"],
        ),
        db=db,
        current_user=admin,
    )
    intent = create_course_intent(
        CourseIntentCreate(
            course_code=course.course_code,
            intent_code="registration",
            display_name="报名方式",
            positive_examples=["怎么报名", "报名入口在哪里"],
        ),
        db=db,
        current_user=admin,
    )
    fact = create_faq(
        FAQCreate(
            fact_name="训练营报名入口",
            question="怎么报名",
            answer="请填写智能体训练营报名表。",
            course_code=course.course_code,
            intent_code=intent.intent_code,
        ),
        db=db,
        current_user=admin,
    )

    decision = IntentRouter().route(
        db,
        user=student,
        message="智能体训练营怎么报名",
    )
    courses = list_course_definitions(db=db, current_user=admin)

    assert any(item.course_code == "agent_bootcamp" for item in courses)
    assert fact.course_code == "agent_bootcamp"
    assert fact.intent_id == "agent_bootcamp.registration"
    assert decision.decision == IntentDecisionType.accept
    assert decision.course_code == "agent_bootcamp"
    assert decision.intent_id == "agent_bootcamp.registration"
    assert decision.answer == "请填写智能体训练营报名表。"


def test_course_and_intent_edits_propagate_to_facts(db):
    admin = _user(db, username="edit-hierarchy-admin", role=Role.admin)
    course = create_course_definition(
        CourseDefinitionCreate(
            course_code="agent_workshop",
            display_name="智能体工作坊",
            aliases=["Agent工作坊"],
        ),
        db=db,
        current_user=admin,
    )
    intent = create_course_intent(
        CourseIntentCreate(
            course_code=course.course_code,
            intent_code="outcomes",
            display_name="学习成果",
            positive_examples=["能学到什么"],
        ),
        db=db,
        current_user=admin,
    )
    fact = create_faq(
        FAQCreate(
            fact_name="工作坊成果",
            question="能学到什么",
            answer="可以完成一个智能体应用。",
            course_code=course.course_code,
            intent_code=intent.intent_code,
        ),
        db=db,
        current_user=admin,
    )

    update_course_definition(
        course.course_code,
        CourseDefinitionUpdate(display_name="AI 智能体工作坊"),
        db=db,
        current_user=admin,
    )
    update_course_intent(
        intent.intent_id,
        CourseIntentUpdate(display_name="产出成果"),
        db=db,
        current_user=admin,
    )
    db.refresh(fact)

    assert fact.course_name == "AI 智能体工作坊"
    assert fact.category == "产出成果"


def test_deleted_intent_stays_deleted_and_stops_its_facts(db):
    admin = _user(db, username="delete-intent-admin", role=Role.admin)
    IntentService().ensure_default_definitions(db)
    fact = create_faq(
        FAQCreate(
            fact_name="删除验证事实",
            question="删除验证讲什么",
            answer="删除验证答案。",
            course_code="weekly_course",
            intent_code="course_content",
        ),
        db=db,
        current_user=admin,
    )

    delete_course_intent(
        "weekly_course.course_content",
        db=db,
        current_user=admin,
    )
    IntentService().ensure_default_definitions(db)
    deleted = db.get(IntentDefinition, "weekly_course.course_content")
    db.refresh(fact)

    assert deleted.is_deleted is True
    assert deleted.is_active is False
    assert fact.is_active is False
    assert all(
        item.intent_id != deleted.intent_id
        for item in list_course_intents(db=db, current_user=admin)
    )


def test_deleting_course_hides_children_and_disables_facts(db):
    admin = _user(db, username="delete-course-admin", role=Role.admin)
    course = create_course_definition(
        CourseDefinitionCreate(
            course_code="temporary_course",
            display_name="临时课程",
            aliases=["临时课"],
        ),
        db=db,
        current_user=admin,
    )
    intent = create_course_intent(
        CourseIntentCreate(
            course_code=course.course_code,
            intent_code="schedule",
            display_name="时间安排",
            positive_examples=["什么时候上课"],
        ),
        db=db,
        current_user=admin,
    )
    fact = create_faq(
        FAQCreate(
            fact_name="临时课时间",
            question="什么时候上课",
            answer="临时课程周日上课。",
            course_code=course.course_code,
            intent_code=intent.intent_code,
        ),
        db=db,
        current_user=admin,
    )

    delete_course_definition(
        course.course_code,
        db=db,
        current_user=admin,
    )
    db.refresh(intent)
    db.refresh(fact)

    assert db.get(CourseDefinition, course.course_code).is_deleted is True
    assert intent.is_deleted is True
    assert fact.is_active is False
    assert all(
        item.course_code != course.course_code
        for item in list_course_definitions(db=db, current_user=admin)
    )
