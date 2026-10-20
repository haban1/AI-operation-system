> **状态说明（2026-08-24）：本方案已被 V1.1 音频版方案替代。最新需求只根据视频音频生成标题和正文，不再分析视频画面，也不再需要 OSS 视频上传。请以 视频音频驱动AI自动生成发布文案执行方案-V1.1.md 为准。**

# 视频上传后 AI 自动生成发布文案执行方案 V1.0

> 文档日期：2026-08-24  
> 适用项目：天河 AI 数字员工运营平台  
> 文档性质：实施前技术方案，不包含本次业务代码修改

---

## 1. 背景与目标

当前发布页的操作顺序是：选择本地素材、执行素材预检、人工填写标题和正文、执行 AI 合规审核、创建发布任务。用户希望新增以下能力：

1. 用户选择或上传视频后，系统自动理解视频内容；
2. 根据视频画面、视频中的硬字幕以及音频生成标题和正文；
3. 自动把结果填写到发布页现有的“标题”和“正文”字段；
4. 用户可以修改、重新生成、取消，并在确认后继续现有 AI 合规审核和发布流程；
5. 约 2 分 30 秒的视频，正常情况下应在可接受时间内完成。

当前百炼 Key 已确认可调用千问 3.5 及其他千问模型，因此第一期不新增 Kimi，不增加第二套模型供应商、Key 管理和计费链路。

---

## 2. 方案结论

### 2.1 推荐模型链路

第一期采用“双模型分工”方案：

```text
qwen3.5-omni-plus
理解视频画面、硬字幕、语音和环境声音，产出视频语义报告
        ↓
qwen3.7-plus
基于语义报告生成符合系统约束的结构化 JSON 文案
        ↓
前端安全填入标题、正文
        ↓
用户确认/修改
        ↓
重新执行现有 AI 合规审核
        ↓
创建发布任务
```

分工原因：

- `qwen3.5-omni-plus` 更适合同时理解视频、音频和画面内字幕；
- `qwen3.7-plus` 用于稳定生成标题、正文、标签、事实清单和风险标记；
- 不依赖 Omni 严格返回 JSON，而是在第二步统一做结构化输出、字段长度控制和文案润色；
- 两个模型复用现有百炼 Key，不引入新的供应商依赖；
- 第二步只传递视频语义报告，不再次传视频，减少重复的视频处理开销。

### 2.2 可选降本模式

系统预留以下配置模式，但不建议第一天就开放给普通用户：

```env
AI_VIDEO_PIPELINE_MODE=OMNI_THEN_TEXT
```

可选值：

- `OMNI_THEN_TEXT`：推荐默认值；Omni 理解视频和音频，Qwen3.7 生成结构化文案；
- `VISION_DIRECT`：直接由支持视频输入的 Qwen3.7 模型理解带字幕视频并返回结构化结果，调用次数少，但不以音频内容作为主要依据；
- `MOCK`：测试环境返回固定样例，不调用在线模型。

由于当前视频都带字幕，`VISION_DIRECT` 在样本测试达标后可以作为低成本方案；但正式第一版仍建议使用 `OMNI_THEN_TEXT`，避免字幕缺失、字幕闪现、旁白与字幕不一致时产生明显信息损失。

### 2.3 产品边界

第一期只生成一组通用内容：

```json
{
  "videoSummary": "视频内容摘要",
  "title": "不超过20字的标题",
  "body": "通用发布正文",
  "hashtags": ["标签1", "标签2"],
  "confirmedFacts": ["能够从视频确认的事实"],
  "uncertainFacts": ["无法确认、不得写入文案的内容"],
  "riskFlags": [],
  "confidence": 0.88
}
```

第一期不直接为抖音、小红书、视频号、B站、微博分别保存独立文案。原因是当前 `publish_tasks` 只保存一组 `title/body`；如果立即做平台独立文案，需要同步改造 `publish_targets`、各平台适配器、任务历史、重试、幂等和发布确认链路，影响范围明显扩大。

---

## 3. 当前代码现状

### 3.1 发布页

主要文件：`public/app.js`

当前发布表单已经存在：

- 本机素材路径：`#materialPath`；
- 标题：`#publishTitle`，最大长度为 20；
- 正文：`#publishBody`；
- 内容来源：`#contentOrigin`；
- 素材预检：`runPrecheck()`；
- AI 合规审核：`runCompliance()`；
- 发布提交：`submitPublish()`。

当前用户选择素材后调用 Local Agent `/pick-file`，得到的是本机文件路径，并非浏览器把文件直接上传到 Web 服务。素材变化后，页面已具备清空预检、预览和合规审核结果的处理逻辑，新功能应沿用这一安全习惯。

### 3.2 Local Agent

主要文件：`agent/local-agent.js`

现有相关路由包括：

- `/pick-file`：打开本机文件选择器；
- `/precheck`：执行文件格式、时长、尺寸、SHA-256 等检查；
- `/ocr`：从图片或视频代表帧识别文字；
- `/ai-review`：执行素材和文案合规审核。

Local Agent 已经能够从 Web 服务读取动态 AI 配置，并通过 `/api/agent/ai-usage` 上报模型调用记录，可以复用现有 Key 分发、调用审计和错误处理模式。

### 3.3 视频处理能力

主要文件：

- `agent/precheck.js`；
- `agent/material-ocr.js`；
- `agent/material-ai-review.js`。

