# Signal Studio GitHub 更新部署

来源：`https://github.com/haban1/AI-operation-system`，提交 `752c29e68f892fa6b2fe0ed54ebce2bbee13b7c7`。这个提交新增 `engines/ai-signal-studio/`、同源认证代理及独立部署配置。此前的 `66de9b7` 尚未包含该引擎。

本机保留已有天河、微信、OpenChatCut 和 Toonflow 的数据与配置，将上游 84 个文件的差异合并到现有项目。冲突处理保留本机配置字段和历史环境说明，没有以旧快照覆盖本机微信改动。合并计划及修改前文件在 `backups/signal-752c29e-20261026/`。

## 本机入口与配置

- 主入口：`http://127.0.0.1:3100/#studio` → 自动化成片。
- 独立入口：`http://127.0.0.1:3100/integrations/ai-signal/`，沿用天河管理员登录。
- 新容器：Compose 服务 `signal`，镜像 `tianhe-signal:752c29e`，容器内部端口 8892，不发布宿主端口。
- 文稿协议为 Chat Completions，地址 `http://web:3100/api/model/v1`，模型别名 `tianhe-workbench-chat`。实际模型、服务商和 Key 仍由天河统一配置。
- `.env.signal` 中的 `VIDEO_LLM_API_KEY` 是天河内部网关令牌，不是复制的服务商 Key；该文件被 Git 忽略。
- 默认配音使用 Edge 在线普通话服务，不需要另外填写配音 Key。
- 本机运行目录为 `runtime/workbench/signal/{runs,data,config}`。Web 只读挂载作品及审核数据，私有配置不挂载到 Web。

## 更新命令

在当前项目运行：

```powershell
./scripts/setup-signal.ps1
# 已构建好镜像时
./scripts/setup-signal.ps1 -SkipBuild
```

本机使用 `compose.yaml + compose.wechat.yaml + compose.workbench.yaml`。上游 `compose.signal.yaml` 是新建独立实例的配置，当前已有实例无需叠加它。

本次系统依赖使用直连下载；本机代理曾导致大文件下载停滞。仅在直连不可用时才传入 `-BuildProxy`。

早先本地版的服务 `ai-studio` 放在 `legacy-studio` profile 中，默认不启动。其源码和 `runtime/workbench/ai-studio` 数据保留，已入共享成片库的视频副本也保留。旧 `/ai-studio/index.html` 入口自动跳转到当前 Signal 页面。完整三路启动脚本 `scripts/setup-workbench.ps1` 已切换为启动仓库的 `signal` 引擎。

## 验证

本次在 Windows Docker Desktop / Linux AMD64 容器中完成：

- 工作台、Signal 认证代理和成片库测试 79 项通过；随仓引擎端到端测试 5 项通过，涵盖主程序登录、真实媒体传输、入库、发布草稿和两个服务重启。
- 引擎 Python 测试 69 项通过。测试需清空容器默认的 `SIGNAL_CONFIG_DIR`，让测试夹具控制临时配置路径；实际服务仍使用持久化配置目录。
- 隔离容器执行 `scripts/smoke_render.py`，Remotion、Chromium、FFmpeg 生成 1080 × 1920 视频且完整解码通过。
- 真实调用天河统一模型读取 Remotion 官方资料、生成 8 场文稿，Edge 中文配音成功，输出「用 React 写视频」：1080 × 1920、76.224 秒、H.264 + AAC，浏览器从头播放到 1:16 结束。
- 下载和首段/尾段 Range 请求通过；同步到成片库后的文件 SHA-256 与源视频一致。发布草稿可读取且仍要求预检，没有发布任何内容。
- 单独重启 `signal` 后，模型连接配置、运行记录、视频和成片库 ID 均保留，重复同步不产生副本。天河、Signal、OpenChatCut、Toonflow 均为 healthy，工作台显示 3/3 在线。
- 旧本地版容器 `tianhe-dev-ai-studio-1` 已停止，示例视频仍在共享库中；微信后台、微信客户端及另外两路引擎未重启。

本次验收验证了单条视频的完整生产链路；三路随机探索、独立评审和反馈重做通过随仓测试覆盖，未在本次验收另行执行完整的收费对比任务。

复核现有示例（只同步和读取草稿，不生成、不发布）：

```powershell
docker exec tianhe-dev-web-1 node scripts/verify-signal-live.mjs verify run-20261026-082305-321164
```

验证报告：`backups/signal-752c29e-20261026/live-verification-after-restart.json`。运行镜像 ID：`sha256:aa24e08b9ee192232fd19fb4244d8eee3b2f811369bbbeb55fdc106729c21fa8`。
