# 运营 Traceable RAG 兼容接入

- 时间：2026-11-06，Australia/Sydney
- 分支：`codex/traceable-rag-integration`
- 基线：`b8fcff778cc855a0dfb3846e25afed394c1aa5ad`

## 背景与决定

用户要求把改进的独立 RAG 用于运营系统“知识与回复”，修复频繁回问/转人工，加入
智慧驱动人设，同时保留原系统业务。两套服务的 API、索引与发布合同不同，直接覆盖
目录会破坏范围和状态边界；采用现有服务内的兼容移植，见
`decisions/0001-operations-rag-boundary.md`。

## 改动入口与理由

- `rag-service/app/retrieval.py`、`pipeline.py`：跨查询统一重排，单跳4/多跳6的证据先冻结，
  Gate 后同集合生成；最多两轮和四条重试查询，原发布/测试 scope 内合并。
- `agent.py`：工具只能复读审核集合；原问题/搜索改写分离；移除证据正文截断；生成配置
  使用请求开始的人设快照。实际引用验证为审核集合子集，防止造引用。
- `persona.py`、`persona_api.py`、`main.py`：复用 service_meta 按 KB 持久化展示配置；
  管理端认证、严格模型、事实/权限优先于风格；只在 Trace 中保存配置哈希/提示词版本。
- `formal-rag-routing.js`、`rag-clarification.js`：缺意图与缺证据区分，宽泛主题先检索；
  DM 缺证据不累计澄清，不因该原因自动转人工。评论、风险、人工请求/接管继续原规则。
- `server.js`、`rag-client.js`、`public/`：固定运营 KB 的管理员代理与“回答风格”界面。
- Node/Python 新增和更新回归，`rag-contract.yml` 持续检查；README、架构与操作说明同步。

保留 BGE/Qdrant、RRF16 候选池（重试可加最多6个首轮seed）、20/20召回、渠道最低阈值、
发布和回滚、快照和实际发送边界。未引入微信 RAG、自动调参、全套索引迁移或自动同步
外部仓库。更新了一个过时测试：现有抖音纯社交评论按 COMMENT_SOCIAL_REPLY，不能要求
它转人工。该产品路径本次未改变。

## 实际验证

- 修改前完整 Python：115 passed；修改后完整 Python：145 passed，15.48秒。
- 最终15文件 Node 专项：115 passed，0 fail，0 skip，49.28秒，设置真实 Chrome 路径。
- 补充分批测试覆盖完整小程序回调/重启/并发/人工终止、mini admin 和会话租约；与上述
  测试有重叠，不累加独立样本数。
- 官方 DeepSeek v4 Flash：隔离的五条合成FAQ/两份CSV，两个有依据问题回答，一个无
  收费资料的问题两轮拒答；检索为hash/lexical测试提供器，非真实业务准确率或RAGAS。
- 独立代码审查未发现阻止合入的问题。`core.whitespace=cr-at-eol diff --check` 通过。
- 细节与限制见 `docs/运营RAG验证-20261106.md`。

旧共享 node_modules 的 iCloud 占位文件使初次测试服务挂起；仅移除隔离checkout自己
创建的符号链接，按锁文件重新 npm ci 后集成正常，未修改原项目依赖或数据。

## 构建和发布隔离

根 Docker context deny-all，只允许产品目录；RAG Dockerfile 显式 COPY，开发记录不在
其 context 内。Compose 仅挂载明确运行目录。Windows installer 也用显式目录清单；
Node package private，CI 无整库产物上传或生产原地拉取。新增 Git archive 排除。

配置审查已完成。用暂存树的同一对象构建精简归档树（保留实际根 attributes、RAG 产品、
开发记录与 AGENTS，略去无关大型媒体），实际归档56个成员，不含 dev-notes/AGENTS；
不是整库所有媒体归档验证。未重建正式镜像或 Windows 安装包，
不能声称所有最终部署产物已验收。未设置全局 hook，也未声称所有贡献者已被强制检查。

## 状态与下一步

代码与本地专项验证完成。提交/分支推送/PR 创建以 GitHub 实际记录为准；本记录编写时
未部署到现有运行实例，未发送真实平台消息，未改业务数据库或模型密钥。

接续先读本记录和 `docs/运营RAG兼容接入-20261106.md`，查看 Git/CI 状态；在更新真实
运营部署前备份原数据、配置与镜像，固定已发布版本进行真实语料验收。索引无需因本次
在线流程与人设改动整体重建。代码审查/CI 通过不等于真实业务接收验收。
