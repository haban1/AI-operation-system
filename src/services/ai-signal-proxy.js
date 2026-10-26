import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { aiSignalPath, safeWorkbenchHttpUrl } from './workbench-urls.js';

const requestHeaders = ['accept', 'accept-language', 'range', 'if-range', 'if-modified-since', 'if-none-match', 'content-type'];
const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition', 'content-encoding'];

export function isAiSignalProxyPath(pathname) {
  return pathname === aiSignalPath.slice(0, -1) || pathname.startsWith(aiSignalPath);
}

function reply(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, message }));
}

function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin
      || parsed.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return false;
    return parsed.protocol === (req.socket.encrypted ? 'https:' : 'http:') || allowedOrigins.includes(origin);
  } catch { return false; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(new Error('Request aborted'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) {
        error(Object.assign(new Error('Request too large'), { statusCode: 413 }));
        req.resume();
      } else chunks.push(chunk);
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

export function createAiSignalProxy({ upstreamUrl = '', authorize, allowedOrigins = [], maxBodyBytes = 2_000_000, timeoutMs = 120_000 } = {}) {
  let upstream;
  try {
    upstream = safeWorkbenchHttpUrl(upstreamUrl);
    if (upstream.pathname !== '/') upstream = null;
  } catch { upstream = null; }

  return async function proxyAiSignal(req, res, url) {
    if (typeof authorize !== 'function' || !authorize(req, res)) {
      return reply(res, 401, '管理员登录已过期或尚未登录');
    }
    if (!originAllowed(req, allowedOrigins)) return reply(res, 403, '请求来源与工作台不一致');
    if (!upstream) return reply(res, 503, 'AI Signal Studio 代理尚未配置');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD, POST');
      return reply(res, 405, '工作台不支持此请求方法');
    }
    if (url.pathname === aiSignalPath.slice(0, -1)) {
      res.writeHead(308, { Location: aiSignalPath + url.search, 'Cache-Control': 'no-store' });
      return res.end();
    }
    const rawPath = String(req.url || '').split('?')[0];
    let path;
    try {
      if (!rawPath.startsWith(aiSignalPath)) throw new Error('Invalid mount');
      path = rawPath.slice(aiSignalPath.length - 1);
      const decoded = decodeURIComponent(path);
      if (decoded.startsWith('//') || /[\\\u0000-\u001f]/.test(decoded)
        || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid path');
    } catch { return reply(res, 400, '工作台请求路径无效'); }

    const length = Number(req.headers['content-length'] || 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes) {
      req.resume();
      return reply(res, 413, '工作台请求内容过大');
    }
    let body;
    try { body = await readBody(req, maxBodyBytes); }
    catch (error) { return reply(res, error.statusCode === 413 ? 413 : 400, error.statusCode === 413 ? '工作台请求内容过大' : '工作台请求未完整接收'); }
    if (res.destroyed) return;
    // Keep the browser session, API credentials, Origin and forwarding headers
    // at this authenticated boundary. The engine expects its loopback Host.
    const headers = { Host: `127.0.0.1:${upstream.port || (upstream.protocol === 'https:' ? '443' : '80')}` };
    for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    if (body.length || req.method === 'POST') headers['Content-Length'] = body.length;

    return new Promise(resolve => {
      const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(upstream, { method: req.method, path: path + url.search, headers }, response => {
        const status = response.statusCode || 502;
        if ((status >= 300 && status < 400 && status !== 304) || status >= 500) {
          response.resume();
          reply(res, 502, 'AI Signal Studio 暂时无法连接，请稍后重试');
          resolve();
          return;
        }
        const outputHeaders = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'" };
        for (const name of responseHeaders) if (response.headers[name] !== undefined) outputHeaders[name] = response.headers[name];
        res.writeHead(status, outputHeaders);
        response.once('error', () => { reply(res, 502, 'AI Signal Studio 响应中断'); resolve(); });
        response.once('aborted', () => { reply(res, 502, 'AI Signal Studio 响应中断'); resolve(); });
        response.once('end', resolve);
        response.pipe(res);
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Upstream timed out')));
      request.once('error', () => { reply(res, 502, 'AI Signal Studio 暂时无法连接，请稍后重试'); resolve(); });
      const close = () => { request.destroy(); resolve(); };
      res.once('close', close);
      request.once('close', () => res.off('close', close));
      request.end(body);
    });
  };
}
