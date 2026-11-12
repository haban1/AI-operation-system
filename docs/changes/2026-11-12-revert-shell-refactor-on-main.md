# 2026-11-12：main 撤回工作台外框重构，改由分支承载

日期：2026-11-12。基线 `18823b4`（main）。状态：已提交、已推送 main；未部署。

## 背景与目标

`18823b4`（工作台外框重构、用户互动页对齐、平台账号页简化）推送到 main 后，用户要求这一轮不进 main，改放到单独分支，并在本机分别展示 main 与该分支的界面以便对比。

## 变更与影响

- 在 main 上新增撤销提交，反向应用 `18823b4` 的全部改动；main 的界面回到 `a6f33c0`。
- 原改动保留在远端分支 `ui/shell-refactor`（指向 `18823b4`），内容与记录 [工作台外框重构](2026-11-12-shell-refactor.md) 一致。
- `docs/changes/2026-11-12-shell-refactor.md` 与对应 dev-notes 记录随撤销从 main 移除，仍在分支上。

## 决策与取舍

用户选择撤销提交而不是强制回退：不改写远端历史，已拉取 `18823b4` 的副本不会分叉。之后若要把分支合入 main，需要先撤销本提交（revert 这个 revert）或在分支上重新提交。

## 验证与证据

撤销后 `git diff a6f33c0 -- public` 为空；文档检查 `node scripts/check-docs-as-code.mjs --staged` 通过。

## 部署与回退

未部署。若要恢复到 main，revert 本提交即可。

## 未完成与下一步

用户在本机两个端口对比 main 与 `ui/shell-refactor` 后，决定是否合并。

## 上下文与关联

- 被撤回的改动：[工作台外框重构](https://github.com/haban1/AI-operation-system/blob/ui/shell-refactor/docs/changes/2026-11-12-shell-refactor.md)（分支 `ui/shell-refactor`）
- 上一版：[评论与私信原位更新](2026-11-12-message-refresh-in-place.md)
