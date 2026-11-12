import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbench } from '../engines/montage15/src/server.mjs';

for (const embedded of [false, true]) test(`montage LAN host with authenticated mount=${embedded}`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-lan-'));
  const mountPath = embedded ? '/video-workbench/montage' : '';
  const app = await createWorkbench({ dataDir: dir, mountPath, authenticatedMount: embedded });
  const server = http.createServer(app.handle);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const host = '10.70.72.78:3100';
  const request = (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: mountPath + pathname, method, headers: { Host: host, ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const initial = await request('/api/bootstrap');
  assert.equal(initial.status, embedded ? 200 : 403);
  if (!embedded) return;
  const body = { name: 'LAN fixture', templateId: 'perspective-flow', format: 'landscape' };
  assert.equal((await request('/api/projects', { method: 'POST', body, headers: { Origin: `http://${host}` } })).status, 403);
  const headers = { Origin: `http://${host}`, 'x-workbench-token': initial.data.sessionToken, 'content-type': 'application/json' };
  assert.equal((await request('/api/projects', { method: 'POST', body, headers: { ...headers, Origin: 'http://foreign.invalid' } })).status, 403);
  assert.equal((await request('/api/projects', { method: 'POST', body, headers: { ...headers, Origin: `https://${host}` } })).status, 403);
  assert.equal((await request('/api/projects', { method: 'POST', body, headers })).status, 201);
  assert.equal((await request('/api/bootstrap')).data.projects.length, 1);
});
