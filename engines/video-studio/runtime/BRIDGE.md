# Embedded Codex runtime

`CodexBridge` wraps `codex app-server` through its official stdio JSON-RPC protocol. Each conversation has its own writable workspace and a persisted Codex thread; later messages use `thread/resume`. It does not expose a shell endpoint or accept arbitrary CLI arguments. An optional `transport: 'exec'` compatibility adapter uses the CLI JSONL interface.

The bridge emits normalized `status`, `thread`, `message`, `activity`, `usage`, `error`, and `done` events. Only visible assistant messages and tool summaries are forwarded. Internal reasoning and raw MCP results are not exposed. `subscribe(id, callback, {after})` replays up to 500 saved events for reconnecting SSE clients.

## Server interface

```js
import { CodexBridge } from './runtime/codex-bridge.mjs';
const bridge = new CodexBridge();
await bridge.status();
const session = bridge.createSession({skillIds:['chatcut-source-pack-01']});
bridge.subscribe(session.id, event => {/* write SSE */});
await bridge.send(session.id, {message:'先设计15秒课程短片分镜', assetContext:{assets:[]}});
bridge.getSession(session.id);
bridge.cancel(session.id);
```

Use authentication and CSRF/same-origin checks in the HTTP host before exposing these operations. Bind a local-only deployment to loopback. A deployed server executes CLI tools on its own filesystem; a remote user's local paths are not accessible without a separate local agent or upload.

## Configuration

Install dependencies with `npm install --prefix runtime`. Install `@openai/codex` in the project or place `codex` on PATH; `CODEX_BIN` can select a binary. On the original machine the bridge can reuse the configured relay from `~/.codex/config.toml`. For another deployment set these server-side environment variables:

- `VIDEO_RELAY_API_KEY`: relay credential.
- `VIDEO_RELAY_BASE_URL`: Responses-compatible relay root, such as `https://example.com/v1`.
- `VIDEO_RELAY_MODEL`: the relay's actual available model identifier.

No credential is passed on the command line, returned in status, or included in the generated Codex config. The key is injected only into the child environment. Codex state and conversation records live under `runtime/private/` and must remain ignored by Git. Do not publish this directory.

Project Skills belong under `.agents/skills`. The six source packs and renderer capability Skills should be shipped in Git. Each run explicitly receives the selected Skills and registered asset context. Original media is not moved by the bridge. The default child policy is `workspace-write` with approval policy `never`; operations requiring escalation fail rather than disabling the sandbox.

## ChatCut

The isolated runtime registers the official ChatCut HTTP MCP with its `x-chatcut-mcp-surface: codex` header. Existing system-keychain OAuth may be reusable; a new deployment still needs its own ChatCut authorization. Each native thread is explicitly warmed with `mcpServerStatus/list` before `turn/start`; this is necessary in the tested CLI for tools to appear in the model session. Do not claim registration is a successful authenticated connection. `status().chatcut.state` is `configured` until a real CLI MCP startup/tool result is seen, and becomes `needs_authorization` on an observed auth failure. Authorize the isolated runtime using:

```sh
CODEX_HOME=/absolute/workbench/runtime/private/codex-home codex mcp login chatcut
```

This must run on the server machine. A ChatGPT subscription or company model-relay key does not grant ChatCut access. ChatCut's media import transfers bytes to its hosted service; preserve its Skill instructions. Remotion and Hyperframe are local tools/Skills and should be tested independently of ChatCut authentication.

## Integration notes

Official OpenAI app-server documentation: <https://developers.openai.com/codex/app-server>. User-visible assistant messages arrive when the assistant item completes; tool activity is emitted as it happens. Sessions survive service restarts; in-flight runs are marked interrupted on the next startup. Interactive approval and MCP elicitation requests are not auto-approved; the host rejects them with a message directing the user to complete authorization locally.
