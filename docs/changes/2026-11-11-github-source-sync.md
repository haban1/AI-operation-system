# 2026-11-11：同步当前智慧驱动源码到 GitHub

日期：2026-11-11（Asia/Shanghai）。用户已授权将当前系统推送到 GitHub；此记录随发布快照提交。目标 haban1/AI-operation-system 的 main，远端核验基线 bd66d8f359c377ad2cad8add5a2fe1eb33638728。源码提交 cad2fcd4245f837eadd68e2b100384601b92f887 已推送至 main，远端提交与树 SHA 均核验一致；本次文档补记只记录已发生的结果。

## 背景与目标

将当前已使用的界面和功能源码交付到原 GitHub 源码仓库，包括此前本机未提交的更新；保留源码、操作说明、验证结果和后续接手上下文。开发仓库旧历史含业务数据库，因此只在独立净化发布 checkout 提交，不合入旧开发历史。

## 变更与影响

发布副本同步 216 个新增或变化文件、删除 10 个已移除接口/旧页面文件，并保留上游开发规范与部署记录，补充本次交接。涵盖精简前端、分步发布、内容创作两种入口及系统创作设置、知识文件自动生效与人设/RAG 测试、公司指代检索、评论确认、热点来源、采集适配和微信界面。实际范围以提交 diff 为准；使用见[前端操作](../frontend-workspace.md)与[知识库](../knowledge-files.md)。此前未推送的 44 页独立预览与 main 集成记录亦保留于待推送历史。

## 决策与取舍

仅同步源码及经过审查的文档，不携带数据库、实际环境配置、密钥、登录态、知识原件、日志、本机备份、依赖和构建产物。保留远端原开发约定及净化历史，公开操作记录去除真实账号、消息和作品标识；本机原始记录不覆盖。未变化的行保留发布基线原换行，新增行使用 LF，Windows 启动器仍按原属性处理；清除少量无语义的行末空格。Git HTTPS 连接超时，但 GitHub REST API 可用且账号有推送权限，采用 Git 对象 API 推送，并逐项核验 blob、tree、commit 哈希，更新分支时禁止强制覆盖。

## 验证与证据

在最终净化源码副本执行验证；所有平台操作使用临时数据库和模拟接口，不触发真实收发、生成或发布。

- 20 个 Node 文档/知识/路由/界面测试文件共 201 项通过、0 失败、0 跳过；另 11 个发布适配/微信代理/小程序/数据采集文件共 241 项通过、0 失败、0 跳过，合计 442 项。
- RAG 执行 python -m pytest tests/test_company_reference.py tests/test_query_rewrite_validation.py tests/test_rewrite_vocabulary.py tests/test_file_manager.py tests/test_answer_profile.py tests/test_reply_style.py tests/test_evidence_workflow.py -k 'not second_round_still_insufficient' -q --disable-warnings，163 项通过、1 项排除。该排除项原有 reject/retry 诊断期望差异，以及另一个旧 test_query_rewrite_flow.py 导入已删除 DebugQueryRequest 的收集失败，已在此前公司检索记录说明；初次包含旧文件的本轮运行也重现导入失败，未为历史接口补兼容。
- 微信前端使用独立 Node 22 容器与现有依赖卷，按原构建顺序 npm run build-types 然后 npm run build 成功；初次省略代码生成导致找不到 API 模块，补齐标准步骤后通过。产物仅留私有测试目录。
- Signal 使用 PYTHONUTF8=1 并将项目依赖自带的 ffmpeg/ffprobe 加入测试 PATH 后，python -m unittest discover -s tests -v 的 89 项全部通过。初跑分别暴露 Windows 默认编码及缺少可执行文件，修正环境后解决，未改业务源码。未运行全量历史 RAG/Node 套件，不能据专项结果宣称所有历史测试或 GitHub CI 通过。

CI 失败日志已读取确认，公开记录仅保留错误类型和测试范围；当前生产容器未受上传影响。

本轮私有清单、扫描结果和日志位于 .codex-work/github-push-20261111/；未公开原始日志或业务证据。提交前运行 node scripts/check-docs-as-code.mjs --staged，提交后检查 origin/main..HEAD 的全部待推送提交记录；内容准确性另经人工审查。根 Docker 使用运行目录明确 COPY，微信构建上下文仅对应前端目录，Signal/RAG 使用自己的上下文；本轮仅推源码，不执行部署。

## 部署与回退

本次上传不更换本机容器、配置、数据或正在运行的系统。其他电脑需要按配置模板准备自己的密钥、数据和登录状态，并从源码构建；克隆不能恢复现有登录或知识资料。GitHub 回退使用针对本轮提交的后续 revert，并保留同时新增的其他提交，不 force-push。已验证的本机运行版本沿用各功能记录中的部署/回退步骤。

## 未完成与下一步

已核验远端 main 为源码提交 cad2fcd4245f837eadd68e2b100384601b92f887，树为 511c36d1ab7f2babef5168cca1254d15be4b0c9e。GitHub Docs as Code 与 Windows launcher 已通过；Python 全量 CI 在收集阶段有 9 个旧测试导入错误，引用已移除的 DebugQueryRequest、TestCandidate、DecisionRequest、ReleaseCreate，未宣称全量 CI 通过。其余运行状态以 GitHub Actions 为准。下一步维护者应将旧测试迁移到当前文件自动生效和正式问答接口，继续覆盖证据与会话边界，不能恢复已要求删除的旧操作页面或屏蔽整套测试来消除失败。下一位接手者从[稳定入口](../development/handoff.md)与[开发交接](../../dev-notes/README.md)开始，先核验当前分支与部署状态；本轮不代替真实平台业务验收。

## 上下文与关联

遵循[Docs as Code](../development/docs-as-code.md)、[源码发布说明](../GitHub源码仓库说明.md)和 dev-notes/POLICY.md。原开发工作树与索引保留；发布 checkout 既有本地基线 bfb756b，待推送的旧本地提交 b2fa5b1 与 bfb756b 连同本轮记录逐一核验。新源码相对本机仅存在明确脱敏和上游文档合并差异。
