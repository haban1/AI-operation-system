import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getCreativeWorkbenchStatus } from '../src/services/creative-workbench.js';

async function server(t, handle) {
  const instance = createServer(handle);
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    instance.close(resolve);
    instance.closeAllConnections();
  }));
  return `http://127.0.0.1:${instance.address().port}`;
}

test('health connects to configured target while using the browser virtual Host', async t => {
  const seen = [];
  const target = await server(t, (request, response) => {
    seen.push({ host: request.headers.host, path: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization });
    response.writeHead(request.headers.host === '127.0.0.1:5199' ? 200 : 403, { 'Content-Type': 'text/html' });
    response.end('Local editor');
  });
  const result = await getCreativeWorkbenchStatus({ videoEditingUrl: 'http://127.0.0.1:5199/', videoEditingHealthUrl: `${target}/` });
  const editing = result.services.find(service => service.id === 'editing');
  assert.equal(editing.online, true);
  assert.equal(editing.url, 'http://127.0.0.1:5199/');
  assert.deepEqual(seen, [{ host: '127.0.0.1:5199', path: '/', cookie: undefined, authorization: undefined }]);
  assert.ok(!JSON.stringify(result).includes(target));
});

test('missing health overrides use the correct browser-origin health paths', async t => {
  const seen = [];
  const target = await server(t, (request, response) => {
    seen.push(request.url);
    if (request.url === '/api/health') response.end(JSON.stringify({ ok: true, service: 'AI Signal Studio' }));
    else response.end('<html>Editor</html>');
  });
  const result = await getCreativeWorkbenchStatus({
    aiSignalStudioUrl: `${target}/studio`, videoEditingUrl: `${target}/editor`, aigcCreationUrl: `${target}/canvas`,
  });
  assert.ok(result.services.every(service => service.online));
  assert.deepEqual(seen.sort(), ['/', '/', '/api/health']);
});

test('automatic health requires its exact identity and rejects oversized or invalid responses', async t => {
  let body = '';
  const target = await server(t, (_request, response) => response.end(body));
  for (const invalid of [
    'not JSON', '{}', JSON.stringify({ ok: 'true', service: 'AI Signal Studio' }),
    JSON.stringify({ ok: true, service: 'Other service' }),
    JSON.stringify({ ok: true, service: 'AI Signal Studio', padding: 'x'.repeat(16384) }),
  ]) {
    body = invalid;
    const result = await getCreativeWorkbenchStatus({ aiSignalStudioUrl: `${target}/` });
    assert.equal(result.services[0].online, false);
    assert.deepEqual(Object.keys(result.services[0]).sort(), ['id', 'online', 'product', 'title', 'url']);
  }
  body = JSON.stringify({ ok: true, service: 'AI Signal Studio', token: 'never-return-this' });
  const healthy = await getCreativeWorkbenchStatus({ aiSignalStudioUrl: `${target}/` });
  assert.equal(healthy.services[0].online, true);
  assert.ok(!JSON.stringify(healthy).includes('never-return-this'));
});

test('redirects are not followed and one unavailable service does not hide other statuses', async t => {
  let redirectedRequests = 0;
  const target = await server(t, (request, response) => {
    if (request.url === '/redirect-target') { redirectedRequests += 1; response.end('redirected'); return; }
    if (request.headers.host === '127.0.0.1:5199') {
      response.writeHead(302, { Location: '/redirect-target' }); response.end(); return;
    }
    if (request.url === '/api/health') response.end(JSON.stringify({ ok: true, service: 'AI Signal Studio' }));
    else response.end('Toonflow');
  });
  const result = await getCreativeWorkbenchStatus({
    aiSignalStudioUrl: 'http://127.0.0.1:8892/', aiSignalStudioHealthUrl: `${target}/api/health`,
    videoEditingUrl: 'http://127.0.0.1:5199/', videoEditingHealthUrl: `${target}/`,
    aigcCreationUrl: 'http://127.0.0.1:13000/', aigcCreationHealthUrl: `${target}/`,
  });
  assert.deepEqual(result.services.map(service => service.online), [true, false, true]);
  assert.equal(redirectedRequests, 0);
});

test('invalid endpoints and unset browser URLs stay offline without a request', async t => {
  let requests = 0;
  const target = await server(t, (_request, response) => { requests += 1; response.end('unexpected'); });
  for (const config of [
    { videoEditingHealthUrl: `${target}/` },
    { videoEditingUrl: `${target}/`, videoEditingHealthUrl: `${target}/private` },
    { videoEditingUrl: `${target}/?key=private` },
    { videoEditingUrl: 'file:///tmp/editor' },
    { videoEditingUrl: 'http://user:password@127.0.0.1/' },
    { aiSignalStudioUrl: `${target}/`, aiSignalStudioHealthUrl: `${target}/api/state` },
  ]) {
    const result = await getCreativeWorkbenchStatus(config);
    assert.ok(result.services.every(service => !service.online));
  }
  assert.equal(requests, 0);
});

test('a stalled automatic body times out after three seconds and falls back to offline', async t => {
  const target = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
  });
  const started = Date.now();
  const result = await getCreativeWorkbenchStatus({ aiSignalStudioUrl: `${target}/` });
  const elapsed = Date.now() - started;
  assert.equal(result.services[0].online, false);
  assert.ok(elapsed >= 2500 && elapsed < 6000, `unexpected timeout duration: ${elapsed} ms`);
});
