from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import ChatMessage, ChatSession, MessageRole, User


class ShortTermMemory:
    def __init__(self, turns: int | None = None) -> None:
        self.turns = turns or get_settings().short_term_memory_turns

    def get_or_create_session(
        self,
        db: Session,
        *,
        user: User,
        session_id: str | None,
    ) -> ChatSession:
        session = None
        if session_id:
            session = db.get(ChatSession, session_id)
            if session and session.user_id != user.id:
                raise PermissionError("Session does not belong to this user")
        if not session:
            session = ChatSession(user_id=user.id)
            db.add(session)
            db.commit()
            db.refresh(session)
        return session

    def add_message(self, db: Session, *, session: ChatSession, user: User, role: MessageRole, content: str) -> None:
        db.add(ChatMessage(session_id=session.id, user_id=user.id, role=role, content=content))
        db.commit()

    def recent_messages(self, db: Session, *, session: ChatSession) -> list[ChatMessage]:
        limit = self.turns * 2
        rows = list(
            db.scalars(
                select(ChatMessage)
                .where(ChatMessage.session_id == session.id)
                .order_by(ChatMessage.sequence.desc())
                .limit(limit)
            )
        )
        return list(reversed(rows))

    def to_prompt_messages(self, db: Session, *, session: ChatSession) -> list[dict[str, str]]:
        return [{"role": msg.role.value, "content": msg.content} for msg in self.recent_messages(db, session=session)]
