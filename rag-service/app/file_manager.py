"""File CRUD with automatic indexing; immutable retrieval snapshots stay internal."""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from .models import now_iso
from .pipeline import RagError


def require_file(service: Any, document_id: str, knowledge_base_id: str = "main-business-kb") -> dict:
    row = service.db.get_document_version(document_id)
    if not row or row["knowledge_base_id"] != knowledge_base_id or service.db.get_meta("file_deleted:" + document_id):
        raise RagError("RESOURCE_NOT_FOUND", "文件不存在", 404)
    return row


def list_files(service: Any, knowledge_base_id: str) -> list[dict]:
    active = service.active_release(knowledge_base_id)
    members = service.db.get_release_members(active["release_id"]) if active else []
    applied = {(m["document_id"], m["document_version"]) for m in members}
    result = []
    for row in service.db.list_documents(knowledge_base_id):
        item = service._document_response(row).model_dump(mode="json")
        current = (row["document_id"], row["document_version"]) in applied
        stored = service.db.get_document_version(row["document_id"])
        managed = json.loads(stored.get("metadata_json") or "{}").get("fileManager")
        item["usageStatus"] = (
            "PROCESSING" if row["status"] in {"PROCESSING", "UPLOADED"}
            else "FAILED" if row.get("error") or row["status"] == "PROCESS_FAILED"
            else "ACTIVE" if current else "PROCESSING" if managed else "INACTIVE"
        )
        result.append(item)
    return result


async def _change_snapshot(service: Any, row: dict, *, delete: bool = False) -> None:
    kb = row["knowledge_base_id"]
    document_id = row["document_id"]
    # Each operation starts from the latest snapshot, so concurrent file changes
    # cannot discard one another. The database also checks external publishers.
    for _ in range(3):
        active = service.active_release(kb)
        base_id = active["release_id"] if active else None
        members = service.db.get_release_members(base_id) if base_id else []
        members = [m for m in members if m["document_id"] != document_id
                   and not service.db.get_meta("file_deleted:" + m["document_id"])]
        if not delete:
            chunks = service.db.get_chunks_for_document(document_id, row["document_version"])
            if not chunks:
                raise RagError("EMPTY_FILE_CONTENT", "文件没有可用内容，请修改后重试", 422)
            members.extend(chunks)
        release_id = "release-" + uuid.uuid4().hex[:16]
        service.db.create_release(
            release_id=release_id, knowledge_base_id=kb,
            knowledge_version="files-" + uuid.uuid4().hex[:12], base_release_id=base_id,
            manifest={"operation": "FILE_DELETE" if delete else "FILE_SAVE", "documentId": document_id},
            members=members, published_by="file-manager", publish_note="Automatic file update",
            enabled_count=0, disabled_count=0,
        )
        try:
            await asyncio.to_thread(service.retriever.build_release_index, release_id)
        except Exception:
            service.db.update_release(release_id, status="FAILED", error={"code": "FILE_INDEX_FAILED", "message": "文件索引更新失败"})
            raise RagError("FILE_INDEX_FAILED", "文件索引更新失败，请重试", 503, True)
        published = service.db.publish_release_atomically(
            release_id, expected_base_release_id=base_id,
            operator_id="file-manager", details={"documentId": document_id},
            meta_updates={"file_deleted:" + document_id: now_iso()} if delete else None,
        )
        if published and published["status"] == "PUBLISHED":
            return
    raise RagError("FILE_UPDATE_CONFLICT", "知识内容正在更新，请稍后重试", 409, True)


async def apply_processed_file(service: Any, document_id: str, version: int) -> None:
    row = service.db.get_document_version(document_id)
    if not row or row["document_version"] != version or service.db.get_meta("file_deleted:" + document_id):
        return
    lock = await service.idempotency_lock("file-manager:" + row["knowledge_base_id"])
    async with lock:
        try:
            row = require_file(service, document_id, row["knowledge_base_id"])
            if row["document_version"] != version:
                return
            await _change_snapshot(service, row)
            service.db.update_document_version(document_id, version, status="READY_FOR_TEST", error=None)
        except Exception:
            # Retain the last working contents when a replacement cannot be indexed.
            service.db.update_document_version(document_id, version, error={
                "code": "FILE_APPLY_FAILED", "message": "文件未能生效，请修改并重新上传；原有可用内容继续保留。",
            })


async def delete_file(service: Any, document_id: str, knowledge_base_id: str) -> dict:
    lock = await service.idempotency_lock("file-manager:" + knowledge_base_id)
    async with lock:
        row = require_file(service, document_id, knowledge_base_id)
        if row["status"] in {"PROCESSING", "UPLOADED"}:
            raise RagError("DOCUMENT_PROCESSING", "文件仍在处理中，请处理完成后再删除", 409, True)
        await _change_snapshot(service, row, delete=True)
        return {"documentId": document_id, "deleted": True}


def recover_file_updates(service: Any) -> None:
    # Persisted metadata makes a restart between parsing and activation recoverable.
    for row in service.db.list_documents():
        if row["status"] != "READY_FOR_TEST":
            continue
        stored = service.db.get_document_version(row["document_id"])
        if not json.loads(stored.get("metadata_json") or "{}").get("fileManager"):
            continue
        active = service.active_release(row["knowledge_base_id"])
        members = service.db.get_release_members(active["release_id"]) if active else []
        if any(m["document_id"] == row["document_id"] and m["document_version"] == row["document_version"] for m in members):
            continue
        service._track(asyncio.create_task(apply_processed_file(service, row["document_id"], row["document_version"])))
