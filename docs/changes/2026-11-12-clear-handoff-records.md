# 清空旧转人工通知并核对完成后清理能力

## 背景与目标

用户要求清空转人工记录中的 201 条旧通知，并检查处理完成后是否会清理通知。实查为 197 条 FAILED、4 条 CANCELLED，无送达成功记录；仅清空该批历史，不把未解决消息标为已处理。

## 变更与影响

原通知 metadata_json 增加 archivedAt 和 archiveReason，保留全部记录、handoff 标识、送达状态、外键及幂等键。src/services/notification.js 的转人工列表和计数、src/server.js 的企微通知列表排除已归档记录。只对当时确认的 201 个通知 ID 归档，没有改变其他六条普通通知。

消息、会话、账号和人工接管状态保持原样；新的未归档通知仍正常显示。本轮没有新增自动清理任务、清空按钮或对外通知。

## 决策与取舍

采用归档隐藏，避免硬删除影响消息关联和防重复发送。清空前使用 SQLite 在线备份并另存该批通知的原始字段；两者只存于本机私有目录。当前这批均为终态，归档没有取消正在发送的任务。

检查结论：系统没有“人工处理完成后自动归档/删除通知”的触发或按保留期清理的任务。POST /api/messages/:id/handled 更新消息和处理注册表、取消原回复任务，但不会清理历史通知，也不会撤回已发往企业微信的消息。通知 CONFIRMED 只代表企微送达，不代表人工已完成处理。原页面也明确不判断人工是否接单。

## 验证与证据

- node --test test/notification-outbox.test.js：42 项通过。隔离 SQLite 验证归档后列表/计数隐藏、幂等重放复用原 ID、FAILED 记录不会被队列领取、新通知仍显示且其他字段不变。
- 运行库事务归档 201 行，仅改 metadata_json；293 条消息、234 个会话和 6 个账号的全部字段哈希在同一事务前后相同，foreign_key_check 通过。
- 重载后 GET /api/manual-handoffs 的 totalHandoffs=0、列表为空；bootstrap 的 handoffRecords=0；企微通知列表不再包含该批 ID，其他六条通知保留。真实浏览器显示空态和零条记录，无脚本错误或业务写请求；已查看截图。
- Web、RAG healthy；只重启 Web，两个镜像和 RAG 启动时间不变。
- 扩展运行 ai-reply-timeout.test.js 与通知测试时，49 项中 48 通过、1 项失败：旧 UI 测试要求 ai-model-settings 导入位于 app.js 首行，而当前系统已有其他前端导入在前；本轮未修改 app.js，没有修复或把该失败算作通过。

私有备份、操作脚本和证据在 .codex-work/clear-handoffs-20261112/：backup/before.private.db、backup/notifications.private.json、archive-runtime.mjs、archive-result.json、isolated-validation.json、outbox-tests.log、online-validation.json、empty-handoffs.png。运行数据库、通知内容、用户资料不进入源码文档或 Git 交付。

## 部署与回退

后端源文件通过现有 bind mount 生效，执行 docker restart tianhe-dev-web-1 重载列表查询，未重启其他服务。没有数据库结构迁移或运行配置变更。

原两个源文件在私有 backup/src/。回退时先核对后续改动，仅撤销本轮三个归档筛选条件；如需恢复可见记录，只针对原 201 个 ID 核验本轮 archivedAt 后恢复备份中的 metadata_json。不要整体恢复旧数据库，以免覆盖新业务；恢复通知可见性不等于重新发送，也不应改变原 FAILED/CANCELLED 状态或人工接管状态。

## 未完成与下一步

已应用、未提交、未推送。已完成本次清空及能力检查；自动完成识别、完成后归档触发和通知保留期尚未新增。若后续要求自动清理，需要明确人工完成依据，再将归档与消息处理状态联动，不能用“通知送达”代替“处理完成”。

## 上下文与关联

[前端入口](../frontend-workspace.md)、[稳定交接](../development/handoff.md)、[Docs as Code](../development/docs-as-code.md)。本轮仅选择两份后端源文件和相关文档；后续公开交付继续使用净化 checkout，保护开发库既有改动和私有历史。
