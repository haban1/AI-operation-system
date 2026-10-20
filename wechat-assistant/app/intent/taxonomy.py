from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TaxonomyValue:
    code: str
    label: str


@dataclass(frozen=True)
class CourseProfile:
    code: str
    label: str
    description: str
    aliases: tuple[str, ...]


DOMAINS = (
    TaxonomyValue("course", "课程咨询"),
    TaxonomyValue("support", "客服支持"),
)

COURSES = (
    TaxonomyValue("weekly_course", "周周有课"),
    TaxonomyValue("paid_course", "付费课程"),
)

INTENTS = (
    TaxonomyValue("course_content", "课程内容"),
    TaxonomyValue("schedule_location", "时间地点"),
    TaxonomyValue("registration", "报名方式"),
    TaxonomyValue("pricing", "费用说明"),
    TaxonomyValue("audience", "适合人群"),
    TaxonomyValue("preparation", "上课准备"),
    TaxonomyValue("materials_support", "资料与服务"),
    TaxonomyValue("instructor", "讲师信息"),
    TaxonomyValue("general", "其他咨询"),
)

COURSE_LABELS = {item.code: item.label for item in COURSES}
# Keep historical records readable without offering this retired course group.
COURSE_LABELS["general"] = "跨课程咨询"
COURSE_LABELS["conversation"] = "对话服务"
INTENT_LABELS = {item.code: item.label for item in INTENTS}
INTENT_LABELS.update(greeting="打招呼", company_profile="公司介绍")

COURSE_PROFILES = (
    CourseProfile(
        code="weekly_course",
        label="周周有课",
        description="每周举办的公开体验课程、本周课程或周六课程。",
        aliases=(
            "周周有课",
            "周六课",
            "本周课程",
            "本期课程",
            "公开课",
            "体验课",
            "Claude Code课程",
            "Claude Code",
            "AI实战课",
        ),
    ),
    CourseProfile(
        code="paid_course",
        label="付费课程",
        description="需要付费报名的进阶课程、长期班、训练营或系统课程。",
        aliases=("付费课程", "进阶课程", "长期班", "训练营", "系统课"),
    ),
)

COURSE_PROFILE_BY_CODE = {item.code: item for item in COURSE_PROFILES}

INTENT_PROFILES = {
    "course_content": {
        "description": "用户询问课程主题、教学内容、实操内容、课程大纲或学习成果。",
        "positive_examples": (
            "这门课主要讲什么",
            "能学到哪些内容",
            "课程大纲是什么",
            "有没有实操",
            "会实操吗",
            "课程主要学什么",
            "培训会教什么东西",
            "上完课能掌握什么",
        ),
        "negative_examples": ("什么时候上课", "在哪里上课", "怎么报名", "课程多少钱"),
    },
    "schedule_location": {
        "description": "用户询问课程日期、时间、时长、地点、交通或具体安排。",
        "positive_examples": (
            "什么时候上课",
            "在哪里上课",
            "课程要上多久",
            "这周六有课吗",
            "上课地址在哪里",
        ),
        "negative_examples": ("课程讲什么", "怎么报名", "课程多少钱"),
    },
    "registration": {
        "description": "用户询问报名入口、报名流程、报名条件、名额或报名后的确认方式。",
        "positive_examples": (
            "怎么报名",
            "报名入口在哪里",
            "现在还能报名吗",
            "报名有什么条件",
            "可以带朋友一起参加吗",
        ),
        "negative_examples": ("课程讲什么", "什么时候上课", "课程多少钱"),
    },
    "pricing": {
        "description": "用户询问课程价格、收费方式、退款或模型使用费用。",
        "positive_examples": (
            "课程多少钱",
            "需要付费吗",
            "可以退款吗",
            "交的钱还能退回来吗",
            "报名后支持退款吗",
            "报名后可以改期吗",
            "模型费用怎么算",
            "token怎么收费",
        ),
        "negative_examples": ("怎么报名", "在哪里上课", "课程讲什么"),
    },
    "audience": {
        "description": "用户询问课程适合人群、基础要求、年龄或技术背景。",
        "positive_examples": (
            "零基础可以参加吗",
            "适合什么人学习",
            "不会代码能听懂吗",
            "年龄大可以参加吗",
        ),
        "negative_examples": ("报名有什么条件", "需要带电脑吗", "课程讲什么"),
    },
    "preparation": {
        "description": "用户询问课前需要携带的设备、软件安装、账号或环境准备。",
        "positive_examples": (
            "需要带电脑吗",
            "课前要准备什么",
            "需要提前安装软件吗",
            "要先注册账号吗",
        ),
        "negative_examples": ("课程讲什么", "适合什么人", "怎么报名"),
    },
    "materials_support": {
        "description": "用户询问课件资料、答疑群、通知、回放或课后支持。",
        "positive_examples": (
            "有学习资料吗",
            "有答疑群吗",
            "课件会给吗",
            "通知在哪里看",
            "有课程回放吗",
        ),
        "negative_examples": ("在哪里上课", "怎么报名", "需要带电脑吗"),
    },
    "instructor": {
        "description": "用户询问课程讲师、老师背景或授课人员。",
        "positive_examples": ("讲师是谁", "是哪位老师上课", "老师有什么背景"),
        "negative_examples": ("课程讲什么", "什么时候上课", "怎么报名"),
    },
    "general": {
        "description": "用户提出无法归入其他细分类别的一般服务或课程咨询。",
        "positive_examples": (
            "还有其他问题",
            "想咨询一下服务",
            "退款流程是什么",
            "如何开具发票",
            "How do I request a refund",
            "Can I get my money back",
        ),
        "negative_examples": (),
    },
}


