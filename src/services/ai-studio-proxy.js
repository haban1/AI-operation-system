import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function studioProxyRoute(method, pathname, search = '') {
  if (search || !pathname.startsWith('/api/ai-studio/')) return null;
  const suffix = pathname.slice('/api/ai-studio'.length);
  const id = '[a-f0-9-]{36}';
  const allowed = (method === 'GET' && ['/status', '/projects'].includes(suffix))
    || (method === 'POST' && suffix === '/projects')
    || (method === 'GET' && new RegExp(`^/projects/${id}$`).test(suffix))
    || (method === 'PUT' && new RegExp(`^/projects/${id}/script$`).test(suffix))
    || (method === 'POST' && new RegExp(`^/projects/${id}/(render|cancel|retry)$`).test(suffix))
    || (['GET', 'HEAD'].includes(method) && new RegExp(`^/projects/${id}/media/(video|poster|script|subtitles)$`).test(suffix));
  return allowed ? `/api${suffix}` : null;
}

// The caller has already verified the Tianhe administrator session and origin.
export async function proxyAiStudio(req, res, url, { baseUrl, token, fetchImpl = fetch }) {
  const fail = (code, message) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
  const route = studioProxyRoute(req.method, url.pathname, url.search);
  if (!route) return fail(404, 'AI Studio 接口不存在');
  if (!baseUrl || !token) return fail(503, 'AI Studio 尚未连接');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    let payload;
    if (['POST', 'PUT'].includes(req.method)) {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(415, '请使用 JSON 请求');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 65536) return fail(413, '请求内容过大'); chunks.push(chunk); }
      payload = Buffer.concat(chunks);
    }
    const upstream = await fetchImpl(new URL(route, baseUrl), {
      method: req.method, redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(req.headers.range ? { Range: req.headers.range } : {}) }, body: payload,
    });
    const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) if (upstream.headers.has(name)) headers[name] = upstream.headers.get(name);
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    if (!res.headersSent) fail(503, 'AI Studio 暂时无法连接，请稍后重试');
    else if (!res.destroyed) res.destroy();
  } finally { clearTimeout(timer); }
}
