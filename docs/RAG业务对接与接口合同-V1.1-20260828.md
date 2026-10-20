# AI数字运营系统 RAG业务对接与接口合同

**版本：** V1.1  
**日期：** 2026年8月28日  
**部署方式：** 本地单机部署  
**文档用途：** 供AI数字运营业务系统与RAG负责人进行需求确认、接口开发、联调和验收

---

## 1. 文档目标

本文档用于明确AI数字运营业务系统与RAG系统之间的职责边界、业务流程、接口字段、状态枚举、错误处理、版本控制、安全要求和联合验收标准。

本项目只建设一个RAG系统，不建设两套RAG。该RAG系统提供两个逻辑入口：

1. **运营测试入口：** 可查询当前正式知识和运营选中的待发布文档，仅供“小智”测试页面使用。
2. **正式用户入口：** 只能查询已正式发布的知识版本，供评论和私信业务调用。

RAG内部采用何种Embedding模型、向量数据库、切片、召回、重排和生成模型，由RAG负责人设计；业务系统只依赖本文约定的接口合同。

---

## 2. 已确认的总体原则

1. 所有服务只在本地电脑运行，不启用云端RAG。
2. RAG是无平台副作用的知识查询服务，不直接操作抖音、微博、B站或视频号。
3. 用户消息必须先经过业务系统的安全路由，符合条件后才允许进入RAG。
4. 已转人工用户、恶意内容、投诉、高风险内容等不进入RAG。
5. 用户聊天内容不能自动写入知识库。
6. 知识库后期由运营人员维护，运营提供正式业务材料。
7. 文档上传后先处理、测试，只有运营点击“发布”后才能应用到真实用户。
8. 小智测试中每条回答默认“启用”；运营不满意时可设置为“不启用”。
9. “不启用”必须在线上实际生效，不能只保存一个页面按钮状态。
10. RAG查询结果返回后，业务系统仍需进行会话版本和人工状态校验，校验通过后才允许创建发送任务。

---

## 3. 系统职责边界

### 3.1 业务系统负责

- 抖音、微博、B站、视频号的评论和私信采集；
- 评论采集与私信采集并行调度；
- 消息去重、会话状态、任务优先级和发送状态；
- 外层安全路由；
- 三轮意图澄清；
- 判断是否调用RAG；
- 聚合用户连续消息；
- 管理`conversationVersion`和输入指纹；
- 根据RAG结果创建评论回复、私信回复或转人工任务；
- 企业微信人工通知；
- 平台消息发送和发送结果核验；
- 运营知识库页面、小智测试页面、启用/不启用按钮和发布按钮；
- 运营人员身份、权限和业务操作日志。

### 3.2 RAG系统负责

- 文档接收和格式校验；
- 文档解析、OCR（如支持）、切片、向量化和索引；
- 测试知识范围和正式知识范围隔离；
- 知识检索、重排和基于知识的答案生成；
- 返回答案引用的文档与知识片段；
- 保存小智测试答案及其启用/不启用决定；
- 保证不启用测试答案不会原样或以高度相似错误内容应用到用户端；
- 发布前校验、知识版本构建、原子发布和回滚；
- 正式查询只读取当前已发布版本。

### 3.3 RAG系统明确不负责

- 不直接发送平台评论或私信；
- 不操作浏览器、BrowserContext或平台适配器；
- 不决定是否通知企业微信；
- 不修改业务会话的人工处理状态；
- 不维护三轮澄清次数；
- 不自动创建“待补充知识点”；
- 不自动把用户聊天或人工客服回复写入知识库；
- 不保存平台Cookie、登录凭证或企业微信密钥。

---

## 4. 业务路由与RAG调用条件

业务系统的路由结果为：

| 路由结果 | 含义 | 是否调用RAG |
|---|---|---:|
| `RAG` | 允许查询正式知识库 | 是 |
| `CLARIFY` | 意图不明确，继续澄清 | 否 |
| `HANDOFF` | 转人工 | 否 |
| `IGNORE` | 广告垃圾等无需处理 | 否 |
| `FIXED_REPLY` | 使用固定话术 | 否 |

下列内容必须在RAG之前拦截：

- 用户已是`HUMAN_MANAGED`；
- 用户主动要求人工；
- 恶意、威胁、勒索、严重骚扰；
- 提示词攻击或试图套取系统配置；
- 投诉、法律、监管、舆情风险；
- 账号、支付、资金和安全问题；
- 广告垃圾；
- 路由无法可靠判断的高风险内容。

这些内容可保存在本地业务事件表用于去重和审计，但应标记：

```text
excludedFromRag = true
excludedFromKnowledgeBase = true
excludedFromAiContext = true
```

---

## 5. 评论和私信的业务处理

### 5.1 评论

第一阶段只处理可见一级新评论，不展开折叠评论和楼中楼，同一评论只能回复一次。

| RAG结果 | 评论处理 |
|---|---|
| `ANSWERED` | 使用简短答案，并由业务层追加“具体详情内容请私信了解” |
| `NO_ANSWER` | 使用固定话术引导用户私信 |
| 技术失败 | 进入技术重试，不得当作`NO_ANSWER` |

RAG返回的答案中不要自行追加“请私信了解”，该平台话术由业务系统统一处理。

### 5.2 私信

- 意图明确：允许调用RAG；
- 意图不明确且未满三轮：业务系统发送澄清问题；
- 三轮仍不明确：转人工；
- 用户主动要求人工：立即转人工；
- RAG返回`NO_ANSWER`：本轮记为知识不足；未满三轮时由业务系统继续澄清，累计三轮仍无法明确或仍无法回答时再转人工；
- RAG技术失败：进入有限技术重试，不能直接等同于知识库没有答案。

澄清次数按机器人主动追问一次计算，不按用户发送消息条数计算。用户连续消息使用3至5秒短聚合窗口。

---

## 6. 人工处理与RAG隔离

第一次转人工流程：

