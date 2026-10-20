# Enterprise Document Customer Service

面向企业微信、个人微信和网页咨询的课程智能客服。管理员上传 PDF、Word 等知识文档后，系统自动提取正文、切分片段并建立检索索引。用户提问时，模型结合角色提示词、历史聊天与当前问题，按需调用文档检索工具，根据原文归纳回答并注明文件名和位置。

日常寒暄由模型自然回复，角色通过 `ASSISTANT_ROLE_PROMPT` 设置。知识库不再维护课程、意图或问答条目；原有条目数据保留在数据库中，但不参与默认问答，旧管理接口不再挂载。

## Repository Layout

本仓库已将两部分源码合并到同一个 Git 根目录：

- `app/`、`frontend/`：FastAPI 智能客服、管理后台和个人微信接入逻辑。
- `wechat-robot-client/`：个人微信机器人客户端源码及其独立部署文件。

微信机器人源码基于 `hp0912/wechat-robot-client` 的提交
`af32cb90bf1b7ca10b26124c0d2692a17aed89f7`，并保留了本机尚未提交的本地部署调整。

两个项目仍保持各自的依赖和 Dockerfile，不需要混合 Python 与 Go 的构建环境。原来的
`D:\wechat-robot-client` 目录仅作为本机备份和当前机器人运行目录；上传 Git、换电脑或重新
克隆时，以本仓库中的 `wechat-robot-client/` 为源码即可。真实 `.env`、数据库、Redis 数据、
机器人登录数据、证书和内部 `.git` 均不会提交。

换电脑部署前，分别从根目录 `.env.example` 和
`wechat-robot-client/.deploy/local/.env.example` 复制出各自的 `.env`，再填写新电脑的
数据库、模型、管理员登录和机器人连接配置。

用户问答呈现效果：

- [企业微信智能客服用户问答呈现效果](docs/企业微信智能客服产品最终形态与实施方案.md)
- [个人微信 AI 客服部署与操作说明](docs/个人微信AI客服部署与操作说明.md)

## Features

- 上传 PDF、Word（.docx）、UTF-8 TXT 和 Markdown，自动解析、切分和索引
- 文档列表与原文预览分栏展示，支持启停、重新解析、删除和检索测试
- BM25 关键词与 Embedding 语义检索融合；向量服务不可用时降级关键词检索
- 模型原生工具调用、多轮补查、查询改写约束、调用预算和错误恢复
- 文档回答带来源引用；校验异常时展示检索原文，不生成未经确认的业务结论
- 网页流式问答、JWT 登录和最近多轮会话记录
- 企业微信、微信客服与个人微信机器人接入，人工接待期间暂停自动回复
- 个人微信首次欢迎语、好友同步和管理员群发工作台

## Document Knowledge

1. 管理员登录后进入“文档知识库”，选择资料并点击“上传并解析”。支持一次选择多个文件。
2. 等待每份文档显示“可检索”，通过“查看原文”检查解析结果。
3. 在“检索测试”输入实际用户问题，确认命中的文件和原文片段。
4. 用户在客服对话中提问，模型按需检索这些文档，并在回答中附上来源。

默认单文件最大 20 MB，PDF 最多 500 页；解析文本最多 200 万字符、2500 个片段。上传请求会等待解析和索引完成，大文件耗时较长。扫描 PDF 需先 OCR 为可复制文字的 PDF；旧版 `.doc` 请另存为 `.docx`。当前仅检索正文和 Word 表格，不识别内嵌图片。

资料更新时上传新版本，检查原文后停用旧版本，避免同时检索冲突内容。“重新解析”会用原文件重新生成片段及向量，适合解析器或向量配置更新后使用。删除会同时删除原文件与索引；需要临时下线时使用“停用”。历史 FAQ 不会自动转换为文档，请上传实际业务资料。

原文件、片段和向量保存在业务数据库中，备份 PostgreSQL 即可保留知识库。无需额外部署向量数据库。文档配置为 `DOCUMENT_MAX_UPLOAD_MB`、`DOCUMENT_EMBEDDING_ENABLED`、`DOCUMENT_RETRIEVAL_TOP_K` 和 `DOCUMENT_EMBEDDING_MIN_SIMILARITY`；向量服务复用 `DASHSCOPE_EMBEDDING_*` 配置。更换向量模型或维度后，请重新解析文档。

