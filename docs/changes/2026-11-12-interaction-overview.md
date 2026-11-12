# 用户互动五平台概览与快捷切换

## 背景与目标

用户反馈评论、私信需要逐个平台切换才知道大致情况，要求在同一界面看到所有平台简略情况，并快速进入对应平台处理。概览须来自真实已采集数据，不能用最近 200 条全平台列表推算总数，也不能将未采集解释为平台没有消息。

## 变更与影响

`public/interaction-overview.js` 渲染平台卡片：真实昵称与平台、待人工评论/私信、已采集数量、登录/暂停/采集状态。数字按钮切换账号和栏目，评论默认选择待处理；账号标题保持当前栏目。继续使用 READY 且检测到昵称才显示昵称的规则。未收到概览数据时显示横线，不假造零。

`public/app.js` 接入概览、原位刷新及切换请求保护。消息账户选择包含五平台配置中的停用账号以查看历史，停用账号立即采集按钮禁用且处理器再次检查；不改变平台开关或触发登录。消息三秒读取刷新概览计数，bootstrap 五秒刷新账号名称和状态，保留当前选择及展开状态。`public/workspace-interactions.css` 支持桌面五列、中等宽度三列、手机两列，日夜主题沿用现有颜色；index.html 更新入口与 CSS 版本。

新增 `src/services/interaction-overview.js`，全量按 account_id/platform_code/message_type 汇总 total、pending、last_collected_at，复用原列表的可见性 SQL 条件。`src/server.js` 的 GET /api/messages 在原 messages/channelRuntimeStates/replyLimits 外增加 overview 数组；可选正整数 accountId 只过滤 messages，overview 始终为全账号统计。无 accountId 的默认行为仍返回全平台最近 200 条；带参数返回当前账号最近 200 条，界面在超限时明确说明。无结构迁移或配置新增。

新测试 `test/interaction-overview.test.js` 加入 package.json 默认清单。操作入口见 [前端工作区](../frontend-workspace.md)。

## 决策与取舍

概览统计全部可见的本地已采集记录，pending 仅含未 handled、非终态且状态或决策需人工处理的消息，不把已关闭历史恢复为待办。可见性保持原行为：软删除、自发、已归并重复、原先隐藏的未送达转人工占位消息不计入。已采集总数包含已处理及已关闭历史；它不代表平台尚未采到的数量。

原详情全局 200 条会挤掉较旧平台数据，因此仅增加兼容的按账号过滤参数；没有修改采集、AI 决策、人工回复或发送接口。详情分页不在本轮实现，超过 200 条显示范围说明，概览仍完整。采集状态由既有运行记录表达，需登录/暂停优先，失败或不完整提示检查，未完成采集不显示“已同步”。已有后台节点合并机制复用到卡片，避免更新计数重建整页。

## 验证与证据

```powershell
node --test --test-concurrency=1 test/interaction-overview.test.js test/background-refresh.test.js test/background-dom.test.js test/comment-post-list-ui.test.js test/workspace-presentation-ui.test.js
```

32 项通过。新增隔离 API 用例覆盖超过 200 条的全量统计、评论/私信分组、已处理/关闭/软删除/自发/重复的口径、停用账号历史、按账号列表及 overview 不缩小、非法参数拒绝、消息状态不变与外键检查。其他回归覆盖后台节点更新、评论操作、原工作区功能和草稿。

四个隔离浏览器场景（1440/390、日间/夜间）通过：五卡片展示、登录/异常/采集中/暂停状态、评论及私信快捷切换、改名和登录失效、特殊字符安全显示、计数变化保留卡片节点/选中账号/展开状态、停用账号历史和采集禁用，无横向溢出、脚本异常或业务写请求；桌面与手机截图已检查。

本机实际四场景、十个账号/栏目入口通过，卡片数字逐项与同次 API 响应 overview 一致。四项 HTTP 前端资源和两份运行后端源码 SHA-256 与宿主匹配，Web/RAG healthy；RAG 与微信前端镜像、启动时间不变。相关 diff --check 与独立索引 Docs as Code 检查通过，主索引仍为空。本轮未运行整套历史测试，未真实发送消息、调用 AI 回复或执行采集验收。

私有备份与证据在 `.codex-work/interaction-overview-20261112/`：backup、api-tests.log、regression.log、visual-validation.json、online-validation.json、docs-check.log、containers-before.txt、日夜/宽度截图及 overview.png。测试消息均在隔离临时库或浏览器模拟接口中，业务库、配置、原始消息和秘密不交付 Git。

## 部署与回退

public 与 src 使用现有 bind mount，执行 `docker restart tianhe-dev-web-1` 重载统计服务；未重启 RAG、微信或数据库。Web/RAG 当前 healthy。变更没有写业务数据或改变账号配置。

回退先核查后续改动，逆向本轮 app.js、index.html、workspace-interactions.css、server.js、package.json 增量，移除两个新增 overview 模块和新测试，再重启 Web。原文件位于私有 backup/public、backup/src、backup/package.json，不整体恢复旧工作树或数据库。概览模块和其 app.js 导入、API 字段需同批交付，避免只上线一半；字段缺失时界面横线只是兼容兜底。

## 未完成与下一步

已修改并应用、未提交、未推送。用户刷新用户互动即可查看。后续真实新增消息、处理完成会由原轮询同步概览，仍需平台先正常登录和采集。本轮不解决平台协议、登录或未采集消息问题，也未新增平台全量历史详情分页；需查 200 条之外明细时应另行设计分页。后续公开源码交付走净化 checkout，仅选择本轮增量及关联文档。

## 上下文与关联

[互动昵称规则](2026-11-12-interaction-account-name.md)、[人工完成归档](2026-11-12-handoff-resolution.md)、[前端操作](../frontend-workspace.md)、[稳定交接](../development/handoff.md)、[Docs as Code](../development/docs-as-code.md)。保留开发库现有修改与私有历史；不要从此库直接推送。接手先确认 API overview、所选 accountId、消息状态及 channelRuntimeStates，再判断卡片显示，不能把“已采集 0”当成平台无新消息。