现有能力包括：

- 使用 `ffprobe-static` 读取视频时长、尺寸、编码、码率、音轨等信息；
- 使用 `@ffmpeg-installer/ffmpeg` 抽取代表帧；
- 使用 `sharp` 压缩图片；
- 按素材 SHA-256 缓存；
- 相同输入请求 inflight 去重；
- 超时、失败和模型输出 JSON 归一化处理。

现有 OCR/审核仅抽取约 3～5 个代表帧，适合审核和局部 OCR，但不足以完整理解 2 分 30 秒视频中的全部字幕，因此不能直接把现有 `/ocr` 结果当作文案生成的完整输入。

### 3.4 Web 代理超时

`src/server.js` 中 `proxyLocalAgentJson()` 当前使用：

```javascript
AbortSignal.timeout(120_000)
```

视频转码、临时上传、Omni 理解、Qwen3.7 生成的总时长有可能超过 120 秒，因此新功能不能实现为一个从浏览器一直同步等待到结束的 HTTP 请求，必须使用异步任务状态机。

### 3.5 数据库与调用日志

主要文件：`src/db.js`

当前已有：

- `publish_tasks`：保存最终标题、正文和发布任务；
- `publish_targets`：保存各平台发布目标；
- `ai_call_logs`：保存模型、状态、Token、耗时和错误；
- `ensureColumn()` 与迁移机制。

建议为文案生成建立独立表，不把转码、上传、推理等中间状态直接塞进 `publish_tasks`。

---

## 4. 范围与非范围

### 4.1 第一阶段包含

- 视频素材预检成功后触发 AI 文案生成；
- 支持 MP4、MOV 等现有预检认可的视频；
- 理解画面、硬字幕、语音和环境声音；
- 自动生成一组通用标题、正文和标签；
- 自动填写空白字段；
- 用户已输入内容时禁止静默覆盖；
- 支持生成进度、取消、重试和页面恢复；
- AI 失败时允许用户继续手工填写；
- AI 生成后自动设置内容来源为 `AI_GENERATED`；
- AI 生成或文案变化后使旧合规审核失效；
- 临时视频安全上传、使用后删除；
- 调用日志、失败日志和缓存；
- Mock 测试模式。

### 4.2 第一阶段不包含

- 自动点击发布；
- AI 生成完成后绕过人工确认；
- 自动裁切发布原片；
- 自动修改发布素材；
- 每个平台保存独立标题和正文；
- 根据实时热点生成与视频无关的内容；
- 对视频中无法确认的人名、时间、地点、人数、政策或效果进行猜测；
- Kimi 或其他第二供应商接入；
- 用生成文案替代现有 AI 合规审核。

---

## 5. 目标业务流程

```text
1. 用户选择本地视频
   ↓
2. Local Agent执行现有预检并计算SHA-256
   ↓
3. 前端确认素材为视频且预检通过
   ↓
4. 创建“文案生成任务”，立即返回generationId
   ↓
5. Local Agent生成临时AI分析副本
   ↓
6. 上传到私有OSS临时目录
   ↓
7. qwen3.5-omni-plus理解视频并生成语义报告
   ↓
8. qwen3.7-plus生成并校验结构化文案
   ↓
9. 删除OSS对象和本地分析副本
   ↓
10. 前端轮询到COMPLETED
   ↓
11. 若标题/正文仍为空，自动填写；已有人工内容则提示确认
   ↓
12. 设置内容来源为AI_GENERATED
   ↓
13. 清空旧合规审核结果
   ↓
14. 用户检查/修改并执行现有AI合规审核
   ↓
15. 用户确认后创建发布任务
```

### 5.1 默认触发方式

推荐默认：

- 素材选择并预检成功后自动触发；
- 页面同时保留“AI 生成标题和文案”按钮；
- 系统设置中提供“选择视频后自动生成”开关；
- 自动触发只针对视频，不对图片自动触发；
- 用户点击取消后，本次素材不再自动重复触发，除非更换素材或手动点击重新生成。

---

## 6. 总体技术架构

```text
┌────────────────────┐
│ 发布页 public/app.js │
└─────────┬──────────┘
          │ 创建任务/轮询
          ▼
┌─────────────────────────────┐
│ Web服务 src/server.js        │
│ - 鉴权                       │
│ - generation持久化          │
│ - 状态查询                   │
│ - OSS短时上传会话            │
│ - Agent回调验签              │
└─────────┬───────────────────┘
          │ 本机任务入队
          ▼
┌────────────────────────────────────┐
│ Local Agent                         │
│ - 读取本机视频                      │
│ - FFmpeg生成压缩分析副本            │
│ - 直传私有OSS                        │
│ - 调用qwen3.5-omni-plus             │
│ - 调用qwen3.7-plus                  │
│ - 清理临时文件/OSS对象              │
│ - 回传进度与结果                    │
└───────────────┬────────────────────┘
                ▼
       ┌──────────────────┐
       │ 阿里云百炼 + OSS │
       └──────────────────┘
```

### 6.1 为什么任务状态由 Web 服务持久化

- 页面刷新或离开后仍能恢复任务；
- Local Agent 重启后可以识别未完成任务；
- 生成结果可以与最终发布任务建立审计关系；
- 避免只把状态保存在浏览器或 Agent 内存中；
- 便于统一重试、取消、超时和问题汇总。

