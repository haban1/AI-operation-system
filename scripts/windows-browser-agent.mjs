import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { acquireInstanceLock } from '../src/services/instance-lock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(root, 'runtime', 'browser-agent');
fs.mkdirSync(runtimeDir, { recursive: true });
const lock = acquireInstanceLock(path.join(runtimeDir, 'supervisor.lock'), { label: 'Windows browser supervisor' });
fs.writeFileSync(path.join(runtimeDir, 'supervisor.pid'), String(process.pid));
const envPath = path.join(root, '.env.docker');
const machineConfigPath = path.join(runtimeDir, 'config.json');
let child = null;
let stopped = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function fileEnvironment() {
  const values = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function options() {
  const local = fs.existsSync(machineConfigPath) ? JSON.parse(fs.readFileSync(machineConfigPath, 'utf8')) : {};
  const source = fileEnvironment();
  if (!source.AGENT_SHARED_TOKEN) throw new Error('.env.docker 未配置 AGENT_SHARED_TOKEN');
  const env = {
    ...process.env,
    // Web and native workers must use the same channel queue switches. With
    // TIANHE_SKIP_DOTENV the child cannot discover these settings on its own.
    ...Object.fromEntries(Object.entries(source).filter(([key]) =>
      key === 'CHANNEL_SPLIT_ENABLED' || /^PLATFORM_CHANNEL_SPLIT_(DOUYIN|XIAOHONGSHU|WECHAT_CHANNELS|BILIBILI|WEIBO)$/.test(key))),
    TIANHE_SKIP_DOTENV: 'true',
    AGENT_SHARED_TOKEN: source.AGENT_SHARED_TOKEN,
    DEVICE_ID: source.DEVICE_ID || 'device-rpa-01',
    CLOUD_BASE_URL: local.webUrl || 'http://127.0.0.1:3100',
    AGENT_HOST: local.agentHost || '0.0.0.0',
    AGENT_PORT: String(local.agentPort || 17831),
    RPA_MODE: 'five_platform_assisted',
    AGENT_ROLE: 'browser',
    AGENT_REMOTE_MATERIALS: 'true',
    AGENT_MATERIAL_CACHE_DIR: path.join(runtimeDir, 'materials'),
    CHROME_EXECUTABLE_PATH: local.chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    XHS_PROFILE_DIR: path.join(runtimeDir, 'profiles', 'xiaohongshu'),
    DOUYIN_PROFILE_DIR: path.join(runtimeDir, 'profiles', 'douyin'),
    CHANNELS_PROFILE_DIR: path.join(runtimeDir, 'profiles', 'wechat_channels'),
    BILIBILI_PROFILE_DIR: path.join(runtimeDir, 'profiles', 'bilibili'),
    WEIBO_PROFILE_DIR: path.join(runtimeDir, 'profiles', 'weibo'),
    // Stable logical account names mapped to these machine-owned profiles.
    // Analytics must never infer its account from a queued task's label.
    PLATFORM_ANALYTICS_PROFILE_BINDINGS: JSON.stringify({
      douyin: 'profile-douyin-main', wechat_channels: 'profile-channels-main',
      bilibili: 'profile-bilibili-main', weibo: 'profile-weibo-main'
    }),
    BROWSER_CONTROL_ENABLED: 'false',
    INSTANCE_LOCK_ENABLED: 'true'
  };
  if (!fs.existsSync(env.CHROME_EXECUTABLE_PATH)) throw new Error('未找到 Chrome，请先安装或在 config.json 配置 chromePath');
  return env;
}

async function stop() {
  stopped = true;
  if (child) {
    const env = options();
    try { await fetch(`http://127.0.0.1:${env.AGENT_PORT}/control/shutdown`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Token': env.AGENT_SHARED_TOKEN },
      body: '{}', signal: AbortSignal.timeout(3000) }); } catch {}
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(5000)]);
    child?.kill();
  }
  lock.release();
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('exit', () => lock.release());

try {
  while (!stopped) {
    const env = options();
    try {
      const response = await fetch(`${env.CLOUD_BASE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('Web offline');
    } catch { await pause(5000); continue; }
    const stdout = fs.openSync(path.join(runtimeDir, 'agent.out.log'), 'a');
    const stderr = fs.openSync(path.join(runtimeDir, 'agent.err.log'), 'a');
    try {
      child = spawn(process.execPath, ['agent/local-agent.js'], {
        cwd: root, env, windowsHide: true, stdio: ['ignore', stdout, stderr]
      });
    } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    fs.writeFileSync(path.join(runtimeDir, 'agent.pid'), String(child.pid));
    await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    child = null;
    if (!stopped) await pause(5000);
  }
} finally { lock.release(); }
