from io import BytesIO
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from starlette.datastructures import Headers

from app.api import wechat_robot as wechat_robot_api
from app.models.entities import (
    FAQEntry,
    Role,
    User,
    WechatRobotBroadcast,
    WechatRobotHandoffNotifier,
    WechatRobotOutboundReceipt,
    WechatRobotUserBinding,
    utcnow,
)
from app.wechat_robot import client as client_module
from app.wechat_robot.broadcast import execute_wechat_robot_broadcast
from app.wechat_robot.service import (
    parse_wechat_robot_messages,
    process_wechat_robot_payload,
    register_programmatic_outbound,
)


def test_parse_private_and_group_messages():
    messages = parse_wechat_robot_messages(
        {
            "Data": {
                "AddMsgs": [
                    {
                        "NewMsgId": 1,
                        "MsgType": 1,
                        "FromUserName": {"String": "wxid_friend"},
                        "ToUserName": {"string": "wxid_robot"},
                        "Content": {"String": "你好"},
                    },
                    {
                        "NewMsgId": 2,
                        "MsgType": 1,
                        "FromUserName": {"String": "room@chatroom"},
                        "ToUserName": {"String": "wxid_robot"},
                        "Content": {"String": "wxid_member:\n课程什么时候开始"},
                    },
                ]
            }
        }
    )

    assert messages[0].from_wxid == "wxid_friend"
    assert messages[0].content == "你好"
    assert messages[1].room_wxid == "room@chatroom"
    assert messages[1].sender_wxid == "wxid_member"
    assert messages[1].content == "课程什么时候开始"


