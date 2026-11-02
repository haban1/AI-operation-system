# AI Studio 本地版

> 2026-10-26 后续更新：GitHub 新提交 `752c29e` 已补齐 Signal Studio 引擎。本机主入口已改用 `engines/ai-signal-studio/` 中的仓库版本，见 [Signal Studio GitHub 更新部署记录](./Signal-Studio-GitHub更新部署-20261026.md)。本文记录早先本地版，源码和示例数据保留作回退；旧页面入口会跳转到当前版本。

2026-10-26：GitHub 仓库 `haban1/AI-operation-system` 的 `66de9b7` 仅包含三路工作台界面及接入协议，没有原定制 AI Signal Studio 引擎。此版本是在天河仓库内补充实现的本地版，不是原版源码恢复。引擎源码位于 `platforms/ai-signal-studio/`，页面位于 `public/ai-studio/`。

## 使用

登录天河，进入「工作空间 → 内容创作 → 自动化成片」。也可打开 <http://127.0.0.1:3100/ai-studio/index.html>。

1. 输入主题、参考资料，选择竖屏、横屏或方形，以及视觉主题。
2. 「生成脚本」调用天河主模型，生成可编辑的标题、概述和分镜。保存后点击「生成视频」。「直接生成视频」会连续执行这两个步骤。
3. 视频使用本地 FFmpeg 制作字幕动效画面。可选本地普通话配音，音色较机械；默认不配音。
4. 成功后可预览 MP4、下载脚本及 SRT 字幕，并同步到天河成片库。入库要求完整视频解码校验通过。

这是主题到字幕短片的本地流程，不包含原项目的热点研究、多风格对比，也不调用图片或视频生成大模型。AI 生成的内容须由用户核实；没有自动发布。

## 统一模型和登录

文字模型使用 `http://web:3100/api/model/v1`，模型别名为 `tianhe-workbench-chat`。实际服务商、API Key 和模型实时沿用天河「AI 服务配置」，不用复制上游密钥。天河若处于模拟模式、密钥不可用或被限流，会显示明确失败状态。

浏览器通过天河同源 `/api/ai-studio/` 接口访问，沿用管理员登录和来源检查。内部容器端口 8892 不发布到宿主机；健康接口之外均要求内部令牌。`.env.ai-studio` 只保存内部鉴权凭据，不入 Git。

## 部署和数据

在天河项目目录运行：

```powershell
./scripts/setup-ai-studio.ps1
# 需要本机代理构建时：
./scripts/setup-ai-studio.ps1 -BuildProxy http://host.docker.internal:7897
# 已有镜像时：
./scripts/setup-ai-studio.ps1 -SkipBuild
```

脚本创建独立内部令牌并准备目录，构建、启动 `ai-studio`，然后重新创建天河 Web 容器接入服务及成片目录。源码、静态页面由现有天河源码挂载加载。完整三路启动脚本 `scripts/setup-workbench.ps1` 也包含此服务。

`runtime/workbench/ai-studio/` 保存 `projects/` 任务及脚本、`runs/` 完成作品，以及 `data/` 审核元数据。天河只读挂载 `runs` 与 `data`，同步后另存于现有 `web_data` 卷。重启保留项目和视频，中断任务需要手动重试，不自动重放模型调用。单进程串行处理，最多 8 个在处理或排队的任务，容器限制 2 CPU、2 GB 内存。

镜像不携带凭据和真实数据。部署前配置副本保存在 `backups/ai-studio-local-20261026/`。回退时先停止 `ai-studio`，恢复备份内的 Compose、主程序配置与接口文件，以及 `.env.docker.before`（若存在），再重新创建 Web 容器。保留 `runtime` 目录及 `web_data` 卷即可保留生成作品。

## 验证命令

```powershell
node --test platforms/ai-signal-studio/test/studio.test.js test/ai-studio-proxy.test.js
docker run --rm -e STUDIO_RENDER_TEST=1 tianhe-ai-studio:local-20261026 node --test test/studio.test.js
docker exec tianhe-dev-web-1 node --test test/creative-workbench-status.test.js test/ai-signal-integration.test.js test/content-library-sources.test.js test/content-library.test.js
```

最后一组包含符号链接隔离测试，应在 Linux 容器中运行；Windows 未启用符号链接权限时会报 EPERM。

## 本机部署验证结果（2026-10-26）

- 三条创作线路在线，AI Studio 使用天河现有 `deepseek-flash` 配置，未另填服务商 Key。
- 页面真实提交「部署验证：咨询服务前的准备」，完成四镜头脚本和 720 × 1280、16.024 秒的 H.264 视频；已在浏览器播放并检查文字排版。
- MP4、封面、JSON 脚本及 SRT 字幕均可下载，视频分段请求正常。未登录的项目和媒体请求返回 401。
- 示例作品「咨询服务前，先做好这四步准备」已进入共享成片库，入库视频和原视频的 SHA-256 一致。未进行发布。
- 单独重启 AI Studio 后再次验证通过，项目、脚本、视频均保留。微信、OpenChatCut 和 Toonflow 容器未重启。
- 引擎测试 6/6（含真实 FFmpeg 和本地配音）；天河代理、工作台、接入和成片库测试 69/69，在 Linux 容器中通过。

真实部署复核命令（需要已有完成项目，不会新建视频或发布）：

```powershell
docker exec tianhe-dev-web-1 node scripts/verify-ai-studio-live.mjs e62b7f60-9d06-4921-b9d2-d53303b0b47d
```

该命令会同步现有成片，并将不含凭据的验证报告写入容器 `/app/data/ai-studio-live-verification.json`。本次重启后的报告同时保存在 `backups/ai-studio-local-20261026/live-verification-after-restart.json`。
