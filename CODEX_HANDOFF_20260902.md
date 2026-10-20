# AI数字运营2 工程交接说明

> 交接日期：2026-09-02（Asia/Shanghai）  
> 工作区：`D:\code\AI数字运营2-源码交接-20260824-最新上下文修复\AI数字运营2`

## 1. 当前代码状态

- Git 分支：`main`
- 基线提交：`df697e06ccaa683c62a2094181ddc600c07c6aee`
- 当前约有 77 个已修改或新增的工作区条目。
- 最新功能尚未统一提交，完整源码以当前工作区和本次源码包为准。
- 2026-08-27 的旧交接文档中有不少“尚未实施”的描述已经过期，以本文件为最新状态。

## 2. 系统结构

```text
Web 管理端（127.0.0.1:3100）
        │
        ├── 本地业务服务 / SQLite
        │     ├── 消息路由
        │     ├── 会话状态与版本
        │     ├── 任务优先级与队列
        │     ├── 企业微信通知 Outbox
        │     ├── 定时发布
        │     ├── RAG Client / 管理代理
        │     └── 小智测试与知识发布控制
        │
        ├── Local Agent
        │     ├── 评论采集 Worker
        │     ├── 私信采集 Worker
        │     ├── 回复 Worker
        │     └── 发布 Worker
        │
        └── 本地 RAG 服务（同事项目，通过合同接口对接）
```

关键入口：

- 服务端：`src/server.js`
- 数据库：`src/db.js`
- Local Agent：`agent/local-agent.js`
- 前端：`public/app.js`、`public/styles.css`
- 启停：`启动本地服务.cmd`、`停止本地服务.cmd`

## 3. 已落地模块

### 外层路由

文件：

- `src/services/message-router.js`
- `src/services/formal-rag-routing.js`
- `src/services/rag-client.js`
- `src/services/rag-contract.js`

路由结果：

```text
RAG | CLARIFY | HANDOFF | IGNORE | FIXED_REPLY
```

高风险、恶意、投诉、法律监管、支付/账号/隐私安全、主动要求人工、已进入人工处理的用户，应在 RAG 前拦截。

### 人工处理与企业微信

文件：

- `src/services/conversation-control.js`
- `src/services/notification.js`
- `src/services/operation-state.js`

流程：

```text
准备转人工
→ 禁止机器人继续回复
→ 企业微信通知进入 Outbox
→ 取得明确成功回执
→ 会话记为人工处理
```

通知成功后的用户再发新消息：不进入 RAG、不澄清、不自主回复、不扫描旧历史，只再次通知企业微信。

### 新增量优先和旧会话恢复

文件：

- `src/services/job-priority.js`
- `src/services/conversation-recovery-policy.js`
- `src/services/conversation-recovery-scheduler.js`
- `agent/job-operation-lane.js`
- `agent/platform-operation-coordinator.js`

读取优先级：

```text
新增量私信
> 回复前会话版本核验
> 旧会话恢复扫描
```

写入优先级：

```text
私信回复
> 评论回复
> 内容发布
```

旧会话只有没有新增量任务时才扫描，至少间隔 30 分钟；用户超过 2 天未回复则停止周期扫描；人工处理会话不扫描。

### 平台通道拆分

适配器：

- 抖音：`agent/rpa-adapters/douyin-assisted.js`
- 微博：`agent/rpa-adapters/weibo-assisted.js`
- B站：`agent/rpa-adapters/bilibili-assisted.js`
- 视频号：`agent/rpa-adapters/wechat-channels-assisted.js`
- 通用基类：`agent/rpa-adapters/assisted-platform.js`

规则：

- 每个平台评论与私信使用独立页面。
- 评论与私信并行采集。
- 采集与发送通道分离。
- 写操作经过平台级安全协调。
- 平台没有明确回显时，Web 不得显示回复成功。

### 抖音私信会话列表恢复（2026-09-02 最新）

