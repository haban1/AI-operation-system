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
  async getAnswerProfile({ knowledgeBaseId = 'main-business-kb' } = {}) {
    return this.request(`/rag-admin-api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/answer-profile`);
  }
  async saveAnswerProfile({ knowledgeBaseId = 'main-business-kb', profile } = {}) {
    return this.request(`/rag-admin-api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/answer-profile`, { method: 'PUT', body: profile });
  }
  async listFiles({ knowledgeBaseId = 'main-business-kb' } = {}) {
    return this.request(`/rag-admin-api/v1/files${queryString({ knowledge_base_id: knowledgeBaseId })}`);
  }
  async fileContent({ documentId, knowledgeBaseId = 'main-business-kb' } = {}) {
    return this.request(`/rag-admin-api/v1/files/${encodeURIComponent(documentId)}/chunks${queryString({ knowledge_base_id: knowledgeBaseId })}`);
  }
  async removeFile({ documentId, knowledgeBaseId = 'main-business-kb' } = {}) {
    return this.request(`/rag-admin-api/v1/files/${encodeURIComponent(documentId)}${queryString({ knowledge_base_id: knowledgeBaseId })}`, { method: 'DELETE' });
  }
  async saveFile({ documentId = null, content, filename, mimeType = 'application/octet-stream', knowledgeBaseId = 'main-business-kb', uploadedBy = 'admin', requestId: suppliedRequestId = null } = {}) {
    const id = suppliedRequestId || requestId('file-save');
    const form = new FormData();
    form.append('file', new Blob([content], { type: mimeType }), filename);
    form.append('metadata', JSON.stringify({ knowledgeBaseId, uploadedBy }));
    const suffix = documentId ? `/${encodeURIComponent(documentId)}` : '';
    return this.request(`/rag-admin-api/v1/files${suffix}`, { method: documentId ? 'PUT' : 'POST', body: form, requestId: id });
  }
  async queryFormalKnowledge(input = {}) {
    const payload = { contractVersion: RAG_CONTRACT_VERSION, requestId: input.requestId || requestId('rag-query'), ...input };
    const result = await this.request('/rag-api/v1/query', { method: 'POST', body: payload, requestId: payload.requestId });
    if ([RAG_RESULT.NOT_CONFIGURED, RAG_RESULT.UNAVAILABLE, RAG_RESULT.INVALID_RESPONSE].includes(result.status)) return result;
    const outcome = String(result.result || result.status || '').toUpperCase();
    return { ...result, status: outcome || RAG_RESULT.INVALID_RESPONSE, answerable: outcome === RAG_RESULT.ANSWERED && Boolean(result.answer?.text), retryable: false };
  }


}

export const ragClient = new RagClient();
export function queryFormalKnowledge(request) { return ragClient.queryFormalKnowledge(request); }
export function healthCheck() { return ragClient.healthCheck(); }
