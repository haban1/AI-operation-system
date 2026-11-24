from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pytest

from app.config import Settings
from app.models import Snapshot, SourceInfo
from app.models import now_iso
from app.pipeline import RagService
from app.tracing import safe_summary
from kb_helpers import active_members, publish_file


def settings_for(tmp_path: Path) -> Settings:
    return Settings(
        auth_enabled=False,
        data_dir=tmp_path / "data",
        upload_dir=tmp_path / "data" / "uploads",
        model_cache_dir=tmp_path / "models",
        sqlite_path=tmp_path / "data" / "rag.db",
        qdrant_path=tmp_path / "data" / "qdrant",
        embedding_provider="hash",
        reranker_provider="lexical",
        generation_provider="deterministic",
        deep_agent_enabled=False,
        query_rewrite_enabled=False,
    )


def csv_bytes(question: str = "如何注册？", answer: str = "请携带证件到窗口办理。") -> bytes:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["标准问题", "标准答案", "关键词", "大类", "小类"])
    writer.writerow([question, answer, "证件,窗口", "sample-kb", "测试"])
    return output.getvalue().encode()


def ask(service: RagService, question: str, knowledge_base_id: str, key: str):
    return service.run_query(
        question=question, knowledge_base_id=knowledge_base_id, source=SourceInfo(),
        snapshot=Snapshot(conversationKey=key, conversationVersion=1, inputFingerprint="sha256:" + key),
        trace_id="trace-" + key, request_id="query-" + key, generate=False,
    )


def test_trace_redacts_short_secrets():
    summary = safe_summary("sk-abcdefghijklmnop bearer very-secret-value")
    assert "abcdefghijklmnop" not in str(summary)
    assert "very-secret-value" not in str(summary)


@pytest.mark.asyncio
async def test_active_file_snapshots_are_isolated_per_knowledge_base(tmp_path: Path):
    settings = settings_for(tmp_path)
    settings.prepare_directories()
    service = RagService(settings)
    try:
        a = await publish_file(service, csv_bytes("A知识如何办理？", "A业务请到一号窗口。"), "a.csv", "text/csv",
                               metadata={"title": "A"}, request_id="upload-a", knowledge_base_id="kb-a")
        b = await publish_file(service, csv_bytes("B知识如何办理？", "B业务请到二号窗口。"), "b.csv", "text/csv",
                               metadata={"title": "B"}, request_id="upload-b", knowledge_base_id="kb-b")
        assert {m["document_id"] for m in active_members(service, "kb-a")} == {a.documentId}
        assert {m["document_id"] for m in active_members(service, "kb-b")} == {b.documentId}
        own = await ask(service, "A知识如何办理？", "kb-a", "own")
        assert own.result == "ANSWERED"
        assert {ref.documentId for ref in own.grounding.sourceReferences} == {a.documentId}
        other = await ask(service, "B知识如何办理？", "kb-a", "other")
        # kb-b content is never visible from kb-a, even for a question that only kb-b answers.
        assert "二号窗口" not in (other.answer.text if other.answer else "")
        assert {ref.documentId for ref in (other.grounding.sourceReferences if other.grounding else [])} <= {a.documentId}
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_legacy_disabled_review_records_no_longer_gate_formal_answers(tmp_path: Path):
    """2026-11-10: old 小智 review data stays in the database but never controls formal replies."""
    settings = settings_for(tmp_path)
    settings.prepare_directories()
    service = RagService(settings)
    try:
        upload = await publish_file(service, csv_bytes("测试问题如何办理？"), "negative.csv", "text/csv",
                                    metadata={"title": "Negative"}, request_id="upload-negative")
        chunk_ids = [m["chunk_id"] for m in active_members(service)]
        stamp = now_iso()
        with service.db.transaction() as conn:
            conn.execute("INSERT INTO test_sessions(test_session_id,knowledge_base_id,mode,status,operator_id,created_at,updated_at)"
                         " VALUES('legacy','main-business-kb','PRE_RELEASE','ACTIVE','legacy',?,?)", (stamp, stamp))
            conn.execute("INSERT INTO test_answers(answer_id,test_session_id,request_id,trace_id,question,result,source_references_json,"
                         "decision,decision_reason_code,created_at,updated_at) VALUES('legacy-answer','legacy','r','t','测试问题如何办理？','ANSWERED',?,"
                         "'DISABLED','ANSWER_INACCURATE',?,?)",
                         (json.dumps([{"documentId": upload.documentId, "chunkId": chunk_ids[0]}]), stamp, stamp))
            conn.execute("INSERT INTO negative_cases(negative_case_id,answer_id,knowledge_base_id,question,blocked_chunk_ids_json,reason_code,active,created_at)"
                         " VALUES('legacy-negative','legacy-answer','main-business-kb','测试问题如何办理？',?,'ANSWER_INACCURATE',1,?)",
                         (json.dumps(chunk_ids), stamp))
        for key, question in [("exact", "测试问题如何办理？"), ("paraphrase", "这个测试问题怎么办理？")]:
            response = await ask(service, question, "main-business-kb", key)
            assert response.reasonCode != "DISABLED_TEST_CASE", key
            assert response.result == "ANSWERED", f"{key}: {response.model_dump_json()}"
            assert {ref.documentId for ref in response.grounding.sourceReferences} == {upload.documentId}
            assert "negativeCaseId" not in json.dumps(response.diagnostics or {})
    finally:
        await service.close()
