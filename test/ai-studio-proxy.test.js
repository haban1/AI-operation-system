import test from 'node:test';
import assert from 'node:assert/strict';
import { studioProxyRoute } from '../src/services/ai-studio-proxy.js';
const id = 'a64c7409-92cb-44dc-8e3e-ffb0e5deae96';
test('AI Studio proxy exposes only fixed service routes', () => {
  assert.equal(studioProxyRoute('GET', '/api/ai-studio/status'), '/api/status');
  assert.equal(studioProxyRoute('POST', `/api/ai-studio/projects/${id}/render`), `/api/projects/${id}/render`);
  assert.equal(studioProxyRoute('GET', `/api/ai-studio/projects/${id}/media/video`), `/api/projects/${id}/media/video`);
  for (const [method, route, query] of [
    ['GET', '/api/ai-studio/../status', ''], ['GET', '/api/ai-studio/status', '?url=http://other'],
    ['DELETE', `/api/ai-studio/projects/${id}`, ''], ['GET', `/api/ai-studio/projects/${id}/media/credentials`, ''],
    ['POST', '/api/model/v1/chat/completions', ''],
  ]) assert.equal(studioProxyRoute(method, route, query), null);
});
