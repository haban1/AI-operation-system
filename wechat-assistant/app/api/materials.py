from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.schemas import MaterialRead
from app.core.legacy_config import get_legacy_settings
from app.core.database import get_db
from app.core.permissions import require_role
from app.ingestion.service import SUPPORTED_SUFFIXES, next_material_version
from app.ingestion.tasks import process_material_task
from app.models.entities import Material, Role, User


router = APIRouter(tags=["materials"])


@router.post("/materials", response_model=MaterialRead)
def upload_material(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Material:
    require_role(current_user, {Role.admin, Role.teacher})
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF, PPTX and DOCX are supported")
    settings = get_legacy_settings()
    version = next_material_version(db, filename=file.filename or "material")
    target_dir = settings.storage_dir
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"{Path(file.filename or 'material').stem}-v{version}{suffix}"
    with target_path.open("wb") as output:
        while chunk := file.file.read(1024 * 1024):
            output.write(chunk)
    material = Material(
        uploaded_by_id=current_user.id,
        filename=file.filename or target_path.name,
        content_type=file.content_type or "",
        path=str(target_path),
        version=version,
    )
    db.add(material)
    db.commit()
    db.refresh(material)
    process_material_task.delay(material.id)
    return material


@router.get("/materials/{material_id}", response_model=MaterialRead)
def get_material(
    material_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Material:
    material = db.get(Material, material_id)
    if not material:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Material not found")
    return material
