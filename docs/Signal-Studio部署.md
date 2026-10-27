# AI Signal Studio 随仓部署

这套部署启动运营系统 Web、RAG 和 AI Signal Studio。Signal 引擎源码位于 `engines/ai-signal-studio/`，不依赖另一台电脑的源码、历史成片或仓库同级的 `platforms/` 启动脚本。

浏览器登录运营系统后，通过 `/integrations/ai-signal/` 使用“自动化成片”。Signal 容器只在 Compose 内网监听 `8892`，不映射宿主端口；浏览器入口由 Web 管理员会话保护。Signal 完成的作品通过只读共享卷进入素材库的待确认队列，人工确认入库后才供发布选择，发布仍沿用预检、审核和最终授权流程。

随仓引擎包含 **AI Signal Studio**。OpenChatCut 和 Toonflow 是可选外部服务，没有安装它们也能启动本部署；可通过新的 `compose.outputs.local.yaml` 接入它们的产物目录，详见 [产物确认入库](产物确认入库.md)。配置挂载不会安装应用或赋予外部模型生成能力。旧的三台本机服务接入方式保留为 [历史记录](视频创作工作台本地接入.md)，不再作为新部署入口。

## 首次部署

首选部署目标为 **Windows 11 / Windows 10 本机**，操作员可先按 [Windows 本机部署](Windows本机部署.md) 完成安装。需要 Git、Node.js 24+，以及已启动的 Docker Desktop，使用 WSL2 后端和 **Linux containers**。Docker Compose 至少为 2.24.4；`!override` 用于替换基础配置的端口绑定。容器内安装 Python、Node、FFmpeg 和引擎依赖，Windows 宿主机不需要单独安装这些引擎运行依赖。首次构建需要网络下载镜像和依赖。

在非 OneDrive、iCloud 或其他同步目录下创建新目录。以下命令可在 PowerShell 中逐行执行，没有 Unix 续行符：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\source\repos" | Out-Null
Set-Location "$env:USERPROFILE\source\repos"
git clone --branch main https://github.com/haban1/AI-operation-system.git
Set-Location .\AI-operation-system
node scripts/init-docker-dev.mjs
```

初始化脚本读取 `.env.docker.example`，复制为 `.env.docker` 并生成随机服务密钥；已有 `.env.docker` 会保留，不会覆盖。不要用真实运营环境的配置和数据做首次验证。

当前模板的管理员是 `admin`，初始密码为 `admin123`。首次启动前，用密码管理器生成独立密码，并在刚生成的 `.env.docker` 中设置 `ADMIN_USERNAME`、`ADMIN_PASSWORD`。也可用下列命令生成密码后自行保存到该文件：

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
notepad .env.docker
```

保留脚本生成的服务密钥；`.env.docker` 不提交 Git。直接复制模板而没有替换密钥占位符，不是完成初始化。

验证 Compose 配置并启动独立实例：

```powershell
node scripts/workbench.mjs start
```

Windows 可直接双击 `start-workbench.cmd`，停止用 `stop-workbench.cmd`，检查用 `check-workbench.cmd`。这组入口统一使用 `compose.yaml`、`compose.signal.yaml` 和 project name `ai-operation-signal`；仓库根目录存在 `compose.outputs.local.yaml` 时，start/stop/status/verify 都会追加这份配置。启动器检查 Docker 模式与 Compose 版本，并等待整套服务健康。旧的 `start-mvp.cmd` 与 `启动本地服务.cmd` 只用于原生安装模式，不会启动 Signal。

启动器要求 `docker` 在 PATH。macOS 若未启用 Docker Desktop 的命令行工具，可用下方日常操作中的手动 Compose 命令，将 `docker` 替换为 `/Applications/Docker.app/Contents/Resources/bin/docker`。不要叠加旧的 `compose.local.yaml` 或 `compose.workbench.example.yaml`，它们会引入另一台电脑的来源挂载和浏览器地址。

打开 `http://localhost:3100/#studio`，使用刚设置的管理员凭据登录，再进入“自动化成片”。首次启动没有历史作品，成片库为空是正常状态。基础 RAG 配置仍需单独准备知识模型与正式知识版本；没有可用知识库不代表 Signal 安装失败。

