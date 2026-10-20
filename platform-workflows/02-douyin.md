# 02 抖音平台闭环

## 范围与边界

本流程仅实现 `DouyinAssistedRpaAdapter` 的抖音发布、评论与私信闭环。知识库和决策任务负责生成 `replyText`；适配器只负责安全定位、填写、发送和回显验证，不自行生成回复内容。本任务不修改公共基类、服务端、数据库、注册表或其他平台。

## 已校准页面与控件

- 发布：`https://creator.douyin.com/creator-micro/content/upload`；可靠成功证据为跳转内容管理页或可见“发布成功”信号。
- 评论：`https://creator.douyin.com/creator-micro/data/following/comment`。
  - 行：`li[class*="cmt-li-"]`
  - 用户：`h4[class*="cmt-name-"]`
  - 正文：`pre[class*="cmt-text-"]`
  - 时间：`p[class*="cmt-time-"]`
  - 编辑器：placeholder 为“有爱评论，说点儿好听的～”的 textarea
  - 发送：编辑器局部 `button[class*="cmt-btn-"]`
- 私信：`https://www.douyin.com/user/self`。
  - 会话：`[data-e2e="conversation-item"]`
  - 标题：`.conversationConversationItemtitle`
  - 预览：`pre.ConversationItemHinttextBox`
  - 未读：`[class*="ConversationItemUnReadCount"]`
  - 陌生人入口：`[class*="conversationStrangerBoxwrapper"]`
  - 会话标题：`.RightPanelHeadertitle`
  - 输入框：`[class*="messageEditorinputArea"][contenteditable="true"]`
  - 正文：`.TextMessageTextpureText`
  - 发送：编辑器所在局部区域的 `.e2e-send-msg-btn`；不使用上传按钮或全页文本按钮。

校准依据为仓库现有 2026-08-06 至 2026-08-07 的抖音日志、DOM 检查 JSON 和截图；本任务没有启动真实浏览器。

## 发布状态机

1. `execute`、`publish`、最终发表点击前均检查平台运行开关。
2. 素材存在且登录页就绪后，仅准备草稿。
3. 只有 `publishMode === "AUTO"` 且 `managementConfirmed === true` 才允许进入最终发表。
4. 最终点击后，仅可靠平台成功信号可返回 `SUCCESS/SUBMITTED`。
5. 最终点击后无信号、验证阻断、二次确认歧义或校验异常，统一返回 `NEEDS_CONFIRMATION`、`submissionStatus: UNKNOWN`、`doNotRetry: true`，防止重复发布。

## 评论闭环

1. 采集前校验评论管理页；“暂无评论”只有在无 loading、无可见评论行时才可保守判空。
2. “点击刷新”最多有限次数；刷新点击和恢复 reload 前重新检查运行开关。
3. 回复目标必须以昵称、正文、时间或指纹形成唯一精确命中；零条和多条均停止。
4. 点击回复入口后再次核对目标身份。
5. 只在唯一可见评论编辑器内查找发送控件；发送点击前再次检查运行开关。
6. 只有目标评论线程中出现新增的精确回复文本才成功；点击后不确定不得自动重试。

## 私信闭环

1. 分别采集主收件箱和经唯一入口验证后的陌生人收件箱，合并时去重。
2. 列表预览必须有可靠未读证据；`previewOnly` 且未读数大于 1 时，在访问页面前直接阻断，避免把最后一条预览误当成全部未读内容。
3. 自动回复要求会话昵称与源预览精确匹配、会话 Header 精确匹配、源正文真实存在于会话中。
4. 只在输入框局部祖先区域使用 `.e2e-send-msg-btn`，明确排除上传控件。
5. 发送点击前再次检查运行开关；只有编辑器清空且目标会话新增己方精确气泡才成功。
6. 发送点击后发生回显异常或无法确认时返回 `NEEDS_CONFIRMATION` 和 `doNotRetry: true`。

## 停止语义

- 入口层：`execute`、`publish`、`verifyPublish`、`collectMessages`、`replyToMessage` 均先检查运行开关。
- 浏览器层：公共 `ensureContext` 在创建 Profile/浏览器前后已有运行态检查。
- 副作用层：最终发表、评论发送、私信发送、评论刷新、评论恢复 reload、陌生人入口点击前再次检查。
- 如果关闭发生在非幂等发送之后，适配器不声称失败，也不盲目重试，而是要求人工确认。

## 独立测试

`test/platform-douyin-flow.test.js` 使用 Node 内置测试和纯 mock 页面，不启动 Playwright 或真实浏览器。覆盖停止态不访问浏览器、发布授权与可靠回执、发布点击后不确定语义、评论精确身份与局部发送、私信多未读预览阻断、私信局部发送及点击后异常保护。

## 现场验收

现场调试编号为 **02**，由主任务统一排队。仍需在真实账号上人工确认：平台 DOM class 是否变化、风控/手机绑定弹窗、陌生人消息分页或懒加载、评论时间格式与采集任务保持一致、发布成功 Toast 与管理页跳转在慢网络下的时序。