### 6.2 为什么不直接复用当前平台 Job Worker

当前 Local Agent 的 Job 领取和执行逻辑与平台启停、平台账号、浏览器 Profile 和平台运行锁强绑定。文案生成不是平台发布操作，不应因某个平台暂停而无法执行，也不应占用发布 RPA 的互斥锁。

第一期建议为内容生成建立独立轻量 Worker；后续如果重构通用 Job 调度器，再统一并入基础任务框架。

---

## 7. 视频临时上传与隐私方案

### 7.1 必须调整现有产品口径

当前页面明确提示“素材留在 RPA 电脑”“原始文件不会上传”“视频仅抽取代表帧”。完整视频理解需要云端模型读取视频，因此启用本功能后必须调整提示，不能继续让用户误认为视频内容完全不会离开本机。

建议页面改为：

> 发布原片仍保留在 RPA 电脑。启用“AI 生成文案”时，系统会生成压缩分析副本并临时上传至阿里云，仅用于本次内容理解；任务完成或失败后自动删除。

这里强调的是“发布原片不上传”，但“压缩分析副本会临时上传”。

### 7.2 为什么不直接传本地路径

浏览器和云端模型无法读取 `D:\素材\video.mp4` 这样的本机路径。Node/OpenAI 兼容调用通常需要模型可以访问的 HTTPS URL 或 Base64 数据。2 分 30 秒视频不适合整段转 Base64，因此推荐私有 OSS + 短时签名 URL。

### 7.3 推荐上传链路

```text
Web服务持有OSS长期凭据
        ↓
Local Agent请求本次generation的短时上传会话
        ↓
Web服务签发指定对象名的短时PUT权限
        ↓
Local Agent直传压缩分析副本
        ↓
Web服务或Agent获取15～30分钟签名GET URL
        ↓
模型读取视频
        ↓
调用完成立即删除对象
        ↓
定时清理任务删除遗漏对象
```

禁止把 OSS 长期 AccessKey 放入浏览器。也不建议将长期 OSS 密钥散落到每台 Local Agent；优先由 Web 服务持有并签发最小权限、短时有效的 URL。

### 7.4 分析副本参数

建议初始配置：

```text
封装：MP4
视频：H.264
音频：AAC，64～96 kbps
分辨率：最长边不超过1280，建议720P
帧率：10～15 fps
视频码率：700～1500 kbps，按清晰度动态调整
最大时长：400秒
最大分析副本：60MB
```

处理原则：

1. 始终生成临时分析副本，避免上传发布原片；
2. 保留硬字幕清晰度；
3. 保留音频，供 Omni 理解旁白和环境声音；
4. 如果字幕区域较小，不能盲目把分辨率压得过低；
5. 转码后使用 `ffprobe` 再次验证时长、视频流和音轨；
6. 本地临时文件使用随机目录和任务 ID 命名；
7. 成功、失败、取消、进程恢复时都要清理。

### 7.5 OSS安全要求

- Bucket 必须为私有；
- 对象前缀建议为 `temporary-ai-materials/{deviceId}/{generationId}/`；
- PUT/GET 签名有效期建议 15～30 分钟；
- 对象名不得包含原始文件名、用户名或完整本机路径；
- OSS 生命周期规则作为兜底，建议 1 天内自动删除；
- 应用层完成调用后立即删除，不以生命周期规则代替主动清理；
- 日志不得打印完整签名 URL；
- 下载 URL 只允许本次任务使用；
- Web 服务签发前验证 generation、deviceId、SHA-256 和任务状态。

### 7.6 实施前置条件

百炼 API Key 不等于 OSS 上传权限。上线前还需准备：

- 私有 OSS Bucket；
- 仅限指定 Bucket/前缀的 RAM 权限；
- Web 服务可使用的 OSS 凭据或实例角色；
- Bucket 所在地域和百炼调用地域的网络可用性验证；
- 生命周期删除规则；
- 用户侧对“压缩分析副本临时上传”的确认。

---

## 8. 模型调用设计

### 8.1 第一步：视频理解

模型：

```env
QWEN_VIDEO_MODEL=qwen3.5-omni-plus
```

输入：

- 私有 OSS 短时签名视频 URL；
- 视频时长、分辨率、是否有音频；
- 明确要求同时参考画面、硬字幕、语音和环境声音；
- 禁止猜测无法确认的事实。

建议输出语义报告字段：

```json
{
  "theme": "视频主题",
  "sceneTimeline": [
    {
      "startSecond": 0,
      "endSecond": 12,
      "visual": "画面内容",
      "subtitle": "可确认字幕",
      "speech": "可确认语音含义"
    }
  ],
  "keyPoints": [],
  "entities": [],
  "confirmedFacts": [],
  "uncertainFacts": [],
  "safetyNotes": [],
  "recommendedAngle": "建议文案角度"
}
```

即使模型没有严格按 JSON 返回，也先保存原始文本，再由第二步模型做结构化归一化。

### 8.2 第二步：文案生成

模型：

```env
QWEN_CONTENT_MODEL=qwen3.7-plus
```

输入：

- 第一步语义报告；
- 现有标题最大 20 字约束；
- 当前选择的平台列表；
- 通用内容规范；
- 禁止出现测试、RPA、发布后删除等内部字样；
- 禁止使用 `uncertainFacts`；
- 要求严格 JSON。

