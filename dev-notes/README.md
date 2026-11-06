# 开发交接入口

先读 [规范](POLICY.md)，最新调整见
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
