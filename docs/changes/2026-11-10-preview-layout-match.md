# 按精简预览进一步对齐正式前端布局

日期：2026-11-10（Asia/Shanghai）。状态：35 个前端文件与 9 个测试/辅助文件已在本机应用，三处运行前端静态目录已热更新；66 项在线静态资源、9 项路由及容器状态核验通过。本轮未提交、未推送。

## 背景与目标

用户要求在保留原有全部功能和后端接口的前提下，按全系统 44 页精简预览重新构建正式前端，并指出上一轮布局与预览仍有较大差异。本轮进一步调整信息结构、默认页面、卡片、表格、分栏与次要说明，保留原业务处理、表单、状态、确认和高级入口，采用最小范围的前端重排。此前六项无数据源指标继续隐藏，有效零值及真实统计保留。

## 变更与影响

八组主导航保留。此前混在同页的发布内容/排期、知识资料/发布版本、AI 服务/消息通知/调用记录改为独立展示入口，继续复用原页面、事件和 API。操作位置见 [前端操作与功能入口](../frontend-workspace.md)。

| 范围 | 本轮内容 |
| --- | --- |
| 主系统 7 文件 | `public/index.html`、`app.js`、`hot-topic-studio.js`、`workspace.css`，新增 `workspace-presentation.js`、`workspace-interactions.js`、`workspace-interactions.css`；总览调整为核心指标、运营数据、发布分布、待办和最近发布；发布页左右分栏，知识资料/发布版本与三项系统设置分别展示；互动页列表与详情、次要信息按需展开 |
| 真实内容引擎与 Signal 6 文件 | 两个引擎各自的 `index.html`、`app.js`、`style.css`；六个创作入口、三路线首页与真实最近成片，热点/自主选题/对比/详情子栏、左列表右设置、模型与配音双栏；原制作、素材、确认、发布、下载、评审和反馈功能保留 |
| 微信前端 22 文件 | 人工接待队列/详情、群发编辑/接收人两栏、联系人紧凑列表、人设正文/列表、八项设置导航、回复配置两栏及紧凑 MCP/技能；复用原完整组件，账号管理、登录态、运维、历史与确认操作保留 |
| 测试与辅助 9 文件 | 适配 8 个测试/辅助文件以进入折叠区域，新增 `test/workspace-presentation-ui.test.js`；继续检查原动作与字段，补充展示入口、素材回填、加载失败与标题隔离回归 |

合计 35 个前端源码/静态文件。本轮没有修改采集、回复、生成、发布后端、API 定义、数据模型、业务配置或依赖，也没有改变已有运行开关。开发工作树包含其他历史改动，不能将全部 `git diff` 视为本轮范围。

## 决策与取舍

原业务 DOM、处理函数和请求继续复用，以展示适配层移动节点、分组或折叠次要信息；不因视觉预览增加无接口支持的按钮、数据或配置。错误、未配置、来源、准入/发布结果待确认、转人工和重试状态保留。折叠区域继续挂载原控件，恢复展开后沿用原事件。

当前 `/video-workbench/*` 由 `src/server.js` 分派到 `engines/video-studio/server.mjs`，真实静态目录是该引擎的 `dist/`，不是 `public/video-workbench/`。正式架构已将旧时间线/分镜画布替换为制作助手；本轮“素材智剪”“AIGC 创作”复用真实助手、六种工作流、五个模块、素材上下文和会话历史，未恢复没有现存后端能力的旧编辑器，也未复制预览示例数据。首页最近成片来自现有接口，卡片仍可预览、确认、下载和去发布。

Signal iframe 保持挂载，切换创作页面时保留未提交主题、模型字段和制作草稿。子页标题仅接收同源且来自对应 iframe 的消息，隐藏子页不会抢占其他页面标题。

微信人工接待 API 当前只提供会话最新消息，因此展示真实队列及最新消息，不虚构多轮聊天或增加没有发送接口的输入框；人工回复仍在微信客户端进行。模型配置仍在“回复设置”，Webhook/API/通知仍在“系统设置”。原字段、API 调用、群发确认、防重复锁和结果核对均保留。

