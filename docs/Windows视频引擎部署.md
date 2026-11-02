# Windows 本地视频引擎

`compose.workbench.yaml` 将独立引擎接入天河内容工作台。使用项目源码构建容器，端口只绑定本机。原有天河、知识库、微信服务与数据卷继续使用。

| 路线 | 源码 | 入口 | 状态 |
| --- | --- | --- | --- |
| 自动化成片 | `engines/ai-signal-studio` GitHub 随仓引擎 | http://127.0.0.1:3100/integrations/ai-signal/ | 已切换至 `752c29e` |
| 素材智剪 | `platforms/OpenChatCut` | http://127.0.0.1:5199/ | 由独立容器运行 |
| AIGC 创作 | `platforms/Toonflow` | http://127.0.0.1:13000/ | 由独立容器运行 |

固定的上游仓库和 commit 记录在 `deploy/workbench/sources.json`。外部检出目录不重复提交进天河仓库；脚本根据记录恢复源码。修改源码后重新构建即可生效，升级前应保留自己的修改并显式更新固定版本。

## 启动

在项目根目录用 PowerShell 执行（需 Docker Desktop、Git、已配置的 `.env.docker`）：

```powershell
./scripts/setup-workbench.ps1
```

脚本准备源码与初始设置，构建并启动三个引擎，待 SQLite 初始化后重建天河 Web 容器以接入只读作品目录。Signal 文稿连接统一指向天河网关，已有语音设置保留；另外两路已有设置保留。不会重新初始化天河数据库。启动或重建引擎后应通过该脚本刷新 Web 的 SQLite/WAL 文件挂载。

本机需要代理下载时，代理仅用于克隆和构建，不写入运行镜像的环境变量：

```powershell
./scripts/setup-workbench.ps1 -GitProxy http://127.0.0.1:7897 -BuildProxy http://host.docker.internal:7897
```

已有镜像时启动：

```powershell
./scripts/setup-workbench.ps1 -SkipBuild
```

打开 http://127.0.0.1:3100/#studio ，从三条路线选择进入。独立入口见上表，Signal 沿用天河管理员登录。

仅停止这三个创作引擎：

```powershell
docker compose -f compose.yaml -f compose.wechat.yaml -f compose.workbench.yaml stop signal openchatcut toonflow
```

## 数据和模型

- Signal 作品、运行记录与配置：`runtime/workbench/signal/`；模型内部令牌：被 Git 忽略的 `.env.signal`。
- OpenChatCut 项目、上传素材和设置：`runtime/workbench/openchatcut/`。
- Toonflow 设置与插件：`runtime/workbench/toonflow/`；作品：其 `workspaces/` 下。
- 天河只读挂载 OpenChatCut 的作品数据库、WAL/SHM、素材目录以及 Toonflow 的工作区。通过完成状态校验后导入的作品副本保存在原有 `web_data` 卷内。
- 备份引擎时先停止对应引擎，完整备份各自 runtime 目录；备份中含访问凭据，不提交 Git。天河自己的数据库与成片库需另外备份 `web_data`。

初始文字模型使用天河内部网关 `http://web:3100/api/model/v1`，模型别名 `tianhe-workbench-chat`，实际服务商、密钥和模型沿用天河主配置。脚本只将内部网关令牌写入引擎的本地设置，不复制服务商密钥。OpenChatCut 使用 OpenAI 协议的 Chat Completions 模式；Toonflow 的模型供应商名称为「天河统一模型」。

图片、视频、语音等生成服务需要在 OpenChatCut / Toonflow 中配置它们支持的供应商；天河现有文字网关不提供这些生成接口。页面可用与模型服务可用是两项独立状态。2026-10-26 已切换到 GitHub `752c29e` 中的 Signal Studio 引擎，支持选题研究、配音动效视频和多风格对比；默认 Edge 普通话配音无需额外 Key。详见 [GitHub 更新部署记录](Signal-Studio-GitHub更新部署-20261026.md)。早先本地补充实现及示例数据保留供回退。

OpenChatCut 使用上游生产服务器和已编译页面，容器内 Nginx 转发至 loopback，并保留来源与访问凭据校验。Toonflow 采用上游 Bun 1.3.14 的标准 standalone 构建；基础运行层复用 Node Debian 镜像，Bun 从官方 npm 包安装。

成片库由页面访问或「同步作品」触发同步。OpenChatCut 导出后应及时同步，避免临时导出被源端清理。Toonflow 视频节点输出标记为片段，图片标记为图片，不把分镜自动视作完整成片。

## 2026-10-22 部署验证

两个引擎和天河 Web 均为 healthy；已实际打开独立页面、天河内嵌页面、OpenChatCut 剪辑器及 Toonflow 空白画布。重启后设置、OpenChatCut 自带示例工程和 Toonflow 的 `myProject/画布1.json` 均保留。

两个容器均能通过内部令牌访问天河模型网关状态接口，当前主模型为 `deepseek-flash`，处于在线模式。未调用收费生成接口，也未发布内容。与模型路由、服务状态、来源读取相关的 16 项测试通过；来源读取与访问校验的实际 HTTP 检查通过。成片库目前为空，尚未用新生成的视频验证端到端入库。

工作台显示 2/3 在线，AI Signal Studio 源码仍待补齐。Toonflow 的云端作品区未登录，可能显示「用户信息错误」；本地项目和画布可用。现有微信后台检查正常，天河全局 Agent 开关仍为停止状态。
