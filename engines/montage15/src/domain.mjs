import { randomUUID, createHash } from 'node:crypto';
import { validateBrief, validateLocks } from './editor-state.mjs';
import { musicTracks } from './music.mjs';
import { fail } from './errors.mjs';
export { AppError, fail, validId } from './errors.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const finite = (value, name, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(422, 'INVALID_VALUE', `${name}应在 ${min}–${max} 之间`);
  return value;
};
const text = (value, name, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(422, 'INVALID_TEXT', `${name}${required ? '不能为空，且' : ''}最多 ${max} 个字符`);
  return value.trim();
};

export function createProject(template, input = {}) {
  const now = new Date().toISOString();
  if (input.format && !(template.formats || []).includes(input.format)) fail(422, 'INVALID_FORMAT', '此模板不支持所选画幅');
  const portrait = template.engine === 'montage15' && input.format === 'portrait';
  return {
    id: randomUUID(), name: text(input.name || `${template.name} · 新项目`, '项目名称', 80, true),
    templateId: template.id, templateVersion: template.version || '1.0.0-stage1',
    templateSnapshot: structuredClone(template), revision: 1,
    width: portrait ? 1080 : template.width, height: portrait ? 1920 : template.height, fps: template.fps, durationFrames: template.durationFrames,
    fields: { ...template.defaults },
    slots: template.slots.map(slot => ({ id: slot.id, assetId: null, inPoint: 0, focusX: 0.5, focusY: 0.5 })),
    audio: { assetId: null, volume: template.engine === 'montage15' ? 0.8 : 0.25,
      musicEnabled: true, sfxEnabled: true, sfxVolume: 0.65, inPoint: 0, fadeIn: 0.12, fadeOut: 0.6 },
    ...(template.supportsColorCards ? { settings: { colorCards: true, titles: true, brand: true, intensity: 0.8 } } : {}),
    createdAt: now, updatedAt: now,
  };
}