## 验证与证据

浏览器交互采用本机真实 Chrome、隔离数据库及模拟 API；写请求均被隔离或拦截，没有真实发送私信、评论、微信消息、通知，没有真实生成或发布素材。

| 验证 | 实际结果 |
| --- | --- |
| 后端与配置边界 | `source-guard.mjs` 的 569 个后端/配置文件指纹、`engine-source-guard.mjs` 的 7 个引擎服务/运行时/依赖配置指纹全部未变 |
| 正式 UI 套件 | 11 文件共 55 个唯一样例最终全部通过、0 跳过；初跑一个测试因保存后详情重新折叠而失败，补充展开动作后该例复跑通过，业务实现未为测试改动；不将复跑重复计入总数 |
| 新展示回归 | `test/workspace-presentation-ui.test.js` 5 项通过，涵盖新展示入口及素材/模型/标题相关状态 |
| 主系统前后对照 | 44 个页面/弹窗场景，7 类模拟写动作 method/path/body 前后一致；随后针对主系统修正复查 22 个场景，0 回归 |
| 默认布局截图 | 13 类默认页面 × 桌面/390 宽共 26 场景，0 页面异常、0 横向溢出 |
| 真实内容引擎 | 28 对旧页面场景，原控制可达、字段选项、业务 ID/data 属性及接口保持；两版各 6 个模拟写动作合同一致 |
| Signal | 97 个原 DOM ID、原表单字段属性保留，9 类模拟 POST 动作及正文前后一致，桌面/手机无页面异常或横向溢出 |
| 六个创作入口 | 桌面/390 宽共 12 场景通过；验证首页真实卡预览/确认/发布事件、原筛选与草稿保留、iframe 不重建、设置往返及子页标题同步 |
| 微信 | ESLint、TypeScript、构建及 6 项原单测通过；15 个业务/设置页面在 1440/720/390 三视口通过；150 处 API client 调用/参数树及 44 个回复设置字段一致；接待设置、恢复 AI、主动接管和带图片群发的模拟合同及确认/防重复流程通过 |
| 文档交付检查 | 对明确源码、测试与关联文档使用隔离 Git 索引运行 `node scripts/check-docs-as-code.mjs --staged` 通过；真实暂存区保持为空，未提交/推送 |
| 在线只读检查 | 9 个健康/认证/bootstrap/RAG/前端路由与两个局域网入口返回 200；66 项主壳/引擎/Signal/微信静态资源均返回 200 且 SHA 匹配（Signal HTML 按既有服务行为替换 base-path 并归一换行）；31 个容器启动时间和运行镜像 ID 未变，原健康容器仍健康；运行开关和三项业务数量前后一致；三个派生镜像各仅增加一个静态文件层，配置及原层不变 |

本轮主要命令：

```powershell
node .codex-work/ui-preview-match-20261110/source-guard.mjs
node .codex-work/ui-preview-match-20261110/engine-source-guard.mjs
node .codex-work/ui-preview-match-20261110/verify-ui-parity.mjs
node .codex-work/ui-preview-match-20261110/verify-interaction-qa.mjs
node .codex-work/ui-preview-match-20261110/verify-main-layout.mjs
node .codex-work/ui-preview-match-20261110/verify-engine-parity.mjs
node .codex-work/ui-preview-match-20261110/signal-ui-check.mjs
node .codex-work/ui-preview-match-20261110/creative-entry-check.mjs
node .codex-work/ui-preview-match-20261110/audit-wechat-source.cjs
node .codex-work/ui-preview-match-20261110/verify-wechat-ui.cjs
```

可在当前源码复跑正式回归：

```powershell
node scripts/run-tests.mjs --test --test-concurrency=1 test/navigation-performance-ui.test.js test/comment-post-list-ui.test.js test/mini-program-ui.test.js test/mini-program-connection-ui.test.js test/publish-layout-sync.test.js test/ai-model-settings-ui.test.js test/platform-analytics-ui.test.js test/rag-answer-profile-ui.test.js test/private-conversation-navigation.test.js test/wechat-workbench-integration.test.js test/workspace-shell-ui.test.js test/workspace-presentation-ui.test.js
```

