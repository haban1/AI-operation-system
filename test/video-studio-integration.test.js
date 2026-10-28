import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNT = '/video-workbench';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startIsolatedServer(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'video-studio-main-test-'));
  const materials = path.join(dir, 'materials');
  await mkdir(materials);
  // The test checks file serving and category metadata, without starting a thumbnail job.
  await writeFile(path.join(materials, 'FV4A8209.JPG'), Buffer.from('source-image-fixture'));
  const port = await freePort();
  const agentPort = await freePort();
  const password = `test-password-${randomUUID()}`;
  const relaySecret = `test-relay-secret-${randomUUID()}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port), SERVER_HOST: '127.0.0.1',
      AGENT_PORT: String(agentPort),
      DATABASE_PATH: path.join(dir, 'isolated.sqlite3'),
      CONTENT_LIBRARY_DIR: path.join(dir, 'content-library'),
      CONTENT_LIBRARY_SIGNAL_ROOT: '', CONTENT_LIBRARY_EDITING_ROOT: '', CONTENT_LIBRARY_CREATION_ROOT: '',
      VIDEO_STUDIO_DATA_DIR: path.join(dir, 'video-studio'),
      VIDEO_STUDIO_UPSTREAM_URL: '',
      VIDEO_MATERIALS_DIR: materials,
      VIDEO_RELAY_API_KEY: relaySecret,
      VIDEO_RELAY_BASE_URL: 'https://relay.invalid/v1',
      VIDEO_RELAY_MODEL: 'test-model-no-call',
      AUTH_ENABLED: 'true', ADMIN_USERNAME: 'video-test-admin', ADMIN_PASSWORD: password,
      SESSION_SECRET: `test-session-${randomUUID()}`,
      INSTANCE_LOCK_ENABLED: 'false',
      AUTO_COLLECT_ENABLED: 'false', LOCAL_AGENT_AUTO_START: 'false',
      QWEN_MODE: 'mock', QWEN_API_KEY: '', DASHSCOPE_API_KEY: '',
      RAG_BASE_URL: '', RAG_TOKEN: '', RAG_ADMIN_ENABLED: 'false', RAG_FORMAL_ROUTING_ENABLED: 'false',
      WECOM_WEBHOOK_URL: '', WECHAT_ROBOT_ADMIN_URL: '', MINI_PROGRAM_API_ENABLED: 'false',
      BROWSER_CONTROL_ENABLED: 'false', BROWSER_CONTROL_PROXY_AUTO_START: 'false',
      AI_AUDIO_CONTENT_AUTO_TRIGGER: 'false', AI_TRAFFIC_PREDICTION_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Isolated business server exited before ready:\n${logs}`);
    try {
      const response = await fetch(base + '/api/auth/session', { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return { base, password, relaySecret, materials };
    } catch {}
    await delay(100);
  }
  assert.fail(`Isolated business server did not become ready:\n${logs}`);
}

