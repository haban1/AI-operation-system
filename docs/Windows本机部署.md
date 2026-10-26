# Windows 本机部署：运营系统与自动化成片

本说明在 Windows 本机启动运营系统、RAG 和 AI Signal Studio。浏览器使用同一个登录入口，完成视频可以同步到共享成片库，再交给发布管理。OpenChatCut 和 Toonflow 仍是可选外部工具，本次命令不会安装它们。

## 1. 准备 Windows 和 Docker

准备 Windows 11 / Windows 10、Git、Node.js 24+ 和适用于该 Windows 版本的 Docker Desktop。Docker Desktop 使用 **WSL2 后端、Linux containers**；不要切换到 Windows containers。先打开 Docker Desktop，等待引擎启动完成，再打开 PowerShell。

逐行执行只读检查：

```powershell
wsl --status
git --version
node --version
docker version
docker compose version
docker info --format '{{.OSType}}'
```

确认 Node 至少是 24，Compose 至少是 2.24.4，Docker 同时显示 Client 和 Server 信息，最后一条输出 `linux`。仅有 Docker Client 或提示无法连接时，先处理 Docker Desktop 启动问题。WSL 未安装时，在管理员 PowerShell 执行 `wsl --install`，按提示完成安装和重启，再启用 Docker Desktop 的 WSL2 后端。

所有后续命令都是 PowerShell 单行命令，可逐行复制。首次构建需要网络下载镜像和依赖。

## 2. 拉取源码并设置管理员

选择普通本地目录，不放在 OneDrive、iCloud 或其他同步文件夹。下方示例创建用户目录下的 `source\repos`；如果该位置被同步，换一个未同步的位置。已有同名仓库时保留它，另选新目录验证。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\source\repos" | Out-Null
Set-Location "$env:USERPROFILE\source\repos"
git clone --branch main https://github.com/haban1/AI-operation-system.git
Set-Location .\AI-operation-system
node scripts/init-docker-dev.mjs
```

私有仓库克隆若要求登录，使用拥有该仓库权限的 GitHub 账号完成 Git 提示的登录。

初始化会从 `.env.docker.example` 生成 `.env.docker` 和随机服务密钥；已有配置不会覆盖。模板管理员为 `admin`，密码为 `admin123`。首次启动前生成并保管独立密码，再编辑管理员配置：

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
notepad .env.docker
```

在记事本中修改 `ADMIN_USERNAME`、`ADMIN_PASSWORD`，保留其他已生成密钥，然后保存。`.env.docker` 只留在本机，不提交 Git。无需复制旧电脑的数据库、成片或模型凭据。

## 3. 启动并打开工作台

在仓库根目录执行：

```powershell
.\start-workbench.cmd
```

也可以在文件夹里双击 `start-workbench.cmd`。它会检查 Docker 是否使用 Linux containers、Compose 版本是否支持当前配置，然后一起构建并启动 Web、RAG 和 Signal，等待健康检查通过后打开工作台。若没有 `.env.docker`，首次运行会生成配置并停止，按提示设置管理员账号密码后再运行。首次构建可能需要几分钟到十几分钟，完成前不要关闭窗口。

这个入口始终使用 `compose.yaml` 加 `compose.signal.yaml`，project name 固定为 `ai-operation-signal`，各次启动共用同一套数据。不要叠加旧电脑的 `compose.local.yaml` 或 `compose.workbench.example.yaml`。仓库里的 `启动本地服务.cmd`、`start-mvp.cmd` 属于旧的原生安装模式，不会启动这个完整工作台；本说明使用 `*-workbench.cmd`，避免混用后出现缺少引擎或另一套空数据库。

在终端中查看状态，或不自动打开浏览器：

```powershell
node scripts/workbench.mjs status
.\start-workbench.cmd --no-browser
```

