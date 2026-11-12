# 开发交接入口

2026-11-12（Australia/Sydney）内容创作已在独立 3101 环境对齐 main `88907a5`，包含智能混剪和
AI 热点自动生成两入口。混剪完整链路通过，热点长响应中断仍阻塞成片验收；本次按用户要求交付 main 源码，未正式替换。
继续开发先读 [本轮接续](changes/20261112-content-main-integration.md) 及其中验证边界。

2026-11-12 本机 main 合并与部署、模型探测修复、账号/接口测试准备见 [本轮接续](changes/20261112-main-merge-restart.md)。用户明确暂不登录账号，小程序/企微配置由用户补齐；不能把接口健康写成全渠道就绪。

2026-11-12 的本地预览闪烁修复见 [后台更新记录](changes/20261112-dashboard-refresh-flicker.md)。自动轮询保留，数据变化原位更新，专项回归与真实浏览器证据见记录。

2026-11-11：当前智慧驱动净化源码交付见[本次记录](changes/20261111-current-source-sync.md)。正式界面已按预览重构，知识入口已改为文件自动生效、人设和本地 RAG 测试；旧审核/发布/回滚 UI 与接口不再使用。当前入口以[稳定交接](../docs/development/handoff.md)及对应功能文档为准。下方按日期保留历史状态，不覆盖当前用户约束。

2026-11-09：已将 GitHub main `bd66d8f` 集成并部署到本机 Web/RAG，保留本机既有修复。
实际验证、私有备份入口和回退见 [部署接续](changes/20261109-main-deployment.md)。

2026-11-09：新增 [44 页客户端精简预览交付](changes/20261109-client-simplification-preview.md)。
本轮仅交付独立设计预览，未替换平台界面。Git 文档检查补充规则见
[Docs as Code](../docs/development/docs-as-code.md)。

先读 [规范](POLICY.md)，当前口语修复见
[查询改写与重排对齐](changes/20261109-colloquial-query-alignment.md)，此前调整见
[五次澄清上限](changes/20261106-five-clarification-attempts.md)，本次接入记录见
[20261106 Traceable RAG](changes/20261106-traceable-rag-integration.md)，长期边界见
[兼容接入决定](decisions/0001-operations-rag-boundary.md)。

业务历史入口为 `START_HERE_NEXT_CODEX.md` 与 `docs/CODEX开发交接-20260915.md`。
在线核心在 `rag-service/app/pipeline.py`；表达层在 `rag-service/app/persona.py`；
运营侧路由在 `src/services/formal-rag-routing.js`；后台代理在 `src/server.js`。

测试：`rag-service/.venv/bin/python -m pytest -q`，Node 使用 Node.js 24+，
`node scripts/run-tests.mjs --test --test-concurrency=1 test/formal-rag-routing.test.js`。
浏览器测试需要设置 `CHROME_EXECUTABLE_PATH`。

Docker 用明确 COPY 和有效 ignore 隔离开发资料；Windows 安装器用明确目录清单。
实际验证结果与未验证的运行环境以 changes 记录为准。
