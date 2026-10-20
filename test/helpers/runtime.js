import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const root = path.resolve(import.meta.dirname, '..', '..');

export async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function tempRuntimeDir(prefix = 'tianhe-runtime-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function waitForHttp(base, pathname = '/api/health', child = null, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`进程提前退出(${child.exitCode})：${child.stderrText || ''}`);
    try {
      const response = await fetch(base + pathname, { signal: AbortSignal.timeout(400) });
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`等待服务超时：${base}${pathname}\n${child?.stderrText || ''}`);
}

export function spawnNode(args, { env = {}, cwd = root } = {}) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      LOCAL_AGENT_AUTO_START: 'false',
      AUTO_COLLECT_ENABLED: 'false',
      AUTH_ENABLED: 'false',
      AGENT_SHARED_TOKEN: '',
      SMOKE_TEST_ENABLED: 'false',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', chunk => { child.stdoutText += chunk.toString(); });
  child.stderr.on('data', chunk => { child.stderrText += chunk.toString(); });
  return child;
}

export async function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2500))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export function cleanupDir(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80); }
  }
}

export async function startServer({ dir = tempRuntimeDir(), port, env = {} } = {}) {
  const resolvedPort = port || await freePort();
  const dbPath = path.join(dir, 'runtime.db');
  const child = spawnNode(['src/server.js'], {
    env: {
      PORT: String(resolvedPort),
      SERVER_HOST: '127.0.0.1',
      DATABASE_PATH: dbPath,
      QWEN_MODE: 'mock',
      RPA_MODE: 'simulated',
      AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false',
      SMOKE_TEST_ENABLED: 'false',
      INSTANCE_LOCK_ENABLED: 'true',
      ...env
    }
  });
  const base = `http://127.0.0.1:${resolvedPort}`;
  await waitForHttp(base, '/api/health', child);
  return { child, base, port: resolvedPort, dir, dbPath };
}

export async function jsonRequest(base, pathname, options = {}) {
  const headers = { ...(options.body !== undefined && typeof options.body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const body = options.body !== undefined && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body;
  const response = await fetch(base + pathname, { ...options, headers, body });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, data, text };
}

/* ==========================================================================
   分组工作区导航（智慧驱动版主界面）
   主界面已从「扁平导航 data-page」改为「侧边栏六分组 + 分组子栏目」：
     侧边栏  -> #nav button[data-workspace="<group>"]
     子栏目  -> #workspaceSubnav button[data-workspace-item="<key>"]
   浏览器测试统一通过 openWorkspacePage() 打开页面，避免各测试文件重复拼选择器。
   ========================================================================== */
export const WORKSPACE_NAV = {
  dashboard: { group: 'overview', key: 'overview' },
  create: { group: 'content', key: 'topics' },
  editing: { group: 'content', key: 'material-editing' },
  publish: { group: 'content', key: 'publishing' },
  tasks: { group: 'content', key: 'publish-tasks' },
  messages: { group: 'inbox', key: 'comments' },
  miniProgram: { group: 'inbox', key: 'mini-program' },
  handoffs: { group: 'inbox', key: 'human-handoffs' },
  knowledge: { group: 'knowledge', key: 'documents' },
  aliases: { group: 'knowledge', key: 'aliases' },
  xiaozhi: { group: 'knowledge', key: 'reply-test' },
  platforms: { group: 'channels', key: 'accounts' },
  browser: { group: 'channels', key: 'browser-tools' },
  wecom: { group: 'settings', key: 'services' },
  wechat: { group: 'wechat', key: 'wechat-service' },
  issues: { group: 'settings', key: 'diagnostics' }
};

/** 按页面名打开分组工作区里的对应栏目，并等待导航提交。
 *  1) 用地址栏深链（#key）而不是「先点分组、再点栏目」：新导航的两次点击会触发两次 navigate，
 *     对依赖渲染所有权/竞态的用例会改变时序；深链只产生一次导航，等价于改造前的一次导航点击。
 *  2) 等待信号用「子导航高亮」（syncWorkspaceNavigation 在 navigate() 内同步执行），
 *     不能等 #content 退出 aria-busy：有意挂起请求的用例会让渲染永远无法完成。
 *     也不能等 location.hash —— 它在 render().then() 里才写入。 */
export async function openWorkspacePage(page, name) {
  const route = WORKSPACE_NAV[String(name)];
  if (!route) throw new Error(`未知页面：${name}`);
  const hash = `#${route.key}`;
  if (!(await page.evaluate(target => location.hash === target, hash))) {
    await page.evaluate(target => { location.hash = target; }, hash);
  }
  // state:'attached'：单栏目分组（运营总览 / 平台与账号）会隐藏整条子导航，用默认的 visible 会超时。
  await page.locator(`#workspaceSubnav button[data-workspace-item="${route.key}"][aria-current="page"]`)
    .waitFor({ state: 'attached' });
}

/** 打开指定分组（导航到该分组第一个栏目），返回该分组当前显示的子栏目文案。 */
export async function openWorkspaceGroup(page, groupId) {
  const firstPage = Object.keys(WORKSPACE_NAV).find(key => WORKSPACE_NAV[key].group === groupId);
  if (!firstPage) throw new Error(`未知分组：${groupId}`);
  await openWorkspacePage(page, firstPage);
  return page.locator('#workspaceSubnav button[data-workspace-item]').allTextContents();
}
