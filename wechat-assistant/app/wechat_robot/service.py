from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.agent.service import AgentService
from app.core.config import get_settings
from app.core.security import hash_password
from app.models.entities import (
    ChatSession,
    FAQEntry,
    Role,
    User,
    WechatRobotHandoffNotifier,
    WechatRobotMessageReceipt,
    WechatRobotOutboundReceipt,
    WechatRobotUserBinding,
    utcnow,
)
from app.wechat_robot.client import WechatRobotClient


logger = logging.getLogger(__name__)
CHAT_ROOM_SUFFIX = "@chatroom"
SUPPORTED_GROUP_REPLY_MODES = {"off", "mention", "all"}
NEW_FRIEND_MARKERS = (
    "过了你的朋友验证请求",
    "你已添加了",
    "现在可以开始聊天了",
)
MANUAL_OUTBOUND_MESSAGE_TYPES = {1, 3, 34, 43, 47, 49}
OUTBOUND_RECEIPT_TTL = timedelta(minutes=10)
HANDOFF_NOTIFIER_ID = "default"


@dataclass(frozen=True)
class IncomingWechatMessage:
    msg_id: str
    msg_type: int
    from_wxid: str
    to_wxid: str
    content: str
    msg_source: str
    room_wxid: str
    sender_wxid: str

    @property
    def is_chat_room(self) -> bool:
        return bool(self.room_wxid)

    @property
    def conversation_key(self) -> str:
        if self.room_wxid:
            return f"room:{self.room_wxid}:sender:{self.sender_wxid}"
        return f"private:{self.from_wxid}"


def process_wechat_robot_payload(
    db: Session,
    *,
    payload: dict[str, Any],
    robot_wxid: str = "",
    client: WechatRobotClient | None = None,
    agent: AgentService | None = None,
) -> dict[str, int]:
    client = client or WechatRobotClient()
    agent = agent or AgentService()
    configured_robot_wxid = robot_wxid.strip()
    counts = {
        "received": 0,
        "replied": 0,
        "greeted": 0,
        "ignored": 0,
        "failed": 0,
    }

    for message in parse_wechat_robot_messages(payload):
        normalized_robot_wxid = (
            configured_robot_wxid
            or message.to_wxid.strip()
            or "default"
        )
        counts["received"] += 1
        if not message.from_wxid:
            counts["ignored"] += 1
            continue
        if not mark_message_if_new(
            db,
            robot_wxid=normalized_robot_wxid,
            message=message,
        ):
            counts["ignored"] += 1
            continue
        if message.from_wxid == normalized_robot_wxid:
            try:
                _handle_outgoing_wechat_message(
                    db,
                    robot_wxid=normalized_robot_wxid,
                    message=message,
                )
                counts["ignored"] += 1
            except Exception:
                db.rollback()
                counts["failed"] += 1
                logger.exception(
                    "Failed to process outgoing WeChat message %s",
                    message.msg_id,
                )
            continue

        try:
            if _should_greet_new_friend(message):
                binding, _, _ = get_or_create_wechat_robot_conversation(
                    db,
                    robot_wxid=normalized_robot_wxid,
                    message=message,
                )
                if _send_greeting_if_needed(
                    db=db,
                    binding=binding,
                    robot_wxid=normalized_robot_wxid,
                    target_wxid=message.from_wxid,
                    client=client,
                ):
                    counts["greeted"] += 1
                db.commit()
                continue

            if not _should_auto_reply(message, robot_wxid=normalized_robot_wxid):
                counts["ignored"] += 1
                db.commit()
                continue

            binding, user, session = get_or_create_wechat_robot_conversation(
                db,
                robot_wxid=normalized_robot_wxid,
                message=message,
            )
            if is_wechat_robot_handoff_active(binding):
                binding.handoff_last_message = message.content
                binding.handoff_updated_at = utcnow()
                counts["ignored"] += 1
                db.commit()
                continue
            if (
                not message.is_chat_room
                and _send_greeting_if_needed(
                    db=db,
                    binding=binding,
                    robot_wxid=normalized_robot_wxid,
                    target_wxid=message.from_wxid,
                    client=client,
                )
            ):
                counts["greeted"] += 1

            result = agent.answer(
                db,
                user=user,
                message=message.content,
                session_id=session.id,
            )
            answer = str(result.get("answer") or "").strip()
            if not answer:
                answer = "暂时没有生成回答，请换个问法再试。"
            decision = str(result.get("decision") or "").strip().upper()
            if decision == "HANDOFF":
                notice = get_settings().wechat_robot_handoff_message.strip()
                if notice and not any(
                    marker in answer
                    for marker in ("转接人工", "人工客服", "人工接待")
                ):
                    answer = f"{answer}\n\n{notice}"
            target_wxid = message.room_wxid or message.from_wxid
            at = (message.sender_wxid,) if message.is_chat_room else ()
            send_programmatic_text(
                db,
                client=client,
                robot_wxid=normalized_robot_wxid,
                to_wxid=target_wxid,
                content=answer,
                at=at,
            )
            for image_url in _matched_wechat_image_urls(db, result):
                try:
                    send_programmatic_image_urls(
                        db,
                        client=client,
                        robot_wxid=normalized_robot_wxid,
                        to_wxid=target_wxid,
                        image_urls=(image_url,),
                    )
                except Exception:
                    logger.exception(
                        "Failed to send WeChat robot image %s",
                        image_url,
                    )
            if decision == "HANDOFF":
                start_wechat_robot_handoff(
                    binding,
                    reason=message.content,
                )
                try:
                    notify_wechat_robot_handoff(
                        db,
                        client=client,
                        robot_wxid=normalized_robot_wxid,
                        binding=binding,
                    )
                except Exception:
                    logger.exception(
                        "Failed to notify WeChat handoff recipient for %s",
                        binding.peer_wxid,
                    )
            db.commit()
            counts["replied"] += 1
        except Exception:
            db.rollback()
            counts["failed"] += 1
            logger.exception(
                "Failed to process WeChat robot message %s",
                message.msg_id,
            )
    return counts


