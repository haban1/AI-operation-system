import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_ENTRIES = 150;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 8000;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.m4v']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function within(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

async function regularFile(root, path) {
  if (!within(root, resolve(path))) return null;
  try {
    const actual = await realpath(path);
    if (!within(root, actual)) return null;
    const info = await stat(actual);
    return info.isFile() && info.size > 0 ? { path: actual, info } : null;
  } catch { return null; }
}

async function jsonFile(root, path) {
  const file = await regularFile(root, path);
  if (!file || file.info.size > MAX_JSON_BYTES) return null;
  let handle;
  try {
    handle = await open(file.path, 'r');
    const bytes = Buffer.alloc(Math.min(file.info.size, MAX_JSON_BYTES) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length === bytes.length) return null; // File grew during this bounded read.
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch { return null; } finally { await handle?.close(); }
}

async function directoryEntries(path) {
  try { return await readdir(path, { withFileTypes: true }); } catch { return []; }
}

function text(value, fallback = '', limit = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback;
}

function date(value, fallback) {
  const parsed = typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

function relativeMediaPath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\u0000-\u001f?#]/.test(value)) return null;
  if (isAbsolute(value) || value.includes(':') || value.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return value;
}

function checkDeadline(deadline) {
  if (Date.now() > deadline) throw new Error('Source discovery timed out');
}

async function signalEntries(root, deadline) {
  const entries = [];
  const reviews = (await jsonFile(root, join(root, 'data/library-review.json')))?.runs || {};
  const selectedRuns = new Set();
  const comparisons = (await directoryEntries(join(root, 'data/comparisons')))
    .filter(item => item.isFile() && /^compare-.*\.json$/.test(item.name)).slice(0, 150);
  for (const item of comparisons) {
    checkDeadline(deadline);
    const batch = await jsonFile(root, join(root, 'data/comparisons', item.name));
    if (!batch) continue;
    const selected = new Set(Array.isArray(batch.selected_styles) ? batch.selected_styles : [batch.selected_style].filter(Boolean));
    for (const agent of Array.isArray(batch.agents) ? batch.agents : []) {
      if (selected.has(agent?.agent_id || agent?.style_id) && typeof agent?.run === 'string') selectedRuns.add(agent.run);
    }
  }
  const folders = (await readdir(join(root, 'runs'), { withFileTypes: true }))
    .filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 500);
  for (const folder of folders) {
    checkDeadline(deadline);
    if (entries.length >= MAX_ENTRIES) break;
    const review = reviews[folder.name] || {};
    if (review.decision === 'rejected') continue;
    const directory = join(root, 'runs', folder.name);
    const validation = await jsonFile(root, join(directory, 'validation.json'));
    if (validation?.full_decode !== 'passed') continue;
    const script = await jsonFile(root, join(directory, 'script.json'));
    if (!script || typeof script !== 'object') continue;
    const video = await regularFile(root, join(directory, 'video.mp4'));
    if (!video) continue;
    entries.push({
      source: 'automatic', sourceId: folder.name,
      title: text(script.title, folder.name),
      body: text(script.summary || script.description, text(script.repo, 'AI Signal Studio 自动化成片'), 2000),
      createdAt: date(script.created_at, video.info.mtime),
      reviewStatus: selectedRuns.has(folder.name) ? 'selected' : 'unreviewed',
      sourceStatus: text(review.label || script.editorial_status, '待内容复核'),
      artifactType: 'final_video', filePath: video.path, rootPath: root,
    });
  }
  return entries;
}

async function editingEntries(root, deadline) {
  const database = await regularFile(root, join(root, 'project-store-v1.sqlite3'));
  if (!database) throw new Error('Source database unavailable');
  let db;
  let snapshot;
  try {
    // Read only the completed-job registry. Never read credentials, chat history,
    // other KV records, or infer finished exports by scanning upload filenames.
    db = new DatabaseSync(database.path, { readOnly: true });
    const size = db.prepare("SELECT length(CAST(v AS BLOB)) AS bytes FROM kv WHERE k = 'generation-jobs:snapshot'").get();
    if (!size) return [];
    if (Number(size.bytes) > 16 * 1024 * 1024) throw new Error('Source registry too large');
    const row = db.prepare("SELECT v FROM kv WHERE k = 'generation-jobs:snapshot'").get();
    if (!row) return [];
    if (typeof row.v !== 'string' || Buffer.byteLength(row.v) > 16 * 1024 * 1024) throw new Error('Source registry too large');
    snapshot = JSON.parse(row.v);
  } finally { db?.close(); }
  const entries = [];
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs.slice(0, 1000) : [];
  jobs.sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
  for (const job of jobs) {
    checkDeadline(deadline);
    if (entries.length >= MAX_ENTRIES) break;
    if (job?.status !== 'succeeded' || job?.params?.kind !== 'export' || job?.params?.format !== 'video') continue;
    const result = job.result;
    if (result?.kind !== 'video' || typeof result.path !== 'string' || !result.path.startsWith('/media/uploads/')) continue;
    const filename = result.path.slice('/media/uploads/'.length);
    if (!relativeMediaPath(filename) || basename(filename) !== filename || !VIDEO_EXTENSIONS.has(extname(filename).toLowerCase())) continue;
    const video = await regularFile(root, join(root, 'media/uploads', filename));
    if (!video || (Number.isFinite(result.sizeBytes) && result.sizeBytes !== video.info.size)) continue;
    entries.push({
      source: 'editing', sourceId: text(job.id, filename, 250),
      title: text(result.name || job.params.name, filename),
      body: job.params.frameRange ? 'OpenChatCut 已完成选区导出，发布前需确认内容完整性。' : 'OpenChatCut 已完成时间线导出，待内容复核。',
      createdAt: date(job.createdAt, video.info.mtime), reviewStatus: 'unreviewed',
      sourceStatus: '导出完成 · 待内容复核',
      artifactType: job.params.frameRange ? 'video_clip' : 'final_video',
      filePath: video.path, rootPath: root,
    });
  }
  return entries;
}

async function creationEntries(root, deadline) {
  const entries = [];
  const seen = new Set();
  let inspected = 0;
  const projects = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).slice(0, 100);
  for (const project of projects) {
    checkDeadline(deadline);
    const projectPath = join(root, project.name);
    const canvases = (await directoryEntries(projectPath)).filter(item => item.isFile() && extname(item.name) === '.json').slice(0, 100);
    for (const canvas of canvases) {
      checkDeadline(deadline);
      if (++inspected > 500 || entries.length >= MAX_ENTRIES) return entries;
      const document = await jsonFile(root, join(projectPath, canvas.name));
      if (document?.toonflowCanvas !== true || !Array.isArray(document.nodes)) continue;
      for (const node of document.nodes.slice(0, 1000)) {
        if (entries.length >= MAX_ENTRIES) return entries;
        const data = node?.data;
        if (!data || data.isGenerating === true || data.generating === true || ['running', 'queued'].includes(data.status)) continue;
        const type = String(node.type || '');
        if (!/(?:imageGenerationNode|videoGenerationNode|videoNode)$/.test(type)) continue;
        for (const output of Object.values(data.outputs || {}).slice(0, 30)) {
          if (!['IMAGE', 'VIDEO'].includes(output?.dataType)) continue;
          const media = relativeMediaPath(output?.value?.url);
          if (!media || !media.startsWith('assets/')) continue;
          const extension = extname(media).toLowerCase();
          if (!(output.dataType === 'VIDEO' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS).has(extension)) continue;
          const file = await regularFile(root, join(projectPath, media));
          if (!file || seen.has(file.path)) continue;
          seen.add(file.path);
          const label = text(data.label, basename(canvas.name, '.json'));
          entries.push({
            source: 'creation', sourceId: `${project.name}/${media}`,
            title: `${project.name} · ${label}`,
            body: `Toonflow 工作区 ${project.name}，画布 ${basename(canvas.name, '.json')}。${output.dataType === 'VIDEO' ? '画布视频输出；片段或预览，未确认最终成片。' : '已生成图片；待内容复核。'}`,
            createdAt: file.info.mtime.toISOString(), reviewStatus: 'unreviewed',
            sourceStatus: output.dataType === 'VIDEO' ? '片段/预览 · 待内容复核' : '图片生成完成 · 待内容复核',
            // A connected video node is not an assembly/export completion signal.
            artifactType: output.dataType === 'VIDEO' ? 'video_clip' : 'image',
            filePath: file.path, rootPath: root,
          });
        }
      }
    }
  }
  return entries;
}

