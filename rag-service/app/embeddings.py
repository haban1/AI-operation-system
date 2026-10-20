"""Expose the existing local embedding model without retrieval or answer generation."""
import asyncio
from pydantic import BaseModel, ConfigDict, field_validator
from .pipeline import RagError


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    input: str | list[str]
    dimensions: int | None = None
    encoding_format: str = "float"

    @field_validator("input")
    @classmethod
    def bounded_input(cls, value):
        texts = [value] if isinstance(value, str) else value
        if not 1 <= len(texts) <= 64 or any(not text.strip() or len(text) > 16000 for text in texts):
            raise ValueError("provide 1-64 non-empty texts, at most 16000 characters each")
        return value


async def embed_local(service, body: EmbeddingRequest):
    provider = service.embedding
    status = provider.status
    if status.fallback or status.model != body.model:
        raise RagError("EMBEDDING_UNAVAILABLE", "所选本地向量模型未就绪", 503)
    if body.encoding_format != "float":
        raise RagError("EMBEDDING_FORMAT", "向量格式或维度与本地模型不一致", 400)
    texts = [body.input] if isinstance(body.input, str) else body.input
    vectors = await asyncio.to_thread(provider.embed, texts)
    # FastEmbed loads lazily on the first request. Recheck after initialization
    # so a failed model load can never silently substitute hash embeddings.
    status = provider.status
    if not status.ready or status.fallback or status.model != body.model:
        raise RagError("EMBEDDING_UNAVAILABLE", "所选本地向量模型未就绪", 503)
    if body.dimensions not in (None, status.dimension):
        raise RagError("EMBEDDING_FORMAT", "向量格式或维度与本地模型不一致", 400)
    return {"object": "list", "model": body.model,
            "data": [{"object": "embedding", "index": i, "embedding": vector} for i, vector in enumerate(vectors)],
            "usage": {"prompt_tokens": 0, "total_tokens": 0}}
