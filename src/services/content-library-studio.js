import http from 'node:http';
import https from 'node:https';
import { ContentLibraryError } from './content-library.js';

const outputId = /^[A-Za-z0-9_-]{1,160}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const error = (code, message, status = 409) => new ContentLibraryError(status, code, message);
const allItems = snapshot => [...snapshot.items, ...snapshot.pendingItems, ...snapshot.rejectedItems];

function validOutput(item) {
  return item && outputId.test(item.id) && item.source === 'mix' && hashPattern.test(item.sha256)
    && Number.isSafeInteger(item.bytes) && item.bytes > 0
    && typeof item.filename === 'string' && /^[^\\/:\x00-\x1f]{1,240}\.(?:mp4|mov|m4v|webm)$/i.test(item.filename);
}

// All requests target a configured service and fixed ID routes. Neither browser
// supplied paths nor URLs returned by that service become download destinations.
export function createStudioOutputSource({ upstreamUrl, timeoutMs = 120_000, maxListBytes = 2 * 1024 * 1024 } = {}) {
  let base;
  try {
    base = new URL(upstreamUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) base = null;
  } catch {}
  function request(suffix, headers = {}) {
    if (!base) throw error('STUDIO_OUTPUTS_UNAVAILABLE', '成片来源尚未连接', 503);
    return new Promise((resolve, reject) => {
      const target = new URL(suffix, base);
      const req = (target.protocol === 'https:' ? https : http).get(target, {
        headers: { Host: target.hostname === 'host.docker.internal' ? `127.0.0.1:${target.port || '8890'}` : target.host, 'Accept-Encoding': 'identity', ...headers },
      }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(error(response.statusCode === 409 ? 'CONTENT_FILE_CHANGED' : 'STUDIO_OUTPUT_UNAVAILABLE', response.statusCode === 409 ? '成片在确认期间已改变，请刷新后重新确认' : '成片来源暂时不可读取', response.statusCode === 409 ? 409 : 502));
        } else resolve(response);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Studio timeout')));
      req.on('error', () => reject(error('STUDIO_OUTPUTS_UNAVAILABLE', '成片来源暂时不可读取', 502)));
    });
  }
  return {
    async list() {
      const response = await request('/api/studio/outputs');
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > maxListBytes) throw error('STUDIO_OUTPUTS_INVALID', '成片清单超出读取限制', 502);
          chunks.push(chunk);
        }
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('STUDIO_OUTPUTS_INVALID', '成片清单格式无效', 502); }
        if (!Array.isArray(result.items) || result.items.length > 1000) throw error('STUDIO_OUTPUTS_INVALID', '成片清单格式无效', 502);
        return { items: result.items.filter(validOutput) };
      } finally { response.destroy(); }
    },
    async open(item) {
      if (!validOutput(item)) throw error('STUDIO_OUTPUT_INVALID', '成片不存在', 404);
      const stream = await request(`/api/studio/outputs/${encodeURIComponent(item.id)}/file`, { 'If-Match': `"${item.sha256}"` });
      return { stream, contentLength: stream.headers['content-length'] };
    },
  };
}

