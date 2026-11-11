# 恢复知识库人设配置与本地 RAG 测试

## 背景与目标

用户在文件增删改查精简后要求补回回答风格（人设配置）和类似旧小智的 RAG 问答测试，以便在本地检查知识问答效果。保留文件自动生效，继续移除旧审核、发布、回退、问法生成和自定义转人工说法流程。

## 变更与影响

知识库现在有文件管理、人设、RAG 问答测试三个栏目。人设支持助手/组织名称、表达要求和问候语；加载失败不提供可编辑的默认表单，保存失败保留输入，取消只撤销未保存修改。保存配置用于下一次正式和测试 RAG 问答，已有有效配置重新启用。

新增 Web `POST /api/rag/test-query`，使用当前有效索引和正常 `/rag-api/v1/query`，返回答案、引用、无答案原因与追踪信息。私信支持最近三轮连续问答，评论单轮；浏览器支持清空、切换场景、失败重试和忽略过时返回。`#xiaozhi` 转到 `#reply-test`。恢复 Web/RAG 人设读写 API，数据库保存与生成逻辑均已接通。详细合同见 [知识库操作与接口](../knowledge-files.md)。

关键文件为 `public/knowledge-tools.js`、`src/services/rag-local-test.js`、`src/server.js`、`src/services/rag-client.js`、`rag-service/app/persona.py`、`rag-service/app/persona_api.py`；同步调整导航、缓存、样式和当前测试合同。

## 决策与取舍

人设是表达配置，不改变证据阈值、事实和引用规则；请求开始时冻结配置，处理中修改只影响后续请求。保存人设不触发索引重建或发布，也没有审核步骤。

测试直接复用正式 RAG 链路，服务端固定知识范围、证据要求、独立 ID 和按管理员/会话隔离的 `LOCAL_TEST` 命名空间。上下文仅接受成对 USER/ASSISTANT，最多六条/12000 字，问题最多 4000 字，回答上限 600 字。它测试检索与生成，不模拟完整平台外层路由/发送策略。对话仅保留浏览器内存，退出登录清空；RAG 继续保存既有脱敏追踪。不恢复旧小智审核数据、答案启停或发布治理服务。

## 验证与证据

- Node：`node --test --test-concurrency=1 test/knowledge-tools.test.js test/rag-answer-profile-client.test.js test/rag-answer-profile-proxy.test.js test/rag-answer-profile-ui.test.js test/knowledge-files.test.js test/hot-topic-knowledge-files.test.js test/formal-rag-routing.test.js test/formal-rag-context.test.js test/message-router.test.js test/mini-program-processing.test.js test/rag-formal-routing-integration.test.js`，97 pass、0 fail、0 skip。
- Python（在 `rag-service/`）：`.venv/Scripts/python.exe -m pytest tests/test_answer_profile.py tests/test_reply_style.py tests/test_file_manager.py tests/test_local_embeddings.py -q`，28 pass。包括持久化、认证、非法字段、跨知识库隔离、两种生成后端、真实管道传入保存的人设、请求中修改不影响已冻结配置，以及文件生命周期；第三方 pytest 插件有弃用提示。
- 实际 Chrome 在 1440/390 像素操作通过：人设读取、撤销、保存失败保留、重新保存、加载失败重试；测试失败保留问题、连续三轮上下文、来源、无答案、单轮评论、清空等待中请求、旧小智链接；无脚本注入、页面异常或横向溢出。四张桌面/手机截图已目视检查。
- 最后补充新回答自动滚动到最新位置，重新执行 `node --test test/rag-answer-profile-ui.test.js`，两项桌面/手机操作与滚动断言通过；没有为纯缓存标记更新重复运行业务回归。
- 隔离代理测试检查业务消息、会话、Agent 任务、小程序处理任务和通知计数不增加；认证失败不调用 RAG，客户端不能改知识范围或关闭证据，快照不符拒绝展示，旧审核/发布接口仍 404。
- 本地部署后人设读取 HTTP 200、25 份原知识全部 ACTIVE。真实本地测试接口 HTTP 200，RAG 追踪 OK、ANSWERED、3 条引用，使用 `openai_compatible` 生成，耗时约 44 秒。未修改真实人设或知识文件，未手动执行平台发送/发布。
- 账号、消息、会话、通知和小程序任务计数与部署前一致。部署期间原有调度器继续创建完成了采集任务，因此没有将全局 Agent 任务计数宣称为不变；测试接口无业务写入由隔离断言和调用路径验证。
- 六项在线 HTML/JS/CSS HTTP/MIME 正确且 SHA-256 与本地一致；Web/RAG 均 running/healthy。独立临时索引的 Docs as Code、当前文档链接、源文件语法与差异空白检查通过，真实暂存区未改动。私有 `manifest.json` 记录 23 个本轮相关路径及两个已有测试依赖，脱敏在线证据和清单留在下述私有目录。

未运行整套历史 `npm test`；其中仍列有旧审核/发布等已移除合同的专项。隔离确定性测试不能证明所有真实问题都能回答；本轮只对一个现有知识问题实测在线生成，也没有真实渠道发送或发布验收。

## 部署与回退

已通过现有源码 bind mount 应用，并重启 `tianhe-dev-rag-1`、`tianhe-dev-web-1`；没有重建其他业务容器或进行数据库 schema 迁移。启动前确认无执行中的 Agent/小程序任务、知识解析或索引构建。源码起始备份、RAG SQLite 在线备份、截图、测试日志、在线脱敏检查和清单位于 `.codex-work/knowledge-playground-20261110/`，不得上传。

维护回退时只撤销本轮人设与测试接口/导航改动、移除本轮新增模块，保留文件 CRUD 与其他同期修改，再重启上述两个服务。按范围清单及起始备份逐段审查，禁止覆盖整个脏工作树。配置使用既有 `service_meta`，回退源码不自动清理已保存的人设；若用户后来修改配置或知识，不得直接还原数据库备份覆盖新数据。

## 未完成与下一步

已修改并在本地生效，未提交、未推送。用户可在“知识库 → 回答风格 / 人设”调整并保存，然后在“RAG 问答测试”输入代表性问题检查回答与来源。需要源码交付时在净化发布工作区选择本轮实现、测试、主题文档、变更记录和交接入口，重新审查并执行适用检查；不携带旧开发历史、真实数据或私有证据。

## 上下文与关联

- [当前操作与接口](../knowledge-files.md)
- [RAG 架构](../../rag-service/ARCHITECTURE.md)
- [文件精简记录](2026-11-10-knowledge-files.md)：其“移除回答风格/测试”是上一阶段状态，以本记录和当前主题文档为准。
- [稳定交接入口](../development/handoff.md)
