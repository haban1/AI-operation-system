import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-program-auth-'));
const dbPath = path.join(dir, 'auth.db');
process.env.DATABASE_PATH = dbPath;
process.env.INSTANCE_LOCK_ENABLED = 'false';

const {
  MINI_PROGRAM_BODY_MAX_BYTES,
  MINI_PROGRAM_CLOCK_SKEW_SECONDS,
  MINI_PROGRAM_MESSAGE_PATH,
  MINI_PROGRAM_NONCE_TTL_MS,
  buildMiniProgramCanonicalRequest,
  cleanupExpiredMiniProgramNonces,
  consumeMiniProgramNonce,
  signMiniProgramRequest,
  startMiniProgramNonceCleanupWorker,
  stopMiniProgramNonceCleanupWorker,
  validateMiniProgramCallbackUrl,
  validateMiniProgramMessagePayload,
  verifyMiniProgramSignature
} = await import('../src/services/mini-program-auth.js');
const { db, row } = await import('../src/db.js');

const RAW_BODY = Buffer.from('{"appId":"app-1","conversationId":"c-1","messageId":"m-1","userId":"u-1","text":"你好","sentAt":"2026-09-05T01:00:00.000Z"}');
const TIMESTAMP_SECONDS = 1788570000;
const SECRET = 'shared-secret-32-characters-long!';
const NONCE = 'nonce-0000000001';
const EXPECTED_BODY_HASH = '9ce8094163dcc8f5be47a324d0a905bb6b44ff3aeb550429f4f4744351efb6ad';
const EXPECTED_SIGNATURE = '4d9740dd9867485e109fbc8d3c08c7194402aa39e71e890fff9db829c1e0b4d2';

