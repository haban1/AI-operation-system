from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models.entities import MaterialStatus, Role


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    username: str
    password: str


class UserCreate(BaseModel):
    username: str
    password: str
    role: Role = Role.student


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    username: str
    role: Role
    permission_version: int


class CourseCreate(BaseModel):
    title: str
    description: str = ""


class CourseRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    description: str
    owner_id: str
    created_at: datetime


class CourseScheduleCreate(BaseModel):
    schedule_date: str = ""
    weekday: int | None = None
    day_label: str = ""
    start_time: str = ""
    end_time: str = ""
    location: str = ""
    instructor: str = ""
    capacity: int | None = None


class CourseScheduleUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    schedule_date: str | None = None
    weekday: int | None = None
    day_label: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    location: str | None = None
    instructor: str | None = None
    capacity: int | None = None


class CourseScheduleRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    schedule_date: str
    weekday: int | None
    day_label: str
    start_time: str
    end_time: str
    location: str
    instructor: str
    capacity: int | None
    created_at: datetime


class CourseWithSchedules(CourseRead):
    schedules: list[CourseScheduleRead] = []


class MaterialRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    filename: str
    version: int
    status: MaterialStatus
    error_message: str
    created_at: datetime


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


class Citation(BaseModel):
    chunk_id: str
    material_id: str
    page_or_slide: str
    score: float
    filename: str = ""


class ChatResponse(BaseModel):
    session_id: str
    answer: str
    used_general_knowledge: bool
    llm_used: bool = False
    tool_rounds: int = 0
    tool_call_count: int = 0
    tool_stop_reason: str = "direct_reply"
    tool_trace: list[dict] = Field(default_factory=list)
    rewrite_used: bool = False
    original_query: str = ""
    retrieval_queries: list[list[str]] = Field(default_factory=list)
    rewrite_strategies: list[list[str]] = Field(default_factory=list)
    rewrite_version: str = "faq-query-rewrite-v1"
    question_count: int = 1
    sub_questions: list[dict] = Field(default_factory=list)
    intent: str
    intent_source: str
    citations: list[Citation]
    matched_faq_id: str | None = None
    matched_question: str | None = None
    matched_fact_ids: list[str] = Field(default_factory=list)
    matched_facts: list[dict] = Field(default_factory=list)
    match_score: float = 0.0
    match_type: str = "none"
    course_code: str = "unknown"
    course_name: str = "未识别"
    intent_code: str = "unknown"
    domain: str = "unknown"
    decision: str = "OUT_OF_SCOPE"
    confidence: float = 0.0
    margin: float = 0.0
    candidates: list[dict] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    risk_level: str = "low"
    requires_confirmation: bool = False
    clarification_question: str | None = None
    router_version: str = "faq-router-v1"
    taxonomy_version: str = "faq-taxonomy-v3"


class ChatMessageRead(BaseModel):
    role: str
    content: str
    created_at: datetime


class ChatSessionRead(BaseModel):
    id: str
    messages: list[ChatMessageRead]


class FAQCreate(BaseModel):
    fact_name: str = ""
    question: str | None = None
    answer: str
    image_url: str = ""
    aliases: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    course_code: str = ""
    course_name: str = ""
    intent_code: str = ""
    category: str = ""
    domain: str = ""
    intent_id: str = ""
    risk_level: str = "low"
    handoff_required: bool = False
    is_active: bool = True
    priority: int = 0


class FAQUpdate(BaseModel):
    fact_name: str | None = None
    question: str | None = None
    answer: str | None = None
    image_url: str | None = None
    aliases: list[str] | None = None
    keywords: list[str] | None = None
    course_code: str | None = None
    course_name: str | None = None
    intent_code: str | None = None
    category: str | None = None
    domain: str | None = None
    intent_id: str | None = None
    risk_level: str | None = None
    handoff_required: bool | None = None
    is_active: bool | None = None
    priority: int | None = None


class FAQRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    fact_name: str
    question: str
    answer: str
    image_url: str
    image_filename: str
    image_content_type: str
    aliases: list[str]
    keywords: list[str]
    course_code: str
    course_name: str
    intent_code: str
    category: str
    domain: str
    intent_id: str
    risk_level: str
    handoff_required: bool
    taxonomy_version: str
    is_active: bool
    priority: int
    hit_count: int
    created_at: datetime
    updated_at: datetime


class FAQQueryLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    question: str
    original_query: str
    retrieval_queries: list[str]
    rewrite_strategies: list[str]
    rewrite_version: str
    matched_faq_id: str | None
    matched_fact_ids: list[str]
    matched_facts: list[dict]
    match_score: float
    margin: float
    decision: str
    course_code: str
    course_name: str
    intent_code: str
    domain: str
    intent_id: str
    match_type: str
    candidates: list[dict]
    sources: list[str]
    router_version: str
    taxonomy_version: str
    corrected_faq_id: str | None
    correction_note: str
    review_status: str
    created_at: datetime


class FAQImportResult(BaseModel):
    created: int
    updated: int
    skipped: int


class FAQEmbeddingRefreshResult(BaseModel):
    total: int
    available: int
    model: str


class FAQTaxonomyOption(BaseModel):
    code: str
    label: str


class FAQTaxonomyRead(BaseModel):
    domains: list[FAQTaxonomyOption]
    courses: list[FAQTaxonomyOption]
    intents: list[FAQTaxonomyOption]
    version: str = "faq-taxonomy-v3"


class CourseDefinitionCreate(BaseModel):
    course_code: str
    display_name: str
    description: str = ""
    aliases: list[str] = Field(default_factory=list)
    is_active: bool = True


class CourseDefinitionUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    aliases: list[str] | None = None
    is_active: bool | None = None


class CourseDefinitionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    course_code: str
    display_name: str
    description: str
    aliases: list[str]
    is_active: bool
    version: int
    created_at: datetime
    updated_at: datetime


class CourseIntentCreate(BaseModel):
    course_code: str
    intent_code: str
    display_name: str
    description: str = ""
    positive_examples: list[str] = Field(default_factory=list)
    negative_examples: list[str] = Field(default_factory=list)
    risk_level: str = "low"
    is_active: bool = True


class CourseIntentUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    positive_examples: list[str] | None = None
    negative_examples: list[str] | None = None
    risk_level: str | None = None
    is_active: bool | None = None


class CourseIntentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    intent_id: str
    domain: str
    course_code: str
    course_name: str
    intent_code: str
    display_name: str
    description: str
    positive_examples: list[str]
    negative_examples: list[str]
    risk_level: str
    is_active: bool
    version: int
    created_at: datetime
    updated_at: datetime


class FAQCorrectionRequest(BaseModel):
    corrected_faq_id: str | None = None
    correction_note: str = ""
    add_as_alias: bool = False
