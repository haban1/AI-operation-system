from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.llm.client import DashScopeEmbeddingClient
from app.models.entities import IntentDefinition, IntentEmbedding


class IntentEmbeddingService:
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
        definitions: Iterable[IntentDefinition],
        *,
        force: bool = False,
    ) -> dict[str, list[float]]:
        items = [definition for definition in definitions if definition.intent_id]
        if not items:
            return {}

        intent_ids = [definition.intent_id for definition in items]
        rows = {
            row.intent_id: row
            for row in db.scalars(
                select(IntentEmbedding).where(IntentEmbedding.intent_id.in_(intent_ids))
            )
        }
        documents = {
            definition.intent_id: intent_embedding_text(definition)
            for definition in items
        }
        hashes = {
            intent_id: hashlib.sha256(text.encode("utf-8")).hexdigest()
            for intent_id, text in documents.items()
        }
        available: dict[str, list[float]] = {}
        refresh: list[IntentDefinition] = []

        for definition in items:
            row = rows.get(definition.intent_id)
            valid = (
                row is not None
                and row.model == self.model_name
                and row.dimension == self.settings.dashscope_embedding_dimensions
                and row.source_hash == hashes[definition.intent_id]
                and _valid_vector(row.vector)
            )
            if valid:
                available[definition.intent_id] = [
                    float(value) for value in row.vector
                ]
            if force or not valid:
                refresh.append(definition)

        if not refresh:
            return available

        vectors = self.client.embed(
            [documents[definition.intent_id] for definition in refresh]
        )
        if not vectors or len(vectors) != len(refresh):
            return available

        normalized = [_normalized_vector(vector) for vector in vectors]
        if any(
            vector is None
            or len(vector) != self.settings.dashscope_embedding_dimensions
            for vector in normalized
        ):
            return available

        try:
            for definition, vector in zip(refresh, normalized, strict=True):
                assert vector is not None
                row = rows.get(definition.intent_id)
                if row is None:
                    row = IntentEmbedding(
                        intent_id=definition.intent_id,
                        model=self.model_name,
                        source_hash=hashes[definition.intent_id],
                        dimension=len(vector),
                        vector=vector,
                    )
                    db.add(row)
                    rows[definition.intent_id] = row
                else:
                    row.model = self.model_name
                    row.source_hash = hashes[definition.intent_id]
                    row.dimension = len(vector)
                    row.vector = vector
                available[definition.intent_id] = vector
            db.commit()
        except SQLAlchemyError:
            db.rollback()

        return available

    def embed_query(self, query: str) -> list[float] | None:
        values = self.client.embed([query.strip()])
        if not values or len(values) != 1:
            return None
        vector = _normalized_vector(values[0])
        if vector is None or len(vector) != self.settings.dashscope_embedding_dimensions:
            return None
        return vector


def intent_embedding_text(definition: IntentDefinition) -> str:
    sections = [
        definition.course_name.strip(),
        definition.display_name.strip(),
        definition.description.strip(),
        *(
            value.strip()
            for value in (definition.positive_examples or [])
            if value.strip()
        ),
    ]
    return "\n".join(value for value in sections if value)


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
        and all(
            isinstance(value, (int, float)) and math.isfinite(float(value))
            for value in values
        )
    )