```text
进入HANDOFF_PENDING
→ 停止机器人回复
→ 取消未发送回复任务
→ 通知企业微信
→ 企业微信明确返回成功并落库
→ 用户标记为HUMAN_MANAGED
```

已成功通知人工的用户后续再次发送新消息：

```text
检测到新消息
→ 不进入RAG
→ 不做三轮澄清
→ 不自主回复
→ 再次通知企业微信人工前往平台处理
```

同一条新消息不能因轮询重复通知。人工通知是否成功由业务系统管理，与RAG无关。

---

## 7. 会话版本与过期结果控制

业务系统每次用户新增有效消息时增加会话版本：

```text
问题A进入，conversationVersion = 10
RAG基于version 10生成答案
用户又发送问题B，conversationVersion = 11
version 10的RAG结果必须作废
```

RAG请求和响应必须包含并原样回显：

- `requestId`；
- `conversationKey`；
- `conversationVersion`；
- `inputFingerprint`。

业务系统收到RAG结果后，至少校验：

1. 当前会话版本是否仍与返回版本一致；
2. 输入指纹是否一致；
3. 用户是否已经转人工；
4. 是否出现新的用户消息；
5. 当前任务是否仍有效。

RAG不负责发送，因此RAG已经生成答案不代表答案一定会被发出。

---

## 8. 知识运营维护流程

知识库由运营人员维护，用户聊天只作为运营发现问题的参考，不能直接成为知识来源。

完整流程：

```text
运营上传正式材料
→ RAG处理文档
→ 文档进入READY_FOR_TEST
→ 运营在小智页面选择待测试文档
→ 小智使用正式知识+选中文档进行预发布测试
→ 每条测试回答默认启用
→ 不满意的回答设置为不启用
→ 运营点击发布
→ RAG构建新知识版本
→ 新版本正式应用到用户端
```

运营测试本身就是业务审核，不再增加“提交审批—领导审批”等额外流程。

### 8.1 一个RAG、两个逻辑入口

```text
一个RAG服务
├── 运营测试入口
│   └── 当前正式知识 + 运营选中的READY_FOR_TEST文档
└── 正式用户入口
    └── 只能查询当前PUBLISHED知识版本
```

文档只需解析和向量化一次。发布本质上是将已经测试的文档版本加入新的正式知识版本，不需要重复上传文档。

### 8.2 文档状态

| 状态 | 含义 |
|---|---|
| `UPLOADED` | 已接收文档 |
| `PROCESSING` | 正在解析、切片和建立索引 |
| `READY_FOR_TEST` | 处理完成，仅供小智测试 |
| `PROCESS_FAILED` | 处理失败 |
| `PUBLISHED` | 已包含在正式发布版本中 |
| `ARCHIVED` | 已下线 |

### 8.3 小智测试模式

建议支持：

1. `SINGLE_DOCUMENT`：只测试运营选中的待发布文档；
2. `PRE_RELEASE`：当前正式知识加运营选中的待发布文档，模拟上线后的真实效果。

小智页面默认使用`PRE_RELEASE`。

### 8.4 启用和不启用

- 每条测试回答默认`ENABLED`；
- 运营满意时无需额外操作；
- 运营不满意时设置为`DISABLED`；
- 运营完成测试后点击“发布”作为最终确认。

`DISABLED`不能只表示页面上不显示，必须记录测试问题、被拒绝答案、引用文档、引用片段、不启用原因、操作者和时间。

如果RAG无法保证被拒绝的错误答案不会应用到正式用户，必须阻止发布并返回发布校验失败。

---

## 9. 服务部署与接口分组

建议RAG服务监听：

```text
http://127.0.0.1:18080
```

端口通过配置文件或环境变量配置，不能写死在业务代码中。

接口分组：

```text
/rag-api/v1/*        正式用户查询
/rag-admin-api/v1/*  运营上传、测试和发布
```

浏览器页面、平台Worker和平台适配器不得直接调用RAG。所有调用必须经过本地业务服务的RAG Client适配层。

---

## 10. 接口总览

| 方法 | 接口 | 用途 |
|---|---|---|
| GET | `/rag-api/v1/health` | RAG健康检查 |
| POST | `/rag-api/v1/query` | 正式用户知识查询 |
| POST | `/rag-admin-api/v1/documents` | 上传运营文档 |
| GET | `/rag-admin-api/v1/documents/{documentId}` | 查询文档处理状态 |
| POST | `/rag-admin-api/v1/test-sessions` | 创建小智测试会话 |
| POST | `/rag-admin-api/v1/test-sessions/{sessionId}/query` | 小智预发布测试 |
| PUT | `/rag-admin-api/v1/test-sessions/{sessionId}/answers/{answerId}/decision` | 设置测试答案启用状态 |
| POST | `/rag-admin-api/v1/knowledge-bases/{knowledgeBaseId}/releases` | 发布知识版本 |
| GET | `/rag-admin-api/v1/releases/{releaseId}` | 查询发布状态 |
| POST | `/rag-admin-api/v1/releases/{releaseId}/rollback` | 回滚知识版本，可作为V1增强接口 |

---

## 11. 通用请求规范

### 11.1 HTTP请求头

```http
Content-Type: application/json
Authorization: Bearer <local-token>
X-Contract-Version: 1.0
X-Request-Id: <UUID或业务唯一ID>
```

文档上传接口使用`multipart/form-data`。

### 11.2 时间格式

所有时间统一使用ISO 8601，并携带时区，例如：

```text
2026-08-27T14:30:00+08:00
```

### 11.3 通用规则

- `requestId`必须全局唯一；
- 同一请求的技术重试必须使用相同`requestId`；
- 同一`requestId`不得对应不同请求内容；
- 接口合同版本第一版固定为`1.0`；
- 所有枚举值使用大写英文和下划线；
- 未知字段可忽略，但不能改变已有字段含义；
- 删除字段或改变字段语义必须升级主版本。

---

## 12. 健康检查接口

### 12.1 请求

```http
GET /rag-api/v1/health
```

### 12.2 返回

