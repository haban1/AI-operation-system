# RAG 测试页面兼容局域网 HTTP

## 背景与目标

用户在“知识库 → RAG 问答测试”看到“页面加载失败：crypto.randomUUID is not a function”。页面创建会话时直接调用该接口；局域网 HTTP 属于非安全上下文，浏览器可提供 getRandomValues 而不提供 randomUUID，错误发生在发起检索前。目标是恢复页面加载及公司介绍、业务简介的本地问答。

## 变更与影响

public/knowledge-tools.js 集中生成测试会话 ID：优先原生 randomUUID，否则使用 getRandomValues 的 128 位随机值；整个 crypto 缺失时使用时间、随机值与递增序号。首次加载、清空、切换平台和场景均使用该方法。连续提问/失败重试保留会话，清空和场景变更创建新会话，原有取消请求和忽略迟到结果的行为保留。public/app.js 的模块版本和 public/index.html 的入口版本一并更新。

test/rag-answer-profile-ui.test.js 增加接口缺失时的浏览器操作回归和会话生命周期断言。[知识库说明](../knowledge-files.md) 补充访问与刷新说明。本轮不修改知识资料、RAG 检索逻辑和认证接口。

## 决策与取舍

无需为打开本地测试页强制更换 HTTPS 或重新上传 PDF。ID 仅隔离测试对话，不是登录凭据；随机数降级不用于任何安全用途。生成结果保持服务端约定的 1–80 位字母/数字/下划线/连字符。无 crypto 时递增序号避免同一页面内相同时间和随机值造成会话复用；不宣称该降级是密码学随机数。

## 验证与证据

修改实现前，新增浏览器回归以 random-values 模式运行：`node --test --test-name-pattern='crypto random-values' test/rag-answer-profile-ui.test.js`，在进入 RAG 页后找不到输入框，复现加载失败。实现修复后运行：

```powershell
node --test --test-concurrency=1 test/knowledge-tools.test.js test/rag-answer-profile-client.test.js test/rag-answer-profile-proxy.test.js test/rag-answer-profile-ui.test.js
```

共 8 项通过、0 跳过，包含原生接口的桌面/窄屏、仅有 getRandomValues 的桌面和整个 crypto 缺失的窄屏。覆盖提交、失败重试、连续上下文、清空、切换场景/平台后的会话更新、迟到结果隔离、引用与文本转义；后端隔离测试验证认证、固定知识范围及不创建业务任务。当前终端没有 npm.cmd，使用上述等价 Node 命令执行，不能把 npm 命令记为通过。

实际 LAN HTTP 浏览器无接口注入：isSecureContext=false、randomUUID=undefined、getRandomValues=function。页面正常打开；“你们是什么公司”和“你们主要做什么业务”均返回 HTTP 200 / ANSWERED，分别有 2、3 个来源，第二问保留 2 条上下文且 sessionId 一致；随后清空、切换评论和微博成功，无页面异常。三项在线资源 index.html/app.js/knowledge-tools.js 与本机 SHA256 一致；Web/RAG healthy，镜像和启动时间不变。真实业务平台收发不在本轮验收范围。

私有证据和备份在 `.codex-work/rag-session-id-20261112/`，包括 verify-live.mjs、live-validation.private.json、lan-http-answered.png、manifest-before.json 和 containers-before.json。原始答案、公司资料和登录信息不进入源码文档。

## 部署与回退

本机通过现有 public bind mount 热更新三个前端文件，不重启 Web/RAG。刷新页面加载新入口；旧页缓存可 Ctrl+F5。回退以私有目录 backup/public/ 的 knowledge-tools.js、app.js、index.html 为本轮前基线，只恢复对应增量或在确认没有后续改动时恢复这三个文件；不以旧 Git HEAD 覆盖当前混合工作树，不恢复数据库。该回退会重新引入本次局域网错误。

## 未完成与下一步

已修改、已应用；未提交、未推送。用户刷新原页面后可继续测试公司介绍和业务简介。后续源码上传应审查本轮增量，并将测试与这些文档一同带入净化发布 checkout；当前开发仓库仍有大量既有工作，不能整体暂存或直接推送私有历史。本轮不追加知识文件，也未验证真实平台发消息。

## 上下文与关联

[稳定交接](../development/handoff.md)、[知识库操作](../knowledge-files.md)、[人设与本地测试](2026-11-10-knowledge-playground.md)、[此前公司指代检索修复](2026-11-11-company-reference.md)、[Docs as Code](../development/docs-as-code.md)。本轮故障属于浏览器会话初始化，与此前检索指代问题分别处理。
