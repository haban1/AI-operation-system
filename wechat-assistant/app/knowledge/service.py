from __future__ import annotations

import logging
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.faq.embeddings import _normalized_vector, cosine_similarity
from app.intent.models import IntentDecision, IntentDecisionType
from app.knowledge.parsers import parse_document
from app.llm.client import DashScopeEmbeddingClient
from app.models.entities import KnowledgeChunk, KnowledgeDocument
from app.retrieval.bm25 import rank_bm25

logger = logging.getLogger(__name__)


class DocumentKnowledgeService:
    def __init__(self, *, embedding_client=None):
        self.settings = get_settings()
        self.embedding_client = embedding_client or DashScopeEmbeddingClient(settings=self.settings.model_copy(
            update={"faq_embedding_enabled": self.settings.document_embedding_enabled}
        ))

    def process(self, db: Session, document: KnowledgeDocument) -> None:
        document.status = "processing"
        document.error_message = ""
        db.commit()
        try:
            sections = parse_document(document.filename, document.content)
            vectors = self.embedding_client.embed([item["text"] for item in sections])
            normalized = [_normalized_vector(v) for v in vectors] if vectors else []
            hybrid = (len(normalized) == len(sections) and all(
                v and len(v) == self.settings.dashscope_embedding_dimensions for v in normalized
            ))
            db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.document_id == document.id))
            for index, section in enumerate(sections):
                db.add(KnowledgeChunk(
                    document_id=document.id, position=index, **section,
                    embedding=normalized[index] if hybrid else [],
                    embedding_model=self.settings.dashscope_embedding_model if hybrid else "",
                ))
            document.status = "ready"
            document.chunk_count = len(sections)
            document.index_mode = "hybrid" if hybrid else "keyword"
            document.error_message = "" if hybrid else "语义索引暂不可用，已启用关键词检索；配置或恢复向量服务后可重新解析。"
            db.commit()
        except Exception as exc:
            db.rollback()
            document.status = "failed"
            document.error_message = str(exc) if isinstance(exc, ValueError) else "文档解析失败，请检查文件是否损坏或格式是否正确。"
            logger.warning("Document indexing failed (%s)", type(exc).__name__)
            db.commit()

    def search(self, db: Session, query: str) -> list[dict]:
        rows = db.execute(select(KnowledgeChunk, KnowledgeDocument).join(
            KnowledgeDocument, KnowledgeDocument.id == KnowledgeChunk.document_id
        ).where(KnowledgeDocument.is_active.is_(True), KnowledgeDocument.status == "ready")).all()
        if not rows or not query.strip():
            return []
        lexical = rank_bm25(query, [doc.filename + "\n" + chunk.text for chunk, doc in rows])
        scores = {hit.index: 1 / (60 + rank) for rank, hit in enumerate(lexical, 1)}
        vector_scores = {}
        eligible = [i for i, (chunk, _) in enumerate(rows) if chunk.embedding
                    and chunk.embedding_model == self.settings.dashscope_embedding_model
                    and len(chunk.embedding) == self.settings.dashscope_embedding_dimensions]
        if eligible:
            embedded = self.embedding_client.embed([query])
            vector = _normalized_vector(embedded[0]) if embedded else None
            if vector:
                for i in eligible:
                    similarity = cosine_similarity(vector, rows[i][0].embedding)
                    if similarity >= self.settings.document_embedding_min_similarity:
                        vector_scores[i] = similarity
                for rank, i in enumerate(sorted(vector_scores, key=vector_scores.get, reverse=True), 1):
                    scores[i] = scores.get(i, 0) + 1 / (60 + rank)
        result = []
        for i in sorted(scores, key=scores.get, reverse=True)[:self.settings.document_retrieval_top_k]:
            chunk, doc = rows[i]
            result.append({"chunk_id": chunk.id, "material_id": doc.id, "filename": doc.filename,
                           "page_or_slide": chunk.location, "text": chunk.text,
                           "score": round(scores[i], 6)})
        return result

    def query(self, db: Session, query: str) -> IntentDecision:
        chunks = self.search(db, query)
        return IntentDecision(
            course_code="", course_name="", intent_code="", domain="knowledge", intent_id="document_search",
            decision=IntentDecisionType.accept if chunks else IntentDecisionType.clarify,
            answer="已找到相关文档片段，请依据原文回答。" if chunks else "暂时没有在已启用的文档中检索到可确认的信息，请补充课程名称或更具体的问题。",
            confidence=0.0, margin=0.0, sources=["DOCUMENT_RETRIEVAL"],
            match_type="document", document_chunks=chunks,
        )
