# 2026-11-11：精简创作导航并迁移创作设置

日期：2026-11-11（Asia/Shanghai）

状态：已修改并应用，未提交、未推送。开发目录 main，HEAD ef4375b，保留既有工作树和真实暂存区。

## 背景与目标

用户要求内容创作顶栏仅保留“创作方式、素材库”，将创作设置入口与页面放入系统设置。自动成片、素材智剪和 AIGC 创作继续从首页三张卡片进入，原配置、业务功能与后端接口保留。

## 变更与影响

- `public/app.js` 增加系统设置栏目 `#creation-settings`，复用创作工作台渲染；主系统与工作台之间增加受限的页面切换消息。
- `public/hot-topic-studio.js` 保持同一 iframe 挂载，记住内容页面，设置与内容互相切换时保留制作草稿、素材筛选与未保存配置。设置页加载完成前切换时按当前目标同步，重置时清除记忆。
- `public/hot-topic-studio.css` 允许创作设置显示主系统标题与系统栏目，保持深色背景和移动端高度；移动端选择器覆盖原壳层的 block 布局，避免 iframe 被压成默认高度。
- `engines/video-studio/dist/index.html` 顶部仅两个按钮；`app.js` 保留原卡片、素材、路由和发布逻辑，并校验父窗口来源与目标路由。进入设置时隐藏工作台顶栏。
- `engines/ai-signal-studio/web/style.css` 仅对嵌入模式隐藏原设置菜单，在设置页隐藏热点导航；独立 Signal 页面仍保留原入口。两层 HTML 及主系统 HTML 更新必要缓存版本。

共九个既有前端文件、一个专项测试及三份文档；本轮没有修改业务后端、依赖、环境配置或数据库。入口说明见 [前端操作入口](../frontend-workspace.md)。

## 决策与取舍

复用原设置表单与 iframe，避免重复配置界面及不同步状态。设置属于独立主系统栏目，使用 `creativeSettings` 页面键；内容导航及原发布选择器不变。嵌入工作台旧 `#settings` 链接会切换到系统设置，新主系统地址也支持直接刷新。

父子消息均校验同源与窗口来源，父窗口仅能发送预先列出的内部页面目标。旧独立工作台路由继续存在；移除的是重复顶栏按钮，三种创作能力没有移除。

## 验证与证据

Windows、Node.js 24、本机 Chrome 执行：

```powershell
node --check public/app.js
node --check public/hot-topic-studio.js
node --check engines/video-studio/dist/app.js
node --test test/creation-navigation-ui.test.js test/workspace-presentation-ui.test.js test/content-library-picker.test.js
```

最终十项通过、零失败、零跳过。专项使用真实主壳、创作工作台和 Signal 前端，API/写请求在隔离测试中模拟，外部请求阻断；验证桌面 1440 与手机 390 宽度的两个按钮、三张创作卡片、设置入口/菜单高亮、旧链接、直接刷新、同一 iframe、草稿/筛选/模型输入保留、原配置提交与连接测试合同、无横向溢出及 iframe 填满剩余视口。手机设置 iframe 最终高度约 664px（测试视口高 1000px），不再是旧样式下的 150px。现有素材库选择与缓存页面回归通过，未调用真实模型、语音服务或制作/发布任务。

额外执行 `test/video-studio-integration.test.js`：五个子项通过，三个子项失败，父测试随之失败。失败分别为 HTML 断言不允许脚本缓存查询参数（本轮前备份也有查询参数）、工具状态依赖本机制作工具、会话 fixture 返回 500。保留失败记录，不将其列为通过；本轮不扩展到后台工具或会话修复。

九项运行文件 SHA 与源码一致，四项主系统公开静态资源 HTTP 内容一致。私有证据/截图、源码与容器备份及部署清单在 `.codex-work/creation-nav-20261111/`，不进入源码交付。文档结构通过独立索引检查，真实 Git 索引不变；结构检查不能证明混合工作树已整理为可交付快照。

## 部署与回退

主系统四项静态文件由既有 `public/` 绑定挂载生效。Web 工作台三个文件、Signal 两个文件已复制到对应运行容器；未重启容器，运行镜像 ID 保持原值。派生镜像 `tianhe-web:creation-nav-20261111` 与 `tianhe-signal:creation-nav-20261111` 已构建，并更新原 Compose 使用的本地标签，供以后重建继续使用。

回退先核验本轮之后的改动，不能整体覆盖他人工作。私有 `backup/` 包含九项源码及五项原运行资源；无后续修改时恢复对应文件与运行目录，并将原 Compose 标签从 `before-creation-nav-20261111` 的相应 Web/Signal 备份标签恢复。恢复后刷新浏览器并核验资源，不需要修改数据或接口。部署细节见私有 `deployment.json`。

## 未完成与下一步

导航迁移已完成；真实模型连接、语音试听、成片制作和发布未在本轮执行。三个既有视频集成失败需在相关制作工具/测试维护任务中核对。后续验收可刷新主系统，检查“内容创作”双按钮及“系统设置 → 创作设置”。

尚未提交或推送。若进行源码交付，仅按本轮增量与相关文档审查，并遵守净化源码流程，不整体上传开发工作树或含业务数据的旧 Git 历史。

## 上下文与关联

- [当前交接入口](../development/handoff.md)、[Docs as Code](../development/docs-as-code.md)、[前端操作入口](../frontend-workspace.md)。
- 前后端消息：`content-workbench:navigate` 与原 `content-workbench:view-changed`；设置实际保存继续调用 Signal 原 `api/config`，连接测试继续调用原 `api/test-model`。
- 专项测试为 `test/creation-navigation-ui.test.js`；原共享素材选择器和工作台业务代码沿用，不新增业务接口。
