"""Run cutover, import, verify, then enable; no synthetic WeChat messages are sent."""
import argparse
import base64
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def run(args, input=None):
    p = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT)
    if p.returncode:
        # Arguments may contain credentials.
        raise RuntimeError("Command failed: " + p.stderr.decode("utf-8", "replace")[-1600:])
    return p.stdout

def inspect(name):
    return json.loads(run(["docker", "inspect", name]))[0]

def env(container):
    return dict(v.split("=", 1) for v in container["Config"]["Env"] if "=" in v)

def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def stamp(value):
    return int(dt.datetime.fromisoformat(value).timestamp()) if value else 0

def sqlvalue(value):
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, (int, float)):
        return str(value)
    if value is None:
        return "NULL"
    if not isinstance(value, bytes):
        value = str(value).encode("utf-8")
    return "X'" + value.hex() + "'"

class Migration:
    def __init__(self, backup):
        self.backup = Path(backup).resolve()
        snapshots = json.loads((self.backup / "containers.json").read_text(encoding="utf-8"))
        self.old = {c["Name"].lstrip("/"): c for c in snapshots}
        self.client = next(n for n in self.old if n.startswith("client_"))
        self.code = env(self.old[self.client])["ROBOT_CODE"]
        assert re.fullmatch(r"[a-zA-Z0-9_]+", self.code)
        self.password = env(inspect("wechat-admin-mysql"))["MYSQL_ROOT_PASSWORD"]
        self.qkey = env(inspect("wechat-admin-qdrant"))["QDRANT__SERVICE__API_KEY"]

    def sql(self, query, database=None):
        return run(["docker", "exec", "-i", "-e", "MYSQL_PWD=" + self.password,
                    "wechat-admin-mysql", "mysql", "-uroot", "--default-character-set=utf8mb4",
                    "-N", "-B", database or self.code], query.encode("utf-8")).decode("utf-8").strip()

    def api(self, path, data=None):
        script = """import fs from 'node:fs';
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const r=await fetch(p.url,{method:p.data===null?'GET':'POST',headers:{'Content-Type':'application/json'},body:p.data===null?undefined:JSON.stringify(p.data),signal:AbortSignal.timeout(120000)});
console.log(await r.text());"""
        payload = json.dumps({"url": f"http://{self.client}:9000/api/v1/robot/" + path, "data": data})
        result = json.loads(run(["docker", "exec", "-i", "tianhe-dev-web-1", "node",
                                 "--input-type=module", "-e", script], payload.encode("utf-8")))
        if result.get("code") != 200:
            raise RuntimeError("Robot API failed: " + path + ": " + str(result.get("message")))
        return result.get("data")

    def qdrant(self, path, method="GET"):
        req = urllib.request.Request("http://127.0.0.1:6333/" + path, method=method, headers={"api-key": self.qkey})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)["result"]

    def cutover(self):
        if (self.backup / "native-cutover.json").exists():
            raise RuntimeError("Cutover already started; inspect the saved state before retrying.")
        schemas = {n: self.qdrant("collections/" + n) for n in ["knowledge", "memories"]}
        if any(c["points_count"] != 0 for c in schemas.values()):
            raise RuntimeError("Native vector collections are not empty. No collection was changed.")
        save(self.backup / "qdrant-before.json", schemas)
        settings = self.api("global-settings")
        system = self.api("system-settings")
        save(self.backup / "native-cutover.json", {"global_settings": settings, "system_settings": system})
        system["webhook_url"] = ""
        system["webhook_headers"] = {}
        self.api("system-settings", system)
        settings.update(chat_ai_enabled=False, text_embedding_model="tianhe-robot-embedding",
                        text_embedding_dimension=512)
        if not settings.get("chat_prompt") or "\ufffd" in settings["chat_prompt"]:
            settings["chat_prompt"] = "你是微信客服助手。使用已绑定的知识库回答业务问题，回答简洁清晰；找不到依据时说明不确定，不编造政策、费用或承诺。"
        self.api("global-settings", settings)
        run(["docker", "update", "--restart=no", "tianhe-dev-wechat-1"])
        run(["docker", "stop", "-t", "90", "tianhe-dev-wechat-1"])
        self.replace_containers()

    def replace_containers(self):
        assert (self.backup / "native-cutover.json").exists()
        assert not inspect("tianhe-dev-wechat-1")["State"]["Running"]
        schemas = json.loads((self.backup / "qdrant-before.json").read_text(encoding="utf-8"))
        export_env = self.backup / ".env.customer-export"
        export_env.write_text("\n".join(self.old["tianhe-dev-wechat-1"]["Config"]["Env"]) + "\n", encoding="utf-8")
        # Export final state in a disposable process with no web server or worker.
        exporter = """import base64,json
from app.core.database import SessionLocal
from app.models.entities import WechatRobotUserBinding,WechatRobotHandoffNotifier,WechatRobotBroadcast
from app.wechat_robot.service import is_wechat_robot_handoff_active
def row(o):
 d={c.name:getattr(o,c.name) for c in o.__table__.columns}
 for k,v in d.items():
  if hasattr(v,'isoformat'):d[k]=v.isoformat()
  elif isinstance(v,bytes):d[k]=base64.b64encode(v).decode()
 if isinstance(o,WechatRobotUserBinding):d['active']=is_wechat_robot_handoff_active(o)
 return d
with SessionLocal() as db:
 print(json.dumps({k:[row(o) for o in db.query(m).all()] for k,m in [('bindings',WechatRobotUserBinding),('notifiers',WechatRobotHandoffNotifier),('broadcasts',WechatRobotBroadcast)]}))
"""
        final_export = json.loads(run(["docker", "run", "--rm", "--network", "tianhe-dev_default",
            "--env-file", str(export_env), "--mount", f"type=bind,source={ROOT / 'wechat-assistant/app'},target=/app/app,readonly",
            "--entrypoint", "python", "tianhe-dev-wechat", "-c", exporter]))
        save(self.backup / "customer-final.json", final_export)
        for name in ["wechat-robot-admin-backend", self.client, "wechat-robot-admin-frontend"]:
            run(["docker", "update", "--restart=no", name])
            run(["docker", "stop", "-t", "30", name])
            run(["docker", "rename", name, name + "-before-native"])
        for name in schemas:
            if self.qdrant("collections/" + name)["points_count"] != 0:
                raise RuntimeError("Collection changed during cutover; stopped before deleting it.")
            self.qdrant("collections/" + name, "DELETE")
        run(["docker", "compose", "--env-file", ".env.robot-native", "-f", "compose.robot.yaml", "up", "-d"])
        run(["docker", "exec", "wechat-nginx", "nginx", "-s", "reload"])
        print("Native containers started. AI remains disabled until import and verification finish.")

    def import_data(self):
        data = json.loads((self.backup / "customer-final.json").read_text(encoding="utf-8"))
        docs = json.loads((self.backup / "published-knowledge.json").read_text(encoding="utf-8"))
        category = "tianhe_migrated"
        categories = self.api("knowledge/categories?type=text") or []
        if not any(c["code"] == category for c in categories):
            self.api("knowledge/category", {"code": category, "type": "text", "name": "客服业务知识",
                "description": "OPC港澳服务社区介绍、入驻流程、政策、服务及常见问题；从天河已发布资料迁入。"})
        for doc in docs:
            source = "tianhe:" + str(doc["document_id"])
            existing = self.sql("SELECT count(*) FROM knowledge_documents WHERE source=" + sqlvalue(source))
            if int(existing) == 0:
                self.api("knowledge/document", {"title": doc["title"], "content": "\n\n".join(doc["parts"]),
                    "source": source, "category": category})
        # Direct inserts preserve active receptions without sending notifications.
        for binding in data["bindings"]:
            peer, room = binding["peer_wxid"], binding.get("room_wxid") or ""
            record = {"key": room + ":" + peer, "peer": peer, "room": room, "active": binding["active"],
                "version": 1, "reason": binding.get("handoff_reason") or "", "last_message": binding.get("handoff_last_message") or "",
                "notification_error": "", "started_at": stamp(binding.get("handoff_started_at")),
                "updated_at": stamp(binding.get("handoff_updated_at") or binding.get("created_at"))}
            self.insert("support_receptions", record)
        for old in data["broadcasts"]:
            record = {"id": "legacy-" + old["id"], "fingerprint": "", "content": old["content"],
                "recipients": json.dumps(old["recipient_ids"]), "image": base64.b64decode(old.get("image_data") or ""),
                "image_type": old.get("image_content_type") or "", "has_image": bool(old.get("image_data")),
                "status": "interrupted" if old["status"] in ["pending", "running", "sending"] else old["status"],
                "results": json.dumps([{"peer": "旧任务", "error": v} for v in old.get("error_details", [])], ensure_ascii=False),
                "success_count": old["success_count"], "failed_count": old["failed_count"],
                "created_at": stamp(old["created_at"]), "updated_at": stamp(old.get("completed_at") or old["created_at"])}
            self.insert("support_broadcasts", record)
        current = self.api("support")["settings"]
        notifiers = sorted(data["notifiers"], key=lambda x: x.get("updated_at") or "")
        notifier = notifiers[-1]["recipient_wxid"] if notifiers else ""
        self.api("support/settings", {"notifier": notifier, "knowledge_codes": list(dict.fromkeys(
            (current.get("knowledge_codes") or []) + [category]))})
        print(f"Imported {len(docs)} documents, {len(data['bindings'])} reception records, {len(data['broadcasts'])} broadcast records.")

    def insert(self, table, record):
        quote = lambda s: chr(96) + s + chr(96)
        columns = ",".join(quote(k) for k in record)
        values = ",".join(sqlvalue(v) for v in record.values())
        key = quote(next(iter(record)))
        self.sql(f"INSERT INTO {table} ({columns}) VALUES ({values}) ON DUPLICATE KEY UPDATE {key}={key}")

    def verify(self):
        counts = self.sql("SELECT count(DISTINCT title),count(*),sum(vector_id IS NOT NULL AND vector_id<>'') FROM knowledge_documents WHERE source LIKE 'tianhe:%'").split("\t")
        assert int(counts[0]) == len(json.loads((self.backup / "published-knowledge.json").read_text(encoding="utf-8"))), counts
        assert int(counts[1]) > 0 and counts[1] == counts[2], "Native document indexing is incomplete: " + str(counts)
        found = self.api("knowledge/search", {"query": "OPC港澳服务社区的入驻流程是怎样的？", "category": "tianhe_migrated", "limit": 5})
        assert found, "Native knowledge search returned no results"
        save(self.backup / "native-search-check.json", found)
        assert any("入驻" in json.dumps(r, ensure_ascii=False) for r in found), "Search evidence missing"
        state = self.api("support")
        settings = self.api("global-settings")
        assert settings["text_embedding_dimension"] == 512
        assert settings["chat_model"] == "tianhe-robot-chat"
        assert self.api("system-settings")["webhook_url"] == ""
        print(json.dumps({"documents": int(counts[0]), "chunks": int(counts[1]), "indexed": int(counts[2]),
                          "friends": len(state["friends"] or []), "active_receptions": len(state["receptions"] or []),
                          "native_search_hits": len(found), "native_ai_enabled": settings["chat_ai_enabled"]}))

    def enable(self):
        self.verify()
        assert not inspect("tianhe-dev-wechat-1")["State"]["Running"]
        settings = self.api("global-settings")
        settings["chat_ai_enabled"] = True
        self.api("global-settings", settings)
        run(["docker", "update", "--restart=no", "tianhe-dev-wechat-db-1"])
        run(["docker", "stop", "-t", "30", "tianhe-dev-wechat-db-1"])
        run(["docker", "compose", "-f", "compose.yaml", "-f", "compose.wechat.yaml", "up", "-d", "--no-build", "web"])
        print("Native replies enabled; 8000 and its PostgreSQL stopped and excluded from normal startup.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["cutover", "replace_containers", "import", "verify", "enable"])
    parser.add_argument("--backup", required=True)
    args = parser.parse_args()
    migration = Migration(args.backup)
    getattr(migration, "import_data" if args.phase == "import" else args.phase)()
