"""Create a shared internal model credential; never copy an upstream API key."""
import datetime
import json
from pathlib import Path
import re
import secrets
import shutil


def prepare(root):
    paths = [root / ".env.docker", root / ".env.wechat"]
    contents = [p.read_text(encoding="utf-8-sig") for p in paths]
    match = re.search(r"^TIANHE_MODEL_TOKEN=(.*)$", contents[0], re.M)
    token = match.group(1).strip().strip('\"\'') if match else ""
    if not token or token.startswith("replace-with-"):
        token = secrets.token_hex(32)
    backup = root / "backups" / ("unified-ai-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    backup.mkdir(parents=True)
    for path, content in zip(paths, contents):
        shutil.copy2(path, backup / path.name)
        content = re.sub(r"^TIANHE_MODEL_TOKEN=.*\n?", "", content, flags=re.M)
        path.write_text(content.rstrip() + "\nTIANHE_MODEL_TOKEN=" + json.dumps(token) + "\n", encoding="utf-8")
    return backup


if __name__ == "__main__":
    backup = prepare(Path(__file__).resolve().parent.parent)
    print("Unified model credential prepared. Configuration backup:", backup)