## Local Run

```powershell
conda env create -f environment.yml
conda activate customer-service-agent
python -m pytest
python -m uvicorn app.main:app --reload
```

前端：

```powershell
cd frontend
npm install
npm run dev
```

- API：`http://127.0.0.1:8000`
- Swagger：`http://127.0.0.1:8000/docs`
- Web：`http://127.0.0.1:5173`

默认账号：

```text
管理员：admin / admin123
用户：student / student123
```

## Docker

填写 `.env` 后运行：

```powershell
docker compose up --build
```

默认部署只启动 API 和 PostgreSQL，不再启动 Celery、Milvus、MinIO 或 etcd。

## WeCom Human Handoff

模型结合当前消息与历史确认用户要求人工接待时，返回 `HANDOFF`，微信客服链路发送“好的，我会为你转接人工客服。”并执行转接。否定转接、仅询问转接能力、引用别人的话不会因关键词直接触发；上一轮询问是否转人工后回复“好的”可由模型结合上下文判断：

- `WECOM_KF_HANDOFF_SERVICER_USERID` 留空：会话进入待接入池，由任一在线接待人员接入。
- 填写企业微信成员 `userid`：流水线会确保该成员已加入客服账号，并将会话直接转给该成员。
- 会话处于待接入、人工接待或已结束状态时，机器人不再回复客户消息。

示例：

```text
WECOM_KF_HANDOFF_SERVICER_USERID=zhangsan
```

## Core Flow

1. 管理员上传知识文档，系统解析正文、切分片段并建立关键词和语义索引，仅就绪且启用的文档参与检索。
2. 渠道检查人工接管状态；其余消息连同角色提示词、历史聊天交给模型。
3. 模型通过 Chat Completions 原生 function calling 选择直接回复、`search_knowledge(query)` 或 `request_human_handoff()`。
4. `search_knowledge` 仅接收结合历史补全的独立问题；课程列表、价格、时间等问题统一查询文档，不再经过课程与意图注册表。复合问题可以分别查询。
5. 后端校验工具名称、参数和改写约束，执行检索，将带片段 ID、文件名、位置和正文的结果以 `role=tool` 返回模型。原文属于资料，不能作为指令执行。
6. 模型可继续补查，也可根据原文归纳回答。系统校验来源标注及数字、链接，转换为可读的来源编号和文件位置。生成失败或校验未通过时回退检索原文。此校验不等于对所有语义结论的自动证明，重要业务资料需保持准确、完整。
7. 未命中时说明无法从资料确认并追问；`request_human_handoff()` 返回“好的，我会为你转接人工客服。”并由渠道处理人工接管。

两个工具定义位于 `app/llm/tools.py`。`request_human_handoff` 的参数是空对象 `{}`；知识查询参数示例：

```json
{"query": "Python零基础课程多少钱，报名截止到什么时候"}
```

默认最多 3 轮、8 次工具调用（`LLM_MAX_TOOL_ROUNDS`、`LLM_MAX_TOOL_CALLS`），每批受 `LLM_MAX_QUESTIONS` 限制。达到预算后使用 `tool_choice=none` 收尾；重复查询复用结果，工具错误允许在预算内修正，执行错误最多重试一次。首次模型请求失败时使用用户原问题检索文档降级；后续失败保留已检索结果。模型服务需支持原生工具调用。

后续模型超时由 `LLM_TOOL_FOLLOWUP_TIMEOUT_SECONDS` 控制，首次请求使用 `LLM_TIMEOUT_SECONDS`。最终仅保存用户消息与最终回复；`tool_rounds`、`tool_call_count`、`tool_stop_reason`、`tool_trace` 供调试调用链。

主要接口（知识库管理和检索测试均需管理员 JWT）：

