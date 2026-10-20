# 天河 AI 运营中枢 MVP 全系统测试报告

- 测试日期：2026-08-10
- 测试对象：`ai-digital-employee-mvp`
- 测试角色：攻击性/边界型测试工程师
- 总体结论：**受控内网、单机单实例、人工看护条件下可试运营；当前不具备直接生产上线条件。**
- 综合稳定性评分：**6.5 / 10**
- 生产发布结论：**No-Go（P0 安全项修复前）**

> 安全边界：本次没有对小红书、抖音、视频号、B站、微博真实账号执行发布、评论回复或私信操作。发布和消息闭环全部在隔离 SQLite 数据库、`RPA_MODE=simulated` 环境完成，避免真实平台副作用。

## 1. 测试范围

1. Web 管理端九个模块：运行总览、平台启停、内容发布、任务中心、评论与私信、知识库、问题汇总、企微配置、账号与设备。
2. 五平台任务状态机：素材预检、AI 审核、账号检查、任务创建、Agent 领取、提交锁、平台结果、幂等防重、失败恢复。
3. 消息闭环：采集/模拟、去重、知识命中、知识缺口、投诉转人工、自动回复安全回执、问题关闭。
4. 管理能力：全局总开关、单平台开关、智能回复开关、账号登录状态、Local Agent 心跳。
5. 非功能：静态语法、依赖漏洞、SQLite 完整性、并发、双实例、异常输入、CORS、鉴权、路径穿越、存储膨胀、可访问性与响应式代码。

## 2. 测试结果摘要

| 项目 | 结果 | 判断 |
|---|---:|---|
| Node 自动化测试 | 246 / 246 通过 | 核心业务回归较完整 |
| 行/分支/函数覆盖率 | 67.69% / 58.85% / 59.65% | 中等；真实页面 RPA 薄弱 |
| 活跃 JS 语法检查 | 56 / 56 通过 | 无语法阻断 |
| 生产依赖审计 | 0 个已知漏洞 | 依赖层良好 |
| SQLite integrity_check | ok | 数据库文件完整 |
| 管理端模块渲染 | 9 / 9 成功 | 未见 console error/warn |
| 模拟发布闭环 | SUBMITTED | 预检、审核、Agent、提交锁、证据链成功 |
| 相同发布幂等 | HTTP 409 拒绝 | 防重复发布有效 |
| 知识命中 | 正确生成答案 | 模拟回执不可信时安全转人工 |
| 知识缺口 | PENDING -> PUBLISHED | 审核沉淀闭环成功 |
| 投诉消息 | MANUAL_REQUIRED | 风险分流正确 |
| 单实例 300 并发写 | 300 / 300 成功 | 单实例稳定，p95 约 1.18s |
| 双实例 500 并发写 | 411 成功、89 失败 | 17.8% `database is locked`，不可接受 |
| 静态目录穿越 | 未泄露文件 | 但未知路径统一返回 SPA 200 |
| 存储型 XSS 探测 | 未复现执行 | 主要动态内容使用转义；不代表形式化证明 |
| 恢复脚本 | 可恢复 RUNNING 任务 | 提交锁保持，但提示语存在误导 |

## 3. 稳定性分项评分

| 维度 | 评分 | 说明 |
|---|---:|---|
| 核心业务状态机 | 8.5/10 | 幂等、提交锁、未知结果转人工等安全语义较好 |
| 管理端可用性 | 8.0/10 | 九模块可加载，基本交互结构完整 |
| 单机单实例运行 | 8.0/10 | 读写稳定，数据库完整 |
| 五平台真实 RPA | 6.0/10 | DOM 易变，且小红书适配器覆盖率仅 13.13% |
| 恢复与运维工程 | 5.5/10 | 有恢复脚本，但无单实例锁、无忙等待重试、日志/交付包膨胀 |
| 安全与生产部署 | 3.0/10 | 无鉴权、主服务监听全网卡、CORS 通配、交付包含密钥和浏览器 Profile |
| 综合 | **6.5/10** | 适合技术验证和受控试点，不适合直接生产 |

## 4. 主要缺陷

### P0-1 主服务无身份认证，监听 0.0.0.0，且 CORS 为 *

