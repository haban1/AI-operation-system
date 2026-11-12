# main 撤回工作台外框重构

2026-11-12。基线 `18823b4`（main）。用户要求这一轮不进 main，改放分支 `ui/shell-refactor`。main 上新增撤销提交，界面回到 `a6f33c0`；原改动与记录保留在分支。详见 [完整记录](../../docs/changes/2026-11-12-revert-shell-refactor-on-main.md)。

下一步：用户对比两个端口后决定是否合并；合并前需先撤销本次撤销。
