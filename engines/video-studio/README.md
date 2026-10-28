# 内容生成与视频制作

系统内入口为“内容生成 → 自动热点 / 混剪 / 素材库”。自动热点和混剪各有独立成片库，混剪另含视频制作和制作素材。公共素材库汇总两种来源的成片，供发布管理直接选择。旧的 OpenChatCut / Toonflow 入口已由同一制作助手替代。

## 运行

安装 Node.js 22+（挂载业务系统时要求 Node.js 24+）、FFmpeg 和可用的 Chromium/Chrome。在模块目录运行：

```sh
npm ci
npm start
```

在业务仓库根目录也可运行 `npm run video:install`、`npm run video:start`；`npm run test:video` 执行模块和主系统挂载回归。

独立入口默认 `http://127.0.0.1:8890/`。业务系统启动后由现有登录保护，入口为 `/video-workbench/`；业务系统直接挂载本模块，不需要另开 8890 进程。

也可保留宿主机上的 Codex / ChatCut 登录态：在业务系统服务端设置 `VIDEO_STUDIO_UPSTREAM_URL=http://host.docker.internal:8890/`（Docker Desktop）或 `http://127.0.0.1:8890/`（同机进程）。页面、媒体和会话事件流仍走主系统同源地址；公司模型密钥和 ChatCut 凭据留在本地制作服务。成片确认和发布素材存储由主系统处理。自动热点在系统内使用 `/integrations/ai-signal/`。

中转配置通过服务端环境设置 `VIDEO_RELAY_BASE_URL`、`VIDEO_RELAY_API_KEY`、`VIDEO_RELAY_MODEL`。本机也可读取现有 `~/.codex/config.toml` 的当前供应商配置。不要把 API Key 写进浏览器或 Git。环境变量模板在 `.env.example`；部署工具应将其加载为进程环境。

Codex 使用 CLI 的官方 `app-server` 协议。macOS 如有已安装的 Codex App，优先使用其 CLI；否则使用项目自带的 npm CLI 0.165.0。可用 `CODEX_BIN` 显式指定路径。验证中，本机 App 的 CLI 0.164 成功调用 ChatCut；npm 0.165 在本机遇到 OAuth 元数据网络错误，因此界面保留实际失败状态。

ChatCut 使用独立 OAuth 身份，不使用公司模型 Key 登录。新机器首次需要授权：先启动一次聊天以初始化隔离配置，再按 `runtime/BRIDGE.md` 使用相同 `CODEX_HOME` 登录。Remotion、Hyperframes 的 CLI、Skill 与依赖随项目安装；首次实际渲染仍需检查浏览器和系统依赖。Docker 镜像安装 FFmpeg 和 Chromium；容器中可在渲染命令显式指定 `/usr/bin/chromium`，并检查 Codex 的沙箱是否满足部署主机限制。

## 文件与素材

- `bundled/videos` 和 `bundled/posters` 是六条作品及封面的真实文件，总视频约 96 MB；部署后无需原外置盘就能播放。
- `.agents/skills` 包含六套组合及 ChatCut、Remotion、Hyperframes 所需文档，保留原引用与许可证。
- 制作素材映射部署主机的绝对目录，浏览子目录、预览、标注分类并选入制作上下文。路径保存在运行数据中，不会复制或移动原素材。
- 公司资产支持 Logo、虚拟形象、品牌规范及文字 Slogan。虚拟形象当前待定。
- 每个会话有独立工作区，生成文件放 `exports/`，刷新成片库后自动列出视频。计划或空目录不会被当作成片。
- 系统挂载时数据默认位于业务项目 `runtime/video-studio`；独立运行默认位于本模块 `runtime/data`。可用 `VIDEO_STUDIO_DATA_DIR` 指定持久目录。

## 成片、公共素材与发布

顶部切换自动热点、混剪时保留当前制作会话。混剪成片库只列混剪样片和真实 CLI 会话 `exports/` 视频；自动热点成片库按来源列出热点视频，不会混入混剪视频；内层热点工作台的成片入口在当前系统切换至热点专属库。原始素材、文稿和计划不作为成片。

两种成片自动汇入顶部“素材库”；同一素材池同时保留已有历史图片和视频，并在发布管理选择器中显示。主系统读取可信输出清单后下载真实视频，校验大小和 SHA-256，以待确认状态保存；同来源同字节不重复复制。直接在发布管理打开“从素材库选择”也会触发同步，不要求先进入制作页面。同步不会替管理员批准内容；变更后的文件须重新确认。

公共素材库支持来源/状态筛选、预览和批量“确认可发布”。发布管理选择器同时显示待确认和已确认素材，待确认素材明确点击“确认并用于发布”后才取得审核记录，再带入原有发布表单，继续平台选择、预检与发布确认。热点对比任务的“保存选择”只保存创作偏好，不代表发布审批。

`GET /api/studio/outputs`、`GET /api/studio/materials` 和 `POST /api/studio/outputs/confirm` 需要业务系统登录。确认请求仅接受 `{ "ids": [...] }`，不接受文件路径或远程 URL。独立制作服务可预览；公共素材同步和发布确认须从已登录的主系统进行。

## GitHub 与部署

提交时保留 `bundled/`、`.agents/skills/`、`dist/`、`server.mjs`、`runtime/*.mjs`、锁文件。不要提交运行会话、密钥、本机路径配置、浏览器登录态和 `node_modules`。Dockerfile 与 `.dockerignore` 已包含本模块和六条视频。GitHub 最大单文件为约 20.6 MB，无需 Git LFS。

`npm test` 验证媒体 Range 请求、目录映射/分类持久化、路径边界、CLI 续聊、取消和协议事件。已有六条视频的交付核验与来源见 `docs/video-packs.md`。本次未新生成媒体。
