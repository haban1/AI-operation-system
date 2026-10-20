from __future__ import annotations

import asyncio
import csv
import io
import unicodedata

import pytest

from app.agent import AgentAnswer, AgentRunResult
from app.config import Settings
from app.models import Snapshot, SourceInfo, TestCandidate as Candidate, TestSessionCreate as Session
from app.pipeline import RagService


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["model", "fallback", "evaluation"])
@pytest.mark.parametrize("answer,budget,platform,channel_type,expected_result", [
    ("答" * 119 + "。", 120, "DOUYIN", "COMMENT", "ANSWERED"),
    ("答" * 120 + "。", 120, "DOUYIN", "COMMENT", "NO_ANSWER"),
    ("答" * 208 + "。", 480, "DOUYIN", "COMMENT", "ANSWERED"),
    ("答" * 479 + "。", 480, "DOUYIN", "COMMENT", "ANSWERED"),
    ("答" * 480 + "。", 480, "DOUYIN", "COMMENT", "NO_ANSWER"),
    ("😀" * 239 + "。", 480, "DOUYIN", "COMMENT", "ANSWERED"),
    ("😀" * 240 + "。", 480, "DOUYIN", "COMMENT", "NO_ANSWER"),
    ("e\u0301" * 479 + "。", 480, "DOUYIN", "COMMENT", "ANSWERED"),
    ("😀" * 240 + "。", 480, "DOUYIN", "DIRECT_MESSAGE", "NO_ANSWER"),
    ("😀" * 240 + "。", 480, "BILIBILI", "DIRECT_MESSAGE", "NO_ANSWER"),
    ("😀" * 240 + "。", 480, "BILIBILI", "COMMENT", "NO_ANSWER"),
    ("😀" * 140 + "。", 280, "WEIBO", "DIRECT_MESSAGE", "ANSWERED"),
    ("😀" * 89 + "。", 180, "WECHAT_CHANNELS", "COMMENT", "ANSWERED"),
], ids=["120-budget", "over-120-budget", "209-regression", "480-boundary", "481-overflow",
        "emoji-within", "emoji-overflow", "nfc-boundary", "private-emoji", "bilibili-private-emoji",
        "bilibili-comment-provisional-count", "weibo-private-provisional-count", "channels-comment-provisional-count"])
async def test_query_rejects_overlong_answers_instead_of_slicing(tmp_path, monkeypatch, mode, answer, budget, platform, channel_type, expected_result):
    settings = Settings(
        auth_enabled=False, data_dir=tmp_path / "data", upload_dir=tmp_path / "uploads",
        model_cache_dir=tmp_path / "models", sqlite_path=tmp_path / "rag.db",
        qdrant_path=tmp_path / "qdrant", embedding_provider="hash", reranker_provider="lexical",
        generation_provider="deterministic", llm_base_url="", llm_api_key="",
        deep_agent_enabled=False, query_rewrite_enabled=False,
    )
    settings.prepare_directories()
    service = RagService(settings)
    try:
        question = "示例账号如何注册？"
        csv_file = io.StringIO()
        writer = csv.writer(csv_file)
        writer.writerow(["标准问题", "标准答案", "关键词", "大类", "小类"])
        writer.writerow([question, answer, "账号,注册", "公共", "账户"])
        upload = await service.accept_upload(
            content=csv_file.getvalue().encode("utf-8"), filename="reply-length.csv", mime_type="text/csv",
            metadata={"knowledgeBaseId": "main-business-kb"}, request_id="length-upload",
        )
        for _ in range(100):
            if service.get_document(upload.documentId).status != "PROCESSING":
                break
            await asyncio.sleep(0.02)
        assert service.get_document(upload.documentId).status == "READY_FOR_TEST"
        session = service.create_test_session(Session(
            requestId="length-session", candidateDocuments=[Candidate(documentId=upload.documentId, documentVersion=1)],
        ))
        if mode == "model":
            async def over_budget_model(**kwargs):
                return AgentRunResult(
                    output=AgentAnswer(result="ANSWERED", answer=answer, citation_ids=[kwargs["evidence"][0]["chunk_id"]]),
                    provider="test", model="test", framework="test",
                )
            monkeypatch.setattr(service.agent, "run", over_budget_model)
        response = await service.run_query(
            question=question, snapshot=Snapshot(conversationKey="length", conversationVersion=1, inputFingerprint="sha256:length"),
            source=SourceInfo(platform=platform, channelType=channel_type), knowledge_base_id="main-business-kb",
            trace_id="length-query", request_id="length-query", test_session_id=session.testSessionId,
            max_answer_chars=budget, generate=mode != "evaluation",
        )
        normalized_answer = unicodedata.normalize("NFC", answer)
        if expected_result == "NO_ANSWER":
            assert response.result == "NO_ANSWER", "超长回答不能截断为貌似完整的 ANSWERED"
            assert response.answer is None
            assert response.reasonCode == "ANSWER_TOO_LONG"
        else:
            assert response.result == "ANSWERED"
            assert response.answer.text == normalized_answer
            assert response.grounding.sourceReferences
    finally:
        await service.close()