def default_course_definitions() -> list[dict]:
    return [
        {
            "course_code": profile.code,
            "display_name": profile.label,
            "description": profile.description,
            "aliases": list(profile.aliases),
        }
        for profile in COURSE_PROFILES
    ]


def default_intent_definitions() -> list[dict]:
    definitions: list[dict] = []
    course_intents = (
        "course_content",
        "schedule_location",
        "registration",
        "pricing",
        "audience",
        "preparation",
        "materials_support",
        "instructor",
        "general",
    )
    for course_code in ("weekly_course", "paid_course"):
        profile = COURSE_PROFILE_BY_CODE[course_code]
        for intent_code in course_intents:
            intent_profile = INTENT_PROFILES[intent_code]
            intent_id = intent_id_for(course_code, intent_code)
            confusing = [
                intent_id_for(course_code, code)
                for code in course_intents
                if code != intent_code
            ]
            definitions.append(
                {
                    "intent_id": intent_id,
                    "domain": "course",
                    "course_code": course_code,
                    "course_name": profile.label,
                    "intent_code": intent_code,
                    "display_name": intent_label(intent_code),
                    "description": intent_profile["description"],
                    "positive_examples": list(intent_profile["positive_examples"]),
                    "negative_examples": list(intent_profile["negative_examples"]),
                    "confusing_intents": confusing,
                }
            )

    return definitions


def normalize_taxonomy(
    *,
    question: str,
    course_code: str = "",
    course_name: str = "",
    intent_code: str = "",
    category: str = "",
    domain: str = "",
    intent_id: str = "",
) -> tuple[str, str, str]:
    normalized_course = course_code.strip()
    normalized_intent = intent_code.strip()

    if normalized_course not in COURSE_LABELS:
        normalized_course = _infer_course(question, category, domain, intent_id)
    if normalized_intent not in INTENT_LABELS:
        normalized_intent = _infer_intent(question, category, domain, intent_id)

    normalized_name = COURSE_LABELS.get(normalized_course, course_name.strip())
    return normalized_course, normalized_name, normalized_intent


def intent_id_for(course_code: str, intent_code: str) -> str:
    if course_code == "general":
        return f"course.{intent_code}"
    return f"{course_code}.{intent_code}"


def intent_label(intent_code: str) -> str:
    return INTENT_LABELS.get(intent_code, "其他咨询")


def _infer_course(question: str, category: str, domain: str, intent_id: str) -> str:
    text = " ".join((question, category, domain, intent_id)).lower()
    paid_terms = ("进阶", "付费课程", "长期班", "训练营", "系统课")
    conversation_terms = (
        "你好",
        "您好",
        "嗨",
        "你是谁",
        "你叫什么",
        "你能做什么",
        "介绍一下你自己",
    )
    if any(term in text for term in conversation_terms):
        return "conversation"
    general_terms = (
        "公司介绍",
        "做什么的",
        "有哪些课程",
        "有什么课",
        "其他课程",
        "人工客服",
        "联系客服",
        "投诉",
        "结束对话",
    )
    if any(term in text for term in paid_terms):
        return "paid_course"
    if any(term in text for term in general_terms):
        return "general"
    return "weekly_course"


def _infer_intent(question: str, category: str, domain: str, intent_id: str) -> str:
    text = " ".join((question, category, domain, intent_id)).lower()
    rules = (
        ("greeting", ("你好", "您好", "嗨", "你是谁", "你叫什么", "你能做什么", "自我介绍")),
        ("course_content", ("内容", "讲什么", "学什么", "作品", "实操")),
        ("registration", ("报名", "参加条件", "带同事", "带朋友")),
        ("schedule_location", ("时间", "地点", "教室", "周六", "多久", "午休", "停车", "安排")),
        ("pricing", ("收费", "费用", "价格", "多少钱", "token")),
        ("audience", ("适合", "人群", "零基础", "年龄")),
        ("preparation", ("准备", "带电脑", "提前安装")),
        ("materials_support", ("资料", "答疑群", "通知", "回放", "线上课")),
        ("instructor", ("讲师", "老师是谁")),
    )
    for code, terms in rules:
        if any(term in text for term in terms):
            return code
    return "general"
