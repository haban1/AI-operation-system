# 视频音频驱动 AI 自动生成发布文案执行方案 V1.1

> 文档日期：2026-08-24  
> 适用项目：天河 AI 数字员工运营平台  
> 需求范围：只根据视频中的音频生成标题和正文  
> 替代文档：`视频上传后AI自动生成发布文案执行方案-V1.0.md`

---

## 1. 需求调整

最新需求已收敛为：

1. 用户选择本地视频；
2. 系统只提取视频中的音频，不分析视频画面，也不识别画面硬字幕；
3. AI 将音频转写为文字；
4. AI 根据转写文字生成标题和正文；
5. 自动填写发布页现有的标题、正文；
6. 用户确认或修改后，继续执行现有 AI 合规审核和发布流程。

因此，原方案中的以下内容不再需要：

- 不需要把视频压缩副本上传 OSS；
- 不需要让多模态模型读取整段视频；
- 不需要分析视频画面；
- 不需要识别画面硬字幕；
- 不需要 `qwen3.5-omni-plus` 作为默认模型；
- 不需要新增 OSS Bucket、RAM 权限、签名 URL 和视频清理任务；
- 第一版不需要建立复杂的长视频异步任务状态机。

新方案明显更简单、速度更快、成本更低，也更符合当前“只根据音频生成”的实际需求。

---

## 2. 推荐方案结论

### 2.1 推荐模型链路

```text
本地视频
  ↓
Local Agent 使用 FFmpeg 提取音频
  ↓
qwen3-asr-flash 将音频转写成文字
  ↓
qwen3.7-plus 根据转写文字生成结构化标题和正文
  ↓
自动填写发布页空白字段
  ↓
用户确认或修改
  ↓
重新执行现有 AI 合规审核
  ↓
发布
```

推荐配置：

```env
QWEN_ASR_MODEL=qwen3-asr-flash
QWEN_CONTENT_MODEL=qwen3.7-plus
```

### 2.2 为什么不再使用 Qwen3.5-Omni 作为默认方案

`qwen3.5-omni-plus` 可以处理音频，但当前需求只需要语音内容，不需要视频画面和环境视觉信息。直接使用 Omni 会带来以下额外成本：

- 模型能力超出实际需求；
- 输入处理和推理时间更长；
- 调试结果时不容易区分“语音理解”和“文案生成”；
- 不利于保留明确的音频转写文本作为审计依据；
- 后续出现文案错误时，不容易判断是转写错误还是生成错误。

采用“ASR 转写 + 文本模型生成”的两段式处理更容易测试、缓存、重试和排查。

### 2.3 可选模型

如果后续验证新版本音频模型在当前百炼账号和接口中表现更好，可以将 ASR 模型配置化替换，例如：

```env
QWEN_ASR_MODEL=qwen-audio-3.0-asr-flash
```

但第一版建议先使用接口成熟、OpenAI 兼容调用较直接的 `qwen3-asr-flash`，上线前用现有 Key 做一次真实音频连通性测试。

---

## 3. 隐私和数据传输变化

### 3.1 不上传视频原片

新方案不会把视频文件或视频画面传给云端模型。

处理方式：

```text
Local Agent读取本地视频
  ↓
本地FFmpeg提取临时音频
  ↓
只把临时音频发送给语音识别模型
  ↓
调用完成后删除临时音频
```

因此可以继续声明“视频原片不会上传”，但需要补充说明音频会发送给千问处理。

建议页面提示改为：

> 视频原片和画面不会上传。启用 AI 生成文案时，系统会在本机临时提取视频音频，并将音频发送给千问用于语音转写和文案生成；处理完成后自动删除本地临时音频。

### 3.2 不再需要 OSS

2 分 30 秒视频提取为单声道、16kHz、48kbps 的 MP3/AAC 后，通常只有约 1MB 左右，适合直接以 Base64 或接口支持的音频内容提交给模型。

第一版不需要：

- OSS Bucket；
- OSS AccessKey；
- RAM 上传权限；
- PUT/GET 签名 URL；
- OSS 生命周期；
- 远程视频删除任务。

这会显著减少安全配置和运维工作。

