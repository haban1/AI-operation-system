# 微信客服与主系统主题统一

## 背景与目标

用户反馈微信客服与主系统配色和 UI 割裂。内嵌微信前端原来固定深色、绿色，与主系统日间/夜间主题无关。本轮统一外观，保留现有业务入口、接口、账号和配置。

## 变更与影响

微信前端的 ThemeSettingsProvider、themeConfig 和新增 workbenchTheme 读取同源父页面的主题及 CSS 颜色；新增 workbench-theme.less 统一账号栏、页签、按钮、会话、表单和设置外观，由 index.less 引入。RobotDetail 仅将内嵌页签圆角改为 8px。

主系统 public/workspace-v2.css 去掉微信工作区重复外框及悬停光边，重新加载按钮改为中性色；public/index.html 更新该样式缓存版本。手机端页签和设置入口换行，修复列表筛选、群发栅格和长人设内容撑出页面的问题。独立微信管理入口保留个人主题偏好。

## 决策与取舍

复用主系统现有 data-theme 和 --tk-*，映射至 Ant Design 主题；深色算法生成后保留主系统的明确颜色，避免主色再次变暗。MutationObserver 同步主题，不重新加载 iframe，避免清空表单和筛选。样式限定 data-workbench-theme，仅改变内嵌外观；无需后端接口或新增设置项。

## 验证与证据

- 隔离微信前端在 node:22-bookworm-slim、pnpm 8.15.9 下运行 pnpm lint、pnpm build-types、pnpm build，全部成功。
- node --test test/wechat-workbench-proxy.test.js test/wechat-workbench-integration.test.js：14 项通过；微信前端 preferences.test.mjs、load-robot-accounts.test.mjs：6 项通过。
- Playwright 检查 1440/390 宽、日间/夜间、七个业务/设置页签，共 28 个场景，无页面脚本异常及页面横向溢出；父子主色一致，搜索筛选切换主题后保留，独立入口保持个人主题。
- 额外验证接待设置抽屉在主题切换后保持打开，群发编辑内容和 iframe 实例保留，账号详情可打开。全部验证未执行保存、群发或其他业务写请求。
- 本机 3100 的四个实际日夜/宽度场景通过；七项线上 HTML/JS/CSS 资源 HTTP 200、SHA256 与候选一致；8080 首页 HTTP 200 且与构建一致。容器内 53 个构建文件哈希一致。
- 626 个后端文件哈希不变；微信前端、Web、RAG 容器镜像及启动时间不变，Web/RAG healthy。

私有证据在 .codex-work/wechat-theme-20261112/ 的 build.log、node-tests.log、frontend-tests.log、visual-validation.json、interaction-validation.json、online-validation.json、deployment.json 和 screenshots/。已查看桌面及手机代表截图。微信当前离线，朋友圈读取返回原有 code 500 / MMTLS 解密错误（四个主题/宽度重复请求），不能将页面样式验证视为朋友圈或真实收发验收；本轮没有修改协议、登录或业务错误处理。

## 部署与回退

已应用本机：public 使用现有 bind mount；微信静态资源先复制、最后更新 index.html，保留旧哈希资源，未重启业务容器。派生镜像 tianhe-wechat-ui:native 已更新，供后续正常重建使用；旧标签备份为 tianhe-wechat-ui:before-theme-20261112。运行容器 image ID 不变是静态热更新的预期结果。

本轮原文件在私有目录 backup/source/，旧运行静态资源在 backup/dist/。回退时只恢复本轮八个前端源文件增量（新增的两个文件对应移除）、恢复旧运行 dist 的资源并最后恢复 index.html，将 native 标签重新指向备份标签。不要整体重置工作树、恢复业务库或重启微信协议服务。部署脚本和哈希清单在同一私有目录，先核对后续改动再恢复。

## 未完成与下一步

已修改并应用，未提交、未推送；不从包含私有历史的开发库直接发布。后续 Git 交付仅同步本轮八个前端文件和相关文档到净化 checkout。用户可刷新微信客服查看日间/夜间效果；真实收发和朋友圈读取须在用户自行登录后另行验收，本轮不更改用户暂不登录的选择。

## 上下文与关联

- [前端操作与入口](../frontend-workspace.md)、[稳定交接](../development/handoff.md)。
- [原主题记录](2026-11-11-day-night-theme.md)、[本轮之前的部署与登录边界](2026-11-12-main-merge-restart.md)。
- [Docs as Code](../development/docs-as-code.md)、[净化源码发布](../GitHub源码仓库说明.md)。所有既有工作树修改保留，本轮无业务数据库、凭据或登录态进入文档。
