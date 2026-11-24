# 修复 RAG contract regression 工作流

- 时间：2026-11-24，Australia/Sydney。
- 分支：`claude/adoring-saha-c387ac`；基线：`main` `aa0ca3b`。
- 公开记录：[docs/changes/2026-11-24-rag-contract-ci-repair.md](../../docs/changes/2026-11-24-rag-contract-ci-repair.md)。

## 背景与理由

`rag-contract.yml` 在 `aa0ca3b`、`b5144ff`（run 45129449571）及更早的提交上失败项完全相同：pytest 有 9 个收集错误，Node 有 23 项失败。根因是 2026-11-10/11 知识库改为“文件自动生效”时删掉了测试会话、发布、回退、debug 检索、小智和自定义转人工说法，但工作流跑的测试没有一起迁移；2026-11-23 的 ADR 0003 又改了低置信度话术和计数，依赖小智的平台对比测试也没能随之更新。另外 `cad2fcd` 删除小智负例时，顺带删掉了通用的证据门 `retryAllowed` / `reject` 诊断，这是唯一的代码回归。

## 入口

- 代码修复：`rag-service/app/pipeline.py` 的 `run_query` 证据门循环（`retry_allowed`、`decision`、`evidenceSet`）。
- Python 测试 helper：`rag-service/tests/kb_helpers.py`（`publish_file`、`settle`、`active_members`）。
- 改写的 Python 测试：`test_core`、`test_published_retrieval`、`test_contract_boundaries`、`test_channel_evidence`、`test_comment_query_rewrite`、`test_conversation_context`、`test_query_rewrite_flow`、`test_reply_length`、`test_reply_sections`。
- 改写的 Node 测试：`test/reply-routing-parity.test.js`、`test/rag-guidance-parity.test.js`、`test/rag-admin-proxy.test.js`、`test/mini-program-reply-dispatch.test.js`；`test/knowledge-files.test.js` 只改了 Chrome 查找；删除 `test/rag-release-rollback.test.js`。
- 工作流：`.github/workflows/rag-contract.yml`；`package.json` 的 `test` 列表去掉已删文件（保留 CRLF）。

## 实际验证

- `rag-service`：`.venv/bin/python -m pytest -q --disable-warnings`。Python 3.13 下 303 通过；用 `--python 3.12` 另建的环境同样 303 通过。
- 工作流 Node 命令（本机 Chrome）：122 项，118 通过，0 失败，4 跳过（`rag-answer-profile-ui` 只认 Windows Chrome 路径）。
- 相关文件对比（72 个文件，逐个运行，限时 150 秒，本分支对比 `git archive HEAD` 副本）：结果见下方“相关对比结果”。

## 相关对比结果

- 基线 `HEAD`（`aa0ca3b`）：73 个文件，736 通过 / 41 失败。本分支：72 个文件（删除了 rollback 测试），757 通过 / 18 失败。
- 本分支的 18 项失败按测试名逐项都在基线失败列表中，没有新增失败。它们属于 `ai-reply-timeout`、`knowledge-alias`、`knowledge-confirmation-chain`、`knowledge-conversation-integration`、`knowledge-metadata-suggestion`、`login-expiry-notification`、`manual-handoff-phrases`、`message-auto-refresh`、`mini-program-ui`、`smart-reply-control`，都不在工作流里，也不在本次范围内。
- 基线有、本分支不再失败的：`reply-routing-parity` 18 项、`rag-guidance-parity` 2 项、`rag-admin-proxy` 1 项、`mini-program-reply-dispatch` 1 项、`rag-release-rollback` 1 项（已删除）。`knowledge-files` 从 1 项通过变成 3 项通过，因为 UI 用例不再被跳过。
- 注意：两边是并发运行的。`mini-program-ui` 有几项在两边都超时失败，耗时差异来自负载，不代表行为变化。

## 隔离与边界

未改构建、打包或部署配置（Dockerfile、ignore、安装器清单都没动），沿用既有的开发资料隔离证据。本次没有部署，也没有在真实平台收发消息。

## 遗留问题

- `rag-answer-profile-ui.test.js` 的 Chrome 查找同样需要读取 `CHROME_EXECUTABLE_PATH`。
- 基线上已有、与本次无关的失败仍在（详见对比结果），多数调用已下线的旧知识库接口。

## 下一步

PR 合并前确认 GitHub Actions 的 RAG contract regression 两个作业都通过。仓库中的行尾混用 CRLF/LF，编辑 `package.json`、`pipeline.py` 和 CRLF 测试文件时要保留原行尾，否则 diff 会被整文件放大。