test('authenticated main-system mount serves six bundled videos and prefixed media APIs without exposing relay secrets', { timeout: 90000 }, async t => {
  const { base, password, relaySecret } = await startIsolatedServer(t);
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'engines/video-studio/bundled/manifest.json'), 'utf8'));
  assert.equal(manifest.videos.length, 6);

  await t.test('all mounted pages, APIs and bundled media require the business login', async () => {
    for (const suffix of ['/', '/app.js', '/api/studio/bootstrap', '/api/studio/outputs', manifest.videos[0].videoPath]) {
      const response = await fetch(base + MOUNT + suffix);
      assert.equal(response.status, 401, `Unauthenticated ${suffix}`);
      await response.arrayBuffer();
    }
    const response = await fetch(base + MOUNT + '/api/chat/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
    for (const prefix of ['', MOUNT]) {
      const list = await fetch(base + prefix + '/api/studio/outputs');
      assert.equal(list.status, 401); await list.arrayBuffer();
      const materials = await fetch(base + prefix + '/api/studio/materials');
      assert.equal(materials.status, 401); await materials.arrayBuffer();
      const confirm = await fetch(base + prefix + '/api/studio/outputs/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":["v5-01"]}' });
      assert.equal(confirm.status, 401); await confirm.arrayBuffer();
    }
  });

  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'video-test-admin', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'The main-system login creates an authenticated session');
  await login.arrayBuffer();
  const request = (suffix, options = {}) => fetch(base + MOUNT + suffix, { ...options, headers: { Cookie: cookie, ...options.headers } });
  let bootstrap;

  await t.test('opening publishing directly discovers six pending materials without approving them', async () => {
    const response = await fetch(base + '/api/content-library', { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const library = await response.json();
    assert.deepEqual(library.counts, { total: 6, approved: 0, pending: 6, rejected: 0 });
    assert.ok(library.pendingItems.every(item => item.receivedBy === 'video-studio-discovery' && item.admittedBy === null));
    const draft = await fetch(base + `/api/content-library/${library.pendingItems[0].id}/publish-draft`, { headers: { Cookie: cookie } });
    assert.equal(draft.status, 409); await draft.arrayBuffer();
    const shared = await fetch(base + '/api/studio/materials', { headers: { Cookie: cookie } });
    assert.equal(shared.status, 200);
    const materials = await shared.json();
    assert.equal(materials.items.length, 6);
    assert.ok(materials.items.every(item => item.source === 'mix' && item.materialId && item.status === 'pending'));
  });

  await t.test('the mounted page and script use the deployment path', async () => {
    const redirect = await fetch(base + MOUNT, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), MOUNT + '/');
    const page = await request('/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /成片库/);
    assert.match(html, /视频制作/);
    assert.match(html, /素材库/);
    assert.match(html, /src="\.\/app\.js"/);
    const script = await request('/app.js');
    assert.equal(script.status, 200);
    const js = await script.text();
    assert.match(js, /location\.pathname/);
    assert.match(js, /API_BASE/);
    assert.match(js, /\/api\/studio\/bootstrap/);
    assert.ok(!html.includes(relaySecret) && !js.includes(relaySecret));
  });

  await t.test('bootstrap returns six deployable videos, six Skills, and four honest tool statuses', async () => {
    const response = await request('/api/studio/bootstrap');
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.ok(!serialized.includes(relaySecret), 'The relay key must never enter bootstrap');
    assert.ok(!serialized.includes(password));
    bootstrap = JSON.parse(serialized);
    assert.equal(bootstrap.videos.filter(video => video.bundled).length, 6);
    assert.equal(bootstrap.skills.length, 6);
    assert.equal(new Set(bootstrap.skills.map(skill => skill.id)).size, 6);
    for (const id of ['codex', 'chatcut', 'remotion', 'hyperframes']) assert.ok(bootstrap.tools.some(tool => tool.id === id), `${id} tool status`);
    for (const video of bootstrap.videos.filter(video => video.bundled)) {
      assert.ok(video.videoPath.startsWith(MOUNT + '/api/studio/outputs/'));
      assert.ok(video.posterPath.startsWith(MOUNT + '/bundled/posters/'));
      assert.ok(video.bytes > 0);
    }
  });

  await t.test('all six bundled videos support actual byte ranges through the authenticated mount', async () => {
    for (const video of manifest.videos) {
      const response = await request(video.videoPath, { headers: { Range: 'bytes=0-31' } });
      assert.equal(response.status, 206, video.id);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      assert.equal(response.headers.get('content-range'), `bytes 0-31/${video.bytes}`);
      const content = Buffer.from(await response.arrayBuffer());
      assert.equal(content.length, 32);
      assert.ok(content.includes(Buffer.from('ftyp')), `${video.id} starts with an MP4 header`);
      const poster = await request(video.posterPath, { method: 'HEAD' });
      assert.equal(poster.status, 200);
      assert.equal(poster.headers.get('content-type'), 'image/jpeg');
    }
    const invalid = await request(manifest.videos[0].videoPath, { headers: { Range: 'bytes=999999999999-' } });
    assert.equal(invalid.status, 416);
    await invalid.arrayBuffer();
  });

  await t.test('mapped material URLs retain the mount prefix and block traversal', async () => {
    const listing = await request('/api/media?collectionId=classroom-202607');
    assert.equal(listing.status, 200);
    const { entries } = await listing.json();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].category, '场地环境');
    assert.ok(entries[0].url.startsWith(MOUNT + '/api/media/file?'));
    const file = await fetch(base + entries[0].url, { headers: { Cookie: cookie } });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'source-image-fixture');
    const traversal = await request('/api/media/file?collectionId=classroom-202607&path=' + encodeURIComponent('../isolated.sqlite3'));
    assert.equal(traversal.status, 403);
    await traversal.arrayBuffer();
  });

  await t.test('session creation is authenticated and does not start a model or disclose its credential', async () => {
    const response = await request('/api/chat/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'isolated test only', skillIds: ['chatcut-source-pack-01'] }),
    });
    assert.equal(response.status, 201);
    const text = await response.text();
    assert.ok(!text.includes(relaySecret));
    const session = JSON.parse(text);
    assert.equal(session.status, 'idle');
    assert.equal(session.threadId, null);
    const read = await request('/api/chat/sessions/' + session.id);
    assert.equal(read.status, 200);
    const stored = await read.json();
    assert.equal(stored.messages.length, 0);
  });

  await t.test('only human confirmation approves a discovered material while the system is globally paused', async () => {
    const paused = await fetch(base + '/api/settings/operations', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, updatedBy: 'isolated-video-test' }),
    });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).settings.enabled, false);
    const initial = await (await request('/api/studio/outputs')).json();
    assert.equal(initial.items.length, 6);
    assert.ok(initial.items.every(item => item.status === 'pending'));
    const pendingLibrary = await (await fetch(base + '/api/content-library', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(pendingLibrary.counts, { total: 6, approved: 0, pending: 6, rejected: 0 });
    const forged = await request('/api/studio/outputs/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['v5-04'], path: '/tmp/forged.mp4' }),
    });
    assert.equal(forged.status, 400); await forged.arrayBuffer();
    const confirmed = await request('/api/studio/outputs/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['v5-04', 'missing-output'] }),
    });
    assert.equal(confirmed.status, 200);
    const batch = await confirmed.json();
    assert.deepEqual(batch.results.map(item => item.ok), [true, false]);
    const materialId = batch.results[0].materialId;
    const library = await (await fetch(base + '/api/content-library', { headers: { Cookie: cookie } })).json();
    assert.deepEqual(library.counts, { total: 6, approved: 1, pending: 5, rejected: 0 });
    assert.equal(library.items[0].id, materialId);
    assert.equal(library.items[0].admittedBy, 'video-test-admin');
    const list = await (await request('/api/studio/outputs')).json();
    assert.equal(list.items.find(item => item.id === 'v5-04').status, 'approved');
    assert.equal(list.items.filter(item => item.status === 'pending').length, 5);
    const draft = await fetch(base + `/api/content-library/${materialId}/publish-draft`, { headers: { Cookie: cookie } });
    assert.equal(draft.status, 200);
    assert.equal((await draft.json()).requiresPrecheck, true);
  });
});
