# 源码交接包清单（2026-09-02）

## 包含

- 最新 `agent/`、`src/`、`public/`、`test/`
- `docs/`、`design/`、`scripts/`、`platform-workflows/`
- 项目配置、启动脚本、依赖清单
- 最新交接文档和结构化会话记录
- Git 状态、已跟踪差异补丁、未跟踪文件清单

## 排除

- `.git`、`.env`
- `node_modules`、`.runtime`
- `.tmp`、`tmp`、`logs`、`data`
- 真实 SQLite 数据库
- `outputs`、`dist`、`packaging`
- `首次登录信息.txt`

这些内容属于依赖、缓存、构建结果、真实业务数据、登录状态或潜在敏感配置，不放入可交接源码包。

