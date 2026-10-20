"""Channel gates and single-turn comments, using local deterministic retrieval."""
import asyncio
import pytest
from pydantic import ValidationError
from app.config import Settings
from app.models import Snapshot, SourceInfo, QueryMessage, DebugQueryRequest, TestCandidate as Candidate, TestSessionCreate as Session
from app.pipeline import RagService


def settings_for(tmp_path, **overrides):
    return Settings(_env_file=None, auth_enabled=False, data_dir=tmp_path / "data",
        upload_dir=tmp_path / "uploads", model_cache_dir=tmp_path / "models",
        sqlite_path=tmp_path / "rag.db", qdrant_path=tmp_path / "qdrant",
        embedding_provider="hash", reranker_provider="lexical", generation_provider="deterministic",
        llm_base_url="", llm_api_key="", deep_agent_enabled=False, query_rewrite_enabled=False, **overrides)


@pytest.mark.parametrize("field", ["comment_evidence_min_score", "direct_message_evidence_min_score"])
@pytest.mark.parametrize("value", [-0.1, 1.1, float("nan")])
def test_channel_threshold_rejects_invalid_values(tmp_path, field, value):
    with pytest.raises(ValidationError):
        settings_for(tmp_path, **{field: value})


def test_defaults_inherit_legacy_threshold_and_zero_is_valid(tmp_path):
    service = object.__new__(RagService)
    service.settings = settings_for(tmp_path, evidence_min_score=0.51, comment_evidence_min_score=0)
    hit = {"reranker_score_normalized": 0.4}
    allowed, _, gate = service._evidence_gate("怎么加入", [hit], require_grounding=True, channel_type="COMMENT")
    assert allowed and gate["threshold"] == 0
    allowed, reason, gate = service._evidence_gate("怎么加入", [hit], require_grounding=True, channel_type="DIRECT_MESSAGE")
    assert not allowed and reason == "INSUFFICIENT_EVIDENCE" and gate["threshold"] == 0.51


@pytest.mark.parametrize("channel", ["COMMENT", "DIRECT_MESSAGE"])
def test_relaxed_gate_still_rejects_missing_or_conflicting_evidence(tmp_path, channel):
    service = object.__new__(RagService)
    service.settings = settings_for(tmp_path, comment_evidence_min_score=0, direct_message_evidence_min_score=0)
    allowed, reason, _ = service._evidence_gate("怎么加入", [], require_grounding=True, channel_type=channel)
    assert not allowed and reason == "NO_RELEVANT_KNOWLEDGE"
    hits = [{"reranker_score_normalized": 0.7, "metadata": {"question": "怎么加入？", "answer": answer}}
            for answer in ["甲基地需提交项目介绍。", "乙活动需在现场报名。"]]
    allowed, reason, _ = service._evidence_gate("怎么加入", hits, require_grounding=True, channel_type=channel)
    assert not allowed and reason == "KNOWLEDGE_CONFLICT"


@pytest.mark.asyncio
async def test_query_uses_channel_gate_and_comment_ignores_history(tmp_path, monkeypatch):
    settings = settings_for(tmp_path, comment_evidence_min_score=0.3, direct_message_evidence_min_score=0.6)
    settings.prepare_directories()
    service = RagService(settings)
    try:
        markdown = "# OPC 港澳服务社区\n\n## 常见问题\n\n### 怎么加入 OPC 港澳服务社区？（常见问法：怎么加入？）\n\n加入 OPC 港澳服务社区需先提交项目介绍，审核通过后签约。\n"
        upload = await service.accept_upload(content=markdown.encode(), filename="video-knowledge.md", mime_type="text/markdown",
            metadata={"knowledgeBaseId": "main-business-kb"}, request_id="upload")
        for _ in range(100):
            if service.get_document(upload.documentId).status != "PROCESSING":
                break
            await asyncio.sleep(0.02)
        assert service.get_document(upload.documentId).status == "READY_FOR_TEST"
        session = service.create_test_session(Session(requestId="session", candidateDocuments=[Candidate(documentId=upload.documentId, documentVersion=1)]))
        real_retrieve = service._retrieve
        seen_contexts = []
        real_analyze = service._rewrite
        async def analyze(question, context, trace):
            seen_contexts.append(context)
            return await real_analyze(question, context, trace)
        async def scored_retrieve(*args, **kwargs):
            selected, runs = await real_retrieve(*args, **kwargs)
            assert selected, "短问法必须能从真实 Markdown 索引召回知识"
            for hit in selected:
                hit["reranker_score_normalized"] = 0.34
            return selected, runs
        monkeypatch.setattr(service, "_retrieve", scored_retrieve)
        monkeypatch.setattr(service, "_rewrite", analyze)
        for channel, expected in [("COMMENT", "ANSWERED"), ("DIRECT_MESSAGE", "NO_ANSWER")]:
            response = await service.run_query(question="怎么加入", snapshot=Snapshot(conversationKey=channel, conversationVersion=1, inputFingerprint=channel),
                source=SourceInfo(platform="DOUYIN", channelType=channel), knowledge_base_id="main-business-kb",
                trace_id=channel, request_id=channel, test_session_id=session.testSessionId, generate=False,
                context=[QueryMessage(role="USER", text="我还想了解申请条件")], debug=True)
            assert response.result == expected
            gate = response.diagnostics["evidenceGate"]
            assert gate["channelType"] == channel
            assert gate["threshold"] == (0.3 if channel == "COMMENT" else 0.6)
            if channel == "COMMENT":
                assert "提交项目介绍" in response.answer.text
                assert seen_contexts[-1] == []
            else:
                assert seen_contexts[-1]
                assert response.reasonCode == "INSUFFICIENT_EVIDENCE"
        # The retrieval-only diagnostic must apply exactly the same channel policy.
        real_search = service.retriever.search_many
        def scored_search(*args, **kwargs):
            result = real_search(*args, **kwargs)
            for hit in result["selected"]:
                hit["reranker_score_normalized"] = 0.34
            return result
        monkeypatch.setattr(service.retriever, "search_many", scored_search)
        for channel, expected in [("COMMENT", True), ("DIRECT_MESSAGE", False)]:
            result = await service.debug_retrieve(DebugQueryRequest(question="怎么加入", channelType=channel,
                testSessionId=session.testSessionId, context=[QueryMessage(role="USER", text="我还想了解申请条件")]))
            assert result["evidenceGate"]["allowed"] is expected
            assert result["evidenceGate"]["channelType"] == channel
            assert bool(seen_contexts[-1]) is (channel == "DIRECT_MESSAGE")
    finally:
        await service.close()


@pytest.mark.parametrize("channel", ["COMMENT", "DIRECT_MESSAGE"])
def test_unset_overrides_keep_existing_shared_gate(tmp_path, channel):
    service = object.__new__(RagService)
    service.settings = settings_for(tmp_path, evidence_min_score=0.51)
    for score, expected in [(0.5, False), (0.51, True)]:
        allowed, _, gate = service._evidence_gate("加入基地", [{"reranker_score_normalized": score}], require_grounding=True, channel_type=channel)
        assert allowed is expected
        assert gate["threshold"] == 0.51
