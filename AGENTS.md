# 开发上下文与交接

开始开发先读 `dev-notes/README.md`、`dev-notes/POLICY.md` 和当前分支最近相关记录。
业务规则入口为 `START_HERE_NEXT_CODEX.md`，历史交接中的目录、状态和提交号以当前
代码与新任务授权核实，不覆盖协作者的工作区或生产数据。

提交、修改提交或推送前使用 `repo-context-handoff` skill；不可用时读取
`/Users/jy/.agents/skills/repo-context-handoff/SKILL.md`。
每次提交维护 `dev-notes/changes/`，记录背景、理由、改动入口、实际验证、遗留问题和
下一步，与代码同次提交。开发记录不得进入镜像、安装包和非开发运行环境。

本规范不授权 commit、push、部署、真实平台收发或改写历史，也不代表 CI 已强制所有
贡献者执行。保留知识测试/发布/回滚、会话快照、人工接管、权限和发送幂等边界。
