import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, digest, editProject, fail } from './domain.mjs';
import { assertKnownId, assertRevision, editableFields, editableSettings, projectLocks, validateScope } from './editor-state.mjs';
import { musicTracks } from './music.mjs';

const operationKeys = ['type', 'target', 'assetId', 'text', 'inPoint', 'focusX', 'focusY', 'number', 'enabled'];

// Only infer a strict shot boundary for an unambiguous footage-only instruction.
// Mixed instructions continue to use their explicit UI scope and validated plan.
export function instructionScope(scope, instruction, template) {
  if (scope.kind !== 'instruction' || /音乐|配乐|BGM|音量|音效|文案|标题|字幕|短句|署名|品牌|图层|动效|全部|所有|其余镜头|其他镜头也|除了|除第|不要改|不改|保持.*镜头/i.test(instruction)) return scope;
  const chinese = { 一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10 };
  const numbers = [...instruction.matchAll(/第\s*([\d一二两三四五六七八九十]+(?:\s*[、,，和及与]\s*(?:第\s*)?[\d一二两三四五六七八九十]+)*)\s*(?:个)?\s*(?:镜头|画面)/g)]
    .flatMap(match => match[1].split(/[、,，和及与]/).map(value => value.replace(/第|\s/g, '')))
    .map(value => /^\d+$/.test(value) ? Number(value) : chinese[value]);
  if (!numbers.length) return scope;
  if (numbers.some(number => !Number.isInteger(number) || number < 1 || number > template.slots.length)) fail(422, 'AI_SCOPE_INVALID', '指令中的镜头编号超出当前工程，请按时间轴编号选择');
  return { kind:'slots', ids:[...new Set(numbers.map(number => template.slots[number-1].id))] };
}

function assetVersion(assets) {
  return digest(assets.map(asset => [asset.id, asset.sourceSha256 || asset.mediaSha256, asset.notesRevision || 0, asset.description || '', asset.subject || '', asset.tags || []]).sort((left, right) => left[0].localeCompare(right[0])));
}

function readableText(value, maximum, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, maximum);
}

export function publicAiRun(run) {
  return {
    id: run.id, projectId: run.projectId, baseRevision: run.baseRevision, resultRevision: run.resultRevision || null,
    mode: run.mode, instruction: run.instruction, scope: run.scope, status: run.status, message: run.message,
    changes: run.changes || [], warnings: run.warnings || [], error: run.error || null, code: run.code || null,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  };
}

export function candidateAssets(project, assets) {
  const brief = project.brief || {};
  const selected = new Set(brief.assetIds || project.slots.map(slot => slot.assetId).filter(Boolean));
  return assets.filter(asset => asset.type !== 'audio' && selected.has(asset.id)
    && (!brief.subject || !asset.subject || asset.subject === brief.subject));
}

export function buildAiContext(project, assets, run, history = []) {
  const template = project.templateSnapshot;
  const maximumHandle = Math.max(...template.slots.map(slot => slot.durationFrames / template.fps));
  const candidates = candidateAssets(project, assets).map(asset => {
    const latestStart = Math.max(0, (asset.duration || 0) - maximumHandle);
    return {
      id: asset.id, name: asset.name, type: asset.type, description: asset.description || '',
      subject: asset.subject || '', tags: asset.tags || [], duration: asset.duration,
      width: asset.width, height: asset.height,
      candidateInPoints: asset.type === 'image' ? [0] : asset.frames?.map(frame => frame.inPoint) || [...new Set([0, .2, .4, .6, .8, 1].map(part => Math.floor(part * latestStart * 30) / 30))],
    };
  });
  return {
    mode: run.mode, instruction: run.instruction, scope: run.scope,
    request: project.brief?.request || '根据已选素材制作15秒短片，文案简洁自然，沿用当前配乐。', facts: project.brief?.facts || '', subject: project.brief?.subject || '',
    locks: projectLocks(project),
    musicPolicy: '沿用当前配乐。仅当用户明确要求更换音乐或仅重做音乐时修改音轨。',
    project: {
      fields: project.fields, slots: project.slots, audio: project.audio, settings: project.settings,
      durationSeconds: 15, fps: 30,
      slotDefinitions: template.slots.map((slot,index) => ({ id: slot.id, shotNumber:index+1, durationSeconds: slot.durationFrames / template.fps, startsAtSeconds: slot.startFrame / template.fps })),
    },
    assets: candidates,
    audioAssets: assets.filter(asset => asset.type === 'audio').map(({ id, name, duration, description, tags }) => ({ id, name, duration, description, tags })),
    music: musicTracks.map(({ id, title, bpm, mood }) => ({ id, title, bpm, mood })),
    recentConversation: history.slice(-6).map(item => ({ instruction: item.instruction, result: item.message, changes: item.changes || [] })),
  };
}

