from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.llm.client import DashScopeEmbeddingClient
from app.models.entities import FAQEmbedding, FAQEntry


class FAQEmbeddingService:
    def __init__(
        self,
        *,
        client: DashScopeEmbeddingClient | None = None,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.client = client or DashScopeEmbeddingClient(settings=self.settings)

    @property
    def model_name(self) -> str:
        return self.settings.dashscope_embedding_model

    def ensure_embeddings(
        self,
        db: Session,
        entries: Iterable[FAQEntry],
        *,
        force: bool = False,
    ) -> dict[str, list[float]]:
        items = [entry for entry in entries if entry.id]
        if not items:
            return {}

        entry_ids = [entry.id for entry in items]
        rows = {
            row.faq_id: row
            for row in db.scalars(select(FAQEmbedding).where(FAQEmbedding.faq_id.in_(entry_ids)))
        }
        documents = {entry.id: faq_embedding_text(entry) for entry in items}
        hashes = {faq_id: _source_hash(text) for faq_id, text in documents.items()}
        available: dict[str, list[float]] = {}
        refresh_entries: list[FAQEntry] = []

        for entry in items:
            row = rows.get(entry.id)
            valid = (
                row is not None
                and row.model == self.model_name
                and row.dimension == self.settings.dashscope_embedding_dimensions
                and row.source_hash == hashes[entry.id]
                and _valid_vector(row.vector)
            )
            if valid:
                available[entry.id] = [float(value) for value in row.vector]
            if force or not valid:
                refresh_entries.append(entry)

        if not refresh_entries:
            return available

        refreshed_vectors = self.client.embed([documents[entry.id] for entry in refresh_entries])
        if not refreshed_vectors or len(refreshed_vectors) != len(refresh_entries):
            return available

        normalized_vectors = [_normalized_vector(vector) for vector in refreshed_vectors]
        if any(
            vector is None or len(vector) != self.settings.dashscope_embedding_dimensions
            for vector in normalized_vectors
        ):
            return available

        try:
            for entry, vector in zip(refresh_entries, normalized_vectors, strict=True):
                assert vector is not None
                row = rows.get(entry.id)
                if row is None:
                    row = FAQEmbedding(
                        faq_id=entry.id,
                        model=self.model_name,
                        source_hash=hashes[entry.id],
                        dimension=len(vector),
                        vector=vector,
                    )
                    db.add(row)
                    rows[entry.id] = row
                else:
                    row.model = self.model_name
                    row.source_hash = hashes[entry.id]
                    row.dimension = len(vector)
                    row.vector = vector
                available[entry.id] = vector
            db.commit()
        except SQLAlchemyError:
            db.rollback()

        return available

    def embed_query(self, question: str) -> list[float] | None:
        values = self.client.embed([question.strip()])
        if not values or len(values) != 1:
            return None
        vector = _normalized_vector(values[0])
        if vector is None or len(vector) != self.settings.dashscope_embedding_dimensions:
            return None
        return vector


def faq_embedding_text(entry: FAQEntry) -> str:
    sections = [
        entry.course_name.strip(),
        entry.category.strip(),
        entry.fact_name.strip(),
        entry.question.strip(),
        entry.answer.strip(),
    ]
    aliases = _clean_values(entry.aliases or [])
    keywords = _clean_values(entry.keywords or [])
    sections.extend(aliases)
    if keywords:
        sections.append(" ".join(keywords))
    return "\n".join(sections)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    score = sum(a * b for a, b in zip(left, right, strict=True))
    return max(0.0, min(1.0, score))


def _normalized_vector(values: Iterable[float]) -> list[float] | None:
    try:
        vector = [float(value) for value in values]
    except (TypeError, ValueError):
        return None
    if not _valid_vector(vector):
        return None
    norm = math.sqrt(sum(value * value for value in vector))
    if norm <= 0:
        return None
    return [value / norm for value in vector]


def _valid_vector(values: object) -> bool:
    return (
        isinstance(values, list)
        and bool(values)
        and all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in values)
    )


def _source_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _clean_values(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value.strip() for value in values if value.strip()))
