from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.agent.service import AgentService
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.entities import FAQEntry
from app.wecom.client import WeComClient, WeComClientError
from app.wecom.service import (
    forget_message,
    get_or_create_wecom_conversation,
    mark_message_if_new,
)


logger = logging.getLogger(__name__)
_poller_status: dict[str, Any] = {
    "configured": False,
    "running": False,
    "mode": "",
    "last_callback_at": "",
    "last_callback_has_open_kfid": False,
    "last_service_state": None,
    "last_handoff_at": "",
    "last_handoff_state": None,
    "last_handoff_servicer_userid": "",
    "human_state_suppressed_count": 0,
    "last_poll_at": "",
    "last_error": "",
    "last_replied_count": 0,
    "total_replied": 0,
}


def customer_service_poller_status() -> dict[str, Any]:
    return dict(_poller_status)


def record_customer_service_callback_received(*, has_open_kfid: bool) -> None:
    _poller_status["configured"] = True
    _poller_status["running"] = False
    _poller_status["mode"] = "callback"
    _poller_status["last_callback_at"] = datetime.now(UTC).isoformat()
    _poller_status["last_callback_has_open_kfid"] = has_open_kfid


def record_customer_service_callback_error(error: str) -> None:
    _poller_status["last_error"] = error[:500]


def record_customer_service_state(service_state: int) -> None:
    _poller_status["last_service_state"] = service_state


def record_customer_service_handoff(
    *,
    service_state: int,
    servicer_userid: str,
) -> None:
    _poller_status["last_service_state"] = service_state
    _poller_status["last_handoff_at"] = datetime.now(UTC).isoformat()
    _poller_status["last_handoff_state"] = service_state
    _poller_status["last_handoff_servicer_userid"] = servicer_userid


def record_human_state_suppressed() -> None:
    _poller_status["human_state_suppressed_count"] += 1


def record_customer_service_callback(*, replied_count: int) -> None:
    _poller_status["configured"] = True
    _poller_status["running"] = False
    _poller_status["mode"] = "callback"
    _poller_status["last_poll_at"] = datetime.now(UTC).isoformat()
    _poller_status["last_error"] = ""
    _poller_status["last_replied_count"] = replied_count
    _poller_status["total_replied"] += replied_count


async def run_customer_service_poller() -> None:
    settings = get_settings()
    callback_configured = bool(
        settings.wecom_corp_id
        and (settings.wecom_kf_token or settings.wecom_token)
        and (settings.wecom_kf_encoding_aes_key or settings.wecom_encoding_aes_key)
    )
    if callback_configured:
        _poller_status["configured"] = True
        _poller_status["running"] = False
        _poller_status["mode"] = "callback"
        _poller_status["last_error"] = ""
        logger.info("WeCom customer service is using callback mode")
        return

    _poller_status["configured"] = bool(
        settings.wecom_kf_poll_enabled
        and settings.wecom_corp_id
        and settings.wecom_secret
        and settings.wecom_kf_open_kfid
    )
    _poller_status["mode"] = "poller"
    if not settings.wecom_kf_poll_enabled:
        return
    if not settings.wecom_corp_id or not settings.wecom_secret or not settings.wecom_kf_open_kfid:
        logger.info("WeCom customer service polling is disabled because credentials are incomplete")
        return

    client = WeComClient()
    cursor = ""
    interval = max(1.0, settings.wecom_kf_poll_interval_seconds)
    _poller_status["running"] = True
    logger.info("WeCom customer service polling started")
    try:
        while True:
            try:
                cursor, replied_count = await asyncio.to_thread(
                    _poll_customer_service_and_commit,
                    client,
                    cursor,
                    settings.wecom_kf_open_kfid,
                )
                _poller_status["last_poll_at"] = datetime.now(UTC).isoformat()
                _poller_status["last_error"] = ""
                _poller_status["last_replied_count"] = replied_count
                _poller_status["total_replied"] += replied_count
                if replied_count:
                    logger.info("Replied to %s WeCom customer service message(s)", replied_count)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                _poller_status["last_error"] = str(exc)[:500]
                logger.exception("WeCom customer service polling failed")
            await asyncio.sleep(interval)
    finally:
        _poller_status["running"] = False


def _poll_customer_service_and_commit(client: WeComClient, cursor: str, open_kfid: str) -> tuple[str, int]:
    with SessionLocal() as db:
        next_cursor, replied_count = poll_customer_service_once(
            db,
            client=client,
            cursor=cursor,
            open_kfid=open_kfid,
        )
        db.commit()
        return next_cursor, replied_count


def poll_customer_service_once(
    db: Session,
    *,
    client: WeComClient | None = None,
    cursor: str = "",
    token: str = "",
    limit: int = 100,
    open_kfid: str = "",
) -> tuple[str, int]:
    client = client or WeComClient()
    payload = client.sync_customer_service_messages(cursor=cursor, token=token, limit=limit, open_kfid=open_kfid)
    replied_count = handle_customer_service_payload(db, client=client, payload=payload)
    return str(payload.get("next_cursor") or cursor), replied_count


