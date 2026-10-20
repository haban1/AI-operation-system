import json
import logging
import time
from collections.abc import Callable, Iterator

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.agent.service import AgentService
from app.api.deps import get_current_user
from app.api.schemas import ChatRequest, ChatResponse, ChatSessionRead
from app.core.database import SessionLocal, get_db
from app.models.entities import ChatMessage, ChatSession, User


router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


@router.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return AgentService().answer(
        db,
        user=current_user,
        message=payload.message,
        session_id=payload.session_id,
    )


@router.post("/chat/stream")
def chat_stream(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    user_id = current_user.id

    def answer() -> dict:
        with SessionLocal() as db:
            user = db.get(User, user_id)
            if not user or not user.is_active:
                raise RuntimeError("Chat user is unavailable")
            return AgentService().answer(
                db,
                user=user,
                message=payload.message,
                session_id=payload.session_id,
            )

    return StreamingResponse(
        _stream_chat_events(answer),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/chat/sessions/{session_id}", response_model=ChatSessionRead)
def get_chat_session(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    session = db.get(ChatSession, session_id)
    if not session or session.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    messages = list(
        db.scalars(select(ChatMessage).where(ChatMessage.session_id == session.id).order_by(ChatMessage.sequence))
    )
    return {
        "id": session.id,
        "messages": [
            {"role": msg.role.value, "content": msg.content, "created_at": msg.created_at} for msg in messages
        ],
    }


def _stream_chat_events(
    answer: Callable[[], dict],
    *,
    chunk_chars: int = 6,
    delay_seconds: float = 0.035,
) -> Iterator[str]:
    yield _stream_event(
        "status",
        stage="planning",
        message="正在理解问题并检索知识文档...",
    )
    try:
        result = answer()
    except Exception:
        logger.exception("Streaming chat failed")
        yield _stream_event(
            "error",
            message="回答生成失败，请稍后重试。",
        )
        return

    yield _stream_event(
        "meta",
        session_id=result.get("session_id"),
    )
    answer_text = str(result.get("answer") or "")
    size = max(1, chunk_chars)
    for start in range(0, len(answer_text), size):
        yield _stream_event("delta", content=answer_text[start : start + size])
        if delay_seconds > 0:
            time.sleep(delay_seconds)
    yield _stream_event("done", data=result)


def _stream_event(event_type: str, **payload) -> str:
    return json.dumps(
        {"type": event_type, **payload},
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"
