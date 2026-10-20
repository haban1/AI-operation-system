import xml.etree.ElementTree as ET
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api import wecom
from app.core.database import Base
from app.main import app
from app.wecom.client import WeComClient
from app.wecom.crypto import WeComCrypto, parse_xml, text_reply_xml
from app.wecom.customer_service import customer_service_poller_status, handle_customer_service_payload
from app.wecom import servicer_manager
from app.wecom.service import get_or_create_wecom_conversation
from app.models.entities import FAQEntry


TOKEN = "test-token"
CORP_ID = "ww-test-corp"
AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"


def test_wecom_crypto_round_trip():
    crypto = WeComCrypto(token=TOKEN, encoding_aes_key=AES_KEY, corp_id=CORP_ID)
    message = text_reply_xml(to_user="student", from_user="agent", content="hello")
    encrypted = crypto.encrypt(message)
    decrypted = crypto.decrypt(encrypted)

    assert parse_xml(decrypted)["Content"] == "hello"


def test_wecom_url_verification(monkeypatch):
    crypto = WeComCrypto(token=TOKEN, encoding_aes_key=AES_KEY, corp_id=CORP_ID)
    monkeypatch.setattr(wecom, "_crypto", lambda: crypto)
    echo = crypto.encrypt("callback-ok")
    timestamp = "12345"
    nonce = "nonce"
    signature = crypto.signature(timestamp=timestamp, nonce=nonce, encrypted=echo)

    client = TestClient(app)
    response = client.get(
        "/wecom/callback",
        params={
            "msg_signature": signature,
            "timestamp": timestamp,
            "nonce": nonce,
            "echostr": echo,
        },
    )

    assert response.status_code == 200
    assert response.text == "callback-ok"


