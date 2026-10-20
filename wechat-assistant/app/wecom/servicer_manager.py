from __future__ import annotations

from app.core.config import get_settings
from app.wecom.client import WeComClient


def ensure_configured_handoff_servicer(
    *,
    client: WeComClient | None = None,
) -> str:
    settings = get_settings()
    open_kfid = settings.wecom_kf_open_kfid.strip()
    servicer_userid = settings.wecom_kf_handoff_servicer_userid.strip()
    if not servicer_userid:
        return ""
    if not open_kfid:
        raise RuntimeError(
            "WECOM_KF_OPEN_KFID is required when a handoff servicer is configured"
        )

    client = client or WeComClient()
    existing = client.list_customer_service_servicers(open_kfid=open_kfid)
    if servicer_userid not in {
        str(item.get("userid") or "").strip()
        for item in existing
        if isinstance(item, dict)
    }:
        client.add_customer_service_servicers(
            open_kfid=open_kfid,
            userids=[servicer_userid],
        )
    return servicer_userid


def main() -> None:
    servicer_userid = ensure_configured_handoff_servicer()
    if servicer_userid:
        print(servicer_userid)


if __name__ == "__main__":
    main()
