# 2026-11-11：按设计预览落地运营总览、评论收件箱与发布预览

日期：2026-11-11（Asia/Shanghai）

状态：已修改，本地联调通过；未提交、未推送、未部署。基线 `f553320`（main，日间/夜间主题提交）。

## 背景与目标

上一轮只把预览的颜色和光效做进代码，页面结构没有改，用户反馈“和预览完全不一样”。本轮按用户确认的设计预览（日间晨雾 / 夜间夜幕）实现三个页面的布局，并接入原有接口：运营总览、评论、发布内容。要求按原后端，尽量不改业务逻辑。

## 变更与影响

全部改动在前端展示层，沿用仓库已有的做法：`app.js` 负责取数、渲染和绑定事件，`workspace-presentation.js` / `workspace-interactions.js` 在渲染后重新组织布局。

- **运营总览**（`workspace-presentation.js` 的 `dashboard`）
  - 问候语 + “今天有 N 件事等你处理”；三张行动卡：待人工回复（`stats.manualRequired` → 评论）、运行问题（`stats.openIssues` → 问题记录）、排队中的发布（`stats.queuedTasks` → 发布任务）。
  - AI 数字员工：粒子球（`ai-orb.js`）+ 五个平台的官方图标、账号名和状态（来自 `bootstrap.accounts` 的启用、平台启停与登录状态），以及采集服务是否在线（`bootstrap.localAgent.online`）。
  - 四个指标卡：已发布（`/api/operations-dashboard` 的 `published`，附近 7 天每日发布走势）、AI 已回复、待人工处理、今日 AI 调用。
  - 发布分布（`channels`）与最近发布（`content`），带平台图标。
  - 原“平台运营数据”面板保持显示；推广趋势、渠道效果、内容效果、活动转化、AI 运营建议收进“更多分析”，设备与登录、运行详情仍在折叠区。
  - `app.js` 只改一行：调用展示层时多传 `accounts` 与 `localAgent`。
- **评论**（`workspace-interactions.js` 的 `presentCommentInbox`）
  - 三栏：左侧状态筛选（待处理 / AI 已回复 / 人工已处理 / 全部，计数来自 `/api/messages`）；中间保留原“按帖子分组”的列表（展开、未读计数、已读记录逻辑不变），评论显示为紧凑行；右侧为所选评论详情：关联帖子、用户原文、回复状态、AI 回复内容与匹配度、需人工的原因、处理详情。
  - 详情区按钮是原卡片按钮的转发（人工回复、检测 App 人工回复、人工已处理、重新判断、删除、打开原消息），点击时调用原按钮，接口与确认流程不变。代理按钮不带 `.mark-handled` 等动作类名，避免被 `app.js` 重复绑定。
- **发布内容**（`workspace-presentation.js` 的 `enhancePublishPreview`）
  - 保留原三步流程、校验、预检、审核与提交；右侧新增手机预览，实时显示标题、正文、所选素材，并可在所选平台间切换。
  - 平台卡片加官方图标；底部操作条改为贴底毛玻璃。
- **公共**：新增 `platform-icons.js`（抖音、B站、微博、小红书使用 Simple Icons 的 CC0 图形；视频号暂用微信图形代替）、`ai-orb.js`、`workspace-v2.css`；`theme.css` / `theme.js` 把新卡片纳入光效，切换主题时通知粒子球重画；`index.html` 与模块导入更新缓存版本号。

### 第二轮：按钮、弹窗与提示（同日追加）

用户要求用前端设计 skill 继续调优按钮、弹出框和流程。

- **原生弹框全部替换**：`app.js` 中 7 处 `prompt()`、4 处 `confirm()` 改为页内弹窗 `uiDialog` / `uiPrompt` / `uiConfirm`（标题、说明、多行输入、字数计数、Esc 取消、⌘/Ctrl+Enter 确认）。取消时仍返回 `null` / `false`，后续接口调用与原来一致。涉及：评论“人工已处理”“人工回复（微博）”“检测 App 人工回复”，问题记录“人工已处理”“误判”，系统设置“清除企微 Webhook”“清除 AI Key”。
- **误判流程合并**：原来最多连弹 4 个原生框（说明 → 平台是否已发布/发送 → 链接 → 内容 ID），改为一个弹窗 `falsePositiveDialog`：说明 + 两个选项的实际结果，选“已发布成功”才显示可选的链接和 ID。提交给 `/api/issues/:id/false-positive` 的字段不变。
- **按钮层级**：主按钮渐变（覆盖 `styles.css` 中强制纯色的旧 `!important` 规则）、次按钮描边、危险操作在页面上为浅红描边、只在确认弹窗里为实心红；评论详情中“人工回复”（或“人工已处理”）为主按钮并排第一，“删除”为右侧浅红文字按钮。
- **弹窗外观**：实底、柔和遮罩、出现时轻微放大；删除确认的须知改为中性列表（不再整块红底），确认按钮为实心红。
- **提示条**：底部居中胶囊，成功带绿色对勾，失败为红底感叹号。
- **平台图标**：导出弹窗、发布任务平台标签、平台账号卡片改用官方图标；平台账号卡片原来按卡片顺序（`nth-child`）写死的“小/抖/视/B/微”改为按平台代码匹配。导出弹窗去掉每个平台重复的“导出该平台全部已完成回复”。
- **评论页**：收件箱已有分类计数，隐藏重复的“消息流”统计行。

### 第三轮：状态文案与其余页面（同日追加）

