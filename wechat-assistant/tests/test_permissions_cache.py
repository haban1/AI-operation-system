from fastapi import HTTPException

from app.core.cache import build_cache_key
from app.core.permissions import require_role
from app.models.entities import Role, User


def test_role_guard_allows_admin_and_teacher_uploads():
    teacher = User(username="teacher", password_hash="x", role=Role.teacher)
    admin = User(username="admin", password_hash="x", role=Role.admin)

    require_role(teacher, {Role.admin, Role.teacher})
    require_role(admin, {Role.admin, Role.teacher})


def test_role_guard_blocks_students_from_uploads():
    student = User(username="student", password_hash="x", role=Role.student)

    try:
        require_role(student, {Role.admin, Role.teacher})
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Expected student upload role check to fail")


def test_cache_key_contains_user_permission_model_and_global_scope():
    key = build_cache_key(
        namespace="answer",
        user_id="u1",
        scope="global",
        permission_version=7,
        model="gpt-test",
        prompt_version="prompt-v1",
        payload={"q": "hello"},
    )

    assert "user=u1" in key
    assert "scope=global" in key
    assert "perm=7" in key
    assert "model=gpt-test" in key
    assert "prompt=prompt-v1" in key
