# 总览平台名称使用真实账号昵称

## 背景与目标

用户要求总览 AI 数字员工列表使用当前登录账号名称；未登录时只显示平台。原列表直接显示 display_name 手工标签，可能与实际账号不一致。

## 变更与影响

public/workspace-presentation.js 在 login_status=READY 且 platform_user_name 非空时显示“昵称 · 平台”，其他情况只显示平台名称。已暂停但仍 READY 的账号保留昵称；UNKNOWN、EXPIRED、DISABLED 等状态不显示历史昵称。昵称继续使用 textContent 写入。public/app.js 的模块版本和 public/index.html 的入口版本同步更新。

## 决策与取舍

复用既有身份字段，不把手工标签或历史运营快照当作当前昵称，也不新增查询和登录动作。登录状态、后台开关、数据采集和账号配置保持原逻辑；昵称缺失时显示平台，不猜测账号名称。沿用总览现有后台刷新与原位更新逻辑。

## 验证与证据

node --test test/background-refresh.test.js test/workspace-presentation-ui.test.js：23 项通过。私有 Playwright 核验四个场景（1440/390 宽、日间/夜间），覆盖真实昵称显示、过期/不确定状态隐藏历史昵称、缺失昵称回退平台、暂停但已登录仍显示昵称，以及后台刷新同步昵称变化；无页面异常或横向页面溢出，无业务写请求。

实际 3100 总览与 bootstrap 名称逐项一致，三个线上资源 HTTP 200、SHA256 与本机文件一致，Web/RAG 镜像和启动时间不变。当前 B站 READY 但 platform_user_name 为空，实际只显示“B站”；本轮没有把这标为昵称采集成功，也没有触发真实平台登录或身份采集。证据在 .codex-work/dashboard-account-name-20261112/ 的 tests.log、validation.json、verification.log 和四张模拟昵称截图。

## 部署与回退

已通过现有 public bind mount 应用本机，无服务重启。原三个前端文件在私有工作目录 backup/public/；回退只恢复这三个文件或对应差异，不恢复数据库及其他工作树改动。

## 未完成与下一步

已修改、已应用，未提交、未推送。用户刷新总览即可看到；接口尚未提供真实昵称的平台保持只显示平台，后续正常身份采集回填后会随总览刷新出现昵称。若另行处理昵称采集，应先排查该平台已有身份采集链路，不能直接填入手工猜测名称。

## 上下文与关联

[前端入口](../frontend-workspace.md)、[稳定交接](../development/handoff.md)、[后台更新](2026-11-12-dashboard-refresh-flicker.md)、[Docs as Code](../development/docs-as-code.md)。后续 Git 交付沿用净化 checkout，不能从当前私有开发历史直接推送。本轮只改变总览列表显示，不改变其他页面的账号管理标签。