问题：Worker 进入某用户聊天后长期停留，可能漏看其他用户的新私信。

实现：

```text
列表发现任务
→ 进入目标会话
→ 采集/核验/回复
→ finally 恢复会话列表
```

重要方法：

- `existingPrivateMessagePage()`
- `inspectPrivateInboxOverviewState()`
- `clickPrivateConversationBackByGeometry()`
- `waitForPrivateInboxOverview()`
- `restorePrivateInboxOverview()`

平台回复仍必须出现本次发送后新增的、当前目标会话范围内的、己方精确文本气泡。

### RAG 与知识库

文件：

- `src/services/rag-client.js`
- `src/services/rag-contract.js`
- `src/services/formal-rag-routing.js`
- `src/services/xiaozhi-test-service.js`
- `src/services/xiaozhi-test-decisions.js`
- `docs/RAG业务对接与接口合同-V1.1-20260828.md`

规则：

- 只有一个公共知识库，不按平台隔离。
- RAG 内核由同事负责，本项目通过接口调用。
- 运营上传后先进入待测试，不能直接对用户生效。
- 小智选择测试文档且不分平台。
- 每条测试问答默认启用，运营可点“不启用”。
- 运营点击发布后，正式版本才对用户生效。
- 引用显示实际引用内容/片段，不只显示 RAG 编码。

### 素材 AI 与知识草稿

文件：

- `agent/material-audio-content-generation.js`
- `agent/material-image-content-generation.js`
- `agent/material-traffic-prediction.js`
- `src/services/material-knowledge-drafts.js`
- `src/services/material-knowledge-schema.js`

功能：

- AI 根据视频/素材内容生成发布文案。
- 同时生成运营可审核的知识库草稿。
- 知识草稿入口在知识库页面。
- 前端不使用“素材流量”，统一显示“潜力”。

### 定时发布

相关文件：

- `src/server.js`
- `src/db.js`
- `public/app.js`
- `public/styles.css`
- `test/scheduled-publish.test.js`

功能：

- 可选择年月日、时分秒。
- 使用本机时间到点执行。
- 未来任务队列与历史发布记录分区展示。
- 待执行、执行中、执行失败、执行完成等状态显示中文。

## 4. 主要界面约定

- 用户可见状态尽量中文化。
- 小智不分平台。
- 知识上传保持运营页面，不暴露 RAG 技术入口。
- 未上传前不能显示“上传完成”或“解析完成”。
- 文件按最新时间排序，可查看内容、可删除。
- 页面底部展示已正式应用到用户端的文件。
- 定时任务滚轮选中框、数字和队列布局按用户截图持续做过视觉调整。

## 5. 最近测试

```text
node --test test/platform-douyin-flow.test.js
```

结果：73 通过，0 失败。

```text
node --test test/deferred-reply-retry.test.js test/reply-job-race.test.js test/douyin-refresh-recovery.test.js test/core.test.js
```

结果：215 通过，0 失败，1 跳过。跳过项是未随源码交付的一次性视频号实机脚本断言。

本次交接前没有重新运行完整 `npm test`；修改跨模块功能时应先运行相关测试。

## 6. 源码包有意排除

- `.env`
- `.git`
- `node_modules`
- `.runtime`
- `.tmp`
- `tmp`
- `logs`
- `data`
- `database/mvp.db*`
- `outputs`
- `dist`
- `packaging`
- `首次登录信息.txt`

这些属于依赖、构建结果、运行缓存、真实业务数据、浏览器/平台状态或潜在敏感配置。

## 7. 下一步建议

1. 实机验证抖音私信处理完成后返回会话列表。
2. 验证多个用户连续发新私信时都能被发现。
3. 验证回复成功、发送回执不明确、目标会话定位失败三条路径。
4. 检查 Web 状态是否严格跟随平台回执。
5. 后续每次只修改用户明确的范围，不顺带重构 RAG 或其他平台。