function signatureFor({ rawBody = RAW_BODY, timestamp = String(TIMESTAMP_SECONDS), nonce = NONCE, secret = SECRET } = {}) {
  const canonical = [
    'POST',
    MINI_PROGRAM_MESSAGE_PATH,
    timestamp,
    nonce,
    crypto.createHash('sha256').update(rawBody).digest('hex')
  ].join('\n');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function headersFor({
  rawBody = RAW_BODY,
  appId = 'app-1',
  timestamp = String(TIMESTAMP_SECONDS),
  nonce = NONCE,
  signature = signatureFor({ rawBody, timestamp, nonce })
} = {}) {
  return {
    'x-mini-app-id': appId,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature
  };
}

function verify(headers, rawBody = RAW_BODY, options = {}) {
  return verifyMiniProgramSignature({
    method: 'POST',
    pathname: MINI_PROGRAM_MESSAGE_PATH,
    headers,
    rawBody,
    appId: options.appId ?? 'app-1',
    secret: options.secret ?? SECRET,
    nowMs: options.nowMs ?? TIMESTAMP_SECONDS * 1000
  });
}

function assertServiceError(action, { statusCode, code }) {
  assert.throws(action, error => {
    assert.equal(error?.statusCode, statusCode);
    assert.equal(error?.code, code);
    assert.equal(typeof error?.message, 'string');
    assert.ok(error.message.length > 0);
    return true;
  });
}

const VALID_PAYLOAD = Object.freeze({
  appId: 'app-1',
  conversationId: 'c-1',
  messageId: 'm-1',
  userId: 'u-1',
  text: '你好',
  sentAt: '2026-09-05T01:00:00.000Z'
});

test('构建规范原文并为固定字节生成确定的 HMAC', () => {
  const canonical = buildMiniProgramCanonicalRequest({
    method: 'POST',
    pathname: MINI_PROGRAM_MESSAGE_PATH,
    timestamp: String(TIMESTAMP_SECONDS),
    nonce: NONCE,
    rawBody: RAW_BODY
  });

  assert.equal(canonical, `POST\n${MINI_PROGRAM_MESSAGE_PATH}\n${TIMESTAMP_SECONDS}\n${NONCE}\n${EXPECTED_BODY_HASH}`);
  assert.equal(signMiniProgramRequest({
    method: 'POST',
    pathname: MINI_PROGRAM_MESSAGE_PATH,
    timestamp: String(TIMESTAMP_SECONDS),
    nonce: NONCE,
    rawBody: RAW_BODY,
    secret: SECRET
  }), EXPECTED_SIGNATURE);
});

test('校验基于实际接收的 Buffer，一个额外空格会使原签名失效', () => {
  const headers = headersFor({ signature: EXPECTED_SIGNATURE });
  assert.deepEqual(verify(headers), {
    appId: 'app-1',
    timestamp: String(TIMESTAMP_SECONDS),
    nonce: NONCE
  });

  const changedBody = Buffer.concat([RAW_BODY, Buffer.from(' ')]);
  assertServiceError(() => verify(headers, changedBody), {
    statusCode: 401,
    code: 'MINI_PROGRAM_AUTH_FAILED'
  });
});

test('仅对两个 32 字节摘要执行常量时间比较', t => {
  const comparedLengths = [];
  t.mock.method(crypto, 'timingSafeEqual', (left, right) => {
    comparedLengths.push([left.length, right.length]);
    return true;
  });

  assertServiceError(() => verify(headersFor({ signature: '0'.repeat(63) })), {
    statusCode: 401,
    code: 'MINI_PROGRAM_AUTH_INVALID'
  });
  assert.deepEqual(comparedLengths, []);

  verify(headersFor({ signature: EXPECTED_SIGNATURE }));
  assert.deepEqual(comparedLengths, [[32, 32]]);
});

test('未知应用、缺失头和非法签名均以安全的稳定错误拒绝', async t => {
  await t.test('未知应用', () => {
    assertServiceError(() => verify(headersFor({ appId: 'unknown-app' })), {
      statusCode: 401,
      code: 'MINI_PROGRAM_AUTH_FAILED'
    });
  });

  for (const name of ['x-mini-app-id', 'x-timestamp', 'x-nonce', 'x-signature']) {
    await t.test(`缺失 ${name}`, () => {
      const headers = headersFor();
      delete headers[name];
      assertServiceError(() => verify(headers), {
        statusCode: 401,
        code: 'MINI_PROGRAM_AUTH_INVALID'
      });
    });
  }

  for (const signature of ['0'.repeat(63), '0'.repeat(65), 'A'.repeat(64), `${'0'.repeat(63)}g`]) {
    await t.test(`非法签名 ${signature.length}`, () => {
      assertServiceError(() => verify(headersFor({ signature })), {
        statusCode: 401,
        code: 'MINI_PROGRAM_AUTH_INVALID'
      });
    });
  }

  const leakedValues = [SECRET, NONCE, EXPECTED_SIGNATURE];
  try {
    verify(headersFor({ signature: 'f'.repeat(64) }));
    assert.fail('错误签名不应通过');
  } catch (error) {
    for (const value of leakedValues) assert.equal(error.message.includes(value), false);
    assert.equal(error.detail, undefined);
  }
});

test('时间戳窗口两端包含第 300 秒并拒绝第 301 秒', async t => {
  for (const delta of [-MINI_PROGRAM_CLOCK_SKEW_SECONDS, MINI_PROGRAM_CLOCK_SKEW_SECONDS]) {
    await t.test(`接受 ${delta} 秒`, () => {
      const timestamp = String(TIMESTAMP_SECONDS + delta);
      assert.doesNotThrow(() => verify(headersFor({ timestamp })));
    });
  }

  for (const delta of [-(MINI_PROGRAM_CLOCK_SKEW_SECONDS + 1), MINI_PROGRAM_CLOCK_SKEW_SECONDS + 1]) {
    await t.test(`拒绝 ${delta} 秒`, () => {
      const timestamp = String(TIMESTAMP_SECONDS + delta);
      assertServiceError(() => verify(headersFor({ timestamp })), {
        statusCode: 401,
        code: 'MINI_PROGRAM_TIMESTAMP_EXPIRED'
      });
    });
  }
});

test('时间窗口按 Unix 整秒计算，不受服务器当前毫秒影响', () => {
  const timestamp = String(TIMESTAMP_SECONDS - MINI_PROGRAM_CLOCK_SKEW_SECONDS);
  assert.doesNotThrow(() => verify(headersFor({ timestamp }), RAW_BODY, {
    nowMs: TIMESTAMP_SECONDS * 1000 + 999
  }));
});

test('进入密码学校验前限制时间戳、Nonce 和应用 ID', async t => {
  for (const timestamp of ['-1', '1.5', 'abc', '1'.repeat(17)]) {
    await t.test(`时间戳 ${timestamp.slice(0, 20)}`, () => {
      assertServiceError(() => verify(headersFor({ timestamp, signature: 'f'.repeat(64) })), {
        statusCode: 401,
        code: 'MINI_PROGRAM_AUTH_INVALID'
      });
    });
  }

  for (const nonce of ['', '😀'.repeat(129)]) {
    await t.test(`Nonce 长度 ${Array.from(nonce).length}`, () => {
      assertServiceError(() => verify(headersFor({ nonce, signature: 'f'.repeat(64) })), {
        statusCode: 401,
        code: 'MINI_PROGRAM_AUTH_INVALID'
      });
    });
  }

  assertServiceError(() => verify(headersFor({ appId: '😀'.repeat(129), signature: 'f'.repeat(64) })), {
    statusCode: 401,
    code: 'MINI_PROGRAM_AUTH_INVALID'
  });
  assertServiceError(() => verify(headersFor({ appId: `${' '.repeat(129)}app-1` })), {
    statusCode: 401,
    code: 'MINI_PROGRAM_AUTH_INVALID'
  });

  const maxNonce = '😀'.repeat(128);
  assert.doesNotThrow(() => verify(headersFor({ nonce: maxNonce })));
});

test('启用时的非法应用 ID 或过短密钥被视为配置不完整', async t => {
  for (const appId of ['', ' '.repeat(3), '😀'.repeat(129)]) {
    await t.test(`应用 ID 长度 ${Array.from(appId).length}`, () => {
      assertServiceError(() => verify(headersFor(), RAW_BODY, { appId }), {
        statusCode: 503,
        code: 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE'
      });
    });
  }

  assertServiceError(() => verify(headersFor(), RAW_BODY, { secret: 'x'.repeat(31) }), {
    statusCode: 503,
    code: 'MINI_PROGRAM_CONFIGURATION_INCOMPLETE'
  });
});

test('鉴权边界接受 32 KiB Buffer 并在多一字节时拒绝', () => {
  const atLimit = Buffer.alloc(MINI_PROGRAM_BODY_MAX_BYTES, 0x61);
  assert.doesNotThrow(() => verify(headersFor({ rawBody: atLimit }), atLimit));

  const overLimit = Buffer.alloc(MINI_PROGRAM_BODY_MAX_BYTES + 1, 0x61);
  assertServiceError(() => verify(headersFor({ rawBody: overLimit }), overLimit), {
    statusCode: 413,
    code: 'MINI_PROGRAM_BODY_TOO_LARGE'
  });
  assertServiceError(() => verify(headersFor(), RAW_BODY.toString('utf8')), {
    statusCode: 400,
    code: 'MINI_PROGRAM_RAW_BODY_INVALID'
  });
});

test('Nonce 重放在当前进程中被 SQLite 唯一约束拒绝', () => {
  const nonce = 'nonce-same-process';
  consumeMiniProgramNonce({ appId: 'app-1', nonce, nowMs: TIMESTAMP_SECONDS * 1000 });

  assertServiceError(() => consumeMiniProgramNonce({ appId: 'app-1', nonce, nowMs: TIMESTAMP_SECONDS * 1000 + 1 }), {
    statusCode: 401,
    code: 'MINI_PROGRAM_NONCE_REPLAY'
  });
});

test('其他表的唯一约束错误保留 SQLite 身份而不伪装成 Nonce 重放', () => {
  db.exec(`
    CREATE TABLE mini_program_nonce_constraint_probe (
      value TEXT NOT NULL UNIQUE
    );
    INSERT INTO mini_program_nonce_constraint_probe(value) VALUES ('occupied');
    CREATE TRIGGER mini_program_nonce_constraint_probe_trigger
    BEFORE INSERT ON mini_program_request_nonces
    WHEN NEW.nonce = 'nonce-unrelated-constraint'
    BEGIN
      INSERT INTO mini_program_nonce_constraint_probe(value) VALUES ('occupied');
    END;
  `);

  try {
    assert.throws(
      () => consumeMiniProgramNonce({
        appId: 'app-1',
        nonce: 'nonce-unrelated-constraint',
        nowMs: TIMESTAMP_SECONDS * 1000
      }),
      error => {
        assert.equal(error?.code, 'ERR_SQLITE_ERROR');
        assert.equal(error?.errcode, 2067);
        assert.equal(error?.statusCode, undefined);
        assert.match(error?.message, /mini_program_nonce_constraint_probe\.value/);
        assert.equal(error.message.includes('nonce-unrelated-constraint'), false);
        return true;
      }
    );
  } finally {
    db.exec(`
      DROP TRIGGER mini_program_nonce_constraint_probe_trigger;
      DROP TABLE mini_program_nonce_constraint_probe;
    `);
  }
});

test('重新打开数据库的新进程仍拒绝已消费的 Nonce', () => {
  const authUrl = pathToFileURL(path.resolve('src/services/mini-program-auth.js')).href;
  const dbUrl = pathToFileURL(path.resolve('src/db.js')).href;
  const script = `
    const { consumeMiniProgramNonce } = await import(${JSON.stringify(authUrl)});
    const { db } = await import(${JSON.stringify(dbUrl)});
    let result = 0;
    try {
      consumeMiniProgramNonce({ appId: 'app-1', nonce: process.env.NONCE_TEST_VALUE, nowMs: ${TIMESTAMP_SECONDS * 1000} });
    } catch (error) {
      result = error?.statusCode === 401 && error?.code === 'MINI_PROGRAM_NONCE_REPLAY' ? 42 : 43;
    } finally {
      db.close();
    }
    process.exitCode = result;
  `;
  const env = {
    ...process.env,
    DATABASE_PATH: dbPath,
    INSTANCE_LOCK_ENABLED: 'false',
    NONCE_TEST_VALUE: 'nonce-persistent-process'
  };

  const first = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);

  const reopened = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(reopened.status, 42, reopened.stderr);
});

