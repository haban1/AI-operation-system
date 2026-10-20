import crypto from 'node:crypto';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeUrl = value => {
  try {
    const url = new URL(String(value || ''));
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return clean(value); }
};
const stableList = value => [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))].sort();
const normalizeTextLines = value => stableList(Array.isArray(value) ? value : String(value || '').split(/\r?\n/))
  .map(item => item.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '<time>').replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '<date>').replace(/\b\d{5,}\b/g, '<number>'))
  .filter(item => item.length >= 2)
  .slice(0, 120);

export function normalizeSmokePage(page = {}) {
  const selectorHits = Object.fromEntries(Object.entries(page.selectorHits || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Boolean(value)]));
  const structure = Object.fromEntries(Object.entries(page.structure || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Number(value) || 0]));
  return {
    key: clean(page.key || page.name || normalizeUrl(page.url)),
    name: clean(page.name || page.key || '页面'),
    url: normalizeUrl(page.url),
    title: clean(page.title),
    keyText: normalizeTextLines(page.keyText),
    controls: stableList(page.controls).slice(0, 100),
    selectorHits,
    structure,
    screenshotPath: clean(page.screenshotPath) || null,
    capturedAt: page.capturedAt || null
  };
}

export function normalizeSmokeSnapshot(snapshot = {}) {
  return {
    platformCode: clean(snapshot.platformCode),
    capturedAt: snapshot.capturedAt || null,
    pages: (Array.isArray(snapshot.pages) ? snapshot.pages : []).map(normalizeSmokePage).sort((a, b) => a.key.localeCompare(b.key))
  };
}

export function smokeFingerprint(snapshot = {}) {
  const normalized = normalizeSmokeSnapshot(snapshot);
  const stable = {
    platformCode: normalized.platformCode,
    pages: normalized.pages.map(page => ({ key: page.key, url: page.url, title: page.title, keyText: page.keyText, controls: page.controls, selectorHits: page.selectorHits, structure: page.structure }))
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function jaccard(left = [], right = []) {
  const a = new Set(left); const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 1;
  let common = 0; for (const item of a) if (b.has(item)) common += 1;
  return common / union.size;
}
function listDifference(left = [], right = []) { const set = new Set(right); return left.filter(item => !set.has(item)); }

export function compareSmokeSnapshots(baselineInput, currentInput) {
  const baseline = normalizeSmokeSnapshot(baselineInput);
  const current = normalizeSmokeSnapshot(currentInput);
  const baselinePages = new Map(baseline.pages.map(page => [page.key, page]));
  const currentPages = new Map(current.pages.map(page => [page.key, page]));
  const pageKeys = [...new Set([...baselinePages.keys(), ...currentPages.keys()])].sort();
  const pages = [];
  let changed = false;
  for (const key of pageKeys) {
    const before = baselinePages.get(key); const after = currentPages.get(key);
    if (!before || !after) {
      changed = true;
      pages.push({ key, name: after?.name || before?.name || key, changed: true, severity: 'HIGH', reasons: [before ? '关键页面无法采集' : '发现新的关键页面'], before: before || null, after: after || null });
      continue;
    }
    const reasons = [];
    const selectorChanges = [];
    for (const selector of [...new Set([...Object.keys(before.selectorHits), ...Object.keys(after.selectorHits)])].sort()) {
      const from = Boolean(before.selectorHits[selector]); const to = Boolean(after.selectorHits[selector]);
      if (from !== to) selectorChanges.push({ selector, from, to });
    }
    if (selectorChanges.some(item => item.from && !item.to)) reasons.push('已有关键 selector 失效');
    else if (selectorChanges.length) reasons.push('关键 selector 命中发生变化');
    if (before.url !== after.url) reasons.push('页面 URL 路径发生变化');
    if (before.title !== after.title) reasons.push('页面标题发生变化');
    const controlsRemoved = listDifference(before.controls, after.controls);
    const controlsAdded = listDifference(after.controls, before.controls);
    const controlSimilarity = jaccard(before.controls, after.controls);
    if (controlSimilarity < 0.72 || controlsRemoved.length >= 3) reasons.push('关键控件集合发生明显变化');
    const textSimilarity = jaccard(before.keyText, after.keyText);
    if (textSimilarity < 0.58) reasons.push('页面关键文本发生明显变化');
    const structureKeys = [...new Set([...Object.keys(before.structure), ...Object.keys(after.structure)])];
    const structureDelta = structureKeys.reduce((sum, item) => sum + Math.abs((before.structure[item] || 0) - (after.structure[item] || 0)), 0);
    const structureBase = Math.max(1, structureKeys.reduce((sum, item) => sum + (before.structure[item] || 0), 0));
    const structureRatio = structureDelta / structureBase;
    if (structureRatio > 0.35) reasons.push('页面结构摘要发生明显变化');
    const pageChanged = reasons.length > 0;
    changed ||= pageChanged;
    pages.push({ key, name: after.name, changed: pageChanged, severity: selectorChanges.some(item => item.from && !item.to) ? 'HIGH' : pageChanged ? 'MEDIUM' : 'NONE', reasons, selectorChanges, controlsAdded: controlsAdded.slice(0, 30), controlsRemoved: controlsRemoved.slice(0, 30), controlSimilarity, textSimilarity, structureRatio, beforeScreenshotPath: before.screenshotPath, currentScreenshotPath: after.screenshotPath, before: { url: before.url, title: before.title }, after: { url: after.url, title: after.title } });
  }
  return { changed, summary: changed ? '检测到页面结构或关键控件变化' : '未发现实质页面变化', pages, baselineFingerprint: smokeFingerprint(baseline), currentFingerprint: smokeFingerprint(current) };
}

export function screenshotPaths(snapshot = {}) {
  return normalizeSmokeSnapshot(snapshot).pages.map(page => page.screenshotPath).filter(Boolean);
}