- `src/server.js:1412` 设置 `Access-Control-Allow-Origin: *`。
- `src/server.js:1414` 监听 `0.0.0.0`。
- API 未发现 Authorization、Session、Cookie 或 API Key 校验中间件。
- 实测从伪造 Origin 可读取 `/api/bootstrap`，并且无凭据成功修改微博智能回复开关。
- 影响：同局域网任意设备可读取运营数据、控制平台、创建发布任务、修改或删除知识、关闭问题。

**整改：** 默认仅监听 127.0.0.1；如需局域网访问，必须增加登录、RBAC、CSRF 防护、严格 Origin allowlist、TLS/反向代理和审计日志。所有写 API 需要鉴权和权限判定。

### P0-2 交接包携带真实敏感信息和持久登录 Profile

- 根目录 `.env` 存在非空 `QWEN_API_KEY`（仅验证长度 35，未输出值）。
- `data/browser-profiles` 含多个平台持久浏览器 Profile，可能包含 Cookie、Session、Token。
- `data + logs + outputs` 共 21,436 个文件、约 2.631 GiB。
- 发现 122 个备份或临时命名文件。

**整改：** 立即轮换交付包中的 API key，废弃/注销 Profile 会话；交付只包含 `.env.example`；秘密放入 Windows Credential Manager/DPAPI 或正式 Secret Manager；打包排除 Cache、Cookies、日志、截图和备份文件。

### P1-1 Local Agent 无认证且允许任意网页跨域调用 localhost

- `agent/local-agent.js:351` 为 CORS `*`。
- `agent/local-agent.js:342-345` 请求体无大小限制。
- 暴露 `/control/shutdown`、`/platforms/open-login`、`/pick-file`、预检、OCR、AI 审核及调试接口。
- 虽然仅绑定 `127.0.0.1`（`agent/local-agent.js:704`），恶意网页仍可向本机端口发请求。

**整改：** 启动时生成高熵一次性/轮换 token；主服务与 Agent 双向认证；严格校验 Origin/Host；危险接口要求签名、nonce、时间窗；关闭生产调试路由；限制请求大小和并发。

### P1-2 双实例并发写失败率 17.8%

- 两个服务共享 SQLite 时，500 次并发写中 89 次 HTTP 500，全部为 `database is locked`。
- `src/db.js` 开启 WAL 和外键，但未设置 `busy_timeout`，实际值为 0。
- 当前没有进程级单实例互斥。

**整改：** Windows mutex/PID lock 防重复启动；`PRAGMA busy_timeout=5000`；针对 `SQLITE_BUSY` 指数退避；集中写事务。若需要多服务实例，迁移 PostgreSQL。

### P1-3 异常请求 HTTP 语义错误并泄露内部错误细节

- 无效 JSON 返回 HTTP 500，应该为 400。
- 超过 2 MiB 请求体返回 HTTP 500，应该为 413。
- 统一 catch 将 `error.message` 作为 detail 返回（`src/server.js:1412`）。

**整改：** 定义 typed HTTP errors；统一返回 400/413/415/422；生产环境隐藏栈和内部 detail，日志用 request-id 关联。

### P1-4 创建与编辑知识的字段约束不一致

- `POST /api/knowledge` 接受 501 字问题和 5001 字答案。
- `PUT /api/knowledge/:id` 限制问题 500、答案 5000（`src/server.js:1132-1133`）。
- `Content-Type: text/plain` 仍会被当作 JSON 处理。

**整改：** 提取共享 schema 校验；创建、编辑、导入统一限制；强制 `application/json` 并返回 415。

### P1-5 五平台真实页面 RPA 回归保障不足

- 小红书适配器行覆盖率仅 13.13%；其他平台约 62%-76%。
- 本次为避免真实账号副作用，只执行模拟发布和回复；未对五个平台做真实最终发布。
- 页面 DOM、验证码、风控策略可能随平台变化，是剩余最大业务风险。

**整改：** 建立脱敏测试账号和发布沙箱；每日真实页面 smoke（停在最终提交前）+ 定期人工受控最终发布；保存 DOM fixture、截图、HAR；对 selector 建多候选、置信度和遥测告警。

### P2-1 恢复脚本提示语与提交锁语义不一致

- RUNNING 任务能恢复为 FAILED，回复任务能转 `MANUAL_REQUIRED`。
- 已经发生最终提交点击的目标会保留 `submit_lock=LOCKED` 和 `submit_attempted_at`，这是正确的防重保护。
- 但恢复结果统一提示“请重新提交”，对已锁定目标具有误导性，实际上系统会禁止安全重发。