def test_private_message_greets_then_replies_once(db, monkeypatch):
    sent = []
    answers = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=True,
            wechat_robot_greeting_text="欢迎咨询",
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content, tuple(at)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            answers.append((message, session_id))
            return {"answer": "AI回答"}

    payload = _private_payload()
    first = process_wechat_robot_payload(
        db,
        payload=payload,
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )
    duplicate = process_wechat_robot_payload(
        db,
        payload=payload,
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert first == {
        "received": 1,
        "replied": 1,
        "greeted": 1,
        "ignored": 0,
        "failed": 0,
    }
    assert duplicate["ignored"] == 1
    assert sent == [
        ("wxid_friend", "欢迎咨询", ()),
        ("wxid_friend", "AI回答", ()),
    ]
    assert len(answers) == 1
    assert db.query(WechatRobotUserBinding).one().greeted_at is not None


def test_group_message_requires_mention(db, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content, tuple(at)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {"answer": "群聊回答"}

    ignored = process_wechat_robot_payload(
        db,
        payload=_group_payload(msg_id=2, mentioned=False),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )
    replied = process_wechat_robot_payload(
        db,
        payload=_group_payload(msg_id=3, mentioned=True),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert ignored["ignored"] == 1
    assert replied["replied"] == 1
    assert sent == [
        ("room@chatroom", "群聊回答", ("wxid_member",)),
    ]
    assert db.query(WechatRobotUserBinding).count() == 1


def test_robot_wxid_falls_back_to_message_recipient(db, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content, tuple(at)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {"answer": "群聊回答"}

    result = process_wechat_robot_payload(
        db,
        payload=_group_payload(msg_id=4, mentioned=True),
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert result["replied"] == 1
    assert sent == [
        ("room@chatroom", "群聊回答", ("wxid_member",)),
    ]


def test_confirmed_new_friend_only_sends_greeting(db, monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=True,
            wechat_robot_greeting_text="欢迎咨询",
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content, tuple(at)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            raise AssertionError("New friend confirmation must not call the AI")

    payload = _private_payload()
    payload["AddMsgs"][0]["MsgType"] = 10000
    payload["AddMsgs"][0]["Content"]["String"] = "你已添加了新朋友，现在可以开始聊天了"
    result = process_wechat_robot_payload(
        db,
        payload=payload,
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert result["greeted"] == 1
    assert result["replied"] == 0
    assert sent == [("wxid_friend", "欢迎咨询", ())]


def test_handoff_pauses_only_that_conversation(db, monkeypatch):
    sent = []
    answer_calls = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
            wechat_robot_handoff_message="已为你转接人工客服，请稍候。",
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content, tuple(at)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            answer_calls.append(message)
            return {
                "answer": "这个问题需要进一步处理。",
                "decision": "HANDOFF",
            }

    first = process_wechat_robot_payload(
        db,
        payload=_private_payload(),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )
    second_payload = _private_payload()
    second_payload["AddMsgs"][0]["NewMsgId"] = 2
    second_payload["AddMsgs"][0]["Content"]["String"] = "请问有人吗"
    second = process_wechat_robot_payload(
        db,
        payload=second_payload,
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    binding = db.query(WechatRobotUserBinding).one()
    assert first["replied"] == 1
    assert second["ignored"] == 1
    assert answer_calls == ["课程什么时候开始"]
    assert sent == [
        (
            "wxid_friend",
            "这个问题需要进一步处理。\n\n已为你转接人工客服，请稍候。",
            (),
        )
    ]
    assert binding.handoff_started_at is not None
    assert binding.handoff_resolved_at is None
    assert binding.handoff_last_message == "请问有人吗"


def test_handoff_notifies_selected_friend_once(db, monkeypatch):
    db.add(
        WechatRobotHandoffNotifier(
            id="default",
            recipient_wxid="wxid_staff",
            recipient_name="值班客服",
        )
    )
    db.commit()
    sent = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
            wechat_robot_handoff_message="已为你转接人工客服，请稍候。",
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content, tuple(at)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {
                "answer": "这个问题需要人工处理。",
                "decision": "HANDOFF",
            }

    first = process_wechat_robot_payload(
        db,
        payload=_private_payload(),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )
    second_payload = _private_payload()
    second_payload["AddMsgs"][0]["NewMsgId"] = 2
    second_payload["AddMsgs"][0]["Content"]["String"] = "还在吗"
    second = process_wechat_robot_payload(
        db,
        payload=second_payload,
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert first["replied"] == 1
    assert second["ignored"] == 1
    assert [item[0] for item in sent] == [
        "wxid_friend",
        "wxid_staff",
    ]
    notification = sent[1][1]
    assert "【人工接管通知】" in notification
    assert "客户：wxid_friend" in notification
    assert "消息：课程什么时候开始" in notification
    assert "请尽快登录机器人微信接管" in notification
    assert "请勿直接回复本通知" in notification


def test_admin_can_select_handoff_notifier(db, monkeypatch):
    admin = User(
        username="notifier-admin",
        password_hash="hash",
        role=Role.admin,
    )
    db.add(admin)
    db.commit()

    class FakeClient:
        def list_friends(self):
            return [
                {
                    "wechat_id": "wxid_staff",
                    "nickname": "值班客服",
                    "remark": "客服小王",
                }
            ]

    monkeypatch.setattr(
        wechat_robot_api,
        "WechatRobotClient",
        lambda: FakeClient(),
    )

    result = wechat_robot_api.save_wechat_robot_handoff_notifier(
        wechat_robot_api.WechatRobotHandoffNotifierRequest(
            wechat_id="wxid_staff",
        ),
        db=db,
        current_user=admin,
    )

    notifier = db.get(WechatRobotHandoffNotifier, "default")
    assert result["enabled"] is True
    assert result["wechat_id"] == "wxid_staff"
    assert result["name"] == "客服小王"
    assert notifier is not None
    assert notifier.recipient_wxid == "wxid_staff"


def test_handoff_stays_active_when_notifier_send_fails(db, monkeypatch):
    db.add(
        WechatRobotHandoffNotifier(
            id="default",
            recipient_wxid="wxid_staff",
            recipient_name="值班客服",
        )
    )
    db.commit()
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
            wechat_robot_handoff_message="已为你转接人工客服，请稍候。",
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            if to_wxid == "wxid_staff":
                raise RuntimeError("notifier unavailable")

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {
                "answer": "这个问题需要人工处理。",
                "decision": "HANDOFF",
            }

    result = process_wechat_robot_payload(
        db,
        payload=_private_payload(),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    binding = db.query(WechatRobotUserBinding).one()
    assert result["replied"] == 1
    assert result["failed"] == 0
    assert binding.handoff_started_at is not None
    assert binding.handoff_resolved_at is None


def test_manual_outgoing_message_pauses_that_friend(db, monkeypatch):
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            raise AssertionError("Outgoing messages must not call the AI")

    result = process_wechat_robot_payload(
        db,
        payload=_outgoing_payload(content="我来人工处理"),
        robot_wxid="wxid_robot",
        agent=FakeAgent(),
    )

    binding = db.query(WechatRobotUserBinding).one()
    assert result == {
        "received": 1,
        "replied": 0,
        "greeted": 0,
        "ignored": 1,
        "failed": 0,
    }
    assert binding.peer_wxid == "wxid_friend"
    assert binding.handoff_started_at is not None
    assert binding.handoff_resolved_at is None
    assert binding.handoff_reason == "客服通过电脑微信主动接管"
    assert binding.handoff_last_message == "我来人工处理"


def test_programmatic_outgoing_echo_does_not_pause_friend(db, monkeypatch):
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )
    register_programmatic_outbound(
        db,
        robot_wxid="wxid_robot",
        to_wxid="wxid_friend",
        msg_type=1,
        content="机器人自动回复",
    )

    result = process_wechat_robot_payload(
        db,
        payload=_outgoing_payload(content="机器人自动回复"),
        robot_wxid="wxid_robot",
    )

    assert result["ignored"] == 1
    assert result["failed"] == 0
    assert db.query(WechatRobotUserBinding).count() == 0
    assert db.query(WechatRobotOutboundReceipt).count() == 0


def test_manual_outgoing_image_pauses_friend(db, monkeypatch):
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    result = process_wechat_robot_payload(
        db,
        payload=_outgoing_payload(
            msg_id=12,
            msg_type=3,
            content="",
        ),
        robot_wxid="wxid_robot",
    )

    binding = db.query(WechatRobotUserBinding).one()
    assert result["ignored"] == 1
    assert result["failed"] == 0
    assert binding.handoff_started_at is not None
    assert binding.handoff_last_message == "[图片]"


def test_admin_can_resume_handoff(db):
    admin = User(
        username="handoff-admin",
        password_hash="hash",
        role=Role.admin,
    )
    customer = User(
        username="handoff-customer",
        password_hash="hash",
        role=Role.student,
    )
    db.add_all([admin, customer])
    db.flush()
    binding = WechatRobotUserBinding(
        user_id=customer.id,
        robot_wxid="wxid_robot",
        conversation_key="private:wxid_friend",
        peer_wxid="wxid_friend",
        handoff_started_at=utcnow(),
        handoff_updated_at=utcnow(),
        handoff_reason="转人工",
        handoff_last_message="请人工处理",
    )
    db.add(binding)
    db.commit()

    result = wechat_robot_api.resume_wechat_robot_handoff_session(
        binding.id,
        db=db,
        current_user=admin,
    )

    assert result == {"success": True, "id": binding.id}
    assert binding.handoff_resolved_at is not None


def test_expired_handoff_automatically_resumes_on_next_message(db, monkeypatch):
    customer = User(
        username="expired-handoff-customer",
        password_hash="hash",
        role=Role.student,
    )
    db.add(customer)
    db.flush()
    binding = WechatRobotUserBinding(
        user_id=customer.id,
        robot_wxid="wxid_robot",
        conversation_key="private:wxid_friend",
        peer_wxid="wxid_friend",
        handoff_started_at=utcnow() - timedelta(hours=25),
        handoff_updated_at=utcnow() - timedelta(hours=25),
        handoff_reason="转人工",
        handoff_last_message="等待人工",
    )
    db.add(binding)
    db.commit()
    sent = []
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent.append((to_wxid, content))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {"answer": "机器人已恢复", "decision": "ACCEPT"}

    result = process_wechat_robot_payload(
        db,
        payload=_private_payload(),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert result["replied"] == 1
    assert sent == [("wxid_friend", "机器人已恢复")]
    assert binding.handoff_resolved_at is not None


def test_handoff_queue_lists_active_customer(db, monkeypatch):
    admin = User(
        username="queue-admin",
        password_hash="hash",
        role=Role.admin,
    )
    customer = User(
        username="queue-customer",
        password_hash="hash",
        role=Role.student,
    )
    db.add_all([admin, customer])
    db.flush()
    binding = WechatRobotUserBinding(
        user_id=customer.id,
        robot_wxid="wxid_robot",
        conversation_key="private:wxid_friend",
        peer_wxid="wxid_friend",
        handoff_started_at=utcnow(),
        handoff_updated_at=utcnow(),
        handoff_reason="退款问题",
        handoff_last_message="请尽快处理",
    )
    db.add(binding)
    db.commit()
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_handoff_auto_resume_hours=24,
        ),
    )

    class FakeClient:
        def list_friends(self):
            return [
                {
                    "wechat_id": "wxid_friend",
                    "nickname": "测试客户",
                    "remark": "",
                }
            ]

    monkeypatch.setattr(
        wechat_robot_api,
        "WechatRobotClient",
        lambda: FakeClient(),
    )

    result = wechat_robot_api.list_wechat_robot_handoffs(
        db=db,
        current_user=admin,
    )

    assert result["count"] == 1
    assert result["items"][0]["name"] == "测试客户"
    assert result["items"][0]["reason"] == "退款问题"


def test_mass_send_client_uses_client_endpoint(monkeypatch):
    requests = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"code": 200, "message": "", "data": None}

    monkeypatch.setattr(
        client_module,
        "get_settings",
        lambda: SimpleNamespace(
            wechat_robot_base_url="http://robot:9001",
            wechat_robot_api_authorization="",
            wechat_robot_request_timeout_seconds=30,
        ),
    )
    monkeypatch.setattr(
        client_module.httpx,
        "post",
        lambda url, **kwargs: requests.append((url, kwargs)) or FakeResponse(),
    )

    client_module.WechatRobotClient().mass_send_text(
        to_wxids=["wxid_a", "wxid_a", "room@chatroom"],
        content="通知",
    )

    assert requests == [
        (
            "http://robot:9001/api/v1/robot/message/send/masssend",
            {
                "json": {
                    "to_wxids": ["wxid_a", "room@chatroom"],
                    "content": "通知",
                },
                "headers": {},
                "timeout": 30,
            },
        )
    ]


def test_send_image_urls_uses_remote_image_endpoint(monkeypatch):
    requests = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"code": 200, "message": "", "data": None}

    monkeypatch.setattr(
        client_module,
        "get_settings",
        lambda: SimpleNamespace(
            wechat_robot_base_url="http://robot:9001",
            wechat_robot_api_authorization="",
            wechat_robot_request_timeout_seconds=30,
        ),
    )
    monkeypatch.setattr(
        client_module.httpx,
        "post",
        lambda url, **kwargs: requests.append((url, kwargs)) or FakeResponse(),
    )

    client_module.WechatRobotClient().send_image_urls(
        to_wxid="wxid_friend",
        image_urls=["https://example.com/a.jpg", "https://example.com/a.jpg"],
    )

    assert requests == [
        (
            "http://robot:9001/api/v1/robot/message/send/image/url",
            {
                "json": {
                    "to_wxid": "wxid_friend",
                    "image_urls": ["https://example.com/a.jpg"],
                },
                "headers": {},
                "timeout": 30,
            },
        )
    ]


def test_list_friends_reads_all_pages_and_filters_contacts(monkeypatch):
    responses = {
        1: {
            "code": 200,
            "data": {
                "total": 4,
                "items": [
                    {"wechat_id": "wxid_a", "type": "friend"},
                    {"wechat_id": "room@chatroom", "type": "chat_room"},
                ],
            },
        },
        2: {
            "code": 200,
            "data": {
                "total": 4,
                "items": [
                    {"wechat_id": "wxid_a", "type": "friend"},
                    {"wechat_id": "wxid_b", "type": "friend"},
                ],
            },
        },
        3: {
            "code": 200,
            "data": {
                "total": 4,
                "items": [],
            },
        },
    }

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    monkeypatch.setattr(
        client_module,
        "get_settings",
        lambda: SimpleNamespace(
            wechat_robot_base_url="http://robot:9001",
            wechat_robot_api_authorization="",
            wechat_robot_request_timeout_seconds=30,
        ),
    )
    monkeypatch.setattr(
        client_module.httpx,
        "get",
        lambda url, **kwargs: FakeResponse(
            responses[kwargs["params"]["page_index"]]
        ),
    )

    friends = client_module.WechatRobotClient().list_friends(page_size=2)

    assert [item["wechat_id"] for item in friends] == ["wxid_a", "wxid_b"]


def test_list_friends_excludes_inactive_contacts_across_pages(monkeypatch):
    pages = {
        1: [{"wechat_id": "deleted", "type": "friend", "status": -10001},
            {"wechat_id": "error", "type": "friend", "status": -1}],
        2: [{"wechat_id": "unknown", "type": "friend", "status": None},
            {"wechat_id": "active", "type": "friend", "status": 0}],
        3: [{"wechat_id": "active_string", "type": "friend", "status": "0"}],
    }
    monkeypatch.setattr(
        client_module.WechatRobotClient,
        "_get",
        lambda self, path, *, params: {
            "total": 5, "items": pages[params["page_index"]]
        },
    )

    friends = client_module.WechatRobotClient().list_friends(page_size=2)

    assert [item["wechat_id"] for item in friends] == ["active", "active_string"]


def test_execute_broadcast_sends_only_selected_friends(db, monkeypatch):
    broadcast = WechatRobotBroadcast(
        created_by_id="admin",
        content="课程通知",
        recipient_ids=["wxid_a", "wxid_c"],
        image_data=b"image",
        image_filename="notice.jpg",
        image_content_type="image/jpeg",
    )
    db.add(broadcast)
    db.commit()
    text_batches = []
    image_recipients = []
    monkeypatch.setattr(
        "app.wechat_robot.broadcast.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_broadcast_interval_seconds=0,
            wechat_robot_broadcast_max_recipients=10,
            wechat_robot_media_base_url="http://customer-service-api:8000",
        ),
    )

    class FakeClient:
        def sync_contacts(self):
            return None

        def list_friends(self):
            return [
                {"wechat_id": "wxid_a"},
                {"wechat_id": "wxid_b"},
                {"wechat_id": "wxid_c"},
            ]

        def send_text(self, *, to_wxid, content):
            text_batches.append((to_wxid, content))

        def send_image_urls(self, *, to_wxid, image_urls):
            image_recipients.append((to_wxid, tuple(image_urls)))

    execute_wechat_robot_broadcast(
        db,
        broadcast=broadcast,
        client=FakeClient(),
        sleep=lambda _: None,
    )

    assert text_batches == [
        ("wxid_a", "课程通知"),
        ("wxid_c", "课程通知"),
    ]
    assert [item[0] for item in image_recipients] == [
        "wxid_a",
        "wxid_c",
    ]
    assert broadcast.status == "completed"
    assert broadcast.recipient_count == 2
    assert broadcast.text_sent_count == 2
    assert broadcast.image_sent_count == 2
    assert broadcast.success_count == 2
    assert broadcast.failed_count == 0


def test_execute_broadcast_records_per_friend_image_failure(db, monkeypatch):
    broadcast = WechatRobotBroadcast(
        created_by_id="admin",
        content="课程通知",
        recipient_ids=["wxid_a", "wxid_b"],
        image_data=b"image",
    )
    db.add(broadcast)
    db.commit()
    monkeypatch.setattr(
        "app.wechat_robot.broadcast.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_broadcast_interval_seconds=0,
            wechat_robot_broadcast_max_recipients=10,
            wechat_robot_media_base_url="http://customer-service-api:8000",
        ),
    )

    class FakeClient:
        def sync_contacts(self):
            return None

        def list_friends(self):
            return [{"wechat_id": "wxid_a"}, {"wechat_id": "wxid_b"}]

        def send_text(self, *, to_wxid, content):
            return None

        def send_image_urls(self, *, to_wxid, image_urls):
            if to_wxid == "wxid_b":
                raise RuntimeError("blocked")

    execute_wechat_robot_broadcast(
        db,
        broadcast=broadcast,
        client=FakeClient(),
        sleep=lambda _: None,
    )

    assert broadcast.status == "completed"
    assert broadcast.text_sent_count == 2
    assert broadcast.image_sent_count == 1
    assert broadcast.success_count == 1
    assert broadcast.failed_count == 1
    assert "wxid_b" in broadcast.error_details[0]


def test_execute_text_only_broadcast_does_not_send_images(db, monkeypatch):
    broadcast = WechatRobotBroadcast(
        created_by_id="admin",
        content="纯文字通知",
        recipient_ids=["wxid_a", "wxid_b"],
        image_data=b"",
    )
    db.add(broadcast)
    db.commit()
    sent_text = []
    monkeypatch.setattr(
        "app.wechat_robot.broadcast.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_broadcast_interval_seconds=0,
            wechat_robot_broadcast_max_recipients=10,
            wechat_robot_media_base_url="http://customer-service-api:8000",
        ),
    )

    class FakeClient:
        def sync_contacts(self):
            return None

        def list_friends(self):
            return [{"wechat_id": "wxid_a"}, {"wechat_id": "wxid_b"}]

        def send_text(self, *, to_wxid, content):
            sent_text.append((to_wxid, content))

        def send_image_urls(self, *, to_wxid, image_urls):
            raise AssertionError("Text-only broadcast must not send images")

    execute_wechat_robot_broadcast(
        db,
        broadcast=broadcast,
        client=FakeClient(),
        sleep=lambda _: None,
    )

    assert sent_text == [
        ("wxid_a", "纯文字通知"),
        ("wxid_b", "纯文字通知"),
    ]
    assert broadcast.text_sent_count == 2
    assert broadcast.image_sent_count == 0
    assert broadcast.success_count == 2
    assert broadcast.failed_count == 0


def test_execute_image_only_broadcast_does_not_send_text(db, monkeypatch):
    broadcast = WechatRobotBroadcast(
        created_by_id="admin",
        content="",
        recipient_ids=["wxid_a", "wxid_b"],
        image_data=b"image",
        image_content_type="image/jpeg",
    )
    db.add(broadcast)
    db.commit()
    sent_images = []
    monkeypatch.setattr(
        "app.wechat_robot.broadcast.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_broadcast_interval_seconds=0,
            wechat_robot_broadcast_max_recipients=10,
            wechat_robot_media_base_url="http://customer-service-api:8000",
        ),
    )

    class FakeClient:
        def sync_contacts(self):
            return None

        def list_friends(self):
            return [{"wechat_id": "wxid_a"}, {"wechat_id": "wxid_b"}]

        def send_text(self, *, to_wxid, content):
            raise AssertionError("Image-only broadcast must not send text")

        def send_image_urls(self, *, to_wxid, image_urls):
            sent_images.append(to_wxid)

    execute_wechat_robot_broadcast(
        db,
        broadcast=broadcast,
        client=FakeClient(),
        sleep=lambda _: None,
    )

    assert sent_images == ["wxid_a", "wxid_b"]
    assert broadcast.text_sent_count == 0
    assert broadcast.image_sent_count == 2
    assert broadcast.success_count == 2
    assert broadcast.failed_count == 0


def test_create_broadcast_requires_admin_confirmation_and_stores_image(db):
    admin = User(
        username="broadcast-admin",
        password_hash="hash",
        role=Role.admin,
    )
    db.add(admin)
    db.commit()
    background_tasks = BackgroundTasks()
    image = UploadFile(
        file=BytesIO(b"jpeg-data"),
        filename="notice.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )

    result = wechat_robot_api.create_wechat_robot_broadcast(
        background_tasks=background_tasks,
        content="课程通知",
        confirm_send=True,
        recipients='["wxid_a"]',
        image=image,
        db=db,
        current_user=admin,
    )

    saved = db.get(WechatRobotBroadcast, result["id"])
    assert result["status"] == "pending"
    assert saved is not None
    assert saved.image_data == b"jpeg-data"
    assert saved.recipient_ids == ["wxid_a"]
    assert len(background_tasks.tasks) == 1


def test_create_text_only_broadcast(db):
    admin = User(
        username="text-broadcast-admin",
        password_hash="hash",
        role=Role.admin,
    )
    db.add(admin)
    db.commit()

    result = wechat_robot_api.create_wechat_robot_broadcast(
        background_tasks=BackgroundTasks(),
        content="纯文字通知",
        confirm_send=True,
        recipients='["wxid_a"]',
        image=None,
        db=db,
        current_user=admin,
    )

    saved = db.get(WechatRobotBroadcast, result["id"])
    assert result["has_image"] is False
    assert saved is not None
    assert saved.image_data == b""


def test_create_image_only_broadcast(db):
    admin = User(
        username="image-broadcast-admin",
        password_hash="hash",
        role=Role.admin,
    )
    db.add(admin)
    db.commit()
    image = UploadFile(
        file=BytesIO(b"image-only"),
        filename="notice.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )

    result = wechat_robot_api.create_wechat_robot_broadcast(
        background_tasks=BackgroundTasks(),
        content="",
        confirm_send=True,
        recipients='["wxid_a"]',
        image=image,
        db=db,
        current_user=admin,
    )

    saved = db.get(WechatRobotBroadcast, result["id"])
    assert result["has_image"] is True
    assert saved is not None
    assert saved.content == ""
    assert saved.image_data == b"image-only"


def test_private_reply_sends_uploaded_matched_fact_image(db, monkeypatch):
    sent_text = []
    sent_images = []
    entry = FAQEntry(
        fact_name="报名入口",
        question="报名入口在哪里",
        answer="请填写报名表。",
        image_data=b"image-data",
        image_filename="registration.jpg",
        image_content_type="image/jpeg",
    )
    db.add(entry)
    db.commit()
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
            wechat_robot_media_base_url="http://customer-service-api:8000",
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            sent_text.append((to_wxid, content, tuple(at)))

        def send_image_urls(self, *, to_wxid, image_urls):
            sent_images.append((to_wxid, tuple(image_urls)))

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {
                "answer": "请填写报名表。",
                "matched_facts": [{"id": entry.id}],
            }

    result = process_wechat_robot_payload(
        db,
        payload=_private_payload(),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert result["replied"] == 1
    assert sent_text == [("wxid_friend", "请填写报名表。", ())]
    assert sent_images == [
        (
            "wxid_friend",
            (f"http://customer-service-api:8000/faqs/{entry.id}/image",),
        )
    ]


def test_image_failure_does_not_fail_text_reply(db, monkeypatch):
    monkeypatch.setattr(
        "app.wechat_robot.service.get_settings",
        lambda: SimpleNamespace(
            wechat_robot_auto_reply_enabled=True,
            wechat_robot_group_reply_mode="mention",
            wechat_robot_greeting_enabled=False,
            wechat_robot_greeting_text="",
            wechat_robot_media_base_url="http://customer-service-api:8000",
        ),
    )

    class FakeClient:
        def send_text(self, *, to_wxid, content, at=()):
            return None

        def send_image_urls(self, *, to_wxid, image_urls):
            raise RuntimeError("image send failed")

    class FakeAgent:
        def answer(self, db, *, user, message, session_id):
            return {
                "answer": "文字回答",
                "matched_facts": [
                    {"id": "remote", "image_url": "https://example.com/a.jpg"}
                ],
            }

    result = process_wechat_robot_payload(
        db,
        payload=_private_payload(),
        robot_wxid="wxid_robot",
        client=FakeClient(),
        agent=FakeAgent(),
    )

    assert result["replied"] == 1
    assert result["failed"] == 0


def test_mass_send_requires_admin():
    with pytest.raises(HTTPException) as exc:
        wechat_robot_api.mass_send_wechat_robot_text(
            wechat_robot_api.WechatRobotMassSendRequest(
                recipients=["wxid_friend"],
                content="通知",
            ),
            current_user=SimpleNamespace(role=Role.student),
        )

    assert exc.value.status_code == 403


def _private_payload() -> dict:
    return {
        "AddMsgs": [
            {
                "NewMsgId": 1,
                "MsgType": 1,
                "FromUserName": {"String": "wxid_friend"},
                "ToUserName": {"String": "wxid_robot"},
                "Content": {"String": "课程什么时候开始"},
                "MsgSource": "",
            }
        ]
    }


def _group_payload(*, msg_id: int, mentioned: bool) -> dict:
    at_list = "wxid_robot" if mentioned else "wxid_someone_else"
    return {
        "AddMsgs": [
            {
                "NewMsgId": msg_id,
                "MsgType": 1,
                "FromUserName": {"String": "room@chatroom"},
                "ToUserName": {"String": "wxid_robot"},
                "Content": {"String": "wxid_member:\n课程什么时候开始"},
                "MsgSource": (
                    f"<msgsource><atuserlist><![CDATA[{at_list}]]>"
                    "</atuserlist></msgsource>"
                ),
            }
        ]
    }


def _outgoing_payload(
    *,
    msg_id: int = 11,
    msg_type: int = 1,
    content: str = "人工回复",
) -> dict:
    return {
        "AddMsgs": [
            {
                "NewMsgId": msg_id,
                "MsgType": msg_type,
                "FromUserName": {"String": "wxid_robot"},
                "ToUserName": {"String": "wxid_friend"},
                "Content": {"String": content},
                "MsgSource": "",
            }
        ]
    }
