# 全系统客户端精简预览

日期：2026-11-09（Asia/Shanghai）。本目录为独立设计资料，尚未实施到平台。

## 查看方式

完整克隆或下载本目录后，双击 [index.html](index.html) 查看 44 页图片图册。
支持上一页、下一页、左右方向键、目录跳转与原图查看。
[interactive.html](interactive.html) 是自包含交互预览，可点击模块、筛选任务及模拟对话。
两者均可离线查看；不通过 GitHub 的源码文本页直接运行。

需要压缩包时，在本目录运行：

```powershell
Compress-Archive -LiteralPath index.html,interactive.html,pages.json,shots,README.md -DestinationPath 全系统精简预览.zip
```

压缩包是本机生成物，不重复纳入 Git。源码图册已移除依赖该压缩包的下载入口。

## 覆盖与精简

44 页覆盖运营总览、内容创作、发布管理、用户互动、微信客服、知识与回复、平台账号、
系统设置八大模块；完整目录见 [pages.json](pages.json)，缩略图见 [全系统预览总览](全系统预览总览.jpg)。
第三方创作工具仅呈现主要工作区，不复刻其所有内部弹窗。

- 移除顶部 AI 已连接、全局运行、刷新及管理员装饰区。
- 删除重复长说明、英文装饰标题、技术编号和无操作意义的状态标签。
- 保留核心状态、来源声明、发布确认、异常提示、转人工与知识测试边界。
- 详细口径和高级配置按需展开，页面优先表达标题、动作和结果。

## 文件与维护

`preview.js`、`preview.css` 为交互预览源文件；修改后运行 `node build.mjs` 重建
`interactive.html`。`index.html` 自带图册逻辑和目录，`shots/` 为已导出的 44 张静态截图。
若修改页面结构或目录，需要同步图册、截图及验证记录；本次不提供自动重截生产页面的工具。

[validation.json](validation.json) 与 [capture-audit.json](capture-audit.json) 保留本轮浏览器验证，
并非持续测试结果。后续改动必须重新核验，不能沿用旧结果宣称通过。

## 使用边界

所有数字、名称、回复和账号状态均为人工示例。交互仅改变当前预览页面，
不访问业务 API、不发送消息、不发布内容、不连接模型；CSP 禁止接口连接及表单提交。
未修改实际平台源码、配置、数据库或登录态，未重启服务。

截图基于桌面浏览器尺寸，未验收手机布局和真实业务功能。
开发接续与 Git 交付状态见 [本轮变更记录](../../docs/changes/2026-11-09-client-simplification-preview.md)。
