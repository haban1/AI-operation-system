from collections.abc import Generator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def _engine_args(database_url: str) -> dict:
    if database_url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}
    return {"pool_pre_ping": True}


settings = get_settings()
engine = create_engine(settings.database_url, **_engine_args(settings.database_url))
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_all() -> None:
    import app.models.entities  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_compatible_schema()
    _retire_legacy_course_groups()
    _seed_course_definitions()
    _seed_intent_definitions()


def _ensure_compatible_schema() -> None:
    inspector = inspect(engine)
    table_names = inspector.get_table_names()
    if "wecom_user_bindings" not in table_names:
        Base.metadata.tables["wecom_user_bindings"].create(bind=engine, checkfirst=True)
    if "wecom_message_receipts" not in table_names:
        Base.metadata.tables["wecom_message_receipts"].create(bind=engine, checkfirst=True)
    if "wechat_robot_outbound_receipts" not in table_names:
        Base.metadata.tables["wechat_robot_outbound_receipts"].create(
            bind=engine,
            checkfirst=True,
        )
    if "wechat_robot_handoff_notifiers" not in table_names:
        Base.metadata.tables["wechat_robot_handoff_notifiers"].create(
            bind=engine,
            checkfirst=True,
        )
    _ensure_columns(
        "wechat_robot_broadcasts",
        {
            "recipient_ids": "JSON DEFAULT '[]' NOT NULL",
            "client_request_id": "VARCHAR(64)",
        },
    )
    with engine.begin() as connection:
        connection.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_wechat_broadcast_request ON wechat_robot_broadcasts (client_request_id)"))
    _ensure_columns(
        "wecom_user_bindings",
        {
            "active_session_id": "VARCHAR(32)",
        },
    )
    _ensure_columns(
        "wechat_robot_user_bindings",
        {
            "handoff_started_at": "TIMESTAMP",
            "handoff_updated_at": "TIMESTAMP",
            "handoff_resolved_at": "TIMESTAMP",
            "handoff_reason": "TEXT DEFAULT '' NOT NULL",
            "handoff_last_message": "TEXT DEFAULT '' NOT NULL",
        },
    )
    _ensure_columns(
        "faq_entries",
        {
            "fact_name": "VARCHAR(200) DEFAULT '' NOT NULL",
            "image_url": "VARCHAR(1000) DEFAULT '' NOT NULL",
            "image_data": (
                "BYTEA"
                if engine.dialect.name == "postgresql"
                else "BLOB"
            ),
            "image_filename": "VARCHAR(255) DEFAULT '' NOT NULL",
            "image_content_type": "VARCHAR(120) DEFAULT '' NOT NULL",
            "course_code": "VARCHAR(60) DEFAULT 'general' NOT NULL",
            "course_name": "VARCHAR(100) DEFAULT '通用咨询' NOT NULL",
            "intent_code": "VARCHAR(80) DEFAULT 'general' NOT NULL",
            "domain": "VARCHAR(100) DEFAULT 'course' NOT NULL",
            "intent_id": "VARCHAR(160) DEFAULT 'course.general' NOT NULL",
            "risk_level": "VARCHAR(20) DEFAULT 'low' NOT NULL",
            "handoff_required": "BOOLEAN DEFAULT FALSE NOT NULL",
            "taxonomy_version": "VARCHAR(40) DEFAULT 'faq-taxonomy-v1' NOT NULL",
        },
    )
    _ensure_columns(
        "faq_query_logs",
        {
            "original_query": "VARCHAR(1000) DEFAULT '' NOT NULL",
            "retrieval_queries": "JSON DEFAULT '[]' NOT NULL",
            "rewrite_strategies": "JSON DEFAULT '[]' NOT NULL",
            "rewrite_version": "VARCHAR(40) DEFAULT 'faq-query-rewrite-v1' NOT NULL",
            "matched_fact_ids": "JSON DEFAULT '[]' NOT NULL",
            "matched_facts": "JSON DEFAULT '[]' NOT NULL",
            "margin": "FLOAT DEFAULT 0 NOT NULL",
            "decision": "VARCHAR(30) DEFAULT 'OUT_OF_SCOPE' NOT NULL",
            "course_code": "VARCHAR(60) DEFAULT 'general' NOT NULL",
            "course_name": "VARCHAR(100) DEFAULT '通用咨询' NOT NULL",
            "intent_code": "VARCHAR(80) DEFAULT 'general' NOT NULL",
            "domain": "VARCHAR(100) DEFAULT 'general' NOT NULL",
            "intent_id": "VARCHAR(160) DEFAULT 'unknown' NOT NULL",
            "match_type": "VARCHAR(30) DEFAULT 'none' NOT NULL",
            "candidates": "JSON DEFAULT '[]' NOT NULL",
            "sources": "JSON DEFAULT '[]' NOT NULL",
            "router_version": "VARCHAR(40) DEFAULT 'faq-router-v1' NOT NULL",
            "taxonomy_version": "VARCHAR(40) DEFAULT 'faq-taxonomy-v1' NOT NULL",
            "corrected_faq_id": "VARCHAR(32)",
            "correction_note": "TEXT DEFAULT '' NOT NULL",
            "review_status": "VARCHAR(20) DEFAULT 'pending' NOT NULL",
            "reviewed_at": "TIMESTAMP",
        },
    )
    _ensure_columns(
        "course_definitions",
        {
            "is_deleted": "BOOLEAN DEFAULT FALSE NOT NULL",
        },
    )
    _ensure_columns(
        "intent_definitions",
        {
            "is_deleted": "BOOLEAN DEFAULT FALSE NOT NULL",
        },
    )
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE faq_query_logs "
                "SET decision = 'ACCEPT', review_status = 'not_required', reviewed_at = created_at "
                "WHERE matched_faq_id IS NOT NULL "
                "AND decision = 'OUT_OF_SCOPE' "
                "AND review_status = 'pending'"
            )
        )
    _backfill_faq_taxonomy()
    _backfill_fact_names()
    if "course_schedules" not in table_names:
        return
    columns = {column["name"] for column in inspector.get_columns("course_schedules")}
    if "schedule_date" in columns:
        return
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE course_schedules ADD COLUMN schedule_date VARCHAR(10) DEFAULT ''"))


