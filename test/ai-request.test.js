import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAi } from '../src/services/ai-request.js';
import { aiHttpError } from '../src/services/ai-http-error.js';

const url = 'https://provider.test/v1/chat/completions';
const options = () => ({ method: 'POST', body: '{"messages":[]}', signal: AbortSignal.timeout(5000) });
const readJson = async response => {
  if (!response.ok) throw await aiHttpError(response, { operation: '文案生成', code: 'CONTENT_HTTP_ERROR' });
  return response.json();
};

for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) {
  test(`generation recovers from ${code} with the same request and deadline`, async () => {
    const request = options();
    let attempts = 0;
    const result = await requestAi(url, request, async (target, sent) => {
      assert.equal(target, url);
      assert.equal(sent, request);
      attempts += 1;
      if (attempts === 1) throw new TypeError('fetch failed', { cause: { code } });
      return Response.json({ result: 'ready' });
    }, readJson);
    assert.deepEqual(result, { result: 'ready' });
    assert.equal(attempts, 2);
  });
}

test('retries a dropped response body, not only the initial fetch', async () => {
  let attempts = 0;
  const result = await requestAi(url, options(), async () => {
    attempts += 1;
    if (attempts > 1) return Response.json({ result: 'complete' });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"result":'));
      controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
    } }));
  }, readJson);
  assert.deepEqual(result, { result: 'complete' });
  assert.equal(attempts, 2);
});

test('persistent reset stops after two attempts and preserves safe diagnosis', async () => {
  let attempts = 0;
  await assert.rejects(requestAi(url, options(), async () => {
    attempts += 1;
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  }, readJson), error => {
    assert.equal(error.code, 'AI_NETWORK_ERROR');
    assert.equal(error.networkCode, 'ECONNRESET');
    assert.match(error.message, /连接失败/);
    assert.doesNotMatch(error.message, /fetch failed|provider.test/);
    return true;
  });
  assert.equal(attempts, 2);
});

for (const status of [401, 402, 403]) {
  test(`does not resubmit HTTP ${status}`, async () => {
    let attempts = 0;
    await assert.rejects(requestAi(url, options(), async () => {
      attempts += 1;
      return Response.json({ error: { message: 'private upstream detail' } }, { status });
    }, readJson));
    assert.equal(attempts, 1);
  });
  test(`does not resubmit HTTP ${status} when its error body is disconnected`, async () => {
    let attempts = 0;
    await assert.rejects(requestAi(url, options(), async () => {
      attempts += 1;
      return new Response(new ReadableStream({ start(controller) {
        controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
      } }), { status });
    }, readJson), error => {
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
    assert.equal(attempts, 1);
  });
}

test('does not retry malformed JSON or certificate errors', async () => {
  for (const fetchImpl of [async () => new Response('{'), async () => {
    throw new TypeError('certificate rejected', { cause: { code: 'CERT_HAS_EXPIRED' } });
  }]) {
    let attempts = 0;
    await assert.rejects(requestAi(url, options(), (...args) => { attempts += 1; return fetchImpl(...args); }, readJson));
    assert.equal(attempts, 1);
  }
});

test('expired total deadline prevents retry during backoff', async () => {
  let attempts = 0;
  const signal = AbortSignal.timeout(30);
  await assert.rejects(requestAi(url, { ...options(), signal }, async () => {
    attempts += 1;
    throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  }, readJson), { name: 'AbortError' });
  assert.equal(attempts, 1);
});
