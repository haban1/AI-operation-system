# 2026-11-12：热点来源恢复与热点成片库流程

日期：2026-11-12（Australia/Sydney）。基线 `fed4cc2`（main）。状态：已在本机 3101 验证，用户要求推送到 main；未部署。

## 背景与目标

用户反馈 AI 热点自动生成页：

- 热点选题来源只剩“RSS · IT之家”，原有的 GitHub 等来源不见了。
- 点“成片库”后跳到另一套布局（“成片库 / 热点制作”标签 + “生成热点”），流程不顺。
- 希望整体操作逻辑更顺。

## 原因

`data/feed.json` 显示配置里所有来源都已开启，但采集时：

- GitHub 失败，原因是 `IncompleteRead(494544 bytes read)`。GitHub 周榜页面约 560KB，传输中途断开时抛出 `http.client.IncompleteRead`；它不属于 `OSError`，`read_public` 没有捕获，`fetch` 也就不会重试。
- Hacker News 失败，原因是 “Unterminated string”。分块响应被提前结束，拿到的 JSON 不完整。
- Reddit 返回 HTTP 403；微博、小红书需要本机登录采集服务。这三项不是本次的网络问题。

本机连续三次直接请求复现：GitHub 一次 `IncompleteRead`，Hacker News 一次只返回 22,802 / 30,569 字节而没有报错。

## 变更与影响

- `engines/ai-signal-studio/scripts/public_web.py`：捕获 `http.client.HTTPException`，并按 `Content-Length` 核对实际读到的长度；内容不完整时报“网页连接中断，内容不完整”。
- `scripts/collect.py`：`fetch` 把“连接中断”视为可重试，最多 4 次；Reddit / Hacker News 的 JSON 解析失败时再获取最多 2 次。没有放宽来源校验，也没有绕过登录。
- 热点成片库流程（`engines/video-studio/dist/app.js`）：
  - 热点页的“成片库”和旧的 `#automatic/library` 都改为进入统一的“成片与素材”，来源筛选为“自动热点”，顶栏高亮“成片与素材”。
  - 没有热点成片时，显示说明和“去生成热点”按钮。
  - 从顶栏直接点“成片与素材”时，来源筛选重置为全部。
- 热点页任务提示（`web/app.js`、`web/index.html`）：采集结果或失败提示可以点 × 收起，只记住这一次结果，新任务的结果仍会显示；任务进行中不显示收起按钮。
- 样式：`public/creation-skin.css` 加入收起按钮样式，并更新三层页面的缓存版本号。

## 决策与取舍

- 只把“连接中断 / 内容不完整”加入自动重试，不重试 HTTP 403、登录失败等确定性错误，以免掩盖真实问题。
- 热点成片不再保留单独的成片库页，统一在“成片与素材”里用来源筛选查看，与混剪成片的确认、发布入口一致。
- 提示收起只保存在本机浏览器，不改服务端任务状态。

## 验证与证据

- 重启 3101 后在页面点“刷新热点”：GitHub 正常（9 个 AI 项目），Hacker News 正常（12 条讨论），RSS · IT之家 正常（30 条）；Reddit 403，微博、小红书仍为未连接；共 39 条选题。
- “成片库”进入 `#materials`，来源筛选为 `automatic`，顶栏高亮“成片与素材”，空状态显示“去生成热点”并能返回热点页；从顶栏直接进入时筛选为全部，可见 23 张卡片。
- 收起提示后，经过 6 秒轮询仍保持收起。
- Signal Python `unittest discover`：93 项通过。Node 相关 6 个文件 77 项中 76 项通过。`creation-navigation-ui` 1440px 在与其他测试并行时超时失败一次，之后单独连续运行 3 次均 2/2 通过，判断为负载下的时序波动。

## 部署与回退

未部署。3101 用 `scripts/start-montage-local.mjs --restart` 重启了两次（需要 `LC_ALL=en_US.UTF-8`，原因见上一份记录）。热点文稿模型的 Token 只保存在进程内，重启后要在“系统设置 → 创作设置”重新填写。

回退：还原上述文件后重启 3101。

## 未完成与下一步

- Reddit 403 需要换用可访问的入口或去掉该来源；微博、小红书需要配置本机登录采集服务（不绕过登录）。
- 本机重启脚本的 PID 路径比对仍受非 ASCII 路径影响。
- 重新填写文稿 Token 后，用 GitHub 选题走一遍“生成三版对比”，验证热点成片能进入“成片与素材”。

## 上下文与关联

- [智能混剪文案时间轴与 AI 调整合一](2026-11-12-montage-captions-ai-tune.md)
- [内容创作外观对齐](2026-11-12-creation-ui-alignment.md)
- [内容创作集成记录](2026-11-12-content-main-integration.md)
