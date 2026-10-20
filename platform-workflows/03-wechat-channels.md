# 03 视频号闭环

## 范围

本流程只负责 `wechat_channels`，复用公共 Assisted Platform 的 Profile、登录态、采集与回复框架；本次未启动真实浏览器，也未执行真实发布或回复。

## 停止态

- 所有入口通过继承的 `runtimeGuard` 在创建 Profile、启动浏览器之前阻断。
- 最终发表、评论发送和私信发送前再次执行运行态检查。
- 平台关闭时不得打开 Profile、不得登录检查、不得采集或发送。

## 内容发布

1. 打开视频号助手发布页并准备草稿。
2. 非 `AUTO` 模式只保留草稿，返回 `NEEDS_CONFIRMATION`。
3. `AUTO` 仍必须有 `managementConfirmed === true`。
4. 只允许唯一可用的“发表”按钮；按页面实际结构处理可选的“确认发表”。
5. 手机号绑定、安全验证、扫码、人脸、验证码等均进入 `NEEDS_CONFIRMATION`。
6. 最终点击后没有可靠成功信号时，标记 `submissionStatus=UNKNOWN`、`retrySafe=false`、`nonIdempotent=true`，禁止盲目重试。

## 评论采集与精确回复

1. 从 `.feeds-container .comment-feed-wrap` 读取作品标题、时间和评论数。
2. 只采集评论数大于零的作品，并把 `sourceVideoKey/title/time` 写入消息上下文。
3. 回复必须携带作品上下文；即使列表只有一个作品也不允许猜测目标。
4. 在目标作品中按用户名、评论正文、评论时间或 fingerprint 唯一定位 `.comment-item`。
5. 只点击目标评论容器内的回复入口。
6. 只使用目标评论容器内 `.comment-reply-list .comment-create-wrap textarea.create-input`。
7. 只点击该局部编辑器内 `.create-ft .primary`。
8. 发送后要求目标评论线程新增精确文本回显且输入框清空；不确定结果禁止自动重试。

## 私信采集与精确回复

1. 只采集带 `.dot` 未读证据的 `.private-msg-list .session-wrap`，保存会话名、预览和会话上下文。
2. 回复前重新核对会话名、预览、未读状态和唯一性。
3. 打开会话后核对 `.session-dialog .header .left`。
4. 源消息必须精确存在于对方方向 `.content-left .message-plain`，不能把己方历史消息误当成来源。
5. 只使用 `.session-dialog textarea.edit_area` 和同一 `.footer` 内发送控件。
6. 发送后只认可 `.content-right` 新增精确回显和输入框清空。
7. 手机号绑定或回显不确定时返回 `NEEDS_CONFIRMATION`，并设置 `retrySafe=false`。

## 现场验收

由主任务按编号 **03** 排队执行：登录检查、只读 DOM 校验、测试账号评论/私信回复及测试内容发布。页面结构变化、账号风控和手机号绑定必须人工处理。
