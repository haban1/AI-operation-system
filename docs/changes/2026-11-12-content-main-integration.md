# 最新 main 内容创作集成与本地联调

2026-11-12（Australia/Sydney）。分支 `codex/content-creation-main-integration`，
基线 [88907a5](https://github.com/haban1/AI-operation-system/commit/88907a5c71a80bd4d756d6eb0b1e19ea5ec75b22)。
用户已明确要求推送到 main；本记录随本次源码提交交付，提交与推送结果以 Git 历史和远端为准。
本轮未替换正式环境。

## 背景与目标

用户指出原预览未基于最新 main，要求拉取、重启并完善整个内容创作 Tab。
范围为智能混剪及 AI 热点自动生成；保留 main 的新版外框和其他业务功能。
先前阶段 1–4 的制作能力继续保留，第五阶段正式系统替换未获得本轮交付验收。

## 变更与影响

- `src/services/content-workbench.js` 组合两个引擎；`src/server.js` 使用异步单例、真实混剪能力状态及退出清理。
  增加停止服务时对未完成媒体连接的 5 秒宽限，避免暂停视频阻碍进程退出。
- `engines/video-studio/dist/` 采用 main 外框，顶部直接显示两个制作 Tab，右侧为成片与素材。
  旧 editing/creation 路由兼容进入混剪，创作设置仍由主系统设置页进入。
- `engines/montage15/` 提供两套已选模板、工程首页、持续索引来源、缩略图/原片预览、指定取材入点、
  时间轴选镜头、手动替换/撤销、局部自然语言修改和 15 秒导出。制作要求位于素材预览之前。
- 三层同源页面同步日夜主题；日间镜头面板、按钮、导出提示及热点表单补足对比度。
- `content-library.js` 校验素材字节及可信 ID；复制中仅元数据变化时二次核对 SHA，仍拒绝同长度内容被修改。
  main 新增的热点知识文档逻辑保留。两个制作引擎共用人工确认边界。
- 热点模型响应在 UTF-8/JSON 截断、缺少完成事件及连接断开时最多自动重试一次；不拼接部分输出，
  显式拒绝、服务失败或 HTTP 鉴权失败不自动重试。
- `scripts/start-montage-local.mjs` 启动/重启独立 Node 与 Signal 服务，停止前核验 PID 对应工作区。
  可选本机 Codex 模型复用在停止服务前完成依赖预检，凭据仅进入子进程环境。

## 决策与取舍

见 [组合引擎决定](../../dev-notes/decisions/0002-content-workbench-composition.md)。
没有以旧前端覆盖 main，没有改变正式平台的登录、自动采集或发布开关。
独立 checkout 和 APFS 写时复制保留原工作区、素材、五个历史工程；14 份已导入源媒体 SHA 全部一致，
SQLite quick_check 为 ok。用户验收工程为本轮另建。

## 验证与证据

- 71 项 Node 专项通过，覆盖 montage-ai、montage-production、montage-codex-planner、montage-shot-editing、
  content-library-copy-integrity、content-library-admission、content-library-studio、video-studio-proxy、
  ai-signal-proxy、hot-topic-knowledge-files。5 项 `test/montage-workbench.test.js` 主系统集成通过。
  唯一用例计数为 71 + 5，不把重复执行相加。
- 停止时保留一个暂停的真实 MP4 HTTP 响应，再运行本地重启脚本，6.415 秒内完成旧进程退出和新服务启动，
  Node 与 Signal 健康均恢复；`restart-verification.json` 留存实际结果。
- `PYTHONPATH=tests python3 -m unittest tests.test_responses tests.test_research tests.test_draft_repair`
  在 Signal 引擎目录运行，28 项通过。包含 UTF-8 截断、缺失完成事件、重复失败、连接断开、引用核实和文稿校验。
- 推送前按现有 `signal-deployment.yml` 的 Node 清单执行 8 个测试文件，115 项通过、0 失败、0 跳过；
  在 Signal 引擎目录运行 `python3 -m unittest discover -s tests -v`，93 项通过。
  日志为本地 `pre-push-node-ci.log`、`pre-push-signal-python.log`；与前述测试存在重叠，不相加计数。
- 真实 UI 完成选模板、新建工程、复用 20 份素材、真实 Codex 初稿、局部修改及导出。
  自然语言只将镜头 3 改为指定原片 6.2 秒入点；前后快照确认其他镜头、字段、配乐和设置不变。
  手动替换至 7.5 秒及撤销恢复、创作设置切换保留工程/选中镜头、日夜主题同步均已观察。
- 实际 MP4：1920×1080、30 fps、450 帧、15 秒，含 AAC 音轨；平均 -20.1 dB、峰值 -4.4 dB，
  未检测到持续 0.15 秒黑场。共享库完整播放成功，pending 的发布草稿请求返回 409 `CONTENT_ADMISSION_REQUIRED`。
- 模型短请求、Edge 短句配音及热点代理连通；RSS 采集 30 条。两次真实单条任务在资料整理时被长响应中断，
  第二次含自动重试；非流式诊断也出现 RemoteDisconnected。热点端到端成片未通过。
- 本地证据位于被 Git 排除的 `artifacts/content-main-integration-20261112/`，含首页/编辑器/播放截图、
  源数据完整性、局部修改快照、渲染检测和测试日志。私有原始数据与凭据不进入本记录。
  浏览器版 `creation-navigation-ui.test.js` 已更新且语法通过，本轮未执行其自动浏览器测试，实际 UI 使用 CUA。

## 部署与回退

本轮入口 `http://127.0.0.1:3101/#studio`，Signal 为回环 18892，经同源代理访问。
本地资料在 `.local/montage-integration/`；根运营 AI 为隔离 mock，混剪 Codex 和热点文稿/配音连接为真实服务。
不启动真实平台采集、发送或发布，不替换原 3100、3190 或已有 Docker 服务。

本地启动：`node scripts/start-montage-local.mjs`；重启追加 `--restart`。
准备依赖和可选本机模型复用见 [引擎说明](../../engines/montage15/README.md)。
本轮曾因复用目录的 smol-toml 被 iCloud 卸载而启动挂起，现已按 runtime lock 在当前工作区安装唯一依赖；
原符号链接保存在本地资料中。停止脚本挂起进程和一个已关闭监听的残留 Node 进程后恢复服务。

Docker 配置明确 COPY montage 引擎并安装其锁定依赖；默认排除配合明确 COPY 保证 dev-notes、
本地数据和验证资料不进入该构建路径。Windows 现有明确目录清单不复制 dev-notes。
这两项为配置审查，未构建 Docker 镜像或 Windows 安装器。
montage npm 包使用 files 白名单，已实际 dry-run 核对不含 dev-notes、.local 或 artifacts；不是正式发布。
GitHub 的 Signal 工作流在 runner 内构建和验证隔离容器，不含正式环境发布步骤；远端 CI 结果需推送后另查。

回退本轮本地预览时，先按 PID 和工作区核对停止这两个服务，再从原工作区启动原 3101。
保留本轮数据和原工作区；不对其他目录执行 reset、clean、清库或锁文件删除。

## 未完成与下一步

阻塞：热点当前模型长响应连接不稳定，资料整理未完成，不能将健康探测、短请求或 UI 对齐当作热点成片通过。
其他来源还存在 GitHub/Hacker News 读取不完整、Reddit 403、微博/小红书登录采集服务不可用；不绕过登录。

下一位开发者先读本记录与体验验收说明，确认当前 Git 和服务路径。先解决热点模型长响应的连接问题，
再选公开 RSS 题材走通文稿、配音、渲染、共享库 pending 和播放，保留源引用校验及人工确认边界。
用户可先验收混剪工程与实际成片；“老师近景”等语义是否满足用户意图仍需看画面确认。
完成用户验收后另行安排正式系统替换、Docker/Windows 产物验证和真实平台联调。

## 上下文与关联

- [体验流程与验收标准](../智能混剪-制作版体验验收.md)
- [前端入口说明](../frontend-workspace.md)
- [开发接手入口](../development/handoff.md)
- [开发规范入口](../../dev-notes/README.md)
- [main 基线](https://github.com/haban1/AI-operation-system/commit/88907a5c71a80bd4d756d6eb0b1e19ea5ec75b22)
