import asyncio
from types import SimpleNamespace
import pytest
from app.embeddings import EmbeddingRequest, embed_local
from app.pipeline import RagError


def service(*, fallback=False):
    status = SimpleNamespace(ready=True, fallback=fallback, model="BAAI/bge-small-zh-v1.5", dimension=3)
    return SimpleNamespace(embedding=SimpleNamespace(status=status, embed=lambda texts: [[1., 0., 0.] for _ in texts]))


def test_openai_format_preserves_input_order():
    result = asyncio.run(embed_local(service(), EmbeddingRequest(model="BAAI/bge-small-zh-v1.5", input=["甲", "乙"], dimensions=3)))
    assert [r["index"] for r in result["data"]] == [0, 1]
    assert result["data"][0]["embedding"] == [1., 0., 0.]


def test_no_silent_fallback_or_dimension_change():
    for body, provider in [
        (EmbeddingRequest(model="BAAI/bge-small-zh-v1.5", input="甲"), service(fallback=True)),
        (EmbeddingRequest(model="BAAI/bge-small-zh-v1.5", input="甲", dimensions=2048), service()),
        (EmbeddingRequest(model="different", input="甲"), service()),
    ]:
        with pytest.raises(RagError):
            asyncio.run(embed_local(provider, body))


def test_input_limits():
    for value in [[], [""], ["x"] * 65, "x" * 16001]:
        with pytest.raises(ValueError):
            EmbeddingRequest(model="BAAI/bge-small-zh-v1.5", input=value)