def _handle_outgoing_wechat_message(
    db: Session,
    *,
    robot_wxid: str,
    message: IncomingWechatMessage,
) -> None:
    target_wxid = message.to_wxid.strip()
    if (
        not target_wxid
        or target_wxid.endswith(CHAT_ROOM_SUFFIX)
        or message.msg_type not in MANUAL_OUTBOUND_MESSAGE_TYPES
    ):
        db.commit()
        return
    if consume_programmatic_outbound(
        db,
        robot_wxid=robot_wxid,
        to_wxid=target_wxid,
        msg_type=message.msg_type,
        content=message.content,
    ):
        return

    incoming_view = IncomingWechatMessage(
        msg_id=message.msg_id,
        msg_type=message.msg_type,
        from_wxid=target_wxid,
        to_wxid=robot_wxid,
        content=message.content,
        msg_source=message.msg_source,
        room_wxid="",
        sender_wxid=target_wxid,
    )
    binding, _, _ = get_or_create_wechat_robot_conversation(
        db,
        robot_wxid=robot_wxid,
        message=incoming_view,
    )
    now = utcnow()
    if not is_wechat_robot_handoff_active(binding, now=now):
        start_wechat_robot_handoff(
            binding,
            reason="客服通过电脑微信主动接管",
        )
    binding.handoff_updated_at = now
    binding.handoff_last_message = _outgoing_message_summary(message)
    db.commit()


def _outgoing_message_summary(message: IncomingWechatMessage) -> str:
    content = message.content.strip()
    if content:
        return content[:1000]
    labels = {
        3: "[图片]",
        34: "[语音]",
        43: "[视频]",
        47: "[表情]",
        49: "[文件或链接]",
    }
    return labels.get(message.msg_type, "[人工消息]")


def register_programmatic_outbound(
    db: Session,
    *,
    robot_wxid: str,
    to_wxid: str,
    msg_type: int,
    content: str = "",
) -> WechatRobotOutboundReceipt:
    now = utcnow()
    db.execute(
        delete(WechatRobotOutboundReceipt).where(
            WechatRobotOutboundReceipt.created_at
            < now - OUTBOUND_RECEIPT_TTL
        )
    )
    receipt = WechatRobotOutboundReceipt(
        robot_wxid=robot_wxid.strip(),
        to_wxid=to_wxid.strip(),
        msg_type=msg_type,
        content_hash=_outbound_content_hash(content),
    )
    db.add(receipt)
    db.commit()
    return receipt


