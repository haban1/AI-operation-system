# 云端浏览器控制体系

> 版本：V1.0  
> 落地日期：2026-08-14  
> 状态：代码已接入，默认关闭，需按本文逐项启用。

## 1. 目标

本体系把项目级 `web-access 2.5.3` 的 CDP 能力接入现有“云端 Web + Windows Local Agent + 五平台 RPA”架构，同时保留原有 Playwright 独立 Profile 体系作为显式回退。

它用于诊断、辅助导航、页面只读取证和本地文件预装载，不替代现有 `PUBLISH`、`REPLY`、`VERIFY_PUBLISH` 等高风险业务流程。

## 2. 架构与信任边界

```text
云端 Browser Command Service
        │ 设备绑定、账号绑定、结构化命令、幂等键、审计
        ▼
Windows Local Agent / BrowserController
        │
        ├─ WebAccess CDP Provider
        │       ▼
        │  127.0.0.1:3456 CDP Proxy
        │       ▼
        │  人工授权远程调试的 Chrome / Edge 登录实例
        │
        └─ Playwright Provider（显式选择的回退）
                ▼
           五平台独立持久化 Profile
```

关键边界：

1. 云端服务不连接浏览器调试端口，只向已鉴权的 Local Agent 下发结构化命令。
2. CDP Proxy 固定监听 `127.0.0.1`，不对局域网和公网开放。
3. 云端不能下发 JavaScript、Cookie、密码、验证码、localStorage 或 sessionStorage 读取请求。
4. 发布、回复、删除、付款、审核等动作不能用低级 `CLICK` 绕过现有业务流程。
5. 素材原文件留在 Windows RPA 电脑；文件路径必须位于配置的本地允许目录。
6. 交互式动作执行后发生异常时，按结果不确定处理并返回 `NEEDS_CONFIRMATION`。

## 3. 正式代码组成

### 云端

- `src/services/browser-control-policy.js`：动作、Provider、用途、域名、敏感字段、交互确认和文件目录策略。
- `src/services/browser-command.js`：session、命令、幂等、状态与审计事件服务。
- `src/server.js`：管理端命令 API、Agent claim/defer/complete 状态同步、租约恢复和能力上报。
- `src/db.js`：`browser_sessions`、`browser_commands`、`browser_command_events` 表及恢复策略。

### Windows Local Agent

- `agent/browser-control/controller.js`：session 固定绑定、二次策略校验、Provider 调度、结果不确定处理。
- `agent/browser-control/providers/web-access-cdp-provider.js`：本机 CDP Provider。
- `agent/browser-control/providers/playwright-provider.js`：独立 Profile 回退 Provider。
- `agent/browser-control/evidence.js`：截图证据路径隔离。
- `agent/browser-control/vendor/web-access/`：生产运行所需的 MIT 许可 web-access 运行时代码。

生产运行不依赖开发目录 `.agents/skills/web-access`。

## 4. 允许的结构化动作

| 动作 | 风险级别 | 说明 |
|---|---:|---|
| `HEALTH_CHECK` | 只读 | 检查 Provider / CDP 连接状态 |
| `OPEN_PAGE` | 只读导航 | 新建受管标签页，只允许 HTTPS 和平台域名白名单 |
| `NAVIGATE` | 只读导航 | 在当前受管标签页跳转 |
| `READ_PAGE_STATE` | 只读 | 读取标题、URL、页面就绪状态等 |
| `READ_TEXT` | 只读 | 按 selector 读取有限长度文本；JS 表达式由 Provider 固定生成 |
| `SCROLL` | 低风险 | 在受管标签页滚动 |
| `SCREENSHOT` | 只读取证 | 截图写入本地证据目录 |
| `CLOSE_TAB` | 低风险 | 关闭本 session 的受管标签页 |
| `CLICK` / `CLICK_AT` | 交互式 | 默认关闭，限辅助导航，要求 30 分钟内人工确认 |
| `SET_FILES` | 交互式 | 默认关闭，限文件预装载，要求人工确认和目录白名单 |

禁止动作或参数包括：任意脚本执行、Cookie/存储读取、账号密码、验证码、验证码绕过，以及直接点击发布、发送、回复、删除、支付、审核类控件。

## 5. Provider 选择

### `web_access_cdp`（默认 Provider，但整个功能默认关闭）

适合：

- 需要复用当前人工登录的浏览器实例；
- 页面诊断、只读检查、辅助导航；
- 操作人员能在 RPA 电脑上确认当前浏览器登录账号。

限制：

- Chrome 会要求人工允许远程调试；
- CDP 只能看到当前获授权的浏览器实例；
- Provider 不能从 CDP 可靠验证该实例对应哪个磁盘 Profile；
- 同一获授权浏览器实例中的登录账号必须由操作人员核对，不能仅依赖云端的 account/profile 绑定声明。

### `playwright`

适合：

- 需要五平台独立 Profile 的强隔离；
- 现有平台适配器已经围绕独立 Profile 完成验证；
- 不希望复用当前人工浏览器实例。

Provider 不会自动静默回退。云端命令必须显式选择 Provider，避免在未知浏览器状态间切换。

## 6. 安全默认配置

