# 2026-11-10：发布内容改为三步操作

日期：2026-11-10（Asia/Shanghai）

状态：已修改并应用，未提交、未推送。

基线：开发目录 main，HEAD ef4375b；工作树混有其他任务修改，本记录仅覆盖发布页步骤调整。

## 背景与目标

用户反馈发布内容页排版混乱，希望操作具有步骤感。将原先同时展示的素材、文案、平台及发布设置整理为逐步流程，保持现有接口、预检、审核和发布能力。

## 变更与影响

- 新增 `public/publish-flow.js`：编辑内容、选择平台、检查并发布三步；顶部切换、底部继续/返回，保留输入与账号选择。
- `public/workspace-presentation.js` 在原发布布局整理后调用新模块；`public/app.js` 仅更新该展示模块的缓存版本。本轮没有修改发布请求、后台执行或接口实现。
- `public/workspace.css` 增加发布表单范围内的样式，桌面分列编辑、窄屏单列；`public/index.html` 更新主脚本与样式缓存版本。
- 不可用账号及原因折叠；末步展示标题、账号与提交方式摘要。默认仍为草稿模式，明确勾选自动提交后按钮显示“确认发布／定时发布”，避免误解。
- 原素材库、本地上传/路径、AI 文案、全选、预检、审核、警告确认、定时弹窗和失败重试保留。详见 [操作入口](../frontend-workspace.md)。

## 决策与取舍

移动原 DOM 控件并保留 ID、名称、业务事件及表单，减少重写风险；没有新建业务状态或接口。步骤与控件事件局限于当前表单，无新增全局监听器、轮询或 observer。

下一步检查内容必填项及至少一个可用账号；顶部允许直接核对任一步骤。原生表单校验会自动切到缺失项并展开本机路径，隐藏控件不会导致无法聚焦。前两步按 Enter 只继续流程；最终提交沿用原预检、AI 审核和警告门禁，不默认继承重试任务的自动发布授权。

## 验证与证据

在 Windows、Node.js 24、本机 Chrome 的隔离服务中执行：

```powershell
node --check public/app.js
node --check public/workspace-presentation.js
node --check public/publish-flow.js
node --test test/publish-flow-ui.test.js test/publish-layout-sync.test.js test/workspace-presentation-ui.test.js test/content-library-picker.test.js test/scheduled-publish.test.js test/publish-content-evidence.test.js
```

上述命令最终 25 项通过、0 失败、0 跳过。专项及相关回归覆盖三步切换、必填项定位、Enter 不提前提交、草稿与排期保留、账号全选/禁用、素材预检竞态、审核失败/阻断/警告、AUTO/DRAFT_ONLY 载荷、定时发布、素材库带入和失败重试。1440/390 宽度三步共六张截图检查了排版与按钮边界。所有专项 UI 写请求均由 mock 响应，外站请求阻断；后端定时测试使用临时数据库和模拟适配器，未执行真实平台投稿或调用真实模型。

另执行 `test/workspace-shell-ui.test.js`，两项在进入 `aliases` 导航时超时：工作区同期其他修改已经移除该入口，本轮不恢复或覆盖它，也不将全系统导航测试报告为通过。最初应用因并发改动触发 SHA 保护而中止，重新核对发布业务区代码一致后只在最新主脚本上更新展示模块引用；预检回归的入口按新可见步骤调整，竞态断言保留。

主系统 3100 的五项 HTML/CSS/JS 资源 HTTP、MIME 与本地 SHA 一致。私有截图、线上校验、备份及应用清单在 `.codex-work/publish-steps-20261110/`，不上传。后端/配置指纹检查检测到同期知识库清理任务的外部变动，已保留路径和散列差异，因此不宣称整个工作区后端指纹始终不变；本轮实际写入范围为五个前端文件、两个测试及测试辅助文件和三份文档。

使用独立 Git 索引运行 `node scripts/check-docs-as-code.mjs --staged` 结构检查通过，真实暂存区未改变；该检查不代表当前混合工作树已经整理为可上传的发布快照。

## 部署与回退

通过现有 `public/` 只读 bind mount 生效，未重启服务、修改配置或数据库。浏览器刷新后加载新缓存版本。独立微信 8080 不承载主系统这组静态资源。

回退前比对私有 `applied.json` 的 SHA；无后续修改时恢复 `backup/public/` 四个原文件，移除新模块，再刷新浏览器。有后续修改时仅撤回新模块引用、调用、追加样式及缓存版本，不整体覆盖；初始备份另存 `backup-initial/`，其中旧知识库内容不能用于覆盖同期新修改。

## 未完成与下一步

本轮未以真实账号发布内容，也未重新验收整个系统全部导航；`aliases` 导航测试应随对应知识库清理任务更新。下一接手者先核验实际工作树与线上资源，再按用户选择的内容和账号执行真实业务验收。

尚未提交或推送。本开发历史含真实业务数据，后续交付按净化源码流程逐文件审查，不能整体上传现有工作树或旧 Git 历史。

## 上下文与关联

- [当前交接入口](../development/handoff.md)、[Docs as Code](../development/docs-as-code.md)。
- [前端操作入口](../frontend-workspace.md)、[源码发布边界](../GitHub源码仓库说明.md)。
- 专项测试：`test/publish-flow-ui.test.js`；步骤/折叠操作辅助：`test/helpers/ui-details.js`；预检生命周期回归：`test/publish-layout-sync.test.js`。
- 正式模块：`public/publish-flow.js`，仅负责界面流程；原 payload 与审核门禁继续由 `public/app.js` 的 `buildPublishRequestPayload()` 负责。