输出：

```json
{
  "videoSummary": "",
  "title": "",
  "body": "",
  "hashtags": [],
  "confirmedFacts": [],
  "uncertainFacts": [],
  "riskFlags": [],
  "confidence": 0
}
```

### 8.3 服务端校验

模型输出不得直接信任，必须执行以下校验：

- `title`、`body` 必须为字符串；
- 标题去除换行并限制为 20 字以内；
- 正文不能为空，超长时按配置限制；
- `hashtags` 去重、去空值、限制数量；
- `confidence` 归一化到 0～1；
- 去除 Markdown 代码围栏；
- 禁止危险占位词和内部测试词；
- 输出无法解析时，允许 Qwen3.7 执行 1 次 JSON 修复；
- 第二次仍失败则任务进入 `FAILED`，不得把半成品写入表单。

### 8.4 事实约束

提示词和结果校验必须明确：

- 只能写入视频中可确认的内容；
- 不得推断未展示的时间、地点、姓名、单位、人数和政策；
- 不得夸大活动效果、服务成效、优惠、承诺或荣誉；
- 字幕与语音冲突时标记风险，不自行决定哪一个正确；
- 涉及未成年人、个人信息、车牌、手机号、住址时标记风险；
- 置信度过低时只生成保守文案，并提示人工核对。

### 8.5 缓存键

建议缓存键：

```text
SHA256(
  materialSha256
  + pipelineMode
  + videoModel
  + contentModel
  + generationRuleVersion
  + selectedPlatformCodes
)
```

同一素材、同一模型、同一规则和同一平台集合重复生成时可以复用结果。用户点击“换一个写法”时增加 `variantSeed`，避免命中完全相同的结果。

---

## 9. 异步任务与接口设计

### 9.1 前端调用 Web 服务

#### 创建任务

```http
POST /api/material-content-generations
```

请求：

```json
{
  "materialPath": "D:\\素材\\video.mp4",
  "materialSha256": "...",
  "precheck": {},
  "platformCodes": ["douyin", "bilibili"],
  "force": false
}
```

响应必须快速返回：

```json
{
  "generation": {
    "id": 123,
    "status": "QUEUED",
    "stage": "QUEUED",
    "progress": 0
  }
}
```

#### 查询任务

```http
GET /api/material-content-generations/:id
```

#### 取消任务

```http
POST /api/material-content-generations/:id/cancel
```

#### 重试任务

```http
POST /api/material-content-generations/:id/retry
```

### 9.2 Web 服务调用 Local Agent

#### 入队

```http
POST /content-generation/jobs
```

只负责校验并放入 Agent 的独立任务队列，应在数秒内返回，不同步等待模型完成。

#### 取消

```http
POST /content-generation/jobs/:id/cancel
```

#### Agent 状态诊断

```http
GET /content-generation/jobs/:id
```

### 9.3 Agent 回调 Web 服务

```http
POST /api/agent/material-content-generations/:id/progress
POST /api/agent/material-content-generations/:id/complete
POST /api/agent/material-content-generations/:id/fail
POST /api/agent/material-content-generations/:id/cleanup
```

回调沿用 Agent Token 鉴权，并验证任务必须属于当前 `deviceId`。

### 9.4 状态机

```text
QUEUED
  ↓
PREPARING
  ↓
UPLOADING
  ↓
ANALYZING_VIDEO
  ↓
GENERATING_COPY
  ↓
VALIDATING
  ↓
CLEANING_UP
  ↓
COMPLETED
```

终止状态：

```text
FAILED
CANCELLED
EXPIRED
```

建议进度映射：

| 阶段 | 进度建议 | 前端提示 |
|---|---:|---|
| QUEUED | 0～5% | 等待处理 |
| PREPARING | 5～25% | 正在生成 AI 分析副本 |
| UPLOADING | 25～45% | 正在安全上传分析副本 |
| ANALYZING_VIDEO | 45～75% | AI 正在理解视频内容 |
| GENERATING_COPY | 75～90% | 正在生成标题和正文 |
| VALIDATING | 90～95% | 正在校验生成结果 |
| CLEANING_UP | 95～99% | 正在清理临时文件 |
| COMPLETED | 100% | 已生成并可填写 |

进度是阶段性估算，不能伪装成模型内部的精确进度。

### 9.5 幂等与并发

- 相同缓存键存在 `QUEUED`～`CLEANING_UP` 任务时，重复点击返回原任务；
- 同一素材 SHA 只允许一个同参数 inflight 任务；
- 更换素材后立即取消旧任务；
- 旧任务即使晚到完成，也不得覆盖当前素材；
- 完成结果必须同时匹配 `generationId + materialSha256 + inputHash`；
- 用户点击重新生成时可以复用视频理解报告，只重新调用文案生成模型；
- 取消任务应中止 FFmpeg、上传和模型请求，并执行清理；
- Agent 重启后，Web 服务将长时间停留在执行态的任务标记为可恢复或失败，并允许重新派发。

---

## 10. 数据库设计

建议新增表：

