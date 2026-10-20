import pytest

from app.wecom.account_resolver import select_customer_service_account


def test_selects_single_authorized_account():
    account = select_customer_service_account(
        [{"name": "新客服", "open_kfid": "new-kfid"}],
        current_open_kfid="old-kfid",
    )

    assert account["open_kfid"] == "new-kfid"


def test_prefers_configured_account_name():
    account = select_customer_service_account(
        [
            {"name": "客服一", "open_kfid": "kfid-1"},
            {"name": "客服二", "open_kfid": "kfid-2"},
        ],
        preferred_name="客服二",
        current_open_kfid="kfid-1",
    )

    assert account["open_kfid"] == "kfid-2"


def test_prefers_known_project_account_name():
    account = select_customer_service_account(
        [
            {"name": "旧客服", "open_kfid": "old-kfid"},
            {"name": "智慧驱动小助手", "open_kfid": "new-kfid"},
        ],
        current_open_kfid="old-kfid",
    )

    assert account["open_kfid"] == "new-kfid"


def test_rejects_ambiguous_accounts():
    with pytest.raises(ValueError, match="WECOM_KF_ACCOUNT_NAME"):
        select_customer_service_account(
            [
                {"name": "客服一", "open_kfid": "kfid-1"},
                {"name": "客服二", "open_kfid": "kfid-2"},
            ]
        )