```env
BROWSER_CONTROL_ENABLED=false
BROWSER_CONTROL_PROVIDER=web_access_cdp
BROWSER_CONTROL_ENABLED_PLATFORMS=
BROWSER_CONTROL_INTERACTIVE_ENABLED=false
BROWSER_CONTROL_RISK_ACKNOWLEDGED=false
BROWSER_CONTROL_CDP_PROXY_PORT=3456
BROWSER_CONTROL_BROWSER=chrome
BROWSER_CONTROL_PROXY_AUTO_START=true
BROWSER_CONTROL_REQUEST_TIMEOUT_MS=30000
BROWSER_CONTROL_TAB_IDLE_TIMEOUT_MS=900000
BROWSER_CONTROL_ALLOWED_HOSTS=
BROWSER_CONTROL_EVIDENCE_DIR=./logs/browser-control
BROWSER_CONTROL_FILE_ROOTS=./data/uploads,./data/materials
```

不要在未完成账号核对、人工监护和风控评估前把交互式动作打开。

## 7. 首次启用流程

1. 保持 `BROWSER_CONTROL_INTERACTIVE_ENABLED=false`，先只启用一个平台。
2. 在正式 `.env` 设置：

   ```env
   BROWSER_CONTROL_ENABLED=true
   BROWSER_CONTROL_ENABLED_PLATFORMS=douyin
   BROWSER_CONTROL_PROVIDER=web_access_cdp
   ```

3. 如果允许 Local Agent 自动启动 CDP Proxy，必须在完成风控确认后设置：

   ```env
   BROWSER_CONTROL_RISK_ACKNOWLEDGED=true
   ```

4. 重启 Web 与 Local Agent。
5. 在目标 Chrome 实例打开 `chrome://inspect/#remote-debugging`，人工开启“Allow remote debugging for this browser instance”。
6. 核对当前浏览器实例登录的是云端 session 所绑定的平台账号。
7. 先执行 `HEALTH_CHECK`、`OPEN_PAGE`、`READ_PAGE_STATE`、`SCREENSHOT`。
8. 检查云端命令记录、Local Agent 日志和本地截图证据。
9. 完成单账号、小范围、低频验证后，才评估是否开启交互式动作。

风险提示：通过 CDP 控制已登录浏览器可能触发平台风控、账号限制或页面二次验证。必须低频运行、人工监护，并遵守平台规则。

## 8. 云端 API

### 查询能力摘要

`GET /api/browser-control/summary`

### 创建命令

`POST /api/browser-control/commands`

只读打开页面示例：

```json
{
  "platformCode": "douyin",
  "accountId": 2,
  "provider": "web_access_cdp",
  "purpose": "DIAGNOSTIC",
  "action": "OPEN_PAGE",
  "idempotencyKey": "douyin-diagnostic-open-20260814-001",
  "params": {
    "url": "https://creator.douyin.com/creator-micro/content/manage"
  }
}
```

后续命令必须复用返回的 `session.id`：

```json
{
  "platformCode": "douyin",
  "accountId": 2,
  "sessionId": "<session-id>",
  "provider": "web_access_cdp",
  "purpose": "DIAGNOSTIC",
  "action": "READ_PAGE_STATE",
  "idempotencyKey": "douyin-read-state-20260814-001",
  "params": {}
}
```

交互式动作还必须设置合适的用途和最近 30 分钟内的 `operatorConfirmedAt`。服务端与 Local Agent 都会重新校验。

### 查询命令

- `GET /api/browser-control/commands?platformCode=douyin&status=QUEUED`
- `GET /api/browser-control/commands/:id`

## 9. 状态、幂等与恢复

- 命令状态：`QUEUED`、`RUNNING`、`SUCCESS`、`FAILED`、`NEEDS_CONFIRMATION`、`CANCELLED`。
- `idempotencyKey` 在 `browser_commands` 中唯一；完全相同的重复请求返回原命令，不同命令复用同一键时返回 `BROWSER_IDEMPOTENCY_CONFLICT`。
- session 固定绑定设备、平台、账号和 Provider。
- 只读命令在进程重启或租约过期后可以安全重新排队。
- `CLICK`、`CLICK_AT`、`SET_FILES` 在中断后不能自动重试，进入 `NEEDS_CONFIRMATION`。
- 平台停止时，Local Agent 关闭该平台的受管标签页并停止对应 Provider 上下文。

审计表：

- `browser_sessions`：session 与受管标签页状态；
- `browser_commands`：命令、参数、结果、证据和幂等键；
- `browser_command_events`：创建、领取、延后、完成和恢复事件。

## 10. 关闭与回退

立即关闭新体系：

```env
BROWSER_CONTROL_ENABLED=false
BROWSER_CONTROL_ENABLED_PLATFORMS=
BROWSER_CONTROL_INTERACTIVE_ENABLED=false
BROWSER_CONTROL_RISK_ACKNOWLEDGED=false
```

然后重启 Web 与 Local Agent。原有 `PUBLISH`、`REPLY`、`VERIFY_PUBLISH` 和五平台 Playwright 适配器不受影响。

如果 web-access CDP 不稳定，可在单条命令中显式选择 `provider: "playwright"`；不要实现自动静默切换。

## 11. 验证

定向测试：

```powershell
node --test test/browser-control.test.js
```

完整回归：

```powershell
npm.cmd test
```

测试覆盖策略拦截、session 复用、非幂等失败、默认关闭、云端创建/领取/完成闭环、Agent 能力上报、数据库迁移和重启恢复。