function allowsOperation(scope, operation) {
  if (['all', 'instruction'].includes(scope.kind)) return true;
  if (scope.kind === 'slots') return operation.type === 'slot' && scope.ids.includes(operation.target);
  if (scope.kind === 'fields') return operation.type === 'field' && scope.ids.includes(operation.target);
  return scope.kind === 'audio' && operation.type === 'audio';
}

function ensureGroundedNumbers(text, facts) {
  const supported = new Set((facts.match(/\d+(?:\.\d+)?/g) || []).map(Number));
  for (const number of text.match(/\d+(?:\.\d+)?/g) || []) {
    if (!supported.has(Number(number))) fail(422, 'AI_UNSUPPORTED_FACT', 'AI 文案包含事实资料中没有的数字，请补充资料或重新生成');
  }
}

export function applyAiPlan(project, assets, run, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some(key => !['message', 'warnings', 'operations'].includes(key))
    || typeof plan.message !== 'string' || !Array.isArray(plan.warnings) || plan.warnings.some(value => typeof value !== 'string')
    || !Array.isArray(plan.operations) || plan.operations.length > 40) fail(422, 'AI_INVALID_PLAN', 'AI 返回的编辑方案格式不正确');
  const input = {
    expectedRevision: project.revision,
    fields: { ...project.fields }, slots: structuredClone(project.slots),
    audio: { ...project.audio }, settings: { ...project.settings },
  };
  const locks = projectLocks(project);
  const candidateIds = new Set(candidateAssets(project, assets).map(asset => asset.id));
  const audioIds = new Set(assets.filter(asset => asset.type === 'audio').map(asset => asset.id));
  const seen = new Set();
  const changes = [];
  const facts = [project.brief?.facts, project.brief?.request, run.instruction, ...Object.values(project.fields)].filter(Boolean).join('\n');
  for (const operation of plan.operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation) || Object.keys(operation).some(key => !operationKeys.includes(key))) fail(422, 'AI_INVALID_OPERATION', 'AI 返回了不支持的编辑操作');
    if (operation.type === 'audio' && (run.mode === 'generate' || (run.scope.kind !== 'audio' && !/音乐|配乐|BGM|音量|音效|淡入|淡出/i.test(run.instruction)))) continue;
    const identity = `${operation.type}:${operation.target}`;
    if (seen.has(identity)) fail(422, 'AI_DUPLICATE_OPERATION', 'AI 对同一内容返回了重复修改');
    seen.add(identity);
    if (!allowsOperation(run.scope, operation)) fail(422, 'AI_SCOPE_VIOLATION', 'AI 修改超出本次选定范围，工程已保留');
    if (operation.type === 'field') {
      if (!editableFields.includes(operation.target) || typeof operation.text !== 'string') fail(422, 'AI_INVALID_FIELD', 'AI 文案字段不正确');
      if (operation.text === project.fields[operation.target]) continue;
      if (locks.fields.includes(operation.target)) fail(409, 'AI_LOCKED', 'AI 尝试修改已锁定文案，工程已保留');
      if (operation.target !== 'accent') ensureGroundedNumbers(operation.text, facts);
      input.fields[operation.target] = operation.text;
      changes.push({ type: 'field', target: operation.target, before: project.fields[operation.target], after: operation.text });
    } else if (operation.type === 'slot') {
      const slot = input.slots.find(item => item.id === operation.target);
      if (!slot || !candidateIds.has(operation.assetId)) fail(422, 'AI_INVALID_ASSET', 'AI 选择了候选范围外或其他分组的素材');
      const next = { id: slot.id, assetId: operation.assetId, inPoint: operation.inPoint, focusX: operation.focusX, focusY: operation.focusY };
      if (digest(next) === digest(slot)) continue;
      if (locks.slots.includes(slot.id)) fail(409, 'AI_LOCKED', 'AI 尝试修改已锁定画面，工程已保留');
      Object.assign(slot, next);
      changes.push({ type: 'slot', target: slot.id, assetId: slot.assetId, inPoint: slot.inPoint });
    } else if (operation.type === 'audio') {
      if (locks.audio) fail(409, 'AI_LOCKED', 'AI 尝试修改已锁定音乐，工程已保留');
      if (operation.target === 'track') {
        if (operation.assetId !== null && !audioIds.has(operation.assetId)) fail(422, 'AI_INVALID_AUDIO', 'AI 选择了不可用的音频');
        if (!operation.assetId && operation.text !== 'template' && !musicTracks.some(track => track.id === operation.text)) fail(422, 'AI_INVALID_AUDIO', 'AI 选择了不可用的内置音乐');
        input.audio.assetId = operation.assetId;
        input.audio.trackId = operation.assetId ? 'template' : operation.text;
        input.audio.inPoint = operation.assetId ? operation.inPoint : 0;
      } else if (['volume', 'sfxVolume', 'fadeIn', 'fadeOut', 'offset'].includes(operation.target)) input.audio[operation.target] = operation.number;
      else if (['musicEnabled', 'sfxEnabled'].includes(operation.target)) input.audio[operation.target] = operation.enabled;
      else fail(422, 'AI_INVALID_AUDIO', 'AI 音乐操作不正确');
      changes.push({ type: 'audio', target: operation.target });
    } else if (operation.type === 'setting') {
      if (!editableSettings.includes(operation.target)) fail(422, 'AI_INVALID_SETTING', 'AI 动效操作不正确');
      if (locks.settings.includes(operation.target)) fail(409, 'AI_LOCKED', 'AI 尝试修改已锁定动效，工程已保留');
      if (operation.target === 'layerOrder') input.settings.layerOrder = typeof operation.text === 'string' ? operation.text.split(',').map(value => value.trim()) : null;
      else input.settings[operation.target] = ['intensity', 'textOffset'].includes(operation.target) ? operation.number : operation.enabled;
      changes.push({ type: 'setting', target: operation.target });
    } else fail(422, 'AI_INVALID_OPERATION', 'AI 返回了不支持的编辑操作');
  }
  if (run.mode === 'generate' && input.slots.some(slot => !slot.assetId)) fail(422, 'AI_INCOMPLETE_DRAFT', 'AI 尚未补齐全部画面，请补充候选素材后重试');
  if (!changes.length) return { project, changes, message: readableText(plan.message, 1000), warnings: plan.warnings.slice(0, 12).map(value => readableText(value, 300)) };
  const next = editProject(project, input, project.templateSnapshot, assets);
  next.editSource = 'ai';
  next.editSummary = readableText(plan.message, 200, 'AI 修改');
  next.aiRunId = run.id;
  delete next.restoredFrom;
  return { project: next, changes, message: readableText(plan.message, 1000), warnings: plan.warnings.slice(0, 12).map(value => readableText(value, 300)) };
}