---

## 4. 当前代码可复用能力

### 4.1 发布页面

文件：`public/app.js`

可复用：

- `renderPublish()`；
- `#materialPath`；
- `#publishTitle`；
- `#publishBody`；
- `#contentOrigin`；
- `runPrecheck()`；
- `runCompliance()`；
- `invalidateCompliance()`；
- 素材变化后清空预检和审核结果的现有逻辑。

### 4.2 素材预检

文件：`agent/precheck.js`

现有 `ffprobe-static` 已能获取：

- 素材类型；
- 视频时长；
- 视频编码；
- 是否包含音轨；
- SHA-256；
- 文件大小等。

新功能应在调用 AI 前确认：

```text
meta.type === 'video'
meta.hasAudio === true
meta.durationSeconds <= 配置上限
meta.sha256 非空
```

没有音轨的视频不调用 AI，直接提示用户手工填写。

### 4.3 FFmpeg

文件：`agent/material-ocr.js`

项目已经依赖：

```text
@ffmpeg-installer/ffmpeg
```

可以复用相同的 FFmpeg 路径和 `execFile` 调用模式，但音频提取逻辑应放入独立文件，避免把文案生成功能塞进 OCR 服务。

### 4.4 AI 配置和调用日志

可复用：

- `GET /api/agent/settings/ai`；
- `POST /api/agent/ai-usage`；
- 现有百炼 Base URL；
- 现有百炼 Key；
- `ai_call_logs`；
- 现有超时、JSON 提取和错误归一化写法。

---

## 5. 目标业务流程

```text
1. 用户选择本地视频
   ↓
2. 执行现有素材预检
   ↓
3. 检查视频是否有音轨
   ↓
4. 自动或手动点击“AI生成标题和文案”
   ↓
5. Local Agent本地提取临时音频
   ↓
6. qwen3-asr-flash转写音频
   ↓
7. 清洗和校验转写结果
   ↓
8. qwen3.7-plus生成标题、正文和标签
   ↓
9. 校验结构化JSON
   ↓
10. 删除本地临时音频
   ↓
11. 自动填写空白标题和正文
   ↓
12. 设置内容来源为AI_GENERATED
   ↓
13. 清空已有合规审核结果
   ↓
14. 用户检查或修改
   ↓
15. 执行现有AI合规审核
   ↓
16. 用户确认并发布
```

---

## 6. 音频提取设计

### 6.1 推荐格式

建议使用 MP3：

```text
格式：MP3
采样率：16000 Hz
声道：单声道
码率：48 kbps
只保留音频，不保留视频流
```

建议 FFmpeg 参数：

```text
-y
-i <videoPath>
-vn
-ac 1
-ar 16000
-b:a 48k
-f mp3
<temporaryAudioPath>
```

对应命令示意：

```bash
ffmpeg -y -i input.mp4 -vn -ac 1 -ar 16000 -b:a 48k -f mp3 output.mp3
```

Node 中必须使用 `execFile()` 参数数组，不拼接 Shell 字符串，避免路径中的空格、中文和特殊字符造成注入或执行失败。

### 6.2 临时目录

建议：

```text
系统临时目录/
  tianhe-ai-content-generation/
    {generationId}/
      audio.mp3
```

要求：

- 目录名使用随机任务 ID；
- 不使用原始视频文件名；
- 提取成功、失败、超时和取消都必须删除；
- Agent 启动时清理超过 1 小时的遗留临时目录；
- 日志不记录完整本机视频路径；
- 删除只允许发生在系统临时目录内，必须校验解析后的绝对路径。

### 6.3 音频大小

按 48kbps 估算：

```text
150秒 × 48kbps ÷ 8 ≈ 0.9MB
```

Base64 后约增加三分之一，通常仍在约 1.2MB 左右，适合直接提交，无需对象存储。

### 6.4 音频有效性检查

提取完成后再次检查：

- 文件存在；
- 文件大小大于最小阈值；
- 音频时长与原视频基本一致；
- 非全程静音；
- 文件大小不超过模型和系统配置上限。

如果视频有音轨但全程无有效人声，任务返回：

