from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect

from app.agent.service import AgentService
from app.core.config import get_settings
from app.core.database import get_db
from app.wecom.client import WeComClient, WeComClientError
from app.wecom.crypto import WeComCrypto, WeComCryptoError, parse_xml, text_reply_xml
from app.wecom.customer_service import (
    handle_customer_service_payload,
    record_customer_service_callback,
    record_customer_service_callback_error,
    record_customer_service_callback_received,
)
from app.wecom.service import get_or_create_wecom_user, mark_message_if_new


router = APIRouter(prefix="/wecom", tags=["wecom"])
logger = logging.getLogger(__name__)


@router.get("/callback", response_class=Response)
def verify_callback(
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    echostr: str = Query(...),
) -> Response:
    return _verify_url(_crypto(), msg_signature=msg_signature, timestamp=timestamp, nonce=nonce, echostr=echostr)


@router.post("/callback", response_class=Response)
async def receive_callback(
    request: Request,
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    db: Session = Depends(get_db),
) -> Response:
    message = await _decrypt_request(request, _crypto(), msg_signature=msg_signature, timestamp=timestamp, nonce=nonce)
    if message is None:
        return _success()

    if not mark_message_if_new(db, msg_id=message.get("MsgId", ""), from_user=message.get("FromUserName", "")):
        return _success()

    reply_text = _answer_text_message(db, user_key=message.get("FromUserName", ""), content=message.get("Content", ""))
    to_user = message.get("FromUserName", "")
    if to_user:
        try:
            WeComClient().send_text(to_user=to_user, content=reply_text)
        except WeComClientError as exc:
            logger.warning("Failed to send WeCom active reply: %s", exc)
            reply = text_reply_xml(
                to_user=message.get("FromUserName", ""),
                from_user=message.get("ToUserName", ""),
                content=reply_text,
            )
            db.commit()
            return Response(
                content=_crypto().encrypted_reply(message_xml=reply, nonce=nonce),
                media_type="application/xml",
            )
    db.commit()
    return _success()


@router.get("/kf/callback", response_class=Response)
def verify_kf_callback(
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    echostr: str = Query(...),
) -> Response:
    return _verify_url(_kf_crypto(), msg_signature=msg_signature, timestamp=timestamp, nonce=nonce, echostr=echostr)


@router.post("/kf/callback", response_class=Response)
async def receive_kf_callback(
    request: Request,
    msg_signature: str = Query(...),
    timestamp: str = Query(...),
    nonce: str = Query(...),
    db: Session = Depends(get_db),
) -> Response:
    event = await _decrypt_request(request, _kf_crypto(), msg_signature=msg_signature, timestamp=timestamp, nonce=nonce)
    if event is None:
        return _success()

    open_kfid = event.get("OpenKfId", "")
    record_customer_service_callback_received(has_open_kfid=bool(open_kfid))
    if not open_kfid:
        error = "WeCom customer service callback did not include OpenKfId"
        record_customer_service_callback_error(error)
        logger.warning(error)
        return _success()

    client = WeComClient()
    try:
        payload = client.sync_customer_service_messages(
            token=event.get("Token", ""),
            open_kfid=open_kfid,
        )
        replied_count = handle_customer_service_payload(db, client=client, payload=payload)
        record_customer_service_callback(replied_count=replied_count)
    except WeComClientError as exc:
        record_customer_service_callback_error(str(exc))
        logger.warning("Failed to handle WeCom customer service callback: %s", exc)
    db.commit()
    return _success()


def _answer_text_message(db: Session, *, user_key: str, content: str) -> str:
    content = content.strip()
    if not content:
        return "请发送你想咨询的课程问题。"
    if not user_key:
        return "暂时无法识别用户，请稍后再试。"

    user = get_or_create_wecom_user(db, wecom_user_id=user_key)
    try:
        result = AgentService().answer(db, user=user, message=content, session_id=None)
    except Exception:
        logger.exception("Failed to generate WeCom answer")
        return "客服助手暂时没有成功处理这个问题，请稍后再试或联系人工客服。"
    return result.get("answer") or "暂时没有生成回答，请换个问法再试。"


async def _decrypt_request(
    request: Request,
    crypto: WeComCrypto,
    *,
    msg_signature: str,
    timestamp: str,
    nonce: str,
) -> dict[str, str] | None:
    try:
        body = (await request.body()).decode("utf-8")
    except ClientDisconnect:
        return None
    try:
        envelope = parse_xml(body)
        encrypted = envelope.get("Encrypt", "")
        crypto.verify_signature(signature=msg_signature, timestamp=timestamp, nonce=nonce, encrypted=encrypted)
        return parse_xml(crypto.decrypt(encrypted))
    except (WeComCryptoError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


def _verify_url(
    crypto: WeComCrypto,
    *,
    msg_signature: str,
    timestamp: str,
    nonce: str,
    echostr: str,
) -> Response:
    try:
        echo = crypto.verify_url(signature=msg_signature, timestamp=timestamp, nonce=nonce, echo=echostr)
    except WeComCryptoError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    return Response(content=echo, media_type="text/plain")


def _crypto() -> WeComCrypto:
    settings = get_settings()
    return _build_crypto(
        token=settings.wecom_token,
        encoding_aes_key=settings.wecom_encoding_aes_key,
        missing_prefix="WeCom",
    )


def _kf_crypto() -> WeComCrypto:
    settings = get_settings()
    return _build_crypto(
        token=settings.wecom_kf_token or settings.wecom_token,
        encoding_aes_key=settings.wecom_kf_encoding_aes_key or settings.wecom_encoding_aes_key,
        missing_prefix="WeCom customer service",
    )


def _build_crypto(*, token: str, encoding_aes_key: str, missing_prefix: str) -> WeComCrypto:
    settings = get_settings()
    missing = [
        name
        for name, value in {
            "WECOM_CORP_ID": settings.wecom_corp_id,
            "TOKEN": token,
            "ENCODING_AES_KEY": encoding_aes_key,
        }.items()
        if not value
    ]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{missing_prefix} is not configured: {', '.join(missing)}",
        )
    return WeComCrypto(token=token, encoding_aes_key=encoding_aes_key, corp_id=settings.wecom_corp_id)


def _success() -> Response:
    return Response(content="success", media_type="text/plain")
