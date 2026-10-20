# CHANGELOG — Recovery 2026-08-16

> 日期基准：2026-08-16（Asia/Shanghai）。本恢复版为独立工作目录，不替换当前项目。

## 交付目标

从已通过 336/336 测试的候选基线建立独立恢复版，并以最小改动加入发布 AI shadow 边界、确定性回复资格门和只读 dry-run 迁移工具。

## 新增文件

| 文件 | 作用 |
|---|---|
| `src/services/auto-reply-eligibility.js` | 统一评论/私信自动回复资格判断；稳定 ID、来源、唯一目标或正文证据不足时 fail-closed。 |
| `src/services/recovery-publish-safety.js` | 固化 AI 页面判断为 shadow；禁止最终点击、成功判定、阻断和自动重试授权；屏蔽 `PUBLISH_STATUS_CHECK`。 |
| `scripts/migrate-recovery-data.mjs` | 默认 dry-run、源库只读、表白名单迁移预演；排除运行态和不确定任务。 |
| `test/recovery-safety.test.js` | 覆盖 7 组恢复安全边界。 |
| `test/migration-recovery.test.js` | 验证 dry-run 不写源库、不创建目标库且排除运行态。 |

## 修改文件与理由

| 文件 | 修改理由 |
|---|---|
| `src/config.js` | 增加恢复版安全配置，并把 AI 页面判断模式固定为 `shadow`。 |
| `src/server.js` | 在知识库确认可自动回答之后、创建回复任务之前执行统一资格门；不合格转 `MANUAL_REQUIRED/AUTO_REPLY_INELIGIBLE`；创建和领取链路排除 `PUBLISH_STATUS_CHECK`。 |
| `agent/rpa-adapters/assisted-platform.js` | 真正进入页面和准备发送前再次核验目标资格、唯一容器和绑定证据；写后异常不自动重试；精确回复已存在则跳过。 |
| `.env.example` | 只增加无密钥的恢复安全配置示例，默认 shadow/fail-closed。 |
| `package.json` | 将新增安全和迁移测试纳入标准 `npm test`。 |
| `test/core.test.js` | 成功路径 fixture 补足稳定帖子/评论或会话/消息上下文。 |
| `test/platform-douyin-flow.test.js` | 补足抖音确定性评论/私信上下文。 |
| `test/platform-wechat-channels-flow.test.js` | 补足视频号确定性评论/私信上下文。 |
| `test/server-integration.test.js` | 补足集成路径中的稳定目标和来源验证上下文。 |
| `test/smart-reply-control.test.js` | 补足智能回复控制测试的稳定目标证据。 |

> 测试 fixture 的变化仅补齐生产规则要求的确定性上下文，没有放宽资格门或删除既有安全断言。

## 核心行为变化

1. AI 页面识别只作旁路观察；失败不阻断确定性发布结果。
2. AI 不拥有最终发布/发送点击权、发布成功判定权、自动重试权或覆盖确定性规则的权限。
3. 恢复版不创建、不领取 `PUBLISH_STATUS_CHECK`。
4. 评论自动回复必须具备稳定帖子 ID、评论 ID、唯一目标及来源验证。
5. 私信自动回复必须具备稳定会话 ID、消息 ID、incoming 方向、完整正文、非 sidebar preview、来源验证和会话标题验证。
6. 页面定位后发生变化、存在多候选、编辑框未绑定目标容器、写后结果不确定时均不发送并转人工确认。
7. 知识不足消息仍优先进入 `KNOWLEDGE_GAP`，资格门不会提前截断知识缺口流程。

## 明确未迁入

未整体迁入当前实验版的 AI 裁决、历史发布状态轮询、回复锁/回执/闭环等模块，包括但不限于：

- `ai-page-adjudicator.js`
- `publish-status-polling.js`
- `reply-target.js`
- `reply-lock.js`
- `reply-receipt.js`
- `reply-closure.js`
- `sqlite-reply-lock-store.js`

## 验证摘要

- 基线：336/336 通过。
- 最终：344/344 通过。
- Node 语法检查：13/13 通过，Node v24.18.0。
- 隔离启动：`/api/health` HTTP 200，测试进程已停止。
- 迁移：仅 dry-run；源库 SHA-256 前后相同；目标库未创建。
- 未进行真实平台最终发布或真实消息发送。
