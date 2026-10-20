from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def new_id() -> str:
    return uuid4().hex


def utcnow() -> datetime:
    return datetime.now(UTC)


class Role(StrEnum):
    admin = "admin"
    teacher = "teacher"
    student = "student"


class MaterialStatus(StrEnum):
    pending = "pending"
    processing = "processing"
    ready = "ready"
    failed = "failed"


class MessageRole(StrEnum):
    user = "user"
    assistant = "assistant"
    system = "system"


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.student)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    permission_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WeComUserBinding(Base):
    __tablename__ = "wecom_user_bindings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    wecom_user_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    active_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("chat_sessions.id"),
        index=True,
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship()


class WeComMessageReceipt(Base):
    __tablename__ = "wecom_message_receipts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    msg_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    from_user: Mapped[str] = mapped_column(String(128), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WechatRobotUserBinding(Base):
    __tablename__ = "wechat_robot_user_bindings"
    __table_args__ = (
        UniqueConstraint(
            "robot_wxid",
            "conversation_key",
            name="uq_wechat_robot_conversation",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    robot_wxid: Mapped[str] = mapped_column(String(128), default="default", index=True)
    conversation_key: Mapped[str] = mapped_column(String(300))
    peer_wxid: Mapped[str] = mapped_column(String(128), default="", index=True)
    room_wxid: Mapped[str] = mapped_column(String(128), default="", index=True)
    active_session_id: Mapped[str | None] = mapped_column(
        ForeignKey("chat_sessions.id"),
        index=True,
        nullable=True,
    )
    greeted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    handoff_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    handoff_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    handoff_resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    handoff_reason: Mapped[str] = mapped_column(Text, default="")
    handoff_last_message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    user: Mapped[User] = relationship()


class WechatRobotMessageReceipt(Base):
    __tablename__ = "wechat_robot_message_receipts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    receipt_key: Mapped[str] = mapped_column(String(300), unique=True, index=True)
    msg_id: Mapped[str] = mapped_column(String(128), default="", index=True)
    robot_wxid: Mapped[str] = mapped_column(String(128), default="default", index=True)
    from_wxid: Mapped[str] = mapped_column(String(128), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class WechatRobotOutboundReceipt(Base):
    __tablename__ = "wechat_robot_outbound_receipts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    robot_wxid: Mapped[str] = mapped_column(String(128), default="", index=True)
    to_wxid: Mapped[str] = mapped_column(String(128), index=True)
    msg_type: Mapped[int] = mapped_column(Integer, index=True)
    content_hash: Mapped[str] = mapped_column(String(64), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        index=True,
    )


class WechatRobotHandoffNotifier(Base):
    __tablename__ = "wechat_robot_handoff_notifiers"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    recipient_wxid: Mapped[str] = mapped_column(
        String(128),
        default="",
        index=True,
    )
    recipient_name: Mapped[str] = mapped_column(String(200), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
    )


class WechatRobotBroadcast(Base):
    __tablename__ = "wechat_robot_broadcasts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    client_request_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    content: Mapped[str] = mapped_column(Text)
    recipient_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    image_data: Mapped[bytes] = mapped_column(LargeBinary)
    image_filename: Mapped[str] = mapped_column(String(255), default="")
    image_content_type: Mapped[str] = mapped_column(String(120), default="image/jpeg")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    recipient_count: Mapped[int] = mapped_column(Integer, default=0)
    text_sent_count: Mapped[int] = mapped_column(Integer, default=0)
    image_sent_count: Mapped[int] = mapped_column(Integer, default=0)
    success_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    error_details: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


class FAQEntry(Base):
    __tablename__ = "faq_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    fact_name: Mapped[str] = mapped_column(String(200), default="", index=True)
    question: Mapped[str] = mapped_column(String(500), unique=True, index=True)
    answer: Mapped[str] = mapped_column(Text)
    image_url: Mapped[str] = mapped_column(String(1000), default="")
    image_data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    image_filename: Mapped[str] = mapped_column(String(255), default="")
    image_content_type: Mapped[str] = mapped_column(String(120), default="")
    aliases: Mapped[list[str]] = mapped_column(JSON, default=list)
    keywords: Mapped[list[str]] = mapped_column(JSON, default=list)
    course_code: Mapped[str] = mapped_column(String(60), default="general", index=True)
    course_name: Mapped[str] = mapped_column(String(100), default="通用咨询", index=True)
    intent_code: Mapped[str] = mapped_column(String(80), default="general", index=True)
    category: Mapped[str] = mapped_column(String(100), default="", index=True)
    domain: Mapped[str] = mapped_column(String(100), default="course", index=True)
    intent_id: Mapped[str] = mapped_column(String(160), default="course.general", index=True)
    risk_level: Mapped[str] = mapped_column(String(20), default="low")
    handoff_required: Mapped[bool] = mapped_column(Boolean, default=False)
    taxonomy_version: Mapped[str] = mapped_column(String(40), default="faq-taxonomy-v3")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    priority: Mapped[int] = mapped_column(Integer, default=0)
    hit_count: Mapped[int] = mapped_column(Integer, default=0)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    created_by: Mapped[User | None] = relationship()


class FAQEmbedding(Base):
    __tablename__ = "faq_embeddings"

    faq_id: Mapped[str] = mapped_column(
        ForeignKey("faq_entries.id", ondelete="CASCADE"),
        primary_key=True,
    )
    model: Mapped[str] = mapped_column(String(100), index=True)
    source_hash: Mapped[str] = mapped_column(String(64))
    dimension: Mapped[int] = mapped_column(Integer)
    vector: Mapped[list[float]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
    )

    faq: Mapped[FAQEntry] = relationship()


class CourseDefinition(Base):
    __tablename__ = "course_definitions"

    course_code: Mapped[str] = mapped_column(String(60), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(100), index=True)
    description: Mapped[str] = mapped_column(Text)
    aliases: Mapped[list[str]] = mapped_column(JSON, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
    )


class IntentDefinition(Base):
    __tablename__ = "intent_definitions"

    intent_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    domain: Mapped[str] = mapped_column(String(100), default="course", index=True)
    course_code: Mapped[str] = mapped_column(String(60), index=True)
    course_name: Mapped[str] = mapped_column(String(100), index=True)
    intent_code: Mapped[str] = mapped_column(String(80), index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text)
    positive_examples: Mapped[list[str]] = mapped_column(JSON, default=list)
    negative_examples: Mapped[list[str]] = mapped_column(JSON, default=list)
    confusing_intents: Mapped[list[str]] = mapped_column(JSON, default=list)
    risk_level: Mapped[str] = mapped_column(String(20), default="low")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
    )


class IntentEmbedding(Base):
    __tablename__ = "intent_embeddings"

    intent_id: Mapped[str] = mapped_column(
        ForeignKey("intent_definitions.intent_id", ondelete="CASCADE"),
        primary_key=True,
    )
    model: Mapped[str] = mapped_column(String(100), index=True)
    source_hash: Mapped[str] = mapped_column(String(64))
    dimension: Mapped[int] = mapped_column(Integer)
    vector: Mapped[list[float]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
    )

    intent: Mapped[IntentDefinition] = relationship()


class FAQQueryLog(Base):
    __tablename__ = "faq_query_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    question: Mapped[str] = mapped_column(String(1000))
    original_query: Mapped[str] = mapped_column(String(1000), default="")
    retrieval_queries: Mapped[list[str]] = mapped_column(JSON, default=list)
    rewrite_strategies: Mapped[list[str]] = mapped_column(JSON, default=list)
    rewrite_version: Mapped[str] = mapped_column(String(40), default="faq-query-rewrite-v1")
    matched_faq_id: Mapped[str | None] = mapped_column(ForeignKey("faq_entries.id"), nullable=True, index=True)
    matched_fact_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    matched_facts: Mapped[list[dict]] = mapped_column(JSON, default=list)
    match_score: Mapped[float] = mapped_column(Float, default=0.0)
    margin: Mapped[float] = mapped_column(Float, default=0.0)
    decision: Mapped[str] = mapped_column(String(30), default="OUT_OF_SCOPE", index=True)
    course_code: Mapped[str] = mapped_column(String(60), default="general", index=True)
    course_name: Mapped[str] = mapped_column(String(100), default="通用咨询", index=True)
    intent_code: Mapped[str] = mapped_column(String(80), default="general", index=True)
    domain: Mapped[str] = mapped_column(String(100), default="general", index=True)
    intent_id: Mapped[str] = mapped_column(String(160), default="unknown", index=True)
    match_type: Mapped[str] = mapped_column(String(30), default="none")
    candidates: Mapped[list[dict]] = mapped_column(JSON, default=list)
    sources: Mapped[list[str]] = mapped_column(JSON, default=list)
    router_version: Mapped[str] = mapped_column(String(40), default="faq-router-v1")
    taxonomy_version: Mapped[str] = mapped_column(String(40), default="faq-taxonomy-v3")
    corrected_faq_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    correction_note: Mapped[str] = mapped_column(Text, default="")
    review_status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    owner: Mapped[User] = relationship()


class CourseSchedule(Base):
    __tablename__ = "course_schedules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    course_id: Mapped[str] = mapped_column(ForeignKey("courses.id"), index=True)
    schedule_date: Mapped[str] = mapped_column(String(10), default="", index=True)
    weekday: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    day_label: Mapped[str] = mapped_column(String(40), default="")
    start_time: Mapped[str] = mapped_column(String(20), default="")
    end_time: Mapped[str] = mapped_column(String(20), default="")
    location: Mapped[str] = mapped_column(String(200), default="")
    instructor: Mapped[str] = mapped_column(String(100), default="")
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    course: Mapped[Course] = relationship()


class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    filename: Mapped[str] = mapped_column(String(255))
    content: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    uploaded_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), default="processing")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    error_message: Mapped[str] = mapped_column(Text, default="")
    index_mode: Mapped[str] = mapped_column(String(20), default="keyword")
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    document_id: Mapped[str] = mapped_column(ForeignKey("knowledge_documents.id"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    location: Mapped[str] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list] = mapped_column(JSON, default=list)
    embedding_model: Mapped[str] = mapped_column(String(200), default="")


class Material(Base):
    __tablename__ = "materials"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"), index=True, nullable=True)
    uploaded_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120), default="")
    path: Mapped[str] = mapped_column(String(500))
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[MaterialStatus] = mapped_column(Enum(MaterialStatus), default=MaterialStatus.pending)
    error_message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class MaterialChunk(Base):
    __tablename__ = "material_chunks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"), index=True, nullable=True)
    material_id: Mapped[str] = mapped_column(ForeignKey("materials.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    chunk_index: Mapped[int] = mapped_column(Integer)
    page_or_slide: Mapped[str] = mapped_column(String(80), default="")
    text: Mapped[str] = mapped_column(Text)
    milvus_pk: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    course_id: Mapped[str | None] = mapped_column(ForeignKey("courses.id"), index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    id: Mapped[str] = mapped_column(String(32), unique=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("chat_sessions.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[MessageRole] = mapped_column(Enum(MessageRole))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(120))
    resource_type: Mapped[str] = mapped_column(String(120), default="")
    resource_id: Mapped[str] = mapped_column(String(120), default="")
    detail: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
