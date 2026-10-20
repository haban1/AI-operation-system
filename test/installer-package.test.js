import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { copyModelCache } from '../packaging/prepare-rag-bundle.mjs';
import { prepareRuntimeTemplate } from '../packaging/prepare-runtime-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function initializedTemplate(t) {
  const dbPath = path.join(temporary(t), 'template.db');
  const initialize = () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import { db } from './src/db.js'; db.close();"], {
      cwd: root, env: { ...process.env, NODE_ENV: 'test', DATABASE_PATH: dbPath }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const prepare = () => {
    const result = spawnSync(process.execPath, [path.join(root, 'packaging/prepare-template-db.mjs'), dbPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  initialize();
  return { dbPath, initialize, prepare };
}

test('first startup of a cleaned installation restores the confirmed Weibo name without replaying unrelated migrations', t => {
  const template = initializedTemplate(t);
  const migrationId = '2026-09-11-weibo-main-account-name-v1';
  const readMigrations = db => db.prepare('SELECT * FROM schema_migrations WHERE id<>? ORDER BY id').all(migrationId);
  const before = new DatabaseSync(template.dbPath);
  const migrations = readMigrations(before);
  before.close();
  template.prepare();
  template.initialize();
  const actual = new DatabaseSync(template.dbPath, { readOnly: true });
  try {
    const account = actual.prepare("SELECT * FROM accounts WHERE platform_code='weibo' AND profile_name='profile-weibo-main'").get();
    assert.equal(account.platform_user_name, '天河港澳社区');
    assert.deepEqual(JSON.parse(account.platform_user_aliases), ['天河港澳社区']);
    assert.equal(account.platform_user_id, null);
    assert.equal(account.login_status, 'UNKNOWN');
    assert.deepEqual(readMigrations(actual), migrations);
    assert.equal(actual.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { actual.close(); }
});

test('installation preserves the explicit mini-program binding even when another account has the same profile', t => {
  const template = initializedTemplate(t);
  const before = new DatabaseSync(template.dbPath);
  const binding = before.prepare('SELECT * FROM mini_program_channel_identity WHERE id=1').get();
  assert.equal(binding.binding_state, 'BOUND');
  before.prepare(`INSERT INTO accounts(platform_code,display_name,device_id,profile_name,enabled,login_status,created_at)
    SELECT platform_code,'another mini-program account',device_id,profile_name,enabled,login_status,created_at FROM accounts WHERE id=?`).run(binding.account_id);
  before.close();
  template.prepare();
  template.initialize();
  const actual = new DatabaseSync(template.dbPath, { readOnly: true });
  try {
    assert.deepEqual(actual.prepare('SELECT * FROM mini_program_channel_identity WHERE id=1').get(), binding);
    assert.equal(actual.prepare('SELECT login_status FROM accounts WHERE id=?').get(binding.account_id).login_status, 'NOT_REQUIRED');
    assert.deepEqual(actual.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { actual.close(); }
});

test('installation template removes customer history and remembered identities while retaining knowledge and encrypted configuration', t => {
  const dbPath = path.join(temporary(t), 'template.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE platforms(code TEXT PRIMARY KEY, desired_state TEXT, runtime_updated_at TEXT, runtime_updated_by TEXT, sort_order INTEGER);
    INSERT INTO platforms VALUES('weibo','RUNNING',NULL,NULL,1);
    CREATE TABLE devices(id TEXT PRIMARY KEY,status TEXT,last_heartbeat TEXT,browser_control_json TEXT);
    INSERT INTO devices VALUES('device-rpa-01','ONLINE','2026-09-08','{}');
    CREATE TABLE accounts(id INTEGER PRIMARY KEY, enabled INTEGER, login_status TEXT, login_checked_at TEXT, login_source TEXT, login_url TEXT, platform_user_id TEXT, platform_user_aliases TEXT);
    INSERT INTO accounts VALUES(1,1,'READY','2026-09-08','LOCAL_AGENT','https://example.test/account','old-user','["old-user"]');
    CREATE TABLE knowledge(id INTEGER PRIMARY KEY,question TEXT,answer TEXT);
    INSERT INTO knowledge VALUES(1,'营业时间','九点到十八点');
    CREATE TABLE knowledge_aliases(id INTEGER PRIMARY KEY,knowledge_id INTEGER REFERENCES knowledge(id),question TEXT);
    INSERT INTO knowledge_aliases VALUES(1,1,'几点开门');
    CREATE TABLE system_settings(setting_key TEXT PRIMARY KEY,encrypted_value TEXT,updated_at TEXT,updated_by TEXT);
    INSERT INTO system_settings VALUES('ai.api_key','encrypted-ai-setting','2026-09-08','admin');
    INSERT INTO system_settings VALUES('wecom.webhook_url','encrypted-wecom-setting','2026-09-08','admin');
    INSERT INTO system_settings VALUES('operations.master_enabled','true','2026-09-08','admin');
    CREATE TABLE messages(id INTEGER PRIMARY KEY,content TEXT,conversation_id INTEGER REFERENCES conversations(id));
    CREATE TABLE conversations(id INTEGER PRIMARY KEY,handoff_source_message_id INTEGER REFERENCES messages(id));
    INSERT INTO messages VALUES(1,'old private message',NULL);
    INSERT INTO conversations VALUES(1,1);
    UPDATE messages SET conversation_id=1 WHERE id=1;
    CREATE TABLE message_processing_registry(id INTEGER PRIMARY KEY,canonical_message_id INTEGER REFERENCES messages(id));
    INSERT INTO message_processing_registry VALUES(1,1);
    CREATE TABLE notifications(id INTEGER PRIMARY KEY,message TEXT);
    INSERT INTO notifications VALUES(1,'old handoff');
    CREATE TABLE publish_tasks(id INTEGER PRIMARY KEY,title TEXT);
    INSERT INTO publish_tasks VALUES(1,'old task');
    CREATE TABLE agent_jobs(id INTEGER PRIMARY KEY,status TEXT,result TEXT);
    INSERT INTO agent_jobs VALUES(1,'QUEUED',NULL);
  `);
  db.close();
  const result = spawnSync(process.execPath, [path.join(root, 'packaging/prepare-template-db.mjs'), dbPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const table of ['messages', 'conversations', 'message_processing_registry', 'notifications', 'publish_tasks', 'agent_jobs']) {
      assert.equal(actual.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} must be empty on a different computer`);
    }
    assert.equal(actual.prepare('SELECT answer FROM knowledge').get().answer, '九点到十八点');
    assert.equal(actual.prepare('SELECT COUNT(*) AS count FROM knowledge_aliases').get().count, 1);
    assert.equal(actual.prepare("SELECT encrypted_value FROM system_settings WHERE setting_key='ai.api_key'").get().encrypted_value, 'encrypted-ai-setting');
    assert.equal(actual.prepare("SELECT encrypted_value FROM system_settings WHERE setting_key='wecom.webhook_url'").get().encrypted_value, 'encrypted-wecom-setting');
    assert.equal(actual.prepare("SELECT encrypted_value FROM system_settings WHERE setting_key='operations.master_enabled'").get().encrypted_value, 'false');
    const account = actual.prepare('SELECT * FROM accounts').get();
    assert.equal(account.login_status, 'UNKNOWN');
    assert.equal(account.login_url, null);
    assert.equal(account.platform_user_id, null);
    assert.equal(account.platform_user_aliases, null);
    assert.equal(actual.prepare('SELECT desired_state FROM platforms').get().desired_state, 'STOPPED');
    assert.deepEqual(actual.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { actual.close(); }
});

test('first installation binds bundled RAG to its own directory and preserves existing configuration on reinstall', { skip: process.platform !== 'win32' }, t => {
  const directory = path.join(temporary(t), '中文 installation');
  fs.mkdirSync(path.join(directory, 'rag/app'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'runtime/browser'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'rag/app/main.py'), '# bundled service fixture\n');
  for (const file of ['initialize-mvp.ps1', '.env.example']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
  fs.copyFileSync(path.join(root, '.env.example'), path.join(directory, 'rag/.env.example'));
  const initialize = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'initialize-mvp.ps1'), '-Quiet'], { cwd: os.tmpdir(), encoding: 'utf8' });
  const result = initialize();
  assert.equal(result.status, 0, result.stderr);
  const readEnv = file => Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const web = readEnv(path.join(directory, '.env'));
  assert.equal(web.RAG_PROJECT_ROOT, './rag');
  assert.equal(web.RAG_ADMIN_ENABLED, 'true');
  assert.equal(web.RAG_FORMAL_ROUTING_ENABLED, 'true');
  assert.ok(web.RAG_TOKEN.length >= 32);
  const rag = readEnv(path.join(directory, 'rag/.env'));
  assert.equal(rag.RAG_BEARER_TOKEN, web.RAG_TOKEN);
  assert.equal(rag.RAG_SQLITE_PATH, './data/rag.db');
  const before = fs.readFileSync(path.join(directory, '.env'));
  const ragBefore = fs.readFileSync(path.join(directory, 'rag/.env'));
  assert.equal(initialize().status, 0);
  assert.deepEqual(fs.readFileSync(path.join(directory, '.env')), before);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'rag/.env')), ragBefore);
});

test('model cache copies dereferenced model bytes instead of text links from a cross-computer archive', t => {
  const directory = temporary(t);
  const source = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  fs.mkdirSync(path.join(source, 'models--test/blobs'), { recursive: true });
  fs.mkdirSync(path.join(source, 'models--test/snapshots/revision/onnx'), { recursive: true });
  const digest = 'a'.repeat(64);
  fs.writeFileSync(path.join(source, 'models--test/blobs', digest), Buffer.from([8, 1, 2, 3, 4]));
  fs.writeFileSync(path.join(source, 'models--test/snapshots/revision/onnx/model.onnx'), `../../../blobs/${digest}`);
  copyModelCache(source, target);
  assert.deepEqual(fs.readFileSync(path.join(target, 'models--test/snapshots/revision/onnx/model.onnx')), Buffer.from([8, 1, 2, 3, 4]));
  assert.equal(fs.existsSync(path.join(target, 'models--test/blobs')), false);
});

test('upgrading an older installation adds bundled RAG without changing Chinese credentials or collection preferences', { skip: process.platform !== 'win32' }, t => {
  const directory = path.join(temporary(t), '旧版 中文 installation');
  fs.mkdirSync(path.join(directory, 'rag/app'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'rag/app/main.py'), '# bundled service fixture\n');
  for (const file of ['initialize-mvp.ps1', '.env.example']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
  fs.writeFileSync(path.join(directory, 'rag/.env.example'), 'RAG_BEARER_TOKEN=dev-local-token\n');
  fs.writeFileSync(path.join(directory, '.env'), 'ADMIN_PASSWORD=原来的密码\nCHROME_EXECUTABLE_PATH=D:/旧安装/浏览器/chrome.exe\nAUTO_COLLECT_ENABLED=false\nRAG_PROJECT_ROOT=\nRAG_TOKEN=\nRAG_ADMIN_ENABLED=false\n');
  const initialize = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'initialize-mvp.ps1'), '-Quiet'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(initialize().status, 0);
  const actual = fs.readFileSync(path.join(directory, '.env'), 'utf8');
  assert.match(actual, /^RAG_PROJECT_ROOT=\.\/rag$/m);
  assert.match(actual, /^ADMIN_PASSWORD=原来的密码$/m);
  assert.match(actual, /^CHROME_EXECUTABLE_PATH=D:\/旧安装\/浏览器\/chrome\.exe$/m);
  assert.match(actual, /^AUTO_COLLECT_ENABLED=false$/m);
  assert.match(actual, /^RAG_ADMIN_ENABLED=true$/m);
  const token = actual.match(/^RAG_TOKEN=(\S+)$/m)?.[1];
  assert.ok(token?.length >= 32);
  const rag = fs.readFileSync(path.join(directory, 'rag/.env'), 'utf8');
  assert.ok(rag.includes(`RAG_BEARER_TOKEN=${token}`));
  assert.equal(initialize().status, 0);
  assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), actual);
  assert.equal(fs.readFileSync(path.join(directory, 'rag/.env'), 'utf8'), rag);
});