def cancel_programmatic_outbound(
    db: Session,
    receipt: WechatRobotOutboundReceipt,
) -> None:
    db.delete(receipt)
    db.commit()


def consume_programmatic_outbound(
    db: Session,
    *,
    robot_wxid: str,
    to_wxid: str,
    msg_type: int,
    content: str = "",
) -> bool:
    now = utcnow()
    content_hash = _outbound_content_hash(content)
    criteria = [
        WechatRobotOutboundReceipt.to_wxid == to_wxid,
        WechatRobotOutboundReceipt.msg_type == msg_type,
        WechatRobotOutboundReceipt.created_at
        >= now - OUTBOUND_RECEIPT_TTL,
        or_(
            WechatRobotOutboundReceipt.robot_wxid == robot_wxid,
            WechatRobotOutboundReceipt.robot_wxid == "",
        ),
    ]
    if msg_type == 1:
        criteria.append(
            WechatRobotOutboundReceipt.content_hash == content_hash
        )
    receipt = db.scalar(
        select(WechatRobotOutboundReceipt)
        .where(*criteria)
        .order_by(WechatRobotOutboundReceipt.created_at)
    )
    if not receipt:
        db.commit()
        return False
    db.delete(receipt)
    db.commit()
    return True


def send_programmatic_text(
    db: Session,
    *,
    client: WechatRobotClient,
    robot_wxid: str,
    to_wxid: str,
    content: str,
    at: Iterable[str] = (),
) -> None:
    at_values = tuple(at)
    receipt = register_programmatic_outbound(
        db,
        robot_wxid=robot_wxid,
        to_wxid=to_wxid,
        msg_type=1,
        content=content,
    )
    try:
        if at_values:
            client.send_text(
                to_wxid=to_wxid,
                content=content,
                at=at_values,
            )
        else:
            client.send_text(to_wxid=to_wxid, content=content)
    except Exception:
        cancel_programmatic_outbound(db, receipt)
        raise


def send_programmatic_image_urls(
    db: Session,
    *,
    client: WechatRobotClient,
    robot_wxid: str,
    to_wxid: str,
    image_urls: Iterable[str],
) -> None:
    urls = tuple(image_urls)
    receipts = [
        register_programmatic_outbound(
            db,
            robot_wxid=robot_wxid,
            to_wxid=to_wxid,
            msg_type=3,
        )
        for _ in urls
    ]
    try:
        client.send_image_urls(to_wxid=to_wxid, image_urls=urls)
    except Exception:
        for receipt in receipts:
            cancel_programmatic_outbound(db, receipt)
        raise


def _outbound_content_hash(content: str) -> str:
    normalized = content.strip()
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def is_wechat_robot_handoff_active(
    binding: WechatRobotUserBinding,
    *,
    now: datetime | None = None,
) -> bool:
    if not binding.handoff_started_at or binding.handoff_resolved_at:
        return False
    settings = get_settings()
    auto_resume_hours = max(
        0.0,
        settings.wechat_robot_handoff_auto_resume_hours,
    )
    if not auto_resume_hours:
        return True
    current = now or utcnow()
    started_at = binding.handoff_started_at
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    if current >= started_at + timedelta(hours=auto_resume_hours):
        binding.handoff_resolved_at = current
        binding.handoff_updated_at = current
        return False
    return True


def start_wechat_robot_handoff(
    binding: WechatRobotUserBinding,
    *,
    reason: str,
) -> None:
    now = utcnow()
    binding.handoff_started_at = now
    binding.handoff_updated_at = now
    binding.handoff_resolved_at = None
    binding.handoff_reason = reason.strip()
    binding.handoff_last_message = reason.strip()


def resume_wechat_robot_handoff(
    binding: WechatRobotUserBinding,
) -> None:
    now = utcnow()
    binding.handoff_resolved_at = now
    binding.handoff_updated_at = now