```text
NO_SPEECH_DETECTED
```

前端提示：

> 视频中未识别到足够的有效语音，暂时无法根据音频生成文案，请手工填写或更换视频。

---

## 7. 语音转写设计

### 7.1 ASR 请求

模型：

```text
qwen3-asr-flash
```

输入：

- 提取后的 MP3 音频；
- Base64 Data URL，或模型接口支持的音频字段；
- 可选语言提示：中文；
- 要求只转写，不总结、不改写、不补充。

建议系统提示：

```text
请准确转写音频中的可辨识语音。
不要根据常识补充未听清的内容。
无法确认的词使用[听不清]标记。
保留专有名词、数字、时间和地点原始表达。
只输出转写文本，不生成标题或文案。
```

### 7.2 转写结果结构

统一归一化为：

```json
{
  "transcript": "完整转写文本",
  "language": "zh",
  "durationSeconds": 150,
  "segments": [],
  "unclearCount": 0,
  "confidence": null
}
```

如果接口不返回分段时间戳，`segments` 可以为空，不影响第一版文案生成。

### 7.3 转写文本清洗

只能做安全清洗：

- 去除重复空白；
- 合并明显重复的连续句子；
- 去除无意义的连续语气词，但不改变事实；
- 保留数字、日期、地点、姓名和单位原文；
- 保留 `[听不清]` 标记；
- 不用语言模型在转写阶段猜测缺失词。

### 7.4 转写失败条件

- 返回空文本；
- 文本过短且视频时长较长；
- `[听不清]` 比例过高；
- 请求超时；
- 音频格式无效；
- 文件超过限制；
- API 返回权限或模型不可用错误。

转写失败后不继续生成文案，避免根据不完整输入编造内容。

---

## 8. 标题与正文生成设计

### 8.1 模型

```text
qwen3.7-plus
```

输入只包含：

- 清洗后的音频转写文本；
- 已选平台列表；
- 标题长度约束；
- 正文风格要求；
- 内容安全规则。

不传视频、不传视频画面、不传本机路径。

### 8.2 输出结构

```json
{
  "audioSummary": "音频内容摘要",
  "title": "不超过20字的标题",
  "body": "发布正文",
  "hashtags": ["标签1", "标签2"],
  "confirmedFacts": [],
  "uncertainFacts": [],
  "riskFlags": [],
  "confidence": 0.88
}
```

### 8.3 生成规则

- 标题不超过现有页面限制的 20 字；
- 正文不得出现“测试”“RPA”“发布后删除”等内部字样；
- 只能使用转写文本中可以确认的信息；
- 不得根据视频文件名补充内容；
- 不得根据平台、账号或常识编造活动时间、地点、人物和效果；
- `[听不清]` 对应内容不得写入事实性文案；
- 音频没有提到的信息不得通过画面推断，因为本方案不分析画面；
- 可以改善语句表达，但不得改变原意；
- 涉及政策、金额、联系方式、承诺等内容时加入 `riskFlags`；
- 输出严格 JSON。

### 8.4 输出校验

服务端必须：

- 去除 Markdown 代码围栏；
- 解析 JSON；
- 检查必填字段；
- 标题去换行并限制 20 字；
- 正文不能为空；
- 标签去重并限制数量；
- `confidence` 归一化到 0～1；
- JSON 无效时允许修复一次；
- 第二次仍失败则返回失败，不把半成品写入页面。

---

## 9. 接口设计

### 9.1 第一版推荐同步接口

由于只处理约 2 分 30 秒的压缩音频，预计总耗时通常低于当前 Local Agent 代理的 120 秒超时，第一版可以沿用现有同步调用模式，不必立即增加数据库异步任务表。

新增 Local Agent 路由：

```http
POST /audio-content-generation
```

通过现有 Web 代理调用：

```http
POST /api/local-agent/audio-content-generation
```

请求：

```json
{
  "materialPath": "D:\\素材\\video.mp4",
  "materialMeta": {
    "type": "video",
    "sha256": "...",
    "durationSeconds": 150,
    "hasAudio": true
  },
  "platformCodes": ["douyin", "bilibili"],
  "force": false,
  "variantSeed": null
}
```

