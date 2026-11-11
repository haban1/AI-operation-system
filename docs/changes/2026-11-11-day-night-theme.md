# 2026-11-11：日间 / 夜间主题与界面光效

日期：2026-11-11（Asia/Shanghai）

状态：已修改，本地验证通过；未提交、未推送、未部署。工作目录为新克隆的 `main`，基线 `0c00079`。

## 背景与目标

用户在设计预览中选定两套界面：日间“晨雾浅色玻璃”为默认，夜间“夜幕光边”可切换；要求保留毛玻璃、光边、反光、3D 倾斜等科技感效果，同时不改原有业务逻辑和交互流程。内容创作页（`hot-topic-studio.css` 与嵌入工作台）本轮不在范围内。

## 变更与影响

- `public/styles.css`、`public/workspace.css`、`public/workspace-interactions.css`：所有写死的颜色改为 `var(--tk-角色, 原色)`，rgba 透明度通过 `color-mix()` 保留。没有设置主题时外观与改前一致（4 个页面截图逐像素比对，差异只在实时时间戳）。约 1,800 处替换，归入约 30 个角色：背景层级（`bg0/surface/surface2/surface3`）、线条、正文/次要/辅助文字，以及强调、成功、危险、警告、紫色各自的实底/浅底/边框/文字。替换用一次性脚本完成，规则按用途（背景/边框/文字/阴影）和色相、亮度分类，所在选择器含 success/published/ready 等字样的青绿色归为“成功”。
- `public/theme.css`（新增）：定义日间、夜间两组 `--tk-*` 颜色；页面背景加缓慢流动的雾面和细网格；侧栏、顶栏、栏目切换条为毛玻璃；面板与卡片为磨砂玻璃，鼠标悬停时出现光标光晕、发光边和反光；主按钮渐变加扫光；所有按钮有按压反馈；`data-fx="off"` 时为性能模式（关闭模糊、动画、倾斜）。
- `public/theme.js`（新增）：在 `<head>` 中同步执行，读取 `localStorage` 的 `ui-theme`（默认 `day`）与 `ui-fx`，在首屏渲染前设置 `data-theme` / `data-fx`，避免闪烁；在侧栏底部 `.side-actions` 加入“日间/夜间”和“光效”两个按钮；鼠标移动时更新卡片光效变量，指标卡等少数卡片随鼠标轻微倾斜。不读写业务数据、不调用接口。
- `public/index.html`：引入 `theme.js` 与 `theme.css`，更新三个样式文件的缓存版本号（`styles.css` 保留原 `20261102-platform-base` 前缀，`core.test.js` 依赖该字符串）。

`app.js` 及其他业务脚本、后端、接口、数据库均未改动。

## 决策与取舍

- 先把颜色变量化，再用主题文件赋值，而不是在 `theme.css` 里逐个覆盖选择器：原样式里约 15 种深色被重复使用上千次，逐个覆盖会产生大量高优先级规则，后续维护困难。变量化后删除 `theme.css`、`theme.js` 两个文件和 `index.html` 中的两行即可回到原界面。
- 光效只用 CSS 变量和 `background-image` 叠层实现，不向卡片插入额外 DOM，避免影响 `app.js` 频繁重绘的列表和网格布局。
- 大面积面板只保留光晕和发光边，不加反光，避免整屏闪动；倾斜只给指标卡和少数小卡片。
- 未设置 `ui-fx` 时，系统开启“减少动态效果”或 CPU 核数 ≤ 2 的设备默认关闭光效，照顾配置较低的 RPA 电脑。
- 用户曾指出按 taste-skill 规则去掉光效后“显得普通”，因此保留了该 skill 不建议的发光、扫光与倾斜；可读性方面的建议（字号、对比度、动效时长）仍然采纳。

## 验证与证据

macOS、Node.js 25.6、Chrome 本机：

- 以模拟模式启动 `node src/server.js`（端口 3190、独立临时数据库、关闭自动采集与 Local Agent），在浏览器中检查运营总览、发布内容、发布排期、发布任务、评论、私信、小程序对话、转人工记录、知识库、平台账号、AI 服务、消息通知、调用记录、浏览器状态、问题记录，日间与夜间均可正常显示；侧栏按钮切换主题并在刷新后保持。
- 悬停检查：卡片 `--mx/--my` 更新、发光边与光晕生效，指标卡倾斜生效。
- 自动对比度扫描（日间）报出的 12 处均核实为检查脚本误判（把 `color(srgb …)` 解析为黑色），实际背景为半透明白色。
- 测试：对 `core`、`publish-flow-ui`、`browser-status-ui`、`creation-navigation-ui`、`workspace-presentation-ui`、`runtime-gates`、`scheduled-publish`、`task-delete`、`xiaozhi-chat` 同时在改前（`git stash`）与改后运行：257 项中改前 12 项失败；改后在修正缓存版本字符串后无新增失败。`workspace-shell-ui`（等待已移除的 `aliases` 栏目）与 `material-audio-content-generation` 中 1 项在改前同样失败。另 11 个与页面相关的测试文件 88 项中，除上述 1 项旧失败外均通过或跳过。

## 部署与回退

本轮没有部署。生效方式与其他静态文件相同：更新 `public/` 后刷新浏览器。回退：删除 `public/theme.css`、`public/theme.js` 及 `index.html` 中对应两行即恢复原深色界面；如需完全还原样式文件，按本次提交反向应用三个 CSS 文件的改动。

## 未完成与下一步

- 内容创作页和嵌入的微信客服后台、创作工作台（iframe）仍为原深色样式，需要单独适配浅色，否则日间模式下会有割裂感。
- 设计预览中的布局优化（总览“今天要处理”行动条、AI 员工粒子球、评论三栏收件箱、发布手机预览、平台官方图标）尚未实现，涉及 `app.js` 渲染结构，需单独评估对现有测试与交互的影响。
- 在 Windows RPA 电脑上实测毛玻璃的性能，必要时把默认光效改为关闭。

## 上下文与关联

- 前端入口说明：[前端操作与功能入口](../frontend-workspace.md)
- 交互式设计预览（晨雾 / 夜幕）在用户的 claude.ai Artifact 中，不在仓库内。
- 设计参考：Anthropic `frontend-design` skill、taste-skill（`design-taste-frontend`）。
