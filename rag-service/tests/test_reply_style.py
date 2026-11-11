from __future__ import annotations

import json
import sys
from types import ModuleType, SimpleNamespace

import pytest

from app.agent import BoundedDeepAgent
from app.persona import AnswerProfile
from app.config import Settings
from app.retrieval import SearchScope


class RecordingProvider:
    enabled = True

    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def json_complete(self, system, user, **kwargs):
        self.calls.append({"system": system, "user": user, **kwargs})
        return self.payload, {"model": "style-test", "text": json.dumps(self.payload)}


def install_deep_agent_stub(monkeypatch, payload, captures):
    deepagents = ModuleType("deepagents")
    tools = ModuleType("langchain_core.tools")
    openai = ModuleType("langchain_openai")

    class Agent:
        async def ainvoke(self, request, config=None):
            captures["user"] = request["messages"][0]["content"]
            return {"messages": [SimpleNamespace(content=json.dumps(payload))]}

    def create_agent(**kwargs):
        captures["system"] = kwargs["system_prompt"]
        captures["tools"] = kwargs["tools"]
        return Agent()

    deepagents.create_deep_agent = create_agent
    deepagents.GeneralPurposeSubagentProfile = lambda **kwargs: kwargs
    deepagents.HarnessProfile = lambda **kwargs: kwargs
    deepagents.register_harness_profile = lambda *args, **kwargs: None
    tools.tool = lambda **kwargs: lambda function: function
    openai.ChatOpenAI = lambda **kwargs: SimpleNamespace(**kwargs)
    monkeypatch.setitem(sys.modules, "deepagents", deepagents)
    monkeypatch.setitem(sys.modules, "langchain_core.tools", tools)
    monkeypatch.setitem(sys.modules, "langchain_openai", openai)


@pytest.mark.asyncio
@pytest.mark.parametrize("backend", ["direct", "deep-agent"])
@pytest.mark.parametrize("has_answer", [True, False], ids=["grounded-answer", "insufficient-evidence"])
async def test_reply_style_applies_to_both_backends_without_relaxing_answer_contract(monkeypatch, backend, has_answer):
    payload = {
        "result": "ANSWERED" if has_answer else "NO_ANSWER",
        "answer": "有剪辑和配音相关课程，报名限年满十八岁的学员。" if has_answer else "",
        "citation_ids": ["chunk-c509a1b2c3d4e5f67890"] if has_answer else [],
        "reason_code": None if has_answer else "INSUFFICIENT_EVIDENCE",
    }
    captures = {}
    if backend == "deep-agent":
        install_deep_agent_stub(monkeypatch, payload, captures)
    settings = Settings(
        deep_agent_enabled=backend == "deep-agent", generation_provider="openai_compatible",
        llm_base_url="https://style-test.invalid/v1", llm_api_key="test-only", llm_model="style-test",
        tianhe_ai_enabled=False,
    )
    provider = RecordingProvider(payload)
    agent = BoundedDeepAgent(settings, SimpleNamespace(), provider)
    result = await agent.run(
        question="能学些什么？", context_text="USER: 我想参加培训",
        evidence=[{"chunk_id": "chunk-c509a1b2c3d4e5f67890", "text": "课程包括剪辑、配音。报名限年满十八岁的学员。"}],
        trace_id="reply-style", max_answer_chars=90, scope=SearchScope("style-test"), answer_profile=AnswerProfile(),
    )
    if backend == "direct":
        assert len(provider.calls) == 1
        captures = provider.calls[0]
        assert captures["max_tokens"] == settings.llm_max_output_tokens
    else:
        assert provider.calls == [], "deep-agent success must not perform a second style rewrite"
        assert len(captures["tools"]) == 1

    system, user = captures["system"], captures["user"]
    # Both providers receive a conversational style policy, including the boundary
    # between concise answers and necessary conditions or a requested full list.
    assert "日常对话" in system and "先说用户最需要的结论" in system
    assert "两三个方向" in system and "明确要完整清单" in system
    assert "答清用户问的部分就停" in system and "不顺带介绍目标、理念、价值" in system
    assert "常用词和具体动作" in system and "用户询问这些术语本身时除外" in system
    assert "办理条件" in system and "例外必须保留" in system
    assert "不要声称自己是真人" in system and "证据不足仍返回NO_ANSWER" in system
    assert "NO_ANSWER" in system and "citation_ids" in system
    assert "口语化和简短要求仅适用于answer" in system
    assert "保留chunk-前缀及全部后缀" in system and "不得缩写、截断或改写" in system
    assert "[chunk-c509a1b2c3d4e5f67890]" in user
    assert "<untrusted-context>" in user and "不可信数据" in user
    assert "最大回答字符数: 90" in user and "ANSWER_TOO_LONG" in user
    assert "不能当成知识证据" in user

    assert result.output.result == payload["result"]
    assert result.output.answer == payload["answer"]
    assert result.output.citation_ids == payload["citation_ids"]
    assert result.output.reason_code == payload["reason_code"]
