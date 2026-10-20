# Mini Program Conversation Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Node.js 后端中增加一个只接收文字的小程序对话渠道，可靠复用正式 RAG 和企微转人工能力，并通过签名回调返回 AI 回复；后台新增只读对话工作台，不提供人工回复输入。

**Architecture:** 小程序通过独立的 HMAC 开放入口写入现有 `messages` / `conversations`，同时创建持久化 Processing Job。共享消息处理器继续负责路由、RAG、澄清和转人工决策，但回复分发按渠道拆分：五个平台继续创建 Local Agent `REPLY` Job，小程序只写 Callback Outbox。企微明确成功后更新会话终态和用户历史人工标记；同一会话的处理、回调与后台转人工使用现有会话串行锁。

**Tech Stack:** Node.js 24 ESM、`node:http`、`node:sqlite`、原生 `fetch` / `AbortSignal.timeout`、浏览器端原生 JavaScript/CSS、Node test runner、Playwright Core。

**Spec:** [docs/superpowers/specs/2026-09-05-mini-program-conversation-channel-design.md](../specs/2026-09-05-mini-program-conversation-channel-design.md)

## Global Constraints

- `mini_program` 是服务端消息渠道，绝不能加入 `config.activePlatformCodes`、`config.supportedPlatformCodes`、Agent allowlist、Local Agent Worker、浏览器 Profile、发布目标或平台登录状态检查。
- V1 只接收一个环境变量配置的 `appId`，只接收文字；没有图片、文件、语音、富文本和人工回复接口。
- 入站接口必须在消息和 Processing Job 同一事务提交后才返回 `202`；RAG、企微和回复回调不得阻塞入站请求。
- HMAC 必须基于原始请求字节；不得对解析后的 JSON 重新序列化后验签。
- 同一个 `appId + messageId` 只能产生一份消息、一次处理和一次对外副作用。
- `HANDOFF_PENDING` 继续保存新文字但不创建处理任务；`HUMAN_MANAGED` 只返回接收确认，不保存正文。
- 企微没有明确成功回执时，不能写入用户历史人工标记，也不能把会话显示为转人工完成。
- 所有未发送的小程序 Callback 在转人工时取消；不得向小程序发送“已转人工”自动回复。
- 管理 API 不返回共享密钥、完整签名或完整回调响应；日志不记录用户正文或完整回调载荷。
- 正式 RAG V1 合同只接受 `DOUYIN / WEIBO / BILIBILI / WECHAT_CHANNELS`。本期保持合同兼容，让 `mini_program` 沿用现有 `DOUYIN` 兼容枚举；真实渠道仍由本地 `messages.platform_code` 和 `context_json.transport` 记录，知识范围继续固定为统一正式库。不要单方面发送 RAG 尚未支持的 `MINI_PROGRAM` 枚举。
- 当前工作树已有用户改动：`public/app.js`、`public/styles.css`、`src/server.js`、`start-mvp.ps1`、`stop-mvp.ps1`、`test/rag-admin-proxy.test.js`。实施时逐处合并，禁止覆盖或回退这些改动。
- 下文的提交命令只可在确认暂存区不含任务开始前的用户改动时执行。若无法可靠分离同一文件中的既有改动，应跳过该任务的提交，保留工作树并在最终交付中说明，不能把不相关用户改动一起提交。

---

## Task 1: Add Configuration, Channel Identity, and Durable Schema

**Files:**

- Create: `test/mini-program-schema.test.js`
- Modify: `src/config.js`
- Modify: `src/db.js`
- Modify: `.env.example`
- Modify: `package.json`

- [ ] **Step 1: Write the failing schema/config test**

```js
// test/mini-program-schema.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-program-schema-'));
process.env.DATABASE_PATH = path.join(dir, 'schema.db');
process.env.INSTANCE_LOCK_ENABLED = 'false';
process.env.MINI_PROGRAM_API_ENABLED = 'true';
process.env.MINI_PROGRAM_APP_ID = 'app-test-001';
process.env.MINI_PROGRAM_SHARED_SECRET = 'a'.repeat(32);

const { config } = await import('../src/config.js');
const { db, row } = await import('../src/db.js');

test('小程序配置不污染五平台运行列表', () => {
  assert.equal(config.miniProgramApiEnabled, true);
  assert.equal(config.miniProgramAppId, 'app-test-001');
  assert.equal(config.activePlatformCodes.includes('mini_program'), false);
  assert.equal(config.supportedPlatformCodes.includes('mini_program'), false);
});

test('迁移创建四张持久表并种下隐藏渠道账号', () => {
  for (const name of [
    'mini_program_users',
    'mini_program_request_nonces',
    'mini_program_processing_jobs',
    'mini_program_callback_outbox'
  ]) assert.ok(row("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name));
  assert.ok(row("SELECT code FROM platforms WHERE code='mini_program'"));
  const account = row("SELECT id,login_status FROM accounts WHERE platform_code='mini_program' AND profile_name='mini-program-api-main'");
  assert.ok(account);
  assert.equal(account.login_status, 'NOT_REQUIRED');
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Register the test and prove it fails**

Append `test/mini-program-schema.test.js` to the explicit `npm test` command in `package.json`, then run:

```powershell
node --test test/mini-program-schema.test.js
```

Expected: FAIL because the config keys and tables do not exist.

- [ ] **Step 3: Add bounded environment configuration**

Add these fields near the RAG/WeCom settings in `src/config.js`:

```js
miniProgramApiEnabled: booleanEnv('MINI_PROGRAM_API_ENABLED', false),
miniProgramAppId: String(process.env.MINI_PROGRAM_APP_ID || '').trim(),
miniProgramSharedSecret: String(process.env.MINI_PROGRAM_SHARED_SECRET || ''),
miniProgramCallbackUrl: String(process.env.MINI_PROGRAM_CALLBACK_URL || '').trim(),
miniProgramCallbackTimeoutMs: Math.max(1_000, Math.min(30_000, numberEnv('MINI_PROGRAM_CALLBACK_TIMEOUT_MS', 12_000))),
```

Do not alter either five-platform array.

- [ ] **Step 4: Add an isolated incremental migration**

Create `migrateMiniProgramChannel()` in `src/db.js`, call it after `migrateSchema()` and before `seed()`, and use migration id `2026-09-05-mini-program-channel-v1`. Its transaction must create exactly these durable structures and indexes:

```sql
CREATE TABLE IF NOT EXISTS mini_program_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  external_user_id TEXT NOT NULL,
  first_handoff_at TEXT,
  last_handoff_at TEXT,
  last_conversation_id INTEGER REFERENCES conversations(id),
  handoff_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, external_user_id)
);
CREATE TABLE IF NOT EXISTS mini_program_request_nonces (
  app_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(app_id, nonce)
);
CREATE TABLE IF NOT EXISTS mini_program_processing_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  lease_expires_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS mini_program_callback_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  app_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  available_at TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  last_attempt_at TEXT,
  http_status INTEGER,
  response_excerpt TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mini_program_users_history
  ON mini_program_users(account_id, external_user_id, first_handoff_at);
