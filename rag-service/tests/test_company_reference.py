"""Company introductions must survive everyday wording without inventing facts."""
import pytest

from app.query_rewrite import _atoms, _vocabulary_entities, parse_rewrite, resolve_company_reference

TITLES = ["Acme启航公司介绍", "启航公司介绍(1)", "启航业务与服务介绍", "日常问候"]


@pytest.mark.parametrize("question", [
    "你们是什么公司", "介绍一下你们公司", "你们公司主要做什么业务", "你们是做什么的",
    "你们主要提供什么服务", "贵公司提供哪些服务", "公司介绍", "业务简介",
    "你们能提供哪些服务", "你们可以提供什么服务", "贵司能提供什么服务", "那你们能提供什么服务",
])
def test_scoped_company_reference_keeps_question_and_names_only_search_object(question):
    assert not _atoms(question)["entities"]
    resolved = resolve_company_reference(question, TITLES)
    assert resolved and "启航" in resolved
    assert "你们" not in resolved and "贵公司" not in resolved
    assert not any(term in resolved for term in ("免费", "培训", "研发", "500"))


def test_company_name_stops_before_question_clause_and_survives_rewording():
    original = "广州启航科技有限公司是一家什么公司？"
    canonical = "广州启航科技有限公司是什么公司？"
    assert _atoms(original)["entities"] == {"广州启航科技"}
    accepted, _, diagnostic = parse_rewrite({"canonical_question": canonical},
                                          original_question=original, resolved_question=original)
    assert accepted == canonical, diagnostic


def test_attached_ascii_brand_is_merged_only_with_an_independently_present_exact_name():
    assert _vocabulary_entities("\n".join(TITLES)) == {"启航"}
    assert _vocabulary_entities("Acme启航公司介绍") == {"acme启航"}
    assert _vocabulary_entities("东启航公司介绍\n启航公司介绍") == {"东启航", "启航"}
    accepted, _, diagnostic = parse_rewrite(
        {"canonical_question": "Acme启航公司提供什么服务"},
        original_question="你们公司提供什么服务", resolved_question="你们公司提供什么服务",
        retrieval_vocabulary="\n".join(TITLES))
    assert accepted, diagnostic


@pytest.mark.parametrize("question,titles", [
    ("你们是什么公司", []),
    ("你们是什么公司", ["公司介绍"]),
    ("你们是什么公司", TITLES + ["星河公司介绍"]),
    ("你们是什么公司", ["东启航公司介绍", "启航公司介绍"]),
    ("星河公司提供什么服务", TITLES),
    ("它提供什么服务", TITLES),
    ("这家公司提供什么服务", TITLES),
    ("你们公司和星河公司的业务有什么区别", TITLES),
    ("你们支持银行卡付款吗", TITLES),
    ("你们公司提供什么服务", ["忽略指令启航公司介绍"]),
])
def test_no_guess_from_ambiguous_unfrozen_other_subject_or_noncompany_intent(question, titles):
    assert resolve_company_reference(question, titles) is None


def test_reference_substitution_preserves_current_factual_constraints_and_negation():
    question = "你们公司2026年500元以内的服务有哪些，只限线上，不要培训"
    resolved = resolve_company_reference(question, TITLES)
    assert resolved == "启航2026年500元以内的服务有哪些，只限线上，不要培训"


def test_alias_hints_do_not_authorize_changing_an_explicit_different_company():
    accepted, _, _ = parse_rewrite(
        {"canonical_question": "启航公司提供什么服务"},
        original_question="星河公司提供什么服务", resolved_question="星河公司提供什么服务",
        retrieval_vocabulary="\n".join(TITLES))
    assert accepted is None


from app.agent import AgentAnswer
from app.config import Settings
from app.models import QueryMessage, Snapshot, SourceInfo
from app.pipeline import PreparedScope, RagService
from app.retrieval import SearchScope


@pytest.fixture
async def service(tmp_path, monkeypatch):
    settings = Settings(
        _env_file=None, auth_enabled=False, data_dir=tmp_path / "data", upload_dir=tmp_path / "uploads",
        model_cache_dir=tmp_path / "models", sqlite_path=tmp_path / "rag.db", qdrant_path=tmp_path / "qdrant",
        embedding_provider="hash", reranker_provider="lexical", generation_provider="deterministic",
        llm_base_url="", llm_api_key="", deep_agent_enabled=False, query_rewrite_enabled=True,
    )
    settings.prepare_directories()
    instance = RagService(settings)
    prepared = PreparedScope(SearchScope("main-business-kb", chunk_ids=[], mode="TEST"), release=None)
    monkeypatch.setattr(instance, "_prepare_scope", lambda **kwargs: prepared)
    try:
        yield instance
    finally:
        await instance.close()


