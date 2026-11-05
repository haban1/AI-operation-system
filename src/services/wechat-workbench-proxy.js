import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

export const wechatWorkbenchPath = '/wechat-workbench/';
export const isWechatWorkbenchPath = pathname => pathname === wechatWorkbenchPath.slice(0, -1) || pathname.startsWith(wechatWorkbenchPath);
const forwardedHeaders = ['accept', 'accept-language', 'content-type', 'range', 'if-range'];
const returnedHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'content-encoding'];
const sessionCookieName = 'session';

function reply(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, message }));
}

function sameOrigin(req, allowedOrigins) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === req.headers.origin
      && origin.host.toLowerCase() === String(req.headers.host || '').toLowerCase()
      && (origin.protocol === (req.socket.encrypted ? 'https:' : 'http:') || allowedOrigins.includes(origin.origin));
  } catch { return false; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(new Error('Request aborted'));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) {
        error(Object.assign(new Error('Body too large'), { statusCode: 413 }));
        req.resume();
      } else chunks.push(chunk);
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

function decodeJson(chunks, encoding) {
  let body = Buffer.concat(chunks);
  const options = { maxOutputLength: 32 * 1024 * 1024 };
  if (encoding === 'gzip') body = gunzipSync(body, options);
  else if (encoding === 'deflate') body = inflateSync(body, options);
  else if (encoding === 'br') body = brotliDecompressSync(body, options);
  else if (encoding && encoding !== 'identity') throw new Error('Unsupported response encoding');
  return JSON.parse(body.toString());
}