CREATE INDEX IF NOT EXISTS idx_mini_program_nonce_expiry
  ON mini_program_request_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_mini_program_processing_claim
  ON mini_program_processing_jobs(status, available_at, lease_expires_at, id);
CREATE INDEX IF NOT EXISTS idx_mini_program_callback_claim
  ON mini_program_callback_outbox(status, available_at, lease_expires_at, conversation_id, id);
```

Use the existing `schema_migrations`, `BEGIN IMMEDIATE`, rollback and `now()` conventions. Do not store the shared secret.

- [ ] **Step 5: Seed a database identity without exposing it to runtime platform APIs**

Add `['mini_program', '小程序', 6]` to the platform seed and add one account:

```js
['mini_program', '小程序服务端', 'mini-program-api-main', 'NOT_REQUIRED']
```

The account may reference the existing required `device-rpa-01` foreign key, but it remains absent from `getAccounts()` because that query uses `supportedPlatformCodes`. It must never use `READY`: the current automatic collector scans enabled `READY` accounts before applying any platform-specific workflow, so `NOT_REQUIRED` is a defense against accidental RPA collection. Add assertions for this status and that neither runtime platform array contains `mini_program`.

- [ ] **Step 6: Document environment defaults**

Add to `.env.example`:

```dotenv
# 小程序服务端文字消息接口，默认关闭。共享密钥至少使用 32 个随机字符。
MINI_PROGRAM_API_ENABLED=false
MINI_PROGRAM_APP_ID=
MINI_PROGRAM_SHARED_SECRET=
MINI_PROGRAM_CALLBACK_URL=
MINI_PROGRAM_CALLBACK_TIMEOUT_MS=12000
```

- [ ] **Step 7: Run the focused test and commit**

```powershell
node --test test/mini-program-schema.test.js
git add src/config.js src/db.js .env.example package.json test/mini-program-schema.test.js
git commit -m "feat: add mini program channel schema"
```

Expected: PASS; commit contains no `.env`, database, log, screenshot, or pre-existing unrelated edits.

---

## Task 2: Implement Raw-Body HMAC Authentication and Validation

**Files:**

- Create: `src/services/mini-program-auth.js`
- Create: `test/mini-program-auth.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for canonical signing**

Cover a deterministic fixture, raw-body sensitivity, constant-time signature comparison, unknown app, malformed signature, timestamp outside `+-300` seconds, duplicate persistent nonce, 32 KiB body limit, exact six-field body, ISO timestamp, ID lengths and Unicode text length.

Use this canonical fixture in the test:

```js
const rawBody = Buffer.from('{"appId":"app-1","conversationId":"c-1","messageId":"m-1","userId":"u-1","text":"你好","sentAt":"2026-09-05T01:00:00.000Z"}');
const canonical = [
  'POST',
  '/open-api/v1/mini-program/messages',
  '1788570000',
  'nonce-0000000001',
  crypto.createHash('sha256').update(rawBody).digest('hex')
].join('\n');
const expected = crypto.createHmac('sha256', 'shared-secret-32-characters-long!').update(canonical).digest('hex');
```

Verify that adding one raw whitespace byte invalidates the previous signature, and that consuming the same nonce after reopening the SQLite-backed module still yields `MINI_PROGRAM_NONCE_REPLAY`.

- [ ] **Step 2: Run the tests to prove RED**

```powershell
node --test test/mini-program-auth.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement a small authentication API**

Export these constants/functions from `src/services/mini-program-auth.js`:

```js
export const MINI_PROGRAM_MESSAGE_PATH = '/open-api/v1/mini-program/messages';
export const MINI_PROGRAM_BODY_MAX_BYTES = 32 * 1024;
export const MINI_PROGRAM_CLOCK_SKEW_SECONDS = 300;
export const MINI_PROGRAM_NONCE_TTL_MS = 10 * 60_000;

export function buildMiniProgramCanonicalRequest({ method, pathname, timestamp, nonce, rawBody }) {}
export function signMiniProgramRequest({ method, pathname, timestamp, nonce, rawBody, secret }) {}
export function verifyMiniProgramSignature({ method, pathname, headers, rawBody, appId, secret, nowMs = Date.now() }) {}
export function consumeMiniProgramNonce({ appId, nonce, nowMs = Date.now() }) {}
export function cleanupExpiredMiniProgramNonces(nowIso = new Date().toISOString()) {}
export function startMiniProgramNonceCleanupWorker({ intervalMs = 60_000 } = {}) {}
export function stopMiniProgramNonceCleanupWorker() {}
export function validateMiniProgramMessagePayload(value) {}
export function validateMiniProgramCallbackUrl(value) {}
```

Implementation requirements:

- Hash the exact `Buffer` received from the socket.
- Validate the supplied signature with `crypto.timingSafeEqual` only after verifying both buffers are 32 bytes.
- Verify app, timestamp and signature before inserting the nonce.
- Use `INSERT` into `mini_program_request_nonces`; translate its unique violation to HTTP `401` / `MINI_PROGRAM_NONCE_REPLAY`.
- Delete only `expires_at <= now` records; never log nonce or signature values.
- Restrict request keys to `appId`, `conversationId`, `messageId`, `userId`, `text`, `sentAt`; reject attachment or message-type fields.
- Require all six values to be strings; require body/header/config `appId` equality, `conversationId` / `messageId` / `userId` lengths of 1-128 Unicode characters, `text` length of 1-2,000 Unicode characters, and a finite ISO-8601 `sentAt`.
- Normalize IDs and text with `trim()` and NFC; count Unicode with `Array.from(value).length`.
- Bound authentication headers before cryptographic work: timestamp must be Unix-second digits, nonce 1-128 characters, app ID 1-128 characters, and signature exactly 64 lowercase hexadecimal characters. Treat an enabled configuration with an app ID outside that bound or a shared secret shorter than 32 characters as incomplete.
- Accept callback URLs using HTTPS, plus HTTP only for `localhost`, `127.0.0.1` or `[::1]`; reject credentials, query strings and fragments.
- Throw errors with `statusCode`, stable `code`, safe Chinese `message`, and no secret-bearing detail.

- [ ] **Step 4: Add the test to the suite and prove GREEN**

```powershell
node --test test/mini-program-auth.test.js
git add src/services/mini-program-auth.js test/mini-program-auth.test.js package.json
git commit -m "feat: authenticate mini program requests"
```

Expected: all auth and validation cases PASS.

---

## Task 3: Persist Inbound Messages with Idempotency and Handoff Short-Circuits

**Files:**

- Create: `src/services/mini-program-channel.js`
- Create: `test/mini-program-channel.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the ingestion state-machine tests**

