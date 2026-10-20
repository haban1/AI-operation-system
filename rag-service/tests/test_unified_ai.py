import asyncio
import json

import httpx

from app.config import Settings
from app.providers import OpenAICompatibleProvider, ProviderError


def test_rag_generation_uses_tianhe_and_preserves_retrieval_models():
    async def check():
        s = Settings(_env_file=None, tianhe_ai_enabled=True, TIANHE_MODEL_TOKEN="internal-token",
                     tianhe_ai_base_url="http://web:3100/api/model/v1", generation_provider="deterministic",
                     llm_base_url="https://obsolete.test", llm_api_key="old-secret")
        provider = OpenAICompatibleProvider(s)
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]})
        provider.client = httpx.AsyncClient(base_url=provider.base_url, headers={"Authorization": "Bearer " + provider.api_key}, transport=httpx.MockTransport(handle))
        assert provider.enabled
        assert (await provider.complete([{"role": "user", "content": "test"}]))["text"] == "answer"
        assert str(calls[0].url) == "http://web:3100/api/model/v1/chat/completions"
        assert calls[0].headers["authorization"] == "Bearer internal-token"
        assert json.loads(calls[0].content)["model"] == "tianhe-rag-chat"
        assert s.embedding_model == "BAAI/bge-small-zh-v1.5"
        assert s.reranker_model == "BAAI/bge-reranker-base"
        await provider.close()
    asyncio.run(check())


def test_unified_rag_rejects_disabled_central_model_without_old_provider_fallback():
    async def check():
        s = Settings(_env_file=None, tianhe_ai_enabled=True, TIANHE_MODEL_TOKEN="token")
        provider = OpenAICompatibleProvider(s)
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(503, json={"error": {"code": "AI_MODE_DISABLED"}})
        provider.client = httpx.AsyncClient(base_url=provider.base_url, transport=httpx.MockTransport(handle))
        try:
            await provider.complete([])
            raise AssertionError("disabled model must not generate an answer")
        except ProviderError as error:
            assert error.code == "RAG_AI_NOT_CONFIGURED"
            assert error.retryable is False
        assert len(calls) == 1
        await provider.close()
    asyncio.run(check())
