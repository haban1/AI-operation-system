# 修复 RAG contract regression 工作流

## 背景与目标

`main` 快进到 `aa0ca3b` 后，`.github/workflows/rag-contract.yml`（RAG contract regression）两个作业都失败：`python-contract` 有 9 个测试模块收集失败（如 `ImportError: cannot import name 'DebugQueryRequest' from 'app.models'`），`operations-contract` 有 23 项 Node 失败。`b5144ff` 及更早的提交上失败完全相同，所以这是长期遗留问题，不是 `aa0ca3b` 引入的。目标：两个作业按工作流命令在本地通过，其他相关测试不新增失败，并且不靠放宽断言变绿。

## 变更与影响

逐项判断是测试过时还是代码回归：

- **代码回归（已修复）**：`rag-service/app/pipeline.py`。2026-11-11 源码同步（`cad2fcd`）删掉小智负例拦截时，把通用的证据门诊断也一起删了：`retryAllowed` 字段、最后一轮的 `decision="reject"`、`evidenceSet`。结果第二轮证据仍不足时诊断写着 `decision="retry"`，实际却不会再重试。现在恢复这三项，小智负例拦截仍然不加回来。回答结果和证据门槛不变，只影响诊断字段。对应失败是 `test_evidence_workflow.py::test_second_round_still_insufficient_rejects_without_generation`。
- **测试过时（2026-11-10/11 知识库改为文件自动生效）**：`app/models.py` 中的 `DebugQueryRequest`、`TestCandidate`、`TestSessionCreate`、`ReleaseCreate` 等，以及测试会话、手动发布、回退、debug 检索、小智负例，都是有意删除的（见[文件管理记录](2026-11-10-knowledge-files.md)、[知识库说明](../knowledge-files.md)），所以要改的是测试，不是把模型加回去：
  - 新增 `rag-service/tests/kb_helpers.py`，用 `publish_file` 走文件管理器上传并等待自动生效。`test_core`、`test_published_retrieval`、`test_channel_evidence`、`test_comment_query_rewrite`、`test_conversation_context`、`test_query_rewrite_flow`、`test_reply_length`、`test_reply_sections` 改用这个 helper，原有检索、门槛、改写、长度、分段断言不变。
  - 删除的功能（release/rollback、`delete_document`、debug 检索、测试答案的启停与历史、小智负例）对应的用例删掉，改写为当前合同：多知识库的生效快照互相隔离；旧小智禁用记录不再拦截正式答复；未生效的已解析文件不能被检索；comment 查询使用同一改写计划，并且仍然丢弃评论历史。
  - `test_contract_boundaries.py` 只保留脱敏用例，其余按上面的当前合同重写。
- **测试过时（小智 / 发布 UI 已下线；ADR 0003 改变了低置信度回复）**：
  - `test/rag-release-rollback.test.js` 删除。这个浏览器用例测的是已下线的发布版本卡片和回退按钮；`test/knowledge-files.test.js` 已断言旧路由返回 404，并覆盖文件 CRUD 和旧书签跳回文件列表，工作流改为运行它和 `test/knowledge-conversation-api.test.js`。`package.json` 的 `npm test` 同步去掉已删文件。
  - `test/knowledge-files.test.js` 的 Chrome 查找原来只认 Windows 路径，改为优先读 `CHROME_EXECUTABLE_PATH`，与项目其他浏览器测试一致，这样 CI 的 Linux Chrome 会真正运行这两个 UI 用例。
  - `test/rag-admin-proxy.test.js` 原来测已下线的文档、发布、回退、小智接口，现在改为覆盖仍在代理的管理面：RAG 状态，以及素材知识草稿经 `/rag-admin-api/v1/files` 入库（multipart、服务端固定知识范围、不外泄客户端元数据、重复确认幂等、失败可重试）。
  - `test/reply-routing-parity.test.js` 原来以小智会话为参照，现在改为本地问答测试 `/api/rag/test-query` 与五个平台共用外层路由（问候、明确转人工、缺对象澄清、RAG 离线），平台间话术、引导计数和人工接管状态一致。按 ADR 0003 修正一处：已明确对象的证据缺口现在计入引导次数。自定义转人工说法与 RAG 创建测试会话失败两个子测试对应的功能已下线，已删除。
  - `test/rag-guidance-parity.test.js` 改为五个平台按 ADR 0003 断言：缺对象先澄清、不访问 RAG；相关候选用标题确认方向，不陈述内容；用户否认后不再提同一候选，计入引导但不通知人工；回“是的”后用候选方向重新走完整 RAG。原来的小智评论邀约子测试已删除，平台评论链路由 `test/comment-handoff-*.test.js` 覆盖。
  - `test/mini-program-reply-dispatch.test.js` 的知识缺口话术改为 ADR 0003 的说法（如实说明答不准，邀请「转人工」），并且计入引导次数。仍断言：不陈述事实、不追问方向、不自动转人工或通知、保持 `BOT_ACTIVE`、不登记待确认人工意图。
