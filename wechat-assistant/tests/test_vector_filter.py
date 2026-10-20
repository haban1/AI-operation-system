from app.core.vector_store import MilvusVectorStore


class FakeEntity:
    def __init__(self, values):
        self.values = values

    def get(self, key):
        return self.values[key]


class FakeHit:
    score = 0.8

    def __init__(self):
        self.entity = FakeEntity(
            {
                "chunk_id": "chunk1",
                "material_id": "material1",
                "version": 1,
                "page_or_slide": "page 1",
                "text": "hello",
            }
        )


class FakeCollection:
    def __init__(self):
        self.kwargs = None

    def search(self, **kwargs):
        self.kwargs = kwargs
        return [[FakeHit()]]


def test_milvus_search_uses_global_material_scope():
    store = MilvusVectorStore()
    fake = FakeCollection()
    store._collection = fake

    hits = store.search(query_embedding=[0.1], top_k=3)

    assert "expr" not in fake.kwargs
    assert "course_id" not in fake.kwargs["output_fields"]
    assert hits[0].material_id == "material1"
