from app.core.celery_app import celery_app
from app.core.database import SessionLocal, create_all
from app.ingestion.service import IngestionService


@celery_app.task(name="materials.process", autoretry_for=(Exception,), retry_backoff=True, max_retries=3)
def process_material_task(material_id: str) -> str:
    create_all()
    with SessionLocal() as db:
        IngestionService().process_material(db, material_id)
    return material_id

