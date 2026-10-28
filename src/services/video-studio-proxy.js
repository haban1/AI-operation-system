import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { safeWorkbenchHttpUrl } from './workbench-urls.js';

const prefix = '/video-workbench/';
const requestHeaders = ['accept', 'accept-language', 'range', 'if-range', 'if-modified-since', 'if-none-match', 'content-type', 'last-event-id'];
const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition', 'x-accel-buffering'];

function reply(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

export function createVideoStudioProxy({ upstreamUrl = '', authorize, allowedOrigins = [], maxBodyBytes = 512 * 1024, timeoutMs = 120_000 } = {}) {
  let upstream;
  try {
    upstream = safeWorkbenchHttpUrl(upstreamUrl);
    if (upstream.pathname !== '/' || !['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(upstream.hostname)) upstream = null;
  } catch { upstream = null; }
  return async function proxyVideoStudio(req, res, url = new URL(req.url, `http://${req.headers.host}`)) {
    if (typeof authorize !== 'function' || !authorize(req, res)) return reply(res, 401, '管理员登录已过期或尚未登录');
    const origin = req.headers.origin;
    if (origin) {
      let valid = false;
      try {
        const parsed = new URL(origin);
        valid = parsed.origin === origin && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase()
          && (parsed.protocol === (req.socket.encrypted ? 'https:' : 'http:') || allowedOrigins.includes(origin));
      } catch {}
      if (!valid) return reply(res, 403, '请求来源与工作台不一致');
    }
    if (!upstream) return reply(res, 503, '本地视频制作服务尚未配置');
    if (!['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(req.method)) return reply(res, 405, '工作台不支持此请求方法');
    const rawPath = String(req.url || '').split('?')[0];
    let targetPath;
    try {
      if (!rawPath.startsWith(prefix)) throw new Error();
      targetPath = rawPath.slice(prefix.length - 1);
      const decoded = decodeURIComponent(targetPath);
      if (decoded.startsWith('//') || /[\\\u0000-\u001f]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error();
    } catch { return reply(res, 400, '工作台请求路径无效'); }
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) return reply(res, 413, '工作台请求内容过大');
        chunks.push(chunk);
      }
    } catch { return reply(res, 400, '工作台请求未完整接收'); }
    // The browser session and credentials terminate at the main application's
    // authentication boundary. The local companion accepts a loopback Host.
    const headers = { Host: `127.0.0.1:${upstream.port || (upstream.protocol === 'https:' ? '443' : '80')}` };
    for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    if (bytes || !['GET', 'HEAD'].includes(req.method)) headers['Content-Length'] = bytes;
    return new Promise(resolve => {
      const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = send(upstream, { method: req.method, path: targetPath + url.search, headers }, response => {
        const status = response.statusCode || 502;
        if ((status >= 300 && status < 400 && status !== 304) || status >= 500) {
          response.resume(); reply(res, 502, '本地视频制作服务暂时无法连接'); resolve(); return;
        }
        const output = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Type-Options': 'nosniff' };
        for (const name of responseHeaders) if (response.headers[name] !== undefined) output[name] = response.headers[name];
        const policy = response.headers['content-security-policy'];
        output['Content-Security-Policy'] = [...(Array.isArray(policy) ? policy : policy ? [policy] : []), "frame-ancestors 'self'"];
        if (targetPath === '/api/studio/bootstrap' && req.method === 'GET' && status === 200) {
          const data = [];
          let length = 0;
          response.on('data', chunk => {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) response.destroy(new Error('Bootstrap too large'));
            else data.push(chunk);
          });
          response.once('end', () => {
            try {
              const payload = JSON.parse(Buffer.concat(data).toString('utf8'));
              payload.automaticUrl = '/integrations/ai-signal/';
              const body = JSON.stringify(payload);
              output['content-length'] = Buffer.byteLength(body);
              res.writeHead(status, output); res.end(body);
            } catch { reply(res, 502, '视频工作台状态暂时无法读取'); }
            resolve();
          });
        } else {
          res.writeHead(status, output);
          res.flushHeaders();
          response.once('end', resolve);
          response.pipe(res);
        }
        response.once('error', () => { reply(res, 502, '视频工作台响应中断'); resolve(); });
        response.once('aborted', () => { reply(res, 502, '视频工作台响应中断'); resolve(); });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Upstream timed out')));
      request.once('error', () => { reply(res, 502, '本地视频制作服务暂时无法连接'); resolve(); });
      const close = () => { request.destroy(); resolve(); };
      res.once('close', close);
      request.once('close', () => res.off('close', close));
      request.end(Buffer.concat(chunks));
    });
  };
}
