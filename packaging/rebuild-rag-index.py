"""Rebuild the installation copy's Qdrant collections from its SQLite snapshot."""
import json
import sys
from pathlib import Path

rag_root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(rag_root))
from app.config import Settings
from app.db import Database
from app.retrieval import LocalVectorIndex

settings = Settings(
    data_dir=rag_root / 'data', upload_dir=rag_root / 'data/uploads',
    sqlite_path=rag_root / 'data/rag.db', qdrant_path=rag_root / 'data/qdrant',
    model_cache_dir=rag_root / 'models',
)
database = Database(settings.sqlite_path)
index = LocalVectorIndex(settings, database)
if not index.available:
    raise RuntimeError(index.error)
try:
    with database.connection() as connection:
        releases = [row['release_id'] for row in connection.execute("SELECT release_id FROM releases WHERE status='PUBLISHED'")]
    for release_id in releases:
        chunks = database.get_release_members(release_id)
        if chunks and not index.build(release_id, chunks):
            raise RuntimeError(index.error or 'Could not rebuild release index')
    print(json.dumps({'rebuiltReleases': len(releases)}))
finally:
    index.client.close()