```json
{
  "status": "READY",
  "contractVersion": "1.0",
  "serviceVersion": "2026.08.27",
  "knowledgeVersion": "kb-20260827-001",
  "timestamp": "2026-08-27T14:30:00+08:00"
}
```

状态枚举：

| 状态 | 含义 |
|---|---|
| `READY` | 可以正常查询 |
| `STARTING` | 正在加载 |
| `DEGRADED` | 部分能力异常 |
| `NOT_READY` | 不可用 |

HTTP 200不代表一定可用，业务系统只有在`status=READY`时才发起正常查询。

---

## 13. 正式用户查询接口

### 13.1 请求

```http
POST /rag-api/v1/query
```

```json
{
  "contractVersion": "1.0",
  "requestId": "rag-query-20260827-001",
  "traceId": "douyin-dm-20260827-001",
  "snapshot": {
    "conversationKey": "DOUYIN:account-001:user-88321",
    "conversationVersion": 11,
    "inputFingerprint": "sha256:8d10946f..."
  },
  "source": {
    "platform": "DOUYIN",
    "accountId": "account-001",
    "channelType": "DIRECT_MESSAGE"
  },
  "knowledgeScope": {
    "tenantId": "local-default",
    "knowledgeBaseId": "main-business-kb"
  },
  "query": {
    "text": "这个产品多少钱？安装费用怎么算？",
    "messageIds": ["msg-10086", "msg-10087"],
    "lastMessageAt": "2026-08-27T14:28:16+08:00"
  },
  "context": [
    {
      "role": "USER",
      "messageId": "msg-10080",
      "text": "我想了解一下你们的产品",
      "sentAt": "2026-08-27T14:25:02+08:00"
    },
    {
      "role": "ASSISTANT",
      "messageId": "msg-10081",
      "text": "请问您主要想了解价格、功能还是安装服务？",
      "sentAt": "2026-08-27T14:25:20+08:00"
    }
  ],
  "constraints": {
    "language": "zh-CN",
    "answerFormat": "PLAIN_TEXT",
    "maxAnswerChars": 600,
    "requireGrounding": true
  }
}
```

### 13.2 关键字段

| 字段 | 必填 | 说明 |
|---|---:|---|
| `contractVersion` | 是 | 接口合同版本 |
| `requestId` | 是 | 本次请求唯一ID |
| `traceId` | 是 | 整条业务链路追踪ID |
| `conversationKey` | 是 | 平台、账号、用户组成的稳定会话标识 |
| `conversationVersion` | 是 | 本次会话快照版本 |
| `inputFingerprint` | 是 | 本次聚合输入摘要 |
| `platform` | 是 | 平台枚举 |
| `channelType` | 是 | 评论或私信 |
| `knowledgeBaseId` | 是 | 目标知识库 |
| `query.text` | 是 | 聚合后的当前问题 |
| `context` | 否 | 必要的最近上下文 |
| `maxAnswerChars` | 是 | 最大回答字符数 |

平台枚举：

```text
DOUYIN
WEIBO
BILIBILI
WECHAT_CHANNELS
```

渠道枚举：

```text
COMMENT
DIRECT_MESSAGE
```

上下文角色：

```text
USER
ASSISTANT
```

建议限制：

- `query.text`最多4000字符；
- `context`最多12条；
- `context`总长度最多12000字符；
- 单条上下文最多4000字符；
- 正式回答默认最多600字符，评论可由业务系统设置更小值。

### 13.3 有答案返回

```json
{
  "contractVersion": "1.0",
  "requestId": "rag-query-20260827-001",
  "traceId": "douyin-dm-20260827-001",
  "snapshot": {
    "conversationKey": "DOUYIN:account-001:user-88321",
    "conversationVersion": 11,
    "inputFingerprint": "sha256:8d10946f..."
  },
  "result": "ANSWERED",
  "answer": {
    "text": "该产品价格根据配置确定，标准安装包含基础服务，特殊施工环境可能产生额外费用。",
    "format": "PLAIN_TEXT"
  },
  "grounding": {
    "confidence": 0.91,
    "sourceReferences": [
      {
        "documentId": "document-001",
        "documentVersion": 1,
        "chunkId": "chunk-018",
        "title": "产品价格与安装服务说明"
      }
    ]
  },
  "meta": {
    "knowledgeBaseId": "main-business-kb",
    "releaseId": "release-20260827-001",
    "knowledgeVersion": "kb-20260827-001",
    "serviceVersion": "2026.08.27",
    "latencyMs": 1860
  }
}
```

`ANSWERED`必须表示已找到足够知识依据，答案可以直接展示，不允许在缺少依据时依靠模型常识编造。

### 13.4 无答案返回

```json
{
  "contractVersion": "1.0",
  "requestId": "rag-query-20260827-001",
  "traceId": "douyin-dm-20260827-001",
  "snapshot": {
    "conversationKey": "DOUYIN:account-001:user-88321",
    "conversationVersion": 11,
    "inputFingerprint": "sha256:8d10946f..."
  },
  "result": "NO_ANSWER",
  "answer": null,
  "reasonCode": "INSUFFICIENT_EVIDENCE",
  "meta": {
    "knowledgeBaseId": "main-business-kb",
    "releaseId": "release-20260827-001",
    "knowledgeVersion": "kb-20260827-001",
    "latencyMs": 920
  }
}
```

`reasonCode`：

```text
NO_RELEVANT_KNOWLEDGE
INSUFFICIENT_EVIDENCE
OUT_OF_SCOPE
KNOWLEDGE_CONFLICT
DISABLED_TEST_CASE
```

RAG业务结果第一版只允许：

```text
ANSWERED
NO_ANSWER
```

`CLARIFY`、`HANDOFF`、`IGNORE`和`FIXED_REPLY`由业务系统决定，RAG不得返回这些业务动作。

---

## 14. 文档上传接口

### 14.1 请求

```http
POST /rag-admin-api/v1/documents
Content-Type: multipart/form-data
```

字段：

- `file`：文档文件；
- `metadata`：JSON字符串。

