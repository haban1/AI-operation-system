import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const target = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && fs.existsSync(path.join(target, '.env')), 'Pass an installed directory');
const installedImport = relative => import(pathToFileURL(path.join(target, relative)).href);
const { config } = await installedImport('src/config.js');
const { buildCollectionChannelPlans } = await installedImport('src/services/channel-job-scheduler.js');
const { platformWorkerPlans } = await installedImport('agent/job-operation-lane.js');
const { AssistedPlatformRpaAdapter } = await installedImport('agent/rpa-adapters/assisted-platform.js');
const requireInstalled = createRequire(path.join(target, 'package.json'));
const { chromium } = requireInstalled('playwright-core');
const platforms = ['douyin', 'wechat_channels', 'bilibili', 'weibo'];
for (const platformCode of platforms) {
  const plans = buildCollectionChannelPlans({ platformCode, featureConfig: config });
  assert.deepEqual(plans.map(plan => plan.channelType), ['COMMENT', 'PRIVATE_MESSAGE'], `${platformCode}: installed channel configuration`);
}
assert.equal(buildCollectionChannelPlans({ platformCode: 'xiaohongshu', featureConfig: config }).length, 1);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-installed-channels-'));
const listener = http.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const dbPath = path.join(temporary, 'fixture.db');
// Use the installed Web code with a disposable database and no Agent. Only
// channel settings come from the actual install; external actions are disabled.
const server = spawn(path.join(target, 'runtime/node.exe'), ['src/server.js'], {
  cwd: target, windowsHide: true,
  env: { ...process.env, PORT: String(port), DATABASE_PATH: dbPath,
    AUTH_ENABLED: 'false', AGENT_SHARED_TOKEN: '', AUTO_COLLECT_ENABLED: 'false',
    LOCAL_AGENT_AUTO_START: 'false', INSTANCE_LOCK_ENABLED: 'false',
    RPA_MODE: 'simulated', QWEN_MODE: 'mock', QWEN_API_KEY: '', WECOM_WEBHOOK_URL: '',
    RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_ADMIN_ENABLED: 'false' },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderr = '';
server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
let browser;
let db;
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (ready) break;
    if (server.exitCode !== null) throw new Error(`Fixture Web exited: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Fixture Web health: ${stderr}`);
  db = new DatabaseSync(dbPath);
  // The fixture has no customer records, credentials or social browser profiles.
  db.prepare("UPDATE platforms SET desired_state='RUNNING' WHERE code<>'xiaohongshu'").run();
  db.prepare("INSERT OR REPLACE INTO system_settings(setting_key,encrypted_value,updated_at,updated_by) VALUES('operations.master_enabled','true',?,'installer-fixture')").run(new Date().toISOString());
  browser = await chromium.launch({ executablePath: path.join(target, 'runtime/browser/chrome.exe'), headless: true });
  const report = [];
  for (const platformCode of platforms) {
    const account = db.prepare('SELECT * FROM accounts WHERE platform_code=? AND enabled=1 LIMIT 1').get(platformCode);
    assert.ok(account, platformCode);
    const response = await fetch(`${base}/api/platforms/${platformCode}/collect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: account.id, types: ['COMMENT', 'PRIVATE_MESSAGE'] })
    });
    const queued = await response.json();
    assert.equal(response.status, 200, JSON.stringify(queued));
    assert.equal(queued.jobIds.length, 2, `${platformCode}: two persisted jobs`);
    const jobs = db.prepare('SELECT job_type,payload,channel_type FROM agent_jobs WHERE id IN (?,?) ORDER BY id').all(...queued.jobIds).map(job => ({ ...job, payload: JSON.parse(job.payload) }));
    assert.deepEqual(jobs.map(job => job.channel_type), ['COMMENT', 'PRIVATE_MESSAGE']);
    const workerPlans = platformWorkerPlans(platformCode, { splitEnabled: true });
    assert.deepEqual(workerPlans.slice(0, 2).map(plan => plan.queueLanes), [['PRIVATE_MESSAGE'], ['COMMENT']]);
    const context = await browser.newContext();
    try {
      // Real Chromium pages and the installed Agent's execute/page-scope code;
      // the external platform collector is replaced only at its network boundary.
      const adapter = Object.create(AssistedPlatformRpaAdapter.prototype);
      adapter.platformCode = platformCode;
      adapter.spec = { name: platformCode, hostHints: ['fixture.invalid'] };
      adapter.channelPages = new Map();
      adapter.ensureContext = async () => context;
      adapter.collectMessages = async function(payload) {
        const page = await this.getPage();
        await page.goto('data:text/html,' + encodeURIComponent(`<main>${payload.channelType}</main>`));
        return { status: 'SUCCESS', result: { messages: [], channel: await page.locator('main').innerText() } };
      };
      const results = await Promise.all(jobs.map(job => adapter.execute(job)));
      assert.deepEqual(results.map(result => result.result.channel), ['COMMENT', 'PRIVATE_MESSAGE']);
      const comment = adapter.channelPages.get('COMMENT');
      const privatePage = adapter.channelPages.get('PRIVATE_MESSAGE');
      assert.ok(comment && privatePage);
      assert.notEqual(comment, privatePage);
      assert.equal(context.pages().length, 2);
      report.push({ platformCode, persistedCollectionJobs: jobs.length, independentBrowserPages: 2 });
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({ installedChannelsVerified: true, fixtureOnly: true, platforms: report }));
} finally {
  db?.close();
  await browser?.close();
  if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
