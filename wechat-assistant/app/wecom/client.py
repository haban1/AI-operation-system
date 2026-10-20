from __future__ import annotations

import hashlib
import time
from typing import Any

import httpx

from app.core.cache import CacheClient
from app.core.config import get_settings


class WeComClientError(RuntimeError):
    pass


class WeComClient:
    def __init__(self, *, cache: CacheClient | None = None) -> None:
        self.settings = get_settings()
        self.cache = cache or CacheClient()
        self._access_token = ""
        self._access_token_expires_at = 0.0

    def send_text(self, *, to_user: str, content: str) -> None:
        if not self.settings.wecom_agent_id:
            raise WeComClientError("WECOM_AGENT_ID is not configured")
        token = self.access_token()
        payload = {
            "touser": to_user,
            "msgtype": "text",
            "agentid": int(self.settings.wecom_agent_id),
            "text": {"content": content},
            "safe": 0,
        }
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}",
            json=payload,
            timeout=10,
        )
        self._raise_for_wecom_error(response.json())

    def sync_customer_service_messages(
        self,
        *,
        cursor: str = "",
        token: str = "",
        limit: int = 1000,
        open_kfid: str | None = None,
    ) -> dict[str, Any]:
        access_token = self.access_token()
        payload = {
            "cursor": cursor,
            "token": token,
            "limit": limit,
        }
        if open_kfid is None:
            open_kfid = self.settings.wecom_kf_open_kfid
        if open_kfid:
            payload["open_kfid"] = open_kfid
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token={access_token}",
            json=payload,
            timeout=10,
        )
        data = response.json()
        self._raise_for_wecom_error(data)
        return data

    def send_customer_service_text(self, *, open_kfid: str, external_userid: str, content: str) -> None:
        access_token = self.access_token()
        payload = {
            "touser": external_userid,
            "open_kfid": open_kfid,
            "msgtype": "text",
            "text": {"content": content},
        }
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token={access_token}",
            json=payload,
            timeout=10,
        )
        self._raise_for_wecom_error(response.json())

    def upload_customer_service_image(self, *, image_url: str) -> str:
        image_url = image_url.strip()
        if not image_url:
            raise WeComClientError("Image URL is empty")
        cache_key = (
            "wecom:kf:image:"
            f"{hashlib.sha256(image_url.encode('utf-8')).hexdigest()}"
        )
        cached = self.cache.get_json(cache_key)
        if isinstance(cached, dict) and cached.get("media_id"):
            return str(cached["media_id"])

        try:
            image_response = httpx.get(
                image_url,
                follow_redirects=True,
                timeout=15,
            )
            image_response.raise_for_status()
        except httpx.HTTPError as exc:
            raise WeComClientError(
                f"Failed to download customer service image: {exc}"
            ) from exc

        content_type = image_response.headers.get(
            "content-type",
            "",
        ).split(";", 1)[0].lower()
        if not content_type.startswith("image/"):
            raise WeComClientError(
                "Customer service image URL did not return an image"
            )
        if len(image_response.content) > 10 * 1024 * 1024:
            raise WeComClientError("Customer service image is larger than 10 MB")

        return self.upload_customer_service_image_bytes(
            image_data=image_response.content,
            content_type=content_type,
            filename="customer-service-image",
        )

    def upload_customer_service_image_bytes(
        self,
        *,
        image_data: bytes,
        content_type: str,
        filename: str = "customer-service-image",
    ) -> str:
        if not image_data:
            raise WeComClientError("Customer service image is empty")
        if not content_type.startswith("image/"):
            raise WeComClientError("Customer service file is not an image")
        if len(image_data) > 10 * 1024 * 1024:
            raise WeComClientError("Customer service image is larger than 10 MB")

        cache_key = (
            "wecom:kf:image:"
            f"{hashlib.sha256(image_data).hexdigest()}"
        )
        cached = self.cache.get_json(cache_key)
        if isinstance(cached, dict) and cached.get("media_id"):
            return str(cached["media_id"])

        access_token = self.access_token()
        response = httpx.post(
            "https://qyapi.weixin.qq.com/cgi-bin/media/upload",
            params={"access_token": access_token, "type": "image"},
            files={
                "media": (
                    filename,
                    image_data,
                    content_type,
                )
            },
            timeout=20,
        )
        data = response.json()
        self._raise_for_wecom_error(data)
        media_id = str(data.get("media_id") or "")
        if not media_id:
            raise WeComClientError("WeCom image upload did not return media_id")
        self.cache.set_json(
            cache_key,
            {"media_id": media_id},
            ttl_seconds=3 * 24 * 60 * 60,
        )
        return media_id

    def send_customer_service_image(
        self,
        *,
        open_kfid: str,
        external_userid: str,
        media_id: str,
    ) -> None:
        access_token = self.access_token()
        payload = {
            "touser": external_userid,
            "open_kfid": open_kfid,
            "msgtype": "image",
            "image": {"media_id": media_id},
        }
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token={access_token}",
            json=payload,
            timeout=10,
        )
        self._raise_for_wecom_error(response.json())

    def get_customer_service_state(self, *, open_kfid: str, external_userid: str) -> int:
        access_token = self.access_token()
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/get?access_token={access_token}",
            json={
                "open_kfid": open_kfid,
                "external_userid": external_userid,
            },
            timeout=10,
        )
        data = response.json()
        self._raise_for_wecom_error(data)
        return int(data.get("service_state", -1))

    def transition_customer_service_state(
        self,
        *,
        open_kfid: str,
        external_userid: str,
        service_state: int,
        servicer_userid: str = "",
    ) -> None:
        access_token = self.access_token()
        payload: dict[str, Any] = {
            "open_kfid": open_kfid,
            "external_userid": external_userid,
            "service_state": service_state,
        }
        if servicer_userid:
            payload["servicer_userid"] = servicer_userid
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/service_state/trans?access_token={access_token}",
            json=payload,
            timeout=10,
        )
        self._raise_for_wecom_error(response.json())

    def ensure_customer_service_session_ready(self, *, open_kfid: str, external_userid: str) -> int:
        service_state = self.get_customer_service_state(
            open_kfid=open_kfid,
            external_userid=external_userid,
        )
        if service_state == 0:
            self.transition_customer_service_state(
                open_kfid=open_kfid,
                external_userid=external_userid,
                service_state=1,
            )
            return 1
        if service_state == 1:
            return service_state
        return service_state

    def handoff_customer_service_session(
        self,
        *,
        open_kfid: str,
        external_userid: str,
    ) -> tuple[int, str]:
        servicer_userid = self.settings.wecom_kf_handoff_servicer_userid.strip()
        target_state = 3 if servicer_userid else 2
        self.transition_customer_service_state(
            open_kfid=open_kfid,
            external_userid=external_userid,
            service_state=target_state,
            servicer_userid=servicer_userid,
        )
        return target_state, servicer_userid

    def list_customer_service_accounts(self) -> list[dict[str, Any]]:
        access_token = self.access_token()
        response = httpx.get(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token={access_token}",
            timeout=10,
        )
        data = response.json()
        self._raise_for_wecom_error(data)
        accounts = data.get("account_list", [])
        return accounts if isinstance(accounts, list) else []

    def list_customer_service_servicers(
        self,
        *,
        open_kfid: str,
    ) -> list[dict[str, Any]]:
        access_token = self.access_token()
        response = httpx.get(
            "https://qyapi.weixin.qq.com/cgi-bin/kf/servicer/list",
            params={
                "access_token": access_token,
                "open_kfid": open_kfid,
            },
            timeout=10,
        )
        data = response.json()
        self._raise_for_wecom_error(data)
        servicers = data.get("servicer_list", [])
        return servicers if isinstance(servicers, list) else []

    def add_customer_service_servicers(
        self,
        *,
        open_kfid: str,
        userids: list[str],
    ) -> None:
        normalized = list(
            dict.fromkeys(userid.strip() for userid in userids if userid.strip())
        )
        if not normalized:
            return
        access_token = self.access_token()
        response = httpx.post(
            f"https://qyapi.weixin.qq.com/cgi-bin/kf/servicer/add?access_token={access_token}",
            json={
                "open_kfid": open_kfid,
                "userid_list": normalized,
            },
            timeout=10,
        )
        self._raise_for_wecom_error(response.json())

    def access_token(self) -> str:
        if self._access_token and self._access_token_expires_at > time.time() + 60:
            return self._access_token

        cache_key = f"wecom:access_token:{self.settings.wecom_corp_id}:{self.settings.wecom_agent_id}"
        cached = self.cache.get_json(cache_key)
        if cached and cached.get("access_token") and cached.get("expires_at", 0) > time.time() + 60:
            self._access_token = str(cached["access_token"])
            self._access_token_expires_at = float(cached["expires_at"])
            return self._access_token

        if not self.settings.wecom_corp_id or not self.settings.wecom_secret:
            raise WeComClientError("WECOM_CORP_ID or WECOM_SECRET is not configured")
        response = httpx.get(
            "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
            params={"corpid": self.settings.wecom_corp_id, "corpsecret": self.settings.wecom_secret},
            timeout=10,
        )
        data = response.json()
        self._raise_for_wecom_error(data)
        token = str(data["access_token"])
        expires_in = int(data.get("expires_in", 7200))
        self._access_token = token
        self._access_token_expires_at = time.time() + expires_in
        self.cache.set_json(
            cache_key,
            {"access_token": token, "expires_at": self._access_token_expires_at},
            ttl_seconds=max(60, expires_in - 60),
        )
        return token

    @staticmethod
    def _raise_for_wecom_error(data: dict[str, Any]) -> None:
        errcode = int(data.get("errcode", 0) or 0)
        if errcode != 0:
            errmsg = data.get("errmsg", "unknown error")
            raise WeComClientError(f"WeCom API error {errcode}: {errmsg}")
