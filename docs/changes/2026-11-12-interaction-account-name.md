# 评论与私信账号选择显示真实昵称

## 背景与目标

用户要求评论页平台名称前显示当前登录账号真实昵称，未登录或检测不到昵称时只显示平台。原下拉拼接 platform_name 和 display_name，展示的是手工账号标签。

## 变更与影响

`public/app.js` 新增互动页面账号名称格式化，只有 login_status=READY 且 platform_user_name 去除首尾空白后非空时显示“昵称 · 平台”；其他情况只显示平台。评论、私信共用的下拉与账号说明统一使用该规则，不回退到手工标签或历史快照。

已有五秒 bootstrap 刷新在消息页原位更新 option 文本和账号说明，现有自定义选择框同步名称，不重建页面或改变所选 ID。`public/index.html` 更新 app.js 缓存版本。后端、采集、登录检测及账号管理不变；操作见 [前端工作区](../frontend-workspace.md)。

## 决策与取舍

沿用总览已采用的 READY/platform_user_name 规则，昵称缺失时不猜测，不新增接口或主动触发平台登录。初始模板使用 esc，刷新用 textContent，昵称内特殊字符按纯文字显示。只调整用户指出的互动账号选择与关联说明，保留其他管理页面的标签用途。

## 验证与证据

`node --test test/background-refresh.test.js test/background-dom.test.js`：21 项通过。私有 Playwright 在 1440/390 宽、日间/夜间共四场景核对评论与私信：真实昵称、过期/未知/禁用隐藏历史昵称、空白昵称仅显示平台、特殊字符安全显示、后台改名与登录失效同步、选中 ID 和选择框节点保留。无脚本异常、业务写请求或页面横向溢出，已查看下拉截图。

本机实际评论下拉逐项与 bootstrap 字段一致；app.js、index.html HTTP 200 且 SHA-256 与宿主源码一致。Web/RAG 镜像及启动时间不变，相关 diff --check 通过。隔离文档索引检查通过，主索引为空。证据与备份位于 `.codex-work/interaction-account-name-20261112/` 的 validation.json、tests.log、docs-check.log、截图及 backup/public，私有目录不上传。本轮未进行真实平台登录或重新验收昵称采集链路，接口无昵称时按规则只显示平台。

## 部署与回退

通过现有 public bind mount 静态热更新应用，无服务重启、数据库或配置迁移。刷新页面载入新入口版本即可。回退仅逆向本轮两个文件增量，或对照私有 backup/public 恢复对应部分，保留同期其他修改；不恢复业务数据或重置整个工作树。

## 未完成与下一步

已修改并应用、未提交、未推送。后续真实登录检测回填昵称后，页面自动显示；登录失效会自动隐藏名称。后续源码交付使用净化 checkout，只同步本轮增量和关联文档。

## 上下文与关联

[总览昵称规则](2026-11-12-dashboard-account-name.md)、[前端入口](../frontend-workspace.md)、[稳定交接](../development/handoff.md)、[Docs as Code](../development/docs-as-code.md)。本开发目录有大量既有修改和私有历史，不直接从此目录推送。
