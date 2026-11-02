// Explicit live check: generates copy, but does not save/publish it or import knowledge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const materialPath = process.argv[2];
assert.ok(materialPath, 'Pass a video path visible inside the web container');
const base = `http://127.0.0.1:${config.port}`;
const headers = { 'Content-Type': 'application/json' };
if (config.authEnabled) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: config.adminUsername, password: config.adminPassword })
  });
  assert.equal(login.status, 200, 'Tianhe login');
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  await login.body.cancel();
}
const started = Date.now();
const response = await fetch(`${base}/api/local-agent/material-content-generation`, {
  method: 'POST', headers,
  body: JSON.stringify({ materialPath, platformCodes: [], force: true }),
  signal: AbortSignal.timeout(config.audioTotalTimeoutMs + 20_000)
});
const data = await response.json();
const result = data.generation;
const summary = {
  httpStatus: response.status, status: result?.status, code: result?.code || data.code,
  elapsedMs: Date.now() - started, model: result?.transcript?.model,
  transcriptCharacters: result?.transcript?.text?.length,
  title: result?.result?.title, bodyCharacters: result?.result?.body?.length,
  calls: result?.calls, audioUploadedBytes: result?.transmittedBytes
};
const directory = path.join(path.dirname(config.databasePath), 'backups', 'local-asr');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({ summary, result }, null, 2));
console.log(JSON.stringify(summary));
assert.equal(response.status, 200);
assert.equal(result?.status, 'SUCCESS');
assert.equal(result?.calls?.asr?.status, 'SUCCESS');
assert.equal(result?.transcript?.model, 'local:whisper-small');
assert.equal(result?.calls?.content?.status, 'SUCCESS');
assert.equal(result?.transmittedBytes, 0);