def notify_wechat_robot_handoff(
    db: Session,
    *,
    client: WechatRobotClient,
    robot_wxid: str,
    binding: WechatRobotUserBinding,
) -> bool:
    notifier = db.get(WechatRobotHandoffNotifier, HANDOFF_NOTIFIER_ID)
    recipient_wxid = (
        notifier.recipient_wxid.strip()
        if notifier
        else ""
    )
    if (
        not recipient_wxid
        or recipient_wxid == binding.peer_wxid.strip()
    ):
        return False

    customer = binding.peer_wxid.strip() or "未知用户"
    source = (
        f"群聊 {binding.room_wxid}"
        if binding.room_wxid
        else "微信私聊"
    )
    reason = (
        binding.handoff_reason.strip()
        or binding.handoff_last_message.strip()
        or "用户请求人工客服"
    )
    content = (
        "【人工接管通知】\n"
        f"客户：{customer}\n"
        f"来源：{source}\n"
        f"消息：{reason[:1000]}\n"
        "机器人已暂停该客户的自动回复，请尽快登录机器人微信接管，"
        "请勿直接回复本通知。"
    )
    send_programmatic_text(
        db,
        client=client,
        robot_wxid=robot_wxid,
        to_wxid=recipient_wxid,
        content=content,
    )
    return True


def _matched_wechat_image_urls(
    db: Session,
    result: dict[str, Any],
) -> tuple[str, ...]:
    matched_facts = result.get("matched_facts", [])
    if not isinstance(matched_facts, list) or not matched_facts:
        return ()

    settings = get_settings()
    media_base_url = settings.wechat_robot_media_base_url.strip().rstrip("/")
    image_urls: list[str] = []
    seen: set[str] = set()
    for fact in matched_facts:
        if not isinstance(fact, dict):
            continue
        fact_id = str(fact.get("id") or "").strip()
        entry = db.get(FAQEntry, fact_id) if fact_id else None
        image_url = (
            str(entry.image_url or "").strip()
            if entry
            else str(fact.get("image_url") or "").strip()
        )
        if entry and entry.image_data:
            if not media_base_url:
                logger.warning(
                    "Cannot send uploaded FAQ image %s because "
                    "WECHAT_ROBOT_MEDIA_BASE_URL is empty",
                    fact_id,
                )
                continue
            image_url = f"{media_base_url}/faqs/{fact_id}/image"
        elif not image_url:
            image_url = str(fact.get("image_url") or "").strip()
        if not image_url or image_url in seen:
            continue
        seen.add(image_url)
        image_urls.append(image_url)
    return tuple(image_urls)


def parse_wechat_robot_messages(
    payload: dict[str, Any],
) -> list[IncomingWechatMessage]:
    sync_data = payload.get("Data") if isinstance(payload.get("Data"), dict) else payload
    raw_messages = sync_data.get("AddMsgs") or sync_data.get("AddMsgList") or []
    if not isinstance(raw_messages, list):
        return []

    messages = []
    for raw in raw_messages:
        if not isinstance(raw, dict):
            continue
        from_wxid = _string_value(raw.get("FromUserName"))
        content = _string_value(raw.get("Content")).strip()
        room_wxid = from_wxid if from_wxid.endswith(CHAT_ROOM_SUFFIX) else ""
        sender_wxid = from_wxid
        if room_wxid:
            sender_wxid, content = _parse_group_content(content)
        messages.append(
            IncomingWechatMessage(
                msg_id=str(raw.get("NewMsgId") or raw.get("MsgId") or ""),
                msg_type=_integer_value(raw.get("MsgType")),
                from_wxid=from_wxid,
                to_wxid=_string_value(raw.get("ToUserName")),
                content=content,
                msg_source=str(raw.get("MsgSource") or ""),
                room_wxid=room_wxid,
                sender_wxid=sender_wxid,
            )
        )
    return messages


