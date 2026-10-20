import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, ROOT } from '../config.js';

const DEFAULT_HOST = '127.0.0.1';
let managedChild = null;
let startPromise = null;
let shutdownPromise = null;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function expectedAgentBindingId(deviceId) {
  if (!config.agentToken) return null;
  return crypto.createHash('sha256').update(`${deviceId || ''}\0${config.agentToken}`).digest('hex').slice(0, 24);
}

function healthRequest({ host = DEFAULT_HOST, port = config.agentPort, timeoutMs = 700 } = {}) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ reachable: res.statusCode === 200, statusCode: res.statusCode, data });
        } catch {
          resolve({ reachable: false, statusCode: res.statusCode, data: null });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ reachable: false, statusCode: null, data: null }));
  });
}

export async function checkLocalAgentHealth(options = {}) {
  const expectedDeviceId = options.deviceId ?? config.deviceId;
  const result = await healthRequest(options);
  const expectedBindingId = expectedAgentBindingId(expectedDeviceId);
  const bindingMatches = !expectedBindingId || result.data?.bindingId === expectedBindingId;
  const identityMatches = result.reachable
    && result.data?.ok === true
    && (!expectedDeviceId || result.data.deviceId === expectedDeviceId)
    && bindingMatches;
  return {
    online: identityMatches,
    reachable: result.reachable,
    statusCode: result.statusCode,
    bindingMatches,
    health: result.data,
    message: identityMatches
      ? 'Local Agent 已连接'
      : result.reachable
        ? (bindingMatches ? '端口已被其他服务占用，未识别到目标 Local Agent' : '检测到 Local Agent，但它不属于当前 Web 安装实例')
        : 'Local Agent 尚未启动'
  };
}

function createAgentProcess({
  port,
  cloudBaseUrl,
  deviceId,
  agentEntryPath,
  logsDir,
  env = {}
}) {
  fs.mkdirSync(logsDir, { recursive: true });
  const stdoutPath = path.join(logsDir, 'agent.out.log');
  const stderrPath = path.join(logsDir, 'agent.err.log');
  const stdout = fs.openSync(stdoutPath, 'a');
  const stderr = fs.openSync(stderrPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [agentEntryPath], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...env,
        AGENT_PORT: String(port),
        CLOUD_BASE_URL: cloudBaseUrl,
        DEVICE_ID: deviceId
      },
      detached: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', stdout, stderr]
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  child.unref();
  return child;
}

export async function ensureLocalAgentOnline(options = {}) {
  if (shutdownPromise) await shutdownPromise;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const port = options.port ?? config.agentPort;
    const host = options.host ?? DEFAULT_HOST;
    const deviceId = options.deviceId ?? config.deviceId;
    const cloudBaseUrl = options.cloudBaseUrl ?? `http://127.0.0.1:${config.port}`;
    const timeoutMs = options.timeoutMs ?? config.localAgentStartTimeoutMs;
    const pollMs = options.pollMs ?? 200;
    const agentEntryPath = options.agentEntryPath ?? config.localAgentEntryPath;
    const logsDir = options.logsDir ?? path.join(ROOT, 'logs');

    // A master-switch restart may arrive immediately after shutdown. The
    // public guard above serializes it with any in-flight shutdown.
    let existing = await checkLocalAgentHealth({ host, port, deviceId });
    if (existing.online) {
      return { online: true, started: false, alreadyRunning: true, pid: null, message: 'Local Agent \u5df2\u8fde\u63a5\uff0c\u65e0\u9700\u91cd\u590d\u542f\u52a8' };
    }
    if (existing.reachable) {
      const error = new Error(existing.message);
      error.code = 'LOCAL_AGENT_PORT_CONFLICT';
      throw error;
    }

    // The listener can close before the managed Node process exits. Wait for
    // that old process (or terminate a stale one) before reusing the port.
    if (managedChild) {
      const exited = await waitForManagedLocalAgentExit(Math.min(2000, timeoutMs));
      if (!exited) await stopManagedLocalAgent();
      if (managedChild && !childHasExited(managedChild)) {
        const error = new Error('Previous Local Agent process has not exited; refusing to start a second process');
        error.code = 'LOCAL_AGENT_SHUTDOWN_INCOMPLETE';
        throw error;
      }
      existing = await checkLocalAgentHealth({ host, port, deviceId });
      if (existing.online) {
        return { online: true, started: false, alreadyRunning: true, pid: null, message: 'Local Agent \u5df2\u8fde\u63a5\uff0c\u65e0\u9700\u91cd\u590d\u542f\u52a8' };
      }
      if (existing.reachable) {
        const error = new Error(existing.message);
        error.code = 'LOCAL_AGENT_PORT_CONFLICT';
        throw error;
      }
    }

    if (!fs.existsSync(agentEntryPath)) {
      const error = new Error(`Local Agent 启动文件不存在：${agentEntryPath}`);
      error.code = 'LOCAL_AGENT_ENTRY_MISSING';
      throw error;
    }

    const child = createAgentProcess({ port, cloudBaseUrl, deviceId, agentEntryPath, logsDir, env: options.env });
    managedChild = child;
    let spawnError = null;
    let exited = false;
    let exitCode = null;
    child.once('error', error => { spawnError = error; });
    child.once('exit', code => {
      exited = true;
      exitCode = code;
      if (managedChild === child) managedChild = null;
    });

    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (exited) throw new Error(`Local Agent \u542f\u52a8\u540e\u5f02\u5e38\u9000\u51fa\uff08\u4ee3\u7801 ${exitCode ?? 'signal'}\uff09`);
        const health = await checkLocalAgentHealth({ host, port, deviceId });
        if (health.online) {
          fs.writeFileSync(path.join(logsDir, 'agent.pid'), String(child.pid), 'utf8');
          return { online: true, started: true, alreadyRunning: false, pid: child.pid, message: 'Local Agent \u5df2\u81ea\u52a8\u542f\u52a8\u5e76\u8fde\u63a5' };
        }
        if (health.reachable) throw new Error(health.message);
        await delay(pollMs);
      }

      const error = new Error(`Local Agent \u5728 ${timeoutMs}ms \u5185\u672a\u80fd\u8fde\u63a5\uff0c\u8bf7\u67e5\u770b logs/agent.err.log`);
      error.code = 'LOCAL_AGENT_START_TIMEOUT';
      throw error;
    } catch (error) {
      if (!exited && child.exitCode === null) child.kill();
      if (managedChild === child) managedChild = null;
      throw error;
    }
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

function childHasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs = 1500) {
  if (childHasExited(child)) return true;
  await new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    timer = setTimeout(finish, Math.max(0, timeoutMs));
    child.once('exit', finish);
  });
  return childHasExited(child);
}

async function waitForManagedLocalAgentExit(timeoutMs = 1500) {
  const child = managedChild;
  if (!child) return true;
  const exited = await waitForChildExit(child, timeoutMs);
  if (exited && managedChild === child) managedChild = null;
  return exited;
}

export async function stopManagedLocalAgent() {
  const child = managedChild;
  if (!child) return false;
  if (childHasExited(child)) {
    if (managedChild === child) managedChild = null;
    return false;
  }

  child.kill();
  let exited = await waitForChildExit(child, 1500);
  if (!exited && !childHasExited(child)) {
    child.kill('SIGKILL');
    exited = await waitForChildExit(child, 1000);
  }
  if (exited && managedChild === child) managedChild = null;
  return true;
}

async function shutdownLocalAgentImpl(options = {}) {
  const port = options.port ?? config.agentPort;
  const host = options.host ?? DEFAULT_HOST;
  const deviceId = options.deviceId ?? config.deviceId;
  const timeoutMs = options.timeoutMs ?? 6000;
  const pollMs = options.pollMs ?? 100;
  const logsDir = options.logsDir ?? path.join(ROOT, 'logs');
  const clearPidFile = () => fs.rmSync(path.join(logsDir, 'agent.pid'), { force: true });

  // Startup health can become visible to callers before ensureLocalAgentOnline
  // has settled. Let that in-flight startup finish before shutting it down;
  // otherwise a later enable can accidentally reuse the doomed startPromise.
  if (startPromise) {
    try { await startPromise; } catch {}
  }

  const before = await checkLocalAgentHealth({ host, port, deviceId });
  if (!before.online) {
    let forcedManagedStop = false;
    if (managedChild && !(await waitForManagedLocalAgentExit(Math.min(1500, timeoutMs)))) {
      forcedManagedStop = await stopManagedLocalAgent();
    }
    const processStopped = !managedChild || childHasExited(managedChild);
    if (processStopped) clearPidFile();
    return {
      stopped: processStopped,
      alreadyStopped: true,
      accepted: false,
      forcedManagedStop,
      message: 'Local Agent \u5df2\u505c\u6b62'
    };
  }

  let accepted = false;
  let gracefulError = null;
  try {
    const response = await fetch(`http://${host}:${port}/control/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.agentToken ? { 'X-Agent-Token': config.agentToken } : {}) },
      body: JSON.stringify({ reason: options.reason || 'MASTER_SWITCH_OFF' }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, 2000))
    });
    accepted = response.ok;
    await response.arrayBuffer();
    if (!response.ok) gracefulError = `Local Agent \u62d2\u7edd\u5173\u95ed\u8bf7\u6c42\uff08HTTP ${response.status}\uff09`;
  } catch (error) {
    gracefulError = error.message;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkLocalAgentHealth({ host, port, deviceId });
    if (!health.online && !health.reachable) {
      // The HTTP listener can disappear a few milliseconds before the managed
      // Node process exits. Wait for that exit so an immediate master-switch
      // restart cannot race the old process and hit EADDRINUSE.
      let forcedManagedStop = false;
      const childExited = await waitForManagedLocalAgentExit(Math.min(1500, Math.max(100, deadline - Date.now())));
      if (!childExited) forcedManagedStop = await stopManagedLocalAgent();
      const processStopped = !managedChild || childHasExited(managedChild);
      if (processStopped) clearPidFile();
      return {
        stopped: processStopped,
        alreadyStopped: false,
        accepted,
        forcedManagedStop,
        message: 'Local Agent \u5df2\u968f\u5168\u5c40\u603b\u5f00\u5173\u5b89\u5168\u505c\u6b62'
      };
    }
    await delay(pollMs);
  }

  const forcedManagedStop = await stopManagedLocalAgent();
  const after = await checkLocalAgentHealth({ host, port, deviceId });
  if (!after.online) clearPidFile();
  return {
    stopped: !after.online,
    alreadyStopped: false,
    accepted,
    forcedManagedStop,
    message: !after.online
      ? 'Local Agent \u5df2\u505c\u6b62'
      : '\u5168\u5c40\u4efb\u52a1\u5df2\u505c\u6b62\uff0c\u4f46 Local Agent \u8fdb\u7a0b\u672a\u80fd\u9000\u51fa',
    error: after.online ? (gracefulError || 'LOCAL_AGENT_SHUTDOWN_TIMEOUT') : null
  };
}


export async function shutdownLocalAgent(options = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = shutdownLocalAgentImpl(options);
  try {
    return await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
}
