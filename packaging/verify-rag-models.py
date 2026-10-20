"""Verify bundled models without network downloads or online AI requests."""
import json
import math
import os
import sys
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
rag_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(rag_root))
from app.config import Settings
from app.providers import FastEmbedProvider, FastEmbedRerankerProvider

settings = Settings(model_cache_dir=rag_root / 'models', fastembed_local_files_only=True, allow_model_fallback=False)
embedding = FastEmbedProvider(settings)
vectors = embedding.embed(['社区服务办理时间'])
assert len(vectors) == 1 and len(vectors[0]) == 512
assert embedding.status.ready and not embedding.status.fallback
reranker = FastEmbedRerankerProvider(settings)
scores = reranker.rerank('社区服务办理时间', ['社区工作日九点到十八点提供服务。', '这是一份天气预报。'])
assert len(scores) == 2 and all(math.isfinite(value) for value in scores)
assert scores[0] > scores[1]
assert reranker.status.ready and not reranker.status.fallback
print(json.dumps({'embeddingDimension': len(vectors[0]), 'rerankerReady': True, 'networkDisabled': True}))
