from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import Depends, File, Form, Header, Request, UploadFile

from .file_manager import delete_file, list_files, require_file
from .pipeline import RagError


def install_file_routes(app, require_auth, execute_idempotent):
    async def save(request: Request, file: UploadFile, metadata: str, request_id: str | None, document_id: str | None = None):
        service = request.app.state.service
        try:
            values = json.loads(metadata)
            if not isinstance(values, dict):
                raise ValueError()
        except (ValueError, TypeError):
            raise RagError("INVALID_REQUEST", "文件信息不合法", 400)
        rid = request_id or "file-" + uuid.uuid4().hex
        kb = str(values.get("knowledgeBaseId") or "main-business-kb")
        lock = await service.idempotency_lock("file-manager:" + kb)
        content = await file.read(service.settings.max_file_bytes + 1)
        payload = {"documentId": document_id, "filename": file.filename,
                   "sha256": hashlib.sha256(content).hexdigest(), "knowledgeBaseId": kb}
        async def accept():
            async with lock:
                return await service.accept_upload(
                    content=content, filename=file.filename or "file.txt", mime_type=file.content_type,
                    metadata={"knowledgeBaseId": kb, "uploadedBy": str(values.get("uploadedBy") or "admin"), "fileManager": True},
                    request_id=rid, document_id=document_id,
                )
        return await execute_idempotent(service, request_id=rid, operation="save_file", payload=payload, status_code=202, handler=accept)

    @app.get("/rag-admin-api/v1/files", dependencies=[Depends(require_auth)])
    async def files(request: Request, knowledge_base_id: str = "main-business-kb"):
        return {"documents": list_files(request.app.state.service, knowledge_base_id)}

    @app.post("/rag-admin-api/v1/files", dependencies=[Depends(require_auth)], status_code=202)
    async def upload(request: Request, file: UploadFile = File(...), metadata: str = Form("{}"), x_request_id: str | None = Header(default=None)):
        return await save(request, file, metadata, x_request_id)

    @app.put("/rag-admin-api/v1/files/{document_id}", dependencies=[Depends(require_auth)], status_code=202)
    async def replace(request: Request, document_id: str, file: UploadFile = File(...), metadata: str = Form("{}"), x_request_id: str | None = Header(default=None)):
        return await save(request, file, metadata, x_request_id, document_id)

    @app.get("/rag-admin-api/v1/files/{document_id}/chunks", dependencies=[Depends(require_auth)])
    async def chunks(request: Request, document_id: str, knowledge_base_id: str = "main-business-kb"):
        service = request.app.state.service
        row = require_file(service, document_id, knowledge_base_id)
        return {"documentId": document_id, "chunks": service.document_chunks(document_id, row["document_version"])}

    @app.get("/rag-admin-api/v1/files/{document_id}", dependencies=[Depends(require_auth)])
    async def detail(request: Request, document_id: str, knowledge_base_id: str = "main-business-kb"):
        row = require_file(request.app.state.service, document_id, knowledge_base_id)
        return request.app.state.service._document_response(row)

    @app.delete("/rag-admin-api/v1/files/{document_id}", dependencies=[Depends(require_auth)])
    async def remove(request: Request, document_id: str, knowledge_base_id: str = "main-business-kb"):
        return await delete_file(request.app.state.service, document_id, knowledge_base_id)
