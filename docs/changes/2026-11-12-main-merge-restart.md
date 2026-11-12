# 2026-11-12：main 合并、本地部署与测试接通

日期：2026-11-12（Asia/Shanghai）。部署基线为 GitHub main a87d44e0c2baf6ef46b38936bf5878b4513fff44；本次提交另含模型连接测试修复和交接记录。

## 背景与目标

用户要求拉取最新 main、保留本机功能和配置、合并提交并重启前后端，进一步检查全部账号和接口是否可开始测试。后续用户明确暂不登录账号，小程序和企微通知由用户在设置页补齐。测试就绪必须区分服务联通与平台登录。

## 变更与影响

从已交付的 0c00079 快进合入 f553320、8b92b6d、a6f33c0，以及 18823b4 / cd6398c / a87d44e 的重构、撤回和恢复历史；最终采用 a87d44e 的工作台外框、日夜主题、分步发布和互动原位更新。运行源码累计应用 19 个 public 文件及 9 个相关文档，无业务冲突。本次只新增一处后端修复：src/services/qwen.js 的连接测试输出额度从 8 提到 128 token；添加 test/ai-connection-reasoning.test.js。

Web 与 RAG 已重启，Windows 浏览器采集端已重连。按用户“接通全部账号”的要求将原停止的抖音、小红书平台置为 RUNNING，五个平台账号及智能回复开关均启用；登录失效的渠道仍暂停执行，不伪造 READY。微信已有 AI 配置和人设保留。小程序、企微通知仍缺少实际接入配置。

## 决策与取舍

沿用独立净化 checkout 与原 GitHub main 历史，未合入含真实数据库的开发历史，不覆盖本机其他修改。普通 Git HTTPS 超时，改用 GitHub REST 获取真实 Git 对象，逐项核验 blob/tree/commit SHA 后快进；推送采用非强制分支更新。

真实 DeepSeek 请求证实 8 token 时 finish_reason=length、正文为空，128 token 时正常返回 OK；因此仅修正探测额度，保留所选模型、Key、回答及空回复/鉴权失败处理。模型与知识测试只在本地接口生成结果，不写入平台消息或发送任务。平台开启前核对 agent_jobs 无待执行/运行任务、publish_tasks 仅有已发布记录；未批量重试历史失败或待确认任务。

## 验证与证据

在最终净化 checkout、临时数据库和模拟平台执行：

- node --test --test-concurrency=2 test/background-dom.test.js test/background-refresh.test.js test/creation-navigation-ui.test.js test/workspace-presentation-ui.test.js test/comment-post-list-ui.test.js test/publish-flow-ui.test.js test/platform-analytics-ui.test.js test/browser-status-ui.test.js test/ai-model-settings-ui.test.js test/content-library-picker.test.js test/knowledge-tools.test.js test/rag-answer-profile-ui.test.js：76 通过，0 失败，0 跳过。
- node --test test/ai-connection-reasoning.test.js test/model-gateway.test.js：7 通过，验证推理模型探测成功、空正文/401 继续失败，以及原生微信对话/向量协议和鉴权。
- 20 个最终版隔离视觉场景：1440/390 宽度，日间/夜间，总览、评论、发布、小程序、转人工、账号、问题页，无页面异常或横向溢出；验证 Ctrl+K 搜索“定时”并回车跳转排期。已查看代表截图。
- 19 项线上 public 资源 HTTP 200 且 SHA256 与最终候选一致；3100 首页/健康、8080 首页 HTTP 200，Web/RAG healthy，RAG READY。四个相关容器镜像不变，Signal 和微信前端未重启。
- 实际认证检查 29 个适用读接口均 HTTP 200：主系统会话、总览、账号、互动、发布历史/排期/任务读取、问题、配置、知识库、浏览器、小程序状态、创作、微信代理/机器人列表/设置。初探 GET /api/publish/tasks 返回 404，经合同确认该路径用于 POST 创建；读取使用 GET /api/tasks，未增加多余兼容接口。
- 修复后 POST /api/settings/ai/test 成功；用微信现有配置调用统一模型网关，对话 HTTP 200 返回正文，向量 HTTP 200 返回 512 维。真实本地知识问答返回 ANSWERED 和有依据正文；29 份知识文件、29 个版本和 200 个分块保留。
- 部署阶段 7 个环境/Compose 文件哈希不变；174 个后端文件原先全不变，本次连接修复后只有 qwen.js 一行有意变化。Web 原 6 账号、293 消息、234 会话及账号/消息 ID 保留；两库 quick_check=ok。RAG 启动清理超时 COMPLETED 幂等记录，历史序列因 INSERT OR IGNORE 前进，业务表原内容未丢；后续本地问答会增加正常 trace/usage，不宣称数据库逐字节一致。

