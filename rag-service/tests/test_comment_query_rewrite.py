"""Colloquial comments and DMs use the validated main-branch query plan."""
import asyncio
import json

import pytest

from app.config import Settings
from app.models import Snapshot, SourceInfo, TestCandidate as Candidate, TestSessionCreate as Session
from app.pipeline import RagService


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["comment", "hit", "private", "disabled", "timeout", "malformed", "no_rewrite", "missing_price"])
async def test_comment_semantic_retry_keeps_original_guards(tmp_path, monkeypatch, case):
    settings = Settings(_env_file=None, auth_enabled=False, data_dir=tmp_path / "data",
        upload_dir=tmp_path / "uploads", model_cache_dir=tmp_path / "models",
        sqlite_path=tmp_path / "rag.db", qdrant_path=tmp_path / "qdrant",
        embedding_provider="hash", reranker_provider="lexical", generation_provider="deterministic",
        llm_base_url="", llm_api_key="", query_rewrite_enabled=case != "disabled", deep_agent_enabled=False,
        comment_query_rewrite_on_miss_enabled=case != "disabled",
        llm_timeout_seconds=0.01 if case == "timeout" else 45)
    settings.prepare_directories()
    service = RagService(settings)
    try:
        upload = await service.accept_upload(
            content="标准问题,标准答案\n公司培训课程有哪些？,培训包括工作流拆解和应用开发。\n".encode(),
            filename="training.csv", mime_type="text/csv", metadata={"knowledgeBaseId": "main-business-kb"}, request_id="upload")
        for _ in range(100):
            if service.get_document(upload.documentId).status != "PROCESSING":
                break
            await asyncio.sleep(0.02)
        assert service.get_document(upload.documentId).status == "READY_FOR_TEST"
        session = service.create_test_session(Session(requestId="session", candidateDocuments=[Candidate(documentId=upload.documentId, documentVersion=1)]))
        canonical = "公司培训课程有哪些？"
        original = "这次培训准确收费多少钱？" if case == "missing_price" else "我可以去你们公司学习到什么"
        question = original
        calls, retrievals, cancelled = [], [], []
        real_retrieve = service._retrieve

        async def retrieve(variants, *args, **kwargs):
            retrievals.append(variants)
            return await real_retrieve(variants, *args, **kwargs)

        async def rewrite(system, user, **kwargs):
            calls.append(json.loads(user))
            if case == "timeout":
                raise TimeoutError("mock provider timeout")
            if case == "malformed":
                return {"query": None}, {}
            return {"canonical_question": canonical, "queries": [canonical]}, {}

        monkeypatch.setattr(service, "_retrieve", retrieve)
        monkeypatch.setattr(service.llm, "enabled", case not in {"disabled", "no_rewrite"})
        monkeypatch.setattr(service.llm, "json_complete", rewrite)
        response = await service.run_query(question=question,
            snapshot=Snapshot(conversationKey=case, conversationVersion=1, inputFingerprint=case),
            source=SourceInfo(channelType="DIRECT_MESSAGE" if case == "private" else "COMMENT"),
            knowledge_base_id="main-business-kb", trace_id=case, request_id=case,
            test_session_id=session.testSessionId, generate=False, debug=True, use_rewrite=case != "no_rewrite")
        if case in {"comment", "hit", "private"}:
            assert response.result == "ANSWERED", response.model_dump_json()
            assert "工作流拆解" in response.answer.text
            assert response.grounding.sourceReferences[0].documentId == upload.documentId
            analysis = response.diagnostics["queryAnalysis"]
            assert analysis["canonicalQuestion"] == canonical
            assert analysis["rerankQueriesByRound"][0]["query"] == canonical
            assert calls[0]["question"] == original
            assert retrievals[0][0] == canonical
            assert response.diagnostics["evidenceGate"]["threshold"] == settings.evidence_min_score
        else:
            assert response.result == "NO_ANSWER"
            if case == "missing_price":
                assert response.diagnostics["evidenceGate"]["detailGap"] == "exact_amount"
            elif case in {"disabled", "no_rewrite"}:
                assert not calls and len(retrievals) <= 2
            else:
                assert len(calls) <= 2 and len(retrievals) <= 2
    finally:
        await service.close()