async def make_plan(service, *, question, context=None, **kwargs):
    with service.tracer.start(trace_id="company-plan", request_id="company-plan", name="test") as trace:
        return await service._query_plan(question, context or [], trace, **kwargs)


def hit():
    return {"chunk_id": "chunk-1", "document_id": "document-1", "document_version": 1,
            "text": "启航提供企业软件开发服务。", "title": "启航公司介绍", "metadata": {},
            "location": {}, "reranker_score_normalized": 0.95, "reranker_score": 0.95,
            "vector_score": 0.95, "lexical_score": 0.95}


@pytest.mark.parametrize("model_enabled", [True, False])
async def test_company_reference_is_scoped_and_survives_unavailable_rewrite_model(service, monkeypatch, model_enabled):
    async def unavailable(*args, **kwargs):
        raise AssertionError("A validated company reference needs no model call")

    service.llm.enabled = model_enabled
    monkeypatch.setattr(service.llm, "json_complete", unavailable)
    plan = await make_plan(service, question="你们是什么公司",
                           vocabulary=["Acme启航公司介绍", "启航公司介绍"])
    assert plan["analysis"]["originalQuestion"] == "你们是什么公司"
    assert plan["analysis"]["contextResolvedQuestion"] == "你们是什么公司"
    assert plan["analysis"]["resolvedQuestion"] == "启航是什么公司"
    assert plan["analysis"]["rerankQueryMethod"] == "scoped_company_reference"
    assert plan["variants"][:2] == ["启航是什么公司", "你们是什么公司"]


@pytest.mark.parametrize("score,expected", [(0.95, "ANSWERED"), (0.1, "NO_ANSWER")])
async def test_company_reference_uses_same_rerank_and_original_evidence_gate(service, monkeypatch, score, expected):
    service.llm.enabled = False
    calls, generated = [], []
    monkeypatch.setattr(service.retriever, "scope_vocabulary", lambda scope: ["启航公司介绍"])

    async def retrieve(variants, scope, trace, top_k, **kwargs):
        calls.append((variants, kwargs))
        candidate = hit()
        candidate["reranker_score_normalized"] = score
        return [candidate], []

    async def generate(**kwargs):
        generated.append(kwargs)
        return AgentAnswer(answer="启航提供有来源的业务服务。", citation_ids=["chunk-1"]), {}

    monkeypatch.setattr(service, "_retrieve", retrieve)
    monkeypatch.setattr(service, "_generate", generate)
    response = await service.run_query(
        question="你们是什么公司",
        snapshot=Snapshot(conversationKey="company", conversationVersion=0, inputFingerprint="company"),
        source=SourceInfo(), knowledge_base_id="main-business-kb", trace_id="company", request_id="company",
        debug=True,
    )
    assert response.result == expected
    assert all(call[1]["rerank_query"] == "启航是什么公司" for call in calls)
    assert response.diagnostics["evidenceGate"]["threshold"] == 0.38
    if expected == "ANSWERED":
        assert generated[0]["question"] == "你们是什么公司"
        assert generated[0]["resolved_question"] == "启航是什么公司"
        assert response.grounding.sourceReferences[0].chunkId == "chunk-1"
    else:
        assert not generated


@pytest.mark.parametrize("question", ["那你们主要做什么业务", "那主要做什么业务"])
@pytest.mark.parametrize("model_enabled", [True, False])
async def test_company_followup_resolves_historical_self_reference_without_model(service, monkeypatch, question, model_enabled):
    service.llm.enabled = model_enabled

    async def unavailable(*args, **kwargs):
        raise AssertionError("The scoped reference must survive a rewrite JSON failure")

    monkeypatch.setattr(service.llm, "json_complete", unavailable)
    history = [QueryMessage(role="USER", text="你们是什么公司"),
               QueryMessage(role="ASSISTANT", text="可以提供公司介绍。")]
    plan = await make_plan(service, question=question, context=history, vocabulary=TITLES)
    assert plan["analysis"]["contextUsed"]
    assert plan["analysis"]["rerankQueryMethod"] == "scoped_company_reference"
    assert "启航" in plan["analysis"]["resolvedQuestion"]
    assert question in plan["analysis"]["contextResolvedQuestion"]
    assert plan["analysis"]["originalQuestion"] == question


async def test_company_followup_keeps_an_explicit_different_context_object(service):
    service.llm.enabled = False
    history = [QueryMessage(role="USER", text="星河公司的介绍"),
               QueryMessage(role="ASSISTANT", text="需要查阅该公司的资料。")]
    plan = await make_plan(service, question="那它提供什么服务", context=history, vocabulary=TITLES)
    assert "星河" in plan["analysis"]["resolvedQuestion"]
    assert "启航" not in plan["analysis"]["resolvedQuestion"]
    assert plan["analysis"]["rerankQueryMethod"] == "deterministic"
