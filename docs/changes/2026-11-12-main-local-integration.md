# 2026-11-12：最新 main 与本机功能集成、重启

日期：2026-11-12（Asia/Shanghai）。公开基线 88907a5，实际 fetch 的 main 为 4982464。提交及推送结果以净化 checkout 的 Git 历史和远端为准。

## 背景与目标

用户要求拉取 GitHub 最新版本、合并提交并重启前后端。保留本机已部署的五平台互动概览、真实账号昵称、消息完成后通知归档、微信主题与人工接待、局域网 RAG 测试会话兼容修复，以及账号、知识、人设和模型配置。

## 变更与影响

快进取得 a5561bb、7572fd4、fed4cc2、304f707、4982464，合入智能混剪、字幕与 AI 调整、热点来源重试、统一成片库及创作界面。以 88907a5 为三方基线，将筛选后的本机增量应用于最新公开源码；app.js、server.js、前端说明自动合并，index.html 的缓存版本和交接记录冲突手工处理，保留双方功能与记录。旧发布净化差异、仅换行的测试变化及原开发 AGENTS 未覆盖公开版本。

本次集成交付此前未提交的互动概览、昵称、通知归档和微信接待等源码、测试及对应记录；各功能细节与此前验证见关联文档。人设属于运行配置，保留本机数据，不把实际配置复制到源码。

线上核对发现新增混剪引擎仍只接受 localhost，导致局域网入口返回 403。新增 authenticatedMount 内部选项，仅由主系统已认证的混剪挂载启用；独立引擎仍限制回环访问。保留 Host 合法性、同源 Origin、操作 token、上层管理员登录。新测试覆盖局域网读写、独立模式拒绝、缺 token 和跨源/协议不一致拒绝。

## 决策与取舍

沿用 haban1/AI-operation-system 的独立净化 checkout，未合入含真实业务库的旧开发历史。普通 Git fetch 成功，无需 REST 对象重建。改动按文件筛选与三方比较，未整体覆盖上游或本机。

Web/Signal 从本机既有镜像派生，只复制明确的运行引擎目录，安装 montage 锁定依赖；未重建无变化的语音/系统依赖。配置文件、数据卷、微信前后端及登录协议保持原样；主系统前端随 Web 重启。微信前端源码重新构建核验，当前已部署同一功能版本，无需重复替换静态文件或重启微信登录服务。

## 验证与证据

- Windows/Chrome：node --test --test-concurrency=1 test/interaction-overview.test.js test/handoff-resolution.test.js test/handoff-resolution-api.test.js test/notification-outbox.test.js test/background-refresh.test.js test/background-dom.test.js test/comment-post-list-ui.test.js test/workspace-presentation-ui.test.js test/rag-answer-profile-ui.test.js test/creation-navigation-ui.test.js，87 项通过，0 跳过。
- Linux 部署候选镜像：montage-ai、montage-codex-planner、montage-shot-editing、montage-production、montage-workbench、content-library-copy-integrity、content-library-admission、content-library-studio、video-studio-proxy、ai-signal-proxy 共 75 项通过。局域网修复后最终镜像追加运行 montage-lan-access、montage-workbench、montage-production，共 22 项通过；与前述重叠，不相加计数。Windows 初跑 99/111，失败涉及缺 ffmpeg 与 Unix CLI 测试脚本，已在实际 Linux 候选环境验证。
- Signal：python3 -m unittest discover -s tests -v，93 项通过。隔离容器先取消镜像中 SIGNAL_CONFIG_DIR，使用测试临时配置；初跑该环境变量干扰两项配置隔离测试，修正测试环境后通过，未更改业务配置。
- 微信前端在 Node22/pnpm8.15.9 下 lint、build-types、tsc --noEmit、build 成功。初次先运行 tsc 缺生成文件，生成后通过；不将生成物加入 Git。
- 本机 LAN：18 个适用认证读接口 HTTP 200，非法 accountId HTTP 400。涵盖总览、消息/概览、账号、任务、运营看板、知识/人设/AI、通知配置、采集端、创作/Signal、混剪和微信账号列表。3100 首页/health、8080 首页 HTTP 200；7 项更新 public 资源、90 个镜像内引擎文件 SHA256 与候选一致。Web/RAG/Signal healthy，RAG READY，Windows 采集端在线。
- 7 份环境/Compose 文件 SHA 不变，Compose 生效配置与重建前环境变量、挂载目标一致。Web 两次快照的账号/消息/会话数量及账号/消息 ID、账号与平台开关一致；Web/RAG quick_check=ok。RAG 知识、索引与其他业务表哈希保留，只有超期幂等记录清理及 sqlite_sequence 变化；不宣称数据库逐字节一致。
- 最终 Web/Signal 镜像实查均无 /app/dev-notes；部署 context 只含明确引擎目录，不带本地数据、文档或秘密。44 项本机增量按配置秘密与 token/private-key 模式扫描无命中；提交前再次检查最终索引和文档。