```json
{
  "requestId": "upload-20260827-001",
  "knowledgeBaseId": "main-business-kb",
  "title": "2026年安装服务说明",
  "category": "INSTALLATION_SERVICE",
  "sourceDepartment": "安装服务部",
  "sourceOwner": "张三",
  "effectiveFrom": "2026-08-01",
  "effectiveTo": null,
  "uploadedBy": "operator-001"
}
```

V1建议支持：PDF、DOCX、XLSX、TXT、Markdown；单文件建议限制50MB。扫描PDF和图片OCR能力由双方联调前确认。

### 14.2 返回

```http
202 Accepted
```

```json
{
  "requestId": "upload-20260827-001",
  "documentId": "document-001",
  "documentVersion": 1,
  "status": "PROCESSING",
  "createdAt": "2026-08-27T14:00:00+08:00"
}
```

---

## 15. 文档状态查询接口

```http
GET /rag-admin-api/v1/documents/document-001
```

处理完成返回：

```json
{
  "documentId": "document-001",
  "documentVersion": 1,
  "title": "2026年安装服务说明",
  "status": "READY_FOR_TEST",
  "progress": 100,
  "processingResult": {
    "pageCount": 36,
    "chunkCount": 128
  }
}
```

处理失败返回：

```json
{
  "documentId": "document-001",
  "documentVersion": 1,
  "status": "PROCESS_FAILED",
  "error": {
    "code": "DOCUMENT_PARSE_FAILED",
    "message": "无法解析该文档"
  }
}
```

业务页面建议每2至5秒轮询一次，直到进入终态。

---

## 16. 创建小智测试会话接口

```http
POST /rag-admin-api/v1/test-sessions
```

```json
{
  "requestId": "create-test-session-001",
  "knowledgeBaseId": "main-business-kb",
  "mode": "PRE_RELEASE",
  "baseReleaseId": "release-20260820-001",
  "candidateDocuments": [
    {"documentId": "document-001", "documentVersion": 1},
    {"documentId": "document-002", "documentVersion": 3}
  ],
  "operatorId": "operator-001"
}
```

返回：

```json
{
  "requestId": "create-test-session-001",
  "testSessionId": "test-session-001",
  "status": "TESTING",
  "mode": "PRE_RELEASE",
  "baseReleaseId": "release-20260820-001",
  "candidateDocuments": [
    {"documentId": "document-001", "documentVersion": 1},
    {"documentId": "document-002", "documentVersion": 3}
  ]
}
```

测试会话必须固定文档版本。文档在测试后发生修改时，不得发布未重新测试的新版本。

---

## 17. 小智测试查询接口

```http
POST /rag-admin-api/v1/test-sessions/test-session-001/query
```

请求：

```json
{
  "requestId": "test-query-001",
  "question": "特殊安装环境需要另外收费吗？",
  "context": []
}
```

返回：

```json
{
  "requestId": "test-query-001",
  "testSessionId": "test-session-001",
  "answerId": "test-answer-001",
  "result": "ANSWERED",
  "answer": {
    "text": "特殊安装环境可能产生额外费用，具体费用需要根据现场情况确定。",
    "format": "PLAIN_TEXT"
  },
  "decision": "ENABLED",
  "sourceReferences": [
    {
      "documentId": "document-001",
      "documentVersion": 1,
      "chunkId": "chunk-018",
      "title": "2026年安装服务说明",
      "excerpt": "高空作业、特殊墙体施工等特殊环境可能产生额外费用。"
    }
  ],
  "meta": {
    "latencyMs": 1250
  }
}
```

每条回答必须返回`answerId`和引用来源，以便页面展示“查看原文”并记录启用决定。

---

## 18. 测试答案启用状态接口

```http
PUT /rag-admin-api/v1/test-sessions/test-session-001/answers/test-answer-001/decision
```

启用：

```json
{
  "requestId": "decision-001",
  "decision": "ENABLED",
  "operatorId": "operator-001"
}
```

不启用：

```json
{
  "requestId": "decision-002",
  "decision": "DISABLED",
  "reasonCode": "ANSWER_INACCURATE",
  "operatorId": "operator-001"
}
```

原因枚举：

```text
ANSWER_INACCURATE
SHOULD_HANDOFF
SOURCE_INCORRECT
OTHER
```

返回：

```json
{
  "requestId": "decision-002",
  "testSessionId": "test-session-001",
  "answerId": "test-answer-001",
  "decision": "DISABLED",
  "decisionVersion": 2,
  "updatedAt": "2026-08-27T14:30:00+08:00"
}
```

### 18.1 不启用的执行合同

RAG必须保存：

- 测试问题；
- 被拒绝答案；
- 引用文档版本；
- 引用知识片段；
- 原因和操作者。

正式版本发布时，RAG必须通过负向测试、来源排除、主题限制或其他可靠机制，保证被拒绝的错误答案不会在线上重复出现。

如果无法保证，发布必须失败并返回`DISABLED_CASE_VALIDATION_FAILED`。不得在仅保存`decision=false`后仍允许同类错误答案上线。

如果运营后续测试并启用了正确替代答案，可由新测试记录覆盖旧的禁止结果，具体覆盖规则由RAG内部实现，但必须保留审计历史。

---

## 19. 发布知识版本接口

```http
POST /rag-admin-api/v1/knowledge-bases/main-business-kb/releases
```

请求：

```json
{
  "requestId": "publish-20260827-001",
  "testSessionId": "test-session-001",
  "baseReleaseId": "release-20260820-001",
  "candidateDocuments": [
    {"documentId": "document-001", "documentVersion": 1},
    {"documentId": "document-002", "documentVersion": 3}
  ],
  "publishedBy": "operator-001",
  "publishNote": "发布2026年安装服务及价格说明"
}
```

初始返回：

```http
202 Accepted
```

```json
{
  "requestId": "publish-20260827-001",
  "releaseId": "release-20260827-001",
  "status": "BUILDING"
}
```

发布必须满足：

