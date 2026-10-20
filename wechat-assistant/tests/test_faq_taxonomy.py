from app.intent.taxonomy import intent_id_for, normalize_taxonomy


def test_legacy_weekly_course_faq_is_mapped_to_two_level_taxonomy():
    course_code, course_name, intent_code = normalize_taxonomy(
        question="怎么报名？",
        category="报名咨询",
        domain="报名咨询",
        intent_id="报名咨询.faq",
    )

    assert course_code == "weekly_course"
    assert course_name == "周周有课"
    assert intent_code == "registration"
    assert intent_id_for(course_code, intent_code) == "weekly_course.registration"


def test_legacy_advanced_course_faq_is_mapped_to_paid_course():
    course_code, course_name, intent_code = normalize_taxonomy(
        question="后续有进阶课程吗？",
        category="进阶课程",
        domain="进阶课程",
        intent_id="进阶课程.faq",
    )

    assert course_code == "paid_course"
    assert course_name == "付费课程"
    assert intent_code == "general"


def test_cross_course_and_support_questions_are_general():
    catalog = normalize_taxonomy(
        question="你们有什么课？",
        category="其他课程",
    )
    support = normalize_taxonomy(
        question="如何联系人工客服？",
        category="客服服务",
    )

    assert catalog == ("general", "跨课程咨询", "general")
    assert support == ("general", "跨课程咨询", "general")
    assert intent_id_for(*catalog[::2]) == "course.general"


def test_explicit_v2_selection_is_preserved():
    result = normalize_taxonomy(
        question="怎么报名？",
        course_code="general",
        course_name="跨课程咨询",
        intent_code="general",
        category="报名咨询",
    )

    assert result == ("general", "跨课程咨询", "general")


def test_course_content_takes_priority_over_audience_keyword():
    result = normalize_taxonomy(
        question="Claude Code 零基础课讲什么？",
        category="课时内容",
    )

    assert result == ("weekly_course", "周周有课", "course_content")
