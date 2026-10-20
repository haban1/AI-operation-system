import json

import httpx

from app.core.config import Settings
from app.llm.client import DashScopeChatClient
from app.wechat_robot.unified_ai import bind_robot


def test_wechat_uses_tianhe_role_and_credential_instead_of_legacy_model(monkeypatch):
    calls = []
    def post(url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(200, request=httpx.Request("POST", url), json={
            "choices": [{"finish_reason": "stop", "message": {"content": "OK"}}]})
    monkeypatch.setattr(httpx, "post", post)
    s = Settings(_env_file=None, tianhe_ai_enabled=True, tianhe_model_token="internal-token",
                 tianhe_ai_base_url="http://web:3100/api/model/v1", llm_enabled=False,
                 dashscope_base_url="https://obsolete.test/v1", dashscope_api_key="old-secret", dashscope_chat_model="old-model")
    assert DashScopeChatClient(settings=s).complete([{"role": "user", "content": "hello"}]) == "OK"
    url, request = calls[0]
    assert url == "http://web:3100/api/model/v1/chat/completions"
    assert request["headers"]["Authorization"] == "Bearer internal-token"
    assert request["json"]["model"] == "tianhe-wechat-chat"
    assert "old-secret" not in json.dumps(calls)


def test_unified_model_failure_does_not_retry_old_provider(monkeypatch, caplog):
    calls = []
    def post(url, **kwargs):
        calls.append(url)
        return httpx.Response(429, request=httpx.Request("POST", url), json={"error": {"message": "secret"}})
    monkeypatch.setattr(httpx, "post", post)
    s = Settings(_env_file=None, tianhe_ai_enabled=True, tianhe_model_token="internal-token", dashscope_api_key="old-secret")
    assert DashScopeChatClient(settings=s).complete([]) is None
    assert len(calls) == 1
    assert "status=429" in caplog.text
    assert "secret" not in caplog.text


def test_robot_binding_keeps_switches_and_prompts_and_backs_up_before_write(tmp_path):
    original = {"id": 1, "chat_ai_enabled": False, "chat_model": "old", "chat_api_key": "old-secret",
                "chat_prompt": "existing prompt", "memory_enabled": True, "tts_enabled": False}
    backup = tmp_path / "robot.json"
    class Client:
        data = original.copy()
        def _get(self, path, *, params):
            return {"items": [], "total": 0} if path.endswith("contacts") else self.data.copy()
        def _post(self, path, data):
            assert json.loads(backup.read_text())[0][2] == original
            self.data = data.copy()
    client = Client()
    result = bind_robot(client, token="internal-token", gateway_url="http://gateway/api/model/v1", backup_path=backup)
    assert result["updated_records"] == 1
    assert client.data["chat_model"] == "tianhe-robot-chat"
    assert client.data["chat_ai_enabled"] is False
    assert client.data["chat_prompt"] == original["chat_prompt"]
    assert client.data["memory_enabled"] is True
    assert client.data["tts_enabled"] is False
