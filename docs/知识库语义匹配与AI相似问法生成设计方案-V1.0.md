# 知识库语义匹配与 AI 相似问法生成设计方案 V1.0

- 编写日期：2026-08-19
- 适用项目：天河 AI 数字员工平台（AI数字运营2）
- 当前状态：设计方案，尚未据此执行数据库迁移和页面改造
- 关联现有方案：`docs/知识库模块架构与安全检索设计方案-V1.0.md`

---

## 1. 背景与问题

当前项目已经具备以下能力：

1. 知识保存在 SQLite 的 `knowledge` 表中；
2. `src/services/knowledge.js` 会根据标准问题、答案、关键词和文字二元组相似度召回候选知识；
3. `src/services/qwen.js` 的 `selectKnowledgeForReply()` 会让 Qwen 从候选知识中选择唯一的 `knowledgeId`；
4. 选中知识后，由 `composeReply()` 根据标准答案生成受知识约束的回复；
5. 知识按平台分类隔离，当前平台只能检索本平台知识和公共知识。

当前主要问题不是 AI 完全不理解语义，而是“正确知识能否先进入候选集合”。例如：

```text
标准问题：参加社区活动需要收费吗？
用户问题：参加活动要钱吗？
```

文字不同但语义相同。知识数量增加后，正确知识可能因为文字分数不高，被截在前 20 条候选之外，后面的 AI 就没有机会选中它。

另一个典型问题是：

```text
行不行 / 可不可以 / 能不能 / 是否允许 / 可以吗
```

这些是公共表达方式。如果给每条知识穷举几百种问法，会出现以下问题：

- 数据重复严重；
- AI 生成数量再多也无法穷举自然语言；
- “行不行”这类短句脱离上下文没有明确意图；
- 相似问法可能跨知识冲突，导致选错答案；
- 标准答案或问题修改后，旧相似问法可能继续错误生效。

因此，本方案不采用“生成大量问法，命中一句就直接回复”的简单方式，而采用：

```text
公共表达归一化
+ 每条知识的高质量相似问法
+ 对话上下文补全
+ 多路召回
+ AI 候选二次判断
+ 自动回复安全门禁
+ 真实消息持续学习
```

---

## 2. 设计目标

### 2.1 核心目标

1. 用户换一种说法时，仍能准确找到对应知识；
2. 解决“行不行”和“可不可以”等公共同义表达；
3. 知识保存或批量导入后，利用现有 Qwen 自动生成相似问法；
4. 相似问法必须绑定 `knowledge_id`，不能复制或独立维护答案；
5. AI 只能从知识库候选中选答案，不能脱离知识库自由编答；
6. 相似问法不能破坏抖音、视频号等平台知识隔离；
7. 对含糊、冲突、低置信度的问题不强行回复；
8. 支持查看、审核、停用和重新生成相似问法；
9. 支持从真实未命中消息中持续补充表达方式。

### 2.2 非目标

V1.0 暂不做以下内容：

- 不直接引入外部向量数据库；
- 不让 AI 修改标准答案；
- 不让 AI 生成相似问法后无校验地全部启用；
- 不对历史 `KNOWLEDGE_GAP` 消息自动补发，防止重复回复；
- 不允许不同平台的私有知识互相召回；
- 不将单独的“行不行”“可以吗”固定绑定到某一条知识。

---

## 3. 总体架构

### 3.1 知识保存流程

```text
业务人员新增/编辑/批量导入知识
        ↓
保存标准问题、答案、关键词和知识版本
        ↓
创建“相似问法生成任务”
        ↓
Qwen 按结构化要求生成 25～30 条候选问法
        ↓
格式校验、归一化、去重
        ↓
同平台知识冲突检查
        ↓
AI 反向验证：候选问法重新选择 knowledgeId
        ↓
高可信问法自动启用；歧义问法进入待审核
        ↓
作为新的召回入口，但不能直接决定答案
```

生成过程建议异步执行。知识本身保存成功后立即可用，不因 AI 超时导致保存失败。

### 3.2 运行时回复流程