浏览器打开 [http://localhost:3100/#studio](http://localhost:3100/#studio)，用刚设置的管理员凭据登录，选择“自动化成片”。Signal 通过主系统登录代理访问，不需要打开或映射 `8892` 端口。OpenChatCut、Toonflow 未配置时显示未接入或离线，不影响 Signal。

首次没有历史成片，空库正常。知识库还需另外准备检索模型、上传资料并正式发布；容器启动成功不代表知识问答已经可用。

## 4. 配置模型和语音

在 Signal 界面设置并保存服务地址、模型名和语音方式。界面输入的 API Key 仅保存在进程内存，Signal 重启后需要重新填写。

希望重启后自动读取 Key 时，在仓库根目录创建独立的 `.env.signal`：

```powershell
if (-not (Test-Path .env.signal)) { Copy-Item .\engines\ai-signal-studio\.env.example .env.signal }
notepad .env.signal
```

填写 `VIDEO_LLM_API_KEY`，以及所用语音服务的 `VIDEO_TTS_API_KEY`，保存后执行：

```powershell
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml up -d --force-recreate signal
```

服务地址和模型名仍从界面保存。`.env.signal` 不提交 Git，只交给 Signal 容器；文件不存在也允许先启动界面。更改文件后需要重新创建容器，`restart` 不会重新加载环境变量。

Linux 容器支持 `edge` 和 OpenAI-compatible 语音服务。MLX / Qwen 本地语音依赖 Mac，不包含在这个镜像中。容器启动和健康检查不会自动发起收费生成；实际点击生成前需配置可用服务及额度。

## 5. 先检查渲染，再验证成片交接

以下命令使用合成音频和仓库样例检查 FFmpeg、Chromium、Remotion 及完整解码，不调用收费模型，也不会发布作品：

```powershell
.\check-workbench.cmd
```

这个检查会使用 `.env.docker` 中的管理员登录，确认登录保护、Signal 页面和接口、共享成片库可访问，再做一次合成视频渲染和完整解码。检查中不会打印密码，也不会生成业务作品或提交发布任务。双击运行时窗口会保留结果；终端自动检查可用 `node scripts/workbench.mjs verify`。

检查通过后，再按业务需要运行一次真实生成。完成视频后打开“共享成片库”并点击“同步作品”，确认可预览，再点击“用于发布”或在发布管理选择“从成片库选择”。带入发布草稿不等于发布成功，仍需原流程的预检、审核和最终授权。

本部署的 Local Agent 默认是模拟模式，不会真实发布或回复。真实五平台操作需要另外接入 Windows 原生 Local Agent，并验证登录及成片文件交接。

## 6. 关闭、再启动与故障检查

```powershell
.\stop-workbench.cmd
.\start-workbench.cmd
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml logs --tail 100 web signal
```

第一条停止服务并保留容器及数据，第二条再次启动，第三条查看最近日志。也可以双击对应的 `.cmd` 文件。不要执行带 `-v` 的 `docker compose down`，否则会删除命名卷中的成片和配置。下次使用前也要先启动 Docker Desktop。

| 情况 | 先检查 |
| --- | --- |
| `docker` 命令找不到或连不上 Server | Docker Desktop 是否安装、已启动，是否需要重新打开 PowerShell |
| 主页面打不开、提示 3100 被占用 | 是否有旧实例占用同一端口；不要启动两套实例抢同一端口 |
| Signal 离线 | 查看 `signal` 日志和 `docker compose ... ps` 的健康状态 |
| 界面可打开但生成失败 | Signal 中的服务地址、模型名、Key、额度及该任务错误 |
| 重启后提示缺 Key | 重新在界面输入，或检查 `.env.signal` 后重新创建 Signal 容器 |
| 生成完成但库里没有作品 | 是否完成完整解码验证、是否被拒绝、是否点击同步；查看同步拒收提示 |

仓库的自动检查分别覆盖 Windows 上的启动脚本逻辑，以及 Linux x64 上从源码构建、整套容器启动、登录代理、成片库访问和合成视频渲染。Windows 脚本测试不使用真实 Docker，因此仍需在目标 Windows / WSL2 电脑上执行一次 `check-workbench.cmd` 并做一次真实生成，才能确认该机器的网络、模型服务和额度也可用。完整配置和持久化说明见 [AI Signal Studio 部署](Signal-Studio部署.md)。
