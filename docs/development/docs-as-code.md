# Docs as Code 与 Git 交付规范

生效日期：2026-11-05。用户明确要求以后的 Git 上传同时交付相关文档、完备信息和上下文，使其他 agent 可以继续。

## 每个提交的交付内容

代码、配置、测试与相关文档是同一交付单元，进入同一个 commit。每个非空提交都新增或实质更新 `docs/changes/YYYY-MM-DD-<topic>.md`；纯文档、依赖、重构与合并提交也说明原因和验证。不能通过空文档、只改日期或重复“已完成”满足要求。

每份变更记录包含七个二级标题：`背景与目标`、`变更与影响`、`决策与取舍`、`验证与证据`、`部署与回退`、`未完成与下一步`、`上下文与关联`。短任务每节一两句话即可；不适用的部分写明原因。使用 [变更记录模板](../../.agents/skills/docs-as-code-handoff/assets/change-record.md)。

| 变更类型 | 同步维护的内容 |
| --- | --- |
| 用户可见行为、界面 | 相应操作说明、适用条件、前后行为与必要截图 |
| API、消息流、数据模型 | 接口合同、字段/兼容性、迁移与回退 |
| 环境变量、依赖、容器、部署 | 无敏感值的配置示例、启动方式、验证及恢复说明 |
| 重构、测试、文档修正 | 变更理由、影响范围、实际检查及局限 |
| 重要架构决策 | ADR 或现有设计文档中的理由、取舍和后果 |

业务事实只维护在相应主题文档；变更记录通过链接关联。架构决策可用 [ADR 模板](../../.agents/skills/docs-as-code-handoff/assets/adr.md)，存入 `docs/decisions/`，不要求普通修复都新增 ADR。

## 可接手的上下文

[稳定交接入口](handoff.md) 维护当前协作目标、入口、已确认约束、未完成项与下一步；状态改变时随本次提交更新。历史快照保留原日期，不继续称为最新。多人并行时各写自己的变更记录，只对稳定入口做必要的链接或状态更新。

接手者先看 `AGENTS.md`、稳定入口、当前 Git 状态，再按任务读取关联记录。文档区分：已确认事实、已实现行为、本轮实际验证、计划和未完成。不要把历史测试结果、模拟成功或未执行的命令写成当前真实验收。完整聊天、提示词、私有业务数据、凭据和大份原始日志不作为源码文档上传；必要证据脱敏后记录最少信息。

每个任务至少留下可执行的下一步、相关文件/接口和验证命令。未完成事项写清阻塞条件；无需把整个仓库重新介绍一遍。

## Git 提交、PR 与上传

1. 检查实际仓库、`git status --short --branch`、相关 diff 和已有暂存内容，只选择本次文件。
2. 完成变更记录与受影响主题文档；状态变化时更新交接入口。
3. 执行适用的验证，记录命令、环境、实际结果及未覆盖范围；提交前审查 `git diff --cached`。
4. 运行 `node scripts/check-docs-as-code.mjs --staged`。提交消息使用简洁主题，正文写原因、结果及 `Docs: docs/changes/<记录>.md`。PR 使用仓库模板链接相同记录。
5. 上传前核对明确的目标远端、分支及所有待推送提交。净化发布工作区必须同步相关文档、skill、模板与检查脚本，并在该工作区重新验证和提交。

本项目旧开发历史含真实业务数据库；按 [GitHub 源码仓库说明](../GitHub源码仓库说明.md) 走净化快照流程，不能把本开发仓库旧历史推入公开仓库。说明中的发布目录是已知入口，使用前应再次核验其远端、分支和状态，不自动选择最近的其他临时 worktree。本规范建立本地持续规则，不构成额外的推送、部署或消息发送授权。

## 自动检查

要求 Node.js 24+，无需额外 npm 依赖。在每个克隆或净化发布工作区运行：

```powershell
node scripts/install-docs-hooks.mjs
node scripts/check-docs-as-code.mjs --staged
node scripts/check-docs-as-code.mjs --commit HEAD
node scripts/check-docs-as-code.mjs --range BASE..HEAD
node --test test/docs-as-code.test.mjs
```

将 `BASE` 替换为实际基线。hooks 在提交时检查索引，在推送时检查新增提交；GitHub Actions 对 push/PR 检查。首次采用以前的历史提交不补造记录。新克隆不会自动安装 Git hooks；发布到其他 Git 平台也需要安装本地 hooks 或接入其 CI。

检查要求提交中存在本规范、稳定交接入口，包含结构完整且非模板占位的变更记录。首次采用时也必须将这些文件一起暂存，不能仅让文档留在工作树。它无法判断事实是否真实、业务说明是否充分或测试是否真的覆盖改动，agent 和 reviewer 必须审查语义。CI 只在规则本身已进入对应远端后生效；分支保护需要仓库管理员另行设置。不得用 `--no-verify` 把缺失文档作为常规流程绕过。

## 规范与 skill 来源

- [Write the Docs：Docs as Code](https://www.writethedocs.org/guide/docs-as-code/)：文档采用版本控制、评审、纯文本及自动检查。
- [Architecture Decision Records](https://adr.github.io/)：保存关键决策、理由和后果。
- [OpenAI curated skills](https://github.com/openai/skills/tree/main/skills/.curated)：2026-11-05 查阅时未发现专门覆盖本次完整 Git 交付与 agent 交接要求的 skill。
- 已查阅 [docs-as-code / dev-workflow](https://github.com/JaysonAlbert/docs-as-code/blob/main/docs-as-code/SKILL.md) 与 [living-docs](https://github.com/ejklock/living-docs-skill/blob/main/skills/living-docs/SKILL.md)。前者有 Java/审批流程假设，后者依赖额外 CLI 和 skills；本项目参考其原则，采用本仓库维护的 [docs-as-code-handoff](../../.agents/skills/docs-as-code-handoff/SKILL.md)，未安装这两套第三方工具链。

skill 的仓库副本是项目权威版本，随源码交付。本机个人 skill 副本用于跨仓库自动发现；修改 skill 时同步本机副本。其他机器可直接读取仓库 skill，或复制到其个人 skills 目录。
