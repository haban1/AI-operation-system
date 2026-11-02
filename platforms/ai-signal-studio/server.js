import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio, StudioError } from './core.js';
import { runCommand } from './render.js';

const uuid = '[a-f0-9-]{36}';
const formats = { video: ['video.mp4', 'video/mp4'], poster: ['poster.png', 'image/png'], script: ['script.json', 'application/json; charset=utf-8'], subtitles: ['subtitles.srt', 'text/plain; charset=utf-8'] };
export function rangeBounds(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new StudioError('无效的媒体范围', 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new StudioError('无效的媒体范围', 416);
  return { start, end, partial: true };
}
export async function createStudioServer({ root, token, modelBase, modelToken, fetchImpl, renderer }) {
  if (!token) throw new Error('AI_STUDIO_TOKEN is required');
  const studio = await createStudio({ root, modelBase, modelToken, fetchImpl, renderer });
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new StudioError('请使用 JSON 请求', 415);
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new StudioError('请求内容过大', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StudioError('请求格式无效'); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://ai-studio');
      if (req.method === 'GET' && url.pathname === '/api/health' && !url.search) return send(res, 200, { ok: true, service: 'AI Signal Studio', implementation: 'tianhe-local', version: '1.0.0' });
      const actual = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      const expected = Buffer.from(token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { error: '请通过天河登录后进入 AI Studio' });
      if (url.search) throw new StudioError('不支持此请求参数');
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { ok: true, implementation: 'tianhe-local', model: await studio.modelStatus(), rendering: '字幕动效视频', voice: '本地普通话合成（机械音）' });
      if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, { projects: studio.list() });
      if (req.method === 'POST' && url.pathname === '/api/projects') return send(res, 202, { project: await studio.create(await body(req)) });
      const match = url.pathname.match(new RegExp(`^/api/projects/(${uuid})(?:/(script|render|cancel|retry|media/(?:video|poster|script|subtitles)))?$`));
      if (!match) throw new StudioError('接口不存在', 404);
      const [, id, action] = match;
      if (req.method === 'GET' && !action) return send(res, 200, { project: studio.get(id) });
      if (req.method === 'PUT' && action === 'script') return send(res, 200, { project: await studio.saveScript(id, await body(req)) });
      if (req.method === 'POST' && action === 'render') return send(res, 202, { project: await studio.render(id, (await body(req)).revision) });
      if (req.method === 'POST' && ['cancel', 'retry'].includes(action)) { await body(req); return send(res, 200, { project: await studio[action](id) }); }
      if (['GET', 'HEAD'].includes(req.method) && action?.startsWith('media/')) {
        const project = studio.get(id);
        if (!project.runId || !/^run-\d+-[a-f0-9-]{36}$/.test(project.runId)) throw new StudioError('尚无已完成的视频', 404);
        const [name, type] = formats[action.slice(6)];
        const filename = path.join(root, 'runs', project.runId, name);
        const info = await stat(filename);
        let bounds;
        try { bounds = rangeBounds(req.headers.range, info.size); }
        catch (error) { res.setHeader('Content-Range', `bytes */${info.size}`); throw error; }
        res.writeHead(bounds.partial ? 206 : 200, {
          'Content-Type': type, 'Content-Length': bounds.end - bounds.start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `${['script', 'subtitles'].includes(action.slice(6)) ? 'attachment' : 'inline'}; filename="${id}-${name}"`,
          ...(bounds.partial ? { 'Content-Range': `bytes ${bounds.start}-${bounds.end}/${info.size}` } : {}),
        });
        if (req.method === 'HEAD') return res.end();
        const stream = createReadStream(filename, { start: bounds.start, end: bounds.end });
        res.on('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      throw new StudioError('不支持的操作', 405);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      send(res, error instanceof StudioError ? error.status : error.code === 'ENOENT' ? 404 : 500, { error: error instanceof StudioError ? error.message : error.code === 'ENOENT' ? '文件不存在' : '服务处理失败，请稍后重试' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return { server, studio };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runCommand('ffmpeg', ['-version'], { timeout: 10000 });
  await runCommand('ffprobe', ['-version'], { timeout: 10000 });
  await runCommand('espeak-ng', ['--version'], { timeout: 10000 });
  const app = await createStudioServer({ root: process.env.STUDIO_DATA_DIR || '/data', token: process.env.AI_STUDIO_TOKEN, modelBase: process.env.TIANHE_MODEL_BASE_URL || 'http://web:3100/api/model/v1', modelToken: process.env.TIANHE_MODEL_TOKEN });
  app.server.listen(Number(process.env.PORT || 8892), '0.0.0.0', () => console.log('AI Signal Studio local service ready on 8892'));
  let closing = false;
  async function close() {
    if (closing) return; closing = true;
    await app.studio.close(); app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
