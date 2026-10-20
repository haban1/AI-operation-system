from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.llm import LLMClient
from app.core.vector_store import MilvusVectorStore
from app.ingestion.parsers import chunk_sections, parse_material
from app.models.entities import Material, MaterialChunk, MaterialStatus


SUPPORTED_SUFFIXES = {".pdf", ".pptx", ".docx"}


def next_material_version(db: Session, *, filename: str) -> int:
    current = db.scalar(select(func.max(Material.version)).where(Material.filename == filename))
    return int(current or 0) + 1


class IngestionService:
    def __init__(self, *, llm: LLMClient | None = None, vector_store: MilvusVectorStore | None = None) -> None:
        self.llm = llm or LLMClient()
        self.vector_store = vector_store or MilvusVectorStore()

    def process_material(self, db: Session, material_id: str) -> Material:
        material = db.get(Material, material_id)
        if not material:
            raise ValueError(f"Material not found: {material_id}")
        material.status = MaterialStatus.processing
        material.error_message = ""
        db.commit()
        try:
            sections = parse_material(Path(material.path))
            chunks = chunk_sections(sections)
            texts = [chunk["text"] for chunk in chunks]
            embeddings = self.llm.embed(texts) if texts else []
            vector_rows = []
            for index, (chunk, embedding) in enumerate(zip(chunks, embeddings, strict=True)):
                row = MaterialChunk(
                    material_id=material.id,
                    version=material.version,
                    chunk_index=index,
                    page_or_slide=chunk["page_or_slide"],
                    text=chunk["text"],
                )
                db.add(row)
                db.flush()
                vector_rows.append(
                    {
                        "embedding": embedding,
                        "chunk_id": row.id,
                        "material_id": material.id,
                        "version": material.version,
                        "page_or_slide": row.page_or_slide,
                        "text": row.text,
                    }
                )
            self.vector_store.upsert_chunks(vector_rows)
            material.status = MaterialStatus.ready
            db.commit()
            db.refresh(material)
            return material
        except Exception as exc:
            material.status = MaterialStatus.failed
            material.error_message = str(exc)
            db.commit()
            raise
