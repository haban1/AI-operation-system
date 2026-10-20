from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.core.permissions import require_role
from app.knowledge.parsers import SUPPORTED_SUFFIXES
from app.knowledge.service import DocumentKnowledgeService
from app.models.entities import KnowledgeDocument, KnowledgeChunk, User, Role

router = APIRouter(prefix="/knowledge", tags=["document-knowledge"])


def manager(user: User = Depends(get_current_user)) -> User:
    require_role(user, {Role.admin})
    return user


def document_or_404(db: Session, document_id: str) -> KnowledgeDocument:
    document = db.get(KnowledgeDocument, document_id)
    if not document:
        raise HTTPException(404, "文档不存在")
    return document


def summary(document: KnowledgeDocument) -> dict:
    return {key: getattr(document, key) for key in (
        "id", "filename", "status", "is_active", "chunk_count", "index_mode", "error_message", "created_at", "updated_at"
    )}


@router.get("/documents")
def list_documents(db: Session = Depends(get_db), user: User = Depends(manager)):
    return [summary(doc) for doc in db.scalars(select(KnowledgeDocument).order_by(KnowledgeDocument.created_at.desc()))]


@router.post("/documents", status_code=201)
def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(manager)):
    filename = Path((file.filename or "").replace("\\", "/")).name
    if Path(filename).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise HTTPException(400, "支持 PDF、Word（.docx）、TXT、Markdown；旧版 .doc 请另存为 .docx。")
    if len(filename) > 255:
        raise HTTPException(400, "文件名过长")
    limit = get_settings().document_max_upload_mb * 1024 * 1024
    content = file.file.read(limit + 1)
    if not content or len(content) > limit:
        raise HTTPException(400, f"请上传非空且不超过 {get_settings().document_max_upload_mb} MB 的文件。")
    document = KnowledgeDocument(filename=filename, content=content, uploaded_by_id=user.id)
    db.add(document)
    db.commit()
    DocumentKnowledgeService().process(db, document)
    return summary(document)


@router.get("/documents/{document_id}")
def preview_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(manager)):
    document = document_or_404(db, document_id)
    chunks = db.scalars(select(KnowledgeChunk).where(KnowledgeChunk.document_id == document_id).order_by(KnowledgeChunk.position))
    return {**summary(document), "chunks": [{"id": c.id, "location": c.location, "text": c.text} for c in chunks]}


class DocumentUpdate(BaseModel):
    is_active: bool


@router.patch("/documents/{document_id}")
def update_document(document_id: str, payload: DocumentUpdate, db: Session = Depends(get_db), user: User = Depends(manager)):
    document = document_or_404(db, document_id)
    document.is_active = payload.is_active
    db.commit()
    return summary(document)


@router.post("/documents/{document_id}/reindex")
def reindex_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(manager)):
    document = document_or_404(db, document_id)
    DocumentKnowledgeService().process(db, document)
    return summary(document)


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(manager)):
    document = document_or_404(db, document_id)
    db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == document_id))
    db.delete(document)
    db.commit()
    return Response(status_code=204)


@router.get("/documents/{document_id}/download")
def download_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(manager)):
    document = document_or_404(db, document_id)
    return Response(document.content, media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(document.filename),
        "X-Content-Type-Options": "nosniff",
    })


class SearchRequest(BaseModel):
    query: str


@router.post("/search")
def search_documents(payload: SearchRequest, db: Session = Depends(get_db), user: User = Depends(manager)):
    if not payload.query.strip() or len(payload.query) > 4000:
        raise HTTPException(400, "查询不能为空且不能超过 4000 字")
    return {"chunks": DocumentKnowledgeService().search(db, payload.query)}
