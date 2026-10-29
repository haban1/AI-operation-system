# 六套剪辑组合和随项目成片

`bundled/videos/` 是六个 MP4 的真实副本，不依赖外盘链接。最大单文件约 20.6 MB，总计 95,846,952 bytes，适合随 Git 仓库分发。`bundled/posters/` 从各视频实际画面提取封面；`bundled/manifest.json` 包含路径、时长、尺寸和 SHA-256。

| Skill | 方向 | 随项目成片 |
|---|---|---|
| `chatcut-source-pack-01` | 纪录混剪 · 证据与现场 | `V5_01_Documentary.mp4` |
| `chatcut-source-pack-02` | 预告片 · 由静到燃 | `V5_02_Trailer.mp4` |
| `chatcut-source-pack-03` | 品牌开场 · 分享的价值 | `V5_03_Brand.mp4` |
| `chatcut-source-pack-04` | 社交短片 · 三眼看现场 | `V5_04_Social.mp4` |
| `chatcut-source-pack-05` | 节拍混剪 · 现场脉动 | `V5_05_Beat.mp4` |
| `chatcut-source-pack-06` | 对照蒙太奇 · 台上与台下 | `V5_06_Contrast.mp4` |

六个组合入口位于 `.agents/skills/`，保留各自的 `config.json` 和 `references/`。它们是本项目整理的组合，不是六套 ChatCut 官方模板。原作者文档来源与固定摘要记录在 `bundled/sources/sources.json`；未修改这些上游原文。入口仅将旧的一次性外置盘输出要求改为当前系统任务目录，用户自然语言要求覆盖默认模块。

引用来源包括 [calesthio/generative-media-skills](https://github.com/calesthio/generative-media-skills)、[iart-ai/motion-design-skills](https://github.com/iart-ai/motion-design-skills) 和 [ChatCut 官方 Skill 目录](https://chatcut.io/skills)。每次执行仍需读取引用的完整规则，再根据本次素材做选择。此处提供原有项目素材及成片的分发副本，不改变其原始权利归属。

## 三工具状态

- ChatCut：地址为 `https://api.chatcut.io/api/external-mcp/mcp`。本次通过工作台内的真实 Codex CLI 对话调用 `list_projects` 成功，界面显示已连接。新部署仍需建立自己的 OAuth 身份；公司模型中转 Key 不等于 ChatCut OAuth。macOS 验证使用已安装 App 的 CLI 0.164；npm CLI 0.165 在本机出现 OAuth 元数据网络错误，不能将它的连接状态视为已验证。
- Remotion：项目依赖固定 `@remotion/cli`、`@remotion/player`、`@remotion/renderer` 和 `remotion` 4.0.539，配合 React 19。`.agents/skills/remotion-best-practices` 保留本机已有 4.0.520 文档及其完整引用。它是 Agent Skill 与 React/Node 渲染工具链，不是 MCP。使用新版本 API 时核对具体项目依赖与文档，再运行渲染并验证输出。
- HyperFrames：官方项目为 [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)，npm 包为 `hyperframes`，本项目固定 0.8.210，要求 Node.js 22+ 和 FFmpeg。四个核心 Skill `hyperframes`、`hyperframes-cli`、`hyperframes-registry`、`media-use` 已从官方源码放入 `.agents/skills/`，许可证在 `bundled/sources/Hyperframes-LICENSE.txt`。该工具通过本地 CLI 使用，不是 MCP。

HyperFrames 官方 `skills update` 安装器会写用户全局 Skill 目录；本项目改为打包核心 Skill，以 `HYPERFRAMES_SKIP_SKILLS=1` 保持仓库版本，不依赖部署者的全局安装。安装依赖时使用 `PUPPETEER_SKIP_DOWNLOAD=1`、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 避免重复下载浏览器；实际渲染仍需指定可用浏览器或按工具要求准备运行环境。

项目还打包 ChatCut basics、素材导入、画面审阅、动效、配乐、shader、错误处理与验证/导出 Skill。原生 ChatCut 工作流仍要通过实际 MCP 连接操作可编辑时间线；仅有文档不等于连接已验证。Codex CLI 固定 npm 稳定版 0.165.0，私有运行配置和认证不写入这些文件。

本次实际执行了三项 CLI 检查：Codex 返回 `0.165.0`；HyperFrames 返回 `0.8.210`；`remotion versions` 确认所有 Remotion 包均为 `4.0.539`。HyperFrames 环境检查识别了本机 FFmpeg/FFprobe 和已有 Google Chrome，因此未下载浏览器。可选的本地 ASR、TTS、音乐模型和 Docker 未安装，不将这些可选项写成视频工具安装失败。此次未创建新的渲染作品，渲染验收仍应针对具体工程进行。

在嵌入式任务进程中设置 `HYPERFRAMES_NO_TELEMETRY=1`，避免第一次执行时写用户全局遥测配置。

## 验证边界

本次复制后核验六个文件的元数据、音轨、SHA-256 和真实帧封面。此前原交付记录还包括全片解码成功及无持续 0.15 秒以上黑场，但不把这些技术检查写成完整人工播放验收。第 5 条音乐 drop 的听感位置仍需人工试听。

`node bundled/package-videos.mjs` 可重新生成 manifest 与封面，要求本机存在 FFmpeg/FFprobe。