私有证据位于 .codex-work/sync-restart-20261112/：merge-plan.json、deployment-plan.json、windows-node-final.log、container-node-tests.log、lan-container-final.log、signal-python-tests-final.log、build-wechat-final.log、verification.json、data-validation.json、audit.json。原始响应、Docker inspect、在线数据库备份和配置仅留本机。初探不存在的 operations/analytics、混剪 projects GET 被纠正为合同已有的 operations-dashboard、templates，未为探测新增接口。全量历史测试、真实平台收发/自动回复、AI 生成和发布未重新验收。

## 部署与回退

19:40 重建 Web/Signal 并重启 RAG；19:53 局域网修复后再次重建 Web（均为北京时间）。使用原 compose.yaml、compose.wechat.yaml、compose.workbench.yaml，up -d --no-deps --no-build web signal；RAG 使用 docker restart。没有清理 orphan 容器、删除卷或重启无关项目。

本机备份位于私有工作目录 backup/，含在线 Web/RAG 数据库、配置及原源码。node .codex-work/sync-restart-20261112/rollback.mjs 已执行 dry run，核验 102 个部署路径；必要时加 --apply，恢复有哈希保护的源码、原派生镜像标签并重启 Web/Signal/RAG。存在后续修改时拒绝覆盖；不自动恢复数据库、配置或微信登录，避免丢失新数据。原镜像保留为 tianhe-web:before-sync-20261112 和 tianhe-signal:before-sync-20261112。远端回退另建 revert，不改写历史。

## 未完成与下一步

下一位先读取本记录和当前交接，核验 main 与本机镜像及源码，再进行用户验收。尚未登录的渠道仍需用户登录；接口健康不等于全部平台可以自动收发。小程序/企微配置按用户此前决定在系统设置补齐，本轮未填占位配置或发送通知。

上游已记录热点长响应中断、部分来源需登录，以及创作导航偶发超时；本轮隔离回归通过不代表这些真实外部条件已解决。用户可刷新工作台测试互动和创作，真实生成、发送、发布按具体测试任务验收。

## 上下文与关联

- [稳定交接](../development/handoff.md)、[前端入口](../frontend-workspace.md)、[Docs as Code](../development/docs-as-code.md)。
- [上游内容集成](2026-11-12-content-main-integration.md)、[成片库流程](2026-11-12-content-library-flow.md)。
- [互动概览](2026-11-12-interaction-overview.md)、[通知归档](2026-11-12-handoff-resolution.md)、[微信接待](2026-11-12-wechat-reception-reply.md)、[微信主题](2026-11-12-wechat-theme-alignment.md)、[RAG 会话](2026-11-12-rag-session-id.md)。
- [开发接续](../../dev-notes/changes/20261112-main-local-integration.md)、[净化发布](../GitHub源码仓库说明.md)。此前同日记录中的“未提交/未推送”是当时快照，本次交付状态以本记录、Git 历史及本机 push-receipt.json 为准。