// The robot session belongs to the server. Browsers only hold their Tianhe session.
export function createWechatWorkbenchProxy({ upstreamUrl = '', loginToken = '', authorize, allowedOrigins = [], maxBodyBytes = 100 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
  let upstream;
  try {
    upstream = new URL(upstreamUrl);
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
      || upstream.pathname !== '/' || upstream.search || upstream.hash) upstream = null;
  } catch { upstream = null; }
  let cookie = '';
  let loginPending;
  const transport = upstream?.protocol === 'https:' ? httpsRequest : httpRequest;

  function rememberCookie(response) {
    const value = (response.headers['set-cookie'] || []).find(value => value.startsWith(sessionCookieName + '='));
    if (value) cookie = value.split(';')[0];
  }

  async function login() {
    if (cookie) return;
    if (loginPending) return loginPending;
    loginPending = new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ token: loginToken }));
      const request = transport(upstream, { method: 'POST', path: '/api/v1/login', headers: {
        'Content-Type': 'application/json', 'Content-Length': body.length, 'Accept-Encoding': 'identity',
      } }, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 64 * 1024) response.destroy(new Error('Invalid login response'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const result = decodeJson(chunks, response.headers['content-encoding']);
            if (response.statusCode !== 200 || result.code !== 200 || result.data?.success !== true) throw new Error('Login rejected');
            rememberCookie(response);
            if (!cookie || cookie === sessionCookieName + '=') throw new Error('Missing robot session');
            resolve();
          } catch { cookie = ''; reject(new Error('Robot login failed')); }
        });
        response.once('aborted', () => reject(new Error('Robot login interrupted')));
      });
      request.setTimeout(Math.min(timeoutMs, 15_000), () => request.destroy(new Error('Login timed out')));
      request.once('error', reject);
      request.end(body);
    }).finally(() => { loginPending = undefined; });
    return loginPending;
  }

  return async function proxyWechatWorkbench(req, res, url) {
    if (typeof authorize !== 'function' || !await authorize(req, res)) return reply(res, 401, '请先登录天河系统');
    if (!sameOrigin(req, allowedOrigins)) return reply(res, 403, '请求来源与系统不一致');
    if (!upstream || !loginToken) return reply(res, 503, '微信助手尚未配置系统内访问，请联系管理员');
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return reply(res, 405, '不支持此请求方法');
    if (url.pathname === wechatWorkbenchPath.slice(0, -1)) {
      res.writeHead(308, { Location: wechatWorkbenchPath + url.search, 'Cache-Control': 'no-store' });
      return res.end();
    }
    let path;
    try {
      const rawPath = String(req.url || '').split('?')[0];
      if (!rawPath.startsWith(wechatWorkbenchPath)) throw new Error('Invalid mount');
      path = rawPath.slice(wechatWorkbenchPath.length - 1);
      const decoded = decodeURIComponent(path);
      if (decoded.includes('%') || decoded.includes('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)
        || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid path');
      path = decoded;
    } catch { return reply(res, 400, '微信助手请求路径无效'); }
    // The embedded UI uses Tianhe login/logout; it cannot create or export robot credentials.
    if (/^\/api\//i.test(path) && (!path.startsWith('/api/v1/')
      || /^\/api\/v1\/(?:login|oauth|user\/(?:logout|api-token))(?:\/|$)/i.test(path))) {
      return reply(res, 403, '微信助手使用天河系统登录');
    }
    if ([...url.searchParams.keys()].some(key => /^(?:api_token|token|access_token)$/i.test(key))) return reply(res, 400, '请求不接受登录凭据');
    const length = Number(req.headers['content-length'] || 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBodyBytes) {
      req.resume(); return reply(res, 413, '上传内容超过微信助手允许的大小');
    }
    let body;
    try { body = await readBody(req, maxBodyBytes); }
    catch (error) { return reply(res, error.statusCode === 413 ? 413 : 400, '微信助手请求内容过大或未完整接收'); }
    const isApi = path.startsWith('/api/v1/');
    const canRetry = ['GET', 'HEAD'].includes(req.method)
      && !/^\/api\/v1\/robot\/(?:docker\/image\/pull|login\/slider(?:-verify-submit)?)(?:\/|$)/.test(path);
    if (isApi) {
      try { await login(); }
      catch { return reply(res, 502, '暂时无法连接微信助手，请稍后重新加载'); }
    }
    if (res.destroyed) return;

    async function send(retried = false) {
      const headers = {};
      for (const name of forwardedHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
      headers['Accept-Encoding'] = 'identity';
      const sentCookie = cookie;
      if (isApi) headers.Cookie = sentCookie;
      if (body.length || !['GET', 'HEAD'].includes(req.method)) headers['Content-Length'] = body.length;
      return new Promise(resolve => {
        const request = transport(upstream, { method: req.method, path: path.split('/').map(encodeURIComponent).join('/') + url.search, headers }, response => {
          const status = response.statusCode || 502;
          const expired = () => {
            response.resume();
            if (cookie === sentCookie) cookie = '';
            if (!retried && canRetry) {
              login().then(() => send(true)).catch(() => reply(res, 502, '微信助手连接已过期，请重新加载')).finally(resolve);
            } else { reply(res, 503, '微信助手连接已过期，请重新加载后再操作'); resolve(); }
          };
          if (status === 401 && isApi) return expired();
          if ((status >= 300 && status < 400 && status !== 304) || status >= 500) {
            response.resume(); reply(res, 502, '微信助手暂时无法连接，请稍后重试'); resolve(); return;
          }
          const outputHeaders = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'", 'X-Content-Type-Options': 'nosniff' };
          for (const name of returnedHeaders) if (response.headers[name] !== undefined) outputHeaders[name] = response.headers[name];
          // Gin reports expired sessions as HTTP 200 with JSON code 401.
          // Account API tokens are never needed by the embedded panel.
          const sanitizeAccount = ['/api/v1/user/self', '/api/v1/system-settings'].includes(path);
          if (isApi && req.method !== 'HEAD' && (sanitizeAccount || /\bjson\b/i.test(response.headers['content-type'] || ''))) {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
              size += chunk.length;
              if (size > 32 * 1024 * 1024) response.destroy(new Error('Invalid robot response'));
              else chunks.push(chunk);
            });
            response.once('end', () => {
              try {
                const data = decodeJson(chunks, response.headers['content-encoding']);
                if (data?.code === 401) return expired();
                if (sanitizeAccount && data?.data && typeof data.data === 'object') delete data.data.api_token;
                rememberCookie(response);
                delete outputHeaders['content-length'];
                delete outputHeaders['content-encoding'];
                res.writeHead(status, outputHeaders); res.end(JSON.stringify(data));
              } catch { reply(res, 502, '无法读取微信助手账户信息'); }
              resolve();
            });
          } else {
            if (isApi) rememberCookie(response);
            res.writeHead(status, outputHeaders);
            response.once('end', resolve);
            response.pipe(res);
          }
          response.once('error', () => { reply(res, 502, '微信助手响应中断'); resolve(); });
          response.once('aborted', () => { reply(res, 502, '微信助手响应中断'); resolve(); });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Upstream timed out')));
        request.once('error', () => { reply(res, 502, '微信助手暂时无法连接，请稍后重试'); resolve(); });
        const close = () => { request.destroy(); resolve(); };
        res.once('close', close);
        request.once('close', () => res.off('close', close));
        request.end(body);
      });
    }
    return send();
  };
}
