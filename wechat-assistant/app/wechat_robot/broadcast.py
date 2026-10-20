from __future__ import annotations

import logging
import time
from collections.abc import Callable

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.entities import WechatRobotBroadcast, utcnow
from app.wechat_robot.client import WechatRobotClient
from app.wechat_robot.service import (
    send_programmatic_image_urls,
    send_programmatic_text,
)


logger = logging.getLogger(__name__)


def run_wechat_robot_broadcast(broadcast_id: str) -> None:
    with SessionLocal() as db:
        broadcast = db.get(WechatRobotBroadcast, broadcast_id)
        if not broadcast:
            return
        execute_wechat_robot_broadcast(db, broadcast=broadcast)


def execute_wechat_robot_broadcast(
    db: Session,
    *,
    broadcast: WechatRobotBroadcast,
    client: WechatRobotClient | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    client = client or WechatRobotClient()
    settings = get_settings()
    interval = max(0.0, settings.wechat_robot_broadcast_interval_seconds)
    max_recipients = max(1, settings.wechat_robot_broadcast_max_recipients)
    errors: list[str] = []

    broadcast.status = "running"
    broadcast.started_at = utcnow()
    db.commit()

    try:
        client.sync_contacts()
        available_recipients = [
            str(item.get("wechat_id") or "").strip()
            for item in client.list_friends()
            if str(item.get("wechat_id") or "").strip()
        ]
        available = set(available_recipients)
        selected = list(
            dict.fromkeys(
                item.strip()
                for item in (broadcast.recipient_ids or [])
                if item.strip()
            )
        )
        recipients = [item for item in selected if item in available]
        unavailable = [item for item in selected if item not in available]
        if unavailable:
            errors.append(
                f"{len(unavailable)} 位已选联系人不再是当前好友，已跳过"
            )
        broadcast.recipient_count = len(recipients)
        if not recipients:
            raise RuntimeError("没有有效的已选好友可供群发")
        if len(recipients) > max_recipients:
            raise RuntimeError(
                f"好友数量 {len(recipients)} 超过群发上限 {max_recipients}"
            )
        db.commit()

        text_recipients: list[str] = []
        if broadcast.content.strip():
            for index, recipient in enumerate(recipients, start=1):
                try:
                    send_programmatic_text(
                        db,
                        client=client,
                        robot_wxid="",
                        to_wxid=recipient,
                        content=broadcast.content,
                    )
                    text_recipients.append(recipient)
                    broadcast.text_sent_count += 1
                except Exception as exc:
                    errors.append(f"好友 {recipient} 文字发送失败：{exc}")
                if index % 10 == 0:
                    db.commit()
                if interval:
                    sleep(interval)
            db.commit()

        if broadcast.image_data:
            image_url = (
                f"{settings.wechat_robot_media_base_url.strip().rstrip('/')}"
                f"/wechat-robot/broadcasts/{broadcast.id}/image"
            )
            image_recipients = (
                text_recipients
                if broadcast.content.strip()
                else recipients
            )
            for index, recipient in enumerate(image_recipients, start=1):
                try:
                    send_programmatic_image_urls(
                        db,
                        client=client,
                        robot_wxid="",
                        to_wxid=recipient,
                        image_urls=(image_url,),
                    )
                    broadcast.image_sent_count += 1
                except Exception as exc:
                    errors.append(f"好友 {recipient} 图片发送失败：{exc}")
                if index % 10 == 0:
                    db.commit()
                if interval:
                    sleep(interval)

        broadcast.success_count = (
            broadcast.image_sent_count
            if broadcast.image_data
            else broadcast.text_sent_count
        )
        broadcast.failed_count = (
            broadcast.recipient_count - broadcast.success_count
        )
        broadcast.error_details = errors[:50]
        broadcast.status = "completed"
        broadcast.completed_at = utcnow()
        db.commit()
    except Exception as exc:
        logger.exception("Failed to run WeChat robot broadcast %s", broadcast.id)
        broadcast.status = "failed"
        broadcast.failed_count = broadcast.recipient_count
        broadcast.error_details = [str(exc)]
        broadcast.completed_at = utcnow()
        db.commit()
