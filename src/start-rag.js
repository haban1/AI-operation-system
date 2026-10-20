import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { config } from './config.js';

// Share the operator's saved AI configuration through child-process memory.
// A separately configured RAG provider always keeps its own URL/key/model.
async function start() {
  const { values } = parseArgs({ options: {
    python: { type: 'string' }, 'rag-root': { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '18080' }
  } });
  if (!values.python || !values['rag-root']) throw new Error('--python and --rag-root are required');
  const ragRoot = path.resolve(values['rag-root']);
  const envPath = path.join(ragRoot, '.env');
  const ragEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  const env = { ...Object.fromEntries(Object.entries(ragEnv).filter(([key]) => key.startsWith('RAG_'))), ...process.env };
  const generation = String(env.RAG_GENERATION_PROVIDER || 'openai_compatible').toLowerCase();
  const hasUrl = Boolean(env.RAG_LLM_BASE_URL?.trim());
  const hasKey = Boolean(env.RAG_LLM_API_KEY?.trim());
  if (['openai', 'openai_compatible'].includes(generation)) {
    if (hasUrl !== hasKey) throw new Error('RAG_LLM_BASE_URL and RAG_LLM_API_KEY must both be configured, or both empty to use platform AI');
    if (!hasUrl) {
      let ai = { mode: config.qwenMode, apiKey: config.qwenApiKey, baseUrl: config.qwenBaseUrl, model: config.qwenModel };
      if (fs.existsSync(config.databasePath)) {
        const { getAiSettings } = await import('./services/settings.js');
        const { db } = await import('./db.js');
        try {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='system_settings'").get()) ai = getAiSettings();
        } finally { db.close(); }
      }
      if (ai.mode === 'online' && ai.apiKey) {
        Object.assign(env, { RAG_LLM_BASE_URL: ai.baseUrl, RAG_LLM_API_KEY: ai.apiKey, RAG_LLM_MODEL: ai.model, RAG_GENERATION_PROVIDER: 'openai_compatible' });
      }
    }
  }
  for (const name of ['ADMIN_PASSWORD', 'SESSION_SECRET', 'AGENT_SHARED_TOKEN', 'WECOM_WEBHOOK_URL', 'SETTINGS_ENCRYPTION_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY']) delete env[name];
  const child = spawn(values.python, ['-E', '-s', '-m', 'uvicorn', 'app.main:app', '--host', values.host, '--port', values.port], {
    cwd: ragRoot, env, stdio: 'inherit', windowsHide: true
  });
  child.on('error', error => { console.error(`RAG process could not start: ${error.code || 'SPAWN_FAILED'}`); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}

start().catch(error => { console.error(error.message); process.exitCode = 1; });