默认只绑定本机 `127.0.0.1:3100`。需要服务器或局域网访问时，由部署维护人员为 Web 配置受保护的 HTTPS 入口并更新允许的来源；保持 Signal 不暴露宿主端口。不要把 `127.0.0.1:8892` 当作远程用户浏览器的入口。

## 配置和数据保存在哪里

| 数据 | 容器内位置 | 持久化卷 | Web 的访问权限 |
| --- | --- | --- | --- |
| Signal 完成输出与运行记录 | `/app/runs` | `signal_runs` | 只读挂载到 `/sources/ai-signal/runs` |
| Signal 作品审核、对比等业务数据 | `/app/data` | `signal_data` | 只读挂载到 `/sources/ai-signal/data` |
| Signal 服务地址、模型名等配置（不含 UI 输入的 Key） | `/app/runtime-config` | `signal_config` | 不挂载 |
| 已发现产物的副本、索引及人工入库状态 | `/app/data/content-library`（Web） | `web_data` | Web 管理 |

Compose 自动创建空卷，不要求宿主机预先存在 `runs`、审核 JSON 或 SQLite WAL/SHM 文件。引擎的私有配置与共享产物分开保存；Web 成片库只读取作品来源，不需要读取模型凭据。

外部输出挂载是独立可选步骤：复制 `compose.outputs.yaml` 为本地 `compose.outputs.local.yaml`，填写真实来源目录后再运行启动器。OpenChatCut 的 profile 整目录只读挂载到 `/sources/openchatcut`，包含作品 SQLite 及其存在的 WAL/SHM 与 uploads；Toonflow 的 workspaces 整目录只读挂载到 `/sources/toonflow`。没有本地覆盖文件时，原两份 Compose 完全不依赖外部路径。只接一路、跨机交接及 URL 配置见 [产物确认入库](产物确认入库.md)。

## 填写模型服务

在 Signal 界面保存模型服务地址、模型名和语音设置。**界面输入的 API Key 只保留在引擎进程内存中，重启后需要重新填写**；它不会随 `signal_config` 卷保存。

需要重启后继续使用 Key 时，在仓库根目录复制 Signal 专用模板；已有 `.env.signal` 时直接维护原文件，不要覆盖：

```powershell
if (-not (Test-Path .env.signal)) { Copy-Item .\engines\ai-signal-studio\.env.example .env.signal }
notepad .env.signal
```

在 `.env.signal` 中填写 `VIDEO_LLM_API_KEY` 和所用语音服务的 `VIDEO_TTS_API_KEY`，然后重建 Signal 容器以重新加载环境变量：

```powershell
node scripts/workbench.mjs start --no-browser
```

模型地址和模型名仍在界面保存。启动器应用配置变更并重新创建受影响容器。`.env.signal` 是可选文件，未创建时也能启动引擎；该文件只供 Signal 容器使用，不传给 Web 或 RAG，也不要提交 Git。仅执行 `restart` 不会重新读取修改后的环境变量。

Linux 镜像支持 `edge` 和 OpenAI-compatible 语音服务。MLX / Qwen 本地语音需要 macOS 专有依赖，不包含在这个 Linux 镜像中；不要将本机 Mac 可用的语音配置直接视为容器内可用。

启动容器不会自动发起收费生成。服务健康表示引擎能够响应，不表示模型额度、权限、配音和完整成片链路已经通过。

## 从生成到发布管理

1. 在“自动化成片”完成选题和生成流程，等待作品验证完成。
2. 打开“素材库”，选择目录自动发现或手动接收。目录同步时，Signal 只有 `validation.json` 标记 `full_decode=passed` 的有效视频会被发现，源端已拒绝作品被排除。已有实际导出文件时，也可点击工具栏“接收产物”，选择来源、文件、产物类型（最终视频/视频片段/图片）并填写标题后上传；适合 Windows 文件交接或旧来源记录缺少路径的情况，无需挂载外部目录。两种入口的新产物都先进入“待确认”，系统校验媒体并保存独立副本。
3. 完整预览并核对内容、标题、正文和产物类型，点击“确认入库”进入“已入库”；暂不使用则点击“暂不入库”进入“已排除”。源端选中不是人工入库确认，旧作品缺少人工确认记录时同样先待确认，源内容的新版本也需重新确认。后续源引擎临时离线不会删除已保存副本。
4. 仅已入库作品可以“用于发布”，或在发布管理中“从成片库选择”。文件、标题和正文会填入发布表单；仍需选择平台、完成预检与审核，并明确授权最终发布。Toonflow 片段/预览不会因确认入库变成完整成片。

