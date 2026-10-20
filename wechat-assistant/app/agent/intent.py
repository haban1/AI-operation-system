from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import StrEnum
from zoneinfo import ZoneInfo

from app.core.llm import LLMClient


class IntentName(StrEnum):
    general = "general"
    course_content = "course_content"
    course_schedule = "course_schedule"


@dataclass(frozen=True)
class IntentResult:
    intent: IntentName
    confidence: float
    source: str
    fields: dict[str, str] = field(default_factory=dict)

    @property
    def is_certain(self) -> bool:
        return self.intent != IntentName.general and self.confidence >= 0.6


@dataclass(frozen=True)
class IntentExample:
    text: str
    intent: IntentName


EXAMPLES = [
    IntentExample("周六有什么课", IntentName.course_schedule),
    IntentExample("这个周末课程怎么安排", IntentName.course_schedule),
    IntentExample("Claude Code 实战什么时候上", IntentName.course_schedule),
    IntentExample("课程在哪里上课", IntentName.course_schedule),
    IntentExample("讲师是谁", IntentName.course_schedule),
    IntentExample("还有名额吗", IntentName.course_schedule),
    IntentExample("Claude Code 实战主要讲什么", IntentName.course_content),
    IntentExample("这门课的知识点有哪些", IntentName.course_content),
    IntentExample("课件里讲了项目初始化吗", IntentName.course_content),
    IntentExample("课程内容包括调试部署吗", IntentName.course_content),
]

WEEKDAY_ALIASES = {
    "周一": 1,
    "星期一": 1,
    "礼拜一": 1,
    "周二": 2,
    "星期二": 2,
    "礼拜二": 2,
    "周三": 3,
    "星期三": 3,
    "礼拜三": 3,
    "周四": 4,
    "星期四": 4,
    "礼拜四": 4,
    "周五": 5,
    "星期五": 5,
    "礼拜五": 5,
    "周六": 6,
    "星期六": 6,
    "礼拜六": 6,
    "周日": 7,
    "周天": 7,
    "星期日": 7,
    "星期天": 7,
    "礼拜日": 7,
    "礼拜天": 7,
}


class IntentRouter:
    def __init__(self, *, llm: LLMClient | None = None) -> None:
        self.llm = llm or LLMClient()
        self._example_embeddings: list[list[float]] | None = None

    def route(self, message: str) -> IntentResult:
        normalized = _normalize(message)
        fields = _extract_fields(message)
        rule_result = self._route_by_rules(normalized, fields)
        if rule_result:
            return rule_result

        vector_result = self._route_by_examples(normalized, fields)
        if vector_result.is_certain:
            return vector_result

        return self._route_by_llm(message, fields)

    def _route_by_rules(self, normalized: str, fields: dict[str, str]) -> IntentResult | None:
        direct_schedule_terms = (
            "排期",
            "课程安排",
            "上课安排",
            "有什么课",
            "有课",
        )
        if any(term in normalized for term in direct_schedule_terms):
            return IntentResult(IntentName.course_schedule, 0.9, "rule", fields)

        schedule_terms = (
            "什么时候",
            "几点",
            "哪天",
            "周几",
            "时间",
            "地点",
            "在哪",
            "在哪上",
            "哪里",
            "哪里上",
            "讲师",
            "老师",
            "名额",
        )
        course_context_terms = ("课", "课程", "上课", "教室", "班")
        if any(term in normalized for term in schedule_terms) and any(
            term in normalized for term in course_context_terms
        ):
            return IntentResult(IntentName.course_schedule, 0.9, "rule", fields)

        content_terms = ("主要讲", "课程内容", "课件", "知识点", "讲什么", "讲了什么", "包括", "学习什么", "总结")
        if any(term in normalized for term in content_terms):
            return IntentResult(IntentName.course_content, 0.9, "rule", fields)

        return None

    def _route_by_examples(self, normalized: str, fields: dict[str, str]) -> IntentResult:
        query_embedding = self.llm.embed([normalized])[0]
        example_embeddings = self._get_example_embeddings()
        scored = sorted(
            (
                (_cosine_similarity(query_embedding, example_embedding), example.intent)
                for example, example_embedding in zip(EXAMPLES, example_embeddings, strict=True)
            ),
            key=lambda item: item[0],
            reverse=True,
        )[:5]
        if not scored or scored[0][0] <= 0:
            return IntentResult(IntentName.general, 0.0, "vector", fields)

        top_score = scored[0][0]
        top_intent = scored[0][1]
        top5_intents = [intent for _, intent in scored]
        majority_intent, majority_count = Counter(top5_intents).most_common(1)[0]
        second_other = next((score for score, intent in scored if intent != top_intent), 0.0)

        if top_score >= 0.72 and majority_intent == top_intent and majority_count >= 3:
            return IntentResult(top_intent, min(0.9, top_score), "vector", fields)
        if top_score >= 0.48 and top_score - second_other >= 0.2:
            return IntentResult(top_intent, min(0.8, top_score), "vector", fields)
        return IntentResult(IntentName.general, top_score, "vector", fields)

    def _get_example_embeddings(self) -> list[list[float]]:
        if self._example_embeddings is None:
            self._example_embeddings = self.llm.embed([_normalize(example.text) for example in EXAMPLES])
        return self._example_embeddings

    def _route_by_llm(self, message: str, fields: dict[str, str]) -> IntentResult:
        prompt = (
            "请识别企业培训客服问题的意图，只输出 JSON。\n"
            "可选 intent: course_content, course_schedule, general。\n"
            "只把明确询问课程排期、上课时间、地点、讲师、名额的问题归为 course_schedule。\n"
            "只把明确询问课程内容、课件、知识点、课程讲什么的问题归为 course_content。\n"
            "身份、能力、问候、日期星期、闲聊、不支持范围、报名或不确定的问题都归为 general。\n"
            "同时提取 course_title、weekday 等关键字段；不确定时 intent=general。\n"
            f"用户问题：{message}"
        )
        raw = self.llm.chat(
            [
                {"role": "system", "content": "你是客服意图识别器，只输出紧凑 JSON。"},
                {"role": "user", "content": prompt},
            ]
        )
        try:
            data = json.loads(_extract_json(raw))
        except (TypeError, ValueError, json.JSONDecodeError):
            return IntentResult(IntentName.general, 0.3, "llm", fields)

        intent = data.get("intent", IntentName.general)
        try:
            intent_name = IntentName(intent)
        except ValueError:
            intent_name = IntentName.general
        confidence = float(data.get("confidence", 0.0) or 0.0)
        llm_fields = {key: str(value) for key, value in data.get("fields", {}).items() if value}
        merged_fields = {**fields, **llm_fields}
        if confidence >= 0.6 and intent_name != IntentName.general:
            return IntentResult(intent_name, confidence, "llm", merged_fields)
        return IntentResult(IntentName.general, confidence, "llm", merged_fields)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", "", text.lower())


