// Run inside the Tianhe web container after generating a sample in the UI.
// Reads existing administrator configuration; never prints credentials or cookies.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:3100';
const sampleId = process.argv[2];
assert.match(sampleId || '', /^[a-f0-9-]{36}$/, 'Pass the sample project ID');
const report = { checkedAt: new Date().toISOString(), projectId: sampleId, checks: [] };
const record = name => report.checks.push(name);
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD }),
  signal: AbortSignal.timeout(10000),
});
assert.equal(login.status, 200, 'Tianhe login');
const cookie = login.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'Administrator session required');
await login.body.cancel();
async function request(route, options = {}) {
  return fetch(`${base}${route}`, { ...options, redirect: 'error',
    headers: { Cookie: cookie, Origin: base, ...options.headers }, signal: AbortSignal.timeout(60000) });
}
async function json(route, options = {}) {
  const response = await request(route, options);
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}
for (const route of ['/api/ai-studio/projects', `/api/ai-studio/projects/${sampleId}/media/video`]) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 401, 'Anonymous access must be denied');
  await response.body.cancel();
}
record('Anonymous API and media access denied');
const workbench = await json('/api/creative-workbench/status');
assert.equal(workbench.services.length, 3);
assert.ok(workbench.services.every(service => service.online), 'All three engines online');
report.services = workbench.services.map(({ id, online }) => ({ id, online }));
record('Three creative engines online');
const status = await json('/api/ai-studio/status');
assert.equal(status.implementation, 'tianhe-local');
assert.ok(status.model.configured && status.model.online);
report.model = status.model.model;
record('Shared Tianhe model configured and online');
const { project } = await json(`/api/ai-studio/projects/${sampleId}`);
assert.equal(project.status, 'completed', 'Sample video completed');
assert.ok(project.script.scenes.length >= 2 && project.runId);
report.runId = project.runId;
report.title = project.script.title;
report.media = project.media;
const media = `/api/ai-studio/projects/${sampleId}/media/`;
const head = await request(`${media}video`, { method: 'HEAD' });
assert.equal(head.status, 200);
assert.equal(Number(head.headers.get('content-length')), project.media.sizeBytes);
for (const range of ['bytes=0-1023', 'bytes=-1024']) {
  const response = await request(`${media}video`, { headers: { Range: range } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
}
const invalid = await request(`${media}video`, { headers: { Range: `bytes=${project.media.sizeBytes}-` } });
assert.equal(invalid.status, 416);
await invalid.body.cancel();
const video = Buffer.from(await (await request(`${media}video`)).arrayBuffer());
assert.equal(video.length, project.media.sizeBytes);
const sha256 = createHash('sha256').update(video).digest('hex');
assert.equal((await json(`${media}script`)).title, project.script.title);
const subtitles = await request(`${media}subtitles`);
assert.equal(subtitles.status, 200);
assert.match(await subtitles.text(), /00:00:00,000 -->/);
const poster = await request(`${media}poster`);
assert.equal(poster.status, 200);
assert.equal(Buffer.from(await poster.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
record('MP4, poster, script and subtitles downloadable; byte ranges valid');
const library = await json('/api/content-library/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const item = library.items.find(value => value.source === 'automatic' && value.sourceId === project.runId);
assert.ok(item, 'Completed sample imported into content library');
assert.equal(item.sha256, sha256);
const imported = Buffer.from(await (await request(item.mediaUrl)).arrayBuffer());
assert.equal(createHash('sha256').update(imported).digest('hex'), sha256);
report.libraryId = item.id;
report.sha256 = sha256;
record('Content library contains byte-identical video');
await writeFile('/app/data/ai-studio-live-verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