响应：

```json
{
  "status": "SUCCESS",
  "materialSha256": "...",
  "transcript": {
    "text": "音频转写内容",
    "model": "qwen3-asr-flash"
  },
  "result": {
    "title": "生成的标题",
    "body": "生成的正文",
    "hashtags": [],
    "confidence": 0.88,
    "riskFlags": []
  },
  "models": {
    "asr": "qwen3-asr-flash",
    "content": "qwen3.7-plus"
  },
  "elapsedMs": 18000,
  "cached": false
}
```

### 9.2 超时配置

建议分阶段超时：

```env
AI_AUDIO_EXTRACT_TIMEOUT_MS=30000
AI_ASR_TIMEOUT_MS=60000
AI_CONTENT_TIMEOUT_MS=30000
AI_AUDIO_TOTAL_TIMEOUT_MS=110000
```

Web 代理继续使用现有 120 秒上限，内部总超时必须略小于代理超时，确保能够返回结构化错误，而不是被代理直接中断。

### 9.3 何时升级为异步任务

出现以下任一情况时，再升级为异步任务：

- 视频最大时长扩展到 5 分钟以上；
- 实际 P95 接近或超过 100 秒；
- 需要页面刷新后恢复生成进度；
- 同时处理多个视频；
- 需要后台批量生成；
- ASR 模型改为异步文件转写接口。

第一版不提前增加无必要的数据库和 Worker 复杂度。

---

## 10. 缓存与幂等

建议在新的 Agent 服务中复用现有 OCR/AI 审核模式：

```javascript
const resultCache = new Map();
const inflight = new Map();
```

缓存键：

```text
SHA256(
  materialSha256
  + asrModel
  + contentModel
  + generationRuleVersion
  + selectedPlatformCodes
  + variantSeed
)
```

规则：

- 相同素材和相同参数重复点击时复用 inflight 请求；
- 已成功结果在缓存有效期内直接返回；
- “换一个写法”复用转写文本，只重新执行 Qwen3.7；
- `force=true` 可以绕过文案缓存，但不应无条件重新转写相同音频；
- 素材 SHA 变化后旧结果失效；
- 本机路径相同但文件内容变化时必须按新 SHA 处理。

建议把 ASR 缓存和文案缓存分开：

```text
ASR缓存键 = materialSha256 + asrModel + asrRuleVersion
文案缓存键 = transcriptHash + contentModel + promptVersion + platformCodes + variantSeed
```

---

## 11. 前端交互

### 11.1 新增状态

```javascript
state.contentGeneration = {
  status: 'IDLE',
  stage: null,
  materialSha256: null,
  result: null,
  error: null,
  titleDirty: false,
  bodyDirty: false,
  requestToken: null
};
```

状态建议：

```text
IDLE
EXTRACTING_AUDIO
TRANSCRIBING
GENERATING_COPY
COMPLETED
FAILED
CANCELLED
```

### 11.2 页面元素

- “AI 生成标题和文案”按钮；
- 可选“选择视频后自动生成”开关；
- 当前阶段提示；
- “取消”按钮；
- “重新生成”按钮；
- 转写质量不足提示；
- 隐私提示：只发送提取后的音频，不上传视频画面。

### 11.3 字段覆盖规则

1. 标题和正文为空时自动填写；
2. 只有一个字段为空时只填写空字段；
3. 用户已有内容时禁止静默覆盖；
4. 请求期间用户开始输入，完成结果不得覆盖；
5. 提供“使用 AI 结果覆盖”确认操作；
6. 结果写入后自动设置 `contentOrigin=AI_GENERATED`；
7. 结果写入后调用现有 `invalidateCompliance()`；
8. 用户修改 AI 文案后仍保持 AI 内容来源；
9. 素材变化后取消或忽略旧请求结果；
10. 返回结果的 SHA 必须与当前 `state.precheck.meta.sha256` 一致。

### 11.4 阶段提示

```text
正在提取视频音频…
正在识别音频内容…
正在生成标题和正文…
已生成，请检查内容后再进行AI审核。
```

