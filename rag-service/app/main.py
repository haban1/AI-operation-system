from __future__ import annotations

import asyncio
import hashlib
import hmac
import inspect
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .models import (
    QueryRequest,
    QueryResponse,
    TraceFeedbackRequest,
    now_iso,
)
from .pipeline import RagError, RagService
from .published_retrieval import PublishedRetrievalRequest, retrieve_published
from .embeddings import EmbeddingRequest, embed_local


settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    service = RagService(settings)
    app.state.service = service
    await service.recover_tasks()
    from .file_manager import recover_file_updates
    recover_file_updates(service)
    yield
    await service.close()


app = FastAPI(
    title="Local RAG Service",
    version=settings.service_version,
    description="Local-first RAG with automatic file indexing, answer presentation settings, and grounded queries.",
    lifespan=lifespan,
)


@app.middleware("http")
async def security_headers(request: Request, call_next: Any):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
    return response

bearer_scheme = HTTPBearer(auto_error=False)


async def require_retrieval_auth(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)):
    token = settings.retrieval_bearer_token
    if not token or not credentials or not hmac.compare_digest(credentials.credentials, token):
        raise RagError("UNAUTHORIZED", "知识检索凭据无效", 401)


@app.post("/rag-api/v1/retrieve", dependencies=[Depends(require_retrieval_auth)])
async def published_retrieve(request: Request, body: PublishedRetrievalRequest):
    return await retrieve_published(request.app.state.service, body)


def service_from(request: Request) -> RagService:
    return request.app.state.service


async def require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> None:
    service = service_from(request)
    if not service.settings.auth_enabled:
        return
    supplied = credentials.credentials if credentials else ""
    if not supplied or not hmac.compare_digest(supplied, service.settings.bearer_token):
        raise RagError("UNAUTHORIZED", "Bearer token无效", 401)




@app.post("/rag-admin-api/v1/embeddings", dependencies=[Depends(require_auth)])
async def local_embeddings(request: Request, body: EmbeddingRequest):
    return await embed_local(service_from(request), body)


def error_response(request_id: str | None, error: RagError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={
            "contractVersion": settings.contract_version,
            "requestId": request_id or "unknown",
            "error": {
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "retryAfterMs": 1000 if error.retryable else None,
                "details": error.details,
            },
        },
    )


@app.exception_handler(RagError)
async def rag_error_handler(request: Request, exc: RagError):
    return error_response(request.headers.get("x-request-id"), exc)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    error = RagError("INVALID_REQUEST", "请求字段不合法", 422, details=jsonable_encoder(exc.errors()))
    return error_response(request.headers.get("x-request-id"), error)


@app.exception_handler(Exception)
async def generic_error_handler(request: Request, exc: Exception):
    error = RagError("INTERNAL_ERROR", "RAG服务内部异常", 500, True)
    return error_response(request.headers.get("x-request-id"), error)


def request_id_from(body: Any, header: str | None) -> str:
    body_id = getattr(body, "requestId", None) if body is not None else None
    if header and body_id and header != body_id:
        raise RagError("INVALID_REQUEST", "Header与请求体requestId不一致", 400)
    return str(body_id or header or "request-" + uuid.uuid4().hex)


def replay_or_conflict(service: RagService, request_id: str, operation: str, payload: Any) -> JSONResponse | None:
    payload_hash = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()
    existing = service.db.get_idempotency(request_id)
    if not existing:
        return None
    if existing["operation"] != operation or existing["payload_hash"] != payload_hash:
        raise RagError("IDEMPOTENCY_CONFLICT", "同一requestId对应了不同请求内容", 409)
    return JSONResponse(status_code=existing["status_code"], content=existing["response"])


def save_idempotency(service: RagService, request_id: str, operation: str, payload: Any, status: int, response: Any) -> None:
    payload_hash = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()
    service.db.save_idempotency(request_id, operation, payload_hash, status, response)


def serialized(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


async def execute_idempotent(
    service: RagService,
    *,
    request_id: str,
    operation: str,
    payload: Any,
    status_code: int,
    handler: Any,
) -> JSONResponse:
    payload_hash = hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    ).hexdigest()
    lock = await service.idempotency_lock(request_id)
    async with lock:
        existing = service.db.get_idempotency(request_id)
        if existing:
            if existing["operation"] != operation or existing["payload_hash"] != payload_hash:
                raise RagError("IDEMPOTENCY_CONFLICT", "同一requestId对应了不同请求内容", 409)
            if existing.get("state") == "PENDING":
                return JSONResponse(
                    status_code=409,
                    content={
                        "contractVersion": settings.contract_version,
                        "requestId": request_id,
                        "error": {
                            "code": "IDEMPOTENCY_IN_PROGRESS",
                            "message": "该requestId的副作用正在恢复或执行中，请稍后重试",
                            "retryable": True,
                            "retryAfterMs": 1000,
                            "details": None,
                        },
                    },
                )
            return JSONResponse(status_code=existing["status_code"], content=existing["response"])
        reserved = service.db.reserve_idempotency(request_id, operation, payload_hash, status_code)
        if not reserved:
            existing = service.db.get_idempotency(request_id)
            if existing and existing.get("state") == "PENDING":
                raise RagError("IDEMPOTENCY_IN_PROGRESS", "该requestId的副作用正在执行中，请稍后重试", 409, True)
            raise RagError("IDEMPOTENCY_CONFLICT", "无法保留requestId", 409)
        try:
            value = handler()
            if inspect.isawaitable(value):
                value = await value
            content = serialized(value)
            service.db.save_idempotency(request_id, operation, payload_hash, status_code, content)
            return JSONResponse(status_code=status_code, content=content)
        except Exception:
            service.db.delete_idempotency(request_id)
            raise


