# 知识问答低置信度回复与转人工链路优化（P0–P2）

- 时间：2026-11-23～24，Asia/Shanghai（24 日为业务环境模拟测试与修复）。
- 分支：`feat/reply-handoff-optimization`；基线：`b5144ff`（本地 main 已快进到 origin/main）。
- 公开记录：[docs/changes/2026-11-23-reply-handoff-optimization.md](../../docs/changes/2026-11-23-reply-handoff-optimization.md)；决策：[ADR 0003](../decisions/0003-low-confidence-reply-orchestration.md)、[ADR 0004](../decisions/0004-handoff-conversation-lifecycle.md)。

## 背景与理由

用户反馈低置信度回复死板、口语化召回不到、无关问题推给人工；转人工链路“怪怪的”，看到消息也不能手动人工回复。
根因与取舍见两份 ADR。其中最隐蔽的一条：发送前的领取守卫在人工会话中会取消所有 REPLY 任务，
连网页提交的人工回复也被取消。所以即使微博开放了人工回复，在已转人工的会话里实际也发不出去。

## 入口

- 回复编排：`src/services/reply-composer.js`（`composeNoAnswerReply`、`relatedTopics` 的相关档与改写问法、`resolveClarificationSelection`）。
- 路由：`src/services/formal-rag-routing.js`（`knowledgeGapResult`）。
- 会话控制：`src/services/conversation-control.js`（接管、交还、闲置交还）；回执话术：`src/services/handoff-ack.js`。
- 服务端：`src/server.js`。
  - 处理流程：`latestVisibleReplyContext`、`confirmedClarification` / `privateOfferConfirmation`、`queueHandoffAck`、`recentHumanFollowupNotification`。
  - 人工回复：`createManualReplyJob`、完成时的 `coversEarlierPending`。
  - 任务链路：领取 / 延期 / 完成中的 `isHandoffAckPayload` 分支。
  - 接口与面板：`/api/conversations/:id/{takeover,release,workspace,draft,reply}`，`conversationWorkspace` / `conversationReplyDraft`。
- 前端：`public/app.js`（`conversationActions`、`openHandoffWorkspace`），`public/styles.css` 末尾的接待面板样式。
- 模拟测试后的修复：
  - `src/services/social-reply.js`（`detectSocialMessage`、`socialReplyText`、`withoutIdentityClauses`、`detectReplyLanguage`），由 `message-router.js` 在风险检测之后调用；
  - `conversation-intent.js` 的嵌入式转人工识别先去掉身份子句，并认得英文；
  - `reply-composer.js` 的 `questionAfterHandoffDecline`、`handoffDeclined` 选项、英文话术、开票不算价格；
  - `server.js` 的 `replyScriptFor`、`handoffRecentlyDeclined`，以及婉拒分支的 `questionAfterDecline`；
  - `decision.js` 收窄“恐怖”。
- 测试工具（不入库，`.codex-work/business-sim-20261123/`）：`deploy.py`（镜像替换与回滚）、`setup.mjs`、`kb-upload.mjs`、`sim.mjs`（模拟用户 / 代理 / 评审）、`report.mjs`。

## 实际验证

- 新增测试 27 项全部通过；改写的旧行为测试 5 项通过。
- 相关测试文件逐个对比（文件名含 rag/knowledge/handoff/mini-program/conversation/message/reply/notification/intent/guidance，排除 hot-topic，每个限时 120 秒）：基线 68 个文件 671 通过 / 34 失败；分支 72 个文件 698 通过 / 34 失败，失败项逐项一致，主要是 reply-routing-parity 18、message-auto-refresh 4 等既有问题。
- `server-integration.test.js` 在基线和分支都是 17 通过 / 7 失败，失败项一致（旧知识库接口已下线）。
- 浏览器：隔离实例（`$TMPDIR/handoff-preview-*` 临时数据库，模拟 RAG 端口 18911，Web 端口 18910）。私信卡片、接待面板（桌面与 375 宽）、无依据草稿提示、面板内发送回复均实际操作确认；预览结束后已停止，临时 `.claude/launch.json` 已删除。
- 编辑时 Python 脚本会把混合换行的文件统一成 LF，已按基线逐行还原；`git diff --stat` 只含真实改动。

- 业务环境模拟测试：
  - 本机 3100，本分支镜像，200 位模拟用户、539 轮，首轮 3.18/5；
  - 修复后同一批 101 位用户复测，2.90→4.03，差评占比 37%→10%；
  - 详见 `docs/changes/2026-11-23-reply-handoff-optimization.md`，测试工具与原始记录在不入库的 `.codex-work/business-sim-20261123/`；
  - 测试后已恢复开关与设置，并删除测试期间产生的业务数据。
- 最终回归：HEAD 69 个文件 864 通过 / 45 失败；分支 74 个文件 903 通过 / 45 失败，失败项逐项一致。HEAD 与分支同时跑时，会因资源争用多出 2 项假失败，单独重跑即通过。
- 部署隔离：产物验证通过。在本分支 Web 镜像 `ai-operation-local-web:reply-handoff-20261123` 中检查，`/app/dev-notes`、`/app/docs/changes`、`/app/.codex-work` 均不存在，也没有包含本记录名的 Markdown 文件。
- 测试中遇到的环境问题：
  - 原 RAG 数据目录是 iCloud 占位文件，SQLite 报 disk I/O error，已改用 Docker 卷；
  - 测试中 Docker Desktop 崩溃一次，重启后恢复；
  - 中转站曾返回 502，导致 26 位用户整段失败，已单独重跑。

## 遗留与下一步

- 多轮追问丢上下文、英文检索不到、每轮耗时长：见 docs 变更记录的“未完成与下一步”。
- 最后补的无关问题与请求识别（“想请您推荐一部电影”）只有单测，没有在业务环境重跑。

- 未在真实平台验证回执和人工回复的送达；抖音私信只在目标仍是最新来信时发送。
- 默认 24 小时闲置自动交还，会在部署首次扫描时释放历史上长期卡在人工状态的会话；部署前需与用户确认。
- Python 侧多视角重排未做（缺评测集与本地模型）；相关档 0.25 需要用真实日志校准。
