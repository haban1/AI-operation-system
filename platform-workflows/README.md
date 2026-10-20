# 五平台任务流程入口

本目录用于独立开发、调试和验收小红书、微博、抖音、视频号、B站五个平台。五个平台共享 Web、数据库、知识库决策和 Local Agent 框架，但浏览器 Profile、适配器实例、运行开关和任务执行彼此隔离。

## 文件

| 编号 | 平台 | 流程文档 | 独立测试 |
|---|---|---|---|
| 00 | 总体约定 | `00-integration-contract.md` | 项目全量测试 |
| 01 | 微博 | `01-weibo.md` | `test/platform-weibo-flow.test.js` |
| 02 | 抖音 | `02-douyin.md` | `test/platform-douyin-flow.test.js` |
| 03 | 视频号 | `03-wechat-channels.md` | `test/platform-wechat-channels-flow.test.js` |
| 04 | B站 | `04-bilibili.md` | `test/platform-bilibili-flow.test.js` |
| 99 | 总验收 | `99-total-acceptance.md` | `npm.cmd test` |

## 调试队列

严格按以下顺序切换，任一时刻只允许一个平台进入期望运行状态：

```powershell
node scripts/platform-debug-queue.mjs status
node scripts/platform-debug-queue.mjs select weibo
node scripts/platform-debug-queue.mjs select douyin
node scripts/platform-debug-queue.mjs select wechat_channels
node scripts/platform-debug-queue.mjs select bilibili
node scripts/platform-debug-queue.mjs stop-all
```

若目标平台存在排队任务，`select` 默认拒绝，避免开启全局开关后任务自动执行。只有人工核对任务内容和测试目标后，才能显式使用 `--allow-queued`。

## 安全边界

- 平台停止或全局停止时，不得启动浏览器、打开 Profile、检查登录、采集、领取或执行任务。
- 评论和私信回复文案由现有知识库和风控链路生成；平台适配器只负责采集、精确定位、发送和可靠回执。
- 发布和回复属于非幂等操作；发送后结果不确定时进入 `NEEDS_CONFIRMATION`，不得盲目重试。
- 实机验收结束后必须执行 `stop-all`，并确认 Local Agent `platformAllowlist=[]`、全局开关关闭且相关 Profile 进程为 0。