```text
收到用户消息
        ↓
清洗文字、统一标点、数字和常见表达
        ↓
判断是否为依赖上下文的短句
        ↓
必要时结合最近对话补全问题
        ↓
标准问题精确召回
+ 关键词召回
+ 相似问法召回
+ 当前文字相似度召回
        ↓
合并并去重候选知识
        ↓
Qwen 对候选知识进行语义比较
        ↓
返回第一名、第二名、置信度、是否可直接回答
        ↓
自动回复门禁判断
        ↓
按 knowledgeId 读取最新标准答案
        ↓
生成受知识约束的回复
```

关键原则：**相似问法只负责把正确知识送进候选集合，最终仍由语义判断和门禁决定是否回复。**

---

## 4. 三种不同的数据不能混在一起

### 4.1 公共同义表达规则

用于全知识库通用的语言转换，例如：

| 用户表达 | 统一语义 |
|---|---|
| 行不行、可不可以、能不能、是否可以、允许吗 | 是否可行 |
| 要不要钱、收费吗、免费吗、得掏钱吗 | 询问费用 |
| 在哪、什么位置、地址哪里、怎么过去 | 询问地点 |
| 怎么弄、怎么办、如何操作、咋办理 | 询问方法 |
| 什么时候、几点、哪天、多久开始 | 询问时间 |
| 怎么参加、在哪报名、如何登记 | 询问报名方式 |

这些规则不绑定某条知识，只用于统一表达和增强召回。

### 4.2 每条知识的相似问法

例如知识：

```text
知识 #12
标准问题：参加社区活动需要收费吗？
```

可以绑定：

```text
参加活动要钱吗
报名是不是要交钱
这个活动收费不
参加的话得掏钱吗
社区活动是免费的吗
费用怎么算
```

这些问法只保存 `knowledge_id=12`，回答时仍读取知识 #12 的最新标准答案。

### 4.3 对话上下文表达

例如：

```text
用户：我想带小孩参加周末活动。
用户：行不行？
```

“行不行”本身不能写成知识 #12 或其他知识的固定相似问法。系统应结合上文补全为：

```text
是否可以带小孩参加周末活动？
```

如果没有可用上文，只收到“行不行”，系统应该澄清或转人工，不能猜测。

---

## 5. AI 相似问法生成策略

### 5.1 每条知识生成多少条

建议默认生成 **25～30 条**，单条知识最多启用 **50 条**。

推荐分布：

| 类型 | 数量 | 示例 |
|---|---:|---|
| 正式表达 | 4～5 | 参加活动是否需要支付费用 |
| 日常口语 | 6～8 | 参加活动要钱吗 |
| 简短省略 | 4～5 | 活动收费吗 |
| 倒装表达 | 3～4 | 钱要不要交，参加活动的话 |
| 语音转文字/常见错别字 | 2～3 | 报名要交费嘛 |
| 带场景表达 | 4～5 | 带孩子参加也要收费吗 |

不建议每条生成几百条。覆盖范围主要依靠“公共规则 + 相似问法 + AI 比较 + 上下文”，不是依靠穷举所有句子。

### 5.2 AI 输出结构

AI 必须输出可验证 JSON，不能输出自然语言段落：

```json
{
  "knowledgeId": 12,
  "intent": "询问参加活动是否需要支付费用",
  "requiredConcepts": ["参加活动", "费用"],
  "excludedIntents": [
    "询问怎么报名",
    "询问近期有哪些活动",
    "询问活动举办地点"
  ],
  "aliases": [
    {
      "text": "参加活动要钱吗",
      "type": "COLLOQUIAL",
      "confidence": 0.97,
      "ambiguityRisk": "LOW"
    },
    {
      "text": "活动收费吗",
      "type": "SHORT",
      "confidence": 0.91,
      "ambiguityRisk": "MEDIUM"
    }
  ]
}
```

### 5.3 禁止生成的内容

以下相似问法不能直接绑定到某条知识：

- “行不行”；
- “可以吗”；
- “怎么弄”；
- “多少钱”；
- “在哪里”；
- “还有吗”；
- “那这个呢”。