def _extract_fields(message: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for alias, weekday in WEEKDAY_ALIASES.items():
        if alias in message:
            fields["weekday"] = str(weekday)
            fields["day_label"] = alias
            break

    title_match = re.search(r"[《<](.*?)[》>]", message)
    if title_match:
        fields["course_title"] = title_match.group(1).strip()
    fields.update(_extract_date_fields(message, today=_today_date()))
    return fields


def _extract_date_fields(message: str, *, today: date) -> dict[str, str]:
    normalized = _normalize(message)
    fields: dict[str, str] = {}

    if "今天" in normalized or "今日" in normalized:
        fields["schedule_date"] = today.isoformat()
        return fields
    if "明天" in normalized or "明日" in normalized:
        fields["schedule_date"] = (today + timedelta(days=1)).isoformat()
        return fields
    if "后天" in normalized:
        fields["schedule_date"] = (today + timedelta(days=2)).isoformat()
        return fields

    if "周末" in normalized or "星期末" in normalized:
        monday = today - timedelta(days=today.isoweekday() - 1)
        fields["date_start"] = (monday + timedelta(days=5)).isoformat()
        fields["date_end"] = (monday + timedelta(days=6)).isoformat()
        return fields

    if "本周" in normalized or "这周" in normalized or "这一周" in normalized:
        monday = today - timedelta(days=today.isoweekday() - 1)
        fields["date_start"] = monday.isoformat()
        fields["date_end"] = (monday + timedelta(days=6)).isoformat()
        return fields

    iso_match = re.search(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?", message)
    if iso_match:
        parsed = _safe_date(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))
        if parsed:
            fields["schedule_date"] = parsed.isoformat()
            return fields

    month_day_match = re.search(r"(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]?", message)
    if month_day_match:
        month = int(month_day_match.group(1))
        day = int(month_day_match.group(2))
        parsed = _safe_date(today.year, month, day)
        if parsed and parsed < today:
            parsed = _safe_date(today.year + 1, month, day)
        if parsed:
            fields["schedule_date"] = parsed.isoformat()
    return fields


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _today_date() -> date:
    from datetime import datetime

    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    dot = sum(left_value * right_value for left_value, right_value in zip(left, right, strict=True))
    return dot / (left_norm * right_norm)


def _extract_json(raw: str) -> str:
    match = re.search(r"\{.*\}", raw, flags=re.S)
    return match.group(0) if match else raw
