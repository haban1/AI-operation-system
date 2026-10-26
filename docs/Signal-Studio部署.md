# AI Signal Studio 随仓部署

这套部署启动运营系统 Web、RAG 和 AI Signal Studio。Signal 引擎源码位于 `engines/ai-signal-studio/`，不依赖另一台电脑的源码、历史成片或仓库同级的 `platforms/` 启动脚本。

浏览器登录运营系统后，通过 `/integrations/ai-signal/` 使用“自动化成片”。Signal 容器只在 Compose 内网监听 `8892`，不映射宿主端口；浏览器入口由 Web 管理员会话保护。Signal 完成的作品通过只读共享卷进入成片库，并沿用发布管理的审核和授权流程。

本次只包含 **AI Signal Studio**。OpenChatCut 和 Toonflow 仍是可选外部服务，没有安装它们也能启动本部署；它们的路线不会因此具备生成能力。此前连接三台本机服务的方式见 [视频创作工作台本地接入](视频创作工作台本地接入.md)。

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
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml config --quiet
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml up -d --build --wait --wait-timeout 300
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml ps
```

macOS 若 `docker` 不在 PATH，可将命令中的 `docker` 替换为 `/Applications/Docker.app/Contents/Resources/bin/docker`。这组命令不要叠加旧的 `compose.local.yaml` 或 `compose.workbench.example.yaml`，它们会引入另一台电脑的来源挂载和浏览器地址。

打开 `http://localhost:3100/#studio`，使用刚设置的管理员凭据登录，再进入“自动化成片”。首次启动没有历史作品，成片库为空是正常状态。基础 RAG 配置仍需单独准备知识模型与正式知识版本；没有可用知识库不代表 Signal 安装失败。

默认只绑定本机 `127.0.0.1:3100`。需要服务器或局域网访问时，由部署维护人员为 Web 配置受保护的 HTTPS 入口并更新允许的来源；保持 Signal 不暴露宿主端口。不要把 `127.0.0.1:8892` 当作远程用户浏览器的入口。

## 配置和数据保存在哪里

| 数据 | 容器内位置 | 持久化卷 | Web 的访问权限 |
| --- | --- | --- | --- |
| Signal 完成输出与运行记录 | `/app/runs` | `signal_runs` | 只读挂载到 `/sources/ai-signal/runs` |
| Signal 作品审核、对比等业务数据 | `/app/data` | `signal_data` | 只读挂载到 `/sources/ai-signal/data` |
| Signal 服务地址、模型名等配置（不含 UI 输入的 Key） | `/app/runtime-config` | `signal_config` | 不挂载 |
| 已入库的成片副本与索引 | `/app/data/content-library`（Web） | `web_data` | Web 管理 |

Compose 自动创建空卷，不要求宿主机预先存在 `runs`、审核 JSON 或 SQLite WAL/SHM 文件。引擎的私有配置与共享产物分开保存；Web 成片库只读取作品来源，不需要读取模型凭据。

## 填写模型服务

在 Signal 界面保存模型服务地址、模型名和语音设置。**界面输入的 API Key 只保留在引擎进程内存中，重启后需要重新填写**；它不会随 `signal_config` 卷保存。

需要重启后继续使用 Key 时，在仓库根目录复制 Signal 专用模板；已有 `.env.signal` 时直接维护原文件，不要覆盖：

```powershell
if (-not (Test-Path .env.signal)) { Copy-Item .\engines\ai-signal-studio\.env.example .env.signal }
notepad .env.signal
```

在 `.env.signal` 中填写 `VIDEO_LLM_API_KEY` 和所用语音服务的 `VIDEO_TTS_API_KEY`，然后重建 Signal 容器以重新加载环境变量：

```powershell
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml up -d --force-recreate signal
```

模型地址和模型名仍在界面保存。`.env.signal` 是可选文件，未创建时也能启动引擎；该文件只供 Signal 容器使用，不传给 Web 或 RAG，也不要提交 Git。仅执行 `restart` 不会重新读取修改后的环境变量。

