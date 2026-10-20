import pytest

from app.config import Settings
from app.pipeline import RagService
from app.retrieval import SearchScope


@pytest.mark.asyncio
async def test_intentional_direct_generation_does_not_report_agent_failure(tmp_path, monkeypatch):
    settings = Settings(
        sqlite_path=tmp_path/'rag.db', qdrant_path=tmp_path/'qdrant',
        data_dir=tmp_path/'data', upload_dir=tmp_path/'uploads', model_cache_dir=tmp_path/'models',
        embedding_provider='hash', reranker_provider='lexical', deep_agent_enabled=False,
        generation_provider='openai_compatible', llm_base_url='https://provider.example/v1', llm_api_key='test-only',
    )
    settings.prepare_directories()
    service = RagService(settings)
    async def completion(*args, **kwargs):
        return {'result':'ANSWERED', 'answer':'工作日九点开放。', 'citation_ids':['chunk-hours']}, {'model':'test-model', 'text':'{}'}
    monkeypatch.setattr(service.llm, 'json_complete', completion)
    try:
        result = await service.agent.run(
            question='几点开放？', context_text='', evidence=[{'chunk_id':'chunk-hours','text':'工作日九点开放。'}],
            trace_id='direct-status', max_answer_chars=100, scope=SearchScope('test-kb'),
        )
        assert result.output.answer == '工作日九点开放。'
        assert result.provider == 'openai_compatible'
        status = service.provider_status()
        assert status['generation']['ready'] is True
        assert status['generation']['fallback'] is False
        assert status['deepAgent']['enabled'] is False
        assert status['deepAgent']['available'] is False
        assert status['deepAgent']['error'] is None
    finally:
        await service.close()
