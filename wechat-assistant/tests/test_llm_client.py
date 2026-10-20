from app.core.llm import LLMClient


class FakeEmbeddingItem:
    def __init__(self, value):
        self.embedding = [float(value)]


class FakeEmbeddingResponse:
    def __init__(self, values):
        self.data = [FakeEmbeddingItem(value) for value in values]


class FakeEmbeddings:
    def __init__(self):
        self.batch_sizes = []

    def create(self, *, model, input):
        self.batch_sizes.append(len(input))
        return FakeEmbeddingResponse(range(len(input)))


class FakeClient:
    def __init__(self):
        self.embeddings = FakeEmbeddings()


def test_llm_client_batches_embedding_requests():
    client = LLMClient()
    fake_client = FakeClient()
    client._client = fake_client
    client.settings.dashscope_embedding_batch_size = 10

    embeddings = client.embed([f"text-{index}" for index in range(25)])

    assert fake_client.embeddings.batch_sizes == [10, 10, 5]
    assert len(embeddings) == 25
