from __future__ import annotations

import hmac
import json
import logging
from typing import Any, Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, defer
from pydantic import BaseModel, Field

from app.api.deps import get_wechat_operator as get_current_user
from app.core.config import get_settings
from app.core.database import SessionLocal, get_db
from app.core.permissions import require_role
from app.models.entities import (
    Role,
    User,
    WechatRobotBroadcast,
    WechatRobotHandoffNotifier,
    WechatRobotUserBinding,
    utcnow,
)
from app.wechat_robot.broadcast import run_wechat_robot_broadcast
from app.wechat_robot.client import WechatRobotClient, WechatRobotClientError
from app.wechat_robot.service import (
    is_wechat_robot_handoff_active,
    process_wechat_robot_payload,
    resume_wechat_robot_handoff,
    send_programmatic_text,
)


router = APIRouter(prefix="/wechat-robot", tags=["wechat-robot"])
logger = logging.getLogger(__name__)
HANDOFF_NOTIFIER_ID = "default"


class WechatRobotMassSendRequest(BaseModel):
    recipients: list[str] = Field(min_length=1)
    content: str = Field(min_length=1, max_length=2000)


class WechatRobotHandoffNotifierRequest(BaseModel):
    wechat_id: str = Field(default="", max_length=128)


@router.get("/friends")
def get_wechat_robot_friend_summary(
    refresh: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    client = WechatRobotClient()
    try:
        if refresh:
            client.sync_contacts()
        friends = client.list_friends()
    except WechatRobotClientError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc
    return {
        "count": len(friends),
        "friends": [
            {
                "wechat_id": item.get("wechat_id"),
                "name": item.get("remark") or item.get("nickname") or "",
            }
            for item in friends
        ],
    }


@router.get("/handoff-notifier")
def get_wechat_robot_handoff_notifier(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    notifier = db.get(WechatRobotHandoffNotifier, HANDOFF_NOTIFIER_ID)
    return _handoff_notifier_response(notifier)


@router.put("/handoff-notifier")
def save_wechat_robot_handoff_notifier(
    payload: WechatRobotHandoffNotifierRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    recipient_wxid = payload.wechat_id.strip()
    recipient_name = ""
    if recipient_wxid:
        try:
            friends = WechatRobotClient().list_friends()
        except WechatRobotClientError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=str(exc),
            ) from exc
        friend = next(
            (
                item
                for item in friends
                if str(item.get("wechat_id") or "").strip()
                == recipient_wxid
            ),
            None,
        )
        if not friend:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Selected handoff notifier is not a current friend",
            )
        recipient_name = str(
            friend.get("remark")
            or friend.get("nickname")
            or ""
        ).strip()

    notifier = db.get(WechatRobotHandoffNotifier, HANDOFF_NOTIFIER_ID)
    if not notifier:
        notifier = WechatRobotHandoffNotifier(
            id=HANDOFF_NOTIFIER_ID,
        )
        db.add(notifier)
    notifier.recipient_wxid = recipient_wxid
    notifier.recipient_name = recipient_name
    notifier.updated_at = utcnow()
    db.commit()
    db.refresh(notifier)
    return _handoff_notifier_response(notifier)


@router.get("/handoffs")
def list_wechat_robot_handoffs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    bindings = db.scalars(
        select(WechatRobotUserBinding)
        .where(
            WechatRobotUserBinding.handoff_started_at.is_not(None),
            WechatRobotUserBinding.handoff_resolved_at.is_(None),
        )
        .order_by(WechatRobotUserBinding.handoff_updated_at.desc())
    ).all()
    active = [
        binding
        for binding in bindings
        if is_wechat_robot_handoff_active(binding)
    ]
    if len(active) != len(bindings):
        db.commit()

    names: dict[str, str] = {}
    try:
        names = {
            str(item.get("wechat_id") or ""): str(
                item.get("remark") or item.get("nickname") or ""
            )
            for item in WechatRobotClient().list_friends()
            if isinstance(item, dict)
        }
    except WechatRobotClientError:
        logger.exception("Failed to load friend names for handoff queue")

    return {
        "count": len(active),
        "items": [
            {
                "id": binding.id,
                "peer_wxid": binding.peer_wxid,
                "name": names.get(binding.peer_wxid, ""),
                "room_wxid": binding.room_wxid,
                "reason": binding.handoff_reason,
                "last_message": binding.handoff_last_message,
                "started_at": binding.handoff_started_at,
                "updated_at": binding.handoff_updated_at,
            }
            for binding in active
        ],
    }


@router.post("/handoffs/{binding_id}/resume")
def resume_wechat_robot_handoff_session(
    binding_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    binding = db.get(WechatRobotUserBinding, binding_id)
    if not binding:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Handoff session not found",
        )
    resume_wechat_robot_handoff(binding)
    db.commit()
    return {"success": True, "id": binding.id}


@router.post("/broadcasts", status_code=status.HTTP_202_ACCEPTED)
def create_wechat_robot_broadcast(
    background_tasks: BackgroundTasks,
    content: str = Form(default=""),
    confirm_send: bool = Form(...),
    recipients: str = Form(...),
    client_request_id: Annotated[str | None, Form(min_length=1, max_length=64)] = None,
    image: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    if not confirm_send:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Please confirm sending to the selected friends",
        )
    try:
        raw_recipients = json.loads(recipients)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Recipients must be a JSON array",
        ) from exc
    if not isinstance(raw_recipients, list):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Recipients must be a JSON array",
        )
    recipient_ids = list(
        dict.fromkeys(
            str(item).strip()
            for item in raw_recipients
            if str(item).strip()
        )
    )
    limit = max(1, get_settings().wechat_robot_broadcast_max_recipients)
    if not recipient_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Select at least one friend",
        )
    if len(recipient_ids) > limit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Recipient count exceeds configured limit of {limit}",
        )
    content = content.strip()
    if len(content) > 2000:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Message content cannot exceed 2000 characters",
        )
    image_data = b""
    image_filename = ""
    content_type = ""
    if image:
        content_type = (image.content_type or "").lower()
        if not content_type.startswith("image/"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only image files are supported",
            )
        image_data = image.file.read(10 * 1024 * 1024 + 1)
        if not image_data or len(image_data) > 10 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Image must be between 1 byte and 10 MB",
            )
        image_filename = (image.filename or "broadcast-image")[:255]
    if not content and not image_data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Provide message content, an image, or both",
        )
    broadcast = WechatRobotBroadcast(
        client_request_id=client_request_id,
        created_by_id=current_user.id,
        content=content,
        recipient_ids=recipient_ids,
        image_data=image_data,
        image_filename=image_filename,
        image_content_type=content_type,
    )
    db.add(broadcast)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalar(select(WechatRobotBroadcast).where(WechatRobotBroadcast.client_request_id == client_request_id)) if client_request_id else None
        if existing is None:
            raise
        if (existing.created_by_id != current_user.id or existing.content != content
                or existing.recipient_ids != recipient_ids or existing.image_data != image_data):
            raise HTTPException(status_code=409, detail="Request ID already used for different content")
        return _broadcast_payload(existing)
    db.refresh(broadcast)
    background_tasks.add_task(run_wechat_robot_broadcast, broadcast.id)
    return _broadcast_payload(broadcast)


