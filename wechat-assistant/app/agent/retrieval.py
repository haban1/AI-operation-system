from dataclasses import asdict

from app.core.cache import CacheClient, build_cache_key
from app.core.legacy_config import get_legacy_settings
from app.core.llm import LLMClient
from app.core.vector_store import MilvusVectorStore, SearchHit
from app.models.entities import User


class MaterialRetriever:
    def __init__(
        self,
        *,
        llm: LLMClient | None = None,
        vector_store: MilvusVectorStore | None = None,
        cache: CacheClient | None = None,
    ) -> None:
        self.settings = get_legacy_settings()
        self.llm = llm or LLMClient()
        self.vector_store = vector_store or MilvusVectorStore()
        self.cache = cache or CacheClient()

    def retrieve(self, *, user: User, query: str) -> list[SearchHit]:
        key = build_cache_key(
            namespace="retrieval",
            user_id=user.id,
            scope="global",
            permission_version=user.permission_version,
            model=self.settings.dashscope_embedding_model,
            prompt_version=self.settings.prompt_version,
            payload={"query": query, "top_k": self.settings.retrieval_top_k},
        )
        cached = self.cache.get_json(key)
        if cached:
            return [SearchHit(**row) for row in cached]
        embedding = self.llm.embed([query])[0]
        hits = self.vector_store.search(
            query_embedding=embedding,
            top_k=self.settings.retrieval_top_k,
        )
        self.cache.set_json(key, [asdict(hit) for hit in hits])
        return hits
