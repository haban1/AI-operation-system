from __future__ import annotations

import pytest

from app.query_rewrite import (
    QUERY_REWRITE_PROMPT_VERSION,
    QUERY_REWRITE_SYSTEM_PROMPT,
    parse_rewrite,
)


def parse(payload, question, *, resolved=None, context='', vocabulary='', max_chars=4000):
    return parse_rewrite(payload, original_question=question, resolved_question=resolved or question,
                         context_text=context, retrieval_vocabulary=vocabulary, max_chars=max_chars)


@pytest.mark.parametrize(('question', 'canonical'), [
    ('你们这家公司到底是干啥的，能给企业帮上啥忙呀', '公司主要业务有哪些，能为企业提供哪些帮助？'),
    ('我做运营的，财务同事也想学，你们那种企业内训适不适合我们', '企业内训是否适合运营和财务岗位？'),
    ('我们配方实验记得乱七八糟的，你们能怎么把这些东西用起来', '如何整理和利用配方实验记录？'),
    ('能不能讲讲RGA的检索过程', '能否介绍RAG的检索过程？'),
    ('Skills和工作流有啥区别', 'Skill与工作流有什么区别？'),
    ('我每次都手工做海抱，这种重复活值不值得搞个skil', '重复制作海报的任务是否适合做成Skill？'),
    ('预算99块以内的培训', '99元以内的培训方案有哪些？'),
    ('人工智能能不能帮企业整理资料', 'AI能否帮助企业整理资料？'),
])
def test_colloquial_normalization_retains_observable_intent(question, canonical):
    accepted, _, diagnostic = parse({'canonical_question': canonical, 'queries': []}, question)
    assert accepted == canonical, diagnostic
    assert diagnostic['canonicalAccepted'] is True
    assert diagnostic['guardCoverage'] == 'bounded surface constraints, not proof of semantic equivalence'


@pytest.mark.parametrize('question', ['我可以去你们公司学习到什么', '我能到公司学点什么'])
def test_visit_phrase_is_not_misclassified_as_an_institution_name(question):
    canonical = '公司培训课程有哪些？'
    accepted, _, diagnostic = parse({'canonical_question': canonical}, question)
    assert accepted == canonical, diagnostic


@pytest.mark.parametrize('question', ['我可以去甲科技公司学习什么', '我们能到甲科技公司学什么'])
def test_visit_phrase_still_preserves_an_explicit_institution(question):
    accepted, _, diagnostic = parse({'canonical_question': '乙科技公司培训课程有哪些？'}, question)
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == 'missing_named_or_quoted_entity'


@pytest.mark.parametrize(('question', 'canonical', 'reason'), [
    ('培训最多500元，只限线上', '培训价格和线上线下安排是什么？', 'missing_numbers'),
    ('海报费用是多少', '海报费用是200元吗？', 'new_numbers'),
    ('本周活动怎么参加', '2027年活动怎么参加', 'new_numbers'),
    ('GPT-6.1-sol支持什么格式', 'GPT-6.1-terra支持什么格式？', 'new_ascii'),
    ('比较HTML和PPTX的可编辑性', '比较HTML和PPT的可编辑性', 'new_ascii'),
    ('“甲科技”公司提供什么服务', '“乙科技”公司提供什么服务？', 'missing_named_or_quoted_entity'),
    ('智慧动力主要提供什么服务', '启航主要提供什么服务', 'missing_named_or_quoted_entity'),
    ('我不想报名，只想了解课程内容', '课程内容是什么？', 'missing_constraint:negation'),
    ('必须线下参加培训吗', '可以线上参加培训吗', 'missing_constraint:required'),
    ('培训费用不超过500元', '培训费用超过500元吗', 'missing_constraint:less_equal'),
    ('课程是否包含财务岗位', '课程收费和报名方式是什么', 'new_intent:price'),
    ('活动包含哪些内容', '免费活动包含哪些内容', 'new_intent:free'),
    ('这家公司提供什么服务', '完全无关的天气和旅游攻略', 'no_observable_topic_anchor'),
])
def test_canonical_fact_or_constraint_changes_are_rejected(question, canonical, reason):
    accepted, _, diagnostic = parse({'canonical_question': canonical}, question)
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == reason


