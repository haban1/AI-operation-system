# 人工完成后自动归档通知并清理首页历史待办

## 背景与目标

用户要求增加处理完成后自动清理通知的能力，并清掉首页仍显示的 194 条待办及侧栏 99+。此前只归档了 201 条通知，没有关闭原消息待办，两个计数来源不同。本轮明确以消息实际完成或关闭为清理依据，不能把企微送达当作人工完成。

## 变更与影响

`src/services/notification.js` 增加按消息 ID 归档的服务及启动补偿：处理完成、关闭或软删除后，转人工通知写入 archivedAt、archiveReason=MESSAGE_RESOLVED，未送达的通知取消；已送达状态及时间保留。归档记录不再领取、直接发送或手动重试，发送途中归档后迟到的成功/失败回执不会复活记录。入队及幂等复用时也检查消息是否已经完成，普通通知不受影响。

`src/server.js` 在消息处理注册同步、人工确认问题已发送、启动补查中接入；人工已处理接口将消息、任务取消、通知归档和注册表写入同一事务。bootstrap 与运营看板人工待办统计统一排除 handled_at、deleted_at 已有值的消息。现有前端自然读取这两个接口，无新增页面或开关，操作见 [前端工作区](../frontend-workspace.md)。两个新测试文件加入 package.json 的默认测试清单。

线上在备份后精确关闭本次 194 条历史待办，状态 CLOSED、decision=OPERATOR_DISMISSED，标注运营清理及禁止自动补发，不声称平台回复成功。184 条关联此前归档通知，10 条为独立待办；本轮没有额外通知需要归档、没有回复批次需收束。账号、会话及其余 99 条消息在清理事务前后哈希一致，原通知历史、外键和消息内容保留。

## 决策与取舍

复用 metadata_json 归档，无数据库结构或配置迁移，保留审计及防重复发送幂等键。只处理同一 message_id 的转人工通知，不按整个会话清理，防止丢掉后续新消息。不会恢复 BOT_ACTIVE，也不会撤回企微消息；已在网络中发出的请求无法撤回，但迟到回执不能重新确认会话或安排重试。

旧待办清理使用显式 CLOSED，不伪造 MANUAL_HANDLED。第一次运行安全校验发现两条消息的 collected_at/updated_at 被周期采集刷新而退出，事务回滚、未写业务数据。确认仅这两个时间字段变化后，仍对其他全部字段和 ID 集合严格校验，并在事务中保留精确的清理前快照，遇到活跃关联回复/检测任务则中止。

## 验证与证据

Node 24 隔离测试命令：

```powershell
node --test --test-concurrency=1 test/handoff-resolution.test.js test/handoff-resolution-api.test.js test/notification-outbox.test.js test/reply-readonly-reconciliation.test.js test/conversation-handoff-claim-guard.test.js
```

56 项通过，覆盖接口归档失败时整笔回滚、完成后统计、同会话新待办保留、普通通知保留、通知送达不触发完成、幂等、归档禁止重试与领取、迟到成功/失败回执保护、已完成消息入队和启动补偿，含原 42 项通知回归及平台回复只读复核回归。全部通知发送为 mock，无真实企微或平台发送。

本机完整 SQLite 备份 quick_check=ok，包含清理前 194 条待办；清理事务 foreign_key_check 通过。实际登录后的只读接口和 Chrome 页面确认：首页人工待办 0/已清空、用户互动无 99+、转人工记录 0、运营建议无待人工会话积压，其他六条普通通知仍显示，页面无脚本错误或业务写请求。截图已查看。Web/RAG healthy，RAG 启动时间未变。

两个运行后端文件与宿主源码 SHA-256 一致，相关源码 diff --check 通过。独立 GIT_INDEX_FILE 执行 `node scripts/check-docs-as-code.mjs --staged` 通过，主暂存区仍为空；这只验证候选文档结构，不代表已提交或验证了整个开发工作树。

私有证据在 `.codex-work/resolve-handoffs-20261112/`：tests.log、result.json、online-validation.json、dashboard-cleared.png、handoffs-cleared.png；backup 保存完整业务库和两份源文件，messages-before-apply.private.json 为精确清理前消息快照。第二次重复备份曾超时，未用其结果覆盖已核验的宿主备份；交接以 quick_check 通过的 backup/before.private.db 为准。私有目录不进入 Git。未执行全量历史测试或真实平台收发；此前 UI 导入顺序旧测试失败见 [前轮记录](2026-11-12-clear-handoff-records.md)，本轮未处理。

## 部署与回退

两个后端文件通过现有 bind mount 部署，执行 `docker restart tianhe-dev-web-1`；没有重启 RAG 或微信服务。前端、配置、人设和登录态不修改。

回退代码时仅逆向本轮增量或对照私有源文件备份，保护后续修改，随后重启 Web。如确需恢复旧待办，仅按清理前快照逐行恢复本轮改动字段及处理注册表，且必须校验当前仍是本轮 CLOSED/OPERATOR_HISTORY_CLEAR、无后续处理；不得覆盖当前 collected_at、新消息或其他记录。恢复已归档通知可见性需单独评估，不能自动排队补发。不要整体恢复旧业务数据库。恢复前先再备份当前库。

## 未完成与下一步

本轮已修改并应用，未提交、未推送。无需用户登录验证本次清理逻辑；后续真实人工处理时可核对对应通知自动消失及首页计数下降。没有新增定期硬删除、通知撤回或单独的“清空全部”按钮；保留审计是既定实现。未来公开源码交付继续用净化 checkout，不推开发库私有历史。

## 上下文与关联

[稳定交接](../development/handoff.md)、[前端操作](../frontend-workspace.md)、[此前通知归档](2026-11-12-clear-handoff-records.md)、[Docs as Code](../development/docs-as-code.md)。相关新增测试为 handoff-resolution.test.js 和 handoff-resolution-api.test.js。开发目录有大量既有改动，后续只选本轮增量及关联文档；主索引保持原状，不将业务库、用户资料或私有运行日志交付到 Git。
