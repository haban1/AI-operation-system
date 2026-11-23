# 智慧驱动：11 月 23 日 GitHub 源码交付

## 背景与目标

把 11 月 12 日晚至 20 日已经在开发工作区完成的产品更新交付到 `haban1/AI-operation-system` 的 `main`，使另一台机器可以从源码创建同样的三种混剪工程。仅交付源码，不在业务主机重新部署，也不复制账号与素材。

## 变更与影响

- 混剪增加「稳镜字动」：六个素材位、六段可编辑和锁定的字幕、分开的原创音乐和音效，预览与导出共用时间线。沿用现有两个模板的使用方式，包含目录导入、自动保存、全屏、入库后继续编辑或准备发布。
- 同步上次公开版本之后的发布与入库流程、互动收件箱与后台采集、账号与提醒展示、知识问答与微信客户端、热点任务取消、品牌资源和相应测试。各业务入口和运行边界见[版本索引](../development/operations-release-2026-11.md)。
- 去除已下线的发布格式预检服务，不代表可跳过内容审核、账号校验或防重发。保留同一原始 Logo 已公开的来源、第三方设计参考的 MIT 许可及音乐署名说明。

## 决策与取舍

以已核对的公开提交 `7c2f0f2f1caa6e91232767c78faaf2a9850b2d8d` 为父提交，只在独立源码仓库提交经过对照的增量，不连接或合并旧开发库历史。保留已有公开文档和远端独有文件；对新增的使用与交接说明作摘要，不照搬本机交接日志。部分测试夹具和提示词例子改用合成名称，不更改业务匹配条件。

只收录模板实现、可再生成的配套资源及产品所需品牌图，不收录课堂原片、示范成片、外购工程、运行库、配置秘密、浏览器会话、私信/评论原文或知识库原件。此为**本次增量**的边界，不是对既有 GitHub 历史执行清理。

## 验证与证据

对照源文件与公开基线并在净化候选副本复验，而非使用现网账号。以下 Node 分组在无外网的 Linux 测试容器中运行，使用临时存储、容器缓存的依赖与 Chromium。可按组执行 `node scripts/run-tests.mjs --test --test-concurrency=1 test/<名称>.test.js …`：

| 分组 | 实际覆盖文件（省略公共前后缀） | 结果 |
| --- | --- | --- |
| 混剪 | `montage-workbench`、`montage-ai`、`montage-steady-type`、`montage-shot-editing`、`montage-system-planner`、`montage-folder-upload`、`montage-autosave-library`、`montage-lan-access` | 34 通过 |
| 采集与账号 | `collection-quiet-window`、`quiet-persistent-context`、`wechat-channels-background`、`weibo-hot-topics`、`platform-douyin-flow`、`platform-weibo-flow`、`agent-platform-analytics`、`issue-account-identity`、`issue-copy`、`interaction-inbox-filter`、`login-expiry-notification` | 217 通过 |
| 发布与问答 | `publish-sync-reconciliation`、`publish-confirmation`、`publish-review-result`、`publish-without-precheck`、`task-status-simple`、`current-publish`、`knowledge-conversation`、`knowledge-conversation-api`、`wechat-knowledge`、`ai-request`、`material-upload`、`content-library`、`scheduled-publish` | 71 通过 |

- RAG：在 `rag-service/` 执行 `python -m pytest -q tests/test_query_rewrite_validation.py tests/test_reply_style.py tests/test_answer_profile.py`，对最终脱敏的示例重跑，96 通过。Signal：在 `engines/ai-signal-studio/` 的隔离环境执行 `python3 -m unittest discover -s tests -v`，97 通过。
- 微信 Go 客户端：在 `wechat-assistant/wechat-robot-client/` 以缓存的 Go 1.25.8 依赖执行 `go test -mod=readonly -p 2 -count=1 ./pkg/tianheknowledge ./pkg/openai_tools ./pkg/support` 及 `go test -mod=readonly -p 2 -count=1 ./service -run TestAIChatUsesSharedKnowledge`，19 通过。上述六组共 534 项，既不是全仓测试，也不代表真实渠道和收费模型完成验收。
- 此次没有重新编码课堂样片；此前竖屏真实导出和横屏浏览器验证的范围及限制见[模板记录](2026-11-20-steady-type-template.md)。
- 额外跑 `test/core.test.js` 和 `test/formal-rag-routing.test.js`：以完整 Git 源码快照在断网容器测试，仅从 `.env.example` 创建临时 `.env`。候选 234 项（226 通过、7 失败、1 跳过），公开父提交 236 项（228 通过、7 失败、1 跳过）。七个失败名称完全相同：旧重试测试准备步骤调用退役的知识接口返回 404、浏览器旧入口名、登出测试检查已移除的知识导入预览状态、三项旧知识导入或导航约定、旧设置面板布局。没有新增失败，不能据此声称相应真实业务已全部验收。最初裁剪测试目录还缺启动脚本和本地配置，已通过完整源码与公开配置模板排除这两项环境误差。

核心组少两项是因为旧素材预检接口与状态卡随旧流程移除；新合同由上表的 `publish-without-precheck` 和 `material-upload` 覆盖。模拟登出进一步验证定时器停止、页面内容与临时预览、草稿和账号状态清除；没有使用真实会话。提交前已核对 194 个暂存路径（183 个文本、10 个二进制、1 个删除）、新增文档相对链接、已配置秘密和常见密钥模式，未发现命中；Docs as Code 结构及保留原换行的空白检查通过。

## 部署与回退

推送 Git 仅更新源码；没有重启服务或迁移线上数据库。新环境按 [README](../../README.md) 配置自己的密钥、空数据与浏览器账号，构建时带上 `engines/montage15` 的封面、模板和两个音轨；主系统、热点引擎、Windows 采集端和微信客户端应按实际使用范围更新。回退源码使用新的 `git revert` 提交，或在单独检出目录使用上述公开基线重新构建；不要覆盖现有业务数据或强推旧分支。已创建第三模板工程时，宜先从新建名单下架，保留旧工程的渲染依赖。

## 未完成与下一步

未运行全仓测试、全套新机镜像构建、真实账号收发或平台发布，推送不等于线上部署。接手者在独立环境设置自己的配置，用合成素材完成导入、生成、入库的验收；需要部署时另外核验版本、配置、队列和回退方案。

## 上下文与关联

[稳定交接](../development/handoff.md) · [开发记录](../../dev-notes/changes/20261123-source-release.md) · [源码仓库边界](../GitHub源码仓库说明.md) · [功能索引](../development/operations-release-2026-11.md) · [模板使用](../../engines/montage15/README.md)。远端提交号及树以实际 Git 引用为准，不在本次提交中自引用未知 SHA。
