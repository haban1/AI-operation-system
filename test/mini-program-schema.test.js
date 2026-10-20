import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-program-schema-'));
process.env.DATABASE_PATH = path.join(dir, 'schema.db');
process.env.INSTANCE_LOCK_ENABLED = 'false';
process.env.MINI_PROGRAM_API_ENABLED = 'true';
process.env.MINI_PROGRAM_APP_ID = 'app-test-001';
process.env.MINI_PROGRAM_SHARED_SECRET = 'a'.repeat(32);

const { config } = await import('../src/config.js');
const { db, initDb, row } = await import('../src/db.js');
const { miniProgramAccount } = await import('../src/services/mini-program-channel.js');

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

test('重新初始化会修复被停用且误标 READY 的隐藏渠道账号', () => {
  db.prepare("UPDATE accounts SET enabled=0,login_status='READY' WHERE platform_code='mini_program' AND profile_name='mini-program-api-main'").run();

  initDb();

  const account = row("SELECT enabled,login_status FROM accounts WHERE platform_code='mini_program' AND profile_name='mini-program-api-main'");
  assert.equal(account.enabled, 1);
  assert.equal(account.login_status, 'NOT_REQUIRED');
});

function resetUnboundMiniAccounts(ids) {
  db.exec('DROP TABLE IF EXISTS mini_program_channel_identity');
  db.prepare('DELETE FROM schema_migrations WHERE id=?').run('2026-09-06-mini-program-channel-identity-v1');
  db.prepare("DELETE FROM accounts WHERE platform_code='mini_program'").run();
  for (const id of ids) db.prepare(`INSERT INTO accounts(id,platform_code,display_name,device_id,profile_name,enabled,login_status,created_at)
    VALUES(?,'mini_program','legacy mini','device-rpa-01','mini-program-api-main',0,'READY','2026-09-01T00:00:00.000Z')`).run(id);
}

function restartedIdentity() {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { db } from './src/db.js';
    import { miniProgramAccount } from './src/services/mini-program-channel.js';
    let result;
    try { result = { accountId: miniProgramAccount().id }; }
    catch (error) { result = { status: error.statusCode, code: error.code }; }
    console.log(JSON.stringify(result));
    db.close();
  `], { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function identitySnapshot() {
  return ['accounts', 'mini_program_channel_identity', 'schema_migrations'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
}

test('review 2: zero candidates seed one durable canonical account and initialization is idempotent', () => {
  resetUnboundMiniAccounts([]);
  initDb();
  assert.ok(row("SELECT name FROM sqlite_master WHERE name='mini_program_channel_identity'"));
  const account = miniProgramAccount();
  const binding = row('SELECT * FROM mini_program_channel_identity');
  assert.equal(binding.account_id, account.id);
  assert.equal(row("SELECT COUNT(*) AS n FROM accounts WHERE platform_code='mini_program'").n, 1);
  assert.equal(account.enabled, 1);
  assert.equal(account.login_status, 'NOT_REQUIRED');
  initDb();
  assert.deepEqual(miniProgramAccount(), account);
  assert.deepEqual(row('SELECT * FROM mini_program_channel_identity'), binding);
  assert.throws(() => db.prepare('INSERT INTO mini_program_channel_identity(id,account_id,created_at) VALUES(2,1,?)').run(binding.created_at));
  assert.throws(() => db.prepare('UPDATE mini_program_channel_identity SET account_id=999999 WHERE id=1').run());
});

test('review 2: unique legacy account is bound and repaired without choosing an arbitrary ID', () => {
  resetUnboundMiniAccounts([200]);
  initDb();
  assert.ok(row("SELECT name FROM sqlite_master WHERE name='mini_program_channel_identity'"));
  assert.equal(miniProgramAccount().id, 200);
  assert.equal(miniProgramAccount().enabled, 1);
  assert.equal(miniProgramAccount().login_status, 'NOT_REQUIRED');
  assert.equal(row('SELECT account_id FROM mini_program_channel_identity').account_id, 200);
});

test('review 2: seed and restarted runtime retain the binding despite smaller/larger duplicate IDs and reverse index', () => {
  resetUnboundMiniAccounts([200]);
  initDb();
  for (const id of [100, 300]) db.prepare(`INSERT INTO accounts(id,platform_code,display_name,device_id,profile_name,enabled,login_status,created_at)
    VALUES(?,'mini_program','legacy mini','device-rpa-01','mini-program-api-main',0,'READY','1900-01-01T00:00:00.000Z')`).run(id);
  db.exec('CREATE INDEX test_schema_mini_reverse ON accounts(platform_code,profile_name,id DESC)');
  try {
    assert.equal(miniProgramAccount().id, 200);
    db.prepare("UPDATE accounts SET enabled=0,login_status='READY' WHERE id=200").run();
    initDb();
    assert.equal(miniProgramAccount().id, 200);
    assert.equal(miniProgramAccount().login_status, 'NOT_REQUIRED');
    for (const id of [100, 300]) assert.deepEqual({ ...row('SELECT enabled,login_status FROM accounts WHERE id=?', id) }, { enabled: 0, login_status: 'READY' });
    const binding = row('SELECT * FROM mini_program_channel_identity');
    const restarted = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { db, row } from './src/db.js';
      import { miniProgramAccount } from './src/services/mini-program-channel.js';
      console.log(JSON.stringify({ id: miniProgramAccount().id, binding: row('SELECT * FROM mini_program_channel_identity') }));
      db.close();
    `], { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(JSON.parse(restarted.stdout), { id: 200, binding: { ...binding } });
  } finally { db.exec('DROP INDEX IF EXISTS test_schema_mini_reverse'); }
});