它们缺少业务对象，容易同时匹配多条知识。AI 可以把它们标记为 `CONTEXT_REQUIRED`，但不能作为普通启用别名。

### 5.4 生成时提供相邻知识

不能只把一条知识单独交给 AI。生成时还要提供同分类下最相近的若干知识，例如：

```text
#10 近期有什么社区活动？
#11 社区活动怎么报名？
#12 参加社区活动需要收费吗？
```

这样 AI 才能明确：

- “最近有什么活动”不能生成给 #12；
- “在哪登记参加”不能生成给 #12；
- “活动要不要钱”可以生成给 #12。

---

## 6. 数据库设计

现阶段继续使用当前 SQLite，不切换现有数据库。

### 6.1 `knowledge_semantic_aliases`

用于保存每条知识的相似问法。

```sql
CREATE TABLE IF NOT EXISTS knowledge_semantic_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  knowledge_version INTEGER NOT NULL,
  alias_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  alias_type TEXT NOT NULL DEFAULT 'AI_GENERATED',
  source TEXT NOT NULL DEFAULT 'AI_GENERATED',
  confidence REAL NOT NULL DEFAULT 0,
  ambiguity_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL DEFAULT 'PENDING',
  validation_json TEXT,
  conflict_json TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(knowledge_id, knowledge_version, normalized_text)
);
```

字段说明：

