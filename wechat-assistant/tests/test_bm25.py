from app.faq.service import FAQService
from app.intent.service import IntentService
from app.models.entities import FAQEntry, IntentDefinition
from app.retrieval.bm25 import rank_bm25, tokenize_bm25


def _intent(
    *,
    intent_id: str,
    intent_code: str,
    display_name: str,
    description: str,
    positive_examples: list[str],
) -> IntentDefinition:
    return IntentDefinition(
        intent_id=intent_id,
        domain="course",
        course_code="weekly_course",
        course_name="周周有课",
        intent_code=intent_code,
        display_name=display_name,
        description=description,
        positive_examples=positive_examples,
        negative_examples=[],
        confusing_intents=[],
    )


def _fact(
    *,
    entry_id: str,
    fact_name: str,
    question: str,
    answer: str,
    aliases: list[str],
    keywords: list[str],
    category: str,
) -> FAQEntry:
    return FAQEntry(
        id=entry_id,
        fact_name=fact_name,
        question=question,
        answer=answer,
        aliases=aliases,
        keywords=keywords,
        course_code="weekly_course",
        course_name="周周有课",
        intent_code="course_content",
        category=category,
        priority=0,
        hit_count=0,
    )


def test_bm25_ranks_chinese_business_terms_and_drops_unrelated_documents():
    documents = [
        "课程报名入口和报名流程",
        "课程上课时间和地点",
        "完成课程后领取电子结业证书",
    ]

    hits = rank_bm25("证书怎么领取", documents)

    assert [hit.index for hit in hits] == [2]
    assert "证书" in tokenize_bm25("证书怎么领取")
    assert "怎么" not in tokenize_bm25("证书怎么领取")


def test_intent_lexical_ranking_uses_bm25_order():
    certificate = _intent(
        intent_id="weekly_course.certificate",
        intent_code="certificate",
        display_name="证书服务",
        description="结业证明和电子证书领取方式",
        positive_examples=["完成课程后怎么领取证书"],
    )
    registration = _intent(
        intent_id="weekly_course.registration",
        intent_code="registration",
        display_name="报名方式",
        description="课程报名入口、报名条件和费用",
        positive_examples=["怎么报名课程"],
    )

    ranked = IntentService()._lexical_ranking(
        "我想问电子证书和领取方式",
        [registration, certificate],
    )

    assert ranked[0][0].intent_id == certificate.intent_id
    assert ranked[0][2] == "bm25"


def test_fact_lexical_ranking_uses_fact_statements_and_filters_stopwords():
    certificate = _fact(
        entry_id="certificate",
        fact_name="电子结业证书",
        question="课程完成后有证书吗",
        answer="完成课程后在学习平台领取电子结业证书。",
        aliases=["结课证明怎么领取"],
        keywords=["证书", "领取"],
        category="证书服务",
    )
    registration = _fact(
        entry_id="registration",
        fact_name="报名入口",
        question="课程怎么报名",
        answer="扫描课程海报二维码报名。",
        aliases=[],
        keywords=["报名"],
        category="报名方式",
    )

    certificate_hits = FAQService()._lexical_ranking(
        "结课证明在哪里领取",
        [registration, certificate],
    )
    registration_hits = FAQService()._lexical_ranking(
        "报名二维码在哪",
        [certificate, registration],
    )

    assert [item[0].id for item in certificate_hits] == [certificate.id]
    assert certificate_hits[0][2] == "bm25"
    assert [item[0].id for item in registration_hits] == [registration.id]