1. 文档仍是测试时的版本；
2. 文档处理状态为`READY_FOR_TEST`；
3. 不存在`SOURCE_INCORRECT`未解决问题；
4. 所有`DISABLED`测试答案的线上限制可以生效；
5. 新版本构建失败时不影响当前线上版本；
6. 发布完成后原子切换当前正式版本。

---

## 20. 发布状态查询接口

```http
GET /rag-admin-api/v1/releases/release-20260827-001
```

发布完成：

```json
{
  "releaseId": "release-20260827-001",
  "knowledgeBaseId": "main-business-kb",
  "knowledgeVersion": "kb-20260827-001",
  "status": "PUBLISHED",
  "publishedAt": "2026-08-27T15:00:00+08:00",
  "publishedBy": "operator-001",
  "enabledTestCaseCount": 17,
  "disabledTestCaseCount": 3
}
```

发布校验失败：

```json
{
  "releaseId": "release-20260827-001",
  "status": "FAILED",
  "error": {
    "code": "DISABLED_CASE_VALIDATION_FAILED",
    "message": "不启用的测试答案仍可能被当前知识版本生成",
    "details": [
      {
        "answerId": "test-answer-001",
        "question": "安装是不是全部免费？"
      }
    ]
  }
}
```

---

## 21. 状态枚举汇总

### 21.1 测试会话状态

```text
TESTING
PUBLISHING
PUBLISHED
CANCELLED
```

### 21.2 发布状态

```text
BUILDING
PUBLISHED
FAILED
ROLLED_BACK
```

### 21.3 正式查询结果

```text
ANSWERED
NO_ANSWER
```

### 21.4 测试答案决定

```text
ENABLED
DISABLED
```

所有状态枚举一经双方确认，不得单方面改名或改变含义。

---

## 22. HTTP状态码与错误格式

| HTTP状态码 | 含义 | 是否自动重试 |
|---:|---|---:|
| 200 | 查询或操作成功 | 否 |
| 202 | 异步任务已接收 | 否，查询任务状态 |
| 400 | JSON或基础参数错误 | 否 |
| 401 | Token错误 | 否 |
| 404 | 文档、测试会话或发布版本不存在 | 否 |
| 409 | 幂等冲突或版本冲突 | 否 |
| 413 | 文件或请求内容过大 | 否 |
| 422 | 字段语义不合法或发布校验不通过 | 否 |
| 429 | RAG过载 | 可以延迟重试 |
| 500 | RAG内部异常 | 可以有限重试 |
| 503 | 服务未准备好 | 可以延迟重试 |
| 504 | RAG内部超时 | 可以有限重试 |

统一错误响应：

```json
{
  "contractVersion": "1.0",
  "requestId": "request-001",
  "error": {
    "code": "INVALID_QUERY",
    "message": "query.text不能为空",
    "retryable": false,
    "retryAfterMs": null,
    "details": {
      "field": "query.text"
    }
  }
}
```

建议错误码：

```text
INVALID_REQUEST
INVALID_QUERY
UNAUTHORIZED
RESOURCE_NOT_FOUND
IDEMPOTENCY_CONFLICT
DOCUMENT_TOO_LARGE
UNSUPPORTED_FILE_TYPE
DOCUMENT_PARSE_FAILED
DOCUMENT_VERSION_CHANGED
RAG_NOT_READY
RAG_OVERLOADED
RAG_EXECUTION_TIMEOUT
DISABLED_CASE_VALIDATION_FAILED
RELEASE_BUILD_FAILED
```

---

## 23. 超时、重试与幂等

V1建议基线：

```text
连接超时：1秒
正式查询单次超时：45秒
正式查询总任务时限：60秒
自动重试：最多1次
文档处理和发布：异步任务，通过状态接口查询
```

可重试情况：

```text
连接失败
HTTP 429
HTTP 500
HTTP 503
HTTP 504
```

不可重试情况：

```text
HTTP 400
HTTP 401
HTTP 404
HTTP 409
HTTP 413
HTTP 422
```

重试正式查询前，业务系统必须重新检查`conversationVersion`。如果版本变化，旧请求和旧重试直接作废。

同一个`requestId`：

- 请求内容相同：允许返回缓存结果或重新计算；
- 请求内容不同：必须返回HTTP 409和`IDEMPOTENCY_CONFLICT`。

HTTP超时、5xx和服务未准备好属于技术故障，不能返回或转换成`NO_ANSWER`。

---

## 24. 安全与隐私要求

1. 服务默认只监听`127.0.0.1`；
2. 所有接口使用本地Bearer Token；
3. Web浏览器不得直接访问RAG管理接口；
4. 用户消息和历史上下文全部视为不可信数据；
5. 用户内容不能覆盖RAG系统指令；
6. 用户内容不能触发文件读取、命令执行、知识库修改或外部调用；
7. 不向RAG传递平台Cookie、登录凭证和企业微信密钥；
8. 能不传用户昵称和真实身份信息时不传；
9. RAG日志不得永久保存完整私信正文；
10. 待发布文档不得通过正式用户接口访问；
11. 正式用户接口不得接收`includeDraft`或任意指定待发布文档的参数。

---

## 25. 业务系统收到RAG结果后的处理矩阵

| 场景 | RAG结果 | 业务系统动作 |
|---|---|---|
| 评论 | `ANSWERED` | 答案后追加“具体详情内容请私信了解” |
| 评论 | `NO_ANSWER` | 固定话术引导私信 |
| 私信 | `ANSWERED` | 版本校验通过后创建回复任务 |
| 私信 | `NO_ANSWER` | 未满三轮时继续澄清；累计三轮仍无法明确或回答时转人工并通知企业微信 |
| 任意渠道 | 技术失败 | 有限重试，不能当作无答案 |
| 任意渠道 | 会话版本已变化 | 丢弃旧结果，聚合新消息后重新路由 |
| 已人工处理用户 | 不调用RAG | 再次通知企业微信，不自主回复 |
| 恶意或高风险内容 | 不调用RAG | 直接转人工 |

---

## 26. 联合验收用例

