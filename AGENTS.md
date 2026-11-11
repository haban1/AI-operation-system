# 开发上下文与交接

开始开发先读 `dev-notes/README.md`、`dev-notes/POLICY.md` 和当前分支最近相关记录。
业务规则入口为 `START_HERE_NEXT_CODEX.md`，历史交接中的目录、状态和提交号以当前
代码与新任务授权核实，不覆盖协作者的工作区或生产数据。

提交、修改提交或推送前使用 `repo-context-handoff` skill；不可用时读取
`/Users/jy/.agents/skills/repo-context-handoff/SKILL.md`。若本机也无该文件，使用仓库内
`.agents/skills/docs-as-code-handoff/SKILL.md`，并继续遵守 `dev-notes/POLICY.md`。
每次提交维护 `dev-notes/changes/`，记录背景、理由、改动入口、实际验证、遗留问题和
下一步，与代码同次提交。开发记录不得进入镜像、安装包和非开发运行环境。

本规范不授权 commit、push、部署、真实平台收发或改写历史，也不代表 CI 已强制所有
贡献者执行。保留知识测试/发布/回滚、会话快照、人工接管、权限和发送幂等边界。

## 可移植的文档交付检查

用户要求后续 Git 交付携带相关文档、验证与接手上下文。`dev-notes/README.md` 仍是
开发记录入口；补充检查规范见 `docs/development/docs-as-code.md`，每次提交同步维护
`docs/changes/` 记录并在提交前运行 `node scripts/check-docs-as-code.mjs --staged`。
新克隆可运行 `node scripts/install-docs-hooks.mjs`，只为当前 checkout 安装钩子。
保护既有改动，只暂存本次路径；明确区分已修改、已提交、已推送和已部署。

## 本机源码同步与当前入口

2026-11-11 当前界面和知识库入口以 `docs/development/handoff.md`、`docs/frontend-workspace.md` 与 `docs/knowledge-files.md` 为准；下方及旧历史中的知识审核/发布/回滚入口已被本轮用户确认的文件自动生效流程替代，内部索引快照与渠道发送边界仍保留。继续遵循 `dev-notes/POLICY.md` 和仓库内 `docs-as-code-handoff` skill，源码同步不得合入含业务数据库的旧开发历史。新提交同时维护两处规范要求的变更记录。