def handle_customer_service_payload(db: Session, *, client: WeComClient, payload: dict) -> int:
    replied_count = 0
    for message in payload.get("msg_list", []):
        if _handle_customer_service_message(db, client=client, message=message):
            replied_count += 1
    return replied_count


def _handle_customer_service_message(db: Session, *, client: WeComClient, message: dict) -> bool:
    if message.get("msgtype") != "text":
        return False
    if message.get("origin") != 3:
        return False

    msg_id = str(message.get("msgid") or message.get("msg_id") or "")
    external_userid = str(message.get("external_userid") or "")
    open_kfid = str(message.get("open_kfid") or "")
    content = str((message.get("text") or {}).get("content") or "").strip()
    if not external_userid or not open_kfid or not content:
        return False
    if not mark_message_if_new(db, msg_id=msg_id, from_user=external_userid):
        return False

    try:
        service_state = client.ensure_customer_service_session_ready(
            open_kfid=open_kfid,
            external_userid=external_userid,
        )
        record_customer_service_state(service_state)
        if service_state in {2, 3, 4}:
            record_human_state_suppressed()
            return False
        if service_state != 1:
            raise WeComClientError(
                f"WeCom customer service session state {service_state} is not available for the bot"
            )

        result = _answer_text(
            db,
            user_key=f"kf:{open_kfid}:{external_userid}",
            content=content,
        )
        client.send_customer_service_text(
            open_kfid=open_kfid,
            external_userid=external_userid,
            content=result.answer,
        )
        for image in result.images:
            try:
                if image.image_data:
                    media_id = client.upload_customer_service_image_bytes(
                        image_data=image.image_data,
                        content_type=image.content_type,
                        filename=image.filename,
                    )
                else:
                    media_id = client.upload_customer_service_image(
                        image_url=image.image_url,
                    )
                client.send_customer_service_image(
                    open_kfid=open_kfid,
                    external_userid=external_userid,
                    media_id=media_id,
                )
            except Exception:
                logger.exception(
                    "Failed to send customer service image: %s",
                    image.image_url or image.filename,
                )
        if result.decision == "HANDOFF":
            handoff_state, servicer_userid = client.handoff_customer_service_session(
                open_kfid=open_kfid,
                external_userid=external_userid,
            )
            record_customer_service_handoff(
                service_state=handoff_state,
                servicer_userid=servicer_userid,
            )
    except Exception:
        forget_message(db, msg_id=msg_id)
        raise
    return True


@dataclass(frozen=True)
class CustomerServiceImage:
    image_url: str = ""
    image_data: bytes | None = None
    content_type: str = "image/png"
    filename: str = "customer-service-image"


@dataclass(frozen=True)
class CustomerServiceAgentResult:
    answer: str
    decision: str
    images: tuple[CustomerServiceImage, ...] = ()


def _answer_text(
    db: Session,
    *,
    user_key: str,
    content: str,
) -> CustomerServiceAgentResult:
    user, session = get_or_create_wecom_conversation(
        db,
        wecom_user_id=user_key,
    )
    try:
        result = AgentService().answer(
            db,
            user=user,
            message=content,
            session_id=session.id,
        )
    except Exception:
        logger.exception("Failed to generate WeCom customer service answer")
        return CustomerServiceAgentResult(
            answer="客服助手暂时没有成功处理这个问题，请稍后再试或联系人工客服。",
            decision="ACCEPT",
        )
    return CustomerServiceAgentResult(
        answer=result.get("answer") or "暂时没有生成回答，请换个问法再试。",
        decision=str(result.get("decision") or "ACCEPT"),
        images=_matched_customer_service_images(db, result),
    )


def _matched_customer_service_images(
    db: Session,
    result: dict[str, Any],
) -> tuple[CustomerServiceImage, ...]:
    matched_facts = result.get("matched_facts", [])
    if not isinstance(matched_facts, list):
        return ()

    images: list[CustomerServiceImage] = []
    seen: set[str] = set()
    for fact in matched_facts:
        if not isinstance(fact, dict):
            continue
        fact_id = str(fact.get("id") or "")
        entry = db.get(FAQEntry, fact_id) if fact_id else None
        image_data = entry.image_data if entry else None
        image_url = (entry.image_url if entry else "") or str(
            fact.get("image_url") or ""
        ).strip()
        if not image_data and not image_url:
            continue
        key = (
            f"data:{hash(image_data)}"
            if image_data
            else f"url:{image_url}"
        )
        if key in seen:
            continue
        seen.add(key)
        images.append(
            CustomerServiceImage(
                image_url=image_url,
                image_data=image_data,
                content_type=(
                    entry.image_content_type
                    if entry and entry.image_content_type
                    else "image/png"
                ),
                filename=(
                    entry.image_filename
                    if entry and entry.image_filename
                    else "customer-service-image"
                ),
            )
        )
    return tuple(images)