目录同步由访问素材库或手动操作触发，不是后台持续归档；“接收产物”则由操作员明确选择文件上传。上传成功不会自动确认入库或发布，也不证明 OpenChatCut / Toonflow 已在本机运行。完整步骤见 [产物确认入库](产物确认入库.md)。首次上线验证可使用已授权的测试作品；不要把健康检查通过当成已经真实生成或发布。

## 必要验收

启动后先执行无模型调用的渲染检查。脚本生成 1 秒合成音频，使用仓库样例验证 FFmpeg、Chromium 和 Remotion，检查完整解码结果后清理测试产物：

```powershell
node scripts/workbench.mjs verify
```

检查器先验证未登录请求被拒绝，再使用本机 `.env.docker` 的管理员凭据检查登录、Signal 页面/脚本/API 和成片库访问，最后调用容器内 `scripts/smoke_render.py`。不会打印密码，不调用外部文本、配音或视频生成服务，也不替代真实选题生成、成片入库和知识检索验收。

- **干净启动**：从新 clone 和空卷启动，`web`、`rag`、`signal` 达到各自的健康状态；不依赖旧机器目录。没有本地 RAG 模型时，单独处理知识检索配置，不以未执行的知识检索作为通过证据。
- **入口与认证**：未登录不能访问 Signal 页面/API；登录后从内容工作台打开 Signal，页面、静态资源与 API 均通过 Web 同源入口加载。
- **缺省来源**：未安装 OpenChatCut / Toonflow 时，Web 和 Signal 仍能启动，另外两条路线显示未接入或离线；空的 Signal 来源不会让 Web 启动失败。
- **产物交接与重启**：分别验证目录自动发现与“接收产物”上传，新增作品均先待确认，人工确认前不能带入发布草稿；确认后可选择发布。重启 Signal 和 Web 后文件与入库状态仍可读取，重复同步不产生重复副本，内容新版本重新待确认。验证到草稿为止，不自动发布。

上述是本部署需要执行的验收步骤，不代表每一项已在当前机器上完成。仓库 CI 分别检查 Windows 启动器逻辑和 Linux x64 的整套容器构建、启动、代理与渲染；Windows 启动器测试使用命令替身，不运行 Windows Docker。目标 Windows / WSL2 机器仍需执行检查并验证真实生成。验证记录应分别写明容器构建、页面加载、生成、入库与发布草稿结果。

## 日常操作

```powershell
# 查看运行状态与最近日志。
node scripts/workbench.mjs status
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml logs --tail 100 web signal

# 更新源码后重新构建；保留命名卷中的数据。
node scripts/workbench.mjs start --no-browser

# 停止本套服务，保留卷；下次用相同 project name 启动。
node scripts/workbench.mjs stop
```

存在 `compose.outputs.local.yaml` 时，手动 Compose 命令在 `-f compose.signal.yaml` 后追加 `-f compose.outputs.local.yaml`；启动器会自动处理。不要执行 `down -v`，它会删除命名卷。更换 Compose project name 会得到另一套卷，不能据此判断旧数据已丢失。升级前停止生成任务并备份 `signal_runs`、`signal_data`、`signal_config`、`web_data`；私有配置备份按凭据文件管理。

Signal 离线时先查看 `signal` 容器日志；页面能打开但生成失败时再检查其模型配置和具体任务错误。来源目录可读取但成片库没有作品时，检查完整解码状态、源端审核结果与同步的拒收提示。工作台健康检查、生成成功和成片入库是不同状态。

基础 Compose 的 Local Agent 使用 `simulated` 模式，不会真实发布或回复。连接 Windows 原生 Local Agent 做真实平台操作时，还需单独验证登录和文件交接；Windows 进程不能直接读取成片库返回的 Linux 容器绝对路径。
