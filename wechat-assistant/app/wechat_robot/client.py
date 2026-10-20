from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import httpx

from app.core.config import get_settings


class WechatRobotClientError(RuntimeError):
    pass


class WechatRobotClient:
    def __init__(self) -> None:
        self.settings = get_settings()

    def send_text(
        self,
        *,
        to_wxid: str,
        content: str,
        at: Iterable[str] = (),
    ) -> None:
        content = content.strip()
        if not to_wxid.strip() or not content:
            raise WechatRobotClientError("Recipient and content are required")
        payload: dict[str, Any] = {
            "to_wxid": to_wxid.strip(),
            "content": content,
        }
        at_list = list(dict.fromkeys(item.strip() for item in at if item.strip()))
        if at_list:
            payload["at"] = at_list
        self._post("/api/v1/robot/message/send/text", payload)

    def mass_send_text(self, *, to_wxids: Iterable[str], content: str) -> None:
        recipients = list(
            dict.fromkeys(item.strip() for item in to_wxids if item.strip())
        )
        if not recipients:
            raise WechatRobotClientError("At least one recipient is required")
        content = content.strip()
        if not content:
            raise WechatRobotClientError("Message content is required")
        self._post(
            "/api/v1/robot/message/send/masssend",
            {
                "to_wxids": recipients,
                "content": content,
            },
        )

    def sync_contacts(self) -> None:
        self._post("/api/v1/robot/contacts/sync", {})

    def list_friends(self, *, page_size: int = 200) -> list[dict[str, Any]]:
        page_size = max(1, min(page_size, 500))
        page_index = 1
        friends: list[dict[str, Any]] = []
        seen: set[str] = set()
        while True:
            data = self._get(
                "/api/v1/robot/contacts",
                params={
                    "type": "friend",
                    "page_index": page_index,
                    "page_size": page_size,
                },
            )
            if not isinstance(data, dict):
                break
            items = data.get("items")
            if not isinstance(items, list):
                break
            for item in items:
                if not isinstance(item, dict) or item.get("type") != "friend":
                    continue
                if item.get("status", 0) not in (0, "0"):
                    continue
                wechat_id = str(item.get("wechat_id") or "").strip()
                if (
                    not wechat_id
                    or wechat_id in seen
                    or wechat_id.endswith("@chatroom")
                    or wechat_id.startswith("gh_")
                ):
                    continue
                seen.add(wechat_id)
                friends.append(item)
            total = int(data.get("total") or 0)
            if not items or len(friends) >= total or len(items) < page_size:
                break
            page_index += 1
        return friends

    def send_image_urls(
        self,
        *,
        to_wxid: str,
        image_urls: Iterable[str],
    ) -> None:
        recipient = to_wxid.strip()
        urls = list(
            dict.fromkeys(item.strip() for item in image_urls if item.strip())
        )
        if not recipient or not urls:
            raise WechatRobotClientError(
                "Recipient and at least one image URL are required"
            )
        self._post(
            "/api/v1/robot/message/send/image/url",
            {
                "to_wxid": recipient,
                "image_urls": urls,
            },
        )

    def _post(self, path: str, payload: dict[str, Any]) -> Any:
        base_url = self.settings.wechat_robot_base_url.strip().rstrip("/")
        if not base_url:
            raise WechatRobotClientError("WECHAT_ROBOT_BASE_URL is not configured")
        headers = {}
        authorization = self.settings.wechat_robot_api_authorization.strip()
        if authorization:
            headers["Authorization"] = authorization
        try:
            response = httpx.post(
                f"{base_url}{path}",
                json=payload,
                headers=headers,
                timeout=self.settings.wechat_robot_request_timeout_seconds,
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise WechatRobotClientError(
                f"WeChat robot API request failed: {exc}"
            ) from exc

        if isinstance(data, dict):
            code = data.get("code")
            if code not in {None, 0, 200}:
                message = data.get("message") or "unknown error"
                raise WechatRobotClientError(
                    f"WeChat robot API error {code}: {message}"
                )
            return data.get("data")
        return data

    def _get(self, path: str, *, params: dict[str, Any]) -> Any:
        base_url = self.settings.wechat_robot_base_url.strip().rstrip("/")
        if not base_url:
            raise WechatRobotClientError("WECHAT_ROBOT_BASE_URL is not configured")
        headers = {}
        authorization = self.settings.wechat_robot_api_authorization.strip()
        if authorization:
            headers["Authorization"] = authorization
        try:
            response = httpx.get(
                f"{base_url}{path}",
                params=params,
                headers=headers,
                timeout=self.settings.wechat_robot_request_timeout_seconds,
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise WechatRobotClientError(
                f"WeChat robot API request failed: {exc}"
            ) from exc

        if isinstance(data, dict):
            code = data.get("code")
            if code not in {None, 0, 200}:
                message = data.get("message") or "unknown error"
                raise WechatRobotClientError(
                    f"WeChat robot API error {code}: {message}"
                )
            return data.get("data")
        return data
