"""Resolve short follow-ups using supplied history, never shared conversation state."""
from __future__ import annotations

import re

from .models import QueryMessage


_TOPIC_SWITCH = re.compile(r"^(?:另外问|另一个问题|换(?:个|一个)?(?:问题|话题)|说回|不(?:是|对)[，,\s]*(?:我)?(?:问|想问)(?:的)?是)")
_FOLLOWUP_START = re.compile(r"^(?:那么?|这(?:个|些|项|种)|那(?:个|些|项|种)|它(?:们)?|上述|前者|后者|刚才|之前|上面|还(?:有|要|需)|第[一二三四五六七八九十\d]+(?:个|项|种))")
_SHORT_FOLLOWUP = re.compile(
    r"^(?:(?:需要|要|准备|提交)(?:哪些|什么)?(?:材料|资料|证件|条件|手续|文件)"
    r"|(?:怎么|如何|怎样|在哪|在哪里|去哪里)(?:申请|办理|办|操作)?"
    r"|(?:能|可以|能否|是否可以)?(?:线上|线下|网上|现场)?(?:申请|办理|办)"
    r"|(?:需要|要|收费)?(?:多少钱|多少费用|多少押金|多久|多长时间)"
    r"|(?:办理|申请)(?:时间|多久|流程|条件|费用)"
    r"|对|对的|是|是的|没错|好的|好|可以|需要|不需要|不是|不对|嗯|继续)(?:呢|吗|么)?$"
)
_CLARIFICATION = re.compile(r"请问|您是|你是|(?:你|您)想了解|还是|想咨询|具体说明|具体.*(?:业务|问题)")
_RESOURCE = r"APP|应用程序|應用程式|应用|應用|软件|軟件|小程序|公众号|公眾號|官网|官網|网站|網站|入口|链接|連結"
_RESOURCE_FOLLOWUP = re.compile(
    rf"^(?:我(?:说|說|问|問)(?:的)?(?:是)?|就是|请问|請問)?"
    rf"(?:这(?:个|個)|那(?:个|個)|你(?:说|說)的|上面(?:的)?|刚才(?:的)?)?(?:{_RESOURCE})"
    r"(?:在|去|哪里|哪裡|哪儿|哪兒|哪|怎么|怎麼|如何|找到|找|下载|下載|安装|安裝|打开|開啟|获取|獲取|进入|進入|地址|网址|網址|链接|連結|发我|给我|給我|呢|啊|吗|嗎|是|有|什么|什麼|能|可以)*$",
    re.IGNORECASE,
)
_QUOTED_RESOURCE = re.compile(rf'[“「《【\"]([^”」》】\"\n]{{1,40}})[”」》】\"]\s*({_RESOURCE})', re.IGNORECASE)
_BARE_RESOURCE = re.compile(
    rf"(?:^|[，。！？；：、\s]|通过|使用|打开|登录|搜索|下载)([A-Za-z0-9\u4e00-\u9fff·]{{2,24}}?)\s*({_RESOURCE})",
    re.IGNORECASE,
)


def _resource_kind(value: str) -> str | None:
    match = re.search(_RESOURCE, value, re.IGNORECASE)
    if not match:
        return None
    kind = match.group().upper()
    if kind in {"APP", "应用程序", "應用程式", "应用", "應用", "软件", "軟件"}:
        return "APP"
    return {"公眾號": "公众号", "官網": "官网", "網站": "网站", "連結": "链接"}.get(kind, kind)


def _referenced_resource(question: str, history: list[QueryMessage]) -> tuple[str | None, str | None]:
    kind = _resource_kind(question)
    if not kind:
        return None, None
    for item in reversed(history):
        if item.role == "USER" and _RESOURCE_FOLLOWUP.fullmatch(re.sub(r"[\s，。！？；：、,.!?;:]", "", item.text)):
            continue
        names = set()
        matches = [(match, True) for match in _QUOTED_RESOURCE.finditer(item.text)]
        matches.extend((match, False) for match in _BARE_RESOURCE.finditer(item.text))
        for match, quoted in matches:
            if _resource_kind(match.group(2)) != kind:
                continue
            name = re.sub(r"^(?:可|请|建议)?(?:通过|使用|打开|登录|搜索|下载)", "", match.group(1)).strip()
            # Descriptions such as "具体的APP" or "暂无APP下载链接" are
            # references to an app, not additional app names in the same reply.
            if not quoted and re.search(r"(?:的|该|此|暂无|尚无|没有|未提供)$", name):
                continue
            if name and name not in {"官方", "这个", "那个", "对应", "相关", "具体", "指定"}:
                names.add(name)
        if names:
            # Multiple named apps in the same reply are ambiguous; do not pick one.
            return (next(iter(names)) if len(names) == 1 else None), kind
    return None, kind