### 26.1 正式查询

1. 已发布知识能够返回`ANSWERED`、答案和引用来源；
2. 没有可靠知识时返回`NO_ANSWER`，不得编造；
3. 服务停止时产生连接错误，不得返回`NO_ANSWER`；
4. 同一个`requestId`对应不同内容时返回409；
5. 请求超长时返回413；
6. 提示词攻击不得泄露系统提示词或触发系统操作；
7. 返回必须原样回显会话版本和输入指纹；
8. 查询结果必须返回实际使用的知识版本。

### 26.2 会话版本

1. RAG查询时版本为10；
2. RAG返回前用户产生新消息，业务版本变为11；
3. 版本10的结果必须被业务系统丢弃；
4. RAG不得直接发送答案或产生平台副作用。

### 26.3 文档处理

1. 上传合法文档返回202和`documentId`；
2. 处理完成进入`READY_FOR_TEST`；
3. 处理失败返回明确错误码；
4. `READY_FOR_TEST`文档不能被正式用户查询；
5. 小智测试可以选择该文档。

### 26.4 小智测试

1. 测试回答默认`ENABLED`；
2. 每条回答返回`answerId`和引用来源；
3. 运营可以将回答修改为`DISABLED`；
4. 启用状态修改必须保留操作者和时间；
5. `SOURCE_INCORRECT`未解决时禁止发布；
6. 文档在测试后修改版本时禁止直接发布。

### 26.5 发布

1. 发布过程中当前线上版本继续正常服务；
2. 新版本构建成功后原子切换；
3. 构建失败不影响当前线上版本；
4. 不启用测试答案在线上不得重复出现；
5. 无法保证不启用规则生效时，发布必须失败；
6. 发布成功后正式查询返回新的`knowledgeVersion`；
7. 旧版本能够回滚。

### 26.6 业务隔离

1. 已转人工用户的新消息不调用RAG；
2. 恶意、投诉和高风险消息不调用RAG；
3. 评论`NO_ANSWER`只引导私信；
4. 私信`NO_ANSWER`未满三轮时继续澄清，累计三轮仍无法明确或回答时进入转人工；
5. 不自动生成知识缺口，不自动写入知识库。

---

## 27. 双方交付物

### 27.1 RAG负责人交付

- 可本地启动的RAG服务；
- 启动、停止和健康检查说明；
- 符合本文的OpenAPI 3.x文档；
- 请求和响应示例；
- 错误码表；
- 支持的文档格式和大小限制；
- 文档处理、测试、发布和回滚能力；
- 不启用测试答案的实际执行方案说明；
- 联调测试数据和验收记录。

### 27.2 业务系统负责人交付

- RAG Client适配层；
- 外层安全路由；
- 会话版本和输入指纹；
- 运营上传与小智测试页面；
- 启用/不启用和发布操作页面；
- 评论、私信和人工处理业务流程；
- 企业微信通知；
- 联调日志和业务验收记录。

---

## 28. 联调前必须确认的开放项

以下内容在开发联调前由双方填写并确认：

| 项目 | 确认结果 |
|---|---|
| RAG监听端口 | 待确认，建议18080 |
| Bearer Token配置方式 | 待确认 |
| 支持的文件格式 | 待确认，建议PDF/DOCX/XLSX/TXT/MD |
| 单文件最大大小 | 待确认，建议50MB |
| 是否支持扫描PDF/OCR | 待确认 |
| 正式查询平均耗时和P95 | 待压测 |
| 正式查询超时时间 | 待确认，建议45秒 |
| 不启用答案的执行机制 | RAG负责人提供方案并通过验收 |
| 版本回滚保留数量 | 待确认 |
| 日志保留周期 | 待确认 |

---

## 29. 最终对接结论

本项目只使用一个本地RAG系统。业务系统先执行安全路由、人工状态判断和意图澄清，仅将允许查询的消息提交RAG。RAG正式查询只读取已发布知识，返回`ANSWERED`或`NO_ANSWER`以及引用和知识版本，不参与平台发送和转人工。

运营上传的文档先进入`READY_FOR_TEST`，在小智页面选中文档进行预发布测试；每条回答默认启用，不满意的设置为不启用；运营点击发布后，RAG完成发布校验并生成新的正式知识版本。未发布文档不能被真实用户查询，不启用的错误答案不能在线上重复应用。

本文档经双方确认后，作为接口开发、联调、错误责任判定和验收的共同依据。任何字段、枚举、状态含义或关键业务规则的变更，应通过新文档版本进行确认，不得单方面修改。

---

## 30. 2026年8月28日落地补充合同（V1.1）

> 本节记录业务项目与`D:\code\rag`完成代码联调后确认的最终落地口径。若前文与本节存在冲突，以本节为准。

### 30.1 唯一事实源与访问边界

1. 本项目仍然只有一个RAG系统，不拆成“测试RAG”和“正式RAG”。
2. RAG是以下数据的唯一事实源：
   - 上传文档及其版本；
   - 文档处理状态和切片结果；
   - 小智测试会话、测试答案及引用；
   - 每条测试答案的启用/不启用决定；
   - 决定历史与当前有效负向案例；
   - 发布版本、发布成员、当前正式版本和回滚状态。
3. 业务数据库只保存业务会话、任务状态、远端标识和必要的短期显示缓存，不复制一套可独立发布的RAG知识状态。
4. 运营浏览器只能访问业务后端`/api/rag/*`和`/api/xiaozhi/*`；不得直接访问`/rag-admin-api/*`。
5. RAG Token只保存在本地业务后端配置中，不下发到浏览器，不写入页面源码或前端日志。
6. 正式平台用户消息只能调用`POST /rag-api/v1/query`；待测文档只能通过RAG Admin测试会话访问。

### 30.2 本地部署配置

业务后端至少配置：

```text
RAG_BASE_URL=http://127.0.0.1:18080
RAG_TOKEN=<本地Bearer Token>
RAG_ADMIN_ENABLED=true
RAG_FORMAL_ROUTING_ENABLED=true
RAG_TIMEOUT_MS=<双方确认值>
RAG_UPLOAD_MAX_BYTES=52428800
```

