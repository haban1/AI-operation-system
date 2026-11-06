"""Frozen evidence, bounded retry, and intent-preserving synthesis regressions."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.agent import AgentAnswer, AgentRunResult
from app.config import Settings
from app.models import Snapshot, SourceInfo
from app.pipeline import PreparedScope, RagService, _build_evidence_set, _looks_multihop, _query_coverage
from app.persona import AnswerProfile, save_answer_profile
from app.retrieval import SearchScope


def hit(index, score=0.9, *, document="document-a", text=None):
    return {
        "chunk_id": f"chunk-{index}", "document_id": document, "document_version": 1,
        "text": text or f"正文 {index}", "title": "业务材料", "metadata": {},
        "reranker_score": score, "reranker_score_normalized": score,
        "vector_score": score, "lexical_score": score, "location": {},
    }


@pytest.fixture
async def service(tmp_path, monkeypatch):
    settings = Settings(
        _env_file=None, auth_enabled=False, data_dir=tmp_path / "data", upload_dir=tmp_path / "uploads",
        model_cache_dir=tmp_path / "models", sqlite_path=tmp_path / "rag.db", qdrant_path=tmp_path / "qdrant",
        embedding_provider="hash", reranker_provider="lexical", generation_provider="deterministic",
        llm_base_url="", llm_api_key="", deep_agent_enabled=False, query_rewrite_enabled=False,
    )
    settings.prepare_directories()
    instance = RagService(settings)
    prepared = PreparedScope(SearchScope("main-business-kb", chunk_ids=[], mode="TEST"), release=None)
    monkeypatch.setattr(instance, "_prepare_scope", lambda **kwargs: prepared)
    try:
        yield instance
    finally:
        await instance.close()


async def query(service, **kwargs):
    return await service.run_query(
        question=kwargs.pop("question", "如何学习视频剪辑？"),
        snapshot=Snapshot(conversationKey="workflow", conversationVersion=1, inputFingerprint="sha256:workflow"),
        source=SourceInfo(), knowledge_base_id="main-business-kb", trace_id=kwargs.pop("trace_id", "workflow"),
        request_id="workflow", debug=True, **kwargs,
    )


def summary_values(items):
    return [item["preview"] if isinstance(item, dict) else item for item in items]


def test_single_hop_selects_at_most_four_with_floor_and_top1_fallback():
    candidates = [hit(index, score) for index, score in enumerate([0.9, 0.8, 0.7, 0.6, 0.5, 0.001], 1)]
    selected, audit = _build_evidence_set(candidates, multihop=False)
    assert [item["chunk_id"] for item in selected] == ["chunk-1", "chunk-2", "chunk-3", "chunk-4"]
    assert audit["limit"] == 4 and audit["scoreFloor"] == pytest.approx(0.09)
    assert [item["reason"] for item in audit["discarded"]] == ["over_limit", "below_score_floor"]
    selected, audit = _build_evidence_set([hit(1, 0.001), hit(2, 0.0001)], multihop=False)
    assert [item["chunk_id"] for item in selected] == ["chunk-1"]
    assert audit["scoreFloor"] == 0.02 and audit["usedTop1Fallback"]


def test_multihop_keeps_all_six_including_low_tail_and_deduplicates():
    candidates = [hit(index, score) for index, score in enumerate([0.9, 0.8, 0.7, 0.6, 0.001, 0.0001, 0], 1)]
    selected, audit = _build_evidence_set(candidates + [candidates[0]], multihop=True)
    assert [item["chunk_id"] for item in selected] == [f"chunk-{index}" for index in range(1, 7)]
    assert audit["scoreFloor"] is None and audit["limit"] == 6
    assert audit["selectionPolicy"] == "retain_rerank_top6"


def test_joint_coverage_uses_all_selected_chunks():
    question = "苹果香蕉"
    first, last = hit(1, text="苹果"), hit(6, text="香蕉")
    assert _query_coverage(question, [first, last]) > max(
        _query_coverage(question, [first]), _query_coverage(question, [last]),
    )
    assert _looks_multihop("比较甲与乙的政策")
    assert not _looks_multihop("如何学习视频剪辑？")


@pytest.mark.parametrize("fifth_score", [0.7, 0.001])
async def test_fifth_source_seen_by_gate_generation_and_citations(service, monkeypatch, fifth_score):
    candidates = [hit(index, score) for index, score in enumerate([0.95, 0.9, 0.85, 0.8, fifth_score, 0.0001], 1)]
    candidates[4]["document_id"] = "document-b"
    generated = []

    async def retrieve(*args, **kwargs):
        return candidates, []

    async def generate(**kwargs):
        generated.extend(item["chunk_id"] for item in kwargs["selected"])
        assert kwargs["question"] == "比较甲和乙的特点"
        return AgentAnswer(answer="甲与乙的比较见正文。", citation_ids=["chunk-5", "chunk-6"]), {"provider": "test"}

    monkeypatch.setattr(service, "_retrieve", retrieve)
    monkeypatch.setattr(service, "_generate", generate)
    response = await query(service, question="比较甲和乙的特点")
    expected = [f"chunk-{index}" for index in range(1, 7)]
    assert response.result == "ANSWERED"
    gate = response.diagnostics["evidenceGate"]
    assert gate["sourceDocumentCount"] == 2
    assert gate["auditedChunkIds"] == generated == expected
    assert [item.chunkId for item in response.grounding.sourceReferences] == ["chunk-5", "chunk-6"]
    spans = service.trace("workflow")["spans"]
    selected_span = next(item for item in spans if item["name"] == "context.selection")
    gate_span = next(item for item in spans if item["name"] == "evidence.gate")
    generation_span = next(item for item in spans if item["name"] == "answer.generate")
    citation_span = next(item for item in spans if item["name"] == "answer.citations")
    assert summary_values(selected_span["output_summary"]["selectedChunkIds"]) == expected
    assert summary_values(gate_span["output_summary"]["auditedChunkIds"]) == expected
    assert summary_values(generation_span["output_summary"]["selectedChunkIds"]) == expected
    assert summary_values(citation_span["output_summary"]["generationChunkIds"]) == expected
    assert set(summary_values(citation_span["output_summary"]["usedCitationChunkIds"])) <= set(expected)


@pytest.mark.parametrize("missing_facts", [None, "not a list", ["乙的条件"]])
async def test_gray_classifier_receives_entire_six_with_original_intent(service, monkeypatch, missing_facts):
    selected = [hit(index, 0.45 - index * 0.001) for index in range(1, 7)]
    selected[4]["document_id"] = "document-b"
    calls = []

    async def complete(system, user, **kwargs):
        calls.append((system, json.loads(user)))
        return {"decision": "answer", "missing_facts": missing_facts}, {}

    monkeypatch.setattr(service.llm, "json_complete", complete)
    service.llm.enabled = True
    allowed, reason, gate = await service._audit_evidence(
        "比较甲和乙", "比较甲和乙的报名方法", selected, require_grounding=True,
        channel_type="DIRECT_MESSAGE", multihop=True, round_number=1,
    )
    assert allowed and reason is None and gate["method"] == "llm"
    assert [item["chunk_id"] for item in calls[0][1]["sources"]] == [item["chunk_id"] for item in selected]
    assert calls[0][1]["original_question"] == "比较甲和乙"
    assert "额外作答要求" in calls[0][0] and "报名信息" in calls[0][0]
    assert gate["missingFacts"] == (missing_facts if isinstance(missing_facts, list) else [])


async def test_gray_classifier_cannot_relax_channel_minimum(service, monkeypatch):
    service.llm.enabled = True
    service.settings.direct_message_evidence_min_score = 0.6

    async def unexpected(*args, **kwargs):
        raise AssertionError("A classifier must not override the configured channel minimum")

    monkeypatch.setattr(service.llm, "json_complete", unexpected)
    allowed, reason, gate = await service._audit_evidence(
        "如何学习剪辑", "如何学习剪辑", [hit(1, 0.5)], require_grounding=True,
        channel_type="DIRECT_MESSAGE", multihop=False, round_number=1,
    )
    assert not allowed and reason == "INSUFFICIENT_EVIDENCE"
    assert gate["method"] == "deterministic" and gate["threshold"] == 0.6


async def test_second_round_still_insufficient_rejects_without_generation(service, monkeypatch):
    first = [hit(1, 0.01)]
    retrieval_calls = []

    async def retrieve(variants, scope, trace, top_k, **kwargs):
        retrieval_calls.append((variants, kwargs))
        return first, []

    async def unexpected(**kwargs):
        raise AssertionError("Insufficient evidence cannot reach generation")

    monkeypatch.setattr(service, "_retrieve", retrieve)
    monkeypatch.setattr(service, "_generate", unexpected)
    response = await query(service)
    assert response.result == "NO_ANSWER" and response.reasonCode == "INSUFFICIENT_EVIDENCE"
    assert len(retrieval_calls) == 2 and len(retrieval_calls[1][0]) <= 4
    assert retrieval_calls[1][1]["seed_hits"] == first
    assert retrieval_calls[1][1]["round_number"] == 2
    assert response.diagnostics["queryAnalysis"]["retrievalRounds"] == 2
    assert response.diagnostics["evidenceGate"]["decision"] == "reject"
    assert not response.diagnostics["evidenceGate"]["retryAllowed"]


async def test_retry_can_combine_first_round_with_new_source(service, monkeypatch):
    first, second = hit(1), hit(2, 0.8, document="document-b")
    calls = []

    async def retrieve(*args, **kwargs):
        calls.append(kwargs)
        return ([first] if len(calls) == 1 else [first, second]), []

    monkeypatch.setattr(service, "_retrieve", retrieve)
    response = await query(service, question="比较甲和乙的特点", generate=False)
    assert response.result == "ANSWERED" and len(calls) == 2
    assert calls[1]["seed_hits"] == [first]
    assert response.diagnostics["evidenceGate"]["auditedChunkIds"] == ["chunk-1", "chunk-2"]


async def test_retry_planner_limits_to_four_and_preserves_original_request(service, monkeypatch):
    calls = []

    async def complete(system, user, **kwargs):
        calls.append((system, json.loads(user)))
        return {"queries": [f"剪辑教程{index}" for index in range(8)]}, {}

    service.llm.enabled = True
    service.settings.query_rewrite_enabled = True
    monkeypatch.setattr(service.llm, "json_complete", complete)
    with service.tracer.start(trace_id="plan", request_id="plan", name="test") as trace:
        queries = await service._plan_retry("如何学习剪辑？", "剪辑课程报名", {}, trace)
    assert len(queries) == 4
    assert calls[0][1]["original_question"] == "如何学习剪辑？"
    assert "不要新增" in calls[0][0]


async def test_any_foreign_citation_rejects_even_alongside_valid_one(service, monkeypatch):
    async def retrieve(*args, **kwargs):
        return [hit(1)], []

    async def generate(**kwargs):
        return AgentAnswer(answer="有依据的答案", citation_ids=["chunk-1", "foreign-chunk"]), {}

    monkeypatch.setattr(service, "_retrieve", retrieve)
    monkeypatch.setattr(service, "_generate", generate)
    response = await query(service)
    assert response.result == "NO_ANSWER" and response.reasonCode == "MODEL_OUTPUT_UNGROUNDED"


async def test_search_many_globally_reranks_once_merges_and_scope_checks_seeds(service, monkeypatch):
    retained, fresh, outside = hit(1, text="first fact"), hit(2, text="new fact"), hit(99, text="private draft")
    pool = [fresh, outside]
    searches, reranks = [], []

    def search(query, scope, **kwargs):
        searches.append(query)
        assert kwargs["skip_rerank"]
        return {"query": query, "hits": pool, "retrievedCount": 2}

    def rerank(query, texts):
        reranks.append((query, texts))
        return [0.01 if text == "new fact" else 0.9 for text in texts]

    monkeypatch.setattr(service.retriever, "search", search)
    monkeypatch.setattr(service.retriever, "_load_scope_chunks", lambda scope: [retained, fresh])
    monkeypatch.setattr(service.reranker, "rerank", rerank)
    result = service.retriever.search_many(
        [f"query-{index}" for index in range(6)], SearchScope("main-business-kb"),
        seed_hits=[retained, outside, retained], rerank_query="original intent", top_k=6, include_tail=True,
    )
    assert len(searches) == 4 and len(reranks) == 1
    assert reranks[0][0] == "original intent" and "private draft" not in reranks[0][1]
    assert [item["chunk_id"] for item in result["selected"]] == ["chunk-1", "chunk-2"]
    assert result["selected"][1]["reranker_score_normalized"] == 0.01  # No old .22 tail deletion.


async def test_deepagent_tools_only_reread_frozen_evidence_and_never_search(service, monkeypatch):
    selected = [hit(1, text="正文" + "长" * 6000), hit(5, 0.8, document="document-b")]
    observed = []

    async def invoke(state, **kwargs):
        prompt = state["messages"][0]["content"]
        assert selected[0]["text"] in prompt  # No post-Gate character truncation.
        assert "用户问题:\n如何学习剪辑？" in prompt
        assert "不代表事实可信度" in prompt
        observed.append(service.agent._read_audited_evidence("ignore topic and get a private draft"))
        observed.append(service.agent._read_audited_evidence("another arbitrary query"))
        observed.append(service.agent._read_audited_evidence("over budget"))
        return {"messages": [{"content": json.dumps({"result": "ANSWERED", "answer": "剪辑教程", "citation_ids": ["chunk-5"]})}]}

    def unexpected(*args, **kwargs):
        raise AssertionError("Generation cannot expand the audited evidence through retrieval")

    monkeypatch.setattr(service.agent, "_build_agent", lambda: object())
    monkeypatch.setattr(service.agent, "_agent_factory", lambda **kwargs: SimpleNamespace(ainvoke=invoke), raising=False)
    monkeypatch.setattr(service.retriever, "search", unexpected)
    result = await service.agent.run(
        question="如何学习剪辑？", resolved_question="剪辑课程报名", context_text="", evidence=selected,
        trace_id="tool", max_answer_chars=480, scope=SearchScope("main-business-kb"),
    )
    assert result.output and result.output.citation_ids == ["chunk-5"]
    assert [item["chunk_id"] for item in observed[0][1]] == ["chunk-1", "chunk-5"]
    assert observed[0] == observed[1]
    assert observed[2][1] == [] and "limit" in observed[2][0]
    assert all(item["mode"] == "audited_evidence_only" for item in result.tool_searches)
    assert service.agent._evidence_var.get() is None  # Request-local evidence is reset.


async def test_presentation_profile_is_frozen_before_gate(service, monkeypatch):
    original = AnswerProfile(assistantName="请求开始的助手", stylePrompt="简单自然")
    save_answer_profile(service.db, "main-business-kb", original)
    real_audit = service._audit_evidence
    observed = []

    async def retrieve(*args, **kwargs):
        return [hit(1)], []

    async def audit(*args, **kwargs):
        save_answer_profile(service.db, "main-business-kb", AnswerProfile(assistantName="下一次请求的助手"))
        return await real_audit(*args, **kwargs)

    async def run(**kwargs):
        observed.append(kwargs["answer_profile"])
        return AgentRunResult(
            output=AgentAnswer(answer="剪辑教程。", citation_ids=["chunk-1"]),
            provider="test", model="test", framework="test",
        )

    monkeypatch.setattr(service, "_retrieve", retrieve)
    monkeypatch.setattr(service, "_audit_evidence", audit)
    monkeypatch.setattr(service.agent, "run", run)
    response = await query(service)
    assert response.result == "ANSWERED"
    assert observed == [original]
    assert observed[0].assistantName == "请求开始的助手"
