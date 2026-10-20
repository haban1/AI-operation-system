from __future__ import annotations

import asyncio
import csv
import io
import json

import httpx
import pytest

from app.config import Settings
from app.models import QueryMessage, Snapshot, SourceInfo, TestCandidate as Candidate, TestQueryRequest as QueryForTest, TestSessionCreate as Session
from app.pipeline import RagService


def history(*turns):
    result = []
    for index, (question, answer) in enumerate(turns):
        result.append(QueryMessage(role="USER", text=question, messageId=str(index)))
        if answer:
            result.append(QueryMessage(role="ASSISTANT", text=answer, messageId=f"{index}:reply"))
    return result


@pytest.fixture
async def service(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data", upload_dir=tmp_path / "uploads", model_cache_dir=tmp_path / "models",
        sqlite_path=tmp_path / "rag.db", qdrant_path=tmp_path / "qdrant",
        embedding_provider="hash", reranker_provider="lexical", generation_provider="deterministic",
        llm_base_url="", llm_api_key="", query_rewrite_enabled=False, deep_agent_enabled=False,
    )
    settings.prepare_directories()
    instance = RagService(settings)
    try:
        yield instance
    finally:
        await instance.close()


@pytest.mark.parametrize("question", ["那需要什么材料？", "需要什么材料？", "要多少钱？", "在哪里办理？", "可以线上办吗？", "港澳居民呢？"])
async def test_followup_reranking_query_contains_previous_subject_without_extra_llm(service, question):
    context = history(("我想入驻海湾创业社区", "可以了解入驻条件和流程。"))
    with service.tracer.start(trace_id="followup", request_id="followup", name="test") as trace:
        variants = await service._rewrite(question, context, trace)
    # The first variant is also the actual cross-encoder query, not merely a cheap candidate pool.
    assert "海湾创业社区" in variants[0]
    assert question in variants[0]


async def test_followup_chain_keeps_subject_and_ignores_legacy_current_question_echo(service):
    context = history(("我想入驻海湾创业社区", "可以申请。"), ("那条件呢？", "需要满足入驻条件。"))
    context.append(QueryMessage(role="USER", text="那需要什么材料？", messageId="current"))
    with service.tracer.start(trace_id="chain", request_id="chain", name="test") as trace:
        variants = await service._rewrite("那需要什么材料？", context, trace)
    assert "海湾创业社区" in variants[0]
    assert variants[0].count("那需要什么材料？") == 1


@pytest.mark.parametrize("question", ["支付宝怎么绑定银行卡？", "另外问一下，支付宝怎么绑定银行卡？", "换个问题，如何注册支付宝？"])
async def test_explicit_new_question_does_not_retrieve_previous_topic(service, question):
    with service.tracer.start(trace_id="switch", request_id="switch", name="test") as trace:
        variants = await service._rewrite(question, history(("我想入驻海湾创业社区", "可以申请。")), trace)
    assert variants[0] == question
    assert all("海湾创业社区" not in value for value in variants)


async def test_followup_uses_latest_topic_after_conversation_switched(service):
    context = history(("我想入驻海湾创业社区", "可以申请。"), ("另外问一下，支付宝怎么绑定银行卡？", "打开银行卡管理。"))
    with service.tracer.start(trace_id="latest-topic", request_id="latest-topic", name="test") as trace:
        variants = await service._rewrite("那需要什么材料？", context, trace)
    assert "支付宝" in variants[0]
    assert "海湾创业社区" not in variants[0]


async def test_answer_to_clarifying_question_preserves_original_request(service):
    context = history(("我想入驻海湾创业社区", "请问您是港澳居民还是内地居民？"))
    with service.tracer.start(trace_id="clarify", request_id="clarify", name="test") as trace:
        variants = await service._rewrite("我是香港居民", context, trace)
    assert "海湾创业社区" in variants[0]
    assert "香港居民" in variants[0]


@pytest.mark.parametrize("reply,question", [
    ("你想了解哪方面的政策？请补充政策名称或涉及的业务，我再帮你查。", "就是社区政策有哪一些"),
    ("你想了解哪个社区的政策？请补充社区名称或所在地，我再帮你查。", "港澳服务社区"),
    ("您想了解哪個社區的政策？請補充社區名稱或所在地，我再幫您查。", "港澳服務社區"),
])
async def test_policy_clarification_keeps_question_when_customer_supplies_subject(service, reply, question):
    context = history(("这个有什么政策？", reply))
    with service.tracer.start(trace_id="policy-clarify", request_id="policy-clarify", name="test") as trace:
        variants = await service._rewrite(question, context, trace)
    assert "这个有什么政策" in variants[0]
    assert question in variants[0]


async def test_confirming_policy_candidate_retrieves_named_policy(service):
    context = history(
        ("这个有什么政策？", "你想了解哪方面的政策？请补充政策名称或涉及的业务，我再帮你查。"),
        ("就是社区政策有哪一些", "你是想了解「七免两低扶持政策」，对吗？"),
    )
    with service.tracer.start(trace_id="policy-confirm", request_id="policy-confirm", name="test") as trace:
        variants = await service._rewrite("是的", context, trace)
    assert "七免两低" in variants[0]
    assert "社区政策" in variants[0]


