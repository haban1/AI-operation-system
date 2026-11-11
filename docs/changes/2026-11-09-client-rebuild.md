# 全系统前端精简重构

日期：2026-11-09（Asia/Shanghai）。状态：本机源码已应用、界面已部署；本轮未提交、未推送。

## 背景与目标

用户确认按此前精简预览重构正式前端，要求保留全部原有业务能力、后端接口与功能，最小化修改，不增加多余注释。验收重点是原操作、表单、状态及高级入口仍可使用，不能用预览中的示例数据替代业务页面。

## 变更与影响

采用原有渲染、路由、事件与 API 调用，仅调整导航、布局、样式和展示文案。统一深色薄荷绿主题，删除英文装饰、重复长介绍和推广干扰，高级信息按需展开。错误原因、来源、模拟状态、未配置、知识发布门控和结果待确认等信息保留。

| 范围 | 本轮文件与行为 |
| --- | --- |
| 主系统 | `public/index.html`、`public/app.js`、`public/wechat-admin.js` 和新增 `public/workspace.css`；八组主导航保留，浏览器控制、相似问法和问题记录可见；运行开关与服务状态移至侧栏“运行状态” |
| 当前内容创作 | `engines/video-studio/dist/index.html`、`style.css`；自动热点、混剪、共享素材库，以及六工作流、五制作模块、制作聊天/历史、目录与公司资产等全部保留，业务 `app.js` 逐字不变 |
| 自动热点 | `engines/ai-signal-studio/web/index.html`、`app.js`、`style.css`；精简标题、配置与说明，保留来源设置、生成、对比、评审、反馈、编辑、入库和下载 |
| 微信客服 | 12 个源码文件，覆盖外壳、机器人详情/列表、登录、MCP、技能、系统设置、主题和全局样式；原 13 个页面归入六个业务标签和设置分组，账号资料改抽屉，账号运维操作按需展开 |
| 兼容壳 | `public/video-workbench/index.html`、新增同目录 `workspace.css`；保留旧静态入口，不能将它当作当前生产内容工作台 |
| 回归 | 新增 `test/workspace-shell-ui.test.js`；两个已有 UI 测试改用 `textContent()` 检查折叠区域的动态状态，保留原值及陈旧响应隔离断言 |

总计应用 23 个前端源码/静态文件。微信构建产物同步至 UI 镜像，依赖、数据库、采集/回复/发布后端、配置及 Compose 文件未在本轮修改。操作位置见 [前端操作与功能入口](../frontend-workspace.md)。

## 决策与取舍

保留现有框架与业务实现，以独立主题和局部模板调整实现预览风格。未因预览页数创建多套业务页面，也未全局隐藏提示、状态或表单。设置卡片、全局开关和创作导航的窄屏文字出现过旧 CSS 叠加问题，已修复并加入实际可见性回归。

实查当前 `/video-workbench/*` 由 `src/server.js` 的 `videoStudioRequest()` 分派到 `engines/video-studio/server.mjs`，实际读取其 `dist/`。此前 main 已用同一制作助手替代旧 OpenChatCut/Toonflow 入口；本轮未改变这个架构，也未恢复旧编辑器覆盖新引擎。旧 `public/video-workbench/` 的验证只作为兼容参考。

微信原生页面、`App.tsx`/`AppRoutes.tsx` 与 150 处 API client 调用保持本轮基线不变。个人主题偏好保留；嵌入模式仍使用已有的固定主题规则。“回复设置”包含模型，“系统设置”仍是 Webhook/API 等配置，两者没有互换功能。

## 验证与证据

所有自动化交互使用隔离数据或模拟平台，不发送真实私信、评论、通知，不创建真实生成或发布任务。

| 验证 | 本轮实际结果 |
| --- | --- |
| 主系统前后对照 | 22 类页面/弹窗 × 1440/390，共 44 场景；关键控件、字段/选项、可见性、滚动可达性无退化，无新增溢出或页面异常；7 类模拟动作两版 method/path/body 一致。原报告另有 10 个旧创作壳场景，不计入当前生产覆盖 |
| 真实内容工作台 | 14 类 × 两尺寸，共 28 场景；两版各 6 项模拟写请求一致；88 个 DOM ID、34 组 data 合同、18 组 API 路径、52 个函数保留，业务 JS SHA 相同；4 种工具 × 两尺寸的内部滚动检查 8 项通过 |
| Signal | 97 个 ID、53 组控件属性不变；9 类模拟 POST 的动作、method、payload 一致；桌面/420 宽无新增溢出、无页面异常，JS 语法检查通过 |
| 微信 | eslint、TypeScript、构建通过，原有 6 项单测通过；隔离浏览器遍历 14 个导航节点（13 原页面加设置分组），20 次模拟 GET，0 页面异常、0 生产请求；已检查桌面与 720 宽入口 |
| 现有 UI/集成套件 | 11 文件初跑 64 项：59 通过、4 失败、1 跳过；其中 3 个失败为折叠区 `innerText()` 读取空值，调整断言后两个相关套件 12 项全部通过；Windows 符号链接权限导致的素材准入失败/跳过，在 Linux 补跑该文件 11 项全部通过 |
| 新响应式回归 | `node scripts/run-tests.mjs --test --test-concurrency=1 test/workspace-shell-ui.test.js`：最终应用后 2 通过、0 失败、0 跳过，覆盖导航中文、设置卡片、全局开关、真实制作/素材控件及工具状态滚动 |
| 创作引擎原测试 | Windows 因符号链接权限及绝对路径 ESM 限制失败；未修改后端绕过。Linux 中 `node --test engines/video-studio/test/studio.test.mjs engines/video-studio/test/outputs.test.mjs`：4 项全部通过 |
| 源码边界 | 本轮起始保存的 569 个后端/配置文件 SHA 全部未变；内容引擎应用前另保存的 7 个服务/运行时/依赖配置指纹亦未变 |
| 正式只读检查 | 健康、会话、bootstrap、RAG 状态/回答风格、微信、Signal、内容入口均 200；实际主样式及真实引擎 HTML/CSS/JS 的 MIME 与 SHA 均匹配应用文件，微信最终 JS 与 Signal 样式也匹配候选 |
| 部署及文档边界 | 五个非目标容器的镜像与启动时间保持原值，三个 UI 派生镜像均只比旧镜像增加一层前端文件；文档检查在独立临时 Git 索引通过，真实暂存区未改 |

