from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models.entities import (
    ChatSession,
    Role,
    User,
    WeComMessageReceipt,
    WeComUserBinding,
)


def get_or_create_wecom_user(db: Session, *, wecom_user_id: str) -> User:
    binding = db.scalar(select(WeComUserBinding).where(WeComUserBinding.wecom_user_id == wecom_user_id))
    if binding:
        user = db.get(User, binding.user_id)
        if user:
            return user

    username = f"wecom:{wecom_user_id}"
    user = db.scalar(select(User).where(User.username == username))
    if not user:
        user = User(
            username=username,
            password_hash=hash_password(wecom_user_id),
            role=Role.student,
        )
        db.add(user)
        db.flush()

    db.add(WeComUserBinding(user_id=user.id, wecom_user_id=wecom_user_id))
    db.flush()
    return user


def get_or_create_wecom_conversation(
    db: Session,
    *,
    wecom_user_id: str,
) -> tuple[User, ChatSession]:
    user = get_or_create_wecom_user(db, wecom_user_id=wecom_user_id)
    binding = db.scalar(
        select(WeComUserBinding).where(
            WeComUserBinding.wecom_user_id == wecom_user_id
        )
    )
    if not binding:
        raise RuntimeError("WeCom user binding was not created")

    session = (
        db.get(ChatSession, binding.active_session_id)
        if binding.active_session_id
        else None
    )
    if session and session.user_id == user.id:
        return user, session

    session = ChatSession(user_id=user.id)
    db.add(session)
    db.flush()
    binding.active_session_id = session.id
    db.flush()
    return user, session


def mark_message_if_new(db: Session, *, msg_id: str, from_user: str) -> bool:
    if not msg_id:
        return True
    db.add(WeComMessageReceipt(msg_id=msg_id, from_user=from_user))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return False
    return True


def forget_message(db: Session, *, msg_id: str) -> None:
    if not msg_id:
        return
    db.execute(delete(WeComMessageReceipt).where(WeComMessageReceipt.msg_id == msg_id))
    db.flush()