test('过期清理仅删除 expires_at 小于或等于边界的记录', () => {
  const nonce = 'nonce-cleanup-boundary';
  const nowMs = TIMESTAMP_SECONDS * 1000;
  consumeMiniProgramNonce({ appId: 'app-1', nonce, nowMs });
  consumeMiniProgramNonce({ appId: 'app-1', nonce: 'nonce-cleanup-future', nowMs: nowMs + 1 });

  assert.equal(cleanupExpiredMiniProgramNonces(new Date(nowMs + MINI_PROGRAM_NONCE_TTL_MS - 1).toISOString()), 0);
  assert.ok(row('SELECT expires_at FROM mini_program_request_nonces WHERE app_id=? AND nonce=?', 'app-1', nonce));
  const expiryBoundary = new Date(nowMs + MINI_PROGRAM_NONCE_TTL_MS).toISOString();
  const expiredCount = Number(row('SELECT COUNT(*) AS count FROM mini_program_request_nonces WHERE expires_at <= ?', expiryBoundary).count);
  assert.equal(cleanupExpiredMiniProgramNonces(expiryBoundary), expiredCount);
  assert.equal(row('SELECT expires_at FROM mini_program_request_nonces WHERE app_id=? AND nonce=?', 'app-1', nonce), undefined);
  assert.ok(row('SELECT expires_at FROM mini_program_request_nonces WHERE app_id=? AND nonce=?', 'app-1', 'nonce-cleanup-future'));
  assert.doesNotThrow(() => consumeMiniProgramNonce({ appId: 'app-1', nonce, nowMs: nowMs + MINI_PROGRAM_NONCE_TTL_MS }));
});

