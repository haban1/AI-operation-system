# 2026-11-05：建立 Docs as Code 与 Agent 交接规范

日期：2026-11-05（Asia/Shanghai）
状态：规范、skill 与检查实现完成，本地验证通过；尚未提交或推送。
基线：开发仓库 `main` / `ef4375b`；本轮开始时索引为空，已有多项业务改动。

## 背景与目标

用户要求以后 Git 上传除 commit message 外，必须同时提供相关文档、完备信息与上下文，方便其他 agent 继续。现有交接文件混有多个“最新”入口和旧状态，未建立逐提交检查。

目标是将要求持久化为项目规则、可复用 skill、稳定交接入口和 Git/CI 检查；保留原有业务工作树，不替用户选择或执行远端上传。

## 变更与影响

新增根 `AGENTS.md`、[规范](../development/docs-as-code.md)、[稳定交接](../development/handoff.md)、[skill 及模板](../../.agents/skills/docs-as-code-handoff/SKILL.md)、PR 模板、检查脚本、hooks 与 GitHub Actions。README 和历史交接顶部改为指向稳定入口。

本机另安装个人 skill 副本并写入个人 `AGENTS.md` 约定，外层工作区增加指向实际 Git 根的入口；这些机器级文件不属于仓库提交。仓库中的 skill 和规则是跨机器交付的来源。

每个提交需同时带结构完整的变更记录，受影响的使用/接口/部署文档同步更新。本轮没有改变产品行为、配置值或业务数据。

## 决策与取舍

采用 Write the Docs 的版本控制、评审和自动检查原则，重要架构决策采用 ADR；未直接安装带 Java/审批假设或额外 CLI 依赖的第三方 skill，来源与判断见 [规范来源](../development/docs-as-code.md#规范与-skill-来源)。

每个任务独立写变更记录，状态变化再更新稳定入口，以减少并行 agent 对同一大文件的冲突。检查索引/提交内容，避免未暂存的文档冒充已经交付。历史提交不追溯补造文档，测试和业务事实仍须人工/agent 语义审查。

## 验证与证据

- `node --test test/docs-as-code.test.mjs`：22/22 通过。隔离 Git 仓库覆盖缺记录、真实原模板占位、未暂存文档、纯文档提交、逐提交范围、旧历史、新分支/更新/删除、缺基线、现有 hooks 保护、当前 checkout 隔离及真实 pre-commit 阻断。首次采用时只暂存代码、带记录删除规范也被拒绝。
- `node --check scripts/check-docs-as-code.mjs` 与 `node --check scripts/install-docs-hooks.mjs`：通过。
- `skill-creator/scripts/quick_validate.py`：本仓库与已安装的个人 skill 副本均输出 `Skill is valid!`；使用本机 Python 3.12，PyYAML 仅安装到忽略的临时验证目录。
- 在独立 `GIT_INDEX_FILE` 中基于 HEAD 仅加入本轮 21 个仓库文件，再运行 `node scripts/check-docs-as-code.mjs --staged` 与 `git diff --cached --check`：通过，真实索引未改。检查了本轮新增的 37 个相对文档链接，其目标均存在于该交付索引，而非仅存在于未跟踪的本机文件。
- GitHub Actions / skill metadata 的 YAML 可解析、hooks 使用 LF；仓库与个人 skill 四个文件逐字节一致。`node scripts/install-docs-hooks.mjs` 在当前开发 checkout 安装成功，`core.hooksPath` 来源为 `.git/config.worktree`。

业务全量测试、真实平台验收和远程 GitHub Actions 未执行；本轮结论仅覆盖规范、文档结构和本地 Git 检查行为。

## 部署与回退

没有产品部署、数据迁移或服务重启。当前开发 checkout 已启用 hooks；新克隆和发布工作区仍须通过 `node scripts/install-docs-hooks.mjs` 安装，GitHub Actions 随规则上传后生效。

移除本地 hooks 配置前先确认当前值确为本规范设置，且无其他用户配置；`git config --worktree --unset core.hooksPath` 撤销当前 checkout 覆盖，不删除钩子文件或其他 checkout 配置。本次安装在共享 Git 配置启用了 `extensions.worktreeConfig`，回退 hooks 时保留该扩展，避免影响其他 worktree 的配置。撤销规范文件应以正常反向提交保留历史，本轮未触碰既有业务修改。

## 未完成与下一步

后续获实际 Git 交付指令时，将明确范围的源码、关联文档和本套规范同步到净化发布工作区，再针对最终快照验证、检查、提交和上传；当前未提交、未推送。当前开发目录的首次提交必须把规范、稳定交接和完整变更记录一同纳入索引，未暂存的本轮文档不能满足 hooks。

新机器或其他发布工作区须自行安装 hooks；分支保护尚未设置。文档检查不能验证陈述的真实性，也不代替相应业务测试。

## 上下文与关联

下一 agent 从 [当前交接](../development/handoff.md) 和 [AGENTS.md](../../AGENTS.md) 开始，再看具体任务 diff。模板位于 `.agents/skills/docs-as-code-handoff/assets/`，每个提交的记录路径为 `docs/changes/YYYY-MM-DD-<topic>.md`。

公开发布必须遵循 [净化源码规则](../GitHub源码仓库说明.md)，不能从这个含旧业务数据历史的开发仓库直接推送。记录里的基线只用于追溯，本轮实际提交哈希应在未来提交成功后从 Git 获取。