export async function collectContentLibrarySources(config = {}) {
  const definitions = [
    { id: 'automatic', title: '自动化成片', root: config.contentLibrarySignalRoot, collect: signalEntries },
    { id: 'editing', title: '素材智剪', root: config.contentLibraryEditingRoot, collect: editingEntries },
    { id: 'creation', title: 'AIGC 创作', root: config.contentLibraryCreationRoot, collect: creationEntries },
  ];
  const results = await Promise.all(definitions.map(async source => {
    const enabled = typeof source.root === 'string' && isAbsolute(source.root);
    const state = { id: source.id, title: source.title, enabled, online: false, message: '产物目录尚未接入' };
    if (!enabled) return { entries: [], source: state };
    let timer;
    try {
      const root = await realpath(source.root);
      if (!(await stat(root)).isDirectory()) throw new Error('Invalid source root');
      const deadline = Date.now() + SOURCE_TIMEOUT_MS;
      const entries = await Promise.race([
        source.collect(root, deadline),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Source discovery timed out')), SOURCE_TIMEOUT_MS); }),
      ]);
      return { entries, source: { ...state, online: true, message: `已发现 ${entries.length} 项完成输出` } };
    } catch {
      return { entries: [], source: { ...state, message: '产物目录暂时无法读取，请检查本地服务与只读挂载' } };
    } finally { clearTimeout(timer); }
  }));
  return { entries: results.flatMap(result => result.entries), sources: results.map(result => result.source) };
}
