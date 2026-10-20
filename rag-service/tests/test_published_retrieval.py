import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.published_retrieval import PublishedRetrievalRequest, retrieve_published
from app.models import ReleaseCreate, TestCandidate as Candidate, TestSessionCreate as SessionCreate, TestQueryRequest as SessionQuery
from app.pipeline import RagService
from test_core import local_settings, sample_faq


@pytest.mark.asyncio
async def test_only_active_published_snippets_without_generation(tmp_path):
    settings = local_settings(tmp_path)
    settings.prepare_directories()
    service = RagService(settings)
    query = PublishedRetrievalRequest(query='示例账号如何注册？')
    try:
        upload = await service.accept_upload(content=sample_faq(), filename='faq.csv', mime_type='text/csv', metadata={'knowledgeBaseId':'main-business-kb'}, request_id='upload')
        for _ in range(100):
            if service.get_document(upload.documentId).status != 'PROCESSING': break
            await asyncio.sleep(.05)
        assert (await retrieve_published(service, query))['status'] == 'NOT_READY'
        candidates = [Candidate(documentId=upload.documentId, documentVersion=1)]
        session = service.create_test_session(SessionCreate(requestId='session', candidateDocuments=candidates))
        await service.test_query(session.testSessionId, SessionQuery(requestId='test', question=query.query))
        release = await service.start_release(ReleaseCreate(requestId='release', testSessionId=session.testSessionId, candidateDocuments=candidates))
        for _ in range(100):
            if service.release(release.releaseId).status != 'BUILDING': break
            await asyncio.sleep(.05)
        assert service.release(release.releaseId).status == 'PUBLISHED'
        # Only retriever and scope resolution may be used by the external Agent.
        service.run_query = lambda **kwargs: pytest.fail('Must not generate an answer')
        result = await retrieve_published(service, query)
        assert result['status'] == 'MATCHED'
        assert result['releaseId'] == release.releaseId
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
