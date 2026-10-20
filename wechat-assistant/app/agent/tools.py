from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.models.entities import AuditLog, Role, User


@dataclass(frozen=True)
class ToolSpec:
    name: str
    handler: Callable[..., Any]
    allowed_roles: set[Role]
    requires_global_access: bool = True


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def call(self, db: Session, user: User, name: str, **kwargs: Any) -> Any:
        spec = self._tools[name]
        if user.role not in spec.allowed_roles:
            raise PermissionError(f"Tool {name} is not allowed for role {user.role}")
        result = spec.handler(**kwargs)
        db.add(
            AuditLog(
                user_id=user.id,
                action=f"tool.{name}",
                resource_type="global",
                resource_id="",
                detail="tool call accepted",
            )
        )
        db.commit()
        return result
