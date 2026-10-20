from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
import logging

import httpx

logger = logging.getLogger(__name__)

from app.core.config import Settings, get_settings


@dataclass(frozen=True)
class ChatCompletion:
    content: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    reasoning_content: str | None = None

    def as_message(self) -> dict[str, Any]:
        message: dict[str, Any] = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            message["tool_calls"] = self.tool_calls
        if self.reasoning_content is not None:
            message["reasoning_content"] = self.reasoning_content
        return message


class DashScopeChatClient:
    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    @property
    def enabled(self) -> bool:
        if self.settings.tianhe_ai_enabled:
            return bool(self.settings.tianhe_ai_base_url and self.settings.tianhe_model_token)
        return self.settings.llm_enabled and bool(self.settings.dashscope_api_key)

    def complete(self, messages: list[dict[str, Any]], *, temperature: float = 0.0) -> str | None:
        result = self._complete(messages, temperature=temperature)
        return result.content if result and not result.tool_calls else None

    def complete_with_tools(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]],
        tool_choice: str = "auto",
        temperature: float = 0.0,
        timeout_seconds: float | None = None,
    ) -> ChatCompletion | None:
        return self._complete(
            messages, temperature=temperature,
            tools=tools, tool_choice=tool_choice, timeout_seconds=timeout_seconds,
        )

    def _complete(
        self, messages: list[dict[str, Any]], *, temperature: float,
        timeout_seconds: float | None = None,
        **options: Any,
    ) -> ChatCompletion | None:
        if not self.enabled:
            return None

        unified = self.settings.tianhe_ai_enabled
        base_url = self.settings.tianhe_ai_base_url if unified else self.settings.dashscope_base_url
        api_key = self.settings.tianhe_model_token if unified else self.settings.dashscope_api_key
        model = "tianhe-wechat-chat" if unified else self.settings.dashscope_chat_model

        try:
            response = httpx.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    **options,
                },
                timeout=timeout_seconds if timeout_seconds is not None else self.settings.llm_timeout_seconds,
            )
            response.raise_for_status()
            payload: dict[str, Any] = response.json()
            choice = payload["choices"][0]
            if choice.get("finish_reason") in {"length", "content_filter"}:
                return None
            message = choice["message"]
            content = message.get("content")
            calls = message.get("tool_calls")
            calls = [] if calls is None else calls
            if not isinstance(calls, list):
                return None
            seen_ids: set[str] = set()
            for call in calls:
                if not isinstance(call, dict) or call.get("type") != "function":
                    return None
                call_id = call.get("id")
                function = call.get("function")
                if (
                    not isinstance(call_id, str) or not call_id.strip() or call_id in seen_ids
                    or not isinstance(function, dict)
                    or not isinstance(function.get("name"), str)
                    or not isinstance(function.get("arguments"), str)
                ):
                    return None
                seen_ids.add(call_id)
        except (httpx.HTTPError, IndexError, AttributeError, KeyError, TypeError, ValueError) as exc:
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            logger.warning("Model call failed: source=%s type=%s status=%s", "tianhe" if unified else "standalone", type(exc).__name__, status)
            return None

        rendered = content.strip() if isinstance(content, str) and content.strip() else None
        if not rendered and not calls:
            return None
        reasoning = message.get("reasoning_content")
        return ChatCompletion(
            content=rendered, tool_calls=calls,
            reasoning_content=reasoning if isinstance(reasoning, str) else None,
        )


class DashScopeEmbeddingClient:
    def __init__(self, *, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    @property
    def enabled(self) -> bool:
        return (
            self.settings.llm_enabled
            and self.settings.faq_embedding_enabled
            and bool(self.base_url)
            and bool(self.api_key)
        )

    @property
    def model_name(self) -> str:
        return self.settings.dashscope_embedding_model

    @property
    def base_url(self) -> str:
        return (
            str(
                getattr(
                    self.settings,
                    "dashscope_embedding_base_url",
                    "",
                )
                or ""
            ).strip()
            or self.settings.dashscope_base_url.strip()
        )

    @property
    def api_key(self) -> str:
        embedding_base_url = str(
            getattr(
                self.settings,
                "dashscope_embedding_base_url",
                "",
            )
            or ""
        ).strip()
        embedding_api_key = str(
            getattr(
                self.settings,
                "dashscope_embedding_api_key",
                "",
            )
            or ""
        ).strip()
        if embedding_base_url or embedding_api_key:
            return embedding_api_key
        return self.settings.dashscope_api_key.strip()

    def embed(self, texts: list[str]) -> list[list[float]] | None:
        if not texts:
            return []
        if not self.enabled:
            return None

        embeddings: list[list[float]] = []
        batch_size = max(1, self.settings.dashscope_embedding_batch_size)
        try:
            for start in range(0, len(texts), batch_size):
                batch = texts[start : start + batch_size]
                response = httpx.post(
                    f"{self.base_url.rstrip('/')}/embeddings",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": self.settings.dashscope_embedding_model,
                        "input": batch,
                        "dimensions": self.settings.dashscope_embedding_dimensions,
                        "encoding_format": "float",
                    },
                    timeout=self.settings.llm_timeout_seconds,
                )
                response.raise_for_status()
                payload: dict[str, Any] = response.json()
                rows = sorted(payload["data"], key=lambda item: int(item["index"]))
                embeddings.extend([float(value) for value in item["embedding"]] for item in rows)
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            return None

        return embeddings if len(embeddings) == len(texts) else None
