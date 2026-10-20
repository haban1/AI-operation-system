import json
from types import SimpleNamespace
import httpx
import pytest
from fastapi import BackgroundTasks, HTTPException
from app.knowledge.tianhe import TianheKnowledgeService
from app.models.entities import User, Role
from app.api import deps, wechat_robot


def test_published_snippets_and_citations(monkeypatch):
    def respond(request):
        assert request.url.path == '/rag-api/v1/retrieve'
        assert request.headers['authorization'] == 'Bearer read-only'
        assert json.loads(request.content) == {'query':'上课时间', 'topK':6}
        return httpx.Response(200, json={'status':'MATCHED', 'releaseId':'release-1', 'knowledgeVersion':3, 'chunks':[{'chunkId':'chunk-1','documentId':'doc-1','title':'课程说明','text':'周一上课','location':{'page':2},'score':.9}]})
    monkeypatch.setattr('app.knowledge.tianhe.get_settings', lambda: SimpleNamespace(tianhe_rag_base_url='http://rag',tianhe_rag_token='read-only',tianhe_rag_timeout_seconds=5,document_retrieval_top_k=6))
    decision = TianheKnowledgeService(transport=httpx.MockTransport(respond)).query(None, '上课时间')
    assert decision.document_chunks[0]['filename'] == '课程说明'
    assert decision.document_chunks[0]['page_or_slide'] == '2'
    assert decision.document_chunks[0]['release_id'] == 'release-1'
    assert decision.document_chunks[0]['text'] == '周一上课'
    service = TianheKnowledgeService(transport=httpx.MockTransport(lambda req: httpx.Response(503)))
    with pytest.raises(httpx.HTTPStatusError): service.query(None, '问题')


def test_operator_token_scoped_and_broadcast_idempotent(db, monkeypatch):
    user = User(username='admin',password_hash='unused',role=Role.admin)
    db.add(user); db.commit()
    monkeypatch.setattr(deps, 'get_settings', lambda: SimpleNamespace(tianhe_admin_token='operator-only'))
    assert deps.get_wechat_operator('operator-only', db).id == user.id
    with pytest.raises(HTTPException): deps.get_current_user('operator-only', db)
    def submit(content='hello'):
        tasks = BackgroundTasks()
        result = wechat_robot.create_wechat_robot_broadcast(background_tasks=tasks,content=content,confirm_send=True,recipients='["wxid_test"]',image=None,client_request_id='same-request',db=db,current_user=user)
        return result,tasks
    first,tasks = submit()
    second,repeated = submit()
    assert first['id'] == second['id']
    assert len(tasks.tasks) == 1 and len(repeated.tasks) == 0
    with pytest.raises(HTTPException) as conflict: submit('different')
    assert conflict.value.status_code == 409
    assert len(wechat_robot.list_wechat_robot_broadcasts(db=db,current_user=user)['items']) == 1


def test_agent_selects_tianhe_only_when_enabled(monkeypatch):
    from app.agent.service import AgentService
    from app.core.config import get_settings
    monkeypatch.setattr(get_settings(), 'tianhe_knowledge_enabled', True)
    assert isinstance(AgentService().document_service, TianheKnowledgeService)