def test_wecom_text_message_calls_agent(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    crypto = WeComCrypto(token=TOKEN, encoding_aes_key=AES_KEY, corp_id=CORP_ID)
    sent_messages = []
    monkeypatch.setattr(wecom, "_crypto", lambda: crypto)
    monkeypatch.setattr(wecom.AgentService, "answer", _fake_answer)
    monkeypatch.setattr(
        wecom.WeComClient,
        "send_text",
        lambda self, *, to_user, content: sent_messages.append((to_user, content)),
    )

    app.dependency_overrides[wecom.get_db] = lambda: db
    try:
        response = _post_message(crypto, content="schedule?")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.text == "success"
    assert sent_messages == [("wecom-user-1", "wecom answer")]


def test_wecom_duplicate_message_is_ignored(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    crypto = WeComCrypto(token=TOKEN, encoding_aes_key=AES_KEY, corp_id=CORP_ID)
    sent_messages = []
    monkeypatch.setattr(wecom, "_crypto", lambda: crypto)
    monkeypatch.setattr(wecom.AgentService, "answer", _fake_answer)
    monkeypatch.setattr(
        wecom.WeComClient,
        "send_text",
        lambda self, *, to_user, content: sent_messages.append((to_user, content)),
    )

    app.dependency_overrides[wecom.get_db] = lambda: db
    try:
        first = _post_message(crypto, content="schedule?")
        second = _post_message(crypto, content="schedule?")
    finally:
        app.dependency_overrides.clear()

    assert first.status_code == 200
    assert second.status_code == 200
    assert sent_messages == [("wecom-user-1", "wecom answer")]


def test_wecom_customer_service_callback_syncs_and_replies(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    crypto = WeComCrypto(token=TOKEN, encoding_aes_key=AES_KEY, corp_id=CORP_ID)
    sent_messages = []
    sync_calls = []
    monkeypatch.setattr(wecom, "_kf_crypto", lambda: crypto)
    monkeypatch.setattr(wecom.AgentService, "answer", _fake_answer)

    def fake_sync(self, **kwargs):
        sync_calls.append(kwargs)
        return {
            "msg_list": [
                {
                    "msgid": "kf-msg-1",
                    "msgtype": "text",
                    "origin": 3,
                    "external_userid": "external-user-1",
                    "open_kfid": "open-kfid-1",
                    "text": {"content": "schedule?"},
                }
            ]
        }

    monkeypatch.setattr(
        wecom.WeComClient,
        "sync_customer_service_messages",
        fake_sync,
    )
    monkeypatch.setattr(
        wecom.WeComClient,
        "ensure_customer_service_session_ready",
        lambda self, **kwargs: 1,
    )
    monkeypatch.setattr(
        wecom.WeComClient,
        "send_customer_service_text",
        lambda self, *, open_kfid, external_userid, content: sent_messages.append(
            (open_kfid, external_userid, content)
        ),
    )

    app.dependency_overrides[wecom.get_db] = lambda: db
    try:
        event = _kf_event_xml(token="kf-token")
        encrypted = crypto.encrypt(event)
        timestamp = "12345"
        nonce = "nonce"
        signature = crypto.signature(timestamp=timestamp, nonce=nonce, encrypted=encrypted)
        client = TestClient(app)
        response = client.post(
            "/wecom/kf/callback",
            params={
                "msg_signature": signature,
                "timestamp": timestamp,
                "nonce": nonce,
            },
            content=_encrypted_xml(encrypted),
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.text == "success"
    assert sync_calls == [{"token": "kf-token", "open_kfid": "open-kfid-1"}]
    assert sent_messages == [("open-kfid-1", "external-user-1", "wecom answer")]
    status = customer_service_poller_status()
    assert status["mode"] == "callback"
    assert status["last_callback_at"]
    assert status["last_callback_has_open_kfid"] is True
    assert status["last_error"] == ""


def test_customer_service_payload_handler_replies_once(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    sent_messages = []
    monkeypatch.setattr(wecom.AgentService, "answer", _fake_answer)

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 1

        def send_customer_service_text(self, *, open_kfid, external_userid, content):
            sent_messages.append((open_kfid, external_userid, content))

    payload = {
        "msg_list": [
            {
                "msgid": "kf-msg-1",
                "msgtype": "text",
                "origin": 3,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "schedule?"},
            }
        ]
    }

    assert handle_customer_service_payload(db, client=FakeClient(), payload=payload) == 1
    assert handle_customer_service_payload(db, client=FakeClient(), payload=payload) == 0
    assert sent_messages == [("open-kfid-1", "external-user-1", "wecom answer")]


def test_customer_service_payload_sends_matched_fact_image(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    sent_texts = []
    sent_images = []
    monkeypatch.setattr(
        wecom.AgentService,
        "answer",
        lambda *args, **kwargs: {
            "answer": "请填写报名信息。",
            "decision": "ACCEPT",
            "matched_facts": [
                {"id": "fact-1", "image_url": "https://example.com/signup.png"},
            ],
        },
    )

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 1

        def send_customer_service_text(self, *, open_kfid, external_userid, content):
            sent_texts.append((open_kfid, external_userid, content))

        def upload_customer_service_image(self, *, image_url):
            assert image_url == "https://example.com/signup.png"
            return "media-signup"

        def send_customer_service_image(self, *, open_kfid, external_userid, media_id):
            sent_images.append((open_kfid, external_userid, media_id))

    payload = {
        "msg_list": [
            {
                "msgid": "kf-image-1",
                "msgtype": "text",
                "origin": 3,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "怎么报名"},
            }
        ]
    }

    assert handle_customer_service_payload(db, client=FakeClient(), payload=payload) == 1
    assert sent_texts == [
        ("open-kfid-1", "external-user-1", "请填写报名信息。"),
    ]
    assert sent_images == [
        ("open-kfid-1", "external-user-1", "media-signup"),
    ]


def test_customer_service_payload_sends_uploaded_fact_image(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    entry = FAQEntry(
        fact_name="报名入口",
        question="报名入口",
        answer="请填写报名信息。",
        image_data=b"fake-png",
        image_filename="signup.png",
        image_content_type="image/png",
    )
    db.add(entry)
    db.commit()
    sent_images = []
    monkeypatch.setattr(
        wecom.AgentService,
        "answer",
        lambda *args, **kwargs: {
            "answer": "请填写报名信息。",
            "decision": "ACCEPT",
            "matched_facts": [{"id": entry.id}],
        },
    )

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 1

        def send_customer_service_text(self, **kwargs):
            return None

        def upload_customer_service_image_bytes(
            self,
            *,
            image_data,
            content_type,
            filename,
        ):
            assert image_data == b"fake-png"
            assert content_type == "image/png"
            assert filename == "signup.png"
            return "media-uploaded-signup"

        def send_customer_service_image(self, *, open_kfid, external_userid, media_id):
            sent_images.append((open_kfid, external_userid, media_id))

    payload = {
        "msg_list": [
            {
                "msgid": "kf-uploaded-image-1",
                "msgtype": "text",
                "origin": 3,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "怎么报名"},
            }
        ]
    }

    assert handle_customer_service_payload(db, client=FakeClient(), payload=payload) == 1
    assert sent_images == [
        ("open-kfid-1", "external-user-1", "media-uploaded-signup"),
    ]


def test_customer_service_image_failure_does_not_drop_text_reply(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    sent_texts = []
    monkeypatch.setattr(
        wecom.AgentService,
        "answer",
        lambda *args, **kwargs: {
            "answer": "请填写报名信息。",
            "decision": "ACCEPT",
            "matched_facts": [
                {"id": "fact-1", "image_url": "https://example.com/signup.png"},
            ],
        },
    )

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 1

        def send_customer_service_text(self, *, open_kfid, external_userid, content):
            sent_texts.append(content)

        def upload_customer_service_image(self, *, image_url):
            raise RuntimeError("image unavailable")

    payload = {
        "msg_list": [
            {
                "msgid": "kf-image-failure-1",
                "msgtype": "text",
                "origin": 3,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "怎么报名"},
            }
        ]
    }

    assert handle_customer_service_payload(db, client=FakeClient(), payload=payload) == 1
    assert sent_texts == ["请填写报名信息。"]


def test_customer_service_payload_ignores_non_customer_text(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    sent_messages = []
    monkeypatch.setattr(wecom.AgentService, "answer", _fake_answer)

    class FakeClient:
        def send_customer_service_text(self, *, open_kfid, external_userid, content):
            sent_messages.append((open_kfid, external_userid, content))

    payload = {
        "msg_list": [
            {
                "msgid": "kf-msg-from-agent",
                "msgtype": "text",
                "origin": 5,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "agent response"},
            }
        ]
    }

    assert handle_customer_service_payload(db, client=FakeClient(), payload=payload) == 0
    assert sent_messages == []


def test_customer_service_messages_reuse_agent_session_per_user(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    answer_calls = []

    def fake_answer(self, db, *, user, message, session_id):
        answer_calls.append((user.username, message, session_id))
        return {"answer": f"answer:{message}"}

    monkeypatch.setattr(wecom.AgentService, "answer", fake_answer)

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 1

        def send_customer_service_text(self, *, open_kfid, external_userid, content):
            return None

    def payload(msg_id, external_userid, content):
        return {
            "msg_list": [
                {
                    "msgid": msg_id,
                    "msgtype": "text",
                    "origin": 3,
                    "external_userid": external_userid,
                    "open_kfid": "open-kfid-1",
                    "text": {"content": content},
                }
            ]
        }

    client = FakeClient()
    assert handle_customer_service_payload(
        db,
        client=client,
        payload=payload("msg-1", "external-user-1", "first"),
    ) == 1
    assert handle_customer_service_payload(
        db,
        client=client,
        payload=payload("msg-2", "external-user-1", "second"),
    ) == 1
    assert handle_customer_service_payload(
        db,
        client=client,
        payload=payload("msg-3", "external-user-2", "other"),
    ) == 1

    assert answer_calls[0][2] == answer_calls[1][2]
    assert answer_calls[2][2] != answer_calls[0][2]


def test_customer_service_handoff_moves_session_to_waiting_pool(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    sent_messages = []
    handoffs = []
    monkeypatch.setattr(
        wecom.AgentService,
        "answer",
        lambda *args, **kwargs: {
            "answer": "好的，我会为你转接人工客服。",
            "decision": "HANDOFF",
        },
    )

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 1

        def send_customer_service_text(self, *, open_kfid, external_userid, content):
            sent_messages.append((open_kfid, external_userid, content))

        def handoff_customer_service_session(self, *, open_kfid, external_userid):
            handoffs.append((open_kfid, external_userid))
            return 2, ""

    payload = {
        "msg_list": [
            {
                "msgid": "kf-handoff-1",
                "msgtype": "text",
                "origin": 3,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "转人工客服"},
            }
        ]
    }

    assert handle_customer_service_payload(
        db,
        client=FakeClient(),
        payload=payload,
    ) == 1
    assert sent_messages == [
        (
            "open-kfid-1",
            "external-user-1",
            "好的，我会为你转接人工客服。",
        )
    ]
    assert handoffs == [("open-kfid-1", "external-user-1")]
    status = customer_service_poller_status()
    assert status["last_handoff_state"] == 2
    assert status["last_handoff_servicer_userid"] == ""


def test_customer_service_does_not_reply_during_human_service(db, monkeypatch):
    Base.metadata.create_all(bind=db.connection())
    monkeypatch.setattr(
        wecom.AgentService,
        "answer",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("bot must remain silent during human service")
        ),
    )

    class FakeClient:
        def ensure_customer_service_session_ready(self, *, open_kfid, external_userid):
            return 3

        def send_customer_service_text(self, **kwargs):
            raise AssertionError("bot must not send during human service")

    payload = {
        "msg_list": [
            {
                "msgid": "kf-human-1",
                "msgtype": "text",
                "origin": 3,
                "external_userid": "external-user-1",
                "open_kfid": "open-kfid-1",
                "text": {"content": "人工还在吗"},
            }
        ]
    }

    before = customer_service_poller_status()["human_state_suppressed_count"]
    assert handle_customer_service_payload(
        db,
        client=FakeClient(),
        payload=payload,
    ) == 0
    status = customer_service_poller_status()
    assert status["last_service_state"] == 3
    assert status["human_state_suppressed_count"] == before + 1


def test_customer_service_session_transitions_from_unassigned(monkeypatch):
    client = WeComClient()
    transitions = []
    monkeypatch.setattr(client, "get_customer_service_state", lambda **kwargs: 0)
    monkeypatch.setattr(
        client,
        "transition_customer_service_state",
        lambda **kwargs: transitions.append(kwargs),
    )

    state = client.ensure_customer_service_session_ready(
        open_kfid="open-kfid-1",
        external_userid="external-user-1",
    )

    assert state == 1
    assert transitions == [
        {
            "open_kfid": "open-kfid-1",
            "external_userid": "external-user-1",
            "service_state": 1,
        }
    ]


def test_customer_service_handoff_uses_waiting_pool_without_servicer(monkeypatch):
    client = WeComClient()
    transitions = []
    monkeypatch.setattr(
        client.settings,
        "wecom_kf_handoff_servicer_userid",
        "",
    )
    monkeypatch.setattr(
        client,
        "transition_customer_service_state",
        lambda **kwargs: transitions.append(kwargs),
    )

    state, servicer_userid = client.handoff_customer_service_session(
        open_kfid="open-kfid-1",
        external_userid="external-user-1",
    )

    assert (state, servicer_userid) == (2, "")
    assert transitions == [
        {
            "open_kfid": "open-kfid-1",
            "external_userid": "external-user-1",
            "service_state": 2,
            "servicer_userid": "",
        }
    ]


def test_customer_service_handoff_can_target_configured_servicer(monkeypatch):
    client = WeComClient()
    transitions = []
    monkeypatch.setattr(
        client.settings,
        "wecom_kf_handoff_servicer_userid",
        "zhangsan",
    )
    monkeypatch.setattr(
        client,
        "transition_customer_service_state",
        lambda **kwargs: transitions.append(kwargs),
    )

    state, servicer_userid = client.handoff_customer_service_session(
        open_kfid="open-kfid-1",
        external_userid="external-user-1",
    )

    assert (state, servicer_userid) == (3, "zhangsan")
    assert transitions == [
        {
            "open_kfid": "open-kfid-1",
            "external_userid": "external-user-1",
            "service_state": 3,
            "servicer_userid": "zhangsan",
        }
    ]


def test_list_customer_service_servicers_keeps_access_token(monkeypatch):
    client = WeComClient()
    requests = []
    monkeypatch.setattr(client, "access_token", lambda: "access-token-1")

    def fake_get(url, *, params, timeout):
        requests.append((url, params, timeout))
        return SimpleNamespace(
            json=lambda: {
                "errcode": 0,
                "servicer_list": [{"userid": "haban"}],
            }
        )

    monkeypatch.setattr("app.wecom.client.httpx.get", fake_get)

    result = client.list_customer_service_servicers(open_kfid="open-kfid-1")

    assert result == [{"userid": "haban"}]
    assert requests == [
        (
            "https://qyapi.weixin.qq.com/cgi-bin/kf/servicer/list",
            {
                "access_token": "access-token-1",
                "open_kfid": "open-kfid-1",
            },
            10,
        )
    ]


def test_servicer_manager_adds_missing_configured_servicer(monkeypatch):
    calls = []

    class FakeClient:
        def list_customer_service_servicers(self, *, open_kfid):
            calls.append(("list", open_kfid))
            return [{"userid": "lisi"}]

        def add_customer_service_servicers(self, *, open_kfid, userids):
            calls.append(("add", open_kfid, userids))

    monkeypatch.setattr(
        servicer_manager,
        "get_settings",
        lambda: SimpleNamespace(
            wecom_kf_open_kfid="open-kfid-1",
            wecom_kf_handoff_servicer_userid="zhangsan",
        ),
    )

    result = servicer_manager.ensure_configured_handoff_servicer(
        client=FakeClient()
    )

    assert result == "zhangsan"
    assert calls == [
        ("list", "open-kfid-1"),
        ("add", "open-kfid-1", ["zhangsan"]),
    ]


def test_wecom_conversation_reuses_session_and_isolates_users(db):
    first_user, first_session = get_or_create_wecom_conversation(
        db,
        wecom_user_id="kf:open-kfid-1:external-user-1",
    )
    same_user, same_session = get_or_create_wecom_conversation(
        db,
        wecom_user_id="kf:open-kfid-1:external-user-1",
    )
    other_user, other_session = get_or_create_wecom_conversation(
        db,
        wecom_user_id="kf:open-kfid-1:external-user-2",
    )
    other_account_user, other_account_session = get_or_create_wecom_conversation(
        db,
        wecom_user_id="kf:open-kfid-2:external-user-1",
    )

    assert same_user.id == first_user.id
    assert same_session.id == first_session.id
    assert other_user.id != first_user.id
    assert other_session.id != first_session.id
    assert other_account_user.id != first_user.id
    assert other_account_session.id != first_session.id


def _fake_answer(self, db, *, user, message, session_id):
    assert user.username in {
        "wecom:wecom-user-1",
        "wecom:kf:open-kfid-1:external-user-1",
    }
    assert message == "schedule?"
    if user.username.startswith("wecom:kf:"):
        assert session_id
    else:
        assert session_id is None
    return {"answer": "wecom answer"}


def _post_message(crypto: WeComCrypto, *, content: str):
    message = _message_xml(content=content)
    encrypted = crypto.encrypt(message)
    timestamp = "12345"
    nonce = "nonce"
    signature = crypto.signature(timestamp=timestamp, nonce=nonce, encrypted=encrypted)
    client = TestClient(app)
    return client.post(
        "/wecom/callback",
        params={
            "msg_signature": signature,
            "timestamp": timestamp,
            "nonce": nonce,
        },
        content=_encrypted_xml(encrypted),
    )


def _message_xml(*, content: str) -> str:
    root = ET.Element("xml")
    values = {
        "ToUserName": "agent",
        "FromUserName": "wecom-user-1",
        "CreateTime": "123",
        "MsgType": "text",
        "Content": content,
        "MsgId": "1",
        "AgentID": "1000001",
    }
    for key, value in values.items():
        child = ET.SubElement(root, key)
        child.text = value
    return ET.tostring(root, encoding="unicode")


def _encrypted_xml(encrypted: str) -> str:
    root = ET.Element("xml")
    child = ET.SubElement(root, "Encrypt")
    child.text = encrypted
    return ET.tostring(root, encoding="unicode")


def _kf_event_xml(*, token: str) -> str:
    root = ET.Element("xml")
    values = {
        "ToUserName": CORP_ID,
        "CreateTime": "123",
        "MsgType": "event",
        "Event": "kf_msg_or_event",
        "Token": token,
        "OpenKfId": "open-kfid-1",
    }
    for key, value in values.items():
        child = ET.SubElement(root, key)
        child.text = value
    return ET.tostring(root, encoding="unicode")