| 字段 | 说明 |
|---|---|
| `knowledge_id` | 绑定标准知识，不复制答案 |
| `knowledge_version` | 只对生成时的知识版本生效 |
| `alias_text` | 原始相似问法 |
| `normalized_text` | 归一化后文本，用于去重和精确召回 |
| `alias_type` | FORMAL/COLLOQUIAL/SHORT/INVERTED/ASR 等 |
| `source` | AI_GENERATED/MANUAL/REAL_MESSAGE |
| `confidence` | 生成和验证后的可信度 |
| `ambiguity_risk` | LOW/MEDIUM/HIGH/CONTEXT_REQUIRED |
| `status` | PENDING/ENABLED/DISABLED/AMBIGUOUS/STALE |
| `validation_json` | AI 反向验证结果和规则版本 |
| `conflict_json` | 与其他知识冲突的详情 |
| `hit_count` | 实际召回次数 |

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_knowledge_alias_enabled
ON knowledge_semantic_aliases(status, normalized_text, knowledge_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_alias_knowledge
ON knowledge_semantic_aliases(knowledge_id, knowledge_version, status);
```

### 6.2 `semantic_expression_rules`

用于保存“行不行=可不可以”这类公共规则。

```sql
CREATE TABLE IF NOT EXISTS semantic_expression_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_text TEXT NOT NULL,
  normalized_variant TEXT NOT NULL UNIQUE,
  canonical_text TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'ENABLED',
  source TEXT NOT NULL DEFAULT 'SYSTEM',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

示例：

```text
variant_text=可不可以
canonical_text=是否可行
rule_type=MODAL_PERMISSION
```

注意：归一化时不能简单地把所有文字机械替换后直接决定答案。公共规则只生成额外检索表达，原始消息必须保留给 AI 判断。

### 6.3 `knowledge_alias_generation_runs`

用于记录 AI 生成任务，方便失败重试和审计。

```sql
CREATE TABLE IF NOT EXISTS knowledge_alias_generation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  knowledge_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  requested_count INTEGER NOT NULL DEFAULT 30,
  generated_count INTEGER NOT NULL DEFAULT 0,
  enabled_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  prompt_version TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
```

### 6.4 可选的真实消息学习表

第二阶段可增加：

```text
knowledge_match_feedback
```

用于记录：

- 哪条真实消息匹配了哪条知识；
- AI 置信度；
- 是否真正发送成功；
- 是否被人工改判；
- 是否建议把该消息加入相似问法。

真实消息不能因为一次高分匹配就直接成为启用别名，必须经过重复命中、人工确认或反向验证。

---

## 7. 相似问法校验机制

AI 生成后按以下顺序处理。

### 7.1 基础校验

- 文本不能为空；
- 长度建议为 2～100 个字符；
- 不允许包含答案内容或系统提示词；
- 不允许生成知识库中不存在的新事实；
- `knowledgeId` 必须等于当前生成任务的知识编号；
- 类型、置信度和风险字段必须符合枚举范围。

### 7.2 归一化与去重

对相似问法执行：

- Unicode 规范化；
- 大小写统一；
- 全角半角统一；
- 标点和多余空格清理；
- 常见口语表达映射；
- 同一知识内去重；
- 与标准问题重复的别名删除。

### 7.3 跨知识冲突检查

在当前平台允许的知识范围内，检查相同或高度相似的别名是否已经绑定其他知识。

例如：

```text
“怎么参加活动”
```

如果同时绑定：

- #11 活动怎么报名；
- #12 活动是否收费；

则该别名必须标记为 `AMBIGUOUS`，不能自动启用。

冲突检查必须遵循平台隔离：

```text
抖音消息：只与抖音知识和公共知识比较
视频号消息：只与视频号知识和公共知识比较
```

### 7.4 AI 反向验证

把生成的相似问法重新作为用户问题，并把当前知识及相邻知识一起交给 AI：

```text
候选问法：活动要不要钱
候选知识：#10、#11、#12
```

要求 AI 返回：

```json
{
  "bestKnowledgeId": 12,
  "bestConfidence": 0.96,
  "secondKnowledgeId": 11,
  "secondConfidence": 0.21,
  "directlyAnswerable": true,
  "reason": "用户询问活动费用"
}
```

只有满足以下条件才允许自动启用：

```text
bestKnowledgeId 等于原知识编号
bestConfidence >= 0.90
bestConfidence - secondConfidence >= 0.15
directlyAnswerable = true
ambiguityRisk = LOW
```

其他问法进入 `PENDING` 或 `AMBIGUOUS`，由页面人工审核。

---

## 8. 运行时召回设计

### 8.1 保留原始问题和生成检索问题

例如用户输入：

```text
这个活动我参加行不行？
```

系统保留：

```text
originalQuery = 这个活动我参加行不行
```

并生成检索表达：

```text
normalizedQuery = 这个活动我参加是否可行
```

AI 最终判断必须看到原始问题，不能只看机械转换后的文本。

### 8.2 多路召回

建议按以下来源召回：

1. 标准问题完全相同；
2. 已启用相似问法完全相同；
3. 公共规则归一化后相同；
4. 标准问题和相似问法的文字相似度；
5. 关键词覆盖；
6. 当前答案的低权重文字召回；
7. 第二阶段可选向量召回。

每路召回只产生候选，不直接产生回复决定。

### 8.3 候选合并

建议每个来源取若干条，再按 `knowledge_id` 合并，避免某一种召回方式独占全部 20 个名额。

示例：

```text
精确/别名召回：最多 8 条
关键词召回：最多 8 条
文字相似度召回：最多 12 条
合并去重后：最多 20 条交给 Qwen
```

每个候选增加召回证据：

```json
{
  "knowledgeId": 12,
  "recallSources": ["ALIAS_EXACT", "KEYWORD"],
  "matchedAlias": "参加活动要钱吗",
  "lexicalScore": 0.71,
  "scopePriority": 1
}
```

### 8.4 AI 二次判断

扩展现有 `selectKnowledgeForReply()` 的结构化返回值：

```json
{
  "matched": true,
  "knowledgeId": 12,
  "confidence": 0.95,
  "secondKnowledgeId": 11,
  "secondConfidence": 0.32,
  "directlyAnswerable": true,
  "needsContext": false,
  "reason": "用户询问参加活动是否收费"
}
```

后端必须校验：

- 返回的编号必须属于候选集合；
- 知识仍为 `PUBLISHED`；
- 知识分类属于当前平台允许范围；
- AI 返回结构不合法时不自动回复；
- AI 超时或接口失败属于技术异常，不记录成知识缺口。

---

## 9. 自动回复门禁

运行时建议使用比生成校验稍宽、但仍安全的门槛：

```text
第一名语义置信度 >= 0.85
第一名与第二名差值 >= 0.12
directlyAnswerable = true
needsContext = false
知识状态 = PUBLISHED
知识版本有效
平台范围正确
最终回复通过现有答案约束校验
```

结果分流：

| 情况 | 处理 |
|---|---|
| 高置信度且差距充分 | 自动回复 |
| 有两个接近答案 | 追问澄清或转人工 |
| 只有“行不行”等短句且无上下文 | 追问用户具体事项 |
| 没有可靠候选 | 记录知识缺口并通知人工 |
| AI 接口失败 | 技术异常/重试，不当作知识缺口 |
| 知识冲突 | 转人工并记录冲突证据 |

---

## 10. 对话上下文设计

### 10.1 何时使用上下文

不是每条消息都把大量历史记录交给 AI。只有满足下列情况之一才补充上下文：

- 当前消息过短；
- 包含“这个、那个、这样、行不行、可以吗、还有吗”等指代词；
- 当前消息无法独立召回可靠候选；
- AI 明确返回 `needsContext=true`。

### 10.2 上下文范围

建议最多读取同一会话最近 3 轮有效对话，并设置时间窗口，例如 30 分钟。过滤：

- 系统提示；
- 已撤回或无效消息；
- 其他用户的消息；
- 其他平台或账号的消息；
- 已经非常久远且无连续关系的对话。

### 10.3 问题补全结果

补全 AI 只能生成用于检索的“完整问题”，不能直接回答：

```json
{
  "contextRequired": true,
  "rewrittenQuestion": "是否可以带小孩参加周末社区活动",
  "confidence": 0.91
}
```

原始消息、补全问题和使用的消息编号都应保留在处理日志中。

如果当前数据库还不能稳定标识同一私信会话，则第一阶段先采用安全策略：短句不自动回复；完成会话标识后再启用上下文补全。

---

## 11. 知识新增、修改和导入流程

### 11.1 单条新增

当前 `POST /api/knowledge` 保存成功后：

1. 提交知识事务；
2. 创建 alias 生成任务；
3. 页面显示“相似问法生成中”；
4. 后台调用 Qwen；
5. 完成后更新可用数量和待审核数量。

AI 失败不回滚知识保存。

### 11.2 单条修改

知识修改并增加 `version` 后：

1. 旧版本相似问法改为 `STALE`；
2. 新版本创建生成任务；
3. 新相似问法通过校验后启用；
4. 回答始终通过 `knowledge_id` 读取当前最新答案。

第一阶段采用“版本变化即重新验证”的保守方案，避免问题意图已经改变而旧别名继续生效。

### 11.3 批量导入

当前 `commitKnowledgeImport()` 完成知识入库后：

1. 为每条新知识创建生成任务；
2. 控制并发，建议每次 2～3 个 AI 请求；
3. 失败任务可独立重试，不影响已导入知识；
4. 导入结果增加：待生成、生成中、已完成、部分失败等统计。

### 11.4 删除和停用

- 知识停用后，其相似问法不得召回；
- 知识删除时，别名和生成任务通过外键级联或业务逻辑清理；
- 相似问法停用不影响标准知识本身；
- 公共表达规则停用后不再参与新消息归一化。

---

## 12. 页面设计

### 12.1 知识列表

每条知识增加“相似问法”状态：

```text
已启用 24 条
待审核 3 条
存在冲突 1 条
生成失败
生成中
```

操作：

- 查看相似问法；
- 重新生成；
- 手工添加；
- 批量启用；
- 批量停用；
- 查看冲突原因。

### 12.2 相似问法弹窗

建议显示：

| 相似问法 | 来源 | 类型 | 置信度 | 风险 | 状态 | 命中次数 | 操作 |
|---|---|---|---:|---|---|---:|---|
| 参加活动要钱吗 | AI | 口语 | 0.97 | 低 | 已启用 | 12 | 停用 |
| 活动收费吗 | AI | 简短 | 0.91 | 中 | 待审核 | 3 | 启用/拒绝 |

冲突项展开后显示：

```text
该问法同时接近：
#11 社区活动怎么报名？
#12 参加社区活动需要收费吗？
```

### 12.3 消息中心诊断信息

“重新判断”或查看详情时，建议展示：

- 原始消息；
- 是否使用上下文补全；
- 命中的相似问法；
- 候选知识前两名；
- 第一名和第二名置信度；
- 最终未回复的门禁原因；
- 使用的语义规则版本。

这样可以区分：

- 没召回正确知识；
- AI 选错知识；
- 分数不足；
- 两条知识冲突；
- 发送平台失败。

---

## 13. 后端接口建议

```text
GET    /api/knowledge/:id/aliases
POST   /api/knowledge/:id/aliases/generate
POST   /api/knowledge/:id/aliases
PATCH  /api/knowledge/aliases/:aliasId
POST   /api/knowledge/aliases/:aliasId/enable
POST   /api/knowledge/aliases/:aliasId/disable
POST   /api/knowledge/aliases/:aliasId/revalidate
GET    /api/knowledge/alias-generation-runs
GET    /api/semantic-expression-rules
POST   /api/semantic-expression-rules
PATCH  /api/semantic-expression-rules/:id
```

所有修改接口应记录操作者、时间、旧值和新值。生成接口必须防止同一知识同一版本重复创建并发任务。

---

## 14. 真实消息持续学习

系统运行后，比 AI 一次性生成更有价值的是实际用户表达。

建议流程：

```text
真实消息高置信度匹配某知识
        ↓
与现有标准问题和别名差异较大
        ↓
记录为 REAL_MESSAGE 候选表达
        ↓
反向验证和冲突检查
        ↓
重复出现或人工确认后启用
```

自动学习限制：

- 不能把机器人自己发出的内容作为用户别名；
- 不能因为一次匹配就立即启用；
- 人工改判后必须降低或撤销错误表达；
- 涉及姓名、手机号、订单号等个人信息时必须脱敏，不能原样入库；
- 只学习问法，不学习未经审核的新答案。

---

## 15. 规则和模型版本

建议独立记录版本：

```text
normalizerVersion: semantic-normalizer-2026.08.19.1
aliasPromptVersion: knowledge-alias-2026.08.19.1
aliasValidatorVersion: knowledge-alias-validator-2026.08.19.1
knowledgeMatcherVersion: knowledge-semantic-2026.08.19.1
replyRuleVersion: reply-semantic-2026.08.19.1
```

规则更新后可以判断哪些相似问法需要重新归一化或重新验证，不必猜测历史数据使用了什么逻辑。

---

## 16. 与当前代码的衔接位置

### 16.1 `src/db.js`

增加：

- `knowledge_semantic_aliases`；
- `semantic_expression_rules`；
- `knowledge_alias_generation_runs`；
- 对应索引和安全迁移。

不得删除、替换或重置当前 `data/mvp.db`。

### 16.2 `src/services/knowledge.js`

当前职责为文字归一化、评分和候选召回。建议拆分或新增：

```text
normalizeSemanticExpressions()
searchKnowledgeAliases()
mergeKnowledgeCandidates()
recordAliasHit()
```

现有 `searchKnowledge()` 对外接口可以暂时保留，内部改为多路召回，减少对 `server.js` 的影响。

### 16.3 `src/services/qwen.js`

新增：

```text
generateKnowledgeAliases()
validateKnowledgeAliasByReverseMatch()
rewriteContextualQuestion()
```

扩展：

```text
selectKnowledgeForReply()
```

使其返回第二候选、分差、是否可直接回答和是否需要上下文。

### 16.4 `src/services/knowledge-import.js`

`commitKnowledgeImport()` 成功后批量创建相似问法生成任务，不在数据库事务内同步等待 AI。

### 16.5 `src/server.js`

增加相似问法管理接口，并在现有知识新增、修改、导入完成后触发生成任务。

### 16.6 Web 页面

在知识库列表和编辑弹窗中增加相似问法入口、生成状态、审核列表和冲突说明。

---

## 17. 分阶段实施建议

### 第一阶段：可用 MVP

目标：解决大部分换说法无法召回的问题，不引入向量库。

1. 新建三个核心表和索引；
2. 实现公共表达规则；
3. 实现每条知识生成 25～30 条问法；
4. 实现去重、冲突检查和 AI 反向验证；
5. 将已启用别名加入 `searchKnowledge()`；
6. 保留现有 `selectKnowledgeForReply()` 二次确认；
7. 增加相似问法查看、启用和停用页面；
8. 补齐单元测试和真实在线只读验证。

### 第二阶段：上下文与持续学习

1. 完善私信会话标识；
2. 对“行不行、可以吗、还有吗”等短句进行上下文补全；
3. 从真实高置信度消息生成待审核别名；
4. 增加人工改判反馈；
5. 增加命中率、误判率和转人工原因统计。

### 第三阶段：可选向量召回

当知识量明显增加、纯文字和别名召回仍不足时，再增加 embedding 向量召回。向量召回也只负责提供候选，不能绕过 AI 二次判断和安全门禁。

---

## 18. 测试用例

### 18.1 同义问法

| 用户问题 | 预期知识 |
|---|---|
| 参加活动要钱吗 | #12 活动是否收费 |
| 报名是不是得交钱 | #12 活动是否收费 |
| 这个活动免费不 | #12 活动是否收费 |
| 最近有什么活动 | #10 近期活动 |
| 在哪登记参加 | #11 活动报名 |

### 18.2 公共表达替换

以下表达在业务对象相同的情况下，应召回相同候选：

```text
能不能参加这个活动
可不可以参加这个活动
参加这个活动行不行
是否允许参加这个活动
```

### 18.3 歧义拦截

```text
用户：参加活动
```

可能是在问报名、费用、资格或时间，不能仅凭“活动”自动回复。

```text
用户：行不行
```

没有上文时不能绑定固定知识，应澄清或转人工。

### 18.4 平台隔离

- 抖音私信不能召回视频号私有知识；
- 视频号私信不能召回抖音私有知识；
- 两个平台都可以召回公共知识；
- 相似问法命中也不能绕过分类隔离。

### 18.5 版本和安全

- 知识修改后旧版本别名必须失效；
- AI 返回候选集合之外的 ID 必须拦截；
- AI 返回非法 JSON 不得自动回复；
- AI 超时不能记录成知识缺口；
- 别名匹配成功但最终答案不覆盖问题时不得发送；
- 相似问法不能携带或生成标准答案以外的新事实。

---

## 19. 验收指标

上线前建议建立一组真实问题测试集，至少覆盖：标准问法、口语、缩写、倒装、错别字、上下文短句、歧义问题和无知识问题。

第一阶段建议目标：

| 指标 | 目标 |
|---|---:|
| 明确同义问题正确召回率 | ≥ 95% |
| 自动回复知识选择准确率 | ≥ 98% |
| 跨平台错误召回 | 0 |
| 候选外 knowledgeId 被采用 | 0 |
| 歧义问题被错误自动回复 | ≤ 1% |
| 知识修改后旧别名继续生效 | 0 |
| AI 失败被误记为知识缺口 | 0 |

不能只看“回复率”。如果提高回复率的代价是错答，应该优先保守转人工。

---

## 20. 最终建议

本项目最适合的实现方式不是单纯增加一个很大的同义词库，而是：

```text
公共表达规则解决语言零件变化
AI 相似问法解决整句说法变化
对话上下文解决“行不行”等省略问题
多路召回保证正确知识进入候选
AI 二次判断解决候选之间的真实意图区分
门禁和标准答案约束防止错答与自由编答
真实消息学习让系统逐渐覆盖用户真实说法
```

第一阶段先实现 SQLite 相似问法表、公共规则、AI 生成与反向验证、多路召回和管理页面，即可在不更换当前数据库、不引入向量库的前提下，大幅提高当前知识库对口语和换说法问题的覆盖能力。
