# 互动工作台设计参考

从 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 下载选定设计规范，固定上游提交 `fcc70284932276d085f01ef9f83edde90b1258cb`，2026-11-17 引入。该项目是 DESIGN.md 合集，不是运行时组件包或 Codex skill；本项目采用其复制文档的接入方式，没有执行第三方安装脚本。

- 原文：[Linear DESIGN.md](linear/DESIGN.md)，未修改，SHA256 `30bd30e72c48a16e4bdbd010f2d1c85fab657c6fae3cc85389399aab10f9cb5f`。
- [MIT 许可证](LICENSE)，保留上游版权。
- 原始地址：`https://raw.githubusercontent.com/VoltAgent/awesome-design-md/fcc70284932276d085f01ef9f83edde90b1258cb/design-md/linear.app/DESIGN.md`。

选用其克制强调色、细边框、层次化表面、8px 控件圆角与 4px 间距原则。适配业务工作台：保留系统日间蓝色/夜间紫色令牌和中文字体，使用 12–14px 操作正文、横向状态筛选与列表/详情双栏。没有照搬营销页大标题、96px 区块留白、仅深色限制、商标或专有字体。

实现仅作用于 `.ws-interactions`，入口 `public/interaction-theme.css`；后端接口、自动采集、分组、回复和原操作事件沿用。无评论或筛选无结果时隐藏详情列，避免空面板占位。操作与维护入口见[版本接手索引](../../development/operations-release-2026-11.md)。

2026-11-17 根据用户后续要求，平台选择进一步加入玻璃模糊、轻反光与悬停反馈，评论列表采用独立圆角卡片。这是本项目的视觉适配，非上游 Linear 原规范；反光跟随系统光效开关。两种主题及工作区使用方法见[前端工作区](../../frontend-workspace.md)。