正式套件命令与去重结果位于本机证据 `evidence/formal-ui-regression-summary.json`；原始日志、截图、前后合同、候选与备份保留于私有 `.codex-work/ui-preview-match-20261110/`，不能整批上传。本轮没有重新验收抖音/微信真实收发、真实模型生成、素材审批或作品发布；截图中的隔离数据不能替代真实业务结果。

## 部署与回退

主系统 `public/` 通过既有源码挂载生效，Web 内置创作引擎、Signal、微信前端三处运行静态目录已热更新。所有容器均未因本轮部署重启。三个持久派生镜像已构建，并同时标记到现有 Compose 引用的标签，供后续正常重建使用；这不代表运行中的容器已切换镜像 ID。

| 服务 | 本轮派生镜像 | 本轮旧镜像备份 |
| --- | --- | --- |
| Web 内置创作 UI | `tianhe-web:preview-match-20261110` | `tianhe-web:before-ui-20261110` |
| 自动成片 UI | `tianhe-signal:preview-match-20261110` | `tianhe-signal:before-ui-20261110` |
| 微信 UI | `tianhe-wechat-ui:preview-match-20261110` | `tianhe-wechat-ui:before-ui-20261110` |

本轮源码清单与指纹见本机 `deployment-manifest.json`，测试文件见 `test-deployment-manifest.json`，镜像标签见 `image-tags.json`；三个运行目录部署前备份在 `backup/runtime/`。回退入口为 `node .codex-work/ui-preview-match-20261110/apply-frontend.mjs --rollback`，先核对本轮应用后指纹再恢复对应 35 个前端源文件，若有后续改动脚本会拒绝覆盖。测试文件按独立 manifest/备份恢复。

运行目录还需分别恢复 `backup/runtime/web/`、`signal/` 与 `wechat/` 对应静态文件，并将 `before-ui-20261110` 恢复到 `image-tags.json` 所列 Compose 原标签，保证下次重建也使用回退版本。本段为未执行的回退步骤；无需恢复数据库、删除卷或执行上轮 main 的整体回退。运行微信目录备份为 `backup/runtime/wechat/dist/`。复制目录时使用目录内容（源路径 `/.`）并最后恢复入口 HTML，避免形成 `static/static/`；本轮已修正该复制问题，66 项正式资源最终核验通过。回退脚本与运行目录恢复均须先检查是否存在后续修改，不覆盖后来的工作。

## 未完成与下一步

前端修改、测试、静态热更新与最终只读核验均已完成，Git 提交/推送尚未执行。下一步由用户直接在系统中核对操作体验；如需后续调整，继续以真实功能与该预览为基准，仅修改明确范围。

如交付 Git，按 [源码仓库说明](../GitHub源码仓库说明.md) 在净化 checkout 中只同步本轮明确文件与相关文档，核验远端/分支、最终快照及文档检查；不上传原开发历史、业务数据库、配置秘密、私有证据或其他旧修复。真实平台收发/生成/发布如需验收，应按具体账号和动作另行开展，不能把模拟合同通过表述为真实业务已成功。

## 上下文与关联

- [稳定交接入口](../development/handoff.md)、[Docs as Code 规范](../development/docs-as-code.md)、[前端操作入口](../frontend-workspace.md)。
- [上一轮精简重构](2026-11-09-client-rebuild.md) 是本轮基线；[隐藏未接入指标](2026-11-10-hide-pending-kpis.md) 的既有行为继续保留。
- 设计参考为净化源码 checkout 的 `design/client-simplification-20261109/`，本轮只对齐真实能力支持的结构与视觉，预览中的演示内容不是业务合同。
- 本机交接包括 `deployment-manifest.json`、`test-deployment-manifest.json`、`creative-manifest.json`、`wechat-source-manifest.json`、`wechat-dist-manifest.json`、`image-tags.json`、两个 source guard、`evidence/`、`creative-ui-audit.md` 与 `audit-wechat.md`；这些是私有定位入口，不随公开源码上传。