Build fixtures against a temporary database and cover these exact assertions:

```js
const first = ingestMiniProgramMessage(payload);
assert.deepEqual(first, { accepted: true, messageId: 'm-1', status: 'ACCEPTED', duplicate: false });
assert.equal(row("SELECT COUNT(*) AS count FROM messages WHERE external_id='mini-program:app-1:message:m-1'").count, 1);
assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 1);
assert.equal(row("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY'").count, 0);

const duplicate = ingestMiniProgramMessage(payload);
assert.equal(duplicate.status, 'ACCEPTED');
assert.equal(duplicate.duplicate, true);
assert.equal(row('SELECT COUNT(*) AS count FROM mini_program_processing_jobs').count, 1);
```

Also prove:

- An existing `appId + conversationId` bound to another `userId` throws `409 CONVERSATION_USER_MISMATCH`, even if that conversation is already `HUMAN_MANAGED`.
- A `HANDOFF_PENDING` conversation stores the new text and increments conversation version but creates no Processing Job or notification.
- A `HUMAN_MANAGED` conversation returns `IGNORED_HANDOFF_COMPLETED` and does not increase `messages` count.
- A user with `first_handoff_at` set and a new `conversationId` stores only the first message, immediately enters `HANDOFF_PENDING`, and creates one idempotent WeCom notification containing `历史人工用户再次咨询`.

- [ ] **Step 2: Run the focused test to prove RED**

```powershell
node --test test/mini-program-channel.test.js
```

Expected: FAIL because the channel service does not exist.

- [ ] **Step 3: Implement a single transactional ingress boundary**

Export:

```js
export const MINI_PROGRAM_PLATFORM_CODE = 'mini_program';
export function miniProgramAccount() {}
export function ingestMiniProgramMessage(payload) {}
export function miniProgramContext(message) {}
export function requestMiniProgramHandoff(input) {}
```

Inside one `immediateTransaction()` execute this fixed order:

1. Resolve the hidden `mini-program-api-main` account.
2. Look up `messages.external_id = mini-program:{appId}:message:{messageId}` and return its original accepted result.
3. Look up `conversations.namespace = mini-program:{appId}:{conversationId}`.
4. If found, compare `conversation.user_name` to `userId`; reject a mismatch.
5. If its mode is `HUMAN_MANAGED`, return `IGNORED_HANDOFF_COMPLETED` before inserting any message.
6. Insert/upsert `mini_program_users` without setting handoff timestamps.
7. Create the conversation if absent; use `user_name = userId`, `external_conversation_key = conversationId`, high-confidence context and `BOT_ACTIVE`.
8. Insert the message with `message_type='PRIVATE_MESSAGE'`, normalized external id, and verified transport context.
9. Atomically increment conversation `version` / `ledger_version`, set `last_incoming_message_id`, then copy the resulting version to the message.
10. If already `HANDOFF_PENDING`, stop after persistence.
11. If this is a new conversation for a historical user, call the transaction-safe handoff helper and enqueue one WeCom record.
12. Otherwise insert one `mini_program_processing_jobs` row.

Store this context shape so shared identity and eligibility code receive stable evidence:

```js
{
  transport: 'MINI_PROGRAM',
  appId,
  conversationId,
  conversationKey: `mini-program:${appId}:${conversationId}`,
  messageId,
  platformMessageId: messageId,
  userId,
  sentAt,
  direction: 'incoming',
  sourceVerified: true,
  serverSignatureVerified: true,
  fullSource: true,
  previewOnly: false,
  chatTitleVerified: true,
  candidateCount: 1
}
```

`requestMiniProgramHandoff()` must use the deterministic notification key `wecom:mini-program:handoff:conversation:{conversationId}` and metadata:

```js
{
  handoff: true,
  reason,
  miniProgram: { appId, userId, accountId, conversationId }
}
```

- [ ] **Step 4: Prove all ingress branches GREEN and commit**

```powershell
node --test test/mini-program-channel.test.js test/mini-program-schema.test.js
git add src/services/mini-program-channel.js test/mini-program-channel.test.js package.json
git commit -m "feat: persist mini program conversations"
```

Expected: all state-machine and idempotency assertions PASS.

---

## Task 4: Add the Signed Reply Callback Outbox

**Files:**

- Create: `src/services/mini-program-callback.js`
- Create: `test/mini-program-callback.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing callback/outbox tests**

Use a local `node:http` receiver. Capture raw bytes and headers, recompute the HMAC with `signMiniProgramRequest()`, and assert:

- The callback payload contains stable `eventId`, `type='assistant.message'`, app/conversation/user IDs, source message ID, text and creation time.
- Any `2xx`, including `204`, marks Outbox `SENT` and message `AUTO_REPLIED`.
- Timeout, thrown network error and non-`2xx` move to `RETRY_WAIT` with sanitized error text.
- Retry delays are exactly `5s, 30s, 2m, 10m, 1h, 6h, 6h, 6h, 6h` across ten total attempts.
- Attempt 10 becomes `FAILED` and remains queryable.
- After a manual requeue extends `max_attempts`, any later automatic retry keeps using the final `6h` delay rather than indexing past the delay table.
- Missing callback URL becomes `NOT_CONFIGURED` without deleting payload or reply text.
- An earlier unsent callback blocks a later callback from the same conversation.
- `HANDOFF_PENDING` cancels a claimed-but-not-yet-sent callback.
- Re-enqueueing the same source message returns the same Outbox row and event id.

- [ ] **Step 2: Run the test to prove RED**

```powershell
node --test test/mini-program-callback.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement durable callback creation and claiming**

Export:

```js
export const MINI_PROGRAM_CALLBACK_RETRY_DELAYS_MS = Object.freeze([
  5_000, 30_000, 120_000, 600_000, 3_600_000,
  21_600_000, 21_600_000, 21_600_000, 21_600_000
]);
export function enqueueMiniProgramReply({ message, replyText, createdAt }) {}
export function claimMiniProgramCallback({ leaseMs = 30_000 } = {}) {}
export async function deliverMiniProgramCallback(callbackOrId, { fetchImpl = globalThis.fetch } = {}) {}
export async function processMiniProgramCallbackOnce(options = {}) {}
export function requeueMiniProgramCallback(id) {}
export function startMiniProgramCallbackWorker(options = {}) {}
export function stopMiniProgramCallbackWorker() {}
```

