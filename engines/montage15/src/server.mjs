import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { AppError, createProject, editProject, fail, validId } from './domain.mjs';
import { importAsset, publicAsset, serveFile, mediaMime, exec, FFMPEG, FFPROBE } from './media.mjs';
import { templates, getTemplate, buildHtml } from './templates.mjs';
import { RenderQueue, publicJob, findBrowser } from './render.mjs';
import { TemplateRegistry } from './template-registry.mjs';
import { musicTracks } from './music.mjs';
import { assertRevision, revisionSummary, validateAssetNotes } from './editor-state.mjs';
import { CodexPlanner } from './codex-planner.mjs';
import { AiEditing, publicAiRun } from './ai-editing.mjs';
import { SourceFolders } from './source-folders.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'";
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 512 * 1024) fail(413, 'BODY_TOO_LARGE', '编辑内容过大'); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks).toString('utf8');
  let value;
  try { value = buffer ? JSON.parse(buffer) : {}; } catch { fail(400, 'INVALID_JSON', '请求内容格式不正确'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_JSON', '请求内容必须是对象');
  return value;
}
function matchId(value) { if (!validId(value)) fail(404, 'NOT_FOUND', '记录不存在'); return value; }
function checkHost(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) fail(403, 'INVALID_HOST', '仅支持本机访问');
  return `http://${host}`;
}
function checkWrite(req, token) {
  const origin = req.headers.origin;
  const expectedOrigin = checkHost(req);
  if (origin && origin !== expectedOrigin) fail(403, 'INVALID_ORIGIN', '请从本机工作台操作');
  const supplied = Buffer.from(String(req.headers['x-workbench-token'] || ''));
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail(403, 'INVALID_SESSION', '页面会话已过期，请刷新页面后重试');
}

