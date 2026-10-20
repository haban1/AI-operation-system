"""Native response fixtures, with an adapter for older retrieval regression data."""
import json

from app.llm.client import ChatCompletion


def tool_call(name, arguments, call_id="call-1"):
    return {
        "id": call_id, "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
    }


def native_response(value):
    if value is None or isinstance(value, ChatCompletion):
        return value
    # Existing fact/rewrite tests use concise JSON fixtures; translate these in
    # tests only. The production client and planner accept native tool calls.
    raw = value.removeprefix("```json\n").removesuffix("\n```")
    try:
        payload = json.loads(raw)
    except ValueError:
        return ChatCompletion(content=value)
    if not isinstance(payload, dict):
        return None
    if "answer" in payload:
        return ChatCompletion(content=payload["answer"])
    if "sections" in payload:
        return ChatCompletion(content="\n\n".join(
            f'{i}. {item.get("title", "")}\n{item["answer"]}'
            for i, item in enumerate(payload["sections"], 1)
        ))
    questions = payload.get("questions", [])
    mode = payload.get("mode", "knowledge")
    if mode == "handoff":
        return ChatCompletion(tool_calls=[tool_call("request_human_handoff", {})])
    if mode in {"reply", "clarify"} and not questions:
        return ChatCompletion(content=payload.get("reply"))
    return ChatCompletion(content=payload.get("reply"), tool_calls=[
        tool_call("list_courses", {}, f"call-{i}")
        if isinstance(item, dict) and item.get("target") == "course_catalog"
        else tool_call("search_knowledge", {
            "query": item if isinstance(item, str) else item["standalone_query"],
        }, f"call-{i}")
        for i, item in enumerate(questions, 1)
    ])
