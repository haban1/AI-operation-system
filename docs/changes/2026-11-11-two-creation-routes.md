# 2026-11-11：内容创作仅保留两种入口

日期：2026-11-11（Asia/Shanghai）。状态：已修改并应用，未提交、未推送。基线 main，HEAD ef4375b；工作树含其他任务的既有修改。

## 背景与目标

用户要求删除内容创作首页的 AIGC 创作入口，只保留自动成片和素材智剪，维持界面简洁。

## 变更与影响

删除 engines/video-studio/dist/index.html 中的一张首页卡片，更新样式缓存版本；style.css 的首页布局从三列调整为两列，手机仍为单列。更新现有导航测试及[操作入口](../frontend-workspace.md)。顶栏、素材库和创作设置位置沿用上一轮。

## 决策与取舍

仅移除入口，保持旧 #creation 路由、历史会话、素材类型与后端接口兼容；不扩展为删除业务能力。两个剩余入口继续使用原工作台。

## 验证与证据

执行 node --test test/creation-navigation-ui.test.js test/workspace-presentation-ui.test.js test/content-library-picker.test.js，10 项通过、0 失败、0 跳过。测试使用隔离数据和模拟写请求，覆盖两张卡片、自动成片与素材智剪进入、草稿/筛选保留及系统设置操作。人工检查 1440px 和 390px 首页截图，分别为两列和单列。证据位于私有 .codex-work/two-creation-routes-20261111/evidence/。运行容器和派生镜像两文件 SHA 均与源码一致；未经登录的 HTTP 验证返回 401，未将其当作页面加载验收。未测试真实生成、配音或发布，未运行全量历史集成测试。

## 部署与回退

已热更新 tianhe-dev-web-1 中 /app/engines/video-studio/dist/ 的 style.css、index.html；容器镜像 ID 保持不变，无服务重启。已构建 tianhe-web:two-creation-routes-20261111，并更新现 Compose 标签 tianhe-web:f0174d9-logo-20261029，保证重建保留改动。回退时将私有 .codex-work/two-creation-routes-20261111/backup/runtime/ 的两个文件复制回同一目录，并将 tianhe-web:before-two-creation-routes-20261111 重新标记为现 Compose 标签。源码备份在同目录 backup/source/；恢复前检查是否已有后续修改。部署清单为 deployment.json。

## 未完成与下一步

入口调整已完成；刷新内容创作页即可查看。下一位接手者先核验当前 Git 状态和本轮私有清单；如需源码交付，单独审查本轮增量，执行净化快照流程，不整体上传既有工作树或旧开发历史。本轮未提交或推送。

## 上下文与关联

参阅[稳定交接入口](../development/handoff.md)、[上一轮导航迁移](2026-11-11-creation-navigation.md)和[Docs as Code 规范](../development/docs-as-code.md)。后端、AI、采集和微信配置未在本轮调整；其他任务修改保留。
