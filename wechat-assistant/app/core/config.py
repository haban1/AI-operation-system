from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    tianhe_ai_enabled: bool = False
    tianhe_ai_base_url: str = "http://web:3100/api/model/v1"
    tianhe_model_token: str = ""
    tianhe_knowledge_enabled: bool = False
    tianhe_rag_base_url: str = ""
    tianhe_rag_token: str = ""
    tianhe_rag_timeout_seconds: float = 60.0
    tianhe_admin_token: str = ""
    tianhe_admin_url: str = "http://127.0.0.1:3100"
    secret_key: str = "change-me-in-production"
    access_token_expire_minutes: int = 1440

    database_url: str = "sqlite:///./agent.db"

    llm_enabled: bool = True
    assistant_role_prompt: str = (
        "你是课程客服智能助教，帮助用户了解课程、解答课程相关问题，"
        "并在用户需要时协助转接人工客服。表达简洁、自然、友好。"
        "如被问到身份，如实说明自己是智能助教，不冒充真人。"
    )
    dashscope_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    dashscope_api_key: str = ""
    dashscope_chat_model: str = "qwen-plus"
    dashscope_embedding_base_url: str = ""
    dashscope_embedding_api_key: str = ""
    dashscope_embedding_model: str = "text-embedding-v4"
    dashscope_embedding_dimensions: int = 1024
    dashscope_embedding_batch_size: int = 10
    llm_timeout_seconds: float = 20.0
    llm_max_questions: int = 5
    llm_max_tool_rounds: int = Field(default=3, ge=1, le=10)
    llm_max_tool_calls: int = Field(default=8, ge=1, le=50)
    llm_tool_followup_timeout_seconds: float = Field(default=45.0, gt=0, le=120)
    query_rewrite_enabled: bool = True
    query_rewrite_history_turns: int = 6
    query_rewrite_max_variants: int = 2
    query_rewrite_fusion_bonus: float = 0.02
    query_rewrite_version: str = "faq-query-rewrite-v1"

    short_term_memory_turns: int = 30
    document_max_upload_mb: int = Field(default=20, ge=1, le=100)
    document_embedding_enabled: bool = True
    document_retrieval_top_k: int = Field(default=6, ge=1, le=15)
    document_embedding_min_similarity: float = Field(default=0.45, ge=0, le=1)
    faq_embedding_enabled: bool = True
    faq_embedding_min_similarity: float = 0.58
    faq_embedding_accept_threshold: float = 0.62
    faq_embedding_margin_threshold: float = 0.08
    faq_embedding_high_risk_accept_threshold: float = 0.72
    faq_embedding_high_risk_margin_threshold: float = 0.12
    faq_grounded_generation_enabled: bool = True
    faq_grounded_answer_max_chars: int = 800
    faq_match_threshold: float = 0.62
    faq_accept_threshold: float = 0.78
    faq_clarify_threshold: float = 0.58
    faq_margin_threshold: float = 0.12
    faq_high_risk_accept_threshold: float = 0.88
    faq_high_risk_margin_threshold: float = 0.18
    faq_candidate_limit: int = 3
    faq_semantic_candidate_limit: int = 20
    faq_semantic_accept_threshold: float = 0.78
    faq_semantic_high_risk_accept_threshold: float = 0.9
    faq_fact_candidate_limit: int = 10
    faq_fact_answer_limit: int = 5
    faq_fact_min_similarity: float = 0.42
    faq_fact_relative_margin: float = 0.12
    faq_rrf_enabled: bool = True
    faq_rrf_k: int = 60
    faq_rrf_text_weight: float = 1.0
    faq_rrf_vector_weight: float = 1.0
    faq_rrf_pool_limit: int = 20
    intent_course_recall_threshold: float = 0.42
    intent_course_accept_threshold: float = 0.78
    intent_course_margin_threshold: float = 0.12
    intent_text_min_similarity: float = 0.42
    intent_embedding_min_similarity: float = 0.58
    intent_accept_threshold: float = 0.72
    intent_clarify_threshold: float = 0.55
    intent_margin_threshold: float = 0.08
    intent_semantic_accept_threshold: float = 0.78
    intent_candidate_limit: int = 5
    intent_candidate_pool_limit: int = 20
    intent_rrf_k: int = 60
    intent_rrf_text_weight: float = 1.0
    intent_rrf_vector_weight: float = 1.0
    intent_consensus_bonus: float = 0.04
    faq_router_version: str = "faq-router-v1"
    faq_taxonomy_version: str = "faq-taxonomy-v3"

    wecom_corp_id: str = ""
    wecom_agent_id: str = ""
    wecom_secret: str = ""
    wecom_token: str = ""
    wecom_encoding_aes_key: str = ""
    wecom_kf_token: str = ""
    wecom_kf_encoding_aes_key: str = ""
    wecom_kf_open_kfid: str = ""
    wecom_kf_handoff_servicer_userid: str = ""
    wecom_kf_poll_enabled: bool = True
    wecom_kf_poll_interval_seconds: float = 5.0

    wechat_robot_base_url: str = "http://127.0.0.1:9001"
    wechat_robot_media_base_url: str = "http://127.0.0.1:8000"
    wechat_robot_api_authorization: str = ""
    wechat_robot_webhook_secret: str = ""
    wechat_robot_request_timeout_seconds: float = 30.0
    wechat_robot_auto_reply_enabled: bool = True
    wechat_robot_group_reply_mode: str = "mention"
    wechat_robot_greeting_enabled: bool = True
    wechat_robot_greeting_text: str = "你好，我是课程客服助手。请问有什么可以帮你？"
    wechat_robot_handoff_message: str = "已为你转接人工客服，请稍候。"
    wechat_robot_handoff_auto_resume_hours: float = 24.0
    wechat_robot_mass_send_max_recipients: int = 50
    wechat_robot_broadcast_max_recipients: int = 500
    wechat_robot_broadcast_interval_seconds: float = 0.8

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8-sig", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
