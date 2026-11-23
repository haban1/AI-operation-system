# 15 秒智能混剪引擎

本目录保存内部系统需要的模板、编辑界面和本地渲染代码。系统入口在
`src/services/montage-workbench.js`，通过主系统登录权限挂载到
`/video-workbench/montage/`。制作入口提供 **透视穿梭**（`perspective-flow`）、**棱镜脉冲**（`prism-pulse`）和 **稳镜字动**（`steady-type`）。
稳镜字动用六个独立镜位、六条可编辑/锁定的字幕和原创音乐制作新视频，不依赖示范成片。旧工程沿用自己的快照。新模板的实现、规格和验证范围见[稳镜字动](../../docs/changes/2026-11-20-steady-type-template.md)；前四阶段的历史验收见
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

主系统的 AI 制作使用「系统设置」里的内容模型，未单独指定时使用对话模型，不需要另行登录 CLI。
支持填写初稿、按镜头/文案/音乐局部重做、自然语言调整和取消。独立引擎仍可使用本机已登录的 Codex CLI，
由 `MONTAGE_CODEX_BIN` 或 `CODEX_BIN` 指定可执行文件、`MONTAGE_CODEX_MODEL` 指定模型。编辑页不接收凭据、可执行文件路径或 CLI 参数。
AI 请求包含制作要求、事实资料、候选素材的名称/标签/说明/尺寸/时长以及当前工程参数，
原片留在本机。素材来源可以直接连接本机文件夹，按需启用素材。macOS 使用本机 Vision 抽帧提取画面标签，
首用需要现有 Xcode Command Line Tools 编译索引程序，工具不可用时显示基础索引状态。
AI 依据这些线索选材，具体身份和动作由用户在预览中核对。选中素材按需转换，来源持续保留。

在主系统或 Docker 中，“选择素材文件夹”从操作者电脑导入 JPG/JPEG/PNG/WebP、MP4/MOV/M4V/WebM（包括子目录）；单文件最多 512 MB，一次最多 5000 个、合计 5 GB。等索引完成后再制作。导入副本位于混剪数据目录的 `source-uploads/`；原目录变化需重新导入。“服务器目录”必须是服务进程能读取的目录。

AI 返回编辑操作，服务端校验素材范围、分组、长度、文案、锁定及修订后才应用；失败或取消保留已保存的视频。局域网 HTTP 不能用浏览器随机 UUID 时，可由服务端生成任务 ID。独立 CLI 使用 JSON Schema、只读模式和独立临时工作目录，关闭 shell、浏览器、插件和多 Agent 工具；编辑仍由工程服务执行。
参考 [OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode)。

手动修改画面、文案、音乐和动效时，该部分默认锁定。用户可以解除锁定后交给 AI
重新生成。已保存修订可预览和恢复，恢复创建新修订。AI 处理中的手动保存、素材说明
变化、取消、超时及重启都有明确状态，失效结果保留在任务记录中。

制作版保留创作设置、热点生成和共享成片库，由 `src/services/content-workbench.js` 组合主系统外框与混剪引擎。
视频自动保存；编辑区中央支持全屏预览。点击“放入成片库”才会渲染当前修订并确认这条 MP4。成功弹窗可全屏播放、继续修改，或点“发布成片”带入发布表单；都不自动授权对外发布。旧待确认项不会一并确认。
尚未保存的修改、旧修订、不完整素材和导出失败不会被冒充为新成片。进程重启保留已保存视频，将中断的任务标为失败，用户可重新导出。

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
