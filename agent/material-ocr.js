import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import sharp from 'sharp';
import { config } from '../src/config.js';

const execFileAsync = promisify(execFile);
const ffmpegPath = ffmpegInstaller?.path;
const resultCache = new Map();
const inflight = new Map();
const OCR_RULE_VERSION = 'ocr-2026.08.06.1';

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    let position = 0;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function normalizeLines(value) {
  const seen = new Set();
  const text = String(value || '')
    .replace(/\r/g, '')
    .replace(/```(?:json|html|markdown)?/gi, '\n')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\$\$/g, '')
    .replace(/\\quad/g, ' ');
  const lines = text
    .split('\n')
    .map(line => line.replace(/^[-*•]+\s*/, '').replace(/\s+/g, ' ').trim())
    .filter(line => line && !/^(?:html|json|markdown)$/i.test(line));
  return lines.filter(line => {
    const key = line.replace(/[\s，。！？、；：,.!?;:·•|｜<>\/\-]/g, '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n');
}

export function parseOcrModelContent(content) {
  const raw = Array.isArray(content)
    ? content.map(item => typeof item === 'string' ? item : item?.text || '').join('\n').trim()
    : String(content || '').trim();
  if (!raw) return { text: '', frames: [] };
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [unfenced];
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(unfenced.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const text = normalizeLines(parsed.map(item => typeof item === 'string' ? item : item?.text || '').join('\n'));
        return { text, frames: [] };
      }
      const frames = Array.isArray(parsed.frames) ? parsed.frames.map((item, index) => ({
        index: Number.isFinite(Number(item?.index)) ? Number(item.index) : index + 1,
        text: normalizeLines(item?.text || '')
      })).filter(item => item.text) : [];
      const text = normalizeLines(parsed.text || frames.map(item => item.text).join('\n'));
      return { text, frames };
    } catch {}
  }
  return { text: normalizeLines(unfenced), frames: [] };
}

async function compressImage(input) {
  return sharp(input, { animated: false })
    .rotate()
    .resize({ width: config.ocrMaxImageEdge, height: config.ocrMaxImageEdge, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 84, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function representativeTimes(durationSeconds, frameCount) {
  const duration = Number(durationSeconds || 0);
  const fractions = frameCount <= 3 ? [0.03, 0.5, 0.92] : [0.02, 0.24, 0.5, 0.74, 0.96];
  if (!duration) return fractions.slice(0, frameCount).map((_, index) => index * 2);
  return fractions.slice(0, frameCount).map(fraction => Math.max(0, Math.min(duration - 0.05, duration * fraction)));
}

async function extractVideoFrames(materialPath, durationSeconds) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('本地视频抽帧组件不可用');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-ocr-'));
  const frames = [];
  const seen = new Set();
  try {
    const times = representativeTimes(durationSeconds, config.ocrVideoFrameCount);
    for (let index = 0; index < times.length; index += 1) {
      const output = path.join(tempDir, `frame-${String(index + 1).padStart(2, '0')}.jpg`);
      try {
        await execFileAsync(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-ss', times[index].toFixed(3), '-i', materialPath,
          '-frames:v', '1', '-an', '-y', output
        ], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        if (!fs.existsSync(output) || fs.statSync(output).size === 0) continue;
        const buffer = await compressImage(output);
        const fingerprint = hashBuffer(buffer);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        frames.push({ index: index + 1, timeSeconds: Number(times[index].toFixed(2)), buffer });
      } catch (error) {
        if (!frames.length && index === times.length - 1) throw error;
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (!frames.length) throw new Error('未能从视频中提取可识别画面');
  return frames;
}

export async function prepareOcrImages({ materialPath, meta = {} }) {
  const absolute = path.resolve(materialPath || '');
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error('OCR 素材不存在或不可读取');
  if (meta.type === 'image') {
    return [{ index: 1, timeSeconds: null, buffer: await compressImage(absolute) }];
  }
  if (meta.type === 'video') return extractVideoFrames(absolute, meta.durationSeconds);
  throw new Error(`OCR 暂不支持该素材类型：${meta.type || 'unknown'}`);
}

async function requestQwenVisionBatch({ images, model, apiKey, baseUrl = config.qwenBaseUrl, signal }) {
  const imageContent = images.map(item => ({
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${item.buffer.toString('base64')}` }
  }));
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      enable_thinking: false,
      max_tokens: 1800,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '你是严格的中文图片 OCR 工具。识别图片中真实可见的全部文字，包括中文、英文、数字、日期、联系方式、字幕、水印和角标。不要描述画面，不要推测模糊内容。按自然阅读顺序输出，重复文字只保留一次。' },
          ...imageContent
        ]
      }]
    }),
    signal
  });
  if (!response.ok) throw new Error(`千问视觉 API 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('千问视觉 API 未返回有效内容');
  return { ...parseOcrModelContent(content), model: data.model || model, usage: data.usage || null };
}

function sumUsage(items) {
  const usage = items.map(item => item.usage).filter(Boolean);
  if (!usage.length) return null;
  return {
    prompt_tokens: usage.reduce((sum, item) => sum + Number(item.prompt_tokens || 0), 0),
    completion_tokens: usage.reduce((sum, item) => sum + Number(item.completion_tokens || 0), 0),
    total_tokens: usage.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0)
  };
}

async function callQwenVision({ images, model = config.qwenVisionModel, apiKey = config.qwenApiKey, baseUrl = config.qwenBaseUrl }) {
  if (!apiKey) throw new Error('QWEN_API_KEY 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ocrTimeoutMs);
  try {
    const batches = model.toLowerCase().includes('ocr') && images.length > 1 ? images.map(item => [item]) : [images];
    const results = new Array(batches.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
      while (cursor < batches.length) {
        const index = cursor++;
        results[index] = await requestQwenVisionBatch({ images: batches[index], model, apiKey, baseUrl, signal: controller.signal });
      }
    });
    await Promise.all(workers);
    return {
      text: normalizeLines(results.map(item => item.text).join('\n')),
      frames: results.map((item, index) => ({ index: index + 1, text: item.text })).filter(item => item.text),
      model: results.find(item => item.model)?.model || model,
      usage: sumUsage(results)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function recognizeMaterialText({
  materialPath,
  precheck,
  force = false,
  mode = config.qwenMode,
  model = config.qwenVisionModel,
  apiKey = config.qwenApiKey,
  baseUrl = config.qwenBaseUrl,
  invokeVision = callQwenVision
}) {
  const absolute = path.resolve(materialPath || '');
  const meta = precheck?.meta || {};
  const sha256 = meta.sha256 || (fs.existsSync(absolute) ? hashFile(absolute) : '');
  const cacheKey = `${OCR_RULE_VERSION}:${model}:${sha256}`;
  if (!force && resultCache.has(cacheKey)) return { ...resultCache.get(cacheKey), cached: true };
  if (!force && inflight.has(cacheKey)) return inflight.get(cacheKey);

  const task = (async () => {
    const startedAt = Date.now();
    if (!config.ocrEnabled) return { status: 'UNAVAILABLE', text: '', message: 'OCR 功能已关闭', ruleVersion: OCR_RULE_VERSION, sha256 };
    if (mode !== 'online') return { status: 'UNAVAILABLE', text: '', message: '当前为模拟模式，未调用在线视觉 OCR', ruleVersion: OCR_RULE_VERSION, sha256 };
    if (!apiKey) return { status: 'UNAVAILABLE', text: '', message: '未配置千问 API Key，仍可人工填写图片文字', ruleVersion: OCR_RULE_VERSION, sha256 };
    if (!['image', 'video'].includes(meta.type)) return { status: 'UNAVAILABLE', text: '', message: '当前素材类型不支持 OCR', ruleVersion: OCR_RULE_VERSION, sha256 };
    try {
      const images = await prepareOcrImages({ materialPath: absolute, meta });
      const totalBytes = images.reduce((sum, item) => sum + item.buffer.length, 0);
      const result = await invokeVision({ images, model, apiKey, baseUrl });
      const text = normalizeLines(result.text);
      const output = {
        status: text ? 'SUCCESS' : 'NO_TEXT',
        text,
        frames: result.frames || [],
        message: text ? `已从${meta.type === 'video' ? `${images.length}个代表帧` : '图片'}识别文字` : '未识别到清晰可见的文字',
        model: result.model || model,
        usage: result.usage || null,
        sourceType: meta.type,
        frameCount: images.length,
        transmittedBytes: totalBytes,
        originalUploaded: false,
        ruleVersion: OCR_RULE_VERSION,
        sha256,
        elapsedMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        cached: false
      };
      resultCache.set(cacheKey, output);
      while (resultCache.size > 50) resultCache.delete(resultCache.keys().next().value);
      return output;
    } catch (error) {
      return {
        status: 'FAILED', text: '', message: `OCR 识别失败：${error.name === 'AbortError' ? '请求超时' : error.message}`,
        model, sourceType: meta.type, originalUploaded: false, ruleVersion: OCR_RULE_VERSION, sha256,
        elapsedMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), cached: false
      };
    }
  })();
  inflight.set(cacheKey, task);
  try { return await task; }
  finally { inflight.delete(cacheKey); }
}
