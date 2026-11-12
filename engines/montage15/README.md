# 15 秒智能混剪引擎

本目录保存内部系统需要的模板、编辑界面和本地渲染代码。系统入口在
`src/services/montage-workbench.js`，通过主系统登录权限挂载到
`/video-workbench/montage/`。制作入口固定提供 `perspective-flow` 和 `prism-pulse` 两套
已由用户选定的模板，旧工程保留已有快照。当前版本 0.6.0，前四阶段的操作和验收见
[制作版体验验收](../../docs/智能混剪-制作版体验验收.md)。

在仓库根目录使用 Node.js 24+：

```sh
npm ci
npm run video:install
npm ci --prefix engines/video-studio/runtime
npm ci --prefix engines/montage15
node scripts/start-montage-local.mjs
```

本地接入实例使用 `127.0.0.1:3101` 和独立的 `.local/montage-integration/`；
已有系统服务和数据库不会被此命令替换。正式主系统仍用 `npm start`，通过
`MONTAGE15_DATA_DIR` 指定混剪数据目录。该引擎当前按本机使用设计。
本地脚本同时启动 18892 的 AI Signal 服务；需先按该引擎 README 准备 Python、
配音和视频渲染依赖，在“系统设置 → 创作设置”配置模型。显式设置
`MONTAGE_LOCAL_REUSE_CODEX_MODEL=true` 可复用本机已有 Codex 模型配置，凭据仅进入
Signal 子进程环境；`--restart` 核对当前工作区 PID 后重启两个本地服务。
需要本机 FFmpeg、FFprobe、Chrome/Chromium；可通过 `VIDEO_FFMPEG`、
`VIDEO_FFPROBE`、`VIDEO_BROWSER_PATH` 指定可执行文件。

主系统提供素材 ID 和经过校验的文件流，引擎不接收客户端文件路径。工程保存模板
快照与修订，支持照片/视频替换、独立视频入点、裁切焦点、动态短句、品牌、动效强度、
配乐和音效。导出固定 15 秒、30 fps；横屏 1920×1080，竖屏 1080×1920。
原视频静音。导出先逐帧生成画面，再在本机混合音轨。

AI 制作使用本机已安装并登录的 Codex CLI。支持自动填写初稿、按镜头/文案/音乐
局部重做、自然语言调整和取消任务。可用 `MONTAGE_CODEX_BIN` 或 `CODEX_BIN`
指定 CLI，`MONTAGE_CODEX_MODEL` 选择模型。普通编辑页面不接收可执行文件路径或 CLI 参数。
AI 请求包含制作要求、事实资料、候选素材的名称/标签/说明/尺寸/时长以及当前工程参数，
原片留在本机。素材来源可以直接连接本机文件夹，按需启用素材。macOS 使用本机 Vision 抽帧提取画面标签，
首用需要现有 Xcode Command Line Tools 编译索引程序，工具不可用时显示基础索引状态。
AI 依据这些线索选材，具体身份和动作由用户在预览中核对。选中素材按需转换，来源持续保留。

AI 返回受 JSON Schema 约束的操作，服务端校验素材范围、分组、长度、文案、锁定及
工程修订后应用。CLI 复用已有本机登录，使用只读模式、独立临时工作目录和结构化输出。
本轮禁用 shell、浏览器、插件和多 Agent 工具，编辑由工程服务执行。
参考 [OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode)。

手动修改画面、文案、音乐和动效时，该部分默认锁定。用户可以解除锁定后交给 AI
重新生成。已保存修订可预览和恢复，恢复创建新修订。AI 处理中的手动保存、素材说明
变化、取消、超时及重启都有明确状态，失效结果保留在任务记录中。

制作版保留 main 的创作设置、热点生成和共享成片库，由
`src/services/content-workbench.js` 组合主系统外框与混剪引擎。本轮完成 3101 本地功能联调，
第五阶段的正式系统替换与发布另行安排。尚未保存的修改、旧修订、
不完整素材和导出失败不会被冒充为新成片。进程重启保留已保存工程，将中断的任务标为
失败，用户可重新导出。

开发验证在仓库根目录运行：

```sh
node scripts/run-tests.mjs --test --test-concurrency=1 test/montage-workbench.test.js test/montage-ai.test.js test/montage-production.test.js test/montage-codex-planner.test.js test/content-library-studio.test.js test/video-studio-proxy.test.js
```

运行时 npm 包只包含 `src/`、`public/`、`templates/`、`vendor/` 和第三方说明，
不包含用户素材、工程数据、开发记录或验证产物。音频来源和署名见
`templates/montage15/audio/CREDITS.md`；第三方说明见 `THIRD_PARTY_NOTICES.md`。

默认配乐沿用模板，普通 AI 重做保留当前音轨，明确的音乐指令支持换曲及偏移。
精细调整提供模板时间轴中的镜头交换、原片取材裁剪、画面焦点、图层顺序和声画时间偏移。
浏览器草稿与已保存修订分别恢复，取消后的渲染任务保留取消状态，重试创建独立任务。
来源文件夹重新关联按内容摘要核对，修复相同原片的编辑副本并保留镜头 ID。