test('installer repairs the all-disabled channel defaults once and preserves later channel choices', { skip: process.platform !== 'win32' }, t => {
  const directory = temporary(t);
  fs.copyFileSync(path.join(root, 'initialize-mvp.ps1'), path.join(directory, 'initialize-mvp.ps1'));
  fs.writeFileSync(path.join(directory, '.env.example'), 'INSTALLER_CHANNEL_CONFIG_VERSION=1\nCHANNEL_SPLIT_ENABLED=true\nPLATFORM_CHANNEL_SPLIT_DOUYIN=true\nPLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS=true\nPLATFORM_CHANNEL_SPLIT_BILIBILI=true\nPLATFORM_CHANNEL_SPLIT_WEIBO=true\nPLATFORM_CHANNEL_SPLIT_XIAOHONGSHU=false\n');
  fs.writeFileSync(path.join(directory, '.env'), 'ADMIN_PASSWORD=已设置的密码\nAUTO_COLLECT_ENABLED=false\nCHANNEL_SPLIT_ENABLED=false\nPLATFORM_CHANNEL_SPLIT_DOUYIN=false\nPLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS=false\nPLATFORM_CHANNEL_SPLIT_BILIBILI=false\nPLATFORM_CHANNEL_SPLIT_WEIBO=false\nPLATFORM_CHANNEL_SPLIT_XIAOHONGSHU=false\n');
  fs.mkdirSync(path.join(directory, 'data/browser-profiles'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'data/browser-profiles/session-fixture'), 'existing social login');
  fs.writeFileSync(path.join(directory, 'data/mvp.db'), 'existing customer history');
  const initialize = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'initialize-mvp.ps1'), '-Quiet'], { encoding: 'utf8' });
  assert.equal(initialize().status, 0);
  fs.mkdirSync(path.join(directory, 'src/services'), { recursive: true });
  for (const file of ['src/config.js', 'src/services/conversation-policy.js', 'src/services/channel-job-scheduler.js', 'src/services/message-channel.js', 'package.json']) fs.copyFileSync(path.join(root, file), path.join(directory, file));
  const installedEnvironment = { ...process.env };
  delete installedEnvironment.NODE_TEST_CONTEXT;
  delete installedEnvironment.NODE_ENV;
  const plans = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { config } from './src/config.js';
    import { buildCollectionChannelPlans } from './src/services/channel-job-scheduler.js';
    console.log(JSON.stringify(['douyin','wechat_channels','bilibili','weibo','xiaohongshu'].map(platformCode => buildCollectionChannelPlans({platformCode, featureConfig:config}).map(plan => plan.channelType))));
  `], { cwd: directory, env: installedEnvironment, encoding: 'utf8' });
  assert.equal(plans.status, 0, plans.stderr);
  assert.deepEqual(JSON.parse(plans.stdout), [['COMMENT','PRIVATE_MESSAGE'], ['COMMENT','PRIVATE_MESSAGE'], ['COMMENT','PRIVATE_MESSAGE'], ['COMMENT','PRIVATE_MESSAGE'], [null]]);
  const repaired = fs.readFileSync(path.join(directory, '.env'), 'utf8');
  assert.match(repaired, /^ADMIN_PASSWORD=已设置的密码$/m);
  assert.match(repaired, /^AUTO_COLLECT_ENABLED=false$/m);
  assert.equal(fs.readFileSync(path.join(directory, 'data/mvp.db'), 'utf8'), 'existing customer history');
  assert.equal(fs.readFileSync(path.join(directory, 'data/browser-profiles/session-fixture'), 'utf8'), 'existing social login');
  const customized = repaired.replace('PLATFORM_CHANNEL_SPLIT_DOUYIN=true', 'PLATFORM_CHANNEL_SPLIT_DOUYIN=false');
  fs.writeFileSync(path.join(directory, '.env'), customized);
  assert.equal(initialize().status, 0);
  assert.equal(fs.readFileSync(path.join(directory, '.env'), 'utf8'), customized);
});

test('packaging carries the enabled collection channels without copying machine paths or credentials', () => {
  const source = 'CHANNEL_SPLIT_ENABLED=true\nPLATFORM_CHANNEL_SPLIT_DOUYIN=true\nPLATFORM_CHANNEL_SPLIT_WEIBO=true\nPLATFORM_CHANNEL_SPLIT_XIAOHONGSHU=false\nADMIN_PASSWORD=source-password\nQWEN_API_KEY=source-secret\nCHROME_EXECUTABLE_PATH=Z:/original/chrome.exe\n';
  const template = 'CHANNEL_SPLIT_ENABLED=false\nPLATFORM_CHANNEL_SPLIT_DOUYIN=false\nADMIN_PASSWORD=\nQWEN_API_KEY=\nCHROME_EXECUTABLE_PATH=\n';
  const actual = prepareRuntimeTemplate(source, template);
  const values = Object.fromEntries(actual.split(/\r?\n/).filter(line => !line.startsWith('#') && line.includes('=')).map(line => line.split('=')));
  assert.equal(values.CHANNEL_SPLIT_ENABLED, 'true');
  assert.equal(values.PLATFORM_CHANNEL_SPLIT_DOUYIN, 'true');
  assert.equal(values.PLATFORM_CHANNEL_SPLIT_WEIBO, 'true');
  assert.equal(values.PLATFORM_CHANNEL_SPLIT_XIAOHONGSHU, 'false');
  assert.equal(values.PLATFORM_CHANNEL_SPLIT_BILIBILI, 'false');
  assert.equal(values.ADMIN_PASSWORD, '');
  assert.equal(values.QWEN_API_KEY, '');
  assert.equal(values.CHROME_EXECUTABLE_PATH, '');
  assert.equal(prepareRuntimeTemplate(source, actual), actual);
});
