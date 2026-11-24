# ADR 0004：转人工会话的完整生命周期与人工回复

- 日期：2026-11-23，Asia/Shanghai
- 状态：实施（分支 `feat/reply-handoff-optimization`，基线 `b5144ff`）
- 关联：[ADR 0003](0003-low-confidence-reply-orchestration.md)

## 背景

用户反馈转人工之后“怪怪的”，看到消息也没法手动变成人工回复。排查到的根因：

1. 会话一旦进入 `HANDOFF_PENDING / HUMAN_MANAGED`，代码中没有任何回到 `BOT_ACTIVE` 的路径，会话永久停在人工处理；
2. 发送任务领取守卫在人工会话中取消所有 REPLY 任务，连运营在网页端提交的人工回复也被取消；
3. 网页端“人工回复”仅对微博开放；
4. 运营无法主动接管 AI 正在处理的会话；
5. 用户说“转人工”后收不到任何回应，`HANDOFF_SUBMITTED_REPLY` 等常量未被使用；
6. 回复任务的领取、延期、完成和租约过期全部依赖 `messages.reply_job_id` 的归属，无法在不改变消息状态的前提下发送辅助消息。

## 决定

- **状态机闭环**：`BOT_ACTIVE → HANDOFF_PENDING → HUMAN_MANAGED → BOT_ACTIVE`。
  - 新增运营“接管”：直接进入 `HUMAN_MANAGED`，取消排队中的 AI 回复，不发企微。
  - 新增“交还 AI”：清空转人工字段，关闭活跃的转人工意图，停止仍在重试的转人工通知。
  - 新增闲置自动交还：无新来信、无人工处理超过 `HANDOFF_IDLE_RELEASE_HOURS`（默认 24 小时）后自动交还。
  - 小程序有独立的状态机与回调，不纳入以上操作。
- **人工回复与机器人回复分开**：领取守卫只拦截 `replyMode !== 'MANUAL'` 的任务。人工回复对微博沿用原精确定位校验；其他平台使用与 AI 自动回复相同的 `assessAutoReplyEligibility(creation)`，能安全自动回复的消息才允许系统代发。
- **转人工回执是辅助回复任务**：仍是 `job_type='REPLY'`（agent 适配器不必改），payload 带 `auxiliaryKind='HANDOFF_ACK'`、`conversationId`，不带 `messageId`。由 `conversations.handoff_ack_job_id` 归属，领取、延期、完成都走独立分支，不改变任何消息状态，失败不重试；每次转人工只发一次，交还后清空。不带 `messageId` 是为了避免被 `cancelConversationAutomation` 按消息取消。
- **接待面板**：只读汇总加上“知识库草稿”（正式 RAG，有依据才给草稿，绝不自动发送）和“发送回复”（回复最新一条待处理消息，成功后一并标记同会话更早的待处理消息）。

## 取舍

- 交还 AI 不自动回复已经在待人工列表里的旧消息，避免机器人回答早已过时的问题，代价是运营需要手动标记旧消息。
- 默认 24 小时自动交还会在部署后的第一次扫描时释放历史上长期卡在人工状态的会话。只改状态，不给用户发消息；如需保留，部署时将 `HANDOFF_IDLE_RELEASE_HOURS` 设为 0。
- 回执不重试：重复发“已转人工”比漏发更打扰用户；失败在接待面板显示为“回执未发送成功”。
- 抖音私信适配器只在目标消息仍是最新来信时发送，所以回执与人工回复都可能因为用户继续发消息而发送失败；接待面板的回复总是对准最新的待处理消息。
