from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.published_retrieval import PublishedRetrievalRequest, retrieve_published
from app.pipeline import RagService
from kb_helpers import publish_file, settle
from test_core import local_settings, sample_faq


@pytest.mark.asyncio
async def test_only_active_published_snippets_without_generation(tmp_path):
    settings = local_settings(tmp_path)
    settings.prepare_directories()
    service = RagService(settings)
    query = PublishedRetrievalRequest(query='示例账号如何注册？')
    try:
        assert (await retrieve_published(service, query))['status'] == 'NOT_READY'
        # A parsed file that has not been activated is not retrievable.
        draft = await service.accept_upload(content=sample_faq(), filename='draft.csv', mime_type='text/csv',
                                            metadata={'knowledgeBaseId': 'main-business-kb'}, request_id='draft')
        await settle(service)
        assert service.get_document(draft.documentId).status == 'READY_FOR_TEST'
        assert (await retrieve_published(service, query))['status'] == 'NOT_READY'
        upload = await publish_file(service, sample_faq(), 'faq.csv', 'text/csv')
        active = service.active_release('main-business-kb')
        # Only retriever and scope resolution may be used by the external Agent.
        service.run_query = lambda **kwargs: pytest.fail('Must not generate an answer')
        result = await retrieve_published(service, query)
        assert result['status'] == 'MATCHED'
        assert result['releaseId'] == active['release_id']
        assert all(chunk['documentId'] == upload.documentId for chunk in result['chunks'])
        assert any('手机号' in chunk['text'] for chunk in result['chunks'])
    finally:
        await service.close()


def test_retrieval_token_cannot_manage_knowledge_or_select_drafts(monkeypatch):
    from app import main
    monkeypatch.setattr(main.settings, 'retrieval_bearer_token', 'retrieval-only')
    fake = SimpleNamespace(settings=SimpleNamespace(auth_enabled=True, bearer_token='admin-only', retrieval_knowledge_base_id='main-business-kb'), active_release=lambda kb: None)
    monkeypatch.setattr(main.app.state, 'service', fake, raising=False)
    client = TestClient(main.app)
    headers = {'Authorization':'Bearer retrieval-only'}
    assert client.post('/rag-api/v1/retrieve', json={'query':'hello'}).status_code == 401
    assert client.post('/rag-api/v1/retrieve', headers={'Authorization':'Bearer admin-only'}, json={'query':'hello'}).status_code == 401
    assert client.get('/rag-api/v1/health', headers=headers).status_code == 401
    for extra in ({'releaseId':'old'}, {'testSessionId':'draft'}, {'knowledgeBaseId':'private'}):
        assert client.post('/rag-api/v1/retrieve', headers=headers, json={'query':'hello', **extra}).status_code == 422
    assert client.post('/rag-api/v1/retrieve', headers=headers, json={'query':'   '}).status_code == 422
    assert client.post('/rag-api/v1/retrieve', headers=headers, json={'query':'hello'}).json()['status'] == 'NOT_READY'
