# 全系统精简预览与源码交付

时间：2026-11-09，Asia/Shanghai。分支：`main`。

## 背景与目标

用户要求全系统界面更简洁，先提供支持翻页的预览，不修改实际平台；完成后拉取 GitHub
最新内容、合并并提交。本轮在独立净化源码 checkout 交付，不混入开发目录的既有改动。

## 变更与影响

新增 [44 页设计目录](../../design/client-simplification-20261109/README.md)，包含图片图册、
自包含交互预览、页面目录、44 张截图、总览、源文件与脱敏验证记录，覆盖八大模块。
去掉装饰性标题和重复说明，保留核心操作、异常与确认边界。全部为人工示例。

同步仓库内 Docs as Code skill、模板、检查器、22 项测试、可选 checkout 专属钩子和 CI，
保留上游 `dev-notes` 为权威入口。补充 Git archive 的开发资料排除；未改业务代码或运行配置。

## 决策与取舍

目标仓库为 `haban1/AI-operation-system`，其 `main` 从 `631bf45` 快进至
`ab8e7b4`，纳入上游 5 个提交，无冲突。原开发仓库历史含运行数据，不能合入公开历史；
因此仅在既有净化源码 clone 上新增本轮文件。用户授权本地提交，本轮不推送或部署。

新上游引用的 `repo-context-handoff` skill 及备用路径在本机均不存在；使用已有的
`docs-as-code-handoff`，将仓库相对路径补作可移植 fallback，仍遵守 `dev-notes/POLICY.md`。
七节记录由检查器校验，`dev-notes/changes/` 保留本次集成上下文与链接，避免复制整份业务历史。

不将本机生成器、源文件指纹和重复 ZIP 纳入源码。提供相对路径构建脚本重建交互 HTML；
移除源码预览中依赖未提交 ZIP 的入口，README 提供离线打包方法。

## 验证与证据

环境：Windows、Node.js v24.22.1。以下为本轮实际结果：

- `node design/client-simplification-20261109/build.mjs` 成功；交互页及图册内联脚本、
  `node --check design/client-simplification-20261109/preview.js` 和文档检查器语法均通过。
- 44 个唯一页面、目录与截图标题一致；44 张 JPG 共 2,374,617 字节，与已验收预览逐张
  SHA-256 一致。最终两份 HTML 与原浏览器验收版本比较，仅去掉 ZIP 下载链接；本地资源存在，
  CSP 禁止接口连接和表单提交。未发现新增资料内的本机 Windows 绝对路径及常见密钥形式。
- 已有浏览器验收见设计目录 `validation.json`、`capture-audit.json`：44 页无缺图与横向溢出，
  导航、翻页、目录选择、末页边界、任务筛选、模拟回复正常，控制台无错误。源码交付副本
  未重复执行全部浏览器步骤；通过内容比对确认与验收版本的差异范围。
- `node --test test/docs-as-code.test.mjs`：22 passed，0 failed，0 skipped，27.62 秒。
  已运行安装器，只为当前 checkout 设置文档钩子。CI 尚未运行，分支保护未配置。
- `node scripts/check-docs-as-code.mjs --staged` 和暂存区 `diff --check` 通过。
  新增说明中的 30 个相对链接存在；原平台 4 个前端文件哈希仍与只读基线一致。
  提交前再次 `git fetch origin`，`HEAD...origin/main` 为 `0 0`，上游仍是 `ab8e7b4`。

本轮不改业务实现，未运行全仓业务测试、真实平台采集/回复或生产模型验证。
桌面截图不代表手机布局验收，第三方编辑器仅预览关键工作区。

## 部署与回退

仅本地设计交付，无平台部署、数据库迁移或服务重启。Docker 根 context 为 deny-all，
只允许明确产品目录；主 Dockerfile 显式 COPY，设计目录与开发记录不会进入主服务 context。
Windows 安装器也按明确产品目录和安装说明复制，不包含本轮设计、规则或记录。
现有流水线未发现整库发布/生产原地拉取；本轮只新增文档检查工作流。
以上为配置审查，不等同于最终 Docker/Windows 产物验收；本轮未重建正式部署产物。
另外，使用暂存树的真实 `.gitattributes` 对本轮设计和开发资料的选定路径执行 Git archive：
归档 58 个成员，包含全部 44 张截图，不含 `dev-notes`、`AGENTS.md`、skill、钩子及
`docs/development`、`docs/changes`。这是选定路径归档验证，不代表整库最终部署包验收。

撤销设计时仅删除本设计目录与相应索引链接；撤销文档钩子可运行
`git config --worktree --unset core.hooksPath`。已共享的提交如需撤销用后续 revert，不能重写历史。

## 未完成与下一步

精简方案尚未实施到实际平台。下一步请用户审阅全系统图册并明确需要落地的页面及交互范围，
再按业务模块实施与验证。推送、部署和真实渠道收发不在本轮操作范围。
当前提交号及是否领先远端应以 `git status` 和 `git log` 为准，不在本记录中自引用未知 SHA。

## 上下文与关联

接续入口：[dev-notes/README.md](../../dev-notes/README.md)、
[本次集成记录](../../dev-notes/changes/20261109-client-simplification-preview.md)、
[补充检查规范](../development/docs-as-code.md)、
[可移植 skill](../../.agents/skills/docs-as-code-handoff/SKILL.md)。
原平台源码、数据、登录态及其他任务改动原样保留，不纳入这次净化源码提交。