@router.get("/broadcasts")
def list_wechat_robot_broadcasts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    # Polling history should not load up to 30 full image blobs into memory.
    records = db.execute(select(WechatRobotBroadcast, func.length(WechatRobotBroadcast.image_data))
                         .options(defer(WechatRobotBroadcast.image_data))
                         .order_by(WechatRobotBroadcast.created_at.desc()).limit(30)).all()
    return {"items": [_broadcast_payload(record, has_image=bool(size)) for record, size in records]}


@router.get("/broadcasts/{broadcast_id}")
def get_wechat_robot_broadcast(
    broadcast_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    broadcast = db.get(WechatRobotBroadcast, broadcast_id)
    if not broadcast:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Broadcast not found",
        )
    return _broadcast_payload(broadcast)


@router.get("/broadcasts/{broadcast_id}/image")
def get_wechat_robot_broadcast_image(
    broadcast_id: str,
    db: Session = Depends(get_db),
) -> Response:
    broadcast = db.get(WechatRobotBroadcast, broadcast_id)
    if not broadcast or not broadcast.image_data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Broadcast image not found",
        )
    return Response(
        content=broadcast.image_data,
        media_type=broadcast.image_content_type,
    )


@router.post("/callback")
def receive_wechat_robot_callback(
    payload: dict[str, Any],
    background_tasks: BackgroundTasks,
    robot_wxid: str = Query(default=""),
    webhook_token: str | None = Header(default=None, alias="X-Webhook-Token"),
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    _verify_webhook(webhook_token or authorization or "")
    background_tasks.add_task(
        _process_payload_in_background,
        payload,
        robot_wxid,
    )
    return {"success": True, "accepted": True}


@router.post("/mass-send")
def mass_send_wechat_robot_text(
    payload: WechatRobotMassSendRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, object]:
    require_role(current_user, {Role.admin})
    recipients = list(
        dict.fromkeys(item.strip() for item in payload.recipients if item.strip())
    )
    settings = get_settings()
    limit = max(1, settings.wechat_robot_mass_send_max_recipients)
    if not recipients:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one non-empty recipient is required",
        )
    if len(recipients) > limit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Recipient count exceeds configured limit of {limit}",
        )
    content = payload.content.strip()
    if not content:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Message content cannot be blank",
        )
    client = WechatRobotClient()
    failed: list[str] = []
    for recipient in recipients:
        try:
            send_programmatic_text(
                db,
                client=client,
                robot_wxid="",
                to_wxid=recipient,
                content=content,
            )
        except WechatRobotClientError:
            failed.append(recipient)
    if failed:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to send to {len(failed)} recipients",
        )
    return {
        "success": True,
        "recipient_count": len(recipients),
    }


