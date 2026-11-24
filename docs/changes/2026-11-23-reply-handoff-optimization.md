# 2026-11-23：知识问答低置信度回复与转人工链路优化（P0–P2）

日期：2026-11-23（Asia/Shanghai）
状态：已实现，本地验证通过，待提交；未部署，未在真实平台收发验收。
关联：分支 `feat/reply-handoff-optimization`，基线 `b5144ff`（origin/main）；决策见开发记录 ADR 0003、ADR 0004。

## 背景与目标

用户反馈：

- 知识问答在低置信度时“人机感”太重：统一回复“这个问题建议向人工客服咨询一下”，口语化提问召回不到，无关问题也被推给人工；
- 转人工后的链路“怪怪的”，看到消息也没法手动变成人工回复。

排查确认的问题：

- 无答案的兜底既不通知人工，也不计入引导次数；
- 相关但分数不够的候选被丢弃（候选确认函数没有调用方）；
- 会话转人工后没有回到 AI 的路径；
- 人工会话中，网页提交的人工回复会被发送前守卫取消；
- 网页人工回复只对微博开放；
- 运营不能主动接管；
- 用户转人工后收不到回执；
- 人工会话里每条跟进消息都单独通知企微。

目标：低置信度时贴合用户问题、尽量积极回应；无关问题得体拒答；转人工形成“转入 → 接待 → 交还”的闭环。RAG 的证据门槛与引用规则不变。

## 变更与影响

**低置信度回复（P0，`src/services/reply-composer.js`）**：私信 RAG 无答案时分三档。

- 相关候选：用 1–3 个标题确认方向，用户回“是 / 好的 / 序号”后重新问答。
- 明显无关：友好划定服务范围，不推人工，不计次数。
- 知识缺口：按报名、联系方式、楼层、排期或通用情况积极说明，邀请“转人工”并登记原问题；计入引导次数，从第二次起换一种说法。
- 邀请转人工后，用户回“好的 / 需要”即真正转人工，回“不用了”即婉拒。
- 只认用户实际收到的上一条回复，旧的邀请不会被误触发。

**转人工链路（P1，`server.js`、`conversation-control.js`、`handoff-ack.js`）**

- 新接口：
  - `POST /api/conversations/:id/takeover`：接管，取消排队中的 AI 回复，不发企微；
  - `POST /api/conversations/:id/release`：交还 AI，关闭转人工意图，停止通知重试；
  - 闲置自动交还：`HANDOFF_IDLE_RELEASE_HOURS`，默认 24。
- 发送前守卫只拦机器人回复；人工回复（`replyMode: MANUAL`）在人工会话中可以正常领取和发送。
- 网页人工回复扩展到全平台：微博沿用原精确定位校验，其他平台使用 AI 自动回复同一套目标定位校验。`GET /api/messages` 增加 `conversation_handling_mode` 和 `manual_reply_supported`。
- 转人工回执：用户明确或确认转人工、RAG 超时 / 超长 / 引导达上限转人工时，给私信用户发一条回执。它是独立的辅助回复任务，不改变消息的待人工状态，每次转人工只发一次。`HANDOFF_SERVICE_HOURS` 设置后，非工作时间追加说明；`HANDOFF_ACK_ENABLED=false` 关闭。
- 人工会话的跟进消息在 `HANDOFF_FOLLOWUP_NOTIFY_WINDOW_MINUTES`（默认 10）内合并通知。

**人工接待面板（P2，`public/app.js`、`public/styles.css`）**

- 私信卡片显示会话状态，并提供“接待面板 / 接管会话 / 交还 AI”。
- 面板展示：转人工原因、用户没得到答复的问题、回执状态、闲置交还时间、最近 30 条对话。
- “知识库草稿”（`POST /api/conversations/:id/draft`）：有依据才给草稿，并列出来源；没有依据时只列可能相关的方向。草稿不会自动发送。
- “发送回复”（`POST /api/conversations/:id/reply`）：回复最新一条待处理消息，成功后一并处理同会话更早的待处理消息。
- 面板数据来自 `GET /api/conversations/:id/workspace`。

**口语化（P2，`reply-composer.js`）**

- 候选匹配时，加入 RAG 已返回的改写标准问法与关键词。
- 新增相关档 `RAG_RELATED_MIN_SCORE`（默认 0.25，低于作答门槛 0.38）：落在这一档的候选，即使字面不重合也会用来确认方向。
- 不改 Python RAG 服务。

**业务环境 200 用户模拟测试后的修复（`social-reply.js`、`message-router.js`、`conversation-intent.js`、`reply-composer.js`、`handoff-ack.js`、`decision.js`、`server.js`）**

