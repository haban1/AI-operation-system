"""Test helpers for the 2026-11-11 file auto-activation flow.

Uploads go through the file manager (``metadata.fileManager``): parsing, indexing and
the atomic switch of the active retrieval snapshot happen automatically. There is no
test-session, manual release or rollback step any more (docs/knowledge-files.md).
"""
from __future__ import annotations

import asyncio
from typing import Any

KNOWLEDGE_BASE_ID = "main-business-kb"


async def settle(service: Any) -> None:
    while service._tasks:
        await asyncio.gather(*list(service._tasks))


def active_members(service: Any, knowledge_base_id: str = KNOWLEDGE_BASE_ID) -> list[dict]:
    active = service.active_release(knowledge_base_id)
    return service.db.get_release_members(active["release_id"]) if active else []


async def publish_file(
    service: Any, content: bytes, filename: str, mime_type: str, *,
    metadata: dict | None = None, request_id: str = "upload", document_id: str | None = None,
    knowledge_base_id: str = KNOWLEDGE_BASE_ID,
):
    """Save a file and wait until it is the active knowledge for queries."""
    upload = await service.accept_upload(
        content=content, filename=filename, mime_type=mime_type,
        metadata={"knowledgeBaseId": knowledge_base_id, **(metadata or {}), "fileManager": True},
        request_id=request_id, document_id=document_id,
    )
    await settle(service)
    document = service.get_document(upload.documentId)
    assert document.status == "READY_FOR_TEST" and not document.error, document.model_dump_json()
    assert any(m["document_id"] == upload.documentId and m["document_version"] == upload.documentVersion
               for m in active_members(service, knowledge_base_id)), "saved file must be active without a manual release"
    return upload
