from app.agent.retrieval import MaterialRetriever
from app.core.vector_store import SearchHit
from app.models.entities import Role, User


class FakeCache:
    def __init__(self):
        self.values = {}

    def get_json(self, key):
        return self.values.get(key)

    def set_json(self, key, value, ttl_seconds=300):
        self.values[key] = value


class FakeLLM:
    def __init__(self):
        self.embedded_texts = None

    def embed(self, texts):
        self.embedded_texts = texts
        return [[0.1, 0.2, 0.3]]


class FakeVectorStore:
    def __init__(self):
        self.query_embedding = None
        self.top_k = None

    def search(self, *, query_embedding, top_k):
        self.query_embedding = query_embedding
        self.top_k = top_k
        return [
            SearchHit(
                chunk_id="chunk1",
                material_id="mat1",
                version=1,
                page_or_slide="page 1",
                text="Claude Code 实战课件内容",
                score=0.9,
            )
        ]


def test_material_retriever_embeds_query_before_vector_search():
    llm = FakeLLM()
    vector_store = FakeVectorStore()
    retriever = MaterialRetriever(llm=llm, vector_store=vector_store, cache=FakeCache())
    user = User(id="u1", username="student", password_hash="x", role=Role.student)

    hits = retriever.retrieve(user=user, query="Claude Code 实战讲什么？")

    assert llm.embedded_texts == ["Claude Code 实战讲什么？"]
    assert vector_store.query_embedding == [0.1, 0.2, 0.3]
    assert vector_store.top_k == retriever.settings.retrieval_top_k
    assert hits[0].chunk_id == "chunk1"