from .file_api import install_file_routes
install_file_routes(app, require_auth, execute_idempotent)
from .persona_api import router as persona_router
app.include_router(persona_router, dependencies=[Depends(require_auth)])


@app.get("/rag-api/v1/health", dependencies=[Depends(require_auth)])
async def health(request: Request):
    service = service_from(request)
    active = service.active_release()
    providers = service.provider_status()
    if not active:
        status = "NOT_READY"
    elif any(item.get("error") and not item.get("fallback", False) for item in providers.values() if isinstance(item, dict)):
        status = "DEGRADED"
    else:
        status = "READY"
    return {
        "status": status,
        "contractVersion": settings.contract_version,
        "serviceVersion": settings.service_version,
        "knowledgeVersion": active.get("knowledge_version") if active else None,
        "releaseId": active.get("release_id") if active else None,
        "timestamp": now_iso(),
        "providers": providers,
    }


@app.get("/rag-admin-api/v1/system/providers", dependencies=[Depends(require_auth)])
async def providers(request: Request):
    return service_from(request).provider_status()


@app.get("/rag-admin-api/v1/system/chunk-policies", dependencies=[Depends(require_auth)])
async def chunk_policies():
    from .chunking import POLICY_PROFILES

    return {
        "policies": [
            {"name": name, "profile": profile, "selection": "manual_or_deterministic"}
            for name, profile in POLICY_PROFILES.items()
        ]
    }


@app.get("/rag-admin-api/v1/system/status", dependencies=[Depends(require_auth)])
async def system_status(request: Request):
    service = service_from(request)
    from .file_manager import list_files
    documents = list_files(service, "main-business-kb")
    return {
        "phase": "READY" if any(item["usageStatus"] == "ACTIVE" for item in documents) else "WAITING_FOR_DOCUMENT",
        "counts": {"documents": len(documents)},
        "updatedAt": now_iso(),
    }


@app.post("/rag-api/v1/query", response_model=QueryResponse, dependencies=[Depends(require_auth)])
async def formal_query(request: Request, body: QueryRequest, x_request_id: str | None = Header(default=None)):
    service = service_from(request)
    request_id = request_id_from(body, x_request_id)
    payload = body.model_dump(mode="json")
    return await execute_idempotent(
        service,
        request_id=request_id,
        operation="formal_query",
        payload=payload,
        status_code=200,
        handler=lambda: service.formal_query(body),
    )


@app.get("/rag-admin-api/v1/traces", dependencies=[Depends(require_auth)])
async def list_traces(request: Request, limit: int = 50, offset: int = 0):
    return {"traces": service_from(request).db.list_traces(min(200, max(1, limit)), max(0, offset))}


@app.get("/rag-admin-api/v1/traces/{trace_id}", dependencies=[Depends(require_auth)])
async def trace_detail(request: Request, trace_id: str):
    return service_from(request).trace(trace_id)


@app.post("/rag-admin-api/v1/traces/{trace_id}/feedback", dependencies=[Depends(require_auth)])
async def trace_feedback(request: Request, trace_id: str, body: TraceFeedbackRequest):
    service = service_from(request)
    if not service.db.get_trace(trace_id):
        raise RagError("RESOURCE_NOT_FOUND", "Trace不存在", 404)
    data = {
        "feedback_id": "feedback-" + uuid.uuid4().hex[:16],
        "trace_id": trace_id,
        "request_id": body.requestId,
        "rating": body.rating,
        "note": str(body.note or "")[:4000],
        "reviewer_id": body.reviewerId,
        "tags": body.tags,
    }
    payload = {"traceId": trace_id, **body.model_dump(mode="json")}
    return await execute_idempotent(
        service,
        request_id=body.requestId,
        operation="trace_feedback",
        payload=payload,
        status_code=200,
        handler=lambda: service.db.save_feedback(data),
    )


@app.get("/")
async def service_info():
    return {"service": "knowledge-files", "status": "running"}