安全要求：

- RAG默认监听`127.0.0.1`；
- 业务后端统一添加`Authorization: Bearer <token>`、`X-Contract-Version: 1.0`和`X-Request-Id`；
- 本地未配置或RAG不可用时，业务系统返回明确技术状态，不得退回旧知识库冒充正式RAG；
- 技术失败不得转换为`NO_ANSWER`。

### 30.3 浏览器到业务后端的RAG Admin代理

| 业务Web接口 | 方法 | 作用 | 对应RAG接口 |
|---|---|---|---|
| `/api/rag/status` | GET | 系统状态 | `/rag-admin-api/v1/system/status` |
| `/api/rag/documents` | GET | 文档列表 | `/rag-admin-api/v1/documents` |
| `/api/rag/documents` | POST | 上传文档 | `/rag-admin-api/v1/documents` |
| `/api/rag/documents/{documentId}?version={version}` | GET | 文档状态 | `/rag-admin-api/v1/documents/{documentId}` |
| `/api/rag/releases` | GET | 发布列表和当前正式版本 | `/rag-admin-api/v1/releases` |
| `/api/rag/releases` | POST | 创建发布 | `/rag-admin-api/v1/knowledge-bases/{knowledgeBaseId}/releases` |
| `/api/rag/releases/{releaseId}` | GET | 发布状态 | `/rag-admin-api/v1/releases/{releaseId}` |
| `/api/rag/releases/{releaseId}/rollback` | POST | 回滚版本 | `/rag-admin-api/v1/releases/{releaseId}/rollback` |

小智页面继续使用业务接口：

```text
GET  /api/xiaozhi/options
POST /api/xiaozhi/sessions
POST /api/xiaozhi/chat
PUT  /api/xiaozhi/sessions/{sessionId}/answers/{answerId}/decision
GET  /api/xiaozhi/sessions/{sessionId}/answers
GET  /api/xiaozhi/sessions/{sessionId}/answers/{answerId}/history
```

业务后端负责把这些调用映射到RAG Admin测试会话接口，并将当前登录运营人员写入`operatorId`或`publishedBy`。

### 30.4 浏览器上传合同与50MB限制

浏览器向业务后端上传时使用JSON和Base64：

```http
POST /api/rag/documents
Content-Type: application/json
```

```json
{
  "filename": "2026秋季活动运营手册.pdf",
  "mimeType": "application/pdf",
  "contentBase64": "JVBERi0xLjQK...",
  "metadata": {
    "knowledgeBaseId": "main-business-kb",
    "title": "2026秋季活动运营手册",
    "category": "活动运营",
    "sourceDepartment": "运营部",
    "sourceOwner": "张三"
  }
}
```

约束：

1. `contentBase64`可带或不带Data URL前缀；业务后端必须做严格Base64校验。
2. 解码后的原始文件默认最大50MB，即`52428800`字节；超出返回HTTP 413和`RAG_FILE_TOO_LARGE`。
3. 业务后端接收JSON时应为Base64膨胀预留请求体空间，但大小判断必须以解码后的原始字节为准。
4. 业务后端校验后转换为RAG要求的`multipart/form-data`：
   - `file`：原始文件二进制；
   - `metadata`：JSON字符串。
5. 浏览器不得自行拼接RAG Bearer Token或直接提交到RAG端口。
6. RAG接收成功返回HTTP 202；此时仅表示已经受理，不代表文档已经可以测试。

### 30.5 文档异步状态与页面轮询

RAG原始文档状态：

```text
UPLOADED
PROCESSING
READY_FOR_TEST
PROCESS_FAILED
```

业务Web可以把`PROCESS_FAILED`归一化显示为“处理失败/FAILED”，但不得把它显示为可测试。

页面行为：

- `UPLOADED`或`PROCESSING`：知识库页面每2.5秒查询一次最新状态；
- `READY_FOR_TEST`：停止该文档的高频轮询，并提供“到小智测试”；
- `PROCESS_FAILED`：停止高频轮询，显示RAG返回的错误码和错误说明；
- 离开RAG知识库页面后必须停止文档轮询；
- 上传表单有输入、已选文件或正在编辑时，轮询不得强制重绘表单造成内容丢失。

### 30.6 小智三种知识范围

业务页面提供三种`scope`：

| 页面scope | RAG测试会话含义 | 候选文档规则 |
|---|---|---|
| `published` | 只测当前正式发布版本 | 强制清空候选文档和选中文档 |
| `pre_release` | 当前正式版本 + 待测文档 | RAG模式`PRE_RELEASE` |
| `single_document` | 仅测试当前选中文档 | RAG模式`SINGLE_DOCUMENT` |

强制一致性规则：

1. `candidateDocuments`按`documentId + documentVersion`去重。
2. 切换到`published`时，前后端都必须清空：
   - `selectedDocumentId`；
   - `selectedDocumentVersion`；
   - `candidateDocuments`。
3. 切换文档或scope后，旧测试结果不能作为新范围的发布依据，必须重新测试。
4. 测试会话必须绑定候选文档的明确版本；文档版本变化后不得沿用旧测试结果发布。
5. 测试内容不得写入真实`messages`，不得创建真实Agent发送任务，也不得通知企业微信。

### 30.7 测试答案决定、版本和幂等

每条测试答案默认：

```json
{
  "decision": "ENABLED",
  "decisionVersion": 1
}
```

设置为不启用时必须提交结构化原因：

```json
{
  "requestId": "decision-001",
  "decision": "DISABLED",
  "reasonCode": "ANSWER_INACCURATE",
  "note": "报名时间与正式材料不一致",
  "operatorId": "admin"
}
```

`reasonCode`枚举：

```text
ANSWER_INACCURATE  答案内容不准确
SOURCE_INCORRECT   引用来源错误
SHOULD_HANDOFF     应该转人工
OTHER              其他
```

执行规则：

