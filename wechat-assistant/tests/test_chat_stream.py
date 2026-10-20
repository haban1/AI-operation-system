import json

from app.api.chat import _stream_chat_events


def test_chat_stream_emits_status_deltas_and_final_payload():
    result = {
        "session_id": "session-1",
        "answer": "这是经过校验的标准答案。",
        "citations": [],
    }

    events = [
        json.loads(line)
        for line in _stream_chat_events(
            lambda: result,
            chunk_chars=3,
            delay_seconds=0,
        )
    ]

    assert events[0] == {
        "type": "status",
        "stage": "planning",
        "message": "正在理解问题并检索知识文档...",
    }
    assert events[1] == {"type": "meta", "session_id": "session-1"}
    assert "".join(event["content"] for event in events if event["type"] == "delta") == result["answer"]
    assert events[-1] == {"type": "done", "data": result}


def test_chat_stream_returns_safe_error_event():
    def fail():
        raise RuntimeError("private failure detail")

    events = [
        json.loads(line)
        for line in _stream_chat_events(
            fail,
            delay_seconds=0,
        )
    ]

    assert events[-1] == {
        "type": "error",
        "message": "回答生成失败，请稍后重试。",
    }
