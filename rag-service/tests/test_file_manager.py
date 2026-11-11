import asyncio
from pathlib import Path

import pytest

from app.file_manager import delete_file, list_files, recover_file_updates, require_file
from app.pipeline import RagError, RagService
from app.retrieval import SearchScope
from app.config import Settings
from app.models import Snapshot, SourceInfo
from app.persona import AnswerProfile, save_answer_profile


def local_settings(tmp_path):
    return Settings(auth_enabled=False, data_dir=tmp_path / "data", upload_dir=tmp_path / "data/uploads",
                    model_cache_dir=tmp_path / "models", sqlite_path=tmp_path / "data/rag.db",
                    qdrant_path=tmp_path / "data/qdrant", embedding_provider="hash", reranker_provider="lexical",
                    generation_provider="deterministic", llm_base_url="", llm_api_key="",
                    deep_agent_enabled=False, query_rewrite_enabled=False)


async def settle(service):
    while service._tasks:
        await asyncio.gather(*list(service._tasks))


async def upload(service, text="测试服务费用为100元。", document_id=None):
    result = await service.accept_upload(
        content=text.encode(), filename="service.txt", mime_type="text/plain",
        metadata={"knowledgeBaseId": "main-business-kb", "fileManager": True},
        request_id="file-test", document_id=document_id,
    )
    await settle(service)
    return result


def members(service):
    active = service.active_release()
    return service.db.get_release_members(active["release_id"]) if active else []


@pytest.mark.asyncio
async def test_current_file_query_uses_saved_profile_and_freezes_it_during_request(tmp_path, monkeypatch):
    service = RagService(local_settings(tmp_path))
    try:
        await upload(service)
        active_id = service.active_release()["release_id"]
        initial = AnswerProfile(assistantName="本地答疑助手", stylePrompt="简短温和地回答。")
        updated = AnswerProfile(assistantName="本地答疑助手", stylePrompt="按步骤回答。")
        save_answer_profile(service.db, "main-business-kb", initial)
        seen = []
        original_plan, original_run = service._query_plan, service.agent.run

        async def plan(*args, **kwargs):
            save_answer_profile(service.db, "main-business-kb", updated)
            return await original_plan(*args, **kwargs)

        async def generate(**kwargs):
            seen.append(kwargs["answer_profile"])
            return await original_run(**kwargs)

        monkeypatch.setattr(service, "_query_plan", plan)
        monkeypatch.setattr(service.agent, "run", generate)
        for index in range(2):
            answer = await service.run_query(
                question="测试服务费用是多少？", knowledge_base_id="main-business-kb",
                snapshot=Snapshot(conversationKey="LOCAL_TEST:profile", conversationVersion=index, inputFingerprint=f"sha256:{index}"),
                source=SourceInfo(accountId="local-test"), trace_id=f"local-test-{index}", request_id=f"local-test-{index}",
            )
            assert answer.result == "ANSWERED"
            assert "100" in answer.answer.text
            assert answer.grounding.sourceReferences
        assert seen == [initial, updated], "profile edits affect the next query, never an in-flight query"
        assert service.active_release()["release_id"] == active_id, "style saving needs no publication or reindex"
        assert len(list_files(service, "main-business-kb")) == 1
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_file_upload_replace_and_delete_update_formal_search(tmp_path: Path):
    service = RagService(local_settings(tmp_path))
    try:
        item = await upload(service)
        assert list_files(service, "main-business-kb")[0]["usageStatus"] == "ACTIVE"
        assert all(m["document_version"] == 1 for m in members(service))
        replaced = await upload(service, "测试服务费用为200元。", item.documentId)
        assert replaced.documentId == item.documentId and replaced.documentVersion == 2
        assert len(list_files(service, "main-business-kb")) == 1
        assert all(m["document_version"] == 2 and "200" in m["text"] and "100" not in m["text"] for m in members(service))
        hits = service.retriever.search("测试服务费用", SearchScope("main-business-kb", release_id=service.active_release()["release_id"]))["hits"]
        assert hits and all(h["document_version"] == 2 for h in hits)
        answer = await service.run_query(
            question="测试服务费用是多少？", knowledge_base_id="main-business-kb",
            snapshot=Snapshot(conversationKey="files", conversationVersion=1, inputFingerprint="sha256:files"),
            source=SourceInfo(), trace_id="file-query", request_id="file-query",
        )
        assert answer.result == "ANSWERED"
        assert "200" in answer.answer.text
        assert all(reference.documentVersion == 2 for reference in answer.grounding.sourceReferences)
        await delete_file(service, item.documentId, "main-business-kb")
        assert not list_files(service, "main-business-kb")
        assert not members(service)
        hits = service.retriever.search("测试服务费用", SearchScope("main-business-kb", release_id=service.active_release()["release_id"]))["hits"]
        assert not hits
        with pytest.raises(RagError, match="文件不存在"):
            require_file(service, item.documentId)
        # Legacy audit snapshots are retained, but restart cannot reactivate deletion.
        recover_file_updates(service)
        await settle(service)
        assert not members(service)
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_concurrent_files_and_identical_contents_keep_independent_ids(tmp_path: Path):
    service = RagService(local_settings(tmp_path))
    try:
        left, right = await asyncio.gather(upload(service), upload(service))
        assert left.documentId != right.documentId
        assert {m["document_id"] for m in members(service)} == {left.documentId, right.documentId}
        await delete_file(service, left.documentId, "main-business-kb")
        assert {m["document_id"] for m in members(service)} == {right.documentId}
        replaced = await upload(service, document_id=right.documentId)
        assert replaced.documentId == right.documentId and replaced.documentVersion == 2
        assert all(m["document_version"] == 2 for m in members(service))
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_failed_index_and_failed_delete_preserve_working_knowledge(tmp_path: Path, monkeypatch):
    service = RagService(local_settings(tmp_path))
    try:
        item = await upload(service)
        original = service.active_release()["release_id"]
        build = service.retriever.build_release_index
        def fail(_):
            raise RuntimeError("simulated disk failure")
        monkeypatch.setattr(service.retriever, "build_release_index", fail)
        await upload(service, "新内容尚未生效。", item.documentId)
        assert service.active_release()["release_id"] == original
        assert list_files(service, "main-business-kb")[0]["usageStatus"] == "FAILED"
        with pytest.raises(RagError, match="文件索引更新失败"):
            await delete_file(service, item.documentId, "main-business-kb")
        assert require_file(service, item.documentId)
        assert service.active_release()["release_id"] == original
        monkeypatch.setattr(service.retriever, "build_release_index", build)
        recover_file_updates(service)
        await settle(service)
        assert list_files(service, "main-business-kb")[0]["usageStatus"] == "ACTIVE"
        assert all("新内容" in m["text"] for m in members(service))
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_invalid_replacement_and_wrong_scope_do_not_destroy_old_contents(tmp_path: Path):
    service = RagService(local_settings(tmp_path))
    try:
        item = await upload(service)
        with pytest.raises(RagError):
            await service.accept_upload(content=b"", filename="empty.txt", mime_type=None, metadata={"fileManager": True}, request_id="empty", document_id=item.documentId)
        with pytest.raises(RagError):
            await delete_file(service, item.documentId, "other-kb")
        assert len(list_files(service, "main-business-kb")) == 1
        assert all("100" in m["text"] for m in members(service))
    finally:
        await service.close()


