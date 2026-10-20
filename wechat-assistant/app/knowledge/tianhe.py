"""Adapt Tianhe's published snippets to the existing search_knowledge tool."""
import httpx
from app.core.config import get_settings
from app.intent.models import IntentDecision, IntentDecisionType


class TianheKnowledgeService:
    def __init__(self, *, transport=None):
        self.settings = get_settings()
        self.transport = transport

    def query(self, db, query: str) -> IntentDecision:
        if not self.settings.tianhe_rag_base_url or not self.settings.tianhe_rag_token:
            raise RuntimeError("Tianhe knowledge retrieval is not configured")
        with httpx.Client(transport=self.transport, timeout=self.settings.tianhe_rag_timeout_seconds) as client:
            response = client.post(self.settings.tianhe_rag_base_url.rstrip("/") + "/rag-api/v1/retrieve",
                                   headers={"Authorization": "Bearer " + self.settings.tianhe_rag_token},
                                   json={"query": query, "topK": self.settings.document_retrieval_top_k})
            response.raise_for_status()
            data = response.json()
        if data.get("status") not in {"MATCHED", "NO_MATCH", "NOT_READY"} or not isinstance(data.get("chunks"), list):
            raise RuntimeError("Invalid Tianhe retrieval response")
        chunks = []
        for item in data["chunks"]:
            location = item.get("location") or {}
            source_location = location.get("page") or location.get("sheet") or " / ".join(item.get("sectionPath") or []) or "原文片段"
            chunks.append({"chunk_id": item["chunkId"], "material_id": item["documentId"],
                           "filename": item.get("title") or "天河知识资料", "page_or_slide": str(source_location),
                           "text": item["text"], "score": item.get("score", 0),
                           "release_id": data.get("releaseId"), "knowledge_version": data.get("knowledgeVersion")})
        return IntentDecision(
            course_code="", course_name="", intent_code="", domain="knowledge", intent_id="document_search",
            decision=IntentDecisionType.accept if chunks else IntentDecisionType.clarify,
            answer="已找到天河已发布知识片段，请依据原文回答。" if chunks else "天河已发布知识中暂无可确认的信息，请澄清问题或请求人工协助。",
            confidence=0.0, margin=0.0, sources=["TIANHE_PUBLISHED_KNOWLEDGE"],
            match_type="document", document_chunks=chunks,
        )
