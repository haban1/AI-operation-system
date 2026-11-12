import { fail, validId } from './errors.mjs';

export const editableFields = ['title', 'subtitle', 'brand', 'accent', 'beat1', 'beat2', 'beat3'];
export const editableSettings = ['titles', 'brand', 'intensity', 'textOffset', 'layerOrder'];

function limitedText(value, maximum, label) {
  if (typeof value !== 'string' || value.length > maximum) fail(422, 'INVALID_BRIEF', `${label}最多 ${maximum} 个字符`);
  return value.trim();
}

function identifiers(value, allowed, label) {
  if (!Array.isArray(value) || value.length > 5000 || value.some(id => !allowed.has(id)) || new Set(value).size !== value.length) {
    fail(422, 'INVALID_SELECTION', `${label}包含不可用或重复的内容`);
  }
  return [...value];
}

export function projectLocks(project) {
  return { slots: [], fields: [], audio: false, settings: [], ...project.locks };
}

export function validateLocks(value, template) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['slots', 'fields', 'audio', 'settings'].includes(key))) {
    fail(422, 'INVALID_LOCKS', '锁定配置不正确');
  }
  if (typeof value.audio !== 'boolean') fail(422, 'INVALID_LOCKS', '音乐锁定状态不正确');
  return {
    slots: identifiers(value.slots, new Set(template.slots.map(slot => slot.id)), '画面锁定'),
    fields: identifiers(value.fields, new Set(editableFields), '文案锁定'),
    audio: value.audio,
    settings: identifiers(value.settings, new Set(editableSettings), '动效锁定'),
  };
}

export function validateBrief(value, assets) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['request', 'facts', 'subject', 'assetIds', 'sourceId'].includes(key))) {
    fail(422, 'INVALID_BRIEF', '制作要求配置不正确');
  }
  return {
    ...(value.sourceId ? { sourceId: assertKnownId(value.sourceId) } : {}),
    request: limitedText(value.request ?? '', 2000, '制作要求'),
    facts: limitedText(value.facts ?? '', 4000, '事实资料'),
    subject: limitedText(value.subject ?? '', 80, '素材分组'),
    assetIds: identifiers(value.assetIds ?? [], new Set(assets.filter(asset => asset.type !== 'audio').map(asset => asset.id)), 'AI 候选素材'),
  };
}

export function validateAssetNotes(value, current) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['expectedRevision', 'description', 'subject', 'tags'].includes(key))) {
    fail(422, 'INVALID_ASSET_NOTES', '素材说明配置不正确');
  }
  if (value.expectedRevision !== (current.notesRevision || 0)) fail(409, 'STALE_ASSET_NOTES', '素材说明已更新，请刷新后重试');
  if (!Array.isArray(value.tags) || value.tags.length > 16) fail(422, 'INVALID_ASSET_NOTES', '素材标签最多 16 个');
  return {
    description: limitedText(value.description ?? '', 500, '素材说明'),
    subject: limitedText(value.subject ?? '', 80, '素材分组'),
    tags: [...new Set(value.tags.map(tag => limitedText(tag, 40, '素材标签')).filter(Boolean))],
    notesRevision: (current.notesRevision || 0) + 1,
  };
}

export function revisionSummary(project) {
  return {
    revision: project.revision,
    name: project.name,
    updatedAt: project.updatedAt,
    source: project.editSource || 'manual',
    summary: project.editSummary || '保存工程',
    restoredFrom: project.restoredFrom || null,
  };
}

export function assertRevision(project, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== project.revision) fail(409, 'STALE_REVISION', '工程已更新，请刷新后重新操作');
}

export function validateScope(input, template) {
  const scope = input || { kind: 'all', ids: [] };
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['kind', 'ids'].includes(key))) fail(422, 'INVALID_SCOPE', '请选择重做范围');
  if (!['all', 'slots', 'fields', 'audio', 'instruction'].includes(scope.kind)) fail(422, 'INVALID_SCOPE', '不支持此重做范围');
  const allowed = new Set(scope.kind === 'slots' ? template.slots.map(slot => slot.id) : scope.kind === 'fields' ? editableFields : []);
  const ids = identifiers(scope.ids || [], allowed, '重做范围');
  if (['slots', 'fields'].includes(scope.kind) && !ids.length) fail(422, 'INVALID_SCOPE', '请选择要重做的画面或文案');
  return { kind: scope.kind, ids };
}

export function assertKnownId(id) {
  if (!validId(id)) fail(400, 'INVALID_ID', '记录标识不正确');
  return id;
}