test('Nonce 清理 Worker 定期删除过期记录并可停止', async () => {
  const expiredAt = '2020-01-01T00:00:00.000Z';
  db.prepare('INSERT INTO mini_program_request_nonces(app_id,nonce,expires_at,created_at) VALUES(?,?,?,?)')
    .run('app-1', 'nonce-worker-removes', expiredAt, expiredAt);

  startMiniProgramNonceCleanupWorker({ intervalMs: 5 });
  try {
    for (let attempt = 0; attempt < 50 && row('SELECT nonce FROM mini_program_request_nonces WHERE app_id=? AND nonce=?', 'app-1', 'nonce-worker-removes'); attempt += 1) {
      await delay(5);
    }
    assert.equal(row('SELECT nonce FROM mini_program_request_nonces WHERE app_id=? AND nonce=?', 'app-1', 'nonce-worker-removes'), undefined);
  } finally {
    stopMiniProgramNonceCleanupWorker();
  }

  db.prepare('INSERT INTO mini_program_request_nonces(app_id,nonce,expires_at,created_at) VALUES(?,?,?,?)')
    .run('app-1', 'nonce-worker-stays', expiredAt, expiredAt);
  await delay(25);
  assert.ok(row('SELECT nonce FROM mini_program_request_nonces WHERE app_id=? AND nonce=?', 'app-1', 'nonce-worker-stays'));
});

