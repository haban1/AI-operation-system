# 内容创作白边修复

## 背景与目标

用户截图中，内容创作页面两侧及底部出现浅色边框，需要恢复统一深色背景。

## 变更与影响

`public/hot-topic-studio.css` 中创作工作区及 iframe 的背景从旧版浅色改为 `var(--bg,#080e13)`；`public/index.html` 更新该样式的缓存版本。只调整这两项背景，不改布局间距、脚本、后端、配置或业务功能。

## 决策与取舍

白边来自外层工作区的旧背景透过现有 padding 显露，并非视频或内容引擎画面问题。统一容器和加载时 iframe 的背景，保留既有桌面及窄屏留白和 iframe 保活。

## 验证与证据

隔离环境复现修复前浅色背景；使用真实主壳和内容引擎静态页面、模拟业务接口，验证六个创作栏目在 1720px 与 390px 下容器及 iframe 均为深色，无页面横向溢出、脚本错误或写请求，共十三个前后场景。桌面与窄屏截图已目视检查。

`node --test test/workspace-presentation-ui.test.js`：5 pass、0 fail、0 skip。线上主入口 HTML 和带新版本的 CSS 均 HTTP 200，MIME、SHA-256 与本地文件一致。私有脚本、截图与报告位于 `.codex-work/studio-white-edge-20261110/`；模拟页面不代表真实生成、发布或收发验收。

## 部署与回退

已通过现有 `public/` 挂载生效，无需构建镜像或重启服务。回退时仅恢复本轮私有 `backup/public/` 中的 CSS 与 HTML，保留其他既有修改。

## 未完成与下一步

已修改并应用，未提交、未推送。本轮无剩余修复项；后续 Git 交付携带本记录和交接入口，按既有净化源码流程单独审查范围。

## 上下文与关联

- [稳定交接入口](../development/handoff.md)
- [前端操作入口](../frontend-workspace.md)
- [预览布局对齐](2026-11-10-preview-layout-match.md)