export class AiEditing {
  constructor({ store, planner, assetsForProject = () => store.all('assets'), prepareAssets = async (project, plan, assets) => assets }) {
    this.store = store;
    this.planner = planner;
    this.assetsForProject = assetsForProject;
    this.prepareAssets = prepareAssets;
    this.queue = [];
    this.active = null;
  }

  async init() {
    for (const run of await this.store.all('ai-runs')) {
      if (!['queued', 'running'].includes(run.status)) continue;
      const current = await this.store.get('projects', run.projectId).catch(() => null);
      if (current?.aiRunId === run.id && current.revision === run.resultRevision) {
        await this.update(run, { status: 'succeeded', message: run.resultMessage || current.editSummary, error: null, code: null });
      } else await this.update(run, { status: 'failed', message: '服务已重启，请重新提交任务', error: '上一轮 AI 任务已中断，工程保留最后保存的修订', code: 'AI_INTERRUPTED' });
    }
  }

  async update(run, patch) {
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
    await this.store.put('ai-runs', run);
    return run;
  }

  async enqueue(project, assets, input) {
    if (Object.keys(input).some(key => !['expectedRevision', 'mode', 'instruction', 'scope', 'requestId'].includes(key))) fail(400, 'AI_INPUT_INVALID', 'AI 请求包含不支持的字段');
    if (!['generate', 'regenerate', 'instruction'].includes(input.mode)) fail(422, 'AI_MODE_INVALID', '请选择生成初稿或局部修改');
    if (typeof input.instruction !== 'string' || input.instruction.length > 2000 || (input.mode === 'instruction' && !input.instruction.trim())) fail(422, 'AI_INSTRUCTION_INVALID', '请输入不超过 2000 字的修改要求');
    if (input.mode === 'generate' && !project.brief?.request?.trim() && !project.brief?.sourceId) fail(422, 'AI_BRIEF_REQUIRED', '请先连接素材来源或填写制作要求');
    const scope = instructionScope(validateScope(input.scope, project.templateSnapshot), input.mode === 'instruction' ? input.instruction : '', project.templateSnapshot);
    if (input.mode === 'generate' && scope.kind !== 'all') fail(422, 'AI_SCOPE_INVALID', '生成初稿需要选择全部未锁定内容');
    const id = input.requestId ? assertKnownId(input.requestId) : randomUUID();
    const requestDigest = digest({ projectId: project.id, ...input, scope });
    const existing = await this.store.get('ai-runs', id).catch(() => null);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail(409, 'AI_REQUEST_REUSED', '本次请求标识已用于其他修改');
      return existing;
    }
    assertRevision(project, input.expectedRevision);
    if ((await this.store.all('ai-runs')).some(run => run.projectId === project.id && ['running', 'queued'].includes(run.status))) fail(409, 'AI_PROJECT_BUSY', '此工程正在处理 AI 任务');
    if (this.queue.length >= 4) fail(429, 'AI_QUEUE_FULL', 'AI 任务较多，请稍后再试');
    if (input.mode === 'generate' && !candidateAssets(project, assets).length) fail(422, 'AI_ASSETS_REQUIRED', '请选择当前分组的候选素材');
    if (!(await this.planner.status()).available) fail(503, 'AI_UNAVAILABLE', 'Codex CLI 尚未就绪，请检查本机安装和登录');
    const now = new Date().toISOString();
    const run = {
      id, projectId: project.id, baseRevision: project.revision, mode: input.mode, scope,
      instruction: input.instruction.trim(), requestDigest, status: 'queued', message: '等待 AI 处理',
      createdAt: now, updatedAt: now,
      assetVersion: assetVersion(assets),
    };
    await this.store.put('ai-runs', run);
    this.queue.push(run);
    void this.drain();
    return run;
  }

  async drain() {
    if (this.active) return;
    while (this.queue.length) {
      const run = this.queue.shift();
      const controller = new AbortController();
      this.active = { run, controller };
      try {
        if (run.status === 'cancelled') continue;
        await this.update(run, { status: 'running', message: '正在读取制作要求和素材标签' });
        const project = await this.store.get('projects', run.projectId);
        assertRevision(project, run.baseRevision);
        const assets = await this.assetsForProject(project);
        const history = (await this.store.all('ai-runs')).filter(item => item.projectId === project.id && item.status === 'succeeded').reverse();
        let progressWrite = Promise.resolve();
        const plan = await this.planner.plan(buildAiContext(project, assets, run, history), {
          directory: path.join(this.store.root, 'ai-private', run.id), signal: controller.signal,
          onProgress: message => { progressWrite = progressWrite.then(() => this.update(run, { message })).catch(() => {}); },
        });
        await progressWrite;
        if (controller.signal.aborted) fail(409, 'AI_CANCELLED', '已取消本次 AI 任务');
        const result = await this.store.locked(`project:${project.id}`, async () => {
          const current = await this.store.get('projects', project.id);
          assertRevision(current, run.baseRevision);
          let currentAssets = await this.assetsForProject(current);
          if (assetVersion(currentAssets) !== run.assetVersion) fail(409, 'AI_ASSETS_CHANGED', '候选素材或说明已变化，请重新生成');
          currentAssets = await this.prepareAssets(current, plan, currentAssets);
          if (assetVersion(currentAssets) !== run.assetVersion) fail(409, 'AI_ASSETS_CHANGED', '素材准备期间说明已变化，请重新生成');
          if (controller.signal.aborted) fail(409, 'AI_CANCELLED', '已取消本次 AI 任务');
          const applied = applyAiPlan(current, currentAssets, run, plan);
          await this.update(run, { resultRevision: applied.project.revision, resultMessage: applied.message, changes: applied.changes, warnings: applied.warnings });
          if (controller.signal.aborted) fail(409, 'AI_CANCELLED', '已取消本次 AI 任务');
          if (applied.project.revision !== current.revision) await this.store.saveProject(applied.project);
          return applied;
        });
        await this.update(run, { status: 'succeeded', resultRevision: result.project.revision, message: result.message, changes: result.changes, warnings: result.warnings });
      } catch (error) {
        const applied = await this.store.get('projects', run.projectId).catch(() => null);
        if (applied?.aiRunId === run.id && applied.revision === run.resultRevision) {
          await this.update(run, { status: 'succeeded', message: run.resultMessage || applied.editSummary, error: null, code: null });
          continue;
        }
        const cancelled = controller.signal.aborted || error.code === 'AI_CANCELLED';
        await this.update(run, {
          status: cancelled ? 'cancelled' : error.code === 'STALE_REVISION' ? 'conflict' : 'failed',
          message: cancelled ? '已取消，工程保留已保存的内容' : '本次 AI 修改未应用',
          error: error instanceof AppError ? error.message : 'AI 服务暂时不可用，请重试',
          code: error instanceof AppError ? error.code : 'AI_FAILED',
        });
      } finally {
        this.active = null;
      }
    }
  }

  async cancel(id) {
    const run = await this.store.get('ai-runs', id);
    if (!['queued', 'running'].includes(run.status)) return run;
    if (this.active?.run.id === id) {
      this.active.controller.abort();
      return this.active.run;
    }
    this.queue = this.queue.filter(item => item.id !== id);
    return this.update(run, { status: 'cancelled', message: '已取消本次 AI 任务' });
  }

  async close() {
    for (const run of [...this.queue]) await this.cancel(run.id);
    if (this.active) this.active.controller.abort();
  }
}