不建议展示虚假的精确百分比；同步方案展示当前阶段即可。

---

## 12. 与现有合规审核的关系

正确顺序：

```text
音频转写
  ↓
生成标题和正文
  ↓
用户确认或修改
  ↓
现有AI合规审核
  ↓
发布
```

AI 文案生成不能替代合规审核。

必须使旧合规结果失效的事件：

- 新文案写入；
- 重新生成；
- 用户修改标题；
- 用户修改正文；
- 更换视频；
- 素材 SHA 变化；
- 更换目标平台。

AI 生成结果不得自动触发 `submitPublish()`。

---

## 13. 配置项

建议在 `src/config.js` 和设置服务中新增：

```env
AI_AUDIO_CONTENT_GENERATION_ENABLED=true
AI_AUDIO_CONTENT_AUTO_TRIGGER=true
QWEN_ASR_MODEL=qwen3-asr-flash
QWEN_CONTENT_MODEL=qwen3.7-plus
AI_AUDIO_MAX_DURATION_SECONDS=300
AI_AUDIO_MAX_BYTES=10485760
AI_AUDIO_BITRATE_KBPS=48
AI_AUDIO_SAMPLE_RATE=16000
AI_AUDIO_EXTRACT_TIMEOUT_MS=30000
AI_ASR_TIMEOUT_MS=60000
AI_CONTENT_TIMEOUT_MS=30000
AI_AUDIO_TOTAL_TIMEOUT_MS=110000
AI_AUDIO_CACHE_MAX_AGE_MS=604800000
AI_AUDIO_RULE_VERSION=audio-content-2026.08.24.1
```

当前 2 分 30 秒视频在 5 分钟上限内，可设置业务上限为 300 秒，避免未来用户误传长视频导致同步请求超时。

---

## 14. AI 调用日志

复用 `ai_call_logs`，增加：

```text
MATERIAL_AUDIO_TRANSCRIPTION
MATERIAL_COPY_GENERATION
MATERIAL_COPY_REPAIR
```

记录：

- 素材 SHA 的脱敏标识；
- ASR 模型；
- 文案模型；
- 调用状态；
- Token 或音频时长；
- 调用耗时；
- 错误码；
- 是否缓存命中；
- 规则版本。

禁止记录：

- API Key；
- 完整本机路径；
- Base64 音频；
- 完整原始音频；
- 未脱敏个人信息。

是否保存完整转写文本应按项目数据政策决定。第一版建议只在当前请求和短期缓存中使用，不默认写入数据库长期保存。

---

## 15. 异常处理

| 异常 | 系统行为 |
|---|---|
| 选择图片素材 | 不触发音频文案生成 |
| 视频没有音轨 | 提示无法根据音频生成 |
| 视频超过5分钟 | 阻止调用并提示手工填写或更换视频 |
| FFmpeg提取失败 | 返回 `AUDIO_EXTRACT_FAILED` |
| 临时磁盘空间不足 | 返回明确错误，不调用AI |
| 音频过大 | 降低码率重试一次 |
| 全程静音 | 返回 `NO_SPEECH_DETECTED` |
| ASR超时 | 返回 `ASR_TIMEOUT`，允许重试 |
| ASR结果为空 | 不继续生成文案 |
| ASR听不清比例过高 | 显示低质量提示，不自动填写 |
| 文案模型超时 | 保留转写缓存，重试时只生成文案 |
| JSON无效 | 修复一次，仍失败则不填写 |
| 用户更换视频 | 忽略旧结果 |
| 用户正在输入 | 不自动覆盖 |
| AI服务不可用 | 不阻塞手工填写和发布 |
| 清理临时音频失败 | 记录错误并由启动清理兜底 |

---

## 16. 耗时预估

以 2 分 30 秒视频为例：

| 阶段 | 常见耗时 |
|---|---:|
| 现有预检和 SHA | 1～5 秒 |
| 本地提取压缩音频 | 1～5 秒 |
| ASR 音频转写 | 5～20 秒 |
| Qwen3.7 生成文案 | 2～8 秒 |
| 校验和清理 | 1～2 秒 |
| **整体** | **常见约 10～35 秒** |