@pytest.mark.parametrize("question", ["App在哪？", "我说的是这个App去哪里找？", "这个APP怎么下载？"])
async def test_app_followup_extracts_named_app_from_previous_reply(service, question):
    context = history(("就是澳门车怎么申请北上大陆", "可通过“澳车北上”APP或官网线上申办。"))
    with service.tracer.start(trace_id="app-followup", request_id="app-followup", name="test") as trace:
        variants = await service._rewrite(question, context, trace)
    assert "澳车北上" in variants[0]
    assert "APP" in variants[0]
    assert "下载" in variants[0]
    assert "哪里" in variants[0]


async def test_app_followup_after_failed_clarification_keeps_original_subject(service):
    context = history(
        ("就是澳门车怎么申请北上大陆", "可通过“澳车北上”APP或官网线上申办。"),
        ("App在哪？", "为了更准确地帮助您，请再具体说明一下想咨询的业务、对象和问题。"),
    )
    with service.tracer.start(trace_id="app-chain", request_id="app-chain", name="test") as trace:
        variants = await service._rewrite("我说的是这个App去哪里找？", context, trace)
    assert "澳车北上" in variants[0]
    assert "App在哪" not in variants[0]
    assert "下载" in variants[0]


async def test_app_followup_uses_latest_business_and_does_not_copy_urls_from_history(service):
    context = history(
        ("怎么申请澳车北上", "可使用“澳车北上”APP。"),
        ("另外问一下，海湾社区怎么预约", "请使用“社区预约”APP，下载网址是https://unsupported.example/app。"),
    )
    with service.tracer.start(trace_id="app-switch", request_id="app-switch", name="test") as trace:
        variants = await service._rewrite("App在哪？", context, trace)
    assert "社区预约" in variants[0]
    assert "澳车北上" not in variants[0]
    assert "unsupported.example" not in variants[0]


@pytest.mark.parametrize("previous_reply", ["可使用“澳车北上”APP。", "可通过“澳车北上”APP申办。请问您还想了解什么？"])
async def test_named_new_app_question_does_not_reuse_previous_app(service, previous_reply):
    context = history(("怎么申请澳车北上", previous_reply))
    with service.tracer.start(trace_id="different-app", request_id="different-app", name="test") as trace:
        variants = await service._rewrite("支付宝APP在哪下载？", context, trace)
    assert variants[0] == "支付宝APP在哪下载？"
    assert "澳车北上" not in variants[0]


async def test_app_followup_keeps_explicit_new_resource_after_old_clarification(service):
    context = history(
        ("怎么申请澳车北上", "可通过“澳车北上”APP申办。请问您还想了解什么？"),
        ("支付宝APP在哪下载？", "请到官网下载。"),
    )
    with service.tracer.start(trace_id="new-app-followup", request_id="new-app-followup", name="test") as trace:
        variants = await service._rewrite("这个APP怎么找？", context, trace)
    assert "支付宝APP" in variants[0]
    assert "澳车北上" not in variants[0]


@pytest.mark.parametrize("missing_link", ["当前证据中未提供具体的APP下载链接", "目前没有该APP的下载链接", "暂无APP下载链接"])
async def test_app_name_is_not_made_ambiguous_by_download_disclaimer(service, missing_link):
    context = history(
        ("就是澳门车怎么申请北上大陆", "可通过“澳车北上”APP申办。"),
        ("App在哪？", f"“澳车北上”APP支持iOS和Android系统，但{missing_link}。"),
    )
    with service.tracer.start(trace_id="app-disclaimer", request_id="app-disclaimer", name="test") as trace:
        variants = await service._rewrite("我说的是这个App去哪里找？", context, trace)
    assert variants[0] == "澳车北上APP在哪里下载或获取？"


async def test_two_actual_app_names_are_still_ambiguous(service):
    from app.conversation_context import analyze_query

    analysis = analyze_query("App在哪？", history(("怎么办理？", "可使用“海湾办事”APP，也可使用社区预约APP。")))
    assert "海湾办事" not in analysis["keywords"]
    assert "社区预约" not in analysis["keywords"]


async def upload_faq(service, extra_rows=()):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["标准问题", "标准答案", "关键词", "大类", "小类"])
    writer.writerow(["申请入驻海湾创业社区需要什么材料？", "请提交创业项目计划书和团队成员身份证明。", "海湾,创业社区,入驻,材料", "社区", "入驻"])
    writer.writerow(["支付宝绑定银行卡需要什么材料？", "请准备本人银行卡和银行预留手机号。", "支付宝,银行卡,材料", "账户", "银行卡"])
    writer.writerows(extra_rows)
    uploaded = await service.accept_upload(content=output.getvalue().encode(), filename="context.csv", mime_type="text/csv", metadata={}, request_id="context-upload")
    for _ in range(100):
        if service.get_document(uploaded.documentId).status != "PROCESSING":
            break
        await asyncio.sleep(0.02)
    assert service.get_document(uploaded.documentId).status == "READY_FOR_TEST"
    session = service.create_test_session(Session(requestId="context-session", candidateDocuments=[Candidate(documentId=uploaded.documentId, documentVersion=1)]))
    return session.testSessionId, service.db.get_chunks_for_document(uploaded.documentId, 1)