Linux 镜像支持 `edge` 和 OpenAI-compatible 语音服务。MLX / Qwen 本地语音需要 macOS 专有依赖，不包含在这个 Linux 镜像中；不要将本机 Mac 可用的语音配置直接视为容器内可用。

启动容器不会自动发起收费生成。服务健康表示引擎能够响应，不表示模型额度、权限、配音和完整成片链路已经通过。

## 从生成到发布管理

1. 在“自动化成片”完成选题和生成流程，等待作品验证完成。
2. 打开“共享成片库”，点击“同步作品”。Signal 只有 `validation.json` 标记 `full_decode=passed` 的有效视频会被接收，已拒绝作品不会进入库。
3. 检查作品预览。入库会校验媒体并保存独立副本；后续源引擎临时离线不会删除已入库作品。
4. 点击“用于发布”，或到发布管理选择“从成片库选择”。文件、标题和正文会填入发布表单；仍需选择平台、完成预检与审核，并明确授权最终发布。

同步是访问成片库或手动操作触发的，不是后台持续归档。首次上线验证可使用已授权的测试作品；不要把健康检查通过当成已经真实生成或发布。

## 必要验收

启动后先执行无模型调用的渲染检查。脚本生成 1 秒合成音频，使用仓库样例验证 FFmpeg、Chromium 和 Remotion，检查完整解码结果后清理测试产物：

```powershell
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml exec -T signal python3 scripts/smoke_render.py
```

这项检查不调用外部文本、配音或视频生成服务，也不替代真实选题生成验收。

- **干净启动**：从新 clone 和空卷启动，`web`、`rag`、`signal` 达到各自的健康状态；不依赖旧机器目录。没有本地 RAG 模型时，单独处理知识检索配置，不以未执行的知识检索作为通过证据。
- **入口与认证**：未登录不能访问 Signal 页面/API；登录后从内容工作台打开 Signal，页面、静态资源与 API 均通过 Web 同源入口加载。
- **缺省来源**：未安装 OpenChatCut / Toonflow 时，Web 和 Signal 仍能启动，另外两条路线显示未接入或离线；空的 Signal 来源不会让 Web 启动失败。
- **成片交接与重启**：一件完成作品入库后可以预览并带入发布草稿；重启 Signal 和 Web 后仍可读取，重复同步不产生重复副本。验证到草稿为止，不自动发布。

上述是本部署需要执行的验收步骤，不代表每一项已在当前机器上完成。当前开发检查环境是 macOS 上的 Linux ARM64 容器环境；其构建、渲染和代理检查不能替代 Windows / WSL2 实机验收，目前没有 Windows 实机通过记录。验证记录应分别写明容器构建、页面加载、生成、入库与发布草稿结果。

## 日常操作

```powershell
# 查看运行状态与最近日志。
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml ps
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml logs --tail 100 web signal

# 更新源码后重新构建；保留命名卷中的数据。
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml up -d --build --wait --wait-timeout 300

# 停止本套服务，保留卷；下次用相同 project name 启动。
docker compose -p ai-operation-signal -f compose.yaml -f compose.signal.yaml down
```

不要加 `down -v`，它会删除命名卷。更换 Compose project name 会得到另一套卷，不能据此判断旧数据已丢失。升级前停止生成任务并备份 `signal_runs`、`signal_data`、`signal_config`、`web_data`；私有配置备份按凭据文件管理。

Signal 离线时先查看 `signal` 容器日志；页面能打开但生成失败时再检查其模型配置和具体任务错误。来源目录可读取但成片库没有作品时，检查完整解码状态、源端审核结果与同步的拒收提示。工作台健康检查、生成成功和成片入库是不同状态。

基础 Compose 的 Local Agent 使用 `simulated` 模式，不会真实发布或回复。连接 Windows 原生 Local Agent 做真实平台操作时，还需单独验证登录和文件交接；Windows 进程不能直接读取成片库返回的 Linux 容器绝对路径。