test('review 2: ambiguous unbound legacy accounts do not prevent startup or elect an identity', () => {
  resetUnboundMiniAccounts([100, 300]);
  const before = db.prepare("SELECT * FROM accounts WHERE platform_code='mini_program' ORDER BY id").all();
  initDb();
  assert.throws(() => miniProgramAccount(), error => error.statusCode === 503 && error.code === 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE');
  assert.deepEqual({ ...row('SELECT account_id,binding_state FROM mini_program_channel_identity WHERE id=1') }, { account_id: null, binding_state: 'UNBOUND' });
  assert.deepEqual(db.prepare("SELECT * FROM accounts WHERE platform_code='mini_program' ORDER BY id").all(), before);
  initDb();
  assert.throws(() => miniProgramAccount(), error => error.statusCode === 503);
  assert.deepEqual({ ...row('SELECT account_id,binding_state FROM mini_program_channel_identity WHERE id=1') }, { account_id: null, binding_state: 'UNBOUND' });
});

test('review 2: missing or invalid binding fails read-only without electing another account', () => {
  resetUnboundMiniAccounts([200]);
  initDb();
  assert.ok(row("SELECT name FROM sqlite_master WHERE name='mini_program_channel_identity'"));
  for (const mutation of [
    "UPDATE accounts SET profile_name='tampered' WHERE id=200",
    'UPDATE mini_program_channel_identity SET account_id=1 WHERE id=1',
    'DELETE FROM mini_program_channel_identity'
  ]) {
    db.exec('SAVEPOINT invalid_identity');
    try {
      db.exec(mutation);
      const before = db.prepare('SELECT * FROM accounts ORDER BY id').all();
      const bindingBefore = db.prepare('SELECT * FROM mini_program_channel_identity').all();
      assert.throws(() => miniProgramAccount(), error => error.statusCode === 503 && error.code === 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE');
      assert.deepEqual(db.prepare('SELECT * FROM accounts ORDER BY id').all(), before);
      assert.deepEqual(db.prepare('SELECT * FROM mini_program_channel_identity').all(), bindingBefore);
    } finally { db.exec('ROLLBACK TO invalid_identity; RELEASE invalid_identity'); }
  }
  db.prepare('UPDATE mini_program_channel_identity SET account_id=1 WHERE id=1').run();
  initDb();
  assert.throws(() => miniProgramAccount(), error => error.statusCode === 503);
  assert.equal(row('SELECT account_id FROM mini_program_channel_identity').account_id, 1);
});

for (const remaining of ['original', 'none', 'duplicate']) test(`review 3: deleted singleton stays unavailable after restart with ${remaining} candidates`, () => {
  resetUnboundMiniAccounts([200]);
  initDb();
  db.prepare('DELETE FROM mini_program_channel_identity').run();
  if (remaining === 'none') db.prepare('DELETE FROM accounts WHERE id=200').run();
  if (remaining === 'duplicate') {
    db.prepare("UPDATE accounts SET profile_name='retired-original' WHERE id=200").run();
    db.prepare(`INSERT INTO accounts(id,platform_code,display_name,device_id,profile_name,enabled,login_status,created_at)
      VALUES(300,'mini_program','duplicate','device-rpa-01','mini-program-api-main',0,'READY','1900-01-01T00:00:00.000Z')`).run();
  }
  const before = identitySnapshot();
  assert.deepEqual(restartedIdentity(), { status: 503, code: 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE' });
  assert.deepEqual(identitySnapshot(), before);
  initDb();
  initDb();
  assert.throws(() => miniProgramAccount(), error => error.statusCode === 503);
  assert.deepEqual(identitySnapshot(), before);
});

test('review 3: explicit unbound state survives restart and can bind only after ambiguity is removed', () => {
  resetUnboundMiniAccounts([100, 300]);
  initDb();
  const binding = row('SELECT * FROM mini_program_channel_identity WHERE id=1');
  assert.ok(binding, 'Migration must create the explicit initial singleton');
  assert.equal(binding.account_id, null);
  assert.equal(binding.binding_state, 'UNBOUND');
  const before = identitySnapshot();
  assert.deepEqual(restartedIdentity(), { status: 503, code: 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE' });
  assert.deepEqual(identitySnapshot(), before);
  db.prepare('DELETE FROM accounts WHERE id=300').run();
  assert.deepEqual(restartedIdentity(), { accountId: 100 });
  assert.deepEqual({ ...row('SELECT account_id,binding_state,created_at FROM mini_program_channel_identity') }, {
    account_id: 100, binding_state: 'BOUND', created_at: binding.created_at
  });
  assert.throws(() => db.prepare('UPDATE mini_program_channel_identity SET account_id=NULL').run(), /constraint/i);
  assert.throws(() => db.prepare("UPDATE mini_program_channel_identity SET binding_state='UNBOUND'").run(), /constraint/i);
  const bound = identitySnapshot();
  assert.deepEqual(restartedIdentity(), { accountId: 100 });
  assert.deepEqual(identitySnapshot(), bound);
});

test('review 3: invalid bound identity remains unchanged across a new process', () => {
  for (const mutation of ["UPDATE accounts SET profile_name='invalid' WHERE id=200", 'UPDATE mini_program_channel_identity SET account_id=1']) {
    resetUnboundMiniAccounts([200]);
    initDb();
    db.exec(mutation);
    const before = identitySnapshot();
    assert.deepEqual(restartedIdentity(), { status: 503, code: 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE' });
    assert.deepEqual(identitySnapshot(), before);
  }
});

test('review 3: legacy non-null identity schema retains valid binding but never repairs a missing row', () => {
  resetUnboundMiniAccounts([200]);
  initDb();
  const binding = row('SELECT * FROM mini_program_channel_identity');
  db.exec(`DROP TABLE mini_program_channel_identity;
    CREATE TABLE mini_program_channel_identity (
      id INTEGER PRIMARY KEY CHECK(id=1),
      account_id INTEGER NOT NULL UNIQUE CHECK(account_id>0) REFERENCES accounts(id),
      created_at TEXT NOT NULL
    )`);
  db.prepare('INSERT INTO mini_program_channel_identity(id,account_id,created_at) VALUES(1,200,?)').run(binding.created_at);
  const before = identitySnapshot();
  assert.deepEqual(restartedIdentity(), { accountId: 200 });
  assert.deepEqual(identitySnapshot(), before);
  db.prepare('DELETE FROM mini_program_channel_identity').run();
  const missing = identitySnapshot();
  assert.deepEqual(restartedIdentity(), { status: 503, code: 'MINI_PROGRAM_ACCOUNT_UNAVAILABLE' });
  assert.deepEqual(identitySnapshot(), missing);
});

test('review 3: two SQLite connections concurrently initialize the identity migration once', { timeout: 20_000 }, async () => {
  resetUnboundMiniAccounts([]);
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const gate = new Int32Array(workerData.gate);
    Atomics.add(gate, 0, 1);
    Atomics.notify(gate, 0);
    while (Atomics.load(gate, 1) === 0) Atomics.wait(gate, 1, 0, 100);
    (async () => {
      const { db } = await import(workerData.databaseUrl);
      const { miniProgramAccount } = await import(workerData.channelUrl);
      parentPort.postMessage({ ok: true, accountId: miniProgramAccount().id });
      db.close();
    })().catch(error => { parentPort.postMessage({ ok: false, error: error.message }); process.exitCode = 1; });
  `;
  const workers = Array.from({ length: 2 }, () => new Worker(workerSource, { eval: true, workerData: {
    gate, databaseUrl: new URL('../src/db.js', import.meta.url).href,
    channelUrl: new URL('../src/services/mini-program-channel.js', import.meta.url).href
  } }));
  try {
    const ready = new Int32Array(gate);
    const deadline = Date.now() + 10_000;
    while (Atomics.load(ready, 0) < 2) {
      if (Date.now() >= deadline) throw new Error('Concurrent SQLite connections did not reach the start gate');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    Atomics.store(ready, 1, 1);
    Atomics.notify(ready, 1, 2);
    const results = await Promise.all(workers.map(worker => new Promise((resolve, reject) => {
      let result;
      worker.on('message', value => { result = value; });
      worker.once('error', reject);
      worker.once('exit', code => resolve({ code, ...result }));
    })));
    assert.equal(Atomics.load(ready, 0), 2);
    assert.ok(results.every(result => result.ok && result.code === 0), JSON.stringify(results));
    assert.equal(results[0].accountId, results[1].accountId);
    assert.equal(row("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='2026-09-06-mini-program-channel-identity-v1'").n, 1);
    assert.equal(row('SELECT COUNT(*) AS n FROM mini_program_channel_identity').n, 1);
    assert.equal(row("SELECT COUNT(*) AS n FROM accounts WHERE platform_code='mini_program'").n, 1);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});

test('two runtimes can concurrently initialize the same blank database', { timeout: 30_000 }, async () => {
  const databaseUrl = new URL('../src/db.js', import.meta.url).href;
  const childSource = `
    process.once('message', () => {
      void (async () => {
        const { db } = await import(${JSON.stringify(databaseUrl)});
        const accountCount = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE platform_code='mini_program'").get().count;
        const bindingCount = db.prepare('SELECT COUNT(*) AS count FROM mini_program_channel_identity').get().count;
        db.close();
        process.send({ type: 'result', ok: true, accountCount, bindingCount }, () => process.disconnect());
      })().catch(error => {
        process.exitCode = 1;
        process.send({ type: 'result', ok: false, code: error.code || null, error: error.message, stack: error.stack }, () => process.disconnect());
      });
    });
    process.send({ type: 'ready' });
  `;

  function launchChild(databasePath) {
    const child = spawn(process.execPath, ['-e', childSource], {
      env: {
        NODE_ENV: 'test',
        DATABASE_PATH: databasePath,
        INSTANCE_LOCK_ENABLED: 'false',
        SQLITE_BUSY_TIMEOUT_MS: '15000'
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let result = null;
    let stderr = '';
    let reportedReady = false;
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.on('message', value => {
        if (value?.type === 'ready') {
          reportedReady = true;
          resolve();
        }
        if (value?.type === 'result') result = value;
      });
      child.once('exit', code => {
        if (!reportedReady) reject(new Error(`Database child exited before ready (${code}): ${stderr}`));
      });
    });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stderr, ...result }));
    });
    return { child, ready, exited };
  }

  for (let round = 0; round < 5; round += 1) {
    const roundDir = fs.mkdtempSync(path.join(os.tmpdir(), `blank-db-race-${round}-`));
    const databasePath = path.join(roundDir, 'blank.db');
    const children = Array.from({ length: 2 }, () => launchChild(databasePath));
    try {
      await Promise.all(children.map(item => item.ready));
      for (const { child } of children) child.send({ type: 'start' });
      const results = await Promise.all(children.map(item => item.exited));
      assert.ok(results.every(result => result.ok && result.code === 0), `round ${round}: ${JSON.stringify(results)}`);
      assert.ok(results.every(result => result.accountCount === 1 && result.bindingCount === 1), `round ${round}: ${JSON.stringify(results)}`);
    } finally {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.allSettled(children.map(item => item.exited));
      fs.rmSync(roundDir, { recursive: true, force: true });
    }
  }
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