export async function createWorkbench({ dataDir = process.env.VIDEO_WORKBENCH_DATA_DIR || path.join(ROOT, '.local'), mountPath = '', templateIds = null, catalogIds = null, assetLibrary = null, receiveOutput = null, planner = new CodexPlanner() } = {}) {
  if (mountPath && !/^\/[a-zA-Z0-9/_-]+$/.test(mountPath)) throw new TypeError('Invalid mount path');
  const resource = value => mountPath + value;
  const viewAsset = asset => { const a = publicAsset(asset); return {...a, url:resource(a.url), thumbnailUrl:a.thumbnailUrl ? resource(a.thumbnailUrl) : null}; };
  const viewJob = job => { const j = publicJob(job); return {...j, downloadUrl:j.downloadUrl ? resource(j.downloadUrl) : null, videoUrl:j.videoUrl ? resource(j.videoUrl) : null}; };
  const preview = (project, assets) => buildHtml(project, assets.map(viewAsset), {assetPrefix:resource('/api/assets'),gsapUrl:resource('/vendor/gsap.min.js'),templateAudioPrefix:resource('/template-audio')});
  const store = new Store(path.resolve(dataDir));
  await store.init();
  const registry = new TemplateRegistry(store, templates.filter(template => !catalogIds || catalogIds.includes(template.id)), templateIds);
  const sources = new SourceFolders(store);
  await sources.init();
  const ai = new AiEditing({ store, planner, assetsForProject: project => sources.assets(project), prepareAssets: (project, plan) => sources.materialize(project, plan) });
  await ai.init();
  const queue = new RenderQueue(store);
  await queue.init();
  const sessionToken = randomBytes(24).toString('hex');
  const capabilities = { engine: 'HyperFrames', engineVersion: '0.9.27', stage: 4, localOnly: true, originalAudio: false,
    browserAvailable: !!await findBrowser(), ffmpegAvailable: false, ffprobeAvailable: false };
  for (const [binary, key] of [[FFMPEG, 'ffmpegAvailable'], [FFPROBE, 'ffprobeAvailable']]) {
    try { await exec(binary, ['-version'], { timeout: 5000 }); capabilities[key] = true; } catch {}
  }
  const publicFiles = new Map([['/', ['public/index.html', 'text/html; charset=utf-8']], ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
    ['/workflow.js', ['public/workflow.js', 'text/javascript; charset=utf-8']], ['/workflow.css', ['public/workflow.css', 'text/css; charset=utf-8']],
    ['/production.js', ['public/production.js', 'text/javascript; charset=utf-8']],
    ['/captions.js', ['public/captions.js', 'text/javascript; charset=utf-8']], ['/ai-tune.js', ['public/ai-tune.js', 'text/javascript; charset=utf-8']],
    ['/workspace.js', ['public/workspace.js', 'text/javascript; charset=utf-8']], ['/workspace.css', ['public/workspace.css', 'text/css; charset=utf-8']],
    ['/integration-theme.css', ['public/integration-theme.css', 'text/css; charset=utf-8']],
    ['/vendor/gsap.min.js', ['vendor/gsap.min.js', 'text/javascript; charset=utf-8']]]);
  if (!mountPath) publicFiles.set('/samples', ['public/samples.html', 'text/html; charset=utf-8']);

  for (const template of templates.filter(t => t.engine === 'montage15')) {
    publicFiles.set(`/posters/${template.id}.jpg`, [`public/posters/${template.id}.jpg`, 'image/jpeg']);
    if (template.soundtrack) for (const file of [template.soundtrack.musicFile, template.soundtrack.sfxFile])
      publicFiles.set(`/template-audio/${file}`, [`templates/montage15/audio/${file}`, 'audio/wav']);
  }
  publicFiles.set('/audio-credits', ['templates/montage15/audio/CREDITS.md', 'text/plain; charset=utf-8']);
  publicFiles.set('/audio-sources', ['templates/montage15/audio/SOURCES.md', 'text/plain; charset=utf-8']);

  async function handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', CSP);
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    try {
      const origin = checkHost(req);
      const url = new URL(req.url, origin);
      if (mountPath && !url.pathname.startsWith(mountPath + '/')) fail(404, 'NOT_FOUND', '页面不存在');
      const pathname = mountPath ? url.pathname.slice(mountPath.length) : url.pathname;
      const read = ['GET', 'HEAD'].includes(req.method);
      if (!read) checkWrite(req, sessionToken);
      if (read && pathname === '/health') return json(res, { ok: true, service: 'local-video-template-workbench', version: '0.6.0', stage: 4 });
      if (read && pathname === '/api/bootstrap') return json(res, {
        sessionToken, templates: await registry.enabled(), templateCatalog: await registry.list(), musicTracks,
        assets: (await store.all('assets')).map(viewAsset), projects: await store.all('projects'),
        jobs: (await store.all('jobs')).map(viewJob), capabilities:{...capabilities, systemLibrary:!!assetLibrary},
        aiRuns: (await store.all('ai-runs')).map(publicAiRun), sourceFolders: await sources.list(),
        integration: { status: mountPath ? 'internal-system' : 'isolated-validation', message: mountPath ? '系统素材库、制作工程与成片库已连接' : '本地素材验收工作台；当前内部系统入口尚未替换' },
      });
      if (read && pathname === '/api/ai/status') return json(res, await planner.status());
      if (read && pathname === '/api/source-folders') return json(res, { sources: await sources.list() });
      if (req.method === 'POST' && pathname === '/api/assets/relink-folder') {
        const input = await body(req);
        if (Object.keys(input).some(key => key !== 'sourceId')) fail(400, 'INVALID_SOURCE_FOLDER', '请选择新的来源文件夹');
        const restored = await sources.repair(matchId(input.sourceId));
        return json(res, { restored, assets: (await store.all('assets')).map(viewAsset) });
      }
      if (req.method === 'POST' && ['/api/source-folders', '/api/source-folders/choose'].includes(pathname)) {
        const input = await body(req);
        const source = pathname.endsWith('/choose') ? await sources.choose() : await sources.register(input);
        return json(res, { source: sources.view(await sources.scan(source.id)) }, 202);
      }
      const sourceMatch = /^\/api\/source-folders\/([^/]+)(\/scan|\/items|\/import)?$/.exec(pathname);
      if (sourceMatch) {
        const id = matchId(sourceMatch[1]);
        if (read && !sourceMatch[2]) return json(res, { source: sources.view(await store.get('source-folders', id)) });
        if (read && sourceMatch[2] === '/items') return json(res, { items: (await sources.items(id)).map(item => ({ ...viewAsset(item), thumbnailUrl: resource(`/api/source-folders/${id}/thumbnails/${item.id}`) })) });
        if (req.method === 'POST' && sourceMatch[2] === '/scan') return json(res, { source: sources.view(await sources.scan(id)) }, 202);
        if (req.method === 'POST' && sourceMatch[2] === '/import') {
          const input = await body(req);
          if (Object.keys(input).some(key => key !== 'id')) fail(400, 'INVALID_SOURCE_ITEM', '请选择来源文件夹中的素材');
          return json(res, { asset: viewAsset(await sources.import(id, matchId(input.id))) });
        }
      }
      const thumbnailMatch = /^\/api\/source-folders\/([^/]+)\/thumbnails\/([^/]+)$/.exec(pathname);
      if (read && thumbnailMatch) {
        const id = matchId(thumbnailMatch[2]);
        if (!(await sources.items(matchId(thumbnailMatch[1]))).some(item => item.id === id)) fail(404, 'NOT_FOUND', '素材不存在');
        return serveFile(req, res, path.join(store.root, 'source-thumbnails', id + '.jpg'), 'image/jpeg');
      }
      if (read && pathname === '/api/templates') return json(res, { templates: await registry.list() });
      let templateMatch;
      if (req.method === 'POST' && (templateMatch = /^\/api\/templates\/([^/]+)\/availability$/.exec(pathname))) {
        const template = await registry.setEnabled(matchId(templateMatch[1]), await body(req));
        return json(res, { template, templates: await registry.enabled() });
      }
      if (req.method === 'POST' && pathname === '/api/assets') {
        if (!capabilities.ffmpegAvailable || !capabilities.ffprobeAvailable) fail(503, 'MEDIA_TOOL_UNAVAILABLE', '本机媒体处理组件不可用');
        const asset = await store.locked('asset-import', () => importAsset(req, store));
        return json(res, { asset: viewAsset(asset) }, 201);
      }
      if (assetLibrary && read && pathname === '/api/library-assets') return json(res, {items:await assetLibrary.list()});
      if (assetLibrary && req.method === 'POST' && pathname === '/api/library-assets/import') {
        const input=await body(req);
        if(Object.keys(input).some(k=>k!=='id') || !/^[a-f0-9]{32}$/.test(input.id||'')) fail(400,'INVALID_LIBRARY_ID','请选择系统素材库中的素材');
        const opened=await assetLibrary.open(input.id);
        try {
          const asset=await store.locked('asset-import',async()=>{
            const previous=(await store.all('assets')).find(a=>a.sourceLibraryId===input.id && a.sourceSha256===opened.sha256);
            if(previous && await import('./media.mjs').then(m=>m.hashFile(previous.mediaFile)).catch(()=>null)===previous.mediaSha256) {
              if (!previous.description && !previous.notesRevision && opened.title) {
                previous.description = opened.title;
                await store.put('assets', previous);
              }
              return previous;
            }
            opened.stream.headers={'x-file-name':encodeURIComponent(opened.filename),'content-length':String(opened.bytes)};
            const imported=await importAsset(opened.stream,store);
            if(imported.sourceSha256!==opened.sha256){
              await fs.rm(path.dirname(imported.mediaFile),{recursive:true,force:true});
              if(imported.thumbnailFile)await fs.rm(imported.thumbnailFile,{force:true});
              await fs.rm(store.file('assets',imported.id),{force:true});
              fail(409,'ASSET_CHANGED','素材在读取期间已改变，请重新选择');
            }
            imported.sourceLibraryId=input.id;
            imported.description=opened.title || '';
            await store.put('assets',imported);return imported;
          });
          return json(res,{asset:viewAsset(asset)},201);
        } finally {opened.stream.destroy();}
      }
      let match;
      if (req.method === 'PUT' && (match = /^\/api\/assets\/([^/]+)\/notes$/.exec(pathname))) {
        const id = matchId(match[1]);
        const input = await body(req);
        const asset = await store.locked(`asset:${id}`, async () => {
          const current = await store.get('assets', id);
          return store.put('assets', { ...current, ...validateAssetNotes(input, current) });
        });
        return json(res, { asset: viewAsset(asset) });
      }
      if(receiveOutput && req.method==='POST' && (match=/^\/api\/jobs\/([^/]+)\/library$/.exec(pathname))){
        const job=await store.get('jobs',matchId(match[1]));
        if(job.status!=='succeeded' || job.project.settings?.colorCards || job.project.slots.some(s=>!s.assetId)) fail(409,'REAL_OUTPUT_REQUIRED','请先导出素材完整的成片');
        return json(res,await receiveOutput(job));
      }
      if (read && (match = /^\/api\/assets\/([^/]+)\/frame$/.exec(pathname))) {
        const asset = await store.get('assets', matchId(match[1]));
        const time = Number(url.searchParams.get('time'));
        if (asset.type !== 'video' || !Number.isFinite(time) || time < 0 || time >= asset.duration) fail(422, 'FRAME_TIME_INVALID', '请选择原片范围内的取材时间');
        const frame = Math.floor(time * 30);
        const directory = path.join(store.root, 'frame-previews', asset.id);
        const filename = path.join(directory, `${frame}.jpg`);
        await store.locked(`frame:${asset.id}:${frame}`, async () => {
          if (await fs.stat(filename).catch(() => null)) return;
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = path.join(directory, `${frame}.tmp.jpg`);
          try {
            await exec(FFMPEG, ['-v','error','-nostdin','-y','-ss',String(frame / 30),'-i',asset.mediaFile,'-frames:v','1','-vf','scale=480:480:force_original_aspect_ratio=decrease','-q:v','3',temporary], {timeout:30000,maxBuffer:100000});
            await fs.rename(temporary,filename);
          } finally { await fs.rm(temporary,{force:true}); }
        });
        return serveFile(req,res,filename,'image/jpeg');
      }
      if (read && (match = /^\/api\/assets\/([^/]+)(\/thumbnail)?$/.exec(pathname))) {
        const asset = await store.get('assets', matchId(match[1]));
        if (match[2] && !asset.thumbnailFile) fail(404, 'NO_THUMBNAIL', '音频没有缩略图');
        return await serveFile(req, res, match[2] ? asset.thumbnailFile : asset.mediaFile, match[2] ? 'image/jpeg' : mediaMime(asset.mediaFile));
      }
      if (req.method === 'POST' && pathname === '/api/projects') {
        const input = await body(req), template = (await registry.enabled()).find(t=>t.id===input.templateId);
        if (!template) fail(422, 'UNKNOWN_TEMPLATE', '请选择已启用的模板');
        const created = createProject(template, input);
        if (input.sourceId) {
          const sourceId = matchId(input.sourceId);
          if ((await store.get('source-folders', sourceId)).status !== 'ready') fail(409, 'SOURCE_INDEXING', '来源文件夹正在索引，请等待完成后创建工程');
          created.brief = { sourceId, request: '根据来源素材制作15秒短片，镜头有变化，文案简洁自然，沿用模板配乐。', facts: '', subject: '', assetIds: (await sources.items(sourceId)).map(item => item.id) };
        }
        if(mountPath && created.settings){created.settings.colorCards=false;created.settings.intensity=.65;}
        const project = await store.saveProject(created);
        return json(res, { project }, 201);
      }
      if ((match = /^\/api\/projects\/([^/]+)$/.exec(pathname))) {
        const id = matchId(match[1]);
        if (read) return json(res, { project: await store.get('projects', id) });
        if (req.method === 'PUT') {
          const input = await body(req);
          const project = await store.locked(`project:${id}`, async () => {
            const current = await store.get('projects', id);
            const scopeProject = { ...current, brief: input.brief || current.brief };
            const next = editProject(current, input, getTemplate(current.templateId), await sources.assets(scopeProject));
            next.editSource = 'manual';
            next.editSummary = '手动保存';
            delete next.aiRunId;
            delete next.restoredFrom;
            return store.saveProject(next);
          });
          return json(res, { project });
        }
      }
      if (read && (match = /^\/api\/projects\/([^/]+)\/revisions$/.exec(pathname))) {
        const id = matchId(match[1]);
        const current = await store.get('projects', id);
        const files = await fs.readdir(path.join(store.root, 'revisions', id));
        const revisions = await Promise.all(files.filter(file => /^\d+\.json$/.test(file) && Number(file.slice(0, -5)) <= current.revision).map(file => store.revision(id, Number(file.slice(0, -5)))));
        return json(res, { revisions: revisions.sort((left, right) => right.revision - left.revision).map(revisionSummary) });
      }
      if (req.method === 'POST' && (match = /^\/api\/projects\/([^/]+)\/restore$/.exec(pathname))) {
        const id = matchId(match[1]), input = await body(req);
        if (Object.keys(input).some(key => !['expectedRevision', 'revision'].includes(key))) fail(400, 'RESTORE_INPUT_INVALID', '恢复请求包含不支持的字段');
        const project = await store.locked(`project:${id}`, async () => {
          const current = await store.get('projects', id);
          assertRevision(current, input.expectedRevision);
          if (input.revision > current.revision) fail(404, 'NOT_FOUND', '工程修订不存在');
          const source = await store.revision(id, input.revision);
          const restored = { ...source, revision: current.revision, createdAt: current.createdAt };
          const next = editProject(restored, { expectedRevision: current.revision }, source.templateSnapshot, await sources.assets(restored));
          next.editSource = 'restore';
          next.editSummary = `恢复修订 ${source.revision}`;
          next.restoredFrom = source.revision;
          delete next.aiRunId;
          return store.saveProject(next);
        });
        return json(res, { project });
      }
      if ((match = /^\/api\/projects\/([^/]+)\/ai-runs$/.exec(pathname))) {
        const id = matchId(match[1]);
        if (read) return json(res, { runs: (await store.all('ai-runs')).filter(run => run.projectId === id).map(publicAiRun) });
        if (req.method === 'POST') {
          const input = await body(req);
          const run = await store.locked('ai-enqueue', async () => {
            const project = await store.get('projects', id);
            return ai.enqueue(project, await sources.assets(project), input);
          });
          return json(res, { run: publicAiRun(run) }, 202);
        }
      }
      if ((match = /^\/api\/ai-runs\/([^/]+)(\/cancel)?$/.exec(pathname))) {
        const id = matchId(match[1]);
        if (req.method === 'POST' && match[2]) return json(res, { run: publicAiRun(await ai.cancel(id)) });
        if (read && !match[2]) return json(res, { run: publicAiRun(await store.get('ai-runs', id)) });
      }
      if (read && (match = /^\/api\/projects\/([^/]+)\/preview$/.exec(pathname))) {
        const id = matchId(match[1]);
        if (url.searchParams.has('revision') && Number(url.searchParams.get('revision')) > (await store.get('projects', id)).revision) fail(404, 'NOT_FOUND', '工程修订不存在');
        const project = url.searchParams.has('revision') ? await store.revision(id, Number(url.searchParams.get('revision'))) : await store.get('projects', id);
        const html = preview(project, await store.all('assets'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
      }
      if (read && (match = /^\/api\/templates\/([^/]+)\/preview$/.exec(pathname))) {
        const template = getTemplate(matchId(match[1]));
        if (!template || template.hidden) fail(404, 'UNKNOWN_TEMPLATE', '模板不存在');
        const html = preview(createProject(template), []);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
      }
      if (req.method === 'POST' && (match = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(pathname))) return json(res, { job: viewJob(await queue.cancel(matchId(match[1]))) });
      if (req.method === 'POST' && (match = /^\/api\/projects\/([^/]+)\/render$/.exec(pathname))) {
        const input = await body(req), id = matchId(match[1]);
        const job = await store.locked('render-enqueue', async () => {
          const project = await store.get('projects', id);
          if (input.expectedRevision !== project.revision) fail(409, 'STALE_REVISION', '工程已更新，请保存最新版本后再导出');
          return queue.enqueue(project, await sources.assets(project));
        });
        return json(res, { job: viewJob(job) }, 202);
      }
      if (read && (match = /^\/api\/jobs\/([^/]+)(?:\/(download|video))?$/.exec(pathname))) {
        const job = await store.get('jobs', matchId(match[1]));
        if (!match[2]) return json(res, { job: viewJob(job) });
        if (job.status !== 'succeeded' || !job.outputFile) fail(409, 'RENDER_NOT_READY', '本次成片尚未生成');
        return await serveFile(req, res, job.outputFile, 'video/mp4', match[2] === 'download' ? { downloadName: `${job.projectName}-r${job.revision}.mp4` } : {});
      }
      if (read && publicFiles.has(pathname)) {
        const [relative, mime] = publicFiles.get(pathname);
        return await serveFile(req, res, path.join(ROOT, relative), mime);
      }
      fail(404, 'NOT_FOUND', '页面或接口不存在');
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy();
      const known=error instanceof AppError || (Number.isInteger(error.statusCode) && error.statusCode>=400 && error.statusCode<500);
      if (!known) console.error('[workbench]', error.message);
      json(res, { error: known ? error.message : '本地服务发生错误，请重试', code: known ? error.code : 'INTERNAL_ERROR', details: known ? error.details : undefined }, error.status || (known ? error.statusCode : 500));
    }
  }
  return { handle, store, queue, capabilities, registry, ai, sources, close: async () => { sources.close(); await ai.close(); } };
}

export async function startWorkbench({ port = Number(process.env.VIDEO_WORKBENCH_PORT || 8897), dataDir } = {}) {
  const app = await createWorkbench({ dataDir });
  const server = http.createServer((req, res) => { void app.handle(req, res); });
  server.requestTimeout = 15 * 60 * 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address();
  console.log(`视频模板素材验收工作台：http://127.0.0.1:${address.port}/`);
  return { ...app, server, url: `http://127.0.0.1:${address.port}` };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const app = await startWorkbench();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    app.queue.currentChild?.kill('SIGTERM'); app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