```sql
CREATE TABLE IF NOT EXISTS material_content_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  material_sha256 TEXT NOT NULL,
  material_path_snapshot TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generation_rule_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  stage TEXT NOT NULL DEFAULT 'QUEUED',
  progress INTEGER NOT NULL DEFAULT 0,
  pipeline_mode TEXT NOT NULL,
  video_model TEXT,
  content_model TEXT,
  platform_codes_json TEXT NOT NULL DEFAULT '[]',
  video_summary_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  cleanup_status TEXT,
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_material_content_generation_status
ON material_content_generations(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_material_content_generation_sha
ON material_content_generations(material_sha256, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_material_content_generation_inflight
ON material_content_generations(input_hash)
WHERE status IN ('QUEUED','PREPARING','UPLOADING','ANALYZING_VIDEO','GENERATING_COPY','VALIDATING','CLEANING_UP');
```

可选增加：

```sql
ALTER TABLE publish_tasks ADD COLUMN content_generation_id INTEGER;
```

作用是把最终发布内容追溯到生成任务。若希望第一期最小改动，也可以先把 `contentGenerationId` 写入现有 `material_meta`，第二期再独立成列。

### 10.1 数据保留

- `result_json` 和摘要可保留用于审计；
- 不保存视频文件和签名 URL；
- `material_path_snapshot` 不在普通日志和前端列表中展示；
- 失败信息应脱敏；
- 建议生成任务记录保留 90 天，具体按项目数据政策确定；
- OSS 分析副本任务完成即删除，最长不超过生命周期兜底时间。

---

## 11. 前端交互设计

### 11.1 新增状态

在 `public/app.js` 的全局状态中增加：

```javascript
state.contentGeneration = {
  jobId: null,
  status: 'IDLE',
  stage: null,
  progress: 0,
  materialSha256: null,
  inputHash: null,
  result: null,
  error: null,
  titleDirty: false,
  bodyDirty: false,
  autoTriggerSuppressed: false
};
```

### 11.2 新增界面元素

建议放在素材状态和标题字段之间：

- “AI 生成标题和文案”按钮；
- “选择视频后自动生成”开关；
- 生成状态条；
- 当前阶段说明；
- “取消”按钮；
- “重新生成”按钮；
- 生成结果摘要和风险提示；
- 隐私提示：将临时上传压缩分析副本。

### 11.3 字段覆盖规则

必须遵循：

1. 标题和正文均为空：自动填写；
2. 只有一个字段为空：只填写空字段；
3. 字段已有人工内容：不得静默覆盖；
4. 用户确认“使用 AI 结果覆盖”后才覆盖；
5. 任务开始后用户又输入了内容，即使任务完成也不能覆盖；
6. 可以提供“复制标题”“复制正文”供用户手工选择；
7. AI 内容写入后自动将 `#contentOrigin` 设为 `AI_GENERATED`；
8. AI 结果写入后调用现有 `invalidateCompliance()`；
9. 用户修改 AI 文案后仍属于包含 AI 生成内容，不自动改回真人原创。

### 11.4 页面恢复

- `generationId` 与当前素材 SHA 保存到页面状态和短期本地存储；
- 重新进入发布页时，如果素材路径和 SHA 仍匹配，则恢复轮询；
- 如果素材文件不存在或 SHA 已变化，放弃旧结果；
- 页面离开不自动取消任务；
- 页面关闭后任务可以继续，用户再次进入时可读取结果。

### 11.5 和合规审核的关系

AI 生成文案不是 AI 合规审核。正确顺序必须是：

```text
AI生成文案 → 用户确认/修改 → AI合规审核 → 发布
```

下列事件必须使已有合规结果失效：

- 新生成文案写入；
- 用户修改标题或正文；
- 更换素材；
- 素材 SHA 变化；
- 更换目标平台；
- 使用另一条生成结果覆盖。

---

## 12. 配置设计

建议在 `src/config.js` 和 AI 设置中新增：

```env
AI_CONTENT_GENERATION_ENABLED=true
AI_CONTENT_AUTO_TRIGGER=true
AI_VIDEO_PIPELINE_MODE=OMNI_THEN_TEXT
QWEN_VIDEO_MODEL=qwen3.5-omni-plus
QWEN_CONTENT_MODEL=qwen3.7-plus
AI_CONTENT_TIMEOUT_MS=180000
AI_VIDEO_MAX_DURATION_SECONDS=400
AI_VIDEO_ANALYSIS_MAX_BYTES=62914560
AI_VIDEO_URL_TTL_SECONDS=1800
AI_CONTENT_CACHE_MAX_AGE_MS=604800000
AI_CONTENT_MAX_RETRIES=1
AI_CONTENT_RULE_VERSION=content-generation-2026.08.24.1
```

OSS 配置：

```env
OSS_REGION=
OSS_BUCKET=
OSS_ENDPOINT=
OSS_ACCESS_KEY_ID=
OSS_ACCESS_KEY_SECRET=
OSS_AI_PREFIX=temporary-ai-materials/
OSS_AI_LIFECYCLE_DAYS=1
```

更安全的生产环境可使用 RAM 角色或密钥管理服务，不把长期密钥写入普通配置文件。

### 12.1 设置页调整

当前 AI 设置只有通用文本模型和视觉/OCR 模型。建议新增：

- 视频理解模型；
- 文案生成模型；
- 视频文案功能开关；
- 自动触发开关；
- 分析副本临时上传说明；
- “测试视频模型连接”按钮；
- 不展示完整 API Key 和 OSS 密钥。

---

## 13. 异常与降级设计

