import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest


def test_legacy_faq_questions_are_migrated_to_named_facts(tmp_path):
    database_path = tmp_path / "legacy.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            CREATE TABLE faq_entries (
                id VARCHAR(32) PRIMARY KEY,
                question VARCHAR(500) NOT NULL UNIQUE,
                answer TEXT NOT NULL,
                aliases JSON NOT NULL DEFAULT '[]',
                keywords JSON NOT NULL DEFAULT '[]',
                course_code VARCHAR(60) NOT NULL DEFAULT 'general',
                course_name VARCHAR(100) NOT NULL DEFAULT '通用咨询',
                intent_code VARCHAR(80) NOT NULL DEFAULT 'general',
                category VARCHAR(100) NOT NULL DEFAULT '',
                domain VARCHAR(100) NOT NULL DEFAULT 'course',
                intent_id VARCHAR(160) NOT NULL DEFAULT 'course.general',
                risk_level VARCHAR(20) NOT NULL DEFAULT 'low',
                handoff_required BOOLEAN NOT NULL DEFAULT FALSE,
                taxonomy_version VARCHAR(40) NOT NULL DEFAULT 'faq-taxonomy-v3',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                priority INTEGER NOT NULL DEFAULT 0,
                hit_count INTEGER NOT NULL DEFAULT 0,
                created_by_id VARCHAR(32),
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE intent_definitions (
                intent_id VARCHAR(160) PRIMARY KEY,
                domain VARCHAR(100) NOT NULL,
                course_code VARCHAR(60) NOT NULL,
                course_name VARCHAR(100) NOT NULL,
                intent_code VARCHAR(80) NOT NULL,
                display_name VARCHAR(120) NOT NULL,
                description TEXT NOT NULL,
                positive_examples JSON NOT NULL DEFAULT '[]',
                negative_examples JSON NOT NULL DEFAULT '[]',
                confusing_intents JSON NOT NULL DEFAULT '[]',
                risk_level VARCHAR(20) NOT NULL DEFAULT 'low',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE intent_embeddings (
                intent_id VARCHAR(160) PRIMARY KEY,
                model VARCHAR(100) NOT NULL,
                source_hash VARCHAR(64) NOT NULL,
                dimension INTEGER NOT NULL,
                vector JSON NOT NULL,
                updated_at TIMESTAMP
            )
            """
        )
        connection.execute(
            """
            INSERT INTO faq_entries (
                id, question, answer, course_code, course_name, intent_code,
                category, domain, intent_id
            ) VALUES (
                'legacy-fact', '本期讲师是谁？', '本期讲师为 Thomas Zhang。',
                'weekly_course', '周周有课', 'course_content',
                '课程内容', 'course', 'weekly_course.course_content'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO intent_definitions (
                intent_id, domain, course_code, course_name, intent_code,
                display_name, description
            ) VALUES (
                'course.course_catalog', 'course', 'general', '跨课程咨询',
                'course_catalog', '课程类型', '旧的伪课程目录意图'
            )
            """
        )
        connection.execute(
            """
            INSERT INTO intent_embeddings (
                intent_id, model, source_hash, dimension, vector
            ) VALUES (
                'course.course_catalog', 'legacy-model', 'legacy-hash', 2,
                '[1.0, 0.0]'
            )
            """
        )
        connection.commit()

    environment = os.environ.copy()
    environment["DATABASE_URL"] = f"sqlite:///{database_path.as_posix()}"
    subprocess.run(
        [
            sys.executable,
            "-c",
            "from app.core.database import create_all; create_all()",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )

    with sqlite3.connect(database_path) as connection:
        row = connection.execute(
            """
            SELECT fact_name, question, intent_code, category, intent_id
            FROM faq_entries WHERE id = 'legacy-fact'
            """
        ).fetchone()
        stale_definition_count = connection.execute(
            """
            SELECT COUNT(*) FROM intent_definitions
            WHERE intent_id = 'course.course_catalog'
            """
        ).fetchone()[0]
        stale_embedding_count = connection.execute(
            """
            SELECT COUNT(*) FROM intent_embeddings
            WHERE intent_id = 'course.course_catalog'
            """
        ).fetchone()[0]
        course_definitions = {
            row[0]
            for row in connection.execute(
                "SELECT course_code FROM course_definitions"
            ).fetchall()
        }
        intent_columns = {
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(intent_definitions)"
            ).fetchall()
        }
        course_columns = {
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(course_definitions)"
            ).fetchall()
        }
        faq_columns = {
            row[1]
            for row in connection.execute(
                "PRAGMA table_info(faq_entries)"
            ).fetchall()
        }

    assert row == (
        "本期讲师",
        "本期讲师是谁？",
        "instructor",
        "讲师信息",
        "weekly_course.instructor",
    )
    assert stale_definition_count == 0
    assert stale_embedding_count == 0
    assert not {"general", "conversation"} & course_definitions
    assert {"weekly_course", "paid_course"}.issubset(
        course_definitions
    )
    assert "is_deleted" in intent_columns
    assert "is_deleted" in course_columns
    assert "image_url" in faq_columns


@pytest.mark.parametrize("course_code,intent_id", [
    ("general", "course.general"), ("conversation", "conversation.greeting"),
])
def test_retired_groups_stay_removed_without_deleting_facts(db, monkeypatch, course_code, intent_id):
    from sqlalchemy.orm import sessionmaker

    from app.core import database
    from app.intent.service import IntentService
    from app.models.entities import CourseDefinition, FAQEntry, IntentDefinition

    course = CourseDefinition(
        course_code=course_code, display_name="旧分组", description="旧分组",
    )
    intent = IntentDefinition(
        intent_id=intent_id, course_code=course_code, course_name="旧分组",
        intent_code="general", display_name="其他咨询", description="旧意图",
    )
    fact = FAQEntry(
        id="legacy-general-fact", question="旧的通用问题", answer="保留历史内容",
        course_code=course_code, intent_id=intent_id,
    )
    normal_course = CourseDefinition(
        course_code="weekly_course", display_name="周周有课", description="正常课程",
    )
    db.add_all([course, intent, fact, normal_course])
    db.commit()
    monkeypatch.setattr(database, "SessionLocal", sessionmaker(bind=db.get_bind()))

    # Repeated startup and on-demand seeding must not restore the retired group.
    for _ in range(2):
        database._retire_legacy_course_groups()
        IntentService().ensure_default_definitions(db)
    db.expire_all()

    assert course.is_deleted and not course.is_active
    assert intent.is_deleted and not intent.is_active
    assert course.version == intent.version == 2
    assert db.get(FAQEntry, "legacy-general-fact").answer == "保留历史内容"
    assert not fact.is_active
    assert normal_course.is_active and not normal_course.is_deleted
    assert normal_course.version == 1
