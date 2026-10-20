from app.agent.memory import ShortTermMemory
from app.models.entities import MessageRole, Role, User


def test_short_term_memory_keeps_recent_thirty_turns_by_default(db):
    user = User(username="student", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    memory = ShortTermMemory()
    session = memory.get_or_create_session(db, user=user, session_id=None)
    for index in range(32):
        memory.add_message(db, session=session, user=user, role=MessageRole.user, content=f"q{index}")
        memory.add_message(db, session=session, user=user, role=MessageRole.assistant, content=f"a{index}")

    recent = memory.recent_messages(db, session=session)

    assert len(recent) == 60
    assert recent[0].content == "q2"
    assert recent[-1].content == "a31"


def test_session_is_scoped_to_user(db):
    user = User(username="student", password_hash="x", role=Role.student)
    other = User(username="other", password_hash="x", role=Role.student)
    db.add_all([user, other])
    db.commit()
    memory = ShortTermMemory(turns=10)
    session = memory.get_or_create_session(db, user=user, session_id=None)

    same_user_session = memory.get_or_create_session(db, user=user, session_id=session.id)

    assert same_user_session.id == session.id
    try:
        memory.get_or_create_session(db, user=other, session_id=session.id)
    except PermissionError:
        pass
    else:
        raise AssertionError("Expected session reuse by another user to be rejected")


def test_same_user_different_sessions_keep_separate_contexts(db):
    user = User(username="student", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    memory = ShortTermMemory(turns=10)
    first_session = memory.get_or_create_session(db, user=user, session_id=None)
    second_session = memory.get_or_create_session(db, user=user, session_id=None)

    memory.add_message(db, session=first_session, user=user, role=MessageRole.user, content="first chat question")
    memory.add_message(db, session=second_session, user=user, role=MessageRole.user, content="second chat question")

    first_history = memory.to_prompt_messages(db, session=first_session)
    second_history = memory.to_prompt_messages(db, session=second_session)

    assert first_session.id != second_session.id
    assert first_history == [{"role": "user", "content": "first chat question"}]
    assert second_history == [{"role": "user", "content": "second chat question"}]