def test_file_http_contract_and_retired_workflows(tmp_path, monkeypatch):
    import time
    from fastapi.testclient import TestClient
    import app.main as main
    monkeypatch.setattr(main, "settings", local_settings(tmp_path))
    with TestClient(main.app) as client:
        response = client.post("/rag-admin-api/v1/files", files={"file": ("sample.txt", "示例服务费用200元。".encode(), "text/plain")})
        assert response.status_code == 202
        item = response.json()
        for _ in range(100):
            documents = client.get("/rag-admin-api/v1/files").json()["documents"]
            if documents[0]["usageStatus"] != "PROCESSING":
                break
            time.sleep(0.02)
        assert documents[0]["usageStatus"] == "ACTIVE"
        path = "/rag-admin-api/v1/files/" + item["documentId"]
        assert client.get(path).status_code == 200
        assert "200" in client.get(path + "/chunks").json()["chunks"][0]["text"]
        assert client.put(path, files={"file": ("changed.txt", "示例服务费用300元。".encode(), "text/plain")} ).status_code == 202
        for _ in range(100):
            documents = client.get("/rag-admin-api/v1/files").json()["documents"]
            if documents[0]["usageStatus"] != "PROCESSING":
                break
            time.sleep(0.02)
        assert documents[0]["documentId"] == item["documentId"]
        assert documents[0]["filename"] == "changed.txt"
        assert "300" in client.get(path + "/chunks").json()["chunks"][0]["text"]
        assert client.delete(path).status_code == 200
        assert client.get(path).status_code == 404
        assert client.get(path + "/chunks").status_code == 404
        assert not client.get("/rag-admin-api/v1/files").json()["documents"]
        for method, path in [
            ("get", "/rag-admin-api/v1/test-sessions"),
            ("post", "/rag-admin-api/v1/test-sessions"),
            ("post", "/rag-admin-api/v1/test-sessions/id/query"),
            ("post", "/rag-admin-api/v1/knowledge-bases/main-business-kb/releases"),
            ("get", "/rag-admin-api/v1/releases"),
            ("post", "/rag-admin-api/v1/releases/id/rollback"),
            ("post", "/rag-admin-api/v1/evaluations/run"),
            ("post", "/rag-admin-api/v1/debug/query"),
        ]:
            assert getattr(client, method)(path).status_code == 404
        service = main.app.state.service
        assert not hasattr(service, "create_test_session")
        assert not hasattr(service, "start_release")
        assert not hasattr(service, "rollback")
        assert not hasattr(service.db, "rollback_release_atomically")