私有证据位于 .codex-work/merge-restart-20261112/：plan-final.json、increment/plan.json、node-ui-tests-final.log、evidence-final/、evidence-shell/、runtime-validation-final.json、data-validation.json、interface-validation.json、model-token-probe.json。原始配置、登录态、响应与数据库均不上传。83 项专项通过不能代替全量测试；既有 Python CI 的 9 个旧接口导入错误与上游旧 UI 测试限制仍见前次源码交付记录。OCR/视觉、真实平台收发、生成与发布未验收。

## 部署与回退

public 通过现有 bind mount 更新，先复制资源、最后更新 index.html，无镜像重建；执行 docker restart tianhe-dev-rag-1 tianhe-dev-web-1，后续探测额度修复只再次重启 Web。Windows 采集端通过已鉴权 shutdown 交由既有 supervisor 重启，原 profiles 保留。运行资料未复制 dev-notes，构建链未改变，本提交仅源码/文档且不触发生产自动部署。

本机初始源码/7 配置/两库在线备份在私有工作目录 backup/，追加上游应用前备份在 increment/backup/。node .codex-work/merge-restart-20261112/rollback.mjs 已执行 dry run、核验 29 路径；必要时加 --apply 恢复本轮原始源码并重启 Web/RAG。它先检查当前哈希，后续修改会阻止覆盖；不自动恢复数据库、配置或平台开关，以免丢失新业务。抖音/小红书可通过平台账号页单独恢复本轮之前的停止状态。Git 回退使用后续 revert，不改写远端历史。

## 未完成与下一步

用户确认暂不登录：B站已登录；抖音、视频号、微博、小红书需扫码，微信机器人离线。五个平台开关开启、采集服务在线不等于全部账号可执行。用户随后在“平台账号”登录并检查状态，在“微信客服”重新登录机器人；登录后再做新私信/评论、AI 回复、采集和发布的真实验收。

用户将自行在系统设置补齐小程序 AppID/网关/密钥与企微 Webhook；填写前保持未配置状态，不填写占位值、不发测试通知。填写后检查小程序连接和通知测试，再验收回调。当前已可进行主系统界面、知识问答、模型/向量、创作服务和已登录 B站的测试。其他渠道不能标为全量就绪。接手先检查 main 与实际部署 SHA，勿重复开启/重试不确定发送任务。

## 上下文与关联

- [当前交接](../development/handoff.md)、[前端操作](../frontend-workspace.md)、[开发记录](../../dev-notes/changes/20261112-main-merge-restart.md)。
- [上游外框](2026-11-12-shell-refactor.md)、[消息原位更新](2026-11-12-message-refresh-in-place.md)、[前次源码交付和旧 CI 限制](2026-11-11-github-source-sync.md)。
- [Docs as Code](../development/docs-as-code.md)、[净化源码发布](../GitHub源码仓库说明.md)。代码、测试和本记录同次提交；实际提交/推送结果以 Git 历史和本机 push-receipt.json 为准。