| 异常 | 系统行为 |
|---|---|
| 非视频素材 | 不自动触发视频文案，可保留手工填写 |
| 视频预检失败 | 不创建生成任务，显示预检错误 |
| 视频超过最大时长 | 提示用户手工填写或更换素材 |
| FFmpeg 转码失败 | 标记 `PREPARE_FAILED`，允许重试 |
| 分析副本超过 60MB | 降低码率重试一次，仍超限则失败 |
| OSS 上传失败 | 标记 `UPLOAD_FAILED`，保留手工流程 |
| 签名 URL 过期 | 重新签发一次，不重复转码 |
| Omni 超时 | 取消在线请求，清理临时对象，允许重试 |
| Omni 输出为空 | 标记 `VIDEO_ANALYSIS_EMPTY` |
| Qwen3.7 JSON 无效 | 执行一次修复提示；仍失败则失败 |
| OSS 删除失败 | 主任务可完成，但记录 `cleanup_status=PENDING` 并加入清理队列 |
| 用户更换素材 | 取消旧任务，旧结果失效 |
| 用户已修改文案 | 结果只展示，不自动覆盖 |
| 页面刷新 | 从 Web 服务恢复任务状态 |
| Agent 重启 | 根据 Web 持久化任务进行恢复或安全失败 |
| AI 服务不可用 | 不阻塞手工填写、合规审核和发布 |
| Mock 模式 | 返回固定安全样例，不产生在线费用 |

### 13.1 降级优先级

```text
完整Omni视频理解
   ↓ 失败
重试一次（复用分析副本）
   ↓ 仍失败
可选：使用视频代表帧/OCR摘要生成保守文案
   ↓ 仍失败
提示用户手工填写
```

代表帧/OCR 降级结果必须明显提示“内容可能不完整”，不能让用户误认为已完整理解视频。

---

## 14. 性能与耗时目标

以 2 分 30 秒、带字幕、普通 1080P 视频为例，建议按以下区间评估：

| 阶段 | 常见耗时 |
|---|---:|
| 现有预检与 SHA-256 | 1～5 秒 |
| 生成 720P 分析副本 | 8～30 秒 |
| 上传 20～60MB 副本 | 5～30 秒 |
| qwen3.5-omni-plus 理解 | 15～50 秒 |
| qwen3.7-plus 生成文案 | 3～12 秒 |
| 校验与清理 | 1～5 秒 |
| **总计** | **常见约 40～120 秒** |

建议产品指标：

```text
P50：不超过75秒
P95：不超过180秒
单任务软超时：180秒
总任务硬超时：240秒
```

上述时间不是固定 SLA。实际耗时受原视频编码、RPA 电脑 CPU、网络上行、OSS 地域、模型高峰和重试影响。第一版页面应显示阶段而不是承诺精确倒计时。

### 14.1 性能优化顺序

1. 永远只上传压缩分析副本；
2. 同 SHA 和相同规则复用视频理解报告；
3. “换一个写法”只重跑 Qwen3.7，不重跑 Omni；
4. 上传和模型调用设置独立超时；
5. 根据网络速度动态选择码率；
6. 用真实 2 分 30 秒样本统计 P50/P95；
7. 样本验证通过后，评估 `VISION_DIRECT` 单模型模式。

---

## 15. AI调用审计

复用现有 `ai_call_logs`，增加任务类型：

```text
VIDEO_CONTENT_UNDERSTANDING
MATERIAL_COPY_GENERATION
MATERIAL_COPY_REPAIR
```

记录：

- generationId；
- 模型名；
- pipeline mode；
- 成功/失败；
- 输入、输出、总 Token（接口可返回时）；
- 调用耗时；
- 错误码；
- 是否缓存命中；
- 规则版本。

禁止记录：

- API Key；
- OSS AccessKey；
- 完整签名 URL；
- 完整本机路径；
- 整段视频内容；
- 无脱敏的个人信息。

---

## 16. 文件改动清单

### 16.1 建议新增

```text
agent/material-content-generation.js
agent/material-analysis-video.js
agent/temporary-video-upload.js
src/services/material-content-generation.js
src/services/material-content-schema.js
src/services/temporary-material-storage.js
test/material-content-generation.test.js
test/material-content-generation-api.test.js
test/material-content-generation-recovery.test.js
test/material-content-generation-ui.test.js
```

职责建议：

- `material-content-generation.js`：Agent 任务编排、模型调用、取消和清理；
- `material-analysis-video.js`：FFmpeg 转码和分析副本验证；
- `temporary-video-upload.js`：短时上传、签名 URL 和删除；
- `material-content-generation.js`（Web service）：数据库状态机、幂等、权限和结果查询；
- `material-content-schema.js`：JSON 解析、字段归一化和安全校验；
- `temporary-material-storage.js`：Web 侧 OSS 签名和清理队列。

### 16.2 建议修改

```text
public/app.js
public/styles.css
agent/local-agent.js
src/server.js
src/config.js
src/services/settings.js
src/db.js
package.json
.env.example（如项目存在）
```

说明：

- `package.json` 需要增加官方或成熟的 OSS SDK；
- 不把生成功能塞进 `agent/material-ai-review.js`，保持“生成”和“审核”职责隔离；
- 不大幅改写现有发布链路，只在填表前增加可选生成步骤；
- 修改前需要保护当前工作区其他未提交改动，按文件和代码块小步提交。

