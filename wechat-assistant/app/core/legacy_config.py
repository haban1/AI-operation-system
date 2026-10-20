from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class LegacySettings(BaseSettings):
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"

    milvus_host: str = "localhost"
    milvus_port: int = 19530
    milvus_collection: str = "course_material_chunks"
    embedding_dimension: int = 1024

    dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    dashscope_api_key: str = ""
    dashscope_chat_model: str = "qwen-plus"
    dashscope_embedding_model: str = "text-embedding-v4"
    dashscope_embedding_batch_size: int = 10

    storage_dir: Path = Field(default=Path("storage/materials"))
    retrieval_top_k: int = 5
    prompt_version: str = "training-agent-v1"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8-sig",
        env_prefix="LEGACY_",
        extra="ignore",
    )


@lru_cache
def get_legacy_settings() -> LegacySettings:
    return LegacySettings()