test('严格的六字段文字消息被 trim 并归一化为 NFC', () => {
  const value = validateMiniProgramMessagePayload({
    appId: '  a\u0301pp-1  ',
    conversationId: '  conversation-e\u0301  ',
    messageId: '  message-e\u0301  ',
    userId: '  user-e\u0301  ',
    text: '  cafe\u0301 😀  ',
    sentAt: VALID_PAYLOAD.sentAt
  });

  assert.deepEqual(value, {
    appId: 'ápp-1',
    conversationId: 'conversation-é',
    messageId: 'message-é',
    userId: 'user-é',
    text: 'café 😀',
    sentAt: VALID_PAYLOAD.sentAt
  });
});

test('消息体只接受恰好六个指定字段', async t => {
  for (const invalid of [null, [], 'message']) {
    await t.test(`非对象 ${String(invalid)}`, () => {
      assertServiceError(() => validateMiniProgramMessagePayload(invalid), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
    });
  }

  for (const field of Object.keys(VALID_PAYLOAD)) {
    await t.test(`缺失 ${field}`, () => {
      const value = { ...VALID_PAYLOAD };
      delete value[field];
      assertServiceError(() => validateMiniProgramMessagePayload(value), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
    });
  }

  for (const extra of ['attachment', 'messageType', 'unexpected']) {
    await t.test(`多余字段 ${extra}`, () => {
      assertServiceError(() => validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, [extra]: 'value' }), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
    });
  }

  await t.test('非枚举必填字段不能被可枚举附件替换', () => {
    const value = { ...VALID_PAYLOAD, attachment: 'value' };
    Object.defineProperty(value, 'text', {
      value: VALID_PAYLOAD.text,
      enumerable: false,
      configurable: true
    });

    assertServiceError(() => validateMiniProgramMessagePayload(value), {
      statusCode: 400,
      code: 'MINI_PROGRAM_PAYLOAD_INVALID'
    });
  });

  await t.test('可枚举 Symbol 也属于禁止的额外字段', () => {
    const value = { ...VALID_PAYLOAD };
    Object.defineProperty(value, Symbol('attachment'), {
      value: 'value',
      enumerable: true
    });

    assertServiceError(() => validateMiniProgramMessagePayload(value), {
      statusCode: 400,
      code: 'MINI_PROGRAM_PAYLOAD_INVALID'
    });
  });
});

test('六个消息字段都必须是字符串', async t => {
  for (const field of Object.keys(VALID_PAYLOAD)) {
    await t.test(field, () => {
      assertServiceError(() => validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, [field]: 1 }), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
    });
  }
});

