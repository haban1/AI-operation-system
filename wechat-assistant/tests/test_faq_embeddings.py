from types import SimpleNamespace

import pytest

from app.faq.embeddings import FAQEmbeddingService
from app.faq.service import FAQService
from app.intent.models import IntentDecisionType
from app.intent.router import IntentRouter
from app.llm.client import DashScopeEmbeddingClient
from app.models.entities import FAQEmbedding, FAQEntry, Role, User


class QueueEmbeddingClient:
    def __init__(self, responses: list[list[list[float]]]) -> None:
        self.responses = list(responses)
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]] | None:
        self.calls.append(list(texts))
        return self.responses.pop(0)


class StubFAQEmbeddingService:
    def ensure_embeddings(self, db, entries, *, force=False):
        return {
            entry.id: [0.64, 0.7683749085] if "refund" in entry.question.lower() else [0.0, 1.0]
            for entry in entries
        }

    def embed_query(self, question):
        return [1.0, 0.0]


class RankedFactEmbeddingService:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self.vectors = vectors
        self.ensure_calls = 0

    def ensure_embeddings(self, db, entries, *, force=False):
        self.ensure_calls += 1
        return {entry.id: self.vectors[entry.id] for entry in entries}

    def embed_query(self, question):
        return [1.0, 0.0]


def _faq(db, question: str, answer: str) -> FAQEntry:
    entry = FAQEntry(question=question, answer=answer, aliases=[], keywords=[])
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def _user(db) -> User:
    user = User(username="embedding-user", password_hash="x", role=Role.student)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_embedding_service_persists_normalized_vectors_and_refreshes_stale_content(db):
    entry = _faq(db, "How do I request a refund?", "Submit a refund request.")
    entry.category = "Deployment verification"
    entry.domain = "operations"
    entry.intent_id = "operations.verify"
    db.commit()
    client = QueueEmbeddingClient([[[3.0, 4.0]], [[0.0, 2.0]]])
    settings = SimpleNamespace(
        dashscope_embedding_model="embedding-test",
        dashscope_embedding_dimensions=2,
    )
    service = FAQEmbeddingService(client=client, settings=settings)

    first = service.ensure_embeddings(db, [entry])
    second = service.ensure_embeddings(db, [entry])

    assert first[entry.id] == pytest.approx([0.6, 0.8])
    assert second[entry.id] == pytest.approx([0.6, 0.8])
    assert len(client.calls) == 1
    stored = db.get(FAQEmbedding, entry.id)
    assert stored.model == "embedding-test"
    assert stored.dimension == 2
    assert "通用咨询" in client.calls[0][0]
    assert "Deployment verification" in client.calls[0][0]
    assert "operations.verify" not in client.calls[0][0]

    entry.aliases = ["Can I get my money back?"]
    db.commit()
    refreshed = service.ensure_embeddings(db, [entry])

    assert refreshed[entry.id] == pytest.approx([0.0, 1.0])
    assert len(client.calls) == 2
    assert "Can I get my money back?" in client.calls[1][0]


def test_faq_service_uses_embedding_for_different_wording(db):
    refund = _faq(db, "How do I request a refund?", "Submit a refund request.")
    _faq(db, "Where is the classroom?", "The classroom is on floor three.")
    service = FAQService(
        threshold=0.62,
        embedding_service=StubFAQEmbeddingService(),
    )

    match = service.match(db, "Can I get my money back?")

    assert match.entry.id == refund.id
    assert match.match_type == "embedding"
    assert match.score == pytest.approx(0.64)


def test_intent_router_accepts_high_confidence_embedding_candidate_without_llm_judge(db):
    user = _user(db)
    refund = _faq(db, "How do I request a refund?", "Submit a refund request.")
    refund.course_code = "weekly_course"
    refund.course_name = "周周有课"
    refund.intent_code = "pricing"
    refund.intent_id = "weekly_course.pricing"
    db.commit()
    service = FAQService(
        threshold=0.62,
        embedding_service=StubFAQEmbeddingService(),
    )

    decision = IntentRouter(faq_service=service).route(
        db,
        user=user,
        message="周周有课可以退款吗？",
    )

    assert decision.decision == IntentDecisionType.accept
    assert decision.matched_faq_id == refund.id
    assert decision.intent_id == "weekly_course.pricing"
    assert decision.match_type == "exact"
    assert decision.sources == ["EXACT", "RRF"]


