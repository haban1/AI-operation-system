import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.RAG_TEST_PYTHON || 'python';
const pythonAvailable = spawnSync(python, ['--version']).status === 0;

function fixture(t, ragEnv = '') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-launch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ragRoot = path.join(directory, '知识库 with spaces');
  fs.mkdirSync(path.join(ragRoot, 'uvicorn'), { recursive: true });
  fs.writeFileSync(path.join(ragRoot, 'uvicorn/__init__.py'), '');
  fs.writeFileSync(path.join(ragRoot, 'uvicorn/__main__.py'), `import json,os,sys
print(json.dumps({'url':os.getenv('RAG_LLM_BASE_URL'),'model':os.getenv('RAG_LLM_MODEL'),'key':os.getenv('RAG_LLM_API_KEY'),'provider':os.getenv('RAG_GENERATION_PROVIDER'),'arguments':sys.argv[1:],'extraSecrets':[name for name in ['AGENT_SHARED_TOKEN','WECOM_WEBHOOK_URL','SETTINGS_ENCRYPTION_KEY'] if name in os.environ]}))
sys.exit(int(os.getenv('FIXTURE_EXIT_CODE','0')))
`);
  fs.writeFileSync(path.join(ragRoot, '.env'), ragEnv);
  const dbPath = path.join(directory, 'settings.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,encrypted_value TEXT,updated_at TEXT,updated_by TEXT)');
  const key = Buffer.from('ab'.repeat(32), 'hex');
  for (const [name, value] of Object.entries({ mode: 'online', api_key: 'test-platform-secret', base_url: 'https://configured.example/v1', model: 'configured-chat-model' })) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    db.prepare('INSERT INTO system_settings VALUES(?,?,?,?)').run(`ai.${name}`, `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`, '2026-09-09', 'test');
  }
  db.close();
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_PATH: dbPath, SETTINGS_ENCRYPTION_KEY: key.toString('hex') };
  for (const name of Object.keys(env)) if (name.startsWith('RAG_')) delete env[name];
  const run = extraEnv => spawnSync(process.execPath, [path.join(root, 'src/start-rag.js'), '--python', python, '--rag-root', ragRoot, '--host', '127.0.0.1', '--port', '18281'], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
  return { run, ragRoot, dbPath };
}

test('RAG child receives the saved platform AI configuration without saving the key to its env file', { skip: !pythonAvailable }, t => {
  const f = fixture(t, 'RAG_LLM_BASE_URL=\nRAG_LLM_API_KEY=\nRAG_LLM_MODEL=unused-default\n');
  const before = fs.readFileSync(path.join(f.ragRoot, '.env'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout.trim());
  assert.equal(actual.url, 'https://configured.example/v1');
  assert.equal(actual.model, 'configured-chat-model');
  assert.equal(actual.key, 'test-platform-secret');
  assert.equal(actual.provider, 'openai_compatible');
  assert.deepEqual(actual.arguments, ['app.main:app', '--host', '127.0.0.1', '--port', '18281']);
  assert.deepEqual(fs.readFileSync(path.join(f.ragRoot, '.env')), before);
  assert.ok(!result.stderr.includes('test-platform-secret'));
});

test('explicit RAG credentials remain together and process environment takes priority', { skip: !pythonAvailable }, t => {
  const f = fixture(t, 'RAG_LLM_BASE_URL=https://rag.example/v1\nRAG_LLM_API_KEY=rag-test-secret\nRAG_LLM_MODEL=rag-model\n');
  const result = f.run({ RAG_LLM_MODEL: 'process-model' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout.trim());
  assert.equal(actual.url, 'https://rag.example/v1');
  assert.equal(actual.key, 'rag-test-secret');
  assert.equal(actual.model, 'process-model');
});

test('incomplete explicit RAG credentials do not mix with the platform key', { skip: !pythonAvailable }, t => {
  const f = fixture(t, 'RAG_LLM_BASE_URL=https://another-provider.example/v1\n');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RAG_LLM_BASE_URL.*RAG_LLM_API_KEY/);
  assert.ok(!result.stderr.includes('test-platform-secret'));
});

test('RAG process failure reaches the launcher exit code', { skip: !pythonAvailable }, t => {
  const f = fixture(t);
  assert.equal(f.run({ FIXTURE_EXIT_CODE: '7' }).status, 7);
});

test('RAG child receives no agent, notification or settings-encryption secrets', { skip: !pythonAvailable }, t => {
  const f = fixture(t);
  const result = f.run({ AGENT_SHARED_TOKEN: 'agent-fixture', WECOM_WEBHOOK_URL: 'https://notification.example/fixture' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()).extraSecrets, []);
});