---

## 17. 分阶段实施计划

### 阶段 0：前置确认与样本准备（0.5～1 人日）

- 确认接受临时上传压缩分析副本；
- 准备私有 OSS 和 RAM 最小权限；
- 收集至少 20 条真实视频样本；
- 样本覆盖字幕大小、横竖屏、无音轨、方言、快切、低清晰度等情况；
- 确认第一版只生成一组通用文案；
- 明确标题 20 字和正文风格规范。

交付物：账号/权限准备清单、样本清单、内容规范。

### 阶段 1：数据表、配置与异步任务骨架（1～1.5 人日）

- 增加 generation 表和索引；
- 增加配置项和设置读取；
- 增加创建、查询、取消、重试接口；
- 建立状态机和 inputHash 幂等；
- 增加 Mock 模式；
- 增加 Agent 回调鉴权。

交付物：不调用真实视频模型也能完整跑通的异步任务。

### 阶段 2：视频分析副本与 OSS（1.5～2 人日）

- FFmpeg 转码；
- 转码后复检；
- 私有 OSS 短时上传；
- 签名 GET URL；
- 成功/失败/取消清理；
- 定时清理遗漏对象；
- 上传进度和超时。

交付物：可安全产生、上传和删除分析副本。

### 阶段 3：模型调用与结果校验（1～1.5 人日）

- 接入 `qwen3.5-omni-plus`；
- 生成视频语义报告；
- 接入 `qwen3.7-plus`；
- JSON 校验、修复和归一化；
- 缓存、inflight 去重和 AI 调用日志；
- 事实与风险约束。

交付物：给定视频可得到稳定结果 JSON。

### 阶段 4：发布页交互（1～1.5 人日）

- 增加生成按钮、自动触发开关和进度；
- 自动填写空字段；
- 人工内容覆盖保护；
- 设置 `AI_GENERATED`；
- 使旧合规审核失效；
- 页面恢复、取消和重新生成；
- 修改隐私提示。

交付物：从选择视频到填入标题/正文的完整界面流程。

### 阶段 5：测试、压测与上线准备（1.5～2 人日）

- 自动化测试；
- 20～50 条真实样本评测；
- 统计 P50/P95；
- 检查事实错误率和字幕覆盖；
- 验证 OSS 清理；
- 验证 Agent/Web 重启恢复；
- 灰度开关、监控和回滚演练。

交付物：测试报告、性能数据、上线检查表。

### 17.1 总体工作量估算

在一名熟悉当前代码的开发人员执行、OSS 权限及时到位的情况下：

```text
开发与联调：约 6～9 人日
测试与样本验收：约 2～3 人日
总计：约 8～12 人日
```

如果第一版改为单模型 `VISION_DIRECT`，可能减少约 1～2 人日，但仍需要异步任务、视频临时上传、前端覆盖保护、合规失效和清理机制，不能只按“一次接口调用”估算。

---

## 18. 测试清单

### 18.1 正常场景

- 2 分 30 秒、1080P、带硬字幕和音轨的视频；
- 横屏和竖屏；
- 中文普通话；
- 有字幕但无音轨；
- 有音轨但字幕较少；
- 标题和正文均为空时自动填写；
- 只为空字段时仅填写空字段；
- 重新生成只改变文案，不重复理解视频；
- 生成后内容来源自动为 `AI_GENERATED`；
- 生成后旧合规审核失效。

### 18.2 幂等与数据一致性

- 同一视频连续点击两次；
- 同一 SHA 的同规则任务复用；
- 更换视频后旧结果晚到；
- 素材路径相同但文件内容变化；
- 页面刷新后恢复；
- 页面离开后再进入；
- Web 服务重启；
- Local Agent 重启；
- 用户在等待过程中修改标题；
- 用户修改正文后旧结果完成。

### 18.3 失败与清理

- FFmpeg 不存在或执行失败；
- 临时磁盘空间不足；
- OSS PUT 超时；
- OSS GET URL 失效；
- Omni 429/5xx/超时；
- Qwen3.7 429/5xx/超时；
- 模型返回 Markdown 而不是 JSON；
- 模型返回空标题；
- 标题超过 20 字；
- OSS 删除失败；
- 用户取消时正在转码；
- 用户取消时正在上传；
- 用户取消时正在模型调用；
- AI 失败后仍可手工填写和继续发布。

### 18.4 安全与合规

- 普通用户不能查询他人 generation；
- Agent 不能回调不属于本设备的 generation；
- 日志无完整签名 URL、Key 和本机路径；
- OSS 对象无法匿名访问；
- URL 过期后不可访问；
- 生命周期可删除遗漏对象；
- AI 结果不能直接触发发布；
- 未重新执行合规审核时不能沿用旧审核结果；
- 模型不得把不确定事实写入正文；
- 内容来源声明不能被自动设置为真人原创。

---

## 19. 上线方案

### 19.1 灰度步骤

1. 先在 `MOCK` 模式完成全流程；
2. 测试环境用 5 条视频验证在线模型和 OSS；
3. 内部账号灰度，默认关闭自动触发，只允许手动点击；
4. 达到质量和清理要求后，对部分运营账号开启自动触发；
5. 收集一周的耗时、失败率、重试率、人工覆盖率和事实错误反馈；
6. 指标稳定后再默认开启。

### 19.2 建议监控指标