建议性能目标：

```text
P50：不超过25秒
P95：不超过60秒
总请求硬超时：110秒
```

与完整视频多模态方案相比，预计可以从约 40～120 秒降低到约 10～35 秒，同时不需要视频上传和 OSS。

实际耗时受视频编码、本机 CPU、网络上行和模型高峰影响，需使用真实视频样本验证。

---

## 17. 文件改动清单

### 17.1 建议新增

```text
agent/material-audio-content-generation.js
agent/material-audio-extractor.js
src/services/material-content-schema.js
test/material-audio-content-generation.test.js
test/material-audio-content-generation-api.test.js
test/material-audio-content-generation-ui.test.js
```

职责：

- `material-audio-extractor.js`：FFmpeg 音频提取、验证、临时目录和清理；
- `material-audio-content-generation.js`：ASR、文案生成、缓存、inflight、超时和结果归一化；
- `material-content-schema.js`：文案 JSON 校验和安全规则。

### 17.2 建议修改

```text
public/app.js
public/styles.css
agent/local-agent.js
src/server.js
src/config.js
src/services/settings.js
```

可选修改：

```text
src/db.js
```

如果只复用 `ai_call_logs`，第一版不需要新增业务表；如果希望长期保存转写和生成历史，再增加独立表。

### 17.3 不需要修改

第一版不需要：

```text
OSS相关服务
视频上传服务
publish_targets平台级文案结构
各平台RPA适配器
发布任务重试机制
```

---

## 18. 分阶段实施计划

### 阶段 1：音频提取与临时文件安全（0.5～1 人日）

- 新增音频提取模块；
- 校验时长、音轨和文件大小；
- 增加安全临时目录；
- 完成成功、失败、取消和启动清理；
- 为中文、空格和特殊字符路径增加测试。

### 阶段 2：ASR 与文案生成（1～1.5 人日）

- 接入 `qwen3-asr-flash`；
- 转写结果清洗；
- 接入 `qwen3.7-plus`；
- JSON 校验和修复；
- ASR 缓存、文案缓存和 inflight 去重；
- AI 调用日志。

### 阶段 3：Local Agent 接口（0.5 人日）

- 增加 `/audio-content-generation`；
- 加入 Web 代理允许列表；
- 增加分阶段超时；
- 返回统一错误结构；
- Mock 模式。

### 阶段 4：发布页接入（0.5～1 人日）

- 增加生成按钮和状态提示；
- 自动触发开关；
- 空字段自动填写；
- 人工内容防覆盖；
- 自动设置 `AI_GENERATED`；
- 使旧合规结果失效；
- 素材 SHA 绑定。

### 阶段 5：测试与灰度（1～1.5 人日）

- 自动化测试；
- 20～50 条真实样本；
- 无音轨、静音、方言、多人对话、音乐背景测试；
- P50/P95 统计；
- 错误率和人工改写率评估；
- 功能开关和回滚验证。

### 18.1 工作量

```text
开发与联调：约3～5人日
样本测试与验收：约1～2人日
总计：约4～7人日
```

相较完整视频理解方案，预计减少约一半工作量，并移除 OSS 运维前置条件。

---

## 19. 测试清单

### 19.1 正常场景

- 2 分 30 秒 MP4，普通话清晰；
- MOV 视频；
- 横屏和竖屏视频；
- 音频单声道和双声道；
- 背景音乐下的人声；
- 多人对话；
- 标题和正文为空时自动填写；
- 只有一个字段为空时只填写空字段；
- “换一个写法”复用 ASR 转写结果。

### 19.2 边界场景

- 视频无音轨；
- 全程静音；
- 人声非常小；
- 方言或夹杂英语；
- 语速很快；
- 音频中大量重复口播；
- 音频只有音乐；
- 接近 5 分钟上限；
- 原视频体积很大但音频正常；
- 本机路径包含中文、空格、括号和特殊字符。

### 19.3 并发与覆盖

- 连续点击两次生成；
- 等待期间更换视频；
- 等待期间修改标题；
- 等待期间修改正文；
- 旧请求晚于新请求返回；
- 相同视频重复生成；
- 相同视频点击“换一个写法”；
- 页面离开后请求返回。

