from app.models.entities import Role, User


def can_upload_material(user: User) -> bool:
    return user.role in {Role.admin, Role.teacher}


def require_role(user: User, roles: set[Role]) -> None:
    if user.role not in roles:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role")
