# 微信人工接待窗口直接回复（2026-11-12）

## 背景与目标

用户在微信客服的人工接待列表收到通知后，希望在当前窗口回复。原界面只显示最后一条消息，并提示到微信客户端接待，没有输入框。

## 变更与影响

- 人工接待选中会话后嵌入现有聊天组件，展示最近50条消息、图片及收发时间，每3秒刷新；更早记录从“历史记录”打开。
- 支持连续发送文字和单张图片，Enter发送、Shift+Enter换行；发送确认后清除相应内容，失败保留未确认部分，文字成功而图片失败时只保留图片。
- 当前页面内各接待会话独立保存草稿。发送时固定接收账号/会话并禁用会话切换、搜索及恢复AI；离线或接待状态变更期间禁止新发送。草稿仅保存在页面内存，刷新、切换账号或离开模块会丢失。
- 私聊发送给接待客户，群聊发送给原群；会话列表标注“群聊”，聊天标题注明回复发送到本群。群回复不自动@该成员。
- 接待期间仍由现有后台暂停AI；手动发送不结束人工接待，必须显式点击“恢复 AI 回复”。原主动接管、接待设置和通知异常说明保留。

涉及微信前端 `src/customer-support/{Reception.tsx,ReceptionConversation.tsx,Reception.styled.ts,index.tsx,types.ts}`、`src/chat/conversation/{ConversationPane.tsx,Composer.tsx}` 和 `src/robot/actions/components/RobotDetail.tsx`。新增隔离UI测试服务 `test/helpers/wechat-reception-mock.mjs`；未修改后端、协议、数据库或模型配置。

## 决策与取舍

复用联系人聊天的生成API、消息渲染和发送组件，不另建发送通道或鉴权入口。接收对象及完成回调在发送开始时固定；会话组件按机器人和接待key隔离，发送中的选中项在快照刷新时保留，避免串发和清除另一会话的草稿。

继续采用既有发送确认语义和最多120秒请求超时。失败提示先核对聊天记录，不自动重试，避免网络异常时重复发送。未引入后端跨管理员互斥锁；其他管理员或手机端更改接待状态仍按既有轮询时效反映。

## 验证与证据

在隔离候选目录、已有依赖卷、`node:22-bookworm-slim`及项目锁定的pnpm8.15.9下执行 `corepack pnpm lint`、`corepack pnpm exec tsc --noEmit`、`corepack pnpm build`，均通过。群聊标识小改后重新lint/build通过，类型声明无后续变动。

使用CUA操作候选构建和纯模拟API，实际检查：会话切换与两份草稿隔离、文字失败保留、文字成功后清空并出现历史记录、发送中控制禁用、图片粘贴/失败保留/成功后清空、文字成功图片失败时不重复发文字、群消息目标为群ID、仅显式恢复AI才退出接待队列，以及离线提示和禁发状态。模拟回执共6次发送请求，其中4次确认、2次人为失败；恢复AI前接待状态写入为0，恢复后只有一条对应群会话的active=false变更。文件选择器自动化超时，图片发送改用现有粘贴入口验证；未将此写为文件选择器通过。

可复现模拟服务：构建微信前端后，在仓库根运行 `node test/helpers/wechat-reception-mock.mjs <候选dist目录> 3197`，打开 `http://127.0.0.1:3197/wechat-workbench/`。它只监听127.0.0.1，不向微信或真实服务转发。`/_test/config`可控制模拟失败与延迟，`/_test/state`返回模拟回执。不能把该模拟服务用作生产接口。

本机55个候选构建文件与运行目录SHA一致；经天河管理员会话读取的HTML及5项JS/CSS入口资源SHA一致，微信账号在线，人工接待保留1条。Web/RAG healthy，微信前端、Web/RAG及微信客户端/协议五个容器启动时间和运行镜像均未改变。真实微信发送、系统全量回归和桌面宽屏视觉未在本轮验收；默认窄屏测试页已检查布局。

`node --check test/helpers/wechat-reception-mock.mjs`和`node scripts/check-docs-as-code.mjs --staged`均通过；后者使用独立临时Git索引，校验主索引字节未改变。文档结构检查不代替以上业务验证。

## 部署与回退

2026-11-12 16:37（Asia/Shanghai）更新现有 `wechat-robot-admin-frontend:/app/dist`：先拷贝资源，最后更新index，保留旧哈希文件供已有页面加载。派生镜像 `tianhe-wechat-ui:native` 已更新用于下次重建，无容器重启、数据库迁移或微信重新登录。

本地私有备份和证据在 `.codex-work/wechat-reception-reply-20261112/`：`backup/source/`、`backup/dist/`、构建/lint/typecheck日志、`deployment.json`、`http-validation.json`、模拟回执和截图。镜像回退标签为 `tianhe-wechat-ui:before-reception-reply-20261112`。回退时恢复原源码文件并移除本轮两个新增接待组件，重新构建；临时运行回退可先恢复backup/dist资源、最后恢复index，并把native标签指回备份镜像。只回退微信前端，不覆盖同时期其他源码或业务数据。私有目录不上传。

## 未完成与下一步

用户刷新“微信客服 → 人工接待”，选中客户后输入并发送，接待结束再恢复AI。真实收发由用户自行验证，本轮未额外向好友或群发送测试消息。文件选择器、宽屏和完整历史抽屉的细项操作未单独验收；复用已有组件，不能据本次模拟结果宣称全系统验收。

已修改并部署，未提交、未推送。后续Git交付从本轮文件清单筛选，连同文档进入净化源码快照，保留既有修改，不直接推送私有开发历史。

## 上下文与关联

- [系统内入口与操作说明](../微信助手系统内集成-20261105.md)
- [此前收信和在线状态核查](2026-11-12-wechat-reception-status.md)
- [稳定交接入口](../development/handoff.md)
- [Docs as Code规范](../development/docs-as-code.md)
