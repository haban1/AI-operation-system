// Run inside the rebuilt Tianhe web container, with the shared model mounted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
import { row } from '../src/db.js';
import { getAiSettings, saveAiSettings } from '../src/services/settings.js';
import { LOCAL_ASR_MODEL } from '../agent/local-whisper-asr.js';

const expected = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(config.localAsrModelPath)) hash.update(chunk);
if (hash.digest('hex') !== expected) throw new Error('Whisper Small 模型校验失败，配置未修改');
execFileSync(config.localAsrExecutable, ['--help'], { windowsHide: true, timeout: 10_000, stdio: 'pipe' });
const current = getAiSettings();
if (current.asrModel !== LOCAL_ASR_MODEL) {
  const directory = path.join(path.dirname(config.databasePath), 'backups', 'local-asr');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `setting-${Date.now()}.json`), JSON.stringify({
    previousModel: current.asrModel,
    setting: row('SELECT * FROM system_settings WHERE setting_key=?', 'ai.asr_model') || null
  }, null, 2), { mode: 0o600 });
  saveAiSettings({ asrModel: LOCAL_ASR_MODEL }, '本地语音识别修复');
}
console.log(JSON.stringify({ asrModel: getAiSettings().asrModel, modelVerified: true, changed: current.asrModel !== LOCAL_ASR_MODEL }));