export function editProject(current, input, template, assets) {
  template = current.templateSnapshot || template;
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== current.revision)
    fail(409, 'STALE_REVISION', '项目已更新，请重新打开后再修改', { currentRevision: current.revision });
  if (input.templateId && input.templateId !== current.templateId) fail(422, 'TEMPLATE_LOCKED', '请新建项目来使用另一套模板');
  const fields = input.fields || current.fields;
  const nextFields = {
    title: text(fields.title, '标题', 28, true), subtitle: text(fields.subtitle, '副标题', 56),
    brand: text(fields.brand, '品牌名称', 24), accent: fields.accent,
  };
  let settings;
  if (template.supportsColorCards) {
    for (const key of ['beat1', 'beat2', 'beat3']) {
      nextFields[key] = text(fields[key] ?? current.fields[key] ?? template.defaults[key], '穿插短句', 16);
      if (/[\r\n]/.test(nextFields[key])) fail(422, 'TEXT_LAYOUT', '穿插短句请使用单行文字');
    }
    settings = { ...current.settings, ...input.settings };
    for (const key of ['colorCards', 'titles', 'brand']) if (typeof settings[key] !== 'boolean') fail(422, 'INVALID_SETTINGS', '模板开关须为布尔值');
    settings.intensity = finite(settings.intensity, '变形强度', 0, 1);
    if (settings.textOffset !== undefined) settings.textOffset = finite(settings.textOffset, '文字时间偏移', -2, 2);
    if (settings.layerOrder !== undefined && (!Array.isArray(settings.layerOrder) || settings.layerOrder.length !== 3 || new Set(settings.layerOrder).size !== 3 || settings.layerOrder.some(layer => !['media', 'text', 'brand'].includes(layer)))) fail(422, 'INVALID_LAYERS', '图层顺序须包含画面、文案和署名');
    if (![[1920,1080],[1080,1920]].some(([w,h])=>current.width===w&&current.height===h) || current.fps!==30 || current.durationFrames!==450) fail(422, 'INVALID_FORMAT', '输出须为 1080p、30 fps、15 秒');
  }
  if (nextFields.title.split(/\r?\n/).length > 2) fail(422, 'TEXT_LAYOUT', '主标题最多手动分成两行');
  if (nextFields.subtitle.split(/\r?\n/).length > 2) fail(422, 'TEXT_LAYOUT', '副标题最多手动分成两行');
  if (/[\r\n]/.test(nextFields.brand)) fail(422, 'TEXT_LAYOUT', '品牌名称请使用单行文字');
  if (typeof nextFields.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(nextFields.accent)) fail(422, 'INVALID_COLOR', '主题颜色须为六位十六进制颜色');
  const requested = input.slots || current.slots;
  if (!Array.isArray(requested) || requested.length !== template.slots.length || requested.some(s => !s || typeof s !== 'object' || Array.isArray(s)) || new Set(requested.map(s => s.id)).size !== requested.length)
    fail(422, 'INVALID_SLOTS', '素材槽位数量或标识不正确');
  const byId = new Map(assets.map(a => [a.id, a]));
  const slots = template.slots.map(def => {
    const slot = requested.find(s => s.id === def.id);
    if (!slot) fail(422, 'INVALID_SLOTS', `缺少素材位置：${def.name}`);
    const assetId = slot.assetId || null;
    const inPoint = finite(slot.inPoint ?? 0, `${def.name}取材起点`, 0, 86400);
    if (assetId) {
      const asset = byId.get(assetId);
      if (!asset || !['image', 'video'].includes(asset.type)) fail(422, 'INVALID_ASSET', `${def.name}请选择已导入的图片或视频`);
      if (asset.type === 'image' && inPoint !== 0) fail(422, 'IMAGE_IN_POINT', `${def.name}是图片，取材起点应为 0`);
      if (asset.type === 'video' && inPoint + def.durationFrames / template.fps > asset.duration + 0.015)
        fail(422, 'SHORT_ASSET', `${def.name}可用视频不足 ${def.durationFrames / template.fps} 秒，请换素材或调整取材起点`, { slotId: def.id });
    }
    return { id: def.id, assetId, inPoint, focusX: finite(slot.focusX ?? 0.5, '横向裁切位置', 0, 1), focusY: finite(slot.focusY ?? 0.5, '纵向裁切位置', 0, 1) };
  });
  const audio = input.audio || current.audio;
  if (typeof audio !== 'object' || Array.isArray(audio)) fail(422, 'INVALID_AUDIO', '音乐配置不正确');
  const assetId = audio.assetId || null;
  const inPoint = finite(audio.inPoint ?? 0, '音乐取材起点', 0, 86400);
  for (const key of ['musicEnabled', 'sfxEnabled']) if (audio[key] !== undefined && typeof audio[key] !== 'boolean') fail(422, 'INVALID_AUDIO', '音轨开关须为布尔值');
  if (assetId) {
    const asset = byId.get(assetId);
    if (!asset || asset.type !== 'audio') fail(422, 'INVALID_AUDIO', '背景音乐请选择已导入的音频文件');
    if (asset.duration - inPoint < template.durationFrames / template.fps - 0.015) fail(422, 'SHORT_AUDIO', '从音乐取材起点起不足 15 秒，请换音乐或调整起点；本阶段不会自动循环');
  }
  const trackId = audio.trackId ?? 'template';
  if (trackId !== 'template' && !musicTracks.some(track => track.id === trackId)) fail(422, 'INVALID_AUDIO', '请选择可用的内置音乐');
  return { ...current, name: text(input.name ?? current.name, '项目名称', 80, true), fields: nextFields,
    ...(input.locks ? { locks: validateLocks(input.locks, template) } : {}),
    ...(input.brief ? { brief: validateBrief(input.brief, assets) } : {}),
    slots, ...(settings ? { settings } : {}), audio: { assetId, volume: finite(audio.volume ?? 0.8, '音乐音量', 0, 1),
      trackId,
      ...(audio.offset !== undefined ? { offset: finite(audio.offset, '音乐时间偏移', -3, 3) } : {}),
      musicEnabled: audio.musicEnabled ?? true, sfxEnabled: audio.sfxEnabled ?? true,
      sfxVolume: finite(audio.sfxVolume ?? 0.65, '音效音量', 0, 1), inPoint,
      fadeIn: finite(audio.fadeIn ?? 0.12, '音乐淡入', 0, 3), fadeOut: finite(audio.fadeOut ?? 0.6, '音乐淡出', 0, 3) }, revision: current.revision + 1, updatedAt: new Date().toISOString() };
}

export function assertRenderable(project, template, assets) {
  // Re-run content and duration checks against the current asset metadata.
  editProject(project, { ...project, expectedRevision: project.revision }, template, assets);
  const missing = template.slots.filter(def => !project.slots.find(s => s.id === def.id)?.assetId).map(s => s.name);
  if (missing.length && !(template.supportsColorCards && project.settings?.colorCards)) fail(422, 'MISSING_ASSETS', `请先替换全部示例素材：${missing.join('、')}`, { missing });
}
