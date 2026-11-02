import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startServer, jsonRequest, stopChild, tempRuntimeDir, cleanupDir } from './helpers/runtime.js';
import { prepareRemoteJobMaterial } from '../agent/remote-job-material.js';

test('platform routes use bound Windows agent while media stays in container', async t => {
  const token = 'test-only-browser-binding';
  const bindingId = createHash('sha256').update(`device-rpa-01\0${token}`).digest('hex').slice(0, 24);
  let validBinding = true;
  const calls = [];
  const browser = http.createServer((req, res) => {
    calls.push({ path: req.url, token: req.headers['x-agent-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, deviceId: 'device-rpa-01',
      bindingId: validBinding ? bindingId : 'other-installation', role: 'browser', rpaMode: 'five_platform_assisted' }));
    res.end(JSON.stringify({ ok: true, status: { state: 'LOGIN', browser: 'OPEN' } }));
  });
  await new Promise(resolve => browser.listen(0, '127.0.0.1', resolve));
  const dir = tempRuntimeDir();
  let runtime;
  t.after(async () => { await stopChild(runtime?.child); await new Promise(resolve => browser.close(resolve)); cleanupDir(dir); });
  runtime = await startServer({ dir, env: { AGENT_SHARED_TOKEN: token,
    BROWSER_AGENT_URL: `http://127.0.0.1:${browser.address().port}`, RPA_MODE: 'five_platform_assisted' } });
  await jsonRequest(runtime.base, '/api/settings/operations', { method: 'POST', body: { enabled: true } });
  const opened = await jsonRequest(runtime.base, '/api/local-agent/platforms/douyin/open-login', { method: 'POST', body: {} });
  assert.equal(opened.response.status, 200);
  assert.equal(calls.find(item => item.path.endsWith('/open-login')).token, token);
  const bootstrap = await jsonRequest(runtime.base, '/api/bootstrap');
  assert.equal(bootstrap.data.localAgent.online, true);
  assert.equal(bootstrap.data.localAgent.executionHost, 'Windows Chrome');
  assert.equal(JSON.stringify(bootstrap.data).includes(token), false);
  const precheck = await jsonRequest(runtime.base, '/api/local-agent/precheck', { method: 'POST', body: {} });
  assert.equal(precheck.response.status, 503); // no material agent in this test
  assert.equal(calls.some(item => item.path === '/precheck'), false);
  validBinding = false;
  const blocked = await jsonRequest(runtime.base, '/api/local-agent/platforms/douyin/open-login', { method: 'POST', body: {} });
  assert.equal(blocked.response.status, 503);
  assert.equal(calls.filter(item => item.path.endsWith('/open-login')).length, 1);
});

test('job material handoff checks authentication, lease, device, roots and SHA before Windows upload', async t => {
  const dir = tempRuntimeDir();
  const uploadDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir);
  const media = Buffer.from('verified-media-content');
  const materialPath = path.join(uploadDir, 'video.mp4');
  fs.writeFileSync(materialPath, media);
  const sha256 = createHash('sha256').update(media).digest('hex');
  const token = 'test-only-material-handoff';
  let runtime, db;
  t.after(async () => { db?.close(); await stopChild(runtime?.child); cleanupDir(dir); });
  runtime = await startServer({ dir, env: { AGENT_SHARED_TOKEN: token, MATERIAL_UPLOAD_DIR: uploadDir } });
  await jsonRequest(runtime.base, '/api/settings/operations', { method: 'POST', body: { enabled: true } });
  db = new DatabaseSync(runtime.dbPath);
  const payload = { platformCode: 'douyin', materialPath, materialSha256: sha256, draftFingerprint: { fingerprintHash: 'keep-original' } };
  const id = Number(db.prepare(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,lease_expires_at)
    VALUES('device-rpa-01','PUBLISH',?,'RUNNING',?,?)`).run(JSON.stringify(payload), new Date().toISOString(), new Date(Date.now() + 600_000).toISOString()).lastInsertRowid);
  const route = `/api/agent/jobs/${id}/material?deviceId=device-rpa-01`;
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(runtime.base + route)).status, 401);
  assert.equal((await fetch(runtime.base + route.replace('device-rpa-01', 'wrong'), { headers })).status, 404);
  const job = { id, job_type: 'PUBLISH', payload };
  const prepared = await prepareRemoteJobMaterial(job, { baseUrl: runtime.base, token, deviceId: 'device-rpa-01',
    cacheDir: path.join(dir, 'cache'), maxBytes: 1024 });
  assert.deepEqual(fs.readFileSync(prepared.payload.materialPath), media);
  assert.deepEqual(prepared.payload.draftFingerprint, payload.draftFingerprint);
  assert.equal(job.payload.materialPath, materialPath);
  db.prepare("UPDATE agent_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
  assert.equal((await fetch(runtime.base + route, { headers })).status, 409);
  await assert.rejects(() => prepareRemoteJobMaterial(job, { baseUrl: runtime.base, token, deviceId: 'device-rpa-01',
    cacheDir: path.join(dir, 'cache'), maxBytes: 1024 }), /HTTP 409/);
  db.prepare('UPDATE agent_jobs SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() + 600_000).toISOString(), id);
  fs.writeFileSync(materialPath, 'changed');
  assert.equal((await fetch(runtime.base + route, { headers })).status, 409);
  const outside = path.join(dir, 'outside.mp4');
  fs.writeFileSync(outside, media);
  db.prepare('UPDATE agent_jobs SET payload=? WHERE id=?').run(JSON.stringify({ ...payload, materialPath: outside }), id);
  assert.equal((await fetch(runtime.base + route, { headers })).status, 403);
});
