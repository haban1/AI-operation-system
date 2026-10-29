import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { precheckMaterial } from '../agent/precheck.js';

// Deployment-only integration coverage: this suite needs Python and FFmpeg.
// It starts the shipped engine and verifies draft-only task guards with no Agent
// executor, model generation, speech synthesis or actual platform publication.
const repoRoot = path.resolve(import.meta.dirname, '..');
const bundledRoot = path.join(repoRoot, 'engines', 'ai-signal-studio');
const prefix = '/integrations/ai-signal/';
const fixtureId = 'bundled-engine-local-fixture';
const username = 'bundled-engine-test';
const password = 'test-only-password';
const execFileAsync = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function request(base, requestPath, { method = 'GET', headers = {}, body = '', chunks, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path: requestPath, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out: ${requestPath}`)));
    req.once('error', reject);
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); }
    else req.end(body);
  });
}

async function json(base, requestPath, options) {
  const result = await request(base, requestPath, options);
  assert.equal(result.status, 200, `${requestPath}: ${result.bytes.toString('utf8').slice(0, 1000)}`);
  return JSON.parse(result.bytes.toString('utf8'));
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function launch(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const processState = { child, diagnostic: '', error: null };
  const record = chunk => { processState.diagnostic = (processState.diagnostic + chunk.toString()).slice(-8000); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.once('error', error => { processState.error = error; });
  return processState;
}

async function stop(processState) {
  if (!processState) return;
  const { child } = processState;
  if (child.exitCode !== null || child.signalCode !== null || processState.error) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function waitForHealth(processState, base, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { child, error, diagnostic } = processState;
    if (error || child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited: ${error || diagnostic}`);
    try { if ((await request(base, '/api/health')).status === 200) return; } catch {}
    await pause(100);
  }
  throw new Error(`${label} did not become healthy: ${processState.diagnostic}`);
}

async function login(base) {
  const response = await request(base, '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers['set-cookie']?.length, 'Main app must issue an authenticated session');
  return { Cookie: response.headers['set-cookie'][0].split(';')[0] };
}

function assertNoPublishTasks(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publish_tasks').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM scheduled_publish_tasks').get().count, 0);
  } finally { db.close(); }
}