def get_or_create_wechat_robot_conversation(
    db: Session,
    *,
    robot_wxid: str,
    message: IncomingWechatMessage,
) -> tuple[WechatRobotUserBinding, User, ChatSession]:
    binding = db.scalar(
        select(WechatRobotUserBinding).where(
            WechatRobotUserBinding.robot_wxid == robot_wxid,
            WechatRobotUserBinding.conversation_key == message.conversation_key,
        )
    )
    if binding:
        user = db.get(User, binding.user_id)
        if not user:
            raise RuntimeError("WeChat robot binding refers to a missing user")
        session = (
            db.get(ChatSession, binding.active_session_id)
            if binding.active_session_id
            else None
        )
        if session and session.user_id == user.id:
            return binding, user, session
        session = ChatSession(user_id=user.id)
        db.add(session)
        db.flush()
        binding.active_session_id = session.id
        return binding, user, session

    identity = f"{robot_wxid}:{message.conversation_key}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    username = f"wechat-robot:{digest[:48]}"
    user = db.scalar(select(User).where(User.username == username))
    if not user:
        user = User(
            username=username,
            password_hash=hash_password(digest),
            role=Role.student,
        )
        db.add(user)
        db.flush()
    session = ChatSession(user_id=user.id)
    db.add(session)
    db.flush()
    binding = WechatRobotUserBinding(
        user_id=user.id,
        robot_wxid=robot_wxid,
        conversation_key=message.conversation_key,
        peer_wxid=message.sender_wxid,
        room_wxid=message.room_wxid,
        active_session_id=session.id,
    )
    db.add(binding)
    db.flush()
    return binding, user, session


def mark_message_if_new(
    db: Session,
    *,
    robot_wxid: str,
    message: IncomingWechatMessage,
) -> bool:
    if not message.msg_id:
        return True
    receipt_key = f"{robot_wxid}:{message.msg_id}"
    db.add(
        WechatRobotMessageReceipt(
            receipt_key=receipt_key,
            msg_id=message.msg_id,
            robot_wxid=robot_wxid,
            from_wxid=message.from_wxid,
        )
    )
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        return False
    return True


def _should_auto_reply(
    message: IncomingWechatMessage,
    *,
    robot_wxid: str,
) -> bool:
    settings = get_settings()
    if not settings.wechat_robot_auto_reply_enabled:
        return False
    if message.msg_type != 1 or not message.content:
        return False
    if not message.is_chat_room:
        return True
    mode = settings.wechat_robot_group_reply_mode.strip().lower()
    if mode not in SUPPORTED_GROUP_REPLY_MODES:
        logger.warning(
            "Unknown WECHAT_ROBOT_GROUP_REPLY_MODE=%s; using mention",
            mode,
        )
        mode = "mention"
    if mode == "off":
        return False
    if mode == "all":
        return True
    return robot_wxid != "default" and _is_mentioned(
        message.msg_source,
        robot_wxid,
    )


def _send_greeting_if_needed(
    *,
    db: Session,
    binding: WechatRobotUserBinding,
    robot_wxid: str,
    target_wxid: str,
    client: WechatRobotClient,
) -> bool:
    settings = get_settings()
    greeting = settings.wechat_robot_greeting_text.strip()
    if (
        not settings.wechat_robot_greeting_enabled
        or binding.greeted_at is not None
        or not greeting
        or not target_wxid
    ):
        return False
    send_programmatic_text(
        db,
        client=client,
        robot_wxid=robot_wxid,
        to_wxid=target_wxid,
        content=greeting,
    )
    binding.greeted_at = utcnow()
    return True


def _should_greet_new_friend(message: IncomingWechatMessage) -> bool:
    if message.is_chat_room:
        return False
    if message.msg_type == 1:
        return NEW_FRIEND_MARKERS[0] in message.content
    if message.msg_type == 10000:
        return any(marker in message.content for marker in NEW_FRIEND_MARKERS[1:])
    return False


def _parse_group_content(content: str) -> tuple[str, str]:
    sender, separator, body = content.partition(":")
    normalized_sender = sender.strip()
    if (
        separator
        and normalized_sender
        and not re.search(r"\s", normalized_sender)
        and len(normalized_sender) <= 128
    ):
        return normalized_sender, body.lstrip()
    return "", content


def _is_mentioned(msg_source: str, robot_wxid: str) -> bool:
    match = re.search(
        r"<atuserlist>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</atuserlist>",
        msg_source,
        flags=re.DOTALL,
    )
    if not match:
        return False
    return robot_wxid in {
        item.strip()
        for item in match.group(1).split(",")
        if item.strip()
    }


def _string_value(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("String") or value.get("string") or "")
    return ""


def _integer_value(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