def _process_payload_in_background(
    payload: dict[str, Any],
    robot_wxid: str,
) -> None:
    with SessionLocal() as db:
        result = process_wechat_robot_payload(
            db,
            payload=payload,
            robot_wxid=robot_wxid,
        )
        if result["failed"]:
            logger.warning("WeChat robot callback result: %s", result)


def _verify_webhook(provided: str) -> None:
    expected = get_settings().wechat_robot_webhook_secret.strip()
    if not expected:
        return
    candidate = provided.strip()
    if candidate.lower().startswith("bearer "):
        candidate = candidate[7:].strip()
    if not hmac.compare_digest(candidate, expected):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid WeChat robot webhook token",
        )


def _broadcast_payload(
    broadcast: WechatRobotBroadcast,
    *, has_image: bool | None = None,
) -> dict[str, object]:
    return {
        "id": broadcast.id,
        "client_request_id": broadcast.client_request_id,
        "content": broadcast.content,
        "status": broadcast.status,
        "has_image": bool(broadcast.image_data) if has_image is None else has_image,
        "selected_recipient_count": len(broadcast.recipient_ids or []),
        "recipient_count": broadcast.recipient_count,
        "text_sent_count": broadcast.text_sent_count,
        "image_sent_count": broadcast.image_sent_count,
        "success_count": broadcast.success_count,
        "failed_count": broadcast.failed_count,
        "errors": broadcast.error_details,
        "created_at": broadcast.created_at,
        "started_at": broadcast.started_at,
        "completed_at": broadcast.completed_at,
    }


def _handoff_notifier_response(
    notifier: WechatRobotHandoffNotifier | None,
) -> dict[str, object]:
    recipient_wxid = (
        notifier.recipient_wxid.strip()
        if notifier
        else ""
    )
    return {
        "enabled": bool(recipient_wxid),
        "wechat_id": recipient_wxid,
        "name": notifier.recipient_name if notifier else "",
        "updated_at": notifier.updated_at if notifier else None,
    }
