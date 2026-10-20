import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Destructive installer verification is confined to existing, isolated fixtures.
// It never installs over the development checkout or the user's default install.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [installerArgument, targetArgument] = process.argv.slice(2);
assert.ok(installerArgument && targetArgument, 'Usage: node packaging/verify-running-upgrade.mjs <installer.exe> <isolated-installed-fixture>');
const installer = path.resolve(installerArgument);
const target = path.resolve(targetArgument);
const allowedPrefix = path.join(projectRoot, '.tmp', 'installer-verification-');
assert.ok(target.startsWith(allowedPrefix) && !path.relative(path.join(projectRoot, '.tmp'), target).startsWith('..'), 'target must be an isolated installer verification directory');
assert.ok(fs.existsSync(path.join(target, 'data/mvp.db')) && fs.existsSync(installer));
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function ps(script) {
  // Long-lived Windows services can inherit their launcher's output handles.
  // Sharing our output avoids waiting for an unused capture pipe to reach EOF.
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, timeout: 120000 });
  assert.equal(result.error, undefined, 'PowerShell launch or wait failed');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
  return result.stdout;
}
function installAt(directory) {
  // NSIS /D consumes the remaining command line, including spaces, without quotes.
  return spawnSync(installer, ['/S', '/NOSTART', '/NOSHORTCUTS', `/D=${directory}`], { windowsHide: true, windowsVerbatimArguments: true, timeout: 300000 });
}
function databaseSnapshot(database, tables) {
  const db = new DatabaseSync(path.join(target, database), { readOnly: true });
  try { return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
function assertSnapshotEqual(actual, expected) {
  for (const table of Object.keys(expected)) {
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(digest(actual[table]), digest(expected[table]), `preserved table changed during installation: ${table}`);
  }
}
const readEnv = () => Object.fromEntries(fs.readFileSync(path.join(target, '.env'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const configuration = readEnv();
assert.equal(configuration.AUTO_COLLECT_ENABLED, 'false');
assert.equal(configuration.PORT, '32180');
assert.equal(configuration.AGENT_PORT, '17980');
assert.equal(configuration.RAG_PORT, '18180');
const base = 'http://127.0.0.1:32180';
let cookie = '';
async function api(route, body) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${route}: ${response.status}`);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}
async function login() {
  cookie = '';
  assert.equal((await api('/api/auth/login', { username: 'admin', password: configuration.ADMIN_PASSWORD })).authenticated, true);
}
function stopFixture() {
  ps(`& ${quote(path.join(projectRoot, 'packaging/stop-installed-runtime.ps1'))} -InstallRoot ${quote(target)}; exit $LASTEXITCODE`);
}
const report = {};
const blocked = fs.mkdtempSync(path.join(projectRoot, '.tmp', 'installer-verification-blocked-'));
try {
  fs.mkdirSync(path.join(blocked, 'runtime'));
  const lockedNode = path.join(blocked, 'runtime/node.exe');
  fs.copyFileSync(process.execPath, lockedNode);
  assert.equal(spawnSync('attrib.exe', ['+R', lockedNode], { windowsHide: true }).status, 0);
  try {
    const blockedResult = installAt(blocked);
    assert.equal(blockedResult.status, 2, `unwritable runtime must abort the actual EXE: ${blockedResult.error || ''}`);
    assert.equal(fs.existsSync(path.join(blocked, 'src')), false, 'failed preflight must occur before application files are copied');
    assert.equal(fs.statSync(lockedNode).size, fs.statSync(process.execPath).size);
    report.unwritableTargetAbortsBeforeCopy = true;
  } finally { spawnSync('attrib.exe', ['-R', lockedNode], { windowsHide: true }); }
} finally { fs.rmSync(blocked, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }

const protectedPaths = ['.env', 'rag/.env', 'data/.settings-key', 'data/browser-profiles/upgrade-retention-fixture.txt'];
assert.ok(fs.existsSync(path.join(target, protectedPaths.at(-1))), 'use a fixture containing the previous upgrade retention marker');
const fixtureDatabase = new DatabaseSync(path.join(target, 'data/mvp.db'));
try {
  assert.equal(fixtureDatabase.prepare("SELECT COUNT(*) AS count FROM messages WHERE external_id <> 'installer-upgrade-retention-fixture'").get().count, 0, 'only synthetic retention messages may be used');
  fixtureDatabase.prepare("UPDATE messages SET status='MANUAL_HANDLED',handled_by='installer-verification' WHERE external_id='installer-upgrade-retention-fixture'").run();
} finally { fixtureDatabase.close(); }
const protectedBefore = Object.fromEntries(protectedPaths.map(name => [name, fs.readFileSync(path.join(target, name))]));
try {
  ps(`if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(32180,17980,18180) }) { throw 'Fixture ports are already occupied' }; & powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quote(path.join(target, 'start-mvp.ps1'))} -NoBrowser -WaitSeconds 45; exit $LASTEXITCODE`);
  await login();
  const bootstrap = await api('/api/bootstrap');
  assert.ok(bootstrap.platforms.every(platform => platform.desired_state === 'STOPPED'));
  await api('/api/settings/operations', { enabled: true, updatedBy: 'isolated-running-upgrade-test' });
  const agent = await api('/api/local-agent/health');
  assert.equal(agent.localAgent.online, true);
  assert.equal(agent.localAgent.bindingVerified, true);
  const browserArguments = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir="${path.join(target, 'tmp/upgrade-browser-test')}"`, 'about:blank'].map(quote).join(', ');
  ps(`$browser = Start-Process -FilePath ${quote(path.join(target, 'runtime/browser/chrome.exe'))} -ArgumentList ${browserArguments} -WindowStyle Hidden -PassThru; Start-Sleep -Milliseconds 500; if ($browser.HasExited) { throw 'Fixture browser did not stay running' }`);
  const oldNode = path.join(target, 'runtime/node.exe');
  assert.throws(() => fs.openSync(oldNode, 'r+'), { code: 'EBUSY' });
  // Capture after the old service finishes its normal startup migrations,
  // immediately before installation, so the comparison isolates the upgrade.
  const businessBefore = databaseSnapshot('data/mvp.db', ['messages', 'publish_tasks', 'knowledge', 'knowledge_aliases']);
  const ragBefore = databaseSnapshot('rag/data/rag.db', ['documents', 'document_versions', 'chunks', 'releases', 'release_members', 'active_releases']);
  assert.ok(businessBefore.messages.length > 0, 'upgrade must preserve an existing message, not just an empty database');
  // Reproduce the old installer's blind spot without changing the running services.
  for (const name of ['server.pid', 'agent.pid', 'rag.pid']) fs.rmSync(path.join(target, 'logs', name), { force: true });
  console.log('RUNNING_UPGRADE_READY: Web, RAG, Agent and bundled Chrome running; PID files removed.');
  const result = installAt(target);
  assert.equal(result.status, 0, `installer failed: ${result.status} ${result.error || ''}`);
  assert.doesNotThrow(() => fs.closeSync(fs.openSync(oldNode, 'r+')));
  ps(`if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(32180,17980,18180) }) { throw 'Installer left a fixture service running' }`);
  for (const [name, before] of Object.entries(protectedBefore)) assert.deepEqual(fs.readFileSync(path.join(target, name)), before, `${name} changed`);
  assertSnapshotEqual(databaseSnapshot('data/mvp.db', Object.keys(businessBefore)), businessBefore);
  assertSnapshotEqual(databaseSnapshot('rag/data/rag.db', Object.keys(ragBefore)), ragBefore);
  report.runningServicesStoppedWithoutPidFiles = true;
  report.existingMessagesPreserved = businessBefore.messages.length;
  report.configurationAndSocialProfilePreserved = true;
  report.knowledgeAndReleasesPreserved = true;
  ps(`& powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${quote(path.join(target, 'start-mvp.ps1'))} -NoBrowser -WaitSeconds 45; exit $LASTEXITCODE`);
  await login();
  assert.equal((await api('/api/health')).service, 'cloud-web');
  assert.equal((await api('/api/settings/ai')).settings.configured, true);
  assert.equal((await api('/api/settings/wecom')).settings.configured, true);
  assert.ok((await api('/api/rag/releases')).active);
  await api('/api/settings/operations', { enabled: false, updatedBy: 'isolated-running-upgrade-test' });
  report.upgradedServicesAndConfigurationVerified = true;
} finally { stopFixture(); }
console.log(JSON.stringify(report, null, 2));
console.log('RUNNING_UPGRADE_VERIFY_OK');
