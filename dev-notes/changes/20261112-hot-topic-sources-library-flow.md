# 热点来源恢复与热点成片库流程

2026-11-12（Australia/Sydney）。基线 `fed4cc2`（main）。

用户反馈热点来源只剩 IT之家，热点页“成片库”跳转不顺。原因是 GitHub 周榜页面传输中途断开（`IncompleteRead` 未被捕获，也未重试），Hacker News 的 JSON 被截断；Reddit 403，微博、小红书未登录。

`public_web.py` 捕获连接中断并核对 `Content-Length`，`collect.py` 对连接中断和 JSON 不完整自动重试。热点页“成片库”改为进入统一的“成片与素材”（筛选自动热点，空状态可返回生成）；任务结果提示可以收起。

验证见[完整记录](../../docs/changes/2026-11-12-hot-topic-sources-library-flow.md)：刷新后 GitHub 9、Hacker News 12、IT之家 30；Signal Python 93 项通过；Node 相关测试中 `creation-navigation-ui` 并行运行时超时一次，单独复跑 3 次均通过。用户要求推送到 main，提交结果以 Git 历史为准；未部署。

下一步：重启后需要重新填写热点文稿 Token；Reddit、微博、小红书需要另行接入。