- 社交性消息不再进知识库：夸视频、道谢收尾（“明白了，谢谢，我自己再找找”）、发错对象（“媽，我晚點返屋企”“撳錯咗”）、问身份 / 能力，直接自然回应。之前这些都会被当成知识缺口，回“答不准，回我转人工”，收尾时甚至触发转人工。消息里只要还有提问信号、不满或退款等词就不拦截。
- 问身份不再被当成转人工：“你是人工客服还是机器人”先去掉身份子句再识别转人工；身份之外明确说“转人工”仍然转。
- 婉拒转人工时顺带的新问题会继续作答（“不用啦～对了，5月10号那节课讲不讲…”），之前只回一句“好的～”就漏掉了。
- 用户本轮或最近几轮说过“不用转人工”后，知识缺口说明不再反复邀请转人工。
- 回复跟随语言：英文用户收到英文的知识缺口说明、拒答、社交回应和转人工回执，并认得英文的 “human / talk to a human”；繁体用户收到繁体，粤语用户的社交回应用粤语。
- 回执改成“已经帮你联系人工同事了，同事接手后会直接在这里回复你”，不再说成已经有人在处理。
- 开票、退款、报销类问题不再被当成价格问题。
- 风险词“恐怖”收窄为恐怖主义 / 恐怖袭击 / 恐怖分子 / 恐袭，“不太敢看恐怖片”不再被当成敏感内容静默转人工。

**数据库**：`conversations` 自动新增 `handoff_ack_job_id`、`handoff_taken_over_by`、`handoff_released_at`、`handoff_release_reason`，沿用现有的 `ensureColumn` 迁移。

未改：RAG 门槛 / Gate / 引用 / 人设；评论渠道话术；小程序状态机（通用接管、交还接口对小程序返回 409）；微信助手话术。

## 决策与取舍

见 ADR 0003（低置信度分档、相关档）与 ADR 0004（会话生命周期、辅助回执、人工回复校验）。要点：

- 候选只用于确认方向，不陈述内容、不作为引用，确认后仍要重新过 Gate；
- 交还 AI 不自动回复旧消息；
- 回执失败不重试；
- 默认 24 小时自动交还，会在部署后首次扫描时释放历史上长期卡在人工状态的会话（只改状态，不发消息）。

P2 原计划中“多视角重排”没有做：它需要改 Python 重排并用固定 84 题集重新评测，而评测集和本地模型不在本仓库。本次改用 Node 侧的相关档加改写问法匹配，把“低分但相关”转成一次方向确认，不改变作答门槛。

## 验证与证据

环境：macOS，Node v25.6.1，`NODE_ENV=test`，隔离临时数据库与模拟 RAG / 模拟 RPA；未调用真实模型或平台。

- 新增测试：
  - `reply-composer.test.js`：10 项；
  - `handoff-ack.test.js`：2 项；
  - `reply-composer-integration.test.js`：7 项，覆盖序号 / 单方向确认、无关拒答、“好的”转人工、通知合并、婉拒、未送达不触发；
  - `handoff-workspace-integration.test.js`：8 项，覆盖回执排队→领取→完成且消息仍待人工、接待面板、知识库草稿、人工会话中的人工回复领取与一并处理、全平台人工回复、接管 / 交还、交还关闭意图、闲置自动交还、小程序拒绝。
- 改写了断言旧行为的测试：`formal-rag-routing.test.js` 3 项、`rag-formal-routing-integration.test.js` 2 项。
- 相关测试文件逐个对比（文件名含 rag/knowledge/handoff/mini-program/conversation/message/reply/notification/intent/guidance，排除 hot-topic，每个限时 120 秒）：基线 `b5144ff` 共 68 个文件，671 项通过、34 项失败；本分支共 72 个文件，698 项通过、34 项失败。失败项与基线逐项一致，新增 27 项全部通过，无超时。
- 基线已有、与本次无关的失败：
  - `server-integration.test.js` 7 项，基线同样 7 项，均调用已下线的旧知识库接口；
  - `rag-guidance-parity` 2 项；
  - `knowledge-conversation-integration` 1 项；
  - `hot-topic-knowledge` 在本机挂起，未纳入。
- 浏览器：用隔离实例（临时数据库，模拟 RAG）在内置浏览器里打开私信页。会话状态标签、“接待面板 / 接管会话 / 交还 AI / 人工回复”按钮，以及面板的原因、原问题、回执、闲置时间、对话、无依据草稿提示、发送后“人工 · 发送中”都正常显示；手机宽度布局正常。
- RAG Python 代码未改，未运行 pytest。未用真实平台验证回执与人工回复的实际送达。

**业务环境模拟测试（2026-11-23～24，本机 3100）**

