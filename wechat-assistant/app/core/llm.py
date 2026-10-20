import hashlib
from collections.abc import Sequence

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore

from app.core.legacy_config import get_legacy_settings


class LLMClient:
    def __init__(self) -> None:
        settings = get_legacy_settings()
        self.settings = settings
        self._client = (
            OpenAI(api_key=settings.dashscope_api_key, base_url=settings.dashscope_base_url)
            if OpenAI and settings.dashscope_api_key
            else None
        )

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        if self._client:
            embeddings: list[list[float]] = []
            batch_size = self.settings.dashscope_embedding_batch_size
            for start in range(0, len(texts), batch_size):
                batch = list(texts[start : start + batch_size])
                response = self._client.embeddings.create(model=self.settings.dashscope_embedding_model, input=batch)
                embeddings.extend(item.embedding for item in response.data)
            return embeddings
        return [self._deterministic_embedding(text, self.settings.embedding_dimension) for text in texts]

    def chat(self, messages: list[dict[str, str]]) -> str:
        if self._client:
            response = self._client.chat.completions.create(
                model=self.settings.dashscope_chat_model,
                messages=messages,
                temperature=0.2,
            )
            return response.choices[0].message.content or ""
        user_message = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        return f"当前未配置 DASHSCOPE_API_KEY。基于请求内容的占位回答：{user_message}"

    @staticmethod
    def _deterministic_embedding(text: str, dimension: int) -> list[float]:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        values: list[float] = []
        while len(values) < dimension:
            for byte in digest:
                values.append((byte / 255.0) - 0.5)
                if len(values) == dimension:
                    break
            digest = hashlib.sha256(digest).digest()
        return values