async def test_generation_receives_all_six_turns_and_retrieves_materials_for_the_same_subject(service):
    session_id, chunks = await upload_faq(service)
    expected_chunk = next(item for item in chunks if "社区" in item["metadata"]["question"])
    context = history(
        ("我想入驻海湾创业社区", "可以了解入驻条件和流程。"),
        ("那可以申请吗？", "请参考社区申请条件。"),
        ("那条件呢？", "请了解团队要求。"),
        ("那在哪里办呢？", "请参考办理流程。"),
        ("那能线上办吗？", "请咨询受理窗口。"),
        ("那流程呢？", "请先准备申请资料。"),
    )
    requests = []

    def provider(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return httpx.Response(200, json={"model": "test", "choices": [{"message": {"content": json.dumps({
            "result": "ANSWERED", "answer": "请提交创业项目计划书和团队成员身份证明。", "citation_ids": [expected_chunk["chunk_id"]]
        }, ensure_ascii=False)}}]})

    service.llm.enabled = True
    service.llm.client = httpx.AsyncClient(transport=httpx.MockTransport(provider), base_url="https://provider.example/v1")
    response = await service.run_query(
        question="那需要什么材料？", context=context,
        snapshot=Snapshot(conversationKey="same-chat", conversationVersion=7, inputFingerprint="sha256:context"),
        source=SourceInfo(), knowledge_base_id="main-business-kb", trace_id="six-turns", request_id="six-turns", test_session_id=session_id,
    )
    assert response.result == "ANSWERED", response.model_dump()
    assert response.grounding.sourceReferences[0].chunkId == expected_chunk["chunk_id"]
    assert len(requests) == 1  # No extra remote rewrite needed for ordinary follow-ups.
    prompt = requests[0]["messages"][-1]["content"]
    passed_context = prompt.split("<untrusted-context>")[1].split("</untrusted-context>")[0]
    assert passed_context.strip().splitlines() == [f"{item.role}: {item.text}" for item in context]
    assert "用户问题:\n那需要什么材料？" in prompt


async def test_missing_current_detail_is_not_invented_from_the_previous_answer(service):
    session_id, _ = await upload_faq(service)
    response = await service.run_query(
        question="那需要多少押金？", context=history(("我想入驻海湾创业社区", "押金是999元。")),
        snapshot=Snapshot(conversationKey="same-chat", conversationVersion=2, inputFingerprint="sha256:missing"),
        source=SourceInfo(), knowledge_base_id="main-business-kb", trace_id="missing-detail", request_id="missing-detail", test_session_id=session_id,
    )
    assert response.result == "NO_ANSWER"
    assert response.answer is None


async def test_app_followup_retrieves_named_app_and_returns_query_analysis_for_test_diagnostics(service):
    session_id, chunks = await upload_faq(service, [[
        "海湾办事APP在哪里下载？", "请从海湾社区官网下载海湾办事APP。", "海湾办事,APP,下载,入口", "社区", "APP下载",
    ]])
    expected_chunk = next(item for item in chunks if "APP" in item["metadata"]["question"])
    requests = []

    def provider(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return httpx.Response(200, json={"model": "test", "choices": [{"message": {"content": json.dumps({
            "result": "ANSWERED", "answer": "请从海湾社区官网下载海湾办事APP。", "citation_ids": [expected_chunk["chunk_id"]],
        }, ensure_ascii=False)}}]})

    service.llm.enabled = True
    service.llm.client = httpx.AsyncClient(transport=httpx.MockTransport(provider), base_url="https://provider.example/v1")
    request = QueryForTest(requestId="app-download", question="我说的是这个App去哪里找？", context=history(
        ("海湾社区怎么预约", "请使用“海湾办事”APP预约。"),
        ("App在哪？", "请具体说明要咨询的业务。"),
    ))
    response = await service.test_query(session_id, request)
    assert response.result == "ANSWERED", response.model_dump()
    assert response.grounding.sourceReferences[0].chunkId == expected_chunk["chunk_id"]
    analysis = response.meta["queryAnalysis"]
    assert analysis["keywords"] == ["海湾办事", "APP", "下载", "获取入口"]
    assert "海湾办事" in analysis["resolvedQuestion"]
    assert analysis["contextUsed"] is True
    assert response.grounding.confidence > 0
    assert len(requests) == 1
    prompt = requests[0]["messages"][-1]["content"]
    assert "用户问题:\n我说的是这个App去哪里找？" in prompt
    resolved = prompt.split("<resolved-question>")[1].split("</resolved-question>")[0].strip()
    assert resolved == analysis["resolvedQuestion"]
    assert "海湾办事" in resolved
    assert "下载" in resolved
    replay = await service.test_query(session_id, request)
    assert replay.meta["queryAnalysis"] == analysis
    assert len(requests) == 1
