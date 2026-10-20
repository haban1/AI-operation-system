import hashlib
import json
from typing import Any

try:
    from redis import Redis
except Exception:  # pragma: no cover - allows tests without redis installed
    Redis = None  # type: ignore

from app.core.legacy_config import get_legacy_settings


def stable_hash(value: Any) -> str:
    raw = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def build_cache_key(
    *,
    namespace: str,
    user_id: str,
    scope: str = "global",
    permission_version: int,
    model: str,
    prompt_version: str,
    payload: Any,
) -> str:
    digest = stable_hash(payload)
    return ":".join(
        [
            namespace,
            f"user={user_id}",
            f"scope={scope}",
            f"perm={permission_version}",
            f"model={model}",
            f"prompt={prompt_version}",
            digest,
        ]
    )


class CacheClient:
    def __init__(self) -> None:
        settings = get_legacy_settings()
        self._client = Redis.from_url(settings.redis_url, decode_responses=True) if Redis else None

    def get_json(self, key: str) -> Any | None:
        if not self._client:
            return None
        try:
            value = self._client.get(key)
        except Exception:
            return None
        return json.loads(value) if value else None

    def set_json(self, key: str, value: Any, ttl_seconds: int = 300) -> None:
        if not self._client:
            return
        try:
            self._client.setex(key, ttl_seconds, json.dumps(value, ensure_ascii=False, default=str))
        except Exception:
            return