1. `DISABLED`必须提供`reasonCode`和非空具体说明；页面最大输入500字，RAG合同字段`note`最大2000字。
2. 相同`requestId`和相同决定重复提交必须幂等，不重复增加`decisionVersion`和历史记录。
3. 有效决定发生变化时，`decisionVersion`递增，并保留操作者、时间、原因和请求ID。
4. 重新设为`ENABLED`时，当前原因清空，但历史记录保留。
5. 业务Web必须能够读取答案列表和单条答案决定历史。

### 30.8 负向案例生命周期

RAG负责维护负向案例，业务系统不另建“待补充知识点”流程。

- 测试答案从`ENABLED`改为`DISABLED`时，产生或更新一条当前有效负向案例；
- 对同一答案重复提交相同决定，不得产生重复有效案例；
- 重新改为`ENABLED`时，清除该答案当前有效负向案例；
- 再次改为`DISABLED`时，只恢复一条当前有效案例，同时保留历史；
- 发布构建必须读取当前有效决定和负向案例，不能只读取页面缓存；
- 运营后续需要补充哪些材料，由人工查看测试和转人工记录后决定，不由系统自动生成知识缺口。

### 30.9 发布范围一致性门槛

“发布为正式版本”按钮只有同时满足以下条件才允许操作：

```text
当前为RAG模式
已经创建远端testSessionId
当前scope不是published
当前选中文档属于已经完成测试的候选文档
当前页面scope与最后一次测试的会话scope一致
```

创建发布时必须提交：

- `testSessionId`；
- `baseReleaseId`（如存在）；
- 已测试的`candidateDocuments`及其明确版本；
- 当前运营人员`publishedBy`；
- 发布说明`publishNote`。

以下情况必须禁止发布：

- 只选择文档但未进行至少一轮测试；
- 测试文档A后切换到文档B但未重新测试；
- 切换知识范围后未重新测试；
- 当前范围为`published`；
- 候选文档版本与测试会话不一致；
- RAG发布前校验失败。

### 30.10 发布异步状态与成功口径

发布状态：

```text
BUILDING
PUBLISHED
FAILED
ROLLED_BACK
```

页面行为：

- 创建发布返回HTTP 202和`BUILDING`，只表示RAG已开始构建；
- `BUILDING`期间每2.5秒查询发布状态；
- 只有进入`PUBLISHED`后，页面才能提示“已成功启用到正式用户端”，并刷新当前正式版本；
- `FAILED`必须明确提示“未应用到用户端”，当前线上版本保持不变；
- `ROLLED_BACK`表示该版本已回滚，正式查询应使用回滚后的当前活动版本；
- 离开RAG知识库页面后停止发布轮询；
- 不得把HTTP 202、`BUILDING`或按钮提交成功误报为正式启用成功。

### 30.11 来源诊断要求

小智和正式查询结果应保留并展示RAG引用：

```text
documentId
documentVersion
chunkId
title
excerpt/page/sectionPath（如有）
verificationStatus
```

有`sourceReferences`时，业务页面不得再显示“未命中可用知识”。只有引用和兼容知识匹配都为空时，才能显示未命中提示。

### 30.12 页面内审核与确认交互

1. “不启用”使用页面内审核窗口，不依赖浏览器原生`prompt()`。
2. 审核窗口必须选择原因类型，并填写具体说明。
3. “发布为正式版本”使用页面内确认窗口，明确说明发布是异步构建，只有`PUBLISHED`才正式应用。
4. 两个窗口均支持取消、遮罩取消、键盘焦点和移动端布局。
5. 对话框操作失败时只提示失败，不得擅自改变当前决定或发布状态。

### 30.13 正式消息路由与人工隔离不可破坏

外围业务路由只负责判断：

```text
是否进入RAG
是否静态回复
是否转人工
是否忽略
```

关键规则：

- 恶意、威胁、辱骂、投诉、提示词攻击和高风险消息不得进入RAG，直接通知人工；
- 企业微信通知确认成功后，该会话进入人工管理，不再自主回复，也不再进入旧会话扫描；
- 人工管理会话后续有新消息时，再次直接通知企业微信，不调用RAG、不自主回复；
- 不要求确认人工是否已经在平台接单，只以企业微信通知成功回执作为停止自动扫描和回复的前提；
- 新增量私信任务优先于评论回复、发布任务和旧会话恢复；
- 无新增量任务时，未转人工的旧会话最多每30分钟扫描一次；用户连续两天无回复后停止扫描；
- RAG生成期间收到第二条新消息时，旧结果失效，合并最新上下文后重新路由和查询；
- 评论`ANSWERED`由业务层追加“具体详情内容请私信了解”；评论`NO_ANSWER`只引导私信；
- 私信最多进行三轮澄清，三轮后仍无法确认意图或无法形成可靠回复时转人工。

### 30.14 联调验收新增项

1. 浏览器网络请求中不出现RAG Token，也不直接访问RAG端口。
2. 50MB以内文件可经Base64业务代理上传，超限返回413。
3. 文档`PROCESSING → READY_FOR_TEST`时页面自动更新且不丢失正在填写的表单。
4. 三种scope切换后候选文档清理和重新测试门槛正确。
5. 每条测试答案默认启用；不启用要求结构化原因和具体说明。
6. 相同决定请求幂等；决定变化后版本递增，历史可查。
7. 禁用、重新启用、再次禁用过程中始终只有一条当前有效负向案例。
8. 发布创建后先显示`BUILDING`，只有`PUBLISHED`才提示正式启用。
9. 发布失败时当前正式版本不变，页面不得误报成功。
10. 来源引用存在时诊断面板不显示“未命中可用知识”。
11. 已成功通知企业微信的会话不再自主回复和旧会话扫描。
12. 风险消息和人工管理会话均不调用RAG。

---

## 31. 确认记录

| 角色 | 姓名 | 日期 | 确认意见 |
|---|---|---|---|
| 业务系统负责人 |  |  |  |
| RAG负责人 |  |  |  |
| 运营代表 |  |  |  |