- **平台账号**：卡片上的“登录状态：UNKNOWN / DISABLED / READY”改为“待检查 / 已停用 / 已登录”，其他状态沿用 `app.js` 已有的状态名称表。
- **私信**：卡片操作按钮与评论详情一致（`rankCardActions`）：“人工回复”或“人工已处理”为主按钮并排第一，“删除”为右侧浅红文字按钮；只改外观类名，保留事件绑定用的类名。会话列表、详情区外观与评论收件箱统一。
- **知识库**：回答风格读取失败、文件列表读取失败时，说明“知识库服务没有响应”、原因和下一步（确认 RAG 服务已启动后重新加载），保留原错误信息与“重新加载”按钮（`#answerProfileRetry`）。
- 新增通用状态提示样式 `.v2-state`；更新相关模块缓存版本号。

## 决策与取舍

- 不重写 `app.js` 渲染函数，而是在展示层移动原节点、补充新组件：原有事件绑定、轮询、权限与安全判断全部保留，测试依赖的结构（如 `details.comment-post-group`、`.operations-analytics-account`）不变。
- 评论详情使用“转发点击”而不是复制处理逻辑，避免两套逻辑不一致。
- 指标只显示接口已有的真实数据；曝光、引流等仍待接入的数据不做假值，原面板中的“待接入”说明保留在“更多分析”里。
- 设计预览中的“AI 建议回复改写（更亲切/更简短）”和“发送回复”快捷键依赖后端暂无的接口，本轮未做。

## 验证与证据

- 本机以模拟模式启动测试服务（端口 3190、独立临时数据库），写入 6 条示例发布与 6 条示例评论/私信（仅测试库）。
- 浏览器检查日间、夜间三个页面；评论详情中“人工已处理”实际调用 `/api/messages/:id/handled`，筛选计数随之更新；发布页手机预览随输入与平台勾选更新。
- 测试对比结果见本记录末尾“测试对比”。

## 部署与回退

未部署。回退：恢复 `workspace-presentation.js`、`workspace-interactions.js`、`app.js` 一行调用参数与 `index.html` 版本号，删除 `platform-icons.js`、`ai-orb.js`、`workspace-v2.css`。不涉及数据和接口。

## 未完成与下一步

- 私信、小程序对话、转人工记录、知识库、平台账号、系统设置等页面只有主题与光效，未按预览重排。
- 视频号官方图标待替换；AI 回复改写与快捷键需后端接口支持。
- 内容创作页与嵌入的微信客服、创作工作台仍为原深色样式。
- 在 Windows RPA 电脑上实测性能。

## 上下文与关联

- 主题与颜色变量：[日间 / 夜间主题记录](2026-11-11-day-night-theme.md)
- 前端入口说明：[前端操作与功能入口](../frontend-workspace.md)

## 测试对比

macOS、Node.js 25.6、本机 Chrome。对以下 14 个测试文件在改动前（`git stash -- public`）与改动后各运行一次：`comment-post-list-ui`、`platform-analytics-ui`、`publish-flow-ui`、`publish-layout-sync`、`workspace-presentation-ui`、`navigation-performance-ui`、`mini-program-ui`、`mini-program-connection-ui`、`core`、`ai-settings-and-polling`、`creation-navigation-ui`、`browser-status-ui`、`ai-model-settings-ui`、`runtime-gates`。

两次结果相同：287 项，通过 239，失败 12，其余跳过；失败项名单一致，均为改动前已有的失败，本轮无新增失败。评论分组、未读计数、平台运营数据、发布三步流程与布局同步等界面测试全部通过。

第二轮（按钮、弹窗、提示）后，在上述列表中再加入使用确认弹窗的 `knowledge-files`，同样改动前后各跑一次：290 项，通过 240，失败 12，名单一致，无新增失败。浏览器中实际点击验证：页内“人工已处理”弹窗提交后调用原接口并出现成功提示，删除确认弹窗、导出弹窗、平台账号图标在日间和夜间显示正常。

**更正**：上面两次对比中的大多数浏览器界面测试在 macOS 上实际被跳过了——它们只查找 Windows 的 Chrome 路径（`C:/Program Files/...`），找不到就 `skip`。因此前文“评论分组、未读计数……界面测试全部通过”不成立，以下为补测结果。

补测方法：把 14 个界面测试文件临时复制为 `test/zz-tmp-*.test.js`，将 Windows Chrome 路径替换为本机 Chrome，并设置 `CHROME_EXECUTABLE_PATH`；改动前（`git stash -- public`）与改动后各跑一次，跑完删除临时文件。文件：`comment-post-list-ui`、`publish-flow-ui`、`workspace-presentation-ui`、`navigation-performance-ui`、`mini-program-connection-ui`、`creation-navigation-ui`、`browser-status-ui`、`ai-model-settings-ui`、`workspace-shell-ui`、`platform-analytics-ui`、`mini-program-ui`、`publish-layout-sync`、`rag-answer-profile-ui`、`knowledge-files`。

结果：改动前后均为 79 项，通过 74，失败 5，跳过 0，失败名单一致，无新增失败。通过项包括评论按帖子排序/默认收起/键盘展开清除未读、刷新后已读保持、发布三步流程与审核门禁、发布排期、发布页离开后的晚到响应、工作区展示层保留未保存设置、回答风格读取失败后“重新加载”、知识文件增删改查（含删除确认弹窗）。5 项旧失败：`workspace controls and navigation remain readable`（1440/390，等待已移除的 `aliases` 栏目）、`disabled knowledge handles failed speculative reads`、`handoff rules remain available independently of knowledge service`、`knowledge lists overlap status`。

建议把这些测试的浏览器路径改为读取 `CHROME_EXECUTABLE_PATH` 并补充 macOS 路径，否则在 Mac 上会静默跳过。本轮未修改测试文件。

`public/app.js` 原为 CRLF 与 LF 混合换行，编辑后已按原换行逐行还原，`git diff` 只包含实际改动的行。
