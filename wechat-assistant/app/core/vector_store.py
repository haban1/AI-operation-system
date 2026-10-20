from dataclasses import dataclass
from typing import Any

try:
    from pymilvus import Collection, CollectionSchema, DataType, FieldSchema, connections, utility
except Exception:  # pragma: no cover
    Collection = None  # type: ignore
    CollectionSchema = None  # type: ignore
    DataType = None  # type: ignore
    FieldSchema = None  # type: ignore
    connections = None  # type: ignore
    utility = None  # type: ignore

from app.core.legacy_config import get_legacy_settings


@dataclass
class SearchHit:
    chunk_id: str
    material_id: str
    version: int
    page_or_slide: str
    text: str
    score: float


class MilvusVectorStore:
    def __init__(self) -> None:
        self.settings = get_legacy_settings()
        self.collection_name = self.settings.milvus_collection
        self._collection: Any | None = None

    def connect(self) -> None:
        if not Collection:
            return
        connections.connect(host=self.settings.milvus_host, port=self.settings.milvus_port)
        if not utility.has_collection(self.collection_name):
            fields = [
                FieldSchema(name="pk", dtype=DataType.INT64, is_primary=True, auto_id=True),
                FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=self.settings.embedding_dimension),
                FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="material_id", dtype=DataType.VARCHAR, max_length=64),
                FieldSchema(name="version", dtype=DataType.INT64),
                FieldSchema(name="page_or_slide", dtype=DataType.VARCHAR, max_length=80),
                FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=8192),
            ]
            schema = CollectionSchema(fields, description="Training material chunks")
            collection = Collection(self.collection_name, schema=schema)
            collection.create_index("embedding", {"index_type": "AUTOINDEX", "metric_type": "COSINE"})
        self._collection = Collection(self.collection_name)
        self._collection.load()

    @property
    def collection(self) -> Any:
        if self._collection is None:
            self.connect()
        return self._collection

    def upsert_chunks(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        if not Collection:
            return
        entities = [
            [row["embedding"] for row in rows],
            [row["chunk_id"] for row in rows],
            [row["material_id"] for row in rows],
            [row["version"] for row in rows],
            [row["page_or_slide"] for row in rows],
            [row["text"][:8192] for row in rows],
        ]
        self.collection.insert(entities)
        self.collection.flush()

    def search(self, *, query_embedding: list[float], top_k: int) -> list[SearchHit]:
        if not Collection:
            return []
        result = self.collection.search(
            data=[query_embedding],
            anns_field="embedding",
            param={"metric_type": "COSINE"},
            limit=top_k,
            output_fields=["chunk_id", "material_id", "version", "page_or_slide", "text"],
        )
        hits: list[SearchHit] = []
        for hit in result[0]:
            entity = hit.entity
            hits.append(
                SearchHit(
                    chunk_id=entity.get("chunk_id"),
                    material_id=entity.get("material_id"),
                    version=entity.get("version"),
                    page_or_slide=entity.get("page_or_slide"),
                    text=entity.get("text"),
                    score=float(hit.score),
                )
            )
        return hits
