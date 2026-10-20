from __future__ import annotations

import asyncio

import pytest

from app.agent import AgentAnswer, AgentRunResult
from app.config import Settings
from app.models import Snapshot, SourceInfo, TestCandidate as Candidate, TestSessionCreate as Session
from app.pipeline import RagService, _extract_answer_text


SECTION_PATH = ["OPC港澳服务社区介绍及入驻流程", "常见问题", "什么是“七免两低”扶持政策？"]
SECTION_LINE = "章节: OPC港澳服务社区介绍及入驻流程 / 常见问题 / 什么是“七免两低”扶持政策？"
POLICY_ANSWER = (
    "“七免”指：免办公场地租赁费、免水电物业管理费、免网络使用费、免创业模拟实训课程、"
    "免业务场景资源对接、免一对一政策辅导、免资本对接加速服务。"
    "“两低”指：低成本AI算力扶持、低成本硬体产品试制服务。"
)


def test_extract_removes_repeated_internal_section_lines_without_changing_body():
    chunk = {
        "text": f"{SECTION_LINE}\n{POLICY_ANSWER}\n\n{SECTION_LINE}\n章节: 合同第三章\n请阅读这一章节的申请条件。",
        "section_path": SECTION_PATH,
        "metadata": {},
    }
    original_text = chunk["text"]

    assert _extract_answer_text(chunk) == f"{POLICY_ANSWER}\n\n章节: 合同第三章\n请阅读这一章节的申请条件。"
    assert chunk["text"] == original_text
    assert chunk["section_path"] == SECTION_PATH


@pytest.mark.parametrize("chunk,expected", [
    ({"text": "章节: 合同第三章\n提交申请。"}, "章节: 合同第三章\n提交申请。"),
    ({"text": "章节: 合同第三章\n提交申请。", "section_path": ["办事指南"]}, "章节: 合同第三章\n提交申请。"),
    ({"text": "用于检索的问题", "section_path": ["合同第三章"], "metadata": {"answer": "章节: 合同第三章\n提交申请。"}}, "章节: 合同第三章\n提交申请。"),
    ({"text": "问题: 怎样申请？\n答案: 提交申请。\n关键词: 申请"}, "提交申请。"),
], ids=["literal-section-without-metadata", "different-section", "explicit-faq-answer", "legacy-faq-label"])
def test_extract_preserves_source_text_and_explicit_faq_answers(chunk, expected):
    assert _extract_answer_text(chunk) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["fallback", "evaluation", "model-echo", "model-section-only"])
async def test_query_returns_body_with_source_sections_separate(tmp_path, monkeypatch, mode):
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
        markdown = "# OPC港澳服务社区介绍及入驻流程\n\n## 常见问题\n\n### 什么是“七免两低”扶持政策？\n\n" + POLICY_ANSWER
        upload = await service.accept_upload(
            content=markdown.encode("utf-8"), filename="policy.md", mime_type="text/markdown",
            metadata={"knowledgeBaseId": "main-business-kb"}, request_id="sections-upload",
        )
        for _ in range(100):
            if service.get_document(upload.documentId).status != "PROCESSING":
                break
            await asyncio.sleep(0.02)
        assert service.get_document(upload.documentId).status == "READY_FOR_TEST"
        session = service.create_test_session(Session(
            requestId="sections-session", candidateDocuments=[Candidate(documentId=upload.documentId, documentVersion=1)],
        ))
        stored_before = service.db.get_chunks_for_document(upload.documentId, 1)
        assert len(stored_before) == 1

        if mode.startswith("model-"):
            async def echo_evidence(**kwargs):
                evidence = kwargs["evidence"][0]
                return AgentRunResult(
                    output=AgentAnswer(
                        result="ANSWERED", answer=SECTION_LINE if mode == "model-section-only" else evidence["text"],
                        citation_ids=[evidence["chunk_id"]],
                    ),
                    provider="test", model="test", framework="test",
                )
            monkeypatch.setattr(service.agent, "run", echo_evidence)

        response = await service.run_query(
            question="什么是七免两低？",
            snapshot=Snapshot(conversationKey="sections", conversationVersion=1, inputFingerprint="sha256:sections"),
            source=SourceInfo(platform="DOUYIN", channelType="COMMENT"), knowledge_base_id="main-business-kb",
            trace_id="sections-query", request_id="sections-query", test_session_id=session.testSessionId,
            max_answer_chars=120, generate=mode != "evaluation",
        )
        if mode == "model-section-only":
            assert response.result == "NO_ANSWER"
            assert response.answer is None
            assert response.reasonCode == "INSUFFICIENT_EVIDENCE"
        else:
            assert response.result == "ANSWERED", response.reasonCode
            assert response.answer.text == POLICY_ANSWER
            assert response.grounding.sourceReferences[0].sectionPath == SECTION_PATH
            assert response.grounding.sourceReferences[0].excerpt == stored_before[0]["text"]
        stored_after = service.db.get_chunks_for_document(upload.documentId, 1)
        assert stored_after[0]["text"] == stored_before[0]["text"]
        assert stored_after[0]["content_hash"] == stored_before[0]["content_hash"]
    finally:
        await service.close()