test('bundled Signal engine integrates through authenticated main app and persistent content library', { timeout: 90_000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'signal-bundled-engine-')));
  const engineRoot = path.join(directory, 'engine');
  const runtimeConfig = path.join(directory, 'runtime-config');
  const libraryRoot = path.join(directory, 'content-library');
  const databasePath = path.join(directory, 'main.db');
  let engine;
  let main;
  t.after(async () => {
    await stop(main);
    await stop(engine);
    await rm(directory, { recursive: true, force: true });
  });

  await mkdir(engineRoot);
  // Copy only shipped source; user configuration, credentials and runs are never read.
  for (const name of ['app.py', 'scripts', 'web', 'config.example.json']) {
    await cp(path.join(bundledRoot, name), path.join(engineRoot, name), { recursive: true });
  }
  for (const name of ['runs', 'data', 'video/public/runs']) await mkdir(path.join(engineRoot, name), { recursive: true });
  await mkdir(runtimeConfig);

  const runDirectory = path.join(engineRoot, 'runs', fixtureId);
  await mkdir(runDirectory);
  const fixturePath = path.join(runDirectory, 'video.mp4');
  const ffmpeg = process.env.SIGNAL_TEST_FFMPEG || 'ffmpeg';
  await execFileAsync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5', '-t', '1', '-c:v', 'mpeg4', '-f', 'mp4', fixturePath], { timeout: 10_000 });
  await execFileAsync(ffmpeg, ['-v', 'error', '-i', fixturePath, '-f', 'null', '-'], { timeout: 10_000 });
  await writeFile(path.join(runDirectory, 'script.json'), JSON.stringify({
    title: 'Local FFmpeg integration fixture', summary: 'Synthetic local test media; no model generation or publication.',
    repo: 'local/test-fixture', created_at: '2026-01-01T00:00:00.000Z', scenes: [],
  }));
  await writeFile(path.join(runDirectory, 'validation.json'), JSON.stringify({ full_decode: 'passed', fixture: true }));
  const fixtureBytes = await readFile(fixturePath);
  const digest = sha256(fixtureBytes);
  // A different valid container forces the reception path to inspect fresh bytes.
  const uploadFixture = path.join(directory, 'receive.mp4');
  await execFileAsync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=5', '-t', '1', '-c:v', 'mpeg4', '-f', 'mp4', uploadFixture], { timeout: 10_000 });
  const uploadBytes = await readFile(uploadFixture);
  const uploadDigest = sha256(uploadBytes);
  const maxUploadBytes = Math.max(1024, fixtureBytes.length, uploadBytes.length) + 64;

  const enginePort = await unusedPort();
  let mainPort = await unusedPort();
  while (mainPort === enginePort) mainPort = await unusedPort();
  const upstream = `http://127.0.0.1:${enginePort}`;
  const base = `http://127.0.0.1:${mainPort}`;
  const commonEnv = { PATH: process.env.PATH, NODE_ENV: 'test' };
  async function startServices() {
    engine = launch(process.env.SIGNAL_TEST_PYTHON || 'python3', ['app.py'], {
      cwd: engineRoot,
      env: { ...commonEnv, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', SIGNAL_HOST: '127.0.0.1', SIGNAL_PORT: String(enginePort), SIGNAL_BASE_PATH: prefix, SIGNAL_CONFIG_DIR: runtimeConfig },
    });
    await waitForHealth(engine, upstream, 'Bundled Signal engine');
    main = launch(process.execPath, ['src/server.js'], {
      cwd: repoRoot,
      env: {
        ...commonEnv, SERVER_HOST: '127.0.0.1', PORT: String(mainPort), DATABASE_PATH: databasePath,
        AUTH_ENABLED: 'true', ADMIN_USERNAME: username, ADMIN_PASSWORD: password, SESSION_SECRET: 'test-only-bundled-engine-session-secret',
        LOCAL_AGENT_AUTO_START: 'false', AUTO_COLLECT_ENABLED: 'false', SMOKE_TEST_ENABLED: 'false', RAG_AUTO_START: 'false', QWEN_MODE: 'mock', RPA_MODE: 'simulated',
        AI_SIGNAL_STUDIO_URL: prefix, AI_SIGNAL_STUDIO_INTERNAL_URL: upstream, AI_SIGNAL_STUDIO_HEALTH_URL: upstream + '/api/health',
        CONTENT_LIBRARY_DIR: libraryRoot, CONTENT_LIBRARY_SEED_ENABLED: 'false', CONTENT_LIBRARY_SIGNAL_ROOT: engineRoot, CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '',
        CONTENT_LIBRARY_MAX_FILE_BYTES: String(maxUploadBytes),
        VIDEO_EDITING_URL: '', VIDEO_EDITING_HEALTH_URL: '', AIGC_CREATION_URL: '', AIGC_CREATION_HEALTH_URL: '',
      },
    });
    await waitForHealth(main, base, 'Main app');
  }
  await startServices();
  let headers;
  let item;

  await t.test('anonymous HTML, JavaScript, API and actual media requests are rejected', async () => {
    for (const suffix of ['', 'app.js', 'api/state', 'api/health', `runs/${fixtureId}/video.mp4`]) {
      assert.equal((await request(base, prefix + suffix)).status, 401, suffix);
    }
    headers = await login(base);
  });

  await t.test('actual engine pages, API URLs and workbench health use the authenticated mount', async () => {
    const html = await request(base, prefix, { headers });
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /text\/html/);
    assert.ok(html.bytes.toString().includes('<title>AI Signal'), 'Engine HTML must be served instead of main app fallback');
    assert.ok(html.bytes.toString().includes(`<base href="${prefix}">`), 'Relative assets must resolve beneath the authenticated mount');
    const js = await request(base, prefix + 'app.js', { headers });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    const health = await json(base, prefix + 'api/health', { headers });
    assert.equal(health.service, 'AI Signal Studio');
    const state = await json(base, prefix + 'api/state', { headers });
    assert.equal(state.runs.find(run => run.id === fixtureId)?.video, `${prefix}runs/${fixtureId}/video.mp4`, 'Engine-generated media URL must include the deployment base path');
    const mediaPath = prefix + `runs/${fixtureId}/video.mp4`;
    const media = await request(base, mediaPath, { headers });
    assert.equal(media.status, 200);
    assert.equal(sha256(media.bytes), digest);
    const partial = await request(base, mediaPath, { headers: { ...headers, Range: 'bytes=0-31' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers['content-range'], `bytes 0-31/${fixtureBytes.length}`);
    assert.deepEqual(partial.bytes, fixtureBytes.subarray(0, 32));
    const head = await request(base, mediaPath, { method: 'HEAD', headers });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), fixtureBytes.length);
    assert.equal(head.bytes.length, 0);
    const status = await json(base, '/api/creative-workbench/status', { headers });
    const automatic = status.services.find(service => service.id === 'automatic');
    assert.equal(automatic.url, prefix);
    assert.equal(automatic.online, true);
    assertNoPublishTasks(databasePath);
  });

  await t.test('shared library requires an authenticated admission before preparing a draft', async () => {
    const synced = await json(base, '/api/content-library/sync', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 20_000 });
    assert.equal(synced.items.length, 0);
    assert.equal(synced.pendingItems.length, 1, JSON.stringify(synced.sources));
    [item] = synced.pendingItems;
    assert.equal(item.admissionStatus, 'pending');
    assert.equal(item.source, 'automatic');
    assert.equal(item.sourceId, fixtureId);
    assert.equal(item.artifactType, 'final_video');
    assert.equal(item.sha256, digest);
    assert.equal(item.sizeBytes, fixtureBytes.length);
    assert.equal((await request(base, item.mediaUrl)).status, 401);
    const draftUrl = `/api/content-library/${item.id}/publish-draft`;
    assert.equal((await request(base, draftUrl)).status, 401);
    const notAdmitted = await request(base, draftUrl, { headers });
    assert.equal(notAdmitted.status, 409);
    assert.equal(JSON.parse(notAdmitted.bytes).code, 'CONTENT_ADMISSION_REQUIRED');
    const media = await request(base, item.mediaUrl, { headers });
    assert.equal(media.status, 200);
    assert.equal(sha256(media.bytes), digest);
    const partial = await request(base, item.mediaUrl, { headers: { ...headers, Range: 'bytes=0-31' } });
    assert.equal(partial.status, 206);
    assert.deepEqual(partial.bytes, fixtureBytes.subarray(0, 32));
    const admissionUrl = `/api/content-library/${item.id}/admission`;
    assert.equal((await request(base, admissionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) })).status, 401);
    const forgedActor = await request(base, admissionUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved', actor: 'not-the-admin' }) });
    assert.equal(forgedActor.status, 400);
    const approved = await json(base, admissionUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
    assert.equal(approved.item.admissionStatus, 'approved');
    assert.equal(approved.item.admittedBy, username);
    assert.equal(approved.item.reviewedBy, username);
    assert.ok(approved.item.admittedAt);
    assert.deepEqual(approved.counts, { total: 1, approved: 1, pending: 0, rejected: 0 });
    const draft = await json(base, draftUrl, { headers });
    assert.equal(draft.requiresPrecheck, true);
    assert.equal(draft.sha256, digest);
    assert.deepEqual(draft.sourceRef, { source: 'automatic', sourceId: fixtureId });
    assert.equal(path.dirname(draft.materialPath), path.join(libraryRoot, 'media'));
    assert.equal(sha256(await readFile(draft.materialPath)), digest);
    assert.notEqual(draft.materialPath, fixturePath);
    assertNoPublishTasks(databasePath);
  });

  await t.test('admission can be revoked and resubmitted without deleting media or publishing', async () => {
    const admissionUrl = `/api/content-library/${item.id}/admission`;
    const draftUrl = `/api/content-library/${item.id}/publish-draft`;
    for (const decision of ['rejected', 'pending']) {
      const reviewed = await json(base, admissionUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
      assert.equal(reviewed.item.admissionStatus, decision);
      assert.equal(reviewed.item.reviewedBy, username);
      assert.equal(reviewed.item.admittedBy, null);
      assert.equal((await request(base, draftUrl, { headers })).status, 409);
      const listed = await json(base, '/api/content-library', { headers });
      assert.equal(listed.items.length, 0);
      assert.equal(listed[decision === 'pending' ? 'pendingItems' : 'rejectedItems'][0].id, item.id);
      assert.equal((await request(base, item.mediaUrl, { headers })).status, 200);
    }
    await json(base, admissionUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
    assertNoPublishTasks(databasePath);
  });

  await t.test('restarting both services preserves copied media and repeated sync creates no duplicates', { skip: !item && 'Requires successful media import' }, async () => {
    await stop(main);
    await stop(engine);
    await startServices();
    headers = await login(base);
    const status = await json(base, '/api/creative-workbench/status', { headers });
    assert.equal(status.services.find(service => service.id === 'automatic').online, true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const synced = await json(base, '/api/content-library/sync', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 20_000 });
      assert.equal(synced.items.length, 1);
      assert.equal(synced.items[0].id, item.id);
      assert.equal(synced.items[0].sha256, digest);
      assert.equal(synced.items[0].admittedBy, username);
    }
    assert.deepEqual(await readdir(path.join(libraryRoot, 'media')), [`${digest}.mp4`]);
    // Removing only this synthetic source proves the library serves its persisted copy.
    await rm(fixturePath);
    const persisted = await request(base, item.mediaUrl, { headers });
    assert.equal(persisted.status, 200);
    assert.equal(sha256(persisted.bytes), digest);
    const draft = await json(base, `/api/content-library/${item.id}/publish-draft`, { headers });
    assert.equal(draft.sha256, digest);
    assertNoPublishTasks(databasePath);
  });

  await t.test('raw MP4 reception authenticates the actor and requires manual admission for every source', async () => {
    const receiveUrl = '/api/content-library/receive?source=editing&filename=received.mp4';
    const unauthenticated = await request(base, receiveUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: uploadBytes });
    assert.equal(unauthenticated.status, 401);
    const uploadHeaders = { ...headers, 'Content-Type': 'application/octet-stream' };
    for (const source of ['automatic', 'editing', 'creation']) {
      const received = await json(base, `/api/content-library/receive?${new URLSearchParams({ source, filename: 'received.mp4', title: 'Received media test', artifactType: 'final_video' })}`, {
        method: 'POST', headers: uploadHeaders, chunks: [uploadBytes.subarray(0, 100), uploadBytes.subarray(100)], timeoutMs: 20_000,
      });
      assert.equal(received.item.source, source);
      assert.equal(received.item.title, 'Received media test');
      assert.equal(received.item.sha256, uploadDigest);
      assert.equal(received.item.artifactType, 'final_video');
      assert.equal(received.item.admissionStatus, 'pending');
      assert.equal(received.item.receivedBy, username);
      assert.equal(received.item.admittedBy, null);
      assert.equal(received.item.sourceStatus, '接收产物 · 待确认');
      const draftUrl = `/api/content-library/${received.item.id}/publish-draft`;
      assert.equal((await request(base, draftUrl, { headers })).status, 409);
      assert.equal(sha256((await request(base, received.item.mediaUrl, { headers })).bytes), uploadDigest);
      await json(base, `/api/content-library/${received.item.id}/admission`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
      const draft = await json(base, draftUrl, { headers });
      assert.equal(draft.sha256, uploadDigest);
      assert.equal(draft.meta.name, 'received.mp4');
    }
    const repeated = await json(base, receiveUrl, { method: 'POST', headers: uploadHeaders, body: uploadBytes });
    assert.equal(repeated.item.artifactType, 'video_clip');
    assert.equal(repeated.item.admissionStatus, 'pending');
    assert.deepEqual(repeated.counts, { total: 5, approved: 4, pending: 1, rejected: 0 });
    assert.equal((await readdir(path.join(libraryRoot, 'media'))).length, 2);
    assert.deepEqual(await readdir(path.join(libraryRoot, 'incoming')), []);
    assertNoPublishTasks(databasePath);
  });

  await t.test('reception rejects unsafe metadata, invalid media and both declared and streamed size excess', async () => {
    const endpoint = '/api/content-library/receive?';
    const good = 'source=editing&filename=clip.mp4';
    const uploadHeaders = { ...headers, 'Content-Type': 'application/octet-stream' };
    const before = (await json(base, '/api/content-library', { headers })).counts;
    for (const query of [
      '', 'source=unknown&filename=clip.mp4', 'source=editing&filename=..%2Fclip.mp4',
      'source=editing&filename=..%5Cclip.mp4', 'source=editing&filename=clip%00.mp4',
      `${good}&filename=other.mp4`, `${good}&source=automatic`, `${good}&title=a&title=b`,
      `${good}&artifactType=video_clip&artifactType=final_video`, `${good}&artifactType=image`,
      `${good}&actor=forged`, `${good}&receivedBy=forged`, `${good}&admissionStatus=approved`,
      `${good}&path=/tmp/secret`, `${good}&url=https://example.invalid/file.mp4`,
    ]) {
      const invalid = await request(base, endpoint + query, { method: 'POST', headers: uploadHeaders, body: uploadBytes });
      assert.equal(invalid.status, 400, query);
      assert.equal(JSON.parse(invalid.bytes).code, 'CONTENT_RECEIVE_INVALID');
    }
    assert.equal((await request(base, endpoint + good, { method: 'POST', headers, body: uploadBytes })).status, 415);
    for (const options of [
      { body: Buffer.alloc(maxUploadBytes + 1), headers: { ...uploadHeaders, 'Content-Length': String(maxUploadBytes + 1) } },
      { chunks: [Buffer.alloc(maxUploadBytes), Buffer.from('x')], headers: uploadHeaders },
    ]) {
      const tooLarge = await request(base, endpoint + good, { method: 'POST', ...options });
      assert.equal(tooLarge.status, 413);
      assert.equal(JSON.parse(tooLarge.bytes).code, 'CONTENT_MEDIA_TOO_LARGE');
    }
    for (const body of [Buffer.alloc(0), Buffer.from('not a real mp4')]) {
      const invalid = await request(base, endpoint + good, { method: 'POST', headers: uploadHeaders, body });
      assert.equal(invalid.status, 400);
      assert.equal(JSON.parse(invalid.bytes).code, 'CONTENT_MEDIA_INVALID');
      assert.equal(invalid.bytes.toString().includes(directory), false);
    }
    assert.deepEqual((await json(base, '/api/content-library', { headers })).counts, before);
    assert.deepEqual(await readdir(path.join(libraryRoot, 'incoming')), []);
    assert.equal((await readdir(path.join(libraryRoot, 'media'))).length, 2);
    assertNoPublishTasks(databasePath);
  });

  await t.test('revoked library media cannot create immediate or scheduled tasks or trigger an existing schedule', async () => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      const account = db.prepare("SELECT id,device_id FROM accounts WHERE platform_code='douyin' ORDER BY id LIMIT 1").get();
      const stamp = new Date().toISOString();
      db.prepare("UPDATE accounts SET enabled=1,login_status='READY',login_checked_at=? WHERE id=?").run(stamp, account.id);
      db.prepare("UPDATE platforms SET desired_state='RUNNING',lifecycle_state='ACTIVE',runtime_updated_at=? WHERE code='douyin'").run(stamp);
      db.prepare("UPDATE devices SET status='ONLINE',last_heartbeat=? WHERE id=?").run(stamp, account.device_id);
      const draft = await json(base, `/api/content-library/${item.id}/publish-draft`, { headers });
      const title = '社区活动安排';
      const body = '本周社区活动开放报名，具体安排请以官方页面为准。';
      const precheck = await precheckMaterial({ materialPath: draft.materialPath, title, body, platforms: ['douyin'] });
      const payload = { title, body, materialPath: draft.materialPath, precheck,
        targets: [{ platformCode: 'douyin', accountId: account.id }], complianceConfirmed: true, publishMode: 'DRAFT_ONLY' };
      const scheduled = new Date(Date.now() + 60_000); scheduled.setMilliseconds(0);
      const schedulePayload = { ...payload, scheduledAt: scheduled.toISOString(), scheduledLocal: scheduled.toISOString().slice(0, 19), timezoneOffsetMinutes: 0 };
      const post = (url, data) => request(base, url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const createdSchedule = await post('/api/publish/schedules', schedulePayload);
      assert.equal(createdSchedule.status, 201, createdSchedule.bytes.toString());
      const scheduleId = JSON.parse(createdSchedule.bytes).schedule.id;
      await json(base, `/api/content-library/${item.id}/admission`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'rejected' }) });
      for (const sourceRef of [undefined, { source: 'editing', sourceId: 'forged-approved-source' }]) {
        for (const [url, data] of [['/api/publish/tasks', payload], ['/api/publish/schedules', schedulePayload]]) {
          const denied = await post(url, { ...data, sourceRef });
          assert.equal(denied.status, 409, denied.bytes.toString());
          assert.equal(JSON.parse(denied.bytes).code, 'CONTENT_ADMISSION_REQUIRED');
        }
      }
      // Make only this isolated test schedule due; the background scheduler must
      // refuse its stale approved draft without adding any publish task/job.
      db.prepare("UPDATE scheduled_publish_tasks SET scheduled_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), scheduleId);
      let record;
      const deadline = Date.now() + 5000;
      do {
        record = db.prepare('SELECT status,error_code FROM scheduled_publish_tasks WHERE id=?').get(scheduleId);
        if (record.status === 'FAILED') break;
        await pause(100);
      } while (Date.now() < deadline);
      assert.equal(record.status, 'FAILED');
      assert.equal(record.error_code, 'CONTENT_ADMISSION_REQUIRED');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publish_tasks').get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='PUBLISH'").get().count, 0);
      await json(base, `/api/content-library/${item.id}/admission`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved' }) });
      const changed = Buffer.from(fixtureBytes); changed[changed.length - 1] ^= 1;
      await writeFile(draft.materialPath, changed);
      const tampered = await post('/api/publish/tasks', { ...payload, precheck: { ...precheck, meta: { ...precheck.meta, sha256: sha256(changed) } } });
      assert.equal(tampered.status, 409);
      assert.equal(JSON.parse(tampered.bytes).code, 'CONTENT_FILE_CHANGED');
      await writeFile(draft.materialPath, fixtureBytes);
      await json(base, `/api/content-library/${item.id}/admission`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'pending' }) });
      const resubmitted = await post('/api/publish/tasks', payload);
      assert.equal(resubmitted.status, 409);
      assert.equal(JSON.parse(resubmitted.bytes).code, 'CONTENT_ADMISSION_REQUIRED');
      // The same bytes explicitly selected from an ordinary external file remain
      // governed by the existing precheck/AI review workflow.
      const external = path.join(directory, 'ordinary-material.mp4');
      await writeFile(external, fixtureBytes);
      const externalPrecheck = await precheckMaterial({ materialPath: external, title, body, platforms: ['douyin'] });
      const normal = await post('/api/publish/tasks', { ...payload, materialPath: external, precheck: externalPrecheck });
      assert.equal(normal.status, 201, normal.bytes.toString());
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publish_tasks').get().count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='PUBLISH'").get().count, 1);
      const queued = JSON.parse(db.prepare("SELECT payload FROM agent_jobs WHERE job_type='PUBLISH'").get().payload);
      assert.equal(queued.publishMode, 'DRAFT_ONLY');
      assert.equal(queued.managementConfirmed, false);
    } finally { db.close(); }
  });
});