- 任务创建量；
- `COMPLETED/FAILED/CANCELLED` 比例；
- 各阶段平均/P50/P95 耗时；
- 转码失败率；
- OSS 上传失败率；
- Omni 调用成功率；
- Qwen3.7 输出修复率；
- 缓存命中率；
- 生成后人工覆盖率；
- 低置信度比例；
- OSS 清理积压量；
- 单视频平均调用成本。

### 19.3 回滚

出现异常时：

```env
AI_CONTENT_GENERATION_ENABLED=false
AI_CONTENT_AUTO_TRIGGER=false
```

关闭后：

- 发布页恢复现有人工填表流程；
- 不影响素材预检、AI 合规审核和发布；
- 已创建的生成任务安全取消；
- 清理任务继续执行；
- 不删除 generation 历史表，以便排查；
- 无需回滚已有 `publish_tasks` 数据。

---

## 20. 验收标准

### 20.1 功能验收

- 选择合规视频后可自动或手动创建文案生成任务；
- 任务过程有明确阶段和失败提示；
- 2 分 30 秒带字幕视频可生成可读标题和正文；
- 标题不超过 20 字；
- 不覆盖用户等待过程中输入的内容；
- AI 生成后内容来源为 `AI_GENERATED`；
- AI 生成后旧合规审核失效；
- AI 失败不阻塞人工发布流程；
- 刷新或离开页面后可恢复任务；
- 更换素材后旧结果无法写入新素材表单；
- 生成结果不能自动发布。

### 20.2 性能验收

在约 20～60MB 的 2 分 30 秒分析副本测试集上：

- P50 不超过 75 秒；
- P95 不超过 180 秒；
- 超时有明确错误和重试入口；
- 重复生成同一风格时可复用视频理解结果。

若实际环境因网络或模型高峰无法达到，应以真实数据调整产品提示，不能通过隐藏等待阶段通过验收。

### 20.3 安全验收

- 发布原片不上传；
- 分析副本位于私有 OSS；
- 签名 URL 短时有效；
- 成功、失败和取消后均触发删除；
- 有生命周期兜底；
- 日志无敏感凭据和完整 URL；
- 运营页面明确提示临时上传行为。

### 20.4 内容质量验收

建议由运营人员对至少 50 条视频进行盲评：

- 主题判断正确率；
- 关键字幕覆盖率；
- 标题可用率；
- 正文可用率；
- 事实错误率；
- 人工大幅重写比例；
- 风险内容漏检比例。

建议上线门槛：

- 不得出现明显编造事实；
- 标题和正文总体可用率达到项目方确认的阈值；
- 低置信度视频能够提示人工核对；
- 不因文案生成绕过现有合规审核。

---

## 21. 风险与待确认项

### 21.1 必须确认

1. 是否接受把“压缩分析副本”临时上传阿里云；
2. 是否已经具备私有 OSS Bucket 和 RAM 权限；
3. 第一版是否确认只生成一组通用文案；
4. 是否默认选择视频后自动触发；
5. 已有人工标题/正文时是否按“弹窗确认后才覆盖”执行；
6. 生成文案的期望风格、正文长度和标签数量；
7. 视频最大允许时长；
8. 生成任务历史和摘要保留时间。

### 21.2 推荐默认决策

```text
模型链路：qwen3.5-omni-plus → qwen3.7-plus
第一版内容：一组通用标题和正文
触发：预检成功后自动触发，同时保留手动按钮
覆盖：只自动填写空字段，人工内容必须确认后才能覆盖
隐私：上传压缩分析副本，发布原片不上传
存储：私有OSS，15～30分钟签名，任务结束立即删除
审核：生成后必须重新执行现有AI合规审核
发布：绝不自动触发
```

---

## 22. 官方参考

- Qwen3.5-Omni-Plus：<https://help.aliyun.com/zh/model-studio/qwen3-5-omni-plus>
- 千问视觉理解与视频输入：<https://help.aliyun.com/zh/model-studio/vision>
- 百炼模型列表：<https://help.aliyun.com/zh/model-studio/models>
- 百炼 API Key：<https://help.aliyun.com/zh/model-studio/get-api-key>
- 阿里云 OSS 文档：<https://help.aliyun.com/zh/oss/>

> 模型能力、价格、地域和接口限制可能调整。正式开发开始前应在当前百炼控制台使用现有 Key 执行一次 `qwen3.5-omni-plus` 与 `qwen3.7-plus` 连通性测试，并以届时官方文档和实际 API 返回为准。

---

## 23. 最终建议

本功能可以落地，且当前千问 Key 足以支撑第一版，不需要接 Kimi。真正的工程重点不在“让模型写一句文案”，而在以下四点：

1. **视频如何安全交给云端模型**：压缩分析副本、私有 OSS、短时签名、立即删除；
2. **长任务如何可靠执行**：异步状态机、页面恢复、取消、重试和 Agent 重启恢复；
3. **AI 结果如何安全写入表单**：不覆盖人工内容、素材 SHA 绑定、内容来源声明和合规失效；
4. **如何控制事实风险**：视频语义报告、结构化生成、服务端校验和人工确认。

建议按“Mock 全流程 → OSS 与视频分析 → 双模型生成 → 发布页接入 → 灰度评测”的顺序实施，不建议直接在现有 `/ai-review` 路由中同步调用视频模型。