现有套件命令：

```powershell
node scripts/run-tests.mjs --test --test-concurrency=1 test/navigation-performance-ui.test.js test/comment-post-list-ui.test.js test/mini-program-ui.test.js test/mini-program-connection-ui.test.js test/publish-layout-sync.test.js test/ai-model-settings-ui.test.js test/platform-analytics-ui.test.js test/rag-answer-profile-ui.test.js test/private-conversation-navigation.test.js test/wechat-workbench-integration.test.js test/content-library-admission.test.js
```

修正折叠区断言后只重跑 `ai-model-settings-ui.test.js`、`mini-program-ui.test.js`，没有把初跑与复跑数量累加。Linux 补验在现有 Web 容器执行，测试使用临时目录及模拟制作桥，不写业务库。原始对照、指纹、脱敏截图和日志保留于私有 `.codex-work/ui-rebuild-20261109/`，不能整批上传。

界面覆盖不等于全部第三方内部弹窗或真实平台业务验收。微信未对全部弹窗逐一做 390 宽检查。本轮没有重新验证抖音/微信真实收发、真实视频生成、素材审批或作品发布结果。

## 部署与回退

主系统 `public/` 为只读源码挂载，应用后立即生效。Signal 和微信仅用原镜像派生前端镜像，分别重建 Signal、robot-ui；业务后台、RAG、协议客户端和其他引擎未重启。

| 服务 | 新前端镜像 | 本轮旧镜像备份 |
| --- | --- | --- |
| Web 内置创作 UI | `tianhe-web:client-ui-20261109` | `tianhe-web:before-ui-20261109` |
| 自动热点 UI | `tianhe-signal:client-ui-20261109` | `tianhe-signal:before-ui-20261109` |
| 微信 UI | `tianhe-wechat-ui:client-ui-20261109` | `tianhe-wechat-ui:before-ui-20261109` |

派生镜像仅 COPY 前端文件，不重建依赖或修改后台。为沿用当前 Compose 引用，新镜像同时恢复到各服务原有镜像标签。Web 未重启：当前容器仍是原镜像 ID，真实创作目录热更新了两个静态文件；新派生镜像用于下次重建时保留界面。不能将标签更新误报为运行中 Web 已更换镜像。

本轮恢复入口：`.codex-work/ui-rebuild-20261109/apply-frontend.mjs --rollback` 恢复 21 个主/兼容/Signal/微信源码文件；`apply-engine.mjs --rollback` 恢复另两个真实创作文件，均先核对部署后指纹。若有后续修改，脚本会拒绝覆盖，需先人工合并。恢复运行容器时还需将 `backup/engine-container-dist/index.html`、`style.css` 复制回 Web 对应目录，并将各 `before-ui-20261109` 镜像恢复到服务原标签，再只重建 Signal 与 robot-ui。不要删除卷、恢复数据库或执行上轮 main 的整体回退。

部署前后账号/消息/会话数量一致，全局运行与自动采集开关保持原值；各平台启停状态未改。本机经局域网地址访问 3100/8080 正常，但没有使用另一台电脑独立验收。刷新界面建议 Ctrl+F5。

## 未完成与下一步

本轮界面已实现并部署，未提交、未推送。开发库存在大量先前改动，不能按当前 `git diff` 整体视作本轮成果；本轮准确范围以两份部署 manifest、微信 12 文件清单及三个测试文件为准。

用户后续要求 Git 交付时，先核验净化 checkout 的远端、分支和既有差异，只同步本轮明确范围与本文档/操作说明/交接入口；重新验证最终发布快照并执行文档检查。不能将原开发历史、业务数据库、私有证据或其他旧修复夹带推送。真实业务收发与发布如需验收，应另按具体账号与平台授权进行，不把模拟结果当作已真实成功。

## 上下文与关联

- [稳定交接入口](../development/handoff.md)、[Docs as Code 规范](../development/docs-as-code.md)、[前端操作入口](../frontend-workspace.md)。
- 上轮 main 部署的范围和回退独立记录于 [main 部署记录](2026-11-09-main-deployment.md)，其中“预览尚未替换”是该次部署时的历史事实。
- 设计参考为净化源码 checkout 中的 `design/client-simplification-20261109/`。本轮私有工作目录含 `deployment-manifest.json`、`engine-deployment-manifest.json`、`wechat-changed-files.json`、两个 source guard、`evidence/parity/`、`evidence/engine-parity/`、`signal-validation.json`、`wechat-browser-validation.json` 与 `evidence/live-final.json`。
- 公开 Git 交付继续遵循 [源码仓库说明](../GitHub源码仓库说明.md)，不推送原开发历史。
