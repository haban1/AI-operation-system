import crypto from 'node:crypto';
import { config } from '../config.js';

export const RAG_CONTRACT_VERSION = '1.0';
export const RAG_RESULT = Object.freeze({
  ANSWERED: 'ANSWERED', NO_ANSWER: 'NO_ANSWER', NEED_CLARIFICATION: 'NEED_CLARIFICATION', REJECTED: 'REJECTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED', NOT_READY: 'NOT_READY', UNAVAILABLE: 'UNAVAILABLE', INVALID_RESPONSE: 'INVALID_RESPONSE'
});

function requestId(prefix = 'rag') { return `${prefix}-${crypto.randomUUID()}`; }
function cleanBaseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
function safeJson(text) { try { return text ? JSON.parse(text) : {}; } catch { return null; } }
function notConfigured() { return { status: RAG_RESULT.NOT_CONFIGURED, answerable: false, retryable: false, error: { code: 'RAG_NOT_CONFIGURED', message: '本地 RAG 服务尚未配置' } }; }
function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  const text = query.toString();
  return text ? `?${text}` : '';
}

export class RagClient {
  constructor({ baseUrl = config.ragBaseUrl, token = config.ragToken, timeoutMs = config.ragTimeoutMs, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.token = String(token || '').trim();
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || config.ragTimeoutMs);
    this.fetchImpl = fetchImpl;
  }

  get configured() { return Boolean(this.baseUrl); }