```text
POST   /auth/login
GET    /knowledge/documents
POST   /knowledge/documents                multipart/form-data，字段 file
GET    /knowledge/documents/{id}          解析后的原文片段
PATCH  /knowledge/documents/{id}          {"is_active": false}
DELETE /knowledge/documents/{id}
POST   /knowledge/documents/{id}/reindex
GET    /knowledge/documents/{id}/download
POST   /knowledge/search                 {"query": "用户问题"}
POST   /chat
POST   /chat/stream
GET    /chat/sessions/{session_id}
GET    /wecom/callback
POST   /wecom/callback
GET    /wecom/kf/callback
POST   /wecom/kf/callback
POST   /wechat-robot/callback
POST   /wechat-robot/mass-send
GET    /health
```

## Personal WeChat Robot

仓库中的 `wechat-robot-client/` 作为独立服务部署，与 FastAPI 保持各自的依赖和容器。
将客户端的 Webhook URL 配置为：

```text
http://<FastAPI地址>:8000/wechat-robot/callback
```

客户端会自动附加 `robot_wxid` 查询参数。若设置了
`WECHAT_ROBOT_WEBHOOK_SECRET`，同时在客户端的 `webhook_headers` 中加入：

```json
{"X-Webhook-Token": "与 WECHAT_ROBOT_WEBHOOK_SECRET 相同的值"}
```

私聊默认自动回复，并在首次会话前发送一次欢迎语。群聊默认仅在机器人被 `@` 时回复；
可用 `WECHAT_ROBOT_GROUP_REPLY_MODE=off|mention|all` 调整。群成员入群欢迎由
`wechat-robot-client` 自带的群欢迎设置负责。需要自动接受好友申请时，还应在客户端
“系统设置”中开启自动通过好友验证；好友确认事件或对方首次发送消息时，本项目会发送
一次欢迎语。

文档问答通过文字回复呈现结论与来源文件、位置；不会自动发送文档中的图片。管理员群发的图片功能保持可用。

当问答结果为 `HANDOFF` 时，个人微信机器人会发送
`WECHAT_ROBOT_HANDOFF_MESSAGE`，并只暂停该客户会话的自动回复。客服通过电脑微信主动
向某位好友发送文字、图片、语音、视频、表情或文件时，该好友也会自动进入人工接待；机器人
自动回复、欢迎语和群发消息不会误触发。管理员可在“微信好友群发”区域同步好友，并从中选择
一位人工接管通知人；用户首次请求转人工时，机器人会私聊通知该客服登录机器人微信处理。
管理员也可在队列中查看转人工原因和最近消息，使用电脑微信完成人工回复后点击“恢复机器人”。未手动
恢复的会话默认在 24 小时后自动恢复，可通过
`WECHAT_ROBOT_HANDOFF_AUTO_RESUME_HOURS` 调整，设置为 `0` 可关闭自动恢复。

管理员登录 FastAPI 管理后台后，可在“微信好友群发”中发送纯文字、纯图片或文字加图片。后台会先同步
机器人通讯录，只列出状态正常的 `friend` 类型联系人并默认全选；管理员可取消不需要接收的好友，
系统仅向提交时仍勾选的好友逐个发送文字和图片，同时展示成功和失败数量。
通讯录同步会读取全部分页，成功后将已不在通讯录中的好友标记为失效，保留历史记录和设置；
重新添加后可通过完整同步恢复。离线、分页异常或详情拉取失败会报错，不会根据残缺列表清理好友。
这部分逻辑位于 `wechat-robot-client/`，更新时需要同时构建并更新微信机器人客户端服务。
提交前需要确认已选好友人数；单次人数和逐条发送间隔分别由
`WECHAT_ROBOT_BROADCAST_MAX_RECIPIENTS` 和
`WECHAT_ROBOT_BROADCAST_INTERVAL_SECONDS` 控制。群发消息应仅用于已同意接收通知的好友。

管理员群发接口示例：

```json
POST /wechat-robot/mass-send
{
  "recipients": ["wxid_example", "123456@chatroom"],
  "content": "课程通知内容"
}
```

该接口需要管理员 JWT，并受 `WECHAT_ROBOT_MASS_SEND_MAX_RECIPIENTS` 限制。生产环境应只
向已同意接收消息的白名单发送，并将 `wechat-robot-client` API 限制在内网访问。

旧 FAQ、课件解析和课程排期代码保留用于兼容历史数据，不挂载到默认应用；当前文档知识库使用 `app/knowledge/` 和 `/knowledge` 接口。
