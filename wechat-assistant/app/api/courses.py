from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.schemas import (
    CourseCreate,
    CourseRead,
    CourseScheduleCreate,
    CourseScheduleRead,
    CourseScheduleUpdate,
    CourseWithSchedules,
)
from app.core.database import get_db
from app.core.permissions import require_role
from app.models.entities import Course, CourseSchedule, Role, User


router = APIRouter(tags=["courses"])


@router.get("/courses", response_model=list[CourseWithSchedules])
def list_courses(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[CourseWithSchedules]:
    courses = list(db.scalars(select(Course).order_by(Course.created_at.desc())))
    if not courses:
        return []

    schedules = list(
        db.scalars(
            select(CourseSchedule)
            .where(CourseSchedule.course_id.in_([course.id for course in courses]))
            .order_by(CourseSchedule.schedule_date, CourseSchedule.start_time)
        )
    )
    schedules_by_course: dict[str, list[CourseScheduleRead]] = {}
    for schedule in schedules:
        schedules_by_course.setdefault(schedule.course_id, []).append(CourseScheduleRead.model_validate(schedule))

    return [
        CourseWithSchedules(
            **CourseRead.model_validate(course).model_dump(),
            schedules=schedules_by_course.get(course.id, []),
        )
        for course in courses
    ]


@router.post("/courses", response_model=CourseRead)
def create_course(
    payload: CourseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Course:
    require_role(current_user, {Role.admin, Role.teacher})
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Course title is required")
    course = Course(title=title, description=payload.description.strip(), owner_id=current_user.id)
    db.add(course)
    db.commit()
    db.refresh(course)
    return course


@router.post("/courses/{course_id}/schedules", response_model=CourseScheduleRead)
def create_course_schedule(
    course_id: str,
    payload: CourseScheduleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CourseSchedule:
    require_role(current_user, {Role.admin, Role.teacher})
    course = db.get(Course, course_id)
    if not course:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Course not found")
    _validate_schedule_payload(payload)

    schedule = CourseSchedule(
        course_id=course.id,
        schedule_date=payload.schedule_date.strip(),
        weekday=payload.weekday,
        day_label=payload.day_label.strip(),
        start_time=payload.start_time.strip(),
        end_time=payload.end_time.strip(),
        location=payload.location.strip(),
        instructor=payload.instructor.strip(),
        capacity=payload.capacity,
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    return schedule


@router.patch("/courses/{course_id}/schedules/{schedule_id}", response_model=CourseScheduleRead)
def update_course_schedule(
    course_id: str,
    schedule_id: str,
    payload: CourseScheduleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CourseSchedule:
    require_role(current_user, {Role.admin, Role.teacher})
    course = db.get(Course, course_id)
    schedule = db.get(CourseSchedule, schedule_id)
    if not course or not schedule or schedule.course_id != course.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found")
    _validate_schedule_payload(payload)

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Course title is required")
        course.title = title
    if payload.description is not None:
        course.description = payload.description.strip()

    for field_name in (
        "schedule_date",
        "weekday",
        "day_label",
        "start_time",
        "end_time",
        "location",
        "instructor",
        "capacity",
    ):
        if field_name not in payload.model_fields_set:
            continue
        value = getattr(payload, field_name)
        if isinstance(value, str):
            value = value.strip()
        setattr(schedule, field_name, value)

    db.commit()
    db.refresh(schedule)
    return schedule


@router.delete("/courses/{course_id}/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_course_schedule(
    course_id: str,
    schedule_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    require_role(current_user, {Role.admin, Role.teacher})
    schedule = db.get(CourseSchedule, schedule_id)
    if not schedule or schedule.course_id != course_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Schedule not found")
    db.delete(schedule)
    db.commit()


def _validate_schedule_payload(payload: CourseScheduleCreate | CourseScheduleUpdate) -> None:
    schedule_date = getattr(payload, "schedule_date", None)
    if schedule_date is not None and schedule_date and not _is_iso_date(schedule_date.strip()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Schedule date must be YYYY-MM-DD")
    weekday = getattr(payload, "weekday", None)
    if weekday is not None and not 1 <= weekday <= 7:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Weekday must be between 1 and 7")
    capacity = getattr(payload, "capacity", None)
    if capacity is not None and capacity < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Capacity must not be negative")


def _is_iso_date(value: str) -> bool:
    parts = value.split("-")
    if len(parts) != 3:
        return False
    year, month, day = parts
    if not (len(year) == 4 and len(month) == 2 and len(day) == 2):
        return False
    try:
        year_int = int(year)
        month_int = int(month)
        day_int = int(day)
    except ValueError:
        return False
    return 1 <= month_int <= 12 and 1 <= day_int <= 31 and year_int > 0