- 环境：Compose 项目 `ai-operation-local`。Web、RAG 换成本分支镜像（`ai-operation-local-*:reply-handoff-20261123`），旧容器改名保留用于回滚。原 RAG 数据在 iCloud 占位文件上，SQLite 报磁盘 I/O 错误，改用 Docker 卷 `ai-operation-local_rag_data`，并通过知识文件接口导入仓库内“周周有课”正文包（23 篇）。统一对话模型在测试期间指向本机中转站 `gpt-6.2-sol`。
- 安全边界：RPA 为模拟模式，未配置企微，未向真实平台或企微发送任何消息。测试期间关闭 Local Agent 自动启动，由测试脚本代替执行端领取并完成回复任务。
- 方法：200 位模拟用户（21 种场景 × 12 种语言风格，覆盖抖音、B站、视频号、微博），由模型扮演，经 `/api/agent/messages/upsert` 发进系统，共 539 轮。另一个模型逐轮评审机器人回复。其中 10 位转人工用户由模拟运营在接待面板回复，最后交还 AI。
- 首轮结果：整体 3.18/5，差评 23%。问题集中在社交性消息、问身份、婉拒时的新问题、繁英语言和风险词误判，均已修复（见“变更与影响”）。
- 复测：同一批 101 位用户（同 id、同场景、同风格），复测场景评分 2.90→4.03，差评占比 37%→10%。其中：
  - 误发 1.00→4.33，问身份 1.67→3.83，问候 / 夸奖 2.00→3.80；
  - 婉拒转人工 2.63→4.00，知识库能直接回答 3.81→5.00；
  - 英文 1.83→2.50。
- 最后补的无关问题与请求识别（“想请您推荐一部电影”）只有单测，没有在业务环境重跑。
- 模拟测试修复后的最终回归：
  - 范围：相关测试文件逐个运行，文件名含 rag/knowledge/handoff/mini-program/conversation/message/reply/notification/intent/guidance/social/core/router/decision，排除 hot-topic；
  - 基线：HEAD `b5144ff` 共 69 个文件，864 项通过、45 项失败；
  - 本分支：74 个文件，903 项通过、45 项失败；
  - 失败项与 HEAD 逐项一致；新增 5 个测试文件 39 项全部通过（含 `social-reply.test.js` 8 项）。
- 耗时：每轮中位 58 秒、P90 127 秒、最长 182 秒。默认 `RAG_TIMEOUT_MS=90000` 下较慢的问题会变成“AI 回复超时”转人工；测试期间临时设为 180000，测完已恢复默认。
- 测试结束：总开关关闭、平台停止、5 个平台账号停用、AI 回到 mock 并清除保存的 Key，Local Agent 自动启动与超时恢复默认。测试期间产生的消息、会话、任务、通知、转人工意图、AI 调用日志已删除，各表行数与测试前备份一致。导入的 23 篇知识文件保留在 RAG 卷中。

## 部署与回退

- 无手工迁移，启动时自动加列。
- 新增可选环境变量：`HANDOFF_ACK_ENABLED`、`HANDOFF_SERVICE_HOURS`、`HANDOFF_SERVICE_TIME_ZONE`、`HANDOFF_IDLE_RELEASE_HOURS`、`HANDOFF_IDLE_SCAN_INTERVAL_MS`、`HANDOFF_FOLLOWUP_NOTIFY_WINDOW_MINUTES`、`RAG_RELATED_MIN_SCORE`。
- 只需重启 Web。静态资源版本号已更新：`app.js` 为 `20261123-handoff-workspace`；`styles.css` 为 `20261102-platform-base-theme-20261111-handoff-20261123`，保留 `20261102-platform-base` 前缀，`core.test.js` 依赖它。
- 回退：还原本提交。新增的列与决策值对旧代码无影响；旧代码会让已交还的会话保持 `BOT_ACTIVE`。

## 未完成与下一步

- 在真实平台上验证：抖音、B站、视频号的人工回复与回执实际送达（适配器与 AI 回复同一路径，但没有实测）。
- 部署前确认是否保留默认 24 小时自动交还，以及是否设置 `HANDOFF_SERVICE_HOURS`。
- 有了评测集与本地模型后，再评估 Python 侧多视角重排；目前的相关档阈值 0.25 是经验值，需要用真实日志校准。
- 评论渠道的回执、拒答话术仍沿用原规则，没有改。
- 模拟测试暴露、尚未处理：
  - 多轮追问丢上下文，回出泛化的“是哪个活动、课程或业务”，需要把对话上下文带进 RAG 查询改写；
  - 英文问题检索不到中文资料，RAG 也用中文作答，需要先翻译再检索，并按提问语言作答；
  - 每轮耗时偏长，需决定超时设置，或减少 RAG 内的模型调用次数。

## 上下文与关联

- 代码：`src/services/reply-composer.js`、`src/services/handoff-ack.js`、`src/services/conversation-control.js`（`takeOverConversation`、`releaseConversationToBot`、`releaseIdleHandoffConversations`）、`src/services/formal-rag-routing.js`（`knowledgeGapResult`）、`src/server.js`（`queueHandoffAck`、`createManualReplyJob`、`conversationWorkspace`、`conversationReplyDraft`、领取守卫中的 `isHandoffAckPayload`）、`public/app.js`（`openHandoffWorkspace`）。
- 操作说明：[前端操作入口](../frontend-workspace.md)、[知识库文件管理](../knowledge-files.md)。
