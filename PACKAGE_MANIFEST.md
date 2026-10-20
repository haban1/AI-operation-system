# 交接包清单（最新）

## 包含

- 当前工作区 Git 已跟踪源码、测试、文档、启动脚本和 .env.example；
- 当前工作区版本的未提交修改（已直接复制工作树文件）；
- CODEX_HANDOFF.md：当前代码状态、业务背景、已完成改动和接手纪律；
- CONVERSATION_MEMORY.md：本轮对话记忆摘要；
- PACKAGE_MANIFEST.md：本清单；
- SOURCE_REVISION.txt：版本及工作区状态；
- WORKTREE_DIFF.patch：相对基线提交的未提交差异，便于核对。

## 明确排除

- .env 及所有备份配置；
- API Key、Webhook、Token、Cookie、浏览器登录 Profile；
- data/、backups/、logs/、数据库和运行态数据；
- node_modules/；
- dist/、安装包、压缩包、构建缓存和临时文件。

## 说明

这个包交接的是“源码 + Codex 对话记忆”，不是完整运行环境。另一个任务如果需要真实历史消息或知识库数据，需要在安全的目标工作区单独提供数据库备份；不要把真实数据库、Cookie 或密钥直接塞入交接包或提交到 GitHub。