The claim transaction must first recover expired `SENDING` leases. Its candidate SQL must exclude any row whose conversation has an earlier callback not in `SENT` or `CANCELLED`. Increment `attempt_count` only when a row becomes `SENDING`.

- [ ] **Step 4: Implement signed delivery under the conversation lock**

Wrap the final state check and HTTP request in:

```js
return withConversationSerial(callback.conversation_id, async () => {
  const conversation = row('SELECT handling_mode FROM conversations WHERE id=?', callback.conversation_id);
  if (conversationHandlingMode(conversation) !== 'BOT_ACTIVE') {
    return cancelMiniProgramCallback(callback.id, 'CONVERSATION_HANDOFF');
  }
  const rawBody = Buffer.from(callback.payload_json, 'utf8');
  const target = validateMiniProgramCallbackUrl(config.miniProgramCallbackUrl);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const signature = signMiniProgramRequest({
    method: 'POST', pathname: target.pathname, timestamp, nonce,
    rawBody, secret: config.miniProgramSharedSecret
  });
  return fetchImpl(target.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mini-App-Id': config.miniProgramAppId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': signature
    },
    body: rawBody,
    signal: AbortSignal.timeout(config.miniProgramCallbackTimeoutMs)
  });
});
```

Read the response through a capped stream reader, cancel after 8 KiB, and persist at most 1,000 characters into `response_excerpt`. Never log the payload, signature or response body, and treat every status from 200 through 299 as accepted.

- [ ] **Step 5: Implement deterministic manual retry**

`requeueMiniProgramCallback(id)` only accepts `FAILED` or `NOT_CONFIGURED`, preserves `attempt_count`, sets `max_attempts = max(max_attempts, attempt_count + 10)`, clears the lease/error fields, and makes the row immediately available. Its delay lookup must clamp to the last `6h` entry for attempts beyond the original table. It must reject `SENT`, `SENDING`, `PENDING` and `RETRY_WAIT` with `409 MINI_PROGRAM_CALLBACK_NOT_RETRYABLE`.

- [ ] **Step 6: Prove callback behavior GREEN and commit**

```powershell
node --test test/mini-program-callback.test.js
git add src/services/mini-program-callback.js test/mini-program-callback.test.js package.json
git commit -m "feat: deliver mini program replies reliably"
```

Expected: signatures verify, ordering holds, and all delivery states PASS.

---

## Task 5: Make the Shared Message Processor Channel-Aware

**Files:**