export function createStudioOutputLibrary({ library, source, mountPath = '/video-workbench' }) {
  let confirmationTail = Promise.resolve();
  let discoveryTail = Promise.resolve();
  async function verifiedSnapshot() {
    const snapshot = await library.list();
    for (const item of allItems(snapshot).filter(item => item.admissionStatus === 'approved')) {
      try { await library.verify(item.id); }
      catch { item.admissionStatus = 'pending'; }
    }
    return snapshot;
  }
  function recordFor(item, snapshot) {
    return allItems(snapshot).find(record => record.source === 'editing' && record.sourceId === `studio:${item.id}`
      && record.sha256 === item.sha256 && record.sizeBytes === item.bytes);
  }
  function mixItem(item, snapshot) {
    const record = recordFor(item, snapshot);
    const approved = record?.admissionStatus === 'approved';
    const poster = typeof item.posterPath === 'string' && /^\/bundled\/posters\/[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/.test(item.posterPath) ? mountPath + item.posterPath : null;
    return { id: item.id, title: String(item.title || item.filename).slice(0, 500), source: 'mix',
      videoPath: `${mountPath}/api/studio/outputs/${encodeURIComponent(item.id)}/file`, posterPath: poster,
      durationSeconds: Number.isFinite(item.durationSeconds) ? item.durationSeconds : null,
      bytes: item.bytes, sha256: item.sha256, filename: item.filename,
      status: approved ? 'approved' : 'pending', materialId: record?.id || null,
      ...Object.fromEntries(['style', 'styleId', 'sourceSkill', 'subtitle', 'description', 'orientation'].filter(key => typeof item[key] === 'string').map(key => [key, item[key].slice(0, key === 'description' ? 2000 : 500)])),
      ...Object.fromEntries(['width', 'height'].filter(key => Number.isSafeInteger(item[key]) && item[key] > 0).map(key => [key, item[key]])),
      bundled: item.bundled === true };
  }
  function automaticItems(snapshot) {
    return allItems(snapshot).filter(item => item.source === 'automatic' && item.mediaType === 'video' && item.artifactType === 'final_video').map(item => ({
      id: `automatic-${item.id}`, sourceId: item.sourceId, title: item.title, source: 'automatic', videoPath: item.mediaUrl,
      posterPath: null, durationSeconds: item.durationSeconds, width: item.width, height: item.height, bytes: item.sizeBytes, sha256: item.sha256,
      status: item.admissionStatus === 'approved' ? 'approved' : 'pending',
      materialId: item.id,
    }));
  }
  async function localMixItems(snapshot, remoteIds) {
    const items = [], seen = new Set(remoteIds);
    const records = allItems(snapshot).filter(item => item.source === 'editing' && item.sourceId?.startsWith('studio:')
      && item.mediaType === 'video' && item.artifactType === 'final_video')
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    for (const record of records) {
      const id = record.sourceId.slice('studio:'.length);
      if (!outputId.test(id) || seen.has(id)) continue;
      // Retained copies remain useful when the companion or original export is
      // unavailable, but only while their actual stored bytes still verify.
      try { await library.verify(record.id); } catch { continue; }
      seen.add(id);
      const approved = record.admissionStatus === 'approved';
      items.push({ record, item: { id, title: record.title, source: 'mix', videoPath: record.mediaUrl,
        posterPath: null, durationSeconds: record.durationSeconds, width: record.width, height: record.height, bytes: record.sizeBytes, sha256: record.sha256,
        status: approved ? 'approved' : 'pending', materialId: record.id } });
    }
    return items;
  }
  async function receiveMix(item, actor) {
    const opened = await source.open(item);
    try {
      return (await library.receive(opened.stream, {
        source: 'editing', filename: item.filename, title: item.title, artifactType: 'final_video',
      }, actor, { contentLength: opened.contentLength, sourceId: `studio:${item.id}`, expectedSha256: item.sha256, expectedBytes: item.bytes })).item;
    } finally { opened.stream.destroy(); }
  }
  function discoverMix(items) {
    const operation = discoveryTail.then(async () => {
      let snapshot = await verifiedSnapshot();
      const failures = new Map();
      for (const item of items.filter(validOutput)) {
        try {
          const existing = recordFor(item, snapshot);
          if (existing) {
            // Discovery reuses a verified version. It must not silently repair
            // a damaged approved copy and present that as a new confirmation.
            await library.verify(existing.id);
            continue;
          }
          await receiveMix(item, 'video-studio-discovery');
          snapshot = await library.list();
        } catch (failure) {
          failures.set(item.id, failure instanceof ContentLibraryError ? failure.message : '成片暂未同步到公共素材库，请稍后重试');
        }
      }
      return { snapshot: await verifiedSnapshot(), failures };
    });
    discoveryTail = operation.catch(() => {});
    return operation;
  }
  async function inventory(actor) {
    let remote = [], offline = false;
    try { remote = (await source.list({ actor })).items.filter(validOutput); }
    catch { offline = true; }
    const { snapshot, failures } = await discoverMix(remote);
    const fallback = await localMixItems(snapshot, remote.map(item => item.id));
    const warnings = [];
    if (offline) warnings.push(fallback.length ? '混剪制作服务暂时不可读取；仍可查看已保存的本地成片' : '混剪制作服务暂时不可读取，暂无可用的本地成片副本');
    if (failures.size) warnings.push(`${failures.size} 条成片暂未完成公共素材同步，其余成片已保留`);
    return { snapshot, remote, fallback, failures, warnings };
  }
  async function confirmMix(item, actor, snapshot) {
    let record = recordFor(item, snapshot || await library.list());
    // Normal confirmation changes admission only. An explicit confirmation can
    // also retry a failed copy or repair damaged storage from the trusted source.
    if (record) { try { await library.verify(record.id); } catch { record = null; } }
    if (!record) record = await receiveMix(item, actor);
    const reviewed = await library.setAdmission(record.id, 'approved', actor);
    return { materialId: reviewed.item.id, status: 'approved' };
  }
  async function confirmBatch(ids, actor) {
    if (typeof actor !== 'string' || !actor.trim() || actor.length > 200) throw error('CONTENT_ADMISSION_ACTOR_REQUIRED', '确认入库需要有效的管理员身份', 401);
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string' || !outputId.test(id))) {
      throw error('STUDIO_CONFIRM_INVALID', '请选择一至一百条待确认成片', 400);
    }
    const operation = confirmationTail.then(async () => {
      const { snapshot, remote, fallback } = await inventory(actor);
      const automatic = new Map(automaticItems(snapshot).map(item => [item.id, item]));
      const localMix = new Map(fallback.map(entry => [entry.item.id, entry.record]));
      const materials = new Map(allItems(snapshot).map(item => [item.id, item]));
      const results = [];
      for (const id of new Set(ids)) {
        try {
          let approved;
          const material = /^[a-f0-9]{32}$/.test(id) ? materials.get(id) : null;
          const local = material || automatic.get(id) || localMix.get(id);
          if (local) {
            const materialId = material?.id || localMix.get(id)?.id || id.slice('automatic-'.length);
            await library.setAdmission(materialId, 'approved', actor);
            approved = { materialId, status: 'approved' };
          } else {
            const item = remote.find(item => item.id === id);
            if (!item) throw error('STUDIO_OUTPUT_NOT_FOUND', '成片不存在或来源暂时不可用', 404);
            approved = await confirmMix(item, actor, snapshot);
          }
          results.push({ id, ok: true, ...approved });
        } catch (failure) {
          results.push({ id, ok: false, error: failure instanceof ContentLibraryError ? failure.message : '成片确认失败，请稍后重试', code: failure.code || 'STUDIO_CONFIRM_FAILED' });
        }
      }
      return { results, summary: { approved: results.filter(item => item.ok).length, failed: results.filter(item => !item.ok).length } };
    });
    confirmationTail = operation.catch(() => {});
    return operation;
  }
  function outputs({ snapshot, remote, fallback, failures, warnings }) {
    return { items: [...remote.map(item => ({ ...mixItem(item, snapshot), ...(failures.has(item.id) ? { syncError: failures.get(item.id) } : {}) })), ...fallback.map(entry => entry.item), ...automaticItems(snapshot)], ...(warnings.length ? { warnings } : {}) };
  }
  return {
    async list({ actor } = {}) {
      return outputs(await inventory(actor));
    },
    async materials({ actor } = {}) {
      const state = await inventory(actor), result = outputs(state);
      const covered = new Set(result.items.map(item => item.materialId).filter(Boolean));
      const legacy = [...state.snapshot.items, ...state.snapshot.pendingItems].filter(item => !covered.has(item.id)).map(item => ({
        id: item.id, materialId: item.id, title: item.title, source: 'legacy', originalSource: item.source,
        libraryItem: true, styleLabel: '历史素材', mediaType: item.mediaType,
        mediaUrl: item.mediaUrl, videoPath: item.mediaUrl, posterPath: item.mediaType === 'image' ? item.mediaUrl : null,
        durationSeconds: item.durationSeconds, width: item.width, height: item.height,
        bytes: item.sizeBytes, sha256: item.sha256, status: item.admissionStatus === 'approved' ? 'approved' : 'pending',
      }));
      return { ...result, items: [...result.items, ...legacy] };
    },
    async sync({ actor } = {}) { const { warnings } = await inventory(actor); return { warnings }; },
    confirmBatch,
    publishingLibrary: {
      async list({ items }) {
        const { snapshot } = await discoverMix(items);
        return { items: items.filter(validOutput).map(item => mixItem(item, snapshot)) };
      },
      async confirm(item, { actor }) {
        if (typeof actor !== 'string' || !actor.trim()) throw error('CONTENT_ADMISSION_ACTOR_REQUIRED', '确认入库需要有效的管理员身份', 401);
        if (!validOutput(item)) throw error('STUDIO_OUTPUT_INVALID', '成片不存在', 404);
        return confirmMix(item, actor);
      },
    },
  };
}