### 19.4 失败与安全

- FFmpeg 超时；
- ASR 429、5xx 和超时；
- 文案模型 429、5xx 和超时；
- 文案返回非法 JSON；
- 临时音频清理失败；
- 日志中不得出现 Base64 音频；
- API Key 不得返回前端；
- AI 结果不能自动发布；
- AI 生成后必须重新审核。

---

## 20. 验收标准

### 20.1 功能

- 视频有音轨时可以生成标题和正文；
- 视频画面不发送给模型；
- 视频原片不上传；
- 只发送本地提取的临时音频；
- 标题不超过 20 字；
- 文案只基于音频转写；
- 不覆盖用户已输入内容；
- 写入后内容来源为 `AI_GENERATED`；
- 写入后旧合规审核失效；
- AI 失败后仍可手工发布；
- 生成结果不能直接触发发布。

### 20.2 性能

针对 2 分 30 秒视频：

- P50 不超过 25 秒；
- P95 不超过 60 秒；
- 请求总时长不超过 110 秒；
- 相同素材重复生成可以复用转写结果。

### 20.3 内容质量

- 转写结果不得主动补充未听清内容；
- 文案不得加入音频中未出现的事实；
- 低质量音频必须提示人工核对；
- `[听不清]` 内容不能作为确定事实写入正文；
- 至少使用 50 条真实视频进行运营盲评。

---

## 21. 上线与回滚

建议上线顺序：

1. Mock 模式跑通完整页面流程；
2. 使用现有 Key 测试 ASR 和 Qwen3.7；
3. 内部账号手动按钮灰度；
4. 统计真实耗时和转写质量；
5. 再决定是否默认开启自动触发。

回滚开关：

```env
AI_AUDIO_CONTENT_GENERATION_ENABLED=false
AI_AUDIO_CONTENT_AUTO_TRIGGER=false
```

关闭后不影响现有：

- 素材预检；
- 人工填写；
- AI 合规审核；
- 发布任务；
- 平台 RPA。

---

## 22. 待确认项与推荐默认值

### 22.1 待确认

1. 是否接受把提取后的音频发送给千问；
2. 是否默认视频预检完成后自动生成；
3. 文案正文期望长度和语言风格；
4. 是否需要把转写文本展示给用户；
5. 是否允许处理方言和多人对话；
6. 是否需要长期保存转写结果。

### 22.2 推荐默认值

```text
只分析音频，不分析画面和硬字幕
视频原片不上传
本地提取48kbps、16kHz、单声道MP3
ASR使用qwen3-asr-flash
文案使用qwen3.7-plus
第一版同步调用
只自动填写空字段
已有人工内容必须确认后覆盖
不长期保存完整转写文本
AI写入后必须重新执行合规审核
绝不自动发布
```

---

## 23. 官方参考

- 千问语音识别：<https://help.aliyun.com/zh/model-studio/qwen-asr-api>
- Qwen-Audio：<https://help.aliyun.com/zh/model-studio/qwen-audio-api>
- Qwen3.5-Omni-Plus：<https://help.aliyun.com/zh/model-studio/qwen3-5-omni-plus>
- 百炼模型列表：<https://help.aliyun.com/zh/model-studio/models>
- 百炼 API Key：<https://help.aliyun.com/zh/model-studio/get-api-key>

> 模型名称、限制、价格和接口兼容性可能调整。正式开发开始前，应在 2026-08-24 当前百炼环境中使用现有 Key 对目标 ASR 模型和 `qwen3.7-plus` 各执行一次真实连通性测试，以实际 API 返回为准。

---

## 24. 最终建议

需求收敛为只依赖视频音频后，推荐不再实施完整视频多模态和 OSS 方案，而是采用：

```text
FFmpeg本地提取音频
  → qwen3-asr-flash转写
  → qwen3.7-plus生成文案
  → 安全填写现有标题和正文
```

该方案不上传视频原片和画面，不需要 OSS，预计 2 分 30 秒视频通常约 10～35 秒完成，开发和维护成本也明显低于完整视频理解方案。
