from __future__ import annotations

import os
import sys
from typing import Any

from app.wecom.client import WeComClient, WeComClientError


DEFAULT_ACCOUNT_NAME = "智慧驱动小助手"


def select_customer_service_account(
    accounts: list[dict[str, Any]],
    *,
    preferred_name: str = "",
    current_open_kfid: str = "",
) -> dict[str, Any]:
    valid_accounts = [
        account
        for account in accounts
        if str(account.get("open_kfid") or "").strip()
    ]
    if not valid_accounts:
        raise ValueError("No authorized WeCom customer service account was found")

    for name in (preferred_name.strip(), DEFAULT_ACCOUNT_NAME):
        if not name:
            continue
        matches = [
            account
            for account in valid_accounts
            if str(account.get("name") or "").strip() == name
        ]
        if len(matches) == 1:
            return matches[0]

    if len(valid_accounts) == 1:
        return valid_accounts[0]

    current_matches = [
        account
        for account in valid_accounts
        if str(account.get("open_kfid") or "").strip() == current_open_kfid.strip()
    ]
    if len(current_matches) == 1:
        return current_matches[0]

    names = ", ".join(
        str(account.get("name") or "(unnamed)")
        for account in valid_accounts
    )
    raise ValueError(
        "Multiple authorized WeCom customer service accounts were found "
        f"({names}); configure WECOM_KF_ACCOUNT_NAME"
    )


def resolve_open_kfid() -> str:
    client = WeComClient()
    account = select_customer_service_account(
        client.list_customer_service_accounts(),
        preferred_name=os.getenv("WECOM_KF_ACCOUNT_NAME", ""),
        current_open_kfid=os.getenv("WECOM_KF_OPEN_KFID", ""),
    )
    return str(account["open_kfid"]).strip()


def main() -> int:
    try:
        open_kfid = resolve_open_kfid()
    except (ValueError, WeComClientError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(open_kfid)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
