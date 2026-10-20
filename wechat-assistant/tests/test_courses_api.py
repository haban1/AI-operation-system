from types import SimpleNamespace

from fastapi import HTTPException

from app.api.courses import create_course, create_course_schedule, delete_course_schedule, list_courses, update_course_schedule
from app.api.schemas import CourseCreate, CourseScheduleCreate, CourseScheduleUpdate
from app.models.entities import Role


def test_admin_can_create_course_and_schedule(db, monkeypatch):
    admin = SimpleNamespace(id="admin-user", role=Role.admin)

    course = create_course(
        CourseCreate(title="Claude Code 实战", description="实战课"),
        db=db,
        current_user=admin,
    )

    schedule = create_course_schedule(
        course.id,
        CourseScheduleCreate(
            schedule_date="2026-06-20",
            weekday=6,
            day_label="周六",
            start_time="09:00",
            end_time="12:00",
            location="线上直播间",
            instructor="王老师",
            capacity=30,
        ),
        db=db,
        current_user=admin,
    )
    rows = list_courses(db=db, current_user=admin)

    assert schedule.course_id == course.id
    assert rows[0].schedules[0].schedule_date == "2026-06-20"
    assert rows[0].title == "Claude Code 实战"
    assert rows[0].schedules[0].day_label == "周六"

    updated = update_course_schedule(
        course.id,
        schedule.id,
        CourseScheduleUpdate(
            title="Claude Code 高阶实战",
            schedule_date="2026-06-21",
            start_time="10:00",
            end_time="13:00",
            capacity=40,
        ),
        db=db,
        current_user=admin,
    )
    rows = list_courses(db=db, current_user=admin)

    assert updated.schedule_date == "2026-06-21"
    assert rows[0].title == "Claude Code 高阶实战"
    assert rows[0].schedules[0].start_time == "10:00"
    assert rows[0].schedules[0].capacity == 40

    delete_course_schedule(course.id, schedule.id, db=db, current_user=admin)
    rows = list_courses(db=db, current_user=admin)

    assert rows[0].schedules == []


def test_student_cannot_create_course(db, monkeypatch):
    student = SimpleNamespace(id="student-user", role=Role.student)

    try:
        create_course(
            CourseCreate(title="Claude Code 实战"),
            db=db,
            current_user=student,
        )
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("Expected students to be blocked from creating courses")
