"""Read-only retrieval for external agents; no drafts, generation or tools."""
import asyncio
from pydantic import BaseModel, ConfigDict, Field, field_validator


class PublishedRetrievalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=4000)
    topK: int = Field(default=8, ge=1, le=20)

    @field_validator("query")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("query must not be blank")
        return value.strip()


async def retrieve_published(service, request: PublishedRetrievalRequest) -> dict:
    kb = service.settings.retrieval_knowledge_base_id
    release = service.active_release(kb)
    if not release:
        return {"status": "NOT_READY", "knowledgeBaseId": kb, "releaseId": None, "chunks": []}
    prepared = service._prepare_scope(knowledge_base_id=kb, release_id=release["release_id"])
    result = await asyncio.to_thread(service.retriever.search, request.query, prepared.scope, top_k=request.topK)
    chunks = []
    for hit in result.get("selected", []):
        # The retriever returns serialized SearchHit objects with public text metadata.
        chunks.append({
            "chunkId": hit["chunk_id"], "documentId": hit["document_id"],
            "documentVersion": hit.get("document_version"), "title": hit.get("title", ""),
            "text": hit.get("text", ""), "location": hit.get("location", {}),
            "sectionPath": hit.get("section_path", []), "score": hit.get("retrieval_score", 0),
        })
    return {"status": "MATCHED" if chunks else "NO_MATCH", "knowledgeBaseId": kb,
            "releaseId": release["release_id"], "knowledgeVersion": release.get("knowledge_version"), "chunks": chunks}
