// Install the editor's verified local Whisper pack, then enable transcription.
// Run after OpenChatCut is healthy. Existing projects and API keys are preserved.
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const base = 'http://127.0.0.1:5199';
const model = process.argv[2] || 'small';
assert.ok(['tiny', 'base', 'small', 'medium', 'large-v3-turbo'].includes(model), 'Unknown Whisper model');
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${result.error || 'request failed'}`);
  return result;
}

const catalog = await request('/api/asr-models');
if (!catalog.models.find(item => item.id === model)?.onnxDownloaded) {
  await request('/api/asr-models/download', { id: model });
  const deadline = Date.now() + 60 * 60_000;
  let lastProgress;
  while (true) {
    const task = await request(`/api/asr-models/download/${model}`);
    const progress = `${task.status}: ${task.filesDone}/${task.filesTotal} files, ${Math.round((task.bytesDone || 0) / 1024 / 1024)} MiB`;
    if (progress !== lastProgress) { console.log(progress); lastProgress = progress; }
    if (task.status === 'done') break;
    if (task.status === 'error') throw new Error(task.error || 'Model download failed');
    if (Date.now() > deadline) throw new Error('Model download timeout; rerun to resume verified files');
    await delay(10_000);
  }
}
const installed = (await request('/api/asr-models')).models.find(item => item.id === model);
assert.equal(installed?.onnxDownloaded, true, 'Whisper model integrity verification failed');
const backupDir = new URL('../backups/openchatcut-media/', import.meta.url);
await mkdir(backupDir, { recursive: true });
await copyFile(new URL('../runtime/workbench/openchatcut/settings.env', import.meta.url),
  new URL(`settings-${Date.now()}.env`, backupDir));
const settings = await request('/api/keys', {
  PREFERRED_TRANSCRIPTION_PROVIDER: 'local', LOCAL_ASR_MODEL: model,
  TRANSCRIPTION_LANGUAGE: 'zh', TRANSCRIPTION_DIARIZATION: '0',
  AUTO_TRANSCRIBE_INGEST: 'local',
});
assert.equal(settings.models.PREFERRED_TRANSCRIPTION_PROVIDER, 'local');
console.log(`Whisper ${model} installed and enabled. Subtitle translation uses the existing Agent model.`);