- 工作流：作业运行列表同上更新，步骤名把“publication”改为“file knowledge”；触发路径补上 `reply-routing-parity`、`conversation-*`、两份 knowledge 测试和 `reply-composer.js` / `knowledge-conversation.js`。

## 决策与取舍

- 没有在 `app/models.py` 里恢复旧模型。恢复只能让 import 通过，对应的服务方法和接口已删除，测试仍会失败；而且这会和“旧接口不再存在”的当前合同冲突。
- 对已下线的功能，只删除测试已下线行为的断言。原用例里仍有效的检查都保留，并按当前合同补上替代断言（作用范围隔离、旧审核数据不起作用、平台间一致、确认后重新查询），没有只为变绿而放宽断言。
- 小智评论邀约测试没有迁移成平台集成测试，因为 `comment-handoff-*` 已有 67 项通过的覆盖。
- `rag-answer-profile-ui.test.js` 的 Chrome 查找同样只认 Windows 路径，4 项在本地和 CI 都会跳过。这不是本次要修的失败，留作后续。

## 验证与证据

环境：macOS，Node v25.6.1（CI 为 Node 24），`NODE_ENV=test`，隔离临时数据库与模拟 RAG，本机 Chrome（`CHROME_EXECUTABLE_PATH`）。没有调用真实模型或平台。

- `python-contract`：在 `rag-service/` 运行 `uv sync --frozen --extra dev` 和 `.venv/bin/python -m pytest -q --disable-warnings`。Python 3.13 下 303 项通过；另用 `uv sync --frozen --extra dev --python 3.12` 建的环境（与 CI 同版本）同样 303 项通过、退出码 0。3.12 解释器退出时会打印一行 libc++ `recursive_mutex` 信息，出现在测试汇总之后，不影响退出码。修复前同一命令是 9 个模块收集错误；跳过这 9 个模块时另有 1 项失败，即上面的证据门回归。
- `operations-contract`：按工作流的完整 `node scripts/run-tests.mjs --test --test-concurrency=1 …` 命令运行，共 122 项：118 通过，0 失败，4 跳过（见上条）。修复前 23 项失败。
- 相关测试对比：文件名含 rag/knowledge/handoff/mini-program/conversation/message/reply/guidance/social/router/intent/notification、排除 hot-topic 的 72 个 Node 测试文件，在本分支和 `HEAD` 原样副本上分别逐个运行（每个限时 150 秒）。基线 73 个文件 736 通过 / 41 失败，本分支 72 个文件 757 通过 / 18 失败。本分支剩下的 18 项失败按测试名都是基线已有的失败，都不在工作流中，没有新增失败。明细见 dev-notes 记录。
- CI 尚未运行；推送 PR 后以 GitHub Actions 结果为准。

## 部署与回退

只改测试、测试 helper、工作流、`npm test` 列表和 pipeline 的诊断字段，不涉及部署或数据迁移。回退方式：还原本提交。还原后工作流会回到失败状态，`evidenceGate.decision` 也会回到最后一轮仍写 `retry` 的错误诊断。

## 未完成与下一步

- 等 PR 上的 RAG contract regression 结果。
- 后续：让 `rag-answer-profile-ui.test.js` 也读取 `CHROME_EXECUTABLE_PATH`，使 4 个跳过的 UI 用例在 CI 中运行。
- 相关对比中，基线上已有的失败（如 `server-integration`、`knowledge-conversation-integration` 调用已下线的旧接口）不在本次范围内，仍未处理。

## 上下文与关联

- 开发记录：[dev-notes/changes/20261124-rag-contract-ci-repair.md](../../dev-notes/changes/20261124-rag-contract-ci-repair.md)
- 合同依据：[知识库说明](../knowledge-files.md)、[文件管理记录](2026-11-10-knowledge-files.md)、[本地问答测试](2026-11-10-knowledge-playground.md)、[低置信度回复](2026-11-23-reply-handoff-optimization.md)、[ADR 0003](../../dev-notes/decisions/0003-low-confidence-reply-orchestration.md)
- 基线：`main` `aa0ca3b`；分支 `claude/adoring-saha-c387ac`