def _ensure_columns(table_name: str, definitions: dict[str, str]) -> None:
    inspector = inspect(engine)
    if table_name not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns(table_name)}
    missing = {name: definition for name, definition in definitions.items() if name not in existing}
    if not missing:
        return
    with engine.begin() as conn:
        for name, definition in missing.items():
            conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {name} {definition}"))


def _backfill_faq_taxonomy() -> None:
    from app.intent.taxonomy import intent_id_for, intent_label, normalize_taxonomy

    with engine.begin() as conn:
        rows = conn.execute(
            text(
                "SELECT id, question, category, domain, intent_id, "
                "course_code, course_name, intent_code, taxonomy_version FROM faq_entries"
            )
        ).mappings()
        for row in rows:
            has_course_taxonomy = row["taxonomy_version"] in {
                "faq-taxonomy-v2",
                "faq-taxonomy-v3",
            }
            course_code, course_name, intent_code = normalize_taxonomy(
                question=row["question"] or "",
                course_code=row["course_code"] or "" if has_course_taxonomy else (
                    "" if row["course_code"] == "general" else row["course_code"] or ""
                ),
                course_name=row["course_name"] or "",
                intent_code=row["intent_code"] or "" if has_course_taxonomy else (
                    "" if row["intent_code"] == "general" else row["intent_code"] or ""
                ),
                category=row["category"] or "",
                domain=row["domain"] or "",
                intent_id=row["intent_id"] or "",
            )
            conn.execute(
                text(
                    "UPDATE faq_entries SET course_code = :course_code, course_name = :course_name, "
                    "intent_code = :intent_code, category = :category, domain = :domain, "
                    "intent_id = :intent_id, taxonomy_version = 'faq-taxonomy-v3' WHERE id = :id"
                ),
                {
                    "id": row["id"],
                    "course_code": course_code,
                    "course_name": course_name,
                    "intent_code": intent_code,
                    "category": intent_label(intent_code),
                    "domain": "course",
                    "intent_id": intent_id_for(course_code, intent_code),
                },
            )
        conn.execute(
            text(
                "UPDATE faq_query_logs SET "
                "course_code = COALESCE((SELECT course_code FROM faq_entries "
                "WHERE faq_entries.id = faq_query_logs.matched_faq_id), course_code), "
                "course_name = COALESCE((SELECT course_name FROM faq_entries "
                "WHERE faq_entries.id = faq_query_logs.matched_faq_id), course_name), "
                "intent_code = COALESCE((SELECT intent_code FROM faq_entries "
                "WHERE faq_entries.id = faq_query_logs.matched_faq_id), intent_code), "
                "domain = COALESCE((SELECT domain FROM faq_entries "
                "WHERE faq_entries.id = faq_query_logs.matched_faq_id), domain), "
                "intent_id = COALESCE((SELECT intent_id FROM faq_entries "
                "WHERE faq_entries.id = faq_query_logs.matched_faq_id), intent_id), "
                "taxonomy_version = CASE WHEN matched_faq_id IS NOT NULL "
                "THEN 'faq-taxonomy-v3' ELSE taxonomy_version END"
            )
        )
        conn.execute(
            text(
                "UPDATE faq_query_logs SET domain = 'course', "
                "intent_id = CASE WHEN course_code = 'general' "
                "THEN 'course.' || intent_code "
                "ELSE course_code || '.' || intent_code END, "
                "taxonomy_version = 'faq-taxonomy-v3' "
                "WHERE domain IN ('weekly_course', 'paid_course', 'general') "
                "AND intent_code NOT IN ('', 'unknown')"
            )
        )
        conn.execute(
            text(
                "UPDATE faq_query_logs SET course_code = '', course_name = '', "
                "intent_code = CASE "
                "WHEN intent_id = 'support.handoff' THEN 'handoff' "
                "WHEN intent_id = 'support.complaint' THEN 'complaint' "
                "WHEN intent_id = 'conversation.stop' THEN 'stop' "
                "ELSE intent_code END, "
                "taxonomy_version = 'faq-taxonomy-v3' "
                "WHERE domain IN ('support', 'conversation')"
            )
        )