def test_negation_preserves_excluded_object_not_only_a_negative_word():
    accepted, _, diagnostic = parse({'canonical_question': '只了解课程内容，不需要其他说明'}, '不想报名，只了解课程内容')
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == 'missing_negated_object'


@pytest.mark.parametrize(('question', 'canonical', 'reason'), [
    ('不想报名，我想退费', '不想退费，我想报名', 'missing_negated_object'),
    ('预算500元，只限线上培训', '预算500美元，只限线上培训', 'new_quantities'),
    ('培训最多2天', '培训最多2年', 'new_quantities'),
    ('能不能退费', '如何退费', 'question_mode_changed'),
    ('如何办理退费', '能否办理退费', 'question_mode_changed'),
    ('我想知道本周活动内容', '我想知道下周活动内容', 'new_relative_times'),
    ('你们公司提供什么服务', '阿里巴巴公司提供什么服务', 'new_named_entity'),
    ('你们公司提供什么服务', '智慧驱动公司提供什么服务', 'new_named_entity'),
])
def test_independent_surface_constraint_probes_are_rejected(question, canonical, reason):
    accepted, _, diagnostic = parse({'canonical_question': canonical}, question)
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == reason


@pytest.mark.parametrize(('question', 'canonical'), [
    ('预算500块钱的培训', '预算500元的培训有哪些？'),
    ('培训最多2日', '培训最多2天'),
    ('这周活动内容有哪些', '本周活动包含哪些内容？'),
    ('不想报名，只想了解课程内容', '不需要报名，只想了解课程内容'),
    ('你们公司提供什么服务', '公司提供哪些服务？'),
])
def test_safe_unit_time_and_generic_subject_normalization_remains_allowed(question, canonical):
    accepted, _, diagnostic = parse({'canonical_question': canonical}, question)
    assert accepted == canonical, diagnostic


def test_old_resolved_conditions_are_allowed_sources_but_not_mandatory():
    canonical = 'Acme API支持哪些输入格式？'
    accepted, _, diagnostic = parse(
        {'canonical_question': canonical, 'context_used': True},
        '它支持哪些输入格式', resolved='Acme API在2026年价格500元。它支持哪些输入格式',
        context='用户此前询问Acme API在2026年的价格500元。',
    )
    assert accepted == canonical, diagnostic


def test_explicit_current_numbers_remain_mandatory_despite_old_context():
    accepted, _, diagnostic = parse(
        {'canonical_question': 'Acme API支持哪些输入格式？'},
        '它最多支持500个文件吗', resolved='Acme API最多支持500个文件吗',
        context='Acme API的介绍',
    )
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == 'missing_numbers'


def test_unique_release_title_may_supply_institution_as_a_retrieval_object_only():
    canonical = '启航公司主要业务与服务有哪些？'
    accepted, _, diagnostic = parse(
        {'canonical_question': canonical, 'context_used': False},
        '你们这家公司干啥的，能给企业帮上什么忙',
        vocabulary='启航业务与服务介绍.txt\n常见问题说明.txt',
    )
    assert accepted == canonical, diagnostic
    assert diagnostic['contextUsedReported'] is False