- Modify: `src/services/auto-reply-eligibility.js`
- Modify: `src/services/manual-notification.js`
- Modify: `src/server.js`
- Modify: `test/formal-rag-routing.test.js`
- Create: `test/mini-program-reply-dispatch.test.js`
- Create: `test/mini-program-isolation.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing eligibility and dispatch tests**

Add a unit case proving a signed server message is eligible without DOM/RPA fields:

```js
const result = assessAutoReplyEligibility({
  platformCode: 'mini_program',
  accountId: 6,
  messageType: 'PRIVATE_MESSAGE',
  sourceContent: '办理业务需要什么材料？',
  userName: 'user-001',
  messageContext: {
    appId: 'app-1', conversationId: 'c-1', messageId: 'm-1', userId: 'user-001',
    direction: 'incoming', serverSignatureVerified: true
  }
});
assert.equal(result.allowed, true);
assert.equal(result.target.kind, 'SERVER_CALLBACK');
```

In `test/mini-program-reply-dispatch.test.js`, seed a mini-program message and call an exported test boundary for reply queueing. Assert one Callback Outbox row, `messages.reply_job_id IS NULL`, and zero Local Agent `REPLY` jobs.

- [ ] **Step 2: Run the tests to prove RED**

```powershell
node --test test/mini-program-reply-dispatch.test.js test/formal-rag-routing.test.js
```

Expected: signed mini-program eligibility/dispatch assertions FAIL.

- [ ] **Step 3: Add the trusted server-channel eligibility branch**

Before DOM-specific private-message checks, require all four stable identifiers and verified signature evidence:

```js
if (platformCode === 'mini_program') {
  const appId = first(context.appId);
  const conversationId = first(context.conversationId);
  const messageId = first(context.messageId);
  const userId = first(context.userId);
  if (!truthy(context.serverSignatureVerified)) return denied('SERVER_SIGNATURE_NOT_VERIFIED', { phase });
  if (!appId || !conversationId || !messageId || !userId) return denied('SERVER_MESSAGE_IDENTITY_REQUIRED', { phase });
  if (clean(context.direction).toLowerCase() !== 'incoming') return denied('INCOMING_DIRECTION_REQUIRED', { phase });
  return allowed({ kind: 'SERVER_CALLBACK', platformCode, accountId, appId, conversationId, messageId, userId }, { phase });
}
```

- [ ] **Step 4: Dispatch mini-program replies before Local Agent job creation**

In `queueStaticReply()` keep common conversation-current, eligibility and length checks, then branch before `createJob()`:

```js
if (message.platform_code === MINI_PROGRAM_PLATFORM_CODE) {
  const callback = enqueueMiniProgramReply({ message, replyText, createdAt: now() });
  run(`UPDATE messages SET status='REPLY_QUEUED',decision=?,confidence=?,reply_text=?,reason=?,knowledge_id=?,
      knowledge_question_snapshot=?,knowledge_answer_snapshot=?,manual_handoff_intent_id=?,response_mode=?,
      rule_version='mini-program-callback-2026.09.05.1',reply_job_id=NULL,updated_at=? WHERE id=?`,
    decision, confidence, replyText, reason, knowledge?.id || null, knowledge?.question || null,
    knowledge?.answer || null, handoffIntentId, responseMode, now(), message.id);
  return callback.id;
}
```

Do not send mini-program messages through reply batches or `createJob()`.

- [ ] **Step 5: Bypass only the five-platform smart-reply switch**

Change the shared processor condition to:

```js
if (message.platform_code !== MINI_PROGRAM_PLATFORM_CODE && !getPlatformSmartReply(message.platform_code).enabled) {
```

Do not add `mini_program` to `SMART_REPLY_PLATFORMS`; the new API-level switch is authoritative.

- [ ] **Step 6: Isolate the channel from legacy five-platform surfaces**

Add defense-in-depth checks in `src/server.js` and cover them in `test/mini-program-isolation.test.js`:

- Make `getMessages()` exclude `m.platform_code = 'mini_program'`, so the old “评论与私信” list does not mix in this server channel.
- Make both automatic account collection and automatic conversation-recovery collection select only `config.activePlatformCodes` in addition to `enabled=1` and `login_status='READY'`; the `NOT_REQUIRED` seed from Task 1 remains the second guard.
- Make `upsertCollectedMessage()` explicitly reject `data.platformCode === 'mini_program'` with stable code `MINI_PROGRAM_SIGNED_ENDPOINT_REQUIRED`, preventing Agent/simulation ingestion from bypassing HMAC verification while preserving current errors for every other unsupported code.
- Reject Local Agent login-state updates for the hidden mini-program account; it has no browser login lifecycle and must stay `NOT_REQUIRED`.
- Reject mini-program rows from generic `DELETE /api/messages/:id`, `/handled`, `/retry`, `/manual-reply`, and `/detect-manual` routes with `409 MINI_PROGRAM_DEDICATED_API_REQUIRED`. Keep the existing non-Weibo manual-reply rejection as a secondary check.

Prove a signed mini-program message is absent from `GET /api/messages`, cannot create an Agent job through collection/simulation/recovery, rejects an Agent login-state update, and cannot be mutated by any generic message action. Existing five-platform cases must remain unchanged.

- [ ] **Step 7: Preserve RAG V1 compatibility explicitly**

Add a formal routing test:

```js
const request = buildFormalRagRequest({
  message: { id: 1, platform_code: 'mini_program', account_id: 6, message_type: 'PRIVATE_MESSAGE', content: '测试' }
});
assert.equal(request.source.platform, 'DOUYIN');
assert.equal(request.source.channelType, 'DIRECT_MESSAGE');
assert.equal(validateFormalRagRequest(request).ok, true);
```

No implementation change is required in `formal-rag-routing.js` while its existing fallback produces this valid contract.

- [ ] **Step 8: Attach mini-program metadata to every handoff notification**

In `notifyManual()`, merge caller metadata instead of replacing it. For mini-program messages, derive `{ appId, userId, accountId, conversationId }` from verified context and force the per-conversation idempotency key. Update `manual-notification.js` so the platform fallback includes `mini_program: '小程序'` and the final instruction reads:

```text
请根据企业微信通知中的用户 ID 和会话 ID，在小程序客服系统中继续对接。
```

Do not tell an operator to return to this Web UI to reply or mark handled.

- [ ] **Step 9: Run focused tests and commit**

```powershell
node --test test/mini-program-reply-dispatch.test.js test/mini-program-isolation.test.js test/formal-rag-routing.test.js test/notification-outbox.test.js
git add src/services/auto-reply-eligibility.js src/services/manual-notification.js src/server.js test/formal-rag-routing.test.js test/mini-program-reply-dispatch.test.js test/mini-program-isolation.test.js package.json
git commit -m "feat: route mini program replies to callback"
```

Expected: mini-program replies create no Agent jobs, stay absent from the legacy message API, and reject generic message mutations; existing five-platform reply tests remain unchanged.

---

## Task 6: Add Processing Worker, Retry Exhaustion, and Confirmed User History

**Files:**

- Create: `src/services/mini-program-processing.js`
- Create: `src/services/mini-program-handoff-state.js`
- Modify: `src/services/mini-program-channel.js`
- Modify: `src/services/conversation-control.js`
- Modify: `src/services/notification.js`
- Modify: `src/server.js`
- Create: `test/mini-program-processing.test.js`
- Modify: `test/notification-outbox.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing worker/state tests**

Cover:

- Claiming `PENDING`, recovering expired `RUNNING`, and marking successful work `COMPLETED`.
- Attempt 1 failure schedules retry 1 at `+5s`; attempt 2 failure schedules retry 2 at `+30s`; attempt 3 failure schedules retry 3 at `+2m`; attempt 4 failure becomes `FAILED`, enters `HANDOFF_PENDING`, and enqueues one `消息处理技术异常` notification. `max_attempts=4` therefore means one initial execution plus three retries.
- A business handoff result counts as completed processing, not an infrastructure retry.
- Entering handoff cancels unsent callback rows along with Agent reply jobs and reply batches.
- WeCom failure leaves both conversation and user history pending.
- Mocked WeCom success changes conversation to `HUMAN_MANAGED` and atomically sets `first_handoff_at`, `last_handoff_at`, `last_conversation_id`, and increments `handoff_count` once.
- Re-delivering the same confirmed notification does not increment `handoff_count` twice.

- [ ] **Step 2: Run tests to prove RED**

```powershell
node --test test/mini-program-processing.test.js test/notification-outbox.test.js
```

Expected: processing module and history assertions FAIL.

- [ ] **Step 3: Implement lease-based processing**

Export:

```js
export const MINI_PROGRAM_PROCESSING_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000]);
export function claimMiniProgramProcessingJob({ leaseMs = 30_000 } = {}) {}
export async function processMiniProgramJobOnce({ processMessage }) {}
export function startMiniProgramProcessingWorker({ processMessage, intervalMs = 1_000 }) {}
export function stopMiniProgramProcessingWorker() {}
```

The worker receives `messageId => processMessageWithRegistry(messageId)` from `src/server.js`; this avoids importing the large server module. Claim/recovery and completion updates must be transactional. Store only a sanitized error code/message of at most 1,000 characters.

- [ ] **Step 4: Let unexpected mini-program processing errors reach the worker**

In the shared `catch` around knowledge/reply generation, keep the current five-platform behavior. For `mini_program`, record no user text in logs and rethrow so the Processing Job controls the three attempts. On exhaustion call `requestMiniProgramHandoff()` with reason `消息处理技术异常` and message type `MINI_PROGRAM_PROCESSING_FAILED`.

Formal RAG responses that explicitly return an unavailable/invalid result continue to use the existing immediate business handoff branch; they do not need three infrastructure attempts.

- [ ] **Step 5: Extend handoff cancellation atomically**

In `cancelConversationAutomation()` add:

```sql
UPDATE mini_program_callback_outbox
SET status='CANCELLED', error_message=?, claimed_at=NULL, lease_expires_at=NULL, available_at=NULL, updated_at=?
WHERE conversation_id=? AND status IN ('PENDING','RETRY_WAIT','NOT_CONFIGURED')
```

Return a `callbacks` count in addition to jobs/messages/batches. A row currently `SENDING` is protected by `withConversationSerial`; the handoff waits for that send to settle before changing mode.

- [ ] **Step 6: Mark user history only inside confirmed delivery**

Keep the database-only history mutation in `src/services/mini-program-handoff-state.js`; both the channel and notification modules may import it, while it must not import either module. This avoids an ESM cycle between channel notification creation and notification confirmation.

After `confirmConversationHandoff()` and still inside the existing `immediateTransaction()` in `deliverNotification()`, inspect `metadata.miniProgram`. If present, call:

```js
markMiniProgramHandoffConfirmed({
  appId: metadata.miniProgram.appId,
  userId: metadata.miniProgram.userId,
  accountId: metadata.miniProgram.accountId,
  conversationId: notification.conversation_id,
  confirmedAt: stamp,
  notificationId: notification.id
});
```

Guard the notification update with `WHERE status='SENDING'` and perform conversation/user confirmation only when that update changes exactly one row. Use `first_handoff_at = COALESCE(first_handoff_at, confirmedAt)`; this guarantees a stale duplicate delivery cannot increment `handoff_count` twice.

- [ ] **Step 7: Add generic notification requeue support**

Export `requeueNotification(id)` from `notification.js`. It may manually requeue only `FAILED` or `RETRY_WAIT`, must clear leases, make the row immediately available, and extend `max_attempts` to at least `attempt_count + 20`. Do not treat requeueing as confirmation.

- [ ] **Step 8: Run focused tests and commit**

```powershell
node --test test/mini-program-processing.test.js test/notification-outbox.test.js test/conversation-handoff-claim-guard.test.js
git add src/services/mini-program-processing.js src/services/mini-program-handoff-state.js src/services/mini-program-channel.js src/services/conversation-control.js src/services/notification.js src/server.js test/mini-program-processing.test.js test/notification-outbox.test.js package.json
git commit -m "feat: process mini program messages asynchronously"
```

Expected: retry, cancellation and confirmed-history tests PASS.

---

## Task 7: Expose the Exact Signed Open Endpoint and Wire Worker Lifecycle

**Files:**

- Create: `src/services/mini-program-http.js`
- Modify: `src/server.js`
- Create: `test/mini-program-open-api.test.js`
- Modify: `test/security-runtime.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing HTTP contract tests**

Start the real server through `test/helpers/runtime.js` with mini-program env enabled. Add a helper that signs the exact `Buffer`, then prove:

- Correct request returns `202 { ok:true, accepted:true, messageId, status:'ACCEPTED' }` quickly.
- Same message with a fresh nonce returns the same result and creates one row.
- Same nonce returns `401 MINI_PROGRAM_NONCE_REPLAY`.
- Wrong signature/app, stale timestamp and missing headers return `401` and write no message.
- Invalid JSON/fields/text/sentAt return `400`; non-JSON returns `415`; body over 32 KiB returns `413`.
- Conversation/user mismatch returns `409 CONVERSATION_USER_MISMATCH`.
- Disabled or incomplete server configuration returns `503`.
- `/api/mini-program/status` still requires admin login while the signed open path does not accept an admin cookie as a substitute for HMAC.

- [ ] **Step 2: Run the tests to prove RED**

```powershell
node --test test/mini-program-open-api.test.js test/security-runtime.test.js
```

Expected: open endpoint returns static/404 behavior instead of the required contract.

- [ ] **Step 3: Implement a raw request reader and handler**

`handleMiniProgramOpenMessage(req)` must:

1. Require `POST` and exact path.
2. Fail `503` if the API is disabled or app/secret are incomplete.
3. Require JSON content type.
4. Read at most 32 KiB into a `Buffer`.
5. Verify HMAC/timestamp/app headers against the raw bytes.
6. Consume the nonce.
7. Parse JSON once and validate the six fields.
8. Require body `appId` to equal both header and configuration.
9. Call `ingestMiniProgramMessage()`.
10. Translate SQLite busy/locked to `503 MINI_PROGRAM_TEMPORARILY_UNAVAILABLE`.

Return `{ statusCode: 202, body: { ok: true, ...result } }`; let the server's existing safe error formatter handle known errors.

- [ ] **Step 4: Route only the exact public path**

In the `http.createServer` callback, after URL parsing and before `/api/*` routing:

```js
if (url.pathname === MINI_PROGRAM_MESSAGE_PATH) {
  const result = await handleMiniProgramOpenMessage(req, url);
  return send(res, result.statusCode, result.body);
}
```

Add `X-Mini-App-Id, X-Timestamp, X-Nonce, X-Signature` to allowed headers, but do not create wildcard `/open-api/*` routing.

- [ ] **Step 5: Start and stop workers independently of Local Agent**

At server startup:

```js
startMiniProgramProcessingWorker({ processMessage: processMessageWithRegistry });
startMiniProgramCallbackWorker();
startMiniProgramNonceCleanupWorker();
```

At shutdown stop all three before closing the HTTP server. Workers should drain existing durable work even when the inbound API switch is off; the switch gates only new public intake.

- [ ] **Step 6: Run HTTP/security tests and commit**

```powershell
node --test test/mini-program-open-api.test.js test/security-runtime.test.js
git add src/services/mini-program-http.js src/server.js test/mini-program-open-api.test.js test/security-runtime.test.js package.json
git commit -m "feat: expose signed mini program message endpoint"
```

Expected: exact signed endpoint passes; all management endpoints remain session protected.

---

## Task 8: Add Authenticated Management Queries and Actions

**Files:**

- Create: `src/services/mini-program-admin.js`
- Modify: `src/server.js`
- Create: `test/mini-program-admin-api.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing admin API tests**

Seed normal, callback-failed, handoff-pending and terminated conversations. Verify:

- `GET /api/mini-program/status` returns booleans for API/app/secret/callback configuration, last receipt time and queue counts, but never values for the secret or signature.
- `GET /api/mini-program/conversations?status=...` returns only mini-program conversations, normalized external IDs, a short latest-text preview and historical-user flag.
- `GET /api/mini-program/conversations/:id/messages` returns stored inbound text, AI reply, decision, knowledge id/question snapshot, callback status/error and WeCom status/error.
- `POST /api/mini-program/conversations/:id/handoff` requires a bounded idempotency key, works only from `BOT_ACTIVE`, and repeated calls return the same notification.
- Notification/callback retry endpoints reject records owned by another platform/conversation.
- There is no route accepting an artificial reply body.

- [ ] **Step 2: Run the test to prove RED**

```powershell
node --test test/mini-program-admin-api.test.js
```

Expected: all six endpoints return not found.

- [ ] **Step 3: Implement normalized read models**

Export:

```js
export function getMiniProgramStatus() {}
export function listMiniProgramConversations({ status = 'ALL', limit = 200 }) {}
export function getMiniProgramConversationMessages(conversationId) {}
export async function handoffMiniProgramConversation({ conversationId, idempotencyKey }) {}
export function retryMiniProgramNotification({ notificationId }) {}
export function retryMiniProgramCallback({ callbackId }) {}
```

Filter mapping:

```js
const FILTERS = Object.freeze({
  PROCESSING: ['PENDING', 'RUNNING', 'RETRY_WAIT'],
  CALLBACK_PENDING: ['PENDING', 'SENDING', 'RETRY_WAIT', 'NOT_CONFIGURED'],
  HANDOFF_PENDING: ['HANDOFF_PENDING'],
  HUMAN_MANAGED: ['HUMAN_MANAGED'],
  ERROR: ['FAILED']
});
```

Return previews capped at 120 Unicode characters. Parse JSON server-side and return only the named safe fields; do not return `payload_json`, request nonces, response JSON, secret config or full callback response excerpts.

- [ ] **Step 4: Serialize the manual handoff action**

Wrap the mode check, `beginConversationHandoff()` and notification enqueue with `withConversationSerial(conversationId, ...)`. Require the UI idempotency key to match `mini-program-handoff:{conversationId}` and persist the deterministic WeCom key from Task 3. A repeated call from pending/managed state returns the existing notification and current state without a second notification.

- [ ] **Step 5: Add routes after existing admin authentication**

Implement the six routes from the approved spec:

```text
GET  /api/mini-program/status
GET  /api/mini-program/conversations
GET  /api/mini-program/conversations/:id/messages
POST /api/mini-program/conversations/:id/handoff
POST /api/mini-program/notifications/:id/retry
POST /api/mini-program/callbacks/:id/retry
```

Use `404` for unknown IDs, `409` for invalid state, and `400` for malformed filter/idempotency input.

- [ ] **Step 6: Run focused tests and commit**

```powershell
node --test test/mini-program-admin-api.test.js test/security-runtime.test.js
git add src/services/mini-program-admin.js src/server.js test/mini-program-admin-api.test.js package.json
git commit -m "feat: add mini program management api"
```

Expected: management data is safe and actions are scoped/idempotent.

---

## Task 9: Verify End-to-End RAG, Callback, and Handoff Behavior

**Files:**

- Create: `test/mini-program-flow.integration.test.js`
- Modify: `package.json`

- [ ] **Step 1: Build isolated fake RAG and callback receivers**

The integration test starts:

- A fake RAG endpoint returning an `ANSWERED` result with the request snapshot echoed exactly.
- A fake mini-program callback endpoint that validates HMAC against raw bytes and records `eventId`.
- The real app server with an isolated SQLite database and the production Worker intervals; use bounded polling with a deadline instead of adding test-only production configuration.

- [ ] **Step 2: Prove normal question flow**

Send a signed business question and assert this sequence with bounded polling:

```text
HTTP 202 ACCEPTED
-> one stored message and one Processing Job
-> one formal RAG request
-> one Callback Outbox record
-> one signed callback accepted
-> message AUTO_REPLIED
-> zero agent_jobs REPLY rows
```

Assert the RAG knowledge base is `main-business-kb`, `source.channelType` is `DIRECT_MESSAGE`, and the callback's `inReplyToMessageId` is the external `messageId`.

- [ ] **Step 3: Prove clarification and explicit handoff flow**

Return `NO_ANSWER` three times for one conversation, capture three callback replies, then send `转人工`. Assert only the fourth message creates a WeCom notification, no “已转人工” callback is created, and subsequent messages while pending are stored without RAG/callback/new notification.

- [ ] **Step 4: Prove confirmed and historical-user flow**

Use `deliverNotification(notification, { fetchImpl })` with a mocked successful WeCom JSON response. Then assert:

- Same `conversationId` receives `IGNORED_HANDOFF_COMPLETED` and message count does not change.
- New `conversationId` for the same `userId` stores its first text, skips RAG, enters pending and creates one notification containing `历史人工用户再次咨询`.
- A different user can use their own conversation normally.

- [ ] **Step 5: Prove restart recovery and concurrency**

Stop the app with queued Processing/Callback rows, restart against the same database and assert they resume. Send parallel signed requests for the same `messageId` with distinct nonces and assert one message/job/callback. Send parallel first messages with one conversation and conflicting users; assert one succeeds and the other receives `409` without cross-user text storage.

- [ ] **Step 6: Run the integration test and commit**

```powershell
node --test test/mini-program-flow.integration.test.js
git add test/mini-program-flow.integration.test.js package.json
git commit -m "test: cover mini program channel end to end"
```

Expected: all intake, RAG, callback, handoff, history, restart and concurrency assertions PASS.

---

## Task 10: Build the Mini Program Conversation Page

**Files:**

- Modify: `public/app.js`
- Modify: `public/styles.css`
- Create: `test/mini-program-ui.test.js`
- Create: `scripts/verify-mini-program-ui.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing static UI contract tests**

Read `public/app.js` and assert:

- `小程序对话` appears after `评论与私信` and before `转人工记录`.
- `renderMiniProgramConversations` is registered in the page renderer map.
- It calls only the six authenticated management endpoints.
- It contains filters `全部 / AI 处理中 / 回复待发送 / 转人工通知中 / 已转人工 / 异常`.
- No mini-program page markup contains a reply textarea, reply input, `manual-reply`, or send-reply endpoint.
- Buttons exist for refresh, handoff, failed WeCom retry and failed callback retry.

- [ ] **Step 2: Run the static test to prove RED**

```powershell
node --test test/mini-program-ui.test.js
```

Expected: nav/page/render assertions FAIL.

- [ ] **Step 3: Add navigation and stable page state**

Insert this nav item between the two existing entries:

```js
['miniProgram','messages','小程序对话','查看小程序文字咨询、AI 回复、回调与转人工状态'],
```

Add state fields without replacing the user's existing state object:

```js
miniProgramFilter: 'ALL',
miniProgramConversationId: null,
```

Register `miniProgram: renderMiniProgramConversations` in `render()` and add status labels for `HANDOFF_PENDING`, `HUMAN_MANAGED`, `NOT_CONFIGURED`, `RETRY_WAIT`, `SENDING`, `ACCEPTED` and `IGNORED_HANDOFF_COMPLETED`.

- [ ] **Step 4: Implement the operational page**

Use one summary band followed by a two-column workbench:

- Top summary: API switch, app configured, callback configured, last received time, processing pending, callback pending, WeCom failures.
- Left: segmented status filters and conversation rows with user ID, conversation ID, last text, last activity, historical marker and state.
- Right: selected conversation header and chronologically ordered saved messages. For each row show inbound text, AI reply, knowledge hit identifier/question, callback status/error and WeCom status/error.
- Actions: icon+text refresh; `BOT_ACTIVE` handoff; failed notification retry; failed callback retry.
- Empty state: no messages or no selected conversation.

Do not add an artificial hero, nested cards, manual reply field, secret display, callback payload display or full RAG document content.

- [ ] **Step 5: Bind actions with deterministic behavior**

The handoff button posts:

```js
body: JSON.stringify({ idempotencyKey: `mini-program-handoff:${conversationId}` })
```

Disable an action while pending, show a toast on success/failure, then refresh status/list/detail without changing the selected row. Filter changes update `state.miniProgramFilter`; selecting a row updates `state.miniProgramConversationId`.

- [ ] **Step 6: Add responsive CSS**

Use `.mini-program-*` selectors only. Constrain the workbench with `grid-template-columns:minmax(280px,.75fr) minmax(420px,1.25fr)`, `min-width:0`, `overflow-wrap:anywhere`, fixed minimum toolbar/button heights, and an `@media(max-width:900px)` one-column layout. At mobile width, put filters/action buttons on new lines; do not let long IDs overlap status badges.

- [ ] **Step 7: Add browser verification script**

`scripts/verify-mini-program-ui.mjs` must start an isolated server, seed representative states through signed API requests plus direct test database setup, launch the configured Chrome executable, and capture:

```text
logs/smoke-tests/mini-program-desktop.png   (1440 x 1000)
logs/smoke-tests/mini-program-mobile.png    (390 x 844)
```

It must fail when:

```js
const metrics = await page.evaluate(() => ({
  bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  overlapping: [...document.querySelectorAll('.mini-program-workbench *')].some((a, index, all) =>
    all.slice(index + 1).some(b => {
      const x = a.getBoundingClientRect();
      const y = b.getBoundingClientRect();
      return a !== b && !a.contains(b) && !b.contains(a) && x.width && y.width && x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
    })
  )
}));
assert.equal(metrics.bodyOverflow, false);
```

Limit overlap checking to sibling text/action regions with a curated selector list so intentional containment does not create false failures.

- [ ] **Step 8: Run UI tests and inspect both screenshots**

```powershell
node --test test/mini-program-ui.test.js
node scripts/verify-mini-program-ui.mjs
```

Open both PNG files and verify nonblank rendering, readable long IDs, no overlap, stable actions, and that no reply input exists.

- [ ] **Step 9: Commit the UI**

```powershell
git add public/app.js public/styles.css test/mini-program-ui.test.js scripts/verify-mini-program-ui.mjs package.json
git commit -m "feat: add mini program conversation workbench"
```

Before committing, use `git diff -- public/app.js public/styles.css` to confirm the user's pre-existing edits were preserved.

---

## Task 11: Document the Partner Contract and Public Proxy Boundary

**Files:**

- Create: `docs/小程序文字对话接口-V1.0-20260905.md`
- Modify: `README.md`

- [ ] **Step 1: Write the partner-facing contract**

Document only what the mini-program team needs:

- Request/response schema and all limits.
- Canonical HMAC algorithm with raw-byte warning.
- Fresh timestamp/nonce requirement on retries and `messageId` idempotency.
- `202 ACCEPTED`, `202 IGNORED_HANDOFF_COMPLETED`, `400`, `401`, `409`, `413`, `415`, `503` examples.
- Callback schema, signing and `eventId` idempotency.
- Requirement to generate a new `conversationId` for a new consultation.
- Statement that only text is supported and no human status callback is expected.

Include a runnable Node.js signing example using `crypto.createHash`, `crypto.createHmac` and `fetch`; do not include a real secret or real user data.

- [ ] **Step 2: Document deployment boundary**

Add a production checklist stating that the remote reverse proxy may forward only:

```text
POST /open-api/v1/mini-program/messages
```

Require HTTPS, 32 KiB body limit, rate/connection limiting, upstream timeout, and source monitoring. Explicitly forbid exposing `/api/*`, `/`, static assets, port `3100` generally, or RAG port `18080`.

- [ ] **Step 3: Link operational docs from README**

Add a short section linking the approved design, implementation plan and partner contract. State that configuration remains environment-only and that the page does not provide human replies.

- [ ] **Step 4: Commit documentation**

```powershell
git add docs/小程序文字对话接口-V1.0-20260905.md README.md
git commit -m "docs: add mini program integration contract"
```

---

## Task 12: Full Regression, Security Audit, and Acceptance Evidence

**Files:**

- Modify only if a verified failure requires a scoped fix.

- [ ] **Step 1: Run syntax checks for every new/changed JavaScript module**

```powershell
node --check src/services/mini-program-auth.js
node --check src/services/mini-program-channel.js
node --check src/services/mini-program-callback.js
node --check src/services/mini-program-processing.js
node --check src/services/mini-program-http.js
node --check src/services/mini-program-admin.js
node --check src/server.js
node --check public/app.js
```

Expected: every command exits 0.

- [ ] **Step 2: Run all focused channel tests together**

```powershell
node --test --test-concurrency=1 test/mini-program-schema.test.js test/mini-program-auth.test.js test/mini-program-channel.test.js test/mini-program-callback.test.js test/mini-program-reply-dispatch.test.js test/mini-program-isolation.test.js test/mini-program-processing.test.js test/mini-program-open-api.test.js test/mini-program-admin-api.test.js test/mini-program-flow.integration.test.js test/mini-program-ui.test.js
```

Expected: all PASS with no leaked child process or open database handle.

- [ ] **Step 3: Run the complete regression suite**

```powershell
npm test
```

Expected: all legacy five-platform, RAG, notification, security and mini-program tests PASS.

- [ ] **Step 4: Run security-oriented source scans**

```powershell
rg -n "miniProgramSharedSecret|MINI_PROGRAM_SHARED_SECRET|X-Signature" src public
rg -n "mini_program" agent platform-workflows src/config.js
rg -n "/api/mini-program/.+(manual-reply|send-reply)|mini-program.+manual-reply" public/app.js src/server.js
```

Expected:

- Secret reads appear only in server-side config/signing code and are never serialized.
- `mini_program` does not appear in Agent/RPA/runtime platform registrations.
- No mini-program management route or page accepts a human reply.

- [ ] **Step 5: Re-run visual acceptance**

```powershell
node scripts/verify-mini-program-ui.mjs
```

Inspect both screenshots and browser console/network output. Confirm the page calls only authenticated `/api/mini-program/*` endpoints and never calls the public ingress endpoint or RAG directly.

- [ ] **Step 6: Inspect the final diff and working tree**

```powershell
git status --short
git diff --check
git log --oneline -12
```

Expected: no whitespace errors; no generated DB, keys, logs or screenshots staged; pre-existing user changes remain intact.

- [ ] **Step 7: Start the real local service for user acceptance**

```powershell
npm start
```

Open `http://127.0.0.1:3100/`, log in, select “小程序对话”, and verify summary, filters, details, handoff and retry states. Keep the service running and report the URL plus the exact five required environment variables to the user; do not print their secret values.

- [ ] **Step 8: Create a final verification commit only when fixes were needed**

If verification required a scoped fix, rerun the focused test that exposed it and commit through the exact task-specific `git add` list above. Skip this step when verification required no code changes; never stage an unknown set of files through a wildcard or broad directory add.