test('应用和用户身份字段按归一化后的 Unicode 码点计算 1 至 128 字符', async t => {
  for (const field of ['appId', 'conversationId', 'messageId', 'userId']) {
    await t.test(field, () => {
      const atLimit = validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, [field]: '😀'.repeat(128) });
      assert.equal(Array.from(atLimit[field]).length, 128);

      assertServiceError(() => validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, [field]: '   ' }), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
      assertServiceError(() => validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, [field]: '😀'.repeat(129) }), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
    });
  }
});

test('文字正文按 Unicode 码点计算 1 至 2000 字符', () => {
  const atLimit = validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, text: '😀'.repeat(2000) });
  assert.equal(Array.from(atLimit.text).length, 2000);

  for (const text of [' \t\r\n ', '😀'.repeat(2001)]) {
    assertServiceError(() => validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, text }), {
      statusCode: 400,
      code: 'MINI_PROGRAM_PAYLOAD_INVALID'
    });
  }
});

test('sentAt 必须是有限且完整的 ISO-8601 时间', async t => {
  for (const sentAt of ['2026-09-05T09:00:00+08:00', '2026-09-05T01:00:00.123456Z']) {
    await t.test(`接受 ${sentAt}`, () => {
      assert.equal(validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, sentAt }).sentAt, sentAt);
    });
  }

  for (const sentAt of ['2026-09-05', '2026-02-29T01:00:00.000Z', '2026-09-05T25:00:00.000Z', 'not-a-date']) {
    await t.test(`拒绝 ${sentAt}`, () => {
      assertServiceError(() => validateMiniProgramMessagePayload({ ...VALID_PAYLOAD, sentAt }), {
        statusCode: 400,
        code: 'MINI_PROGRAM_PAYLOAD_INVALID'
      });
    });
  }
});

test('回调地址接受 HTTPS 和仅限环回主机的 HTTP', () => {
  assert.equal(validateMiniProgramCallbackUrl('https://callback.example.test/replies').href, 'https://callback.example.test/replies');
  assert.equal(validateMiniProgramCallbackUrl('http://localhost:8080/replies').href, 'http://localhost:8080/replies');
  assert.equal(validateMiniProgramCallbackUrl('http://127.0.0.1/replies').href, 'http://127.0.0.1/replies');
  assert.equal(validateMiniProgramCallbackUrl('http://[::1]:8080/replies').href, 'http://[::1]:8080/replies');
});

test('回调地址拒绝远程 HTTP、认证信息、查询、片段和非 HTTP 协议', async t => {
  const invalidUrls = [
    'http://callback.example.test/replies',
    'http://127.1/replies',
    'http://2130706433/replies',
    'http://0x7f000001/replies',
    'https://user:password@callback.example.test/replies',
    'https://callback.example.test/replies?token=value',
    'https://callback.example.test/replies?',
    'https://callback.example.test/replies#section',
    'https://callback.example.test/replies#',
    'ftp://callback.example.test/replies',
    '/relative/replies',
    ''
  ];

  for (const value of invalidUrls) {
    await t.test(value || '空地址', () => {
      assertServiceError(() => validateMiniProgramCallbackUrl(value), {
        statusCode: 503,
        code: 'MINI_PROGRAM_CALLBACK_URL_INVALID'
      });
    });
  }
});

test.after(() => {
  stopMiniProgramNonceCleanupWorker();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
