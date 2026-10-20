import fs from 'node:fs';

export const DEFAULT_UPLOAD_TIMEOUT_OPTIONS = Object.freeze({
  minTimeoutMs: 10 * 60 * 1000,
  maxTimeoutMs: 30 * 60 * 1000,
  minBytesPerSecond: 256 * 1024,
  processingGraceMs: 3 * 60 * 1000
});

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeUploadTimeoutOptions(options = {}) {
  const minTimeoutMs = finitePositive(options.minTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_OPTIONS.minTimeoutMs);
  const requestedMaxTimeoutMs = finitePositive(options.maxTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_OPTIONS.maxTimeoutMs);
  return {
    minTimeoutMs,
    maxTimeoutMs: Math.max(minTimeoutMs, requestedMaxTimeoutMs),
    minBytesPerSecond: finitePositive(options.minBytesPerSecond, DEFAULT_UPLOAD_TIMEOUT_OPTIONS.minBytesPerSecond),
    processingGraceMs: Math.max(0, Number.isFinite(Number(options.processingGraceMs)) ? Number(options.processingGraceMs) : DEFAULT_UPLOAD_TIMEOUT_OPTIONS.processingGraceMs)
  };
}

export function uploadTimeoutMsForSize(fileSizeBytes, options = {}) {
  const normalized = normalizeUploadTimeoutOptions(options);
  const size = Number(fileSizeBytes);
  if (!Number.isFinite(size) || size <= 0) return normalized.minTimeoutMs;
  const estimatedUploadMs = (size / normalized.minBytesPerSecond) * 1000;
  const estimatedTotalMs = Math.ceil(estimatedUploadMs + normalized.processingGraceMs);
  return Math.min(normalized.maxTimeoutMs, Math.max(normalized.minTimeoutMs, estimatedTotalMs));
}

export function resolveUploadTimeoutMs(materialPath, options = {}) {
  try {
    return uploadTimeoutMsForSize(fs.statSync(materialPath).size, options);
  } catch {
    return normalizeUploadTimeoutOptions(options).minTimeoutMs;
  }
}