  async request(pathname, { method = 'GET', body = undefined, requestId: suppliedRequestId = null, headers: suppliedHeaders = {} } = {}) {
    if (!this.configured) return notConfigured();
    const id = suppliedRequestId || requestId('rag-request');
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = { 'X-Contract-Version': RAG_CONTRACT_VERSION, 'X-Request-Id': id, ...suppliedHeaders };
    if (!isFormData && body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : (isFormData || typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const raw = await response.text();
      const data = safeJson(raw);
      if (!data) return { status: RAG_RESULT.INVALID_RESPONSE, answerable: false, retryable: false, httpStatus: response.status, requestId: id, error: { code: 'RAG_INVALID_JSON', message: 'RAG 返回了无法解析的 JSON' } };
      if (!response.ok) {
        return {
          status: RAG_RESULT.UNAVAILABLE, answerable: false, retryable: [429, 500, 502, 503, 504].includes(response.status),
          httpStatus: response.status, requestId: id,
          error: data.error || data.detail?.error || { code: `RAG_HTTP_${response.status}`, message: data.message || data.detail?.message || 'RAG 请求失败' }, raw: data
        };
      }
      return { ...data, requestId: data.requestId || id, httpStatus: response.status };
    } catch (error) {
      const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return { status: RAG_RESULT.UNAVAILABLE, answerable: false, retryable: true, requestId: id, error: { code: timeout ? 'RAG_EXECUTION_TIMEOUT' : 'RAG_UNAVAILABLE', message: String(error?.message || 'RAG 服务不可用').slice(0, 1000) } };
    }
  }

  async healthCheck() {
    const result = await this.request('/rag-api/v1/health');
    if (result.status === RAG_RESULT.NOT_CONFIGURED) return result;
    return { ...result, answerable: result.status === 'READY', retryable: result.status !== 'READY' };
  }

  async systemStatus() { return this.request('/rag-admin-api/v1/system/status'); }
  async listDocuments({ knowledgeBaseId = 'main-business-kb' } = {}) { return this.request(`/rag-admin-api/v1/documents${queryString({ knowledge_base_id: knowledgeBaseId })}`); }
  async getDocument({ documentId, version = null } = {}) {
    if (!String(documentId || '').trim()) throw new Error('documentId 不能为空');
    return this.request(`/rag-admin-api/v1/documents/${encodeURIComponent(documentId)}${queryString({ version })}`);
  }
  async getDocumentChunks({ documentId, version = null } = {}) {
    if (!String(documentId || '').trim()) throw new Error('documentId 不能为空');
    return this.request(`/rag-admin-api/v1/documents/${encodeURIComponent(documentId)}/chunks${queryString({ version })}`);
  }
  async deleteDocument({ documentId } = {}) {
    if (!String(documentId || '').trim()) throw new Error('documentId 不能为空');
    return this.request(`/rag-admin-api/v1/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
  }
  async uploadDocument({ content, filename, mimeType = 'application/octet-stream', metadata = {}, requestId: suppliedRequestId = null } = {}) {
    if (content === undefined || content === null) throw new Error('上传文件内容不能为空');
    const id = suppliedRequestId || metadata.requestId || requestId('rag-document');
    const form = new FormData();
    form.append('file', new Blob([content], { type: mimeType }), String(filename || 'uploaded.bin'));
    form.append('metadata', JSON.stringify({ ...metadata, requestId: id }));
    return this.request('/rag-admin-api/v1/documents', { method: 'POST', body: form, requestId: id });
  }

  async queryFormalKnowledge(input = {}) {
    const payload = { contractVersion: RAG_CONTRACT_VERSION, requestId: input.requestId || requestId('rag-query'), ...input };
    const result = await this.request('/rag-api/v1/query', { method: 'POST', body: payload, requestId: payload.requestId });
    if ([RAG_RESULT.NOT_CONFIGURED, RAG_RESULT.UNAVAILABLE, RAG_RESULT.INVALID_RESPONSE].includes(result.status)) return result;
    const outcome = String(result.result || result.status || '').toUpperCase();
    return { ...result, status: outcome || RAG_RESULT.INVALID_RESPONSE, answerable: outcome === RAG_RESULT.ANSWERED && Boolean(result.answer?.text), retryable: false };
  }

  async createTestSession({ requestId: suppliedRequestId, knowledgeBaseId = 'main-business-kb', mode = 'PRE_RELEASE', baseReleaseId = null, candidateDocuments = [], operatorId = 'local-operator' } = {}) {
    const payload = { requestId: suppliedRequestId || requestId('rag-test-session'), knowledgeBaseId, mode, baseReleaseId, candidateDocuments, operatorId };
    return this.request('/rag-admin-api/v1/test-sessions', { method: 'POST', body: payload, requestId: payload.requestId });
  }
  async getTestSession({ testSessionId } = {}) {
    if (!String(testSessionId || '').trim()) throw new Error('testSessionId 不能为空');
    return this.request(`/rag-admin-api/v1/test-sessions/${encodeURIComponent(testSessionId)}`);
  }
  async deleteTestSession() { return { deleted: false, remoteManaged: true }; }
  async queryTestKnowledge({ testSessionId, requestId: suppliedRequestId, question, context = [] } = {}) {
    if (!String(testSessionId || '').trim()) throw new Error('testSessionId 不能为空');
    const payload = { requestId: suppliedRequestId || requestId('rag-test-query'), question, context };
    const result = await this.request(`/rag-admin-api/v1/test-sessions/${encodeURIComponent(testSessionId)}/query`, { method: 'POST', body: payload, requestId: payload.requestId });
    if ([RAG_RESULT.NOT_CONFIGURED, RAG_RESULT.UNAVAILABLE, RAG_RESULT.INVALID_RESPONSE].includes(result.status)) return result;
    const outcome = String(result.result || result.status || '').toUpperCase();
    return { ...result, status: outcome || RAG_RESULT.INVALID_RESPONSE, answerable: outcome === RAG_RESULT.ANSWERED && Boolean(result.answer?.text), retryable: false };
  }
  async listTestAnswers({ testSessionId } = {}) {
    if (!String(testSessionId || '').trim()) throw new Error('testSessionId 不能为空');
    return this.request(`/rag-admin-api/v1/test-sessions/${encodeURIComponent(testSessionId)}/answers`);
  }
  async getTestAnswerHistory({ testSessionId, answerId } = {}) {
    if (!String(testSessionId || '').trim() || !String(answerId || '').trim()) throw new Error('测试会话和答案不能为空');
    return this.request(`/rag-admin-api/v1/test-sessions/${encodeURIComponent(testSessionId)}/answers/${encodeURIComponent(answerId)}/history`);
  }
  async updateTestDecision({ testSessionId, answerId, requestId: suppliedRequestId, decision, reasonCode = null, note = null, operatorId = 'local-operator' } = {}) {
    if (!String(testSessionId || '').trim() || !String(answerId || '').trim()) throw new Error('测试会话和答案不能为空');
    const payload = { requestId: suppliedRequestId || requestId('rag-test-decision'), decision, reasonCode, note, operatorId };
    return this.request(`/rag-admin-api/v1/test-sessions/${encodeURIComponent(testSessionId)}/answers/${encodeURIComponent(answerId)}/decision`, { method: 'PUT', body: payload, requestId: payload.requestId });
  }

  async createRelease({ knowledgeBaseId = 'main-business-kb', requestId: suppliedRequestId, testSessionId, baseReleaseId = null, candidateDocuments = [], publishedBy = 'local-operator', publishNote = '' } = {}) {
    const payload = { requestId: suppliedRequestId || requestId('rag-release'), testSessionId, baseReleaseId, candidateDocuments, publishedBy, publishNote };
    return this.request(`/rag-admin-api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/releases`, { method: 'POST', body: payload, requestId: payload.requestId });
  }
  async listReleases({ knowledgeBaseId = 'main-business-kb' } = {}) { return this.request(`/rag-admin-api/v1/releases${queryString({ knowledge_base_id: knowledgeBaseId })}`); }
  async getRelease({ releaseId } = {}) {
    if (!String(releaseId || '').trim()) throw new Error('releaseId 不能为空');
    return this.request(`/rag-admin-api/v1/releases/${encodeURIComponent(releaseId)}`);
  }
  async getReleaseMembers({ releaseId } = {}) {
    if (!String(releaseId || '').trim()) throw new Error('releaseId 不能为空');
    return this.request(`/rag-admin-api/v1/releases/${encodeURIComponent(releaseId)}/members`);
  }
  async rollbackRelease({ releaseId, requestId: suppliedRequestId, operatorId = 'local-operator', note = '' } = {}) {
    if (!String(releaseId || '').trim()) throw new Error('releaseId 不能为空');
    const payload = { requestId: suppliedRequestId || requestId('rag-rollback'), targetReleaseId: releaseId, operatorId, note };
    return this.request(`/rag-admin-api/v1/releases/${encodeURIComponent(releaseId)}/rollback`, { method: 'POST', body: payload, requestId: payload.requestId });
  }
}

export const ragClient = new RagClient();
export function queryFormalKnowledge(request) { return ragClient.queryFormalKnowledge(request); }
export function queryTestKnowledge(request) { return ragClient.queryTestKnowledge(request); }
export function healthCheck() { return ragClient.healthCheck(); }
