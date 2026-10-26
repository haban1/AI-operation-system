# AI Signal Studio

本目录是运营系统随仓交付的热点视频引擎，包含选题研究、多方案创作、配音和 Remotion 渲染源码。Windows 本机推荐按 [Windows 部署指南](../../docs/Windows本机部署.md) 使用 Docker Desktop；容器、登录代理和成片库配置见 [详细部署说明](../../docs/Signal-Studio部署.md)。

源码基于 `kinnyuww/ai-video-factory` 的 `d97ea17`，并包含后续本机的研究、多方案创作和评审模块。部署本系统使用当前仓库中的完整目录。

## 原生独立运行

先安装 Python 3.9+、Node.js 20+、FFmpeg（含 ffprobe）和 curl。Linux 另需中文字体，例如 `fonts-noto-cjk`。

```bash
# 在当前 engines/ai-signal-studio 目录中执行。
python3 setup.py
python3 app.py --port 8892
```

打开 http://127.0.0.1:8892 ，在「模型设置」填写服务地址、模型名和 Token，点击「保存并测试连接」。Windows 将命令中的 `python3` 换成 `python`。

选题后可生成单条视频，或让三个 Agent 随机探索：每轮分配不同创作约束，各自设计专用提示词并制作，第四位 Agent 匿名比较成片关键帧、文稿与时序。失败重试保留原方案；“同题再探索”换一组。评审不试听音频，模型不支持图片时降级为文字评审。完整流程见工作台内的流程图。

在「选题与研究 → 自主选题」输入主题，可补充受众和参考网页。系统会搜索、读取正文、整理带来源的资料后生成视频。自动模式优先尝试 Responses 服务的联网搜索，不支持时使用公开搜索；网络受限或资料不足会说明原因并停止生成。

默认使用在线文稿模型与 Edge 配音。也可选择 OpenAI 兼容 Speech API，单独填写语音地址、模型、音色和语音 Token，再试听。本地 Qwen 配音仅适用于已配置 MLX 的 Apple Silicon 环境。

首次启动会从 `config.example.json` 创建本地配置。Token 只保留在当前进程中，重启后重新填写；也可通过 `VIDEO_LLM_API_KEY`（文稿）、`VIDEO_TTS_API_KEY`（语音）环境变量提供。

默认仅监听回环地址。Docker 部署使用 `SIGNAL_HOST`、`SIGNAL_PORT`、`SIGNAL_CONFIG_DIR` 和 `SIGNAL_BASE_PATH`，将私有配置与共享作品分开，并通过主应用的管理员登录代理访问；不要单独公开引擎端口。

## 原生运行的数据迁移

停止服务后，在新机器复制原机器的 `runs/`、`data/` 和不含 Token 的 `config.json`。配音 Python 路径留空即可使用新机器的项目环境，然后重新启动。

这些本地文件、日志、依赖和成片均被 Git 忽略，只提交源码与配置示例。

服务器可通过 SSH 转发访问：

```bash
ssh -L 8892:127.0.0.1:8892 user@server
```
