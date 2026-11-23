import { setTimeout as delay } from 'node:timers/promises';

const CONNECTION_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);

export async function requestAi(url, options, fetchImpl = globalThis.fetch, readResponse = response => response) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await readResponse(await fetchImpl(url, options)); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      const networkCode = error?.cause?.code || error?.code;
      const connectionFailed = CONNECTION_ERRORS.has(networkCode);
      if (connectionFailed && attempt === 0) {
        await delay(250, undefined, { signal: options.signal });
        continue;
      }
      if (connectionFailed) throw Object.assign(new Error('AI 服务连接失败，请稍后重试或检查服务器网络', { cause: error }), { code: 'AI_NETWORK_ERROR', networkCode });
      throw error;
    }
  }
}
