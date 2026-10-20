from __future__ import annotations

import re


_KNOWN_FACT_NAMES = {
    "上课会产出作品吗": "课程产出",
    "怎么报名": "报名入口",
    "本期课程会讲什么内容": "本期课程内容",
    "课程收费吗": "课程费用",
    "本期课程是什么安排": "本期课程安排",
    "使用模型的token怎么收费": "模型使用费用",
    "需要带电脑吗": "携带电脑要求",
    "需要提前安装claudecode吗": "Claude Code 安装准备",
    "零基础可以参加吗": "零基础参与要求",
    "本课程适合什么人群": "适合人群",
    "有学习资料或答疑群吗": "学习资料与答疑群",
    "通知在哪里看": "课程通知渠道",
    "现在还可以报名吗": "报名状态",
    "报名有什么条件": "报名条件",
    "报名后可以直接去上课吗": "报名确认",
    "可以带同事或朋友一起去吗": "同行人员报名",
    "每周六都有这个课程吗": "开课频率",
    "课程上多久": "课程时长",
    "上课地点在哪里": "上课地点",
    "具体在哪个教室": "具体教室通知",
    "午休多久附近有吃饭的地方吗": "午休与餐饮",
    "有停车位吗": "停车安排",
    "本期讲师是谁": "本期讲师",
    "有线上课或回放吗": "授课形式与回放",
    "如何联系人工客服": "人工客服联系方式",
    "服务时间是什么时候": "客服服务时间",
    "退款流程是什么": "退款流程",
    "如何开具发票": "发票开具流程",
}

def derive_fact_name(question: str, category: str = "") -> str:
    cleaned = _clean_question(question)
    known = _KNOWN_FACT_NAMES.get(_lookup_key(cleaned))
    if known:
        return known

    patterns = (
        (r"^(?:本期)?(?:课程)?(?:会)?讲什么(?:内容)?$", "课程内容"),
        (r"^(?:本期)?讲师是谁$", "本期讲师"),
        (r"^(?:课程)?上多久$", "课程时长"),
        (r"^(?:上课)?地点(?:在)?哪里$", "上课地点"),
        (r"^怎么报名$", "报名入口"),
        (r"^报名有什么条件$", "报名条件"),
        (r"^课程收费吗$", "课程费用"),
    )
    compact = re.sub(r"\s+", "", cleaned.lower())
    for pattern, fact_name in patterns:
        if re.fullmatch(pattern, compact):
            return fact_name

    return cleaned or category.strip() or "未命名事实"


def _clean_question(value: str) -> str:
    return re.sub(r"[？?！!。；;，,：:]+$", "", value.strip())


def _lookup_key(value: str) -> str:
    return re.sub(r"[\W_]+", "", value.lower(), flags=re.UNICODE)