def _followup(question: str, previous_reply: str = "") -> bool:
    if _TOPIC_SWITCH.search(question):
        return False
    compact = re.sub(r"[\s，。！？；：、,.!?;:]", "", question)
    # A named resource in the current question establishes its own topic even
    # when the previous reply ends with a general invitation to ask more.
    if not _RESOURCE_FOLLOWUP.fullmatch(compact):
        name, _ = _referenced_resource(question, [QueryMessage(role="USER", text=question)])
        if name:
            return False
    return bool(
        _FOLLOWUP_START.search(compact)
        or (len(compact) <= 24 and compact.endswith("呢"))
        or _SHORT_FOLLOWUP.fullmatch(compact)
        or _RESOURCE_FOLLOWUP.fullmatch(compact)
        or (len(compact) <= 30 and _CLARIFICATION.search(previous_reply))
    )


def prepare_history(question: str, context: list[QueryMessage]) -> list[QueryMessage]:
    history = list(context)
    # Older V1 callers also appended the current question to context.
    if history and history[-1].role == "USER" and history[-1].text.strip() == question.strip():
        history.pop()
    if _TOPIC_SWITCH.search(question):
        return []
    start = 0
    for index, item in enumerate(history):
        if item.role == "USER" and _TOPIC_SWITCH.search(item.text):
            start = index
    return history[start:]


def analyze_query(question: str, context: list[QueryMessage]) -> dict:
    analysis = {"originalQuestion": question, "resolvedQuestion": question, "keywords": [], "contextUsed": False}
    history = prepare_history(question, context)
    last_reply = history[-1].text if history and history[-1].role == "ASSISTANT" else ""
    if not history or not _followup(question, last_reply):
        return analysis
    # The most recent independent user question starts the active topic; following
    # ellipses and answers to clarification retain that topic across several turns.
    start = 0
    previous_reply = ""
    for index, item in enumerate(history):
        if item.role == "USER":
            if not _followup(item.text, previous_reply):
                start = index
            previous_reply = ""
        else:
            previous_reply = item.text
    topic_parts = []
    previous_reply = ""
    for item in history[start:]:
        if item.role == "USER":
            if not topic_parts or _CLARIFICATION.search(previous_reply):
                topic_parts.append(item.text)
            previous_reply = ""
        else:
            previous_reply = item.text
    if not topic_parts:
        return analysis
    # Old questions about fees/time/materials should not dilute the new detail
    # during reranking. Full turns still reach the answer model separately.
    topic = "；".join(topic_parts)[:1800]
    # Include the preceding question/options only when the customer is selecting
    # or clarifying them. Answers never become factual retrieval evidence.
    clarification = f"；上轮回复：{last_reply[:600]}" if last_reply and (
        _CLARIFICATION.search(last_reply) or re.search(r"前者|后者|第[一二三四五六七八九十\d]+|^(?:对的?|是的?|没错)[。！!]*$", question)
    ) else ""
    name, kind = _referenced_resource(question, history[start:])
    keywords = [value for value in [name, kind] if value]
    resource_hint = f"；指代对象：{name} {kind}" if name and kind else ""
    if kind and re.search(r"在哪|哪里|哪裡|哪儿|哪兒|哪找|去哪|下载|下載|链接|連結|网址|網址|入口", question):
        intent = "下载或获取入口" if kind == "APP" else "访问入口"
        keywords.extend(["下载", "获取入口"] if kind == "APP" else ["访问入口"])
        resource_hint += f"；检索意图：查找{kind}{intent}"
        if name:
            # Keep the cross-encoder query focused on the requested detail. The
            # original question and complete history still reach generation.
            analysis.update(
                resolvedQuestion=f"{name}{kind}在哪里{'下载或获取' if kind == 'APP' else '访问'}？",
                keywords=keywords,
                contextUsed=True,
            )
            return analysis
    analysis.update(
        resolvedQuestion=f"会话主题：{topic}{resource_hint}{clarification}；当前追问：{question}",
        keywords=keywords,
        contextUsed=True,
    )
    return analysis


def contextual_query(question: str, context: list[QueryMessage]) -> str:
    return analyze_query(question, context)["resolvedQuestion"]
