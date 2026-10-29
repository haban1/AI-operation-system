# 天河港澳社区 AI 数字员工运营平台 MVP

> 安装版管理后台：http://127.0.0.1:3100；账号：admin；初始密码：admin123。

GitHub 源码仓库：[AI-operation-system](https://github.com/haban1/AI-operation-system)。当前源码快照包含天河、RAG、8080 微信机器人，以及朋友圈定时发布和 AI 内容计划，详见 [GitHub 源码仓库说明](docs/GitHub源码仓库说明.md)。运行数据、真实配置和模型文件需在本机准备。

现有 28 个视频以真实文件、清单和固定字节审批证明随仓库交付，新机器默认初始化到公共素材库，无需开发者本机路径或原数据库。本机的 16 张图片不随此交付包分发。新部署步骤、精确摘要验收与审批边界见 [随仓库部署现有成片](docs/DEPLOY_BUNDLED_MEDIA.md)。

Windows 本机部署完整内容工作台：先看 [Windows 本机部署](docs/Windows本机部署.md)，准备 Node.js 24+ 和 Docker Desktop 的 WSL2 / Linux containers 后，运行 `start-workbench.cmd`，检查用 `check-workbench.cmd`，关闭用 `stop-workbench.cmd`。这组入口包含主系统、RAG 与仓库自带的 Signal 引擎，不依赖开发者电脑上的其他源码。配置、持久化和验收细节见 [AI Signal Studio 部署](docs/Signal-Studio部署.md)。OpenChatCut 与 Toonflow 仍是可选外部服务。

自动热点与混剪的输出自动同步到公共素材库，新作品默认“待确认”，在发布时明确确认后再沿用预检与审核。随仓库交付的既有成片按固定字节审批证明恢复已确认状态，未来输出不继承该审批。支持目录自动发现和浏览器“接收产物”上传；Windows 或跨机交接无需提供容器文件路径。操作与可选目录配置见 [产物确认入库](docs/产物确认入库.md)。

此前的 Codeup 仓库：[zhihuiqudong-AI](https://codeup.aliyun.com/68a53af7a72fbe627240d5b0/zhihuiqudong-AI)，首次上传记录见 [Codeup 源码仓库说明](docs/Codeup源码仓库说明.md)。

在线模型统一在天河「企微及 AI → AI 服务配置」维护，供主程序、Local Agent、知识库生成和微信客服使用。容器升级与机器人接入步骤见 [统一模型配置](docs/统一模型配置.md)。

只开发基础 Web / RAG 时可参考 [容器开发启动说明](docs/容器开发启动说明.md)；其单独的 `compose.yaml` 不包含 Signal，且使用另一套开发数据。完整内容工作台使用上述 `*-workbench.cmd` 或 `node scripts/workbench.mjs start`，不要混用入口。

微信客服已统一到 8080 原生机器人：人工接待、好友群发、知识库问答均在机器人内运行，天河工作空间嵌入同一后台，模型配置继续统一使用天河。独立 8000 和 PostgreSQL 已停用。开发启动、知识迁移及回退见 [微信原生客服说明](docs/微信原生客服迁移-20261019.md)。

朋友圈支持单次定时发布，以及按主题和知识库生成内容的单次／每天／每周计划，可选审核后发布或自动发布，支持暂停、恢复和取消，见 [朋友圈发布计划说明](docs/朋友圈定时发布与AI内容计划-20261020.md)。

2026-09-10 最终版目录：`G:\CODE\天河AI最终版`。最新平台回复、账号识别、视频知识、三轮引导及 App 追问修复已统一到本地 `main`；Web、Local Agent 和 RAG 均使用此主仓库的源码，RAG 实际从 `rag-service/` 启动。迁移前已成功刷新两个仓库的远程分支，未发现主分支遗漏的提交。目录关系、启动入口、备份与验证记录见 [最终版迁移说明](docs/最终版迁移说明-20260910.md)。运行数据、模型、登录状态和密钥保留在本机，不随 Git 提交。

本工程用于验证“Web 统一管理 + 五个平台独立 Platform Agent + 本地 RPA 执行”的运营闭环。当前正式接入小红书、抖音、视频号、B站和微博；五个平台均可由 Web 独立启停，并共享统一的任务、知识、审核、监控和人工确认机制。

> 当前是**可运行 MVP/技术验证版**。五个平台已接入任务编排、账号/Profile/设备映射、辅助浏览器适配和每日 Smoke Test。所有平台默认安全关闭；只有“全局运行开关、账号启用、平台开启、登录状态和 Smoke Gate”同时满足时才允许执行。真实平台页面仍需在人工监护下持续校准 DOM 和成功判定，不能表述为已经正式投产。

## 1. MVP 已实现范围

### 云端 Web 与服务

- 运行总览、五平台内容发布与任务中心；
- 五平台评论、私信采集任务和处理记录；
- 待补充知识审核、知识库管理；
- 千问回复组织（默认模拟模式，可配置百炼）；
- 风险转人工、问题汇总；
- 平台运营账号、独立浏览器 Profile、RPA 电脑固定映射；
- Local Agent 心跳、任务领取、状态和证据回传；
- 分平台采集接口、人工回复检测和保守的异常处理。

### Windows Local Agent

- 本机地址：`http://127.0.0.1:17831`；
- Windows 原生素材文件选择器；
- 素材存在性、类型、大小和分平台格式预检；
- 主动连接云端、领取任务和回传结果；
- 五个平台均使用独立适配器和独立 Chrome Profile，默认执行白名单包含小红书、抖音、视频号、B站和微博；
- 五平台登录状态检查和人工登录入口；只有处于 `RUNNING` 的平台参与批量打开和批量检查；
- 草稿准备、发布、采集、回复、复核及截图/JSON 证据接口；
- 结果不明确时返回 `NEEDS_CONFIRMATION`，不盲目重发。

### 业务闭环

1. 用户在 RPA 电脑选择本地素材；
2. Local Agent 按目标平台分别预检；
3. 云端 API 强制校验预检结果，缺失、阻断或平台不匹配时拒绝创建任务；
4. 云端绑定平台运营账号、浏览器 Profile 和 RPA 电脑并下发任务；
5. Local Agent 使用对应平台的独立 Profile 准备草稿并执行辅助发布；
6. 只有检测到可靠成功信号才回传成功，结果不明确则停止并转人工确认；
7. 评论或私信先做风险判断，再检索知识并调用千问组织语言；
8. 高可信且安全的回复进入自动发送任务；
9. 知识不足进入“待补充知识”，风险内容只通知人工；
10. 千问、知识、登录、RPA、发布和发送异常统一进入“问题汇总”。

## 2. 关键边界

- 当前正式平台：小红书、抖音、视频号、B站、微博。
- 小红书已升级为正式第五平台，但新安装默认账号停用、平台 `STOPPED`，不会自动唤醒浏览器或领取任务。
- 不包含平台限流检测、预测、规避、解除或恢复功能。
- 素材原文件始终保留在 RPA 电脑本地，云端只保存路径、元数据、预检结果、任务状态和必要证据。
- 用户只核对或选择预配置的平台运营账号，不填写账号密码和验证码。
- 首次登录、扫码、验证码、人脸验证、二次验证、风控确认及登录恢复由工作人员在对应 RPA 电脑人工完成。
- Web、云端服务和 Local Agent 不保存、自动填写、传输或绕过平台密码、验证码、扫码及人脸数据。
- 每个平台使用独立持久化 Chrome Profile，避免账号会话混用。
- 发布或发送结果不明确时必须返回 `NEEDS_CONFIRMATION`，禁止自动重试造成重复发布或重复回复。
- 人工回复仍可在五个平台的官方 App 内完成，本项目不建设手机端。
- 自动化测试固定使用 `RPA_MODE=simulated`；真实辅助联调必须逐平台显式启用账号和平台，并先通过该平台只读 Smoke Test。
- 五个平台均尚未完成完整真实运营账号生产验收，不应视为生产可用。B站当前按视频投稿接入，微博当前按图文/视频发布入口接入。

### 小程序文字对话接入（服务端渠道）

小程序通过独立签名接口提交文字消息，并通过固定服务端回调接收 AI 回复；它不进入五平台浏览器/RPA 流程。所有 appId、共享密钥、回调地址和功能开关只通过环境变量配置，管理页面只用于查看状态和发起转人工，不提供人工回复入口。公网代理只能映射合同指定的单个开放 POST 路径，不能暴露管理后台或 RAG 服务。

- [接入设计方案](docs/superpowers/specs/2026-09-05-mini-program-conversation-channel-design.md)
- [实施计划](docs/superpowers/plans/2026-09-05-mini-program-conversation-channel.md)
- [小程序文字对话接口 V1.0（合作方联调合同）](docs/小程序文字对话接口-V1.0-20260905.md)

### 新浏览器控制体系（默认关闭）

项目已正式接入 `web-access 2.5.3`，形成“云端结构化命令服务 + Windows Local Agent BrowserController + web-access CDP / Playwright 双 Provider”的浏览器控制体系。

- 云端不直连本机 Chrome，只下发设备、平台、账号和 session 绑定的白名单动作；
- CDP Proxy 只监听 `127.0.0.1`，生产运行使用 `agent/browser-control/vendor/web-access`，不依赖开发 Skill 目录；
- 默认 `BROWSER_CONTROL_ENABLED=false`、`BROWSER_CONTROL_INTERACTIVE_ENABLED=false`；
- 禁止云端下发任意 JavaScript、Cookie、密码、验证码或浏览器存储读取请求；
- 发布、回复、删除、支付、审核等高风险操作必须继续走原有业务流程；
- 只读命令中断后可安全重排，交互式命令结果不确定时进入 `NEEDS_CONFIRMATION`；
- web-access 模式复用人工授权的浏览器实例，不能自动证明该实例对应哪个磁盘 Profile；要求操作人员核对当前登录账号。需要强 Profile 隔离时显式选择 Playwright Provider。

配置、启用、API、风控与回退说明见 [云端浏览器控制体系](docs/browser-control-system.md)。

### 内容素材建议规格

系统按平台做素材类型、扩展名、大小和基础图片尺寸预检，但当前不会自动裁切或转码。制作侧可先统一准备以下常用母版，再在发布前人工检查平台预览：

- 竖屏视频：`1080×1920`、`9:16`，适用于小红书、抖音、视频号和微博；
- 横屏视频：`1920×1080`、`16:9`，适用于B站、微博和横屏视频号；
- 图文图片：`1080×1440`、`3:4`，适用于小红书和微博；
- B站适配器当前只接受 `.mp4`、`.mov` 视频投稿；
- 微博适配器当前接受 `.jpg`、`.jpeg`、`.png`、`.webp` 图片及 `.mp4`、`.mov` 视频。

视频分辨率、画幅比例、时长、编码、码率和帧率尚未完整自动解析，系统会给出警告并要求人工确认。平台规则可能调整，正式运营前仍应以真实账号发布页提示和预览效果为准。

## 3. 每日五平台 Smoke Test 与平台门禁

- 调度范围覆盖小红书、抖音、视频号、B站和微博；只有已启用账号且平台处于 `RUNNING` 时才执行该平台只读检查。
- 每次检查只读采集 URL、页面标题、关键文本、控件、selector、结构摘要和截图，并与最近一次人工确认基线自动比较。
- 未发现变化时自动继续任务流；发现变化时只暂停对应平台，其他平台继续运行。
- 管理端提供“确认无实质变化，继续运行”和“确认页面已变化，联系技术人员”两个结论按钮。
- 确认无实质变化后，当前快照成为新基线并清除门禁；确认页面变化后，平台进入 `PAUSED_TECH`。
- 技术修复后发起复测：与已有基线一致时自动恢复；首次没有基线但已经人工确认页面变化时，成功复测会建立技术基线并自动恢复。

## 4. 稳定性与安全保护

- 当前登录模型为单管理员账号，不区分角色权限。
- 管理端使用 HttpOnly、SameSite=Strict Cookie；注销后旧令牌立即撤销。
- Local Agent 使用独立 Bearer Token，并通过 `/api/agent/*` 专用接口同步账号登录状态。
- Server 与 Local Agent 均使用单实例锁；SQLite 配置 busy timeout 和有限重试。
- 服务重启后，发布/回复任务不会自动重发，而是进入 `NEEDS_CONFIRMATION`；只读安全任务才允许重新排队。
- 自动化测试必须使用模拟 RPA 和 Mock 千问，禁止真实发布与回复。

## 5. 技术结构

```text
浏览器 Web
   │ HTTP API
   ▼
云端服务（MVP：Node.js + SQLite）
   ▲                         │
   │ 心跳 / 轮询 / 结果回传   │ 知识检索 / 千问 / 风险判断
   │                         ▼
Windows Local Agent ──> RPA Adapter Registry
                          ├─ xiaohongshu
                          ├─ douyin
                          ├─ wechat_channels
                          ├─ bilibili
                          └─ weibo
```

主要技术与依赖：

- Web 服务：Node.js `node:http`；
- 数据库：Node.js `node:sqlite`；
- 前端：Vanilla HTML/CSS/JavaScript；
- 浏览器自动化：`playwright-core`，连接本机 Google Chrome；
- 设计文档读取工具：`mammoth`；
- 千问：默认知识约束模拟模式，可切换阿里云百炼 OpenAI 兼容接口。

RPA 注册模式：

- `simulated`：使用模拟适配器，严禁真实发布或回复，适合自动化测试；
- `xiaohongshu_assisted`：历史兼容模式，仅注册小红书辅助适配器；新部署建议使用 `five_platform_assisted`；
- `five_platform_assisted`：注册五个平台适配器；默认 `AGENT_PLATFORM_ALLOWLIST=xiaohongshu,douyin,wechat_channels,bilibili,weibo`，五个平台均可被 Web 独立启停。平台处于 STOPPED 时不会领取任务、检查登录或启动浏览器。

## 6. 启动与停止

环境要求：Windows、Node.js 24 或更高版本、Google Chrome。

推荐使用以下命令，避免本机 PowerShell 执行策略阻止脚本：

```powershell
cd "D:\code\Codex项目交接包-2026-07-31\06_MVP\ai-digital-employee-mvp"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-mvp.ps1
```

启动后访问：`http://127.0.0.1:3100`

停止：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\stop-mvp.ps1
```

不使用脚本时，可在两个终端分别启动：

```powershell
node src/server.js
node agent/local-agent.js
```

## 7. 五平台人工登录

1. 复制 `.env.example` 为 `.env`；自动化测试必须保持 `RPA_MODE=simulated`、`QWEN_MODE=mock`、`LOCAL_AGENT_AUTO_START=false`；
2. 启动 Web 和 Local Agent；
3. 打开 Web 的“账号与设备”页面；
4. 对需要启用的平台先点击“启用账号（不唤醒）”，再显式点击“开启平台”；
5. 在弹出的对应独立 Chrome Profile 中人工完成扫码、密码、验证码、人脸或风控验证；
6. 回到 Web 点击“检查登录”，确认状态；
7. 小红书评论通知另使用“小红书主站通知页”入口检查主站登录；
8. 首次使用任一平台时，先进行单账号、单素材、小范围人工监护联调，不直接批量发布或批量回复。

页面加载只检查已有状态，不会主动打开登录窗口。只有点击某个平台的“打开登录”后，Local Agent 才会轮询该平台；未打开的平台不轮询、不创建 Profile、不拉起浏览器。停止单个平台会停止该平台轮询并按 Profile 清理对应浏览器及子进程；关闭 Web 管理平台会停止 Local Agent、全部轮询和全部受控平台浏览器。系统不会索取、保存或绕过任何平台凭据和验证。

## 8. 千问配置

默认演示配置：

```text
QWEN_MODE=mock
RPA_MODE=five_platform_assisted
```

接入阿里云百炼：

```text
QWEN_MODE=online
QWEN_API_KEY=你的百炼API Key
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.7-plus
```

不要把 API Key 发到聊天、日志或截图中。填写后可先做独立连通性测试：

```powershell
npm.cmd run test:qwen
```

系统只把命中的知识片段和当前问题发送给千问；模型返回后仍需通过风险规则、知识匹配阈值和输出安全校验，才允许自动回复。

## 9. 知识库批量导入（含 Excel）

知识库批量导入支持 `.csv`、`.tsv`、`.txt`、`.md`、`.docx` 和 `.xlsx`。Excel 导入规则如下：

1. 系统只读取 XLSX 的**第一张工作表**；
2. 第一行必须是字段表头，推荐固定为：`标准问题`、`标准答案`、`关键词`、`大类`、`小类`；
3. 也兼容“问题/答案/关键字/一级分类/二级分类”以及英文 `question/answer/tags/category/subcategory` 等别名；
4. 单个文件最大 8MB，单次最多 1000 条；
5. 上传后必须先查看预览清洗结果，重点核对空格和字段前缀清理、关键词补全/去重、小类推断、完全重复、相似问题、截断和错误项；
6. 提交导入后知识默认进入 `DRAFT / PENDING_REVIEW`，必须人工审核并发布后才可用于自动回复；
7. 公共知识可供五个平台调用；平台专属知识必须使用对应的“小红书知识库/抖音知识库/视频号知识库/B站知识库/微博知识库”大类，系统会执行检索隔离。

交接包的 `04_知识库与导入测试` 中包含当前知识库完整导出、五平台总测试表以及五个平台单独测试 Excel，可直接用于验证数据清洗功能。


## 10. 演示与联调方法

### 内容发布

1. 进入“内容发布”；
2. 填写标题和正文；
3. 选择本地素材；
4. 勾选目标平台并核对运营账号；
5. 执行本地分平台预检；
6. 预检通过后创建任务；
7. 到“任务中心”查看分平台结果和证据；
8. 若状态为 `NEEDS_CONFIRMATION`，应人工核对平台页面，不能直接重发。

使用 `simulated` 模式时：

- 普通文件名：`SUCCESS`；
- 文件名包含 `fail`：`FAILED`；
- 文件名包含 `confirm`：`NEEDS_CONFIRMATION`。

示例素材位于 `sample-material/`。

### 评论和私信

进入“评论与私信”，选择目标平台账号后可手动触发采集或注入测试消息：

- `社区服务中心几点上班？`：命中知识并自动回复；
- `社区有没有粤语课程？`：进入待补充知识并通知人工；
- `我要投诉，请转人工处理`：风险转人工，不进入知识库。

## 11. 测试与重置

运行单元和服务端集成测试：

```powershell
npm.cmd test
```

启动 Web 和 Local Agent 后执行端到端联调：

```powershell
node scripts/integration-live.mjs
```

重置演示数据库前必须先停止 Web 和 Agent：

```powershell
node src/reset-db.js
```

## 12. 后续实账号联调

1. 由工作人员分别登录五个平台真实运营账号并确认账号权限；
2. 对每个平台逐项校准发布页、管理页、评论页和私信页 DOM；
3. 验证单条发布、发布状态复核、评论采集、私信采集和回复成功信号；
4. 对验证码、风控、页面改版和网络中断验证 `NEEDS_CONFIRMATION` 边界；
5. 完成小范围人工监护试运行后，再评估生产验收；
6. 当前已具备管理员 Cookie、Agent Bearer Token、单实例锁和 SQLite busy retry；正式部署仍需补充 HTTPS、密钥轮换、集中审计、异机备份和外部监控。