@pytest.mark.parametrize(('vocabulary', 'canonical', 'reason'), [
    ('甲科技公司简介\n乙科技公司简介', '甲科技公司提供什么服务', 'ambiguous_vocabulary_entity'),
    ('启航业务与服务介绍\n星河业务与服务介绍', '启航公司提供什么服务', 'ambiguous_vocabulary_entity'),
    ('甲科技公司2027年课程定价500元', '课程定价500元吗', 'new_numbers'),
    ('甲科技公司2027年课程定价500元', '2027年课程内容是什么', 'new_numbers'),
    ('课程说明 https://example.org/enroll', 'https://example.org/enroll如何使用', 'new_urls'),
    ('AI课程下周开始', '下周AI课程内容是什么', 'new_relative_times'),
])
def test_vocabulary_cannot_resolve_ambiguous_entities_or_authorize_new_facts(vocabulary, canonical, reason):
    accepted, _, diagnostic = parse({'canonical_question': canonical}, '公司课程与服务有哪些', vocabulary=vocabulary)
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == reason


def test_current_named_subject_cannot_be_replaced_or_mixed_with_scope_institution():
    vocabulary = '启航业务与服务介绍'
    assert parse({'canonical_question': '启航公司业务是什么'}, '甲科技公司业务是什么', vocabulary=vocabulary)[0] is None
    accepted, _, diagnostic = parse(
        {'canonical_question': '甲科技公司与启航公司业务有哪些'},
        '甲科技公司业务有哪些', vocabulary=vocabulary,
    )
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == 'conflicting_vocabulary_entity'


def test_explicit_context_subject_is_allowed_even_when_titles_have_multiple_institutions():
    canonical = '甲科技公司提供什么服务？'
    accepted, _, diagnostic = parse(
        {'canonical_question': canonical, 'context_used': True}, '它提供什么服务',
        context='USER: 甲科技公司的介绍', vocabulary='甲科技公司简介\n乙科技公司简介',
    )
    assert accepted == canonical, diagnostic


@pytest.mark.parametrize('term', ['AI', 'RAG', 'BGE-M3', 'GPT-4'])
def test_vocabulary_can_supply_ascii_technical_names_without_independent_numeric_facts(term):
    canonical = f'{term}企业内训是否适合运营岗位？'
    accepted, _, diagnostic = parse(
        {'canonical_question': canonical}, '企业内训适不适合运营岗',
        vocabulary=f'{term}企业内训适用岗位说明 2027年500元',
    )
    assert accepted == canonical, diagnostic


def test_vocabulary_does_not_authorize_added_enrollment_price_or_free_intents():
    for canonical in ('AI企业内训报名方式是什么', 'AI企业内训费用是多少', '免费AI企业内训内容有哪些'):
        accepted, _, diagnostic = parse(
            {'canonical_question': canonical}, '企业内训包含哪些内容',
            vocabulary='AI企业内训免费报名费用说明',
        )
        assert accepted is None
        assert diagnostic['canonicalRejectionReason'].startswith('new_intent:')


@pytest.mark.parametrize(('vocabulary', 'canonical', 'reason'), [
    ('企业内训收费USD500', '企业内训收费USD500吗', 'new_numbers'),
    ('企业内训收费RMB500', '企业内训收费RMB500吗', 'new_numbers'),
    ('企业内训收费CNY500', '企业内训收费CNY500吗', 'new_numbers'),
    ('企业内训 www.example.com', '企业内训如何通过www.example.com参加', 'new_urls'),
    ('企业内训 example.com', '企业内训如何通过example.com参加', 'new_urls'),
])
def test_vocabulary_currency_amounts_and_bare_domains_are_facts_not_technical_names(vocabulary, canonical, reason):
    accepted, _, diagnostic = parse(
        {'canonical_question': canonical}, '企业内训收费多少以及如何参加', vocabulary=vocabulary,
    )
    assert accepted is None
    assert diagnostic['canonicalRejectionReason'] == reason


def test_existing_bare_domain_can_be_preserved_without_inventing_a_different_site():
    question = 'www.example.com如何使用'
    assert parse({'canonical_question': 'www.example.com的使用方式是什么'}, question)[0]
    assert parse({'canonical_question': 'www.other.com如何使用'}, question)[2]['canonicalRejectionReason'] == 'new_urls'


