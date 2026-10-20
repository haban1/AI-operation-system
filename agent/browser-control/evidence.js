import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function safeSegment(value, fallback = 'unknown') {
  const normalized = String(value || fallback).trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function createEvidenceStore({ rootDir }) {
  const resolvedRoot = path.resolve(rootDir);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  return {
    rootDir: resolvedRoot,
    screenshotPath({ platformCode, sessionId, commandId, format = 'png' } = {}) {
      const day = new Date().toISOString().slice(0, 10);
      const directory = path.join(resolvedRoot, day, safeSegment(platformCode));
      fs.mkdirSync(directory, { recursive: true });
      const filename = [safeSegment(sessionId, 'session'), safeSegment(commandId, randomUUID()), Date.now()].join('-') + `.${format === 'jpeg' ? 'jpg' : 'png'}`;
      const file = path.resolve(directory, filename);
      const relative = path.relative(resolvedRoot, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('截图证据路径越界');
      return file;
    }
  };
}