def test_fact_retrieval_uses_weighted_rrf_to_fuse_text_and_vector_ranks(db):
    lexical_first = _faq(db, "文本最相关事实", "文本渠道排名第一。")
    balanced = _faq(db, "双路相关事实", "文本和向量都相关。")
    vector_first = _faq(db, "向量最相关事实", "向量渠道排名靠前。")
    for entry in (lexical_first, balanced, vector_first):
        entry.course_code = "weekly_course"
        entry.intent_code = "course_content"
        entry.intent_id = "weekly_course.course_content"
    db.commit()

    embeddings = RankedFactEmbeddingService(
        {
            lexical_first.id: [0.6, 0.8],
            balanced.id: [1.0, 0.0],
            vector_first.id: [0.8, 0.6],
        }
    )
    service = FAQService(embedding_service=embeddings)
    service._lexical_ranking = lambda normalized_query, entries: [
        (lexical_first, 0.9, "similar"),
        (balanced, 0.8, "similar"),
        (vector_first, 0.7, "similar"),
    ]

    candidates = service.rank_facts_rrf(
        db,
        ["这门课包含什么内容"],
        limit=3,
        course_code="weekly_course",
        intent_code="course_content",
    )

    assert [candidate.entry.id for candidate in candidates] == [
        balanced.id,
        lexical_first.id,
        vector_first.id,
    ]
    assert candidates[0].match_type == "rrf"
    assert candidates[0].lexical_rank == 2
    assert candidates[0].embedding_rank == 1
    assert candidates[0].lexical_score == pytest.approx(0.8)
    assert candidates[0].embedding_score == pytest.approx(1.0)


def test_fact_rrf_exact_match_short_circuits_vector_retrieval(db):
    exact = _faq(db, "实操安排", "课程包含现场实操。")
    exact.aliases = ["会实操吗"]
    exact.course_code = "weekly_course"
    exact.intent_code = "course_content"
    db.commit()
    embeddings = RankedFactEmbeddingService({exact.id: [1.0, 0.0]})
    service = FAQService(embedding_service=embeddings)

    candidates = service.rank_facts_rrf(
        db,
        ["会实操吗"],
        course_code="weekly_course",
        intent_code="course_content",
    )

    assert candidates[0].entry.id == exact.id
    assert candidates[0].match_type == "exact"
    assert embeddings.ensure_calls == 0


def test_dashscope_embedding_client_batches_requests_and_orders_response(monkeypatch):
    calls: list[dict] = []

    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        batch = kwargs["json"]["input"]
        data = [
            {"index": index, "embedding": [float(len(text)), float(index + 1)]}
            for index, text in enumerate(batch)
        ]
        return FakeResponse({"data": list(reversed(data))})

    monkeypatch.setattr("app.llm.client.httpx.post", fake_post)
    settings = SimpleNamespace(
        llm_enabled=True,
        faq_embedding_enabled=True,
        dashscope_api_key="test-key",
        dashscope_base_url="https://example.test/v1",
        dashscope_embedding_model="embedding-test",
        dashscope_embedding_dimensions=256,
        dashscope_embedding_batch_size=2,
        llm_timeout_seconds=5.0,
    )
    client = DashScopeEmbeddingClient(settings=settings)

    result = client.embed(["a", "bbbb", "cc"])

    assert result == [[1.0, 1.0], [4.0, 2.0], [2.0, 1.0]]
    assert [len(call["json"]["input"]) for call in calls] == [2, 1]
    assert all(call["json"]["dimensions"] == 256 for call in calls)
    assert all(call["url"] == "https://example.test/v1/embeddings" for call in calls)


def test_dashscope_embedding_client_uses_separate_endpoint_and_key(monkeypatch):
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"index": 0, "embedding": [1.0, 2.0]}]}

    def fake_post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return FakeResponse()

    monkeypatch.setattr("app.llm.client.httpx.post", fake_post)
    settings = SimpleNamespace(
        llm_enabled=True,
        faq_embedding_enabled=True,
        dashscope_api_key="chat-key",
        dashscope_base_url="https://chat.example.test/v1",
        dashscope_embedding_api_key="embedding-key",
        dashscope_embedding_base_url="https://embedding.example.test/v1",
        dashscope_embedding_model="embedding-test",
        dashscope_embedding_dimensions=2,
        dashscope_embedding_batch_size=10,
        llm_timeout_seconds=5.0,
    )

    result = DashScopeEmbeddingClient(settings=settings).embed(["test"])

    assert result == [[1.0, 2.0]]
    assert calls[0]["url"] == "https://embedding.example.test/v1/embeddings"
    assert calls[0]["headers"]["Authorization"] == "Bearer embedding-key"


def test_separate_embedding_url_requires_separate_key():
    settings = SimpleNamespace(
        llm_enabled=True,
        faq_embedding_enabled=True,
        dashscope_api_key="chat-key",
        dashscope_base_url="https://chat.example.test/v1",
        dashscope_embedding_api_key="",
        dashscope_embedding_base_url="https://embedding.example.test/v1",
        dashscope_embedding_model="embedding-test",
    )

    client = DashScopeEmbeddingClient(settings=settings)

    assert client.enabled is False
    assert client.api_key == ""