**整改：** 按 `submit_lock` 和 `submit_attempted_at` 分类：未提交可重试；已提交未知则标记 `REVIEW_REQUIRED/UNKNOWN` 并提示人工核对平台。

### P2-2 大列表一次性返回，数据增长后会拖慢页面

- `/api/tasks` 响应约 358 KiB，`/api/messages` 约 240 KiB。
- 任务、消息、问题等历史记录增长后，网络、DOM 渲染和内存占用会持续增加。

**整改：** 所有列表统一服务端分页、筛选、排序和 total；前端使用虚拟滚动；仪表盘使用聚合查询而非拉全量。

### P2-3 SPA 导航和 HTTP 状态可用性

- 页面切换不更新 URL，刷新回到首页，不支持模块深链接和浏览器前进/后退。
- 目录穿越测试未泄露文件，但未知/非法静态路径统一返回首页 HTML 和 HTTP 200，不利于监控、缓存和错误定位。

**整改：** 使用 hash/history router；静态文件不存在返回 404，仅合法前端路由回退 index.html。

### P2-4 可访问性仍需补齐

优点：主要按钮有语义，主开关使用 `role=switch`，知识库切换有 tab 语义，关键按钮具备 focus-visible。

不足：侧栏当前项未设置 `aria-current`；tab 未见方向键 roving tabindex；弹窗虽支持 Escape，但未见完整 focus trap 和关闭后焦点恢复；建议补充 axe-core 自动扫描和键盘全流程回归。

## 5. 已验证的正向能力

1. 246 项测试全通过，核心流程不是“页面能打开”级别，而是覆盖发布、回复、幂等、开关、Agent 协议和 SQLite 闭环。
2. 发布前强制素材预检、文件 SHA 一致性、AI 审核和 READY 账号。
3. 相同账号、素材、文案重复创建会返回 409。
4. 最终提交动作设置 submit lock 和 attempt 记录，降低重复发布概率。
5. 自动回复缺少可信平台回执时，不会误报成功，而是转人工并生成问题记录。
6. 投诉/明确要求人工的消息正确转人工；无知识问题进入待补充知识并可审核发布。
7. SQLite 完整性正常，WAL 和 foreign_keys 已启用；生产依赖未发现已知漏洞。
8. 主要前端动态文本使用转义，本次存储型 XSS 探测未触发脚本。

## 6. 上线前整改门槛

### 必须完成（P0）

- 主服务鉴权、RBAC、Origin allowlist、默认 localhost 绑定。
- Agent token/签名认证和危险接口收敛。
- 轮换密钥、清理浏览器 Profile 会话、重新生成无敏感数据交付包。

### 建议试运营前完成（P1）

- 单实例锁 + SQLite busy timeout/retry。
- HTTP 错误分类、输入 schema 和 Content-Type 校验。
- 五平台真实页面 smoke 基线，尤其小红书。
- 备份、恢复、日志轮转和磁盘容量告警。

### 后续优化（P2）

- 大列表分页/虚拟化。
- URL 路由、404 语义、可访问性。
- SLO、指标、结构化日志、告警和性能压测自动化。

## 7. 最终判断

**业务安全状态机优于一般 MVP，但系统边界安全和部署工程化明显落后。** 在单机、单实例、可信网络、人工看护前提下，可以稳定演示和小范围试运营；在无鉴权局域网、多用户或直接暴露网络的条件下，不建议上线。

## 8. 证据文件

- `.tmp/qa-full-test-20260810.log`
- `.tmp/qa-coverage-20260810.log`
- `.tmp/qa-npm-audit-20260810.json`
- `.tmp/qa-adversarial-api-results.json`
- `.tmp/qa-field-results.json`
- `.tmp/qa-concurrency-results.json`
- `.tmp/qa-single-concurrency-results.json`
- `.tmp/qa-e2e-results-20260810.json`
- `.tmp/qa-workflow-closeout-results.json`
- `.tmp/qa-path-traversal-results.json`
- `.tmp/qa-agent-cors-results.json`
- `.tmp/qa-recovery-results.json`
- `.tmp/qa-recovery-locked-results.json`
- `.tmp/qa-sensitive-package-results.json`
- `.tmp/qa-storage-results.json`
