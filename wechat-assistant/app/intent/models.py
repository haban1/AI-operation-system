from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class IntentDecisionType(StrEnum):
    accept = "ACCEPT"
    clarify = "CLARIFY"
    out_of_scope = "OUT_OF_SCOPE"
    reject = "REJECT"
    handoff = "HANDOFF"


class IntentSignalSource(StrEnum):
    rule = "RULE"
    exact = "EXACT"
    contains = "CONTAINS"
    similar = "SIMILAR"
    keyword = "KEYWORD"
    embedding = "EMBEDDING"
    semantic = "LLM_SEMANTIC"
    semantic_reject = "LLM_SEMANTIC_REJECT"
    grounded_answer = "LLM_GROUNDED_ANSWER"
    query_rewrite = "QUERY_REWRITE"


@dataclass(frozen=True)
class IntentCandidate:
    faq_id: str
    question: str
    course_code: str
    course_name: str
    intent_code: str
    domain: str
    intent_id: str
    score: float
    match_type: str
    risk_level: str
    handoff_required: bool
    fact_name: str = ""
    description: str = ""
    rrf_score: float | None = None
    lexical_score: float | None = None
    embedding_score: float | None = None
    lexical_rank: int | None = None
    embedding_rank: int | None = None

    def as_dict(self) -> dict:
        return {
            "faq_id": self.faq_id,
            "question": self.question,
            "fact_name": self.fact_name,
            "course_code": self.course_code,
            "course_name": self.course_name,
            "intent_code": self.intent_code,
            "domain": self.domain,
            "intent_id": self.intent_id,
            "score": round(self.score, 4),
            "match_type": self.match_type,
            "risk_level": self.risk_level,
            "handoff_required": self.handoff_required,
            "description": self.description,
            "rrf_score": (
                round(self.rrf_score, 4)
                if self.rrf_score is not None
                else None
            ),
            "lexical_score": (
                round(self.lexical_score, 4)
                if self.lexical_score is not None
                else None
            ),
            "embedding_score": (
                round(self.embedding_score, 4)
                if self.embedding_score is not None
                else None
            ),
            "lexical_rank": self.lexical_rank,
            "embedding_rank": self.embedding_rank,
        }


@dataclass(frozen=True)
class IntentDecision:
    course_code: str
    course_name: str
    intent_code: str
    domain: str
    intent_id: str
    decision: IntentDecisionType
    answer: str
    confidence: float
    margin: float
    candidates: list[IntentCandidate] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    matched_faq_id: str | None = None
    matched_question: str | None = None
    matched_fact_ids: list[str] = field(default_factory=list)
    matched_facts: list[dict] = field(default_factory=list)
    document_chunks: list[dict] = field(default_factory=list)
    match_type: str = "none"
    risk_level: str = "low"
    requires_confirmation: bool = False
    clarification_question: str | None = None
    router_version: str = "faq-router-v1"
    taxonomy_version: str = "faq-taxonomy-v3"
