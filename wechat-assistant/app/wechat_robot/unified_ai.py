"""Bind an existing robot to Tianhe without changing reply switches or prompts."""
import argparse
import json
from pathlib import Path

from app.core.config import get_settings
from app.wechat_robot.client import WechatRobotClient


def bind_robot(client, *, token, gateway_url, backup_path):
    if not token:
        raise ValueError("TIANHE_MODEL_TOKEN is required")
    global_path = "/api/v1/robot/global-settings"
    records = [(global_path, {}, client._get(global_path, params={}))]
    for kind, path, param in [
        ("friend", "/api/v1/robot/friend-settings", "contact_id"),
        ("chatroom", "/api/v1/robot/chat-room-settings", "chat_room_id"),
    ]:
        page = 1
        while True:
            contacts = client._get("/api/v1/robot/contacts", params={"type": kind, "page_index": page, "page_size": 200})
            items = contacts.get("items") or []
            for item in items:
                params = {param: item["wechat_id"]}
                data = client._get(path, params=params)
                if data.get("id") and any(data.get(k) for k in ("chat_base_url", "chat_api_key", "chat_model", "image_recognition_model")):
                    records.append((path, params, data))
            if len(items) < 200 or page * 200 >= contacts.get("total", 0):
                break
            page += 1
    # Back up every affected record before the first write. This file contains
    # credentials and must stay in the ignored local backups directory.
    backup_path = Path(backup_path)
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    with backup_path.open("x", encoding="utf-8") as backup:
        json.dump(records, backup, ensure_ascii=False, indent=2)
    fields = {"chat_base_url": gateway_url, "chat_api_key": token,
              "chat_model": "tianhe-robot-chat", "image_recognition_model": "tianhe-robot-vision"}
    for path, params, data in records:
        update = {**data, **fields}
        if path == global_path or data.get("chat_room_summary_model"):
            update["chat_room_summary_model"] = "tianhe-robot-summary"
        if data.get("text_embedding_model"):
            update["text_embedding_model"] = "tianhe-robot-embedding"
        client._post(path, update)
        stored = client._get(path, params=params)
        if any(stored.get(k) != v for k, v in fields.items()):
            raise RuntimeError("Robot model configuration did not persist; see backup")
    return {"updated_records": len(records), "source": "tianhe"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", required=True)
    parser.add_argument("--gateway-url", default="http://tianhe-model-gateway:3100/api/model/v1")
    args = parser.parse_args()
    result = bind_robot(WechatRobotClient(), token=get_settings().tianhe_model_token,
                        gateway_url=args.gateway_url, backup_path=args.backup)
    print(json.dumps(result))
