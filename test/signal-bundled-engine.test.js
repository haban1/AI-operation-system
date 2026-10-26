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

// Deployment-only integration coverage: this suite needs Python and FFmpeg.
// It starts the shipped engine, but never invokes model, speech or publish APIs.
const repoRoot = path.resolve(import.meta.dirname, '..');
const bundledRoot = path.join(repoRoot, 'engines', 'ai-signal-studio');
const prefix = '/integrations/ai-signal/';
const fixtureId = 'bundled-engine-local-fixture';
const username = 'bundled-engine-test';
const password = 'test-only-password';
const execFileAsync = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function request(base, requestPath, { method = 'GET', headers = {}, body = '', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base, { path: requestPath, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out: ${requestPath}`)));
    req.once('error', reject);
    req.end(body);
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
        CONTENT_LIBRARY_DIR: libraryRoot, CONTENT_LIBRARY_SIGNAL_ROOT: engineRoot, CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '',
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

  await t.test('shared library imports verified bytes and prepares a draft without publishing', async () => {
    const synced = await json(base, '/api/content-library/sync', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 20_000 });
    assert.equal(synced.items.length, 1, JSON.stringify(synced.sources));
    [item] = synced.items;
    assert.equal(item.source, 'automatic');
    assert.equal(item.sourceId, fixtureId);
    assert.equal(item.artifactType, 'final_video');
    assert.equal(item.sha256, digest);
    assert.equal(item.sizeBytes, fixtureBytes.length);
    assert.equal((await request(base, item.mediaUrl)).status, 401);
    const draftUrl = `/api/content-library/${item.id}/publish-draft`;
    assert.equal((await request(base, draftUrl)).status, 401);
    const media = await request(base, item.mediaUrl, { headers });
    assert.equal(media.status, 200);
    assert.equal(sha256(media.bytes), digest);
    const partial = await request(base, item.mediaUrl, { headers: { ...headers, Range: 'bytes=0-31' } });
    assert.equal(partial.status, 206);
    assert.deepEqual(partial.bytes, fixtureBytes.subarray(0, 32));
    const draft = await json(base, draftUrl, { headers });
    assert.equal(draft.requiresPrecheck, true);
    assert.equal(draft.sha256, digest);
    assert.deepEqual(draft.sourceRef, { source: 'automatic', sourceId: fixtureId });
    assert.equal(path.dirname(draft.materialPath), path.join(libraryRoot, 'media'));
    assert.equal(sha256(await readFile(draft.materialPath)), digest);
    assert.notEqual(draft.materialPath, fixturePath);
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
});