def test_deterministically_resolved_subject_cannot_be_overridden_by_unique_title():
    accepted, queries, diagnostic = parse(
        {'canonical_question': '启航公司提供什么服务', 'queries': ['启航公司服务']},
        '它提供什么服务', resolved='甲科技公司提供什么服务',
        context='USER: 甲科技公司的业务是什么？', vocabulary='启航业务与服务介绍',
    )
    assert accepted is None and queries == []
    assert diagnostic['canonicalRejectionReason'] == 'conflicting_vocabulary_entity'
    assert diagnostic['queryRejections'] == [{'index': 0, 'reason': 'conflicting_vocabulary_entity'}]


def test_explicit_context_may_supply_subject_without_adding_an_unknown_name():
    canonical = 'Acme API支持哪些输入格式？'
    accepted, _, diagnostic = parse({'canonical_question': canonical, 'context_used': True},
                                    '它支持哪些输入格式', context='USER: Acme API的用法是什么？')
    assert accepted == canonical, diagnostic
    assert diagnostic['contextUsedReported'] is True


@pytest.mark.parametrize('value', [None, [], 'not json', 3])
def test_invalid_payload_falls_back_without_raising(value):
    canonical, queries, diagnostic = parse(value, '如何学习AI？')
    assert canonical is None and queries == []
    assert diagnostic['canonicalRejectionReason'] == 'payload_not_object'


def test_legacy_schema_can_expand_recall_but_cannot_choose_reranking_query():
    canonical, queries, diagnostic = parse({'queries': ['AI学习方法', '如何学习AI？']}, '如何学习AI？')
    assert canonical is None
    assert queries == ['AI学习方法', '如何学习AI？']
    assert diagnostic['canonicalRejectionReason'] == 'canonical_missing_legacy_recall_only'


def test_invalid_canonical_keeps_safe_auxiliary_queries_and_rejects_inventions():
    canonical, queries, diagnostic = parse({'canonical_question': '课程费用500元', 'queries': ['课程内容概览', '课程费用500元', 'https://invented.invalid报名']}, '课程内容有哪些？')
    assert canonical is None
    assert queries == ['课程内容概览']
    assert [item['reason'] for item in diagnostic['queryRejections']] == ['new_numbers', 'new_urls']


def test_types_limits_and_deduplication_are_bounded():
    canonical, queries, diagnostic = parse({'canonical_question': {'query': '坏对象'}, 'queries': ['AI学习方法', None, 'AI学习方法', '不会执行的第4条']}, '学习AI')
    assert canonical is None and queries == ['AI学习方法']
    assert diagnostic['canonicalRejectionReason'] == 'canonical_not_string'
    assert diagnostic['queryRejections'] == [{'index': 1, 'reason': 'query_not_string'}, {'reason': 'query_limit', 'discardedCount': 1}]
    assert parse({'canonical_question': '学习AI超出边界'}, '学习AI', max_chars=4)[2]['canonicalRejectionReason'] == 'canonical_too_long'


def test_known_url_is_preserved_and_new_url_is_rejected():
    question = 'https://example.org/intro 页面说明什么？'
    assert parse({'canonical_question': 'https://example.org/intro 页面主要内容是什么？'}, question)[0]
    assert parse({'canonical_question': 'https://example.net/intro 页面主要内容是什么？'}, question)[2]['canonicalRejectionReason'] == 'new_urls'
    assert parse({'canonical_question': '页面主要内容是什么？'}, question)[2]['canonicalRejectionReason'] == 'missing_urls'


@pytest.mark.parametrize('reported', ['true', 1, [], None])
def test_context_used_requires_an_actual_boolean(reported):
    assert parse({'context_used': reported}, '课程内容')[2]['contextUsedReported'] is None


def test_prompt_does_not_embed_company_or_benchmark_answers():
    assert '智慧驱动' not in QUERY_REWRITE_SYSTEM_PROMPT
    assert QUERY_REWRITE_PROMPT_VERSION
    assert '不是回答器' in QUERY_REWRITE_SYSTEM_PROMPT