def _backfill_fact_names() -> None:
    from app.faq.facts import derive_fact_name

    with engine.begin() as conn:
        rows = conn.execute(
            text(
                "SELECT id, fact_name, question, category, course_code, intent_code "
                "FROM faq_entries"
            )
        ).mappings()
        for row in rows:
            fact_name = (row["fact_name"] or "").strip()
            intent_code = row["intent_code"] or ""
            question = row["question"] or ""
            values: dict[str, str] = {"id": row["id"]}
            assignments: list[str] = []
            if not fact_name:
                values["fact_name"] = derive_fact_name(
                    question,
                    row["category"] or "",
                )
                assignments.append("fact_name = :fact_name")
            if "讲师" in question and intent_code != "instructor":
                course_code = row["course_code"] or "general"
                values.update(
                    {
                        "intent_code": "instructor",
                        "category": "讲师信息",
                        "intent_id": (
                            "course.general"
                            if course_code == "general"
                            else f"{course_code}.instructor"
                        ),
                    }
                )
                assignments.extend(
                    (
                        "intent_code = :intent_code",
                        "category = :category",
                        "intent_id = :intent_id",
                    )
                )
            if assignments:
                conn.execute(
                    text(
                        f"UPDATE faq_entries SET {', '.join(assignments)} "
                        "WHERE id = :id"
                    ),
                    values,
                )


def _retire_legacy_course_groups() -> None:
    from sqlalchemy import or_, update

    from app.models.entities import CourseDefinition, FAQEntry, IntentDefinition

    with SessionLocal() as db:
        for model in (CourseDefinition, IntentDefinition):
            db.execute(
                update(model)
                .where(
                    model.course_code.in_(("general", "conversation")),
                    or_(model.is_active.is_(True), model.is_deleted.is_(False)),
                )
                .values(is_active=False, is_deleted=True, version=model.version + 1)
            )
        db.execute(
            update(FAQEntry)
            .where(
                FAQEntry.course_code.in_(("general", "conversation")),
                FAQEntry.is_active.is_(True),
            )
            .values(is_active=False)
        )
        db.commit()


def _seed_intent_definitions() -> None:
    from sqlalchemy import select

    from app.intent.taxonomy import default_intent_definitions
    from app.models.entities import IntentDefinition, IntentEmbedding

    with SessionLocal() as db:
        stale_intent_id = "course.course_catalog"
        stale_embedding = db.get(IntentEmbedding, stale_intent_id)
        if stale_embedding:
            db.delete(stale_embedding)
        stale_definition = db.get(IntentDefinition, stale_intent_id)
        if stale_definition:
            db.delete(stale_definition)
        existing = set(db.scalars(select(IntentDefinition.intent_id)))
        changed = bool(stale_embedding or stale_definition)
        for payload in default_intent_definitions():
            if payload["intent_id"] in existing:
                continue
            db.add(IntentDefinition(**payload))
            changed = True
        if changed:
            db.commit()


def _seed_course_definitions() -> None:
    from sqlalchemy import select

    from app.intent.taxonomy import default_course_definitions
    from app.models.entities import CourseDefinition

    with SessionLocal() as db:
        existing = set(db.scalars(select(CourseDefinition.course_code)))
        changed = False
        for payload in default_course_definitions():
            if payload["course_code"] in existing:
                continue
            db.add(CourseDefinition(**payload))
            changed = True
        if changed:
            db.commit()
