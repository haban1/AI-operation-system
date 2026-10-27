import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const project = 'ai-operation-signal';
export const baseUrl = 'http://127.0.0.1:3100';
const mount = '/integrations/ai-signal/';
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const outputsConfig = 'compose.outputs.local.yaml';
const usage = 'Usage: node scripts/workbench.mjs <start|stop|status|verify> [--no-browser]';

export function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { action: 'help' };
  const [action, ...flags] = args;
  if (!['start', 'stop', 'status', 'verify'].includes(action) ||
      flags.some(flag => flag !== '--no-browser') ||
      (flags.length && action !== 'start')) throw new Error(usage);
  return { action, noBrowser: flags.includes('--no-browser') };
}

export function composeArgs(...args) {
  return ['compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.signal.yaml', ...args];
}

export function supportsCompose(version) {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && (minor > 24 || (minor === 24 && patch >= 4)));
}

function runCommand(command, args, { root, capture = false }) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true,
  });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}).${capture ? `\n${result.stderr || ''}` : ''}`);
  }
  return result.stdout?.trim() || '';
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

async function checkWeb(request) {
  const response = await request(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || (await response.json()).service !== 'cloud-web') {
    throw new Error('The main workbench health check failed. Check docker compose logs web.');
  }
}

async function verifyIntegration(root, request, log) {
  const env = parseEnv(readFileSync(path.join(root, '.env.docker'), 'utf8'));
  const get = (route, options = {}) => request(`${baseUrl}${route}`, {
    ...options, signal: AbortSignal.timeout(15_000), redirect: 'manual',
  });
  for (const route of [mount, `${mount}api/state`, '/api/content-library']) {
    if ((await get(route)).status !== 401) throw new Error(`Login protection failed: ${route}`);
  }
  const login = await get('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
  });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!login.ok || !cookie) throw new Error('Login failed. Check ADMIN_USERNAME and ADMIN_PASSWORD in .env.docker.');
  const headers = { Cookie: cookie };
  try {
    const response = await get('/api/creative-workbench/status', { headers });
    if (!response.ok) throw new Error('Cannot read the workbench status.');
    const automatic = (await response.json()).services?.find(service => service.id === 'automatic');
    if (!automatic?.online || automatic.url !== mount) throw new Error('Signal is not online at the authenticated workbench URL.');
    const page = await get(mount, { headers });
    if (!page.ok || !(await page.text()).includes(`<base href="${mount}">`)) {
      throw new Error('The authenticated mount did not serve the bundled Signal page.');
    }
    for (const route of [`${mount}app.js`, `${mount}api/state`, `${mount}api/health`, '/api/content-library']) {
      const response = await get(route, { headers });
      if (!response.ok) throw new Error(`Workbench integration failed: ${route}`);
      if (route.endsWith('app.js')) {
        if (!(await response.text()).trim()) throw new Error('The Signal client script is empty.');
      } else {
        const data = await response.json();
        if (route.endsWith('api/health') && (data.ok !== true || data.service !== 'AI Signal Studio')) {
          throw new Error('The proxy did not reach the bundled Signal health endpoint.');
        }
        if (route === '/api/content-library' && !Array.isArray(data.items)) {
          throw new Error('The shared content library returned an invalid response.');
        }
      }
    }
    log('PASS: login, Signal page/assets/API, and shared content-library access.');
  } finally {
    await get('/api/auth/logout', { method: 'POST', headers }).catch(() => {});
  }
}

export async function runWorkbench({ action, noBrowser = false }, {
  root = defaultRoot, run = runCommand, request = fetch, open = openBrowser, log = console.log,
} = {}) {
  if (action === 'help') { log(usage); return; }
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  const execute = (command, args, capture = false) => run(command, args, { root, capture });
  if (execute('docker', ['info', '--format', '{{.OSType}}'], true) !== 'linux') {
    throw new Error('Start Docker Desktop with the WSL2 backend and Linux containers.');
  }
  if (!supportsCompose(execute('docker', ['compose', 'version', '--short'], true))) {
    throw new Error('Docker Compose 2.24.4 or newer is required. Update Docker Desktop.');
  }
  if (!existsSync(path.join(root, '.env.docker'))) {
    if (action === 'start') {
      execute(process.execPath, ['scripts/init-docker-dev.mjs']);
      throw new Error('Created .env.docker. Set ADMIN_USERNAME and ADMIN_PASSWORD in that file, then run start again.');
    }
    throw new Error('.env.docker is missing. Run start to initialize this checkout first.');
  }
  const hasOutputs = existsSync(path.join(root, outputsConfig));
  if (hasOutputs && !statSync(path.join(root, outputsConfig)).isFile()) {
    throw new Error(`${outputsConfig} must be a file. See docs/产物确认入库.md.`);
  }
  const overlays = hasOutputs ? ['-f', outputsConfig] : [];
  log(hasOutputs
    ? `Using optional outputs configuration: ${outputsConfig}`
    : `Optional external outputs are not configured (${outputsConfig} not found).`);
  const compose = (...args) => execute('docker', composeArgs(...overlays, ...args));
  compose('config', '--quiet');
  if (action === 'stop') {
    compose('stop');
    log('Stopped this workbench. Databases, settings and finished videos are retained.');
  } else if (action === 'status') {
    compose('ps', '--all');
  } else if (action === 'start') {
    compose('up', '-d', '--build', '--wait', '--wait-timeout', '300');
    compose('ps', '--all');
    await checkWeb(request);
    log(`Workbench ready: ${baseUrl}/#studio`);
    if (!noBrowser) open(`${baseUrl}/#studio`);
  } else if (action === 'verify') {
    compose('ps', '--all');
    await checkWeb(request);
    await verifyIntegration(root, request, log);
    compose('exec', '-T', 'signal', 'python3', 'scripts/smoke_render.py');
    log('PASS: synthetic video rendered and fully decoded. No paid AI generation or publishing was requested.');
  } else {
    throw new Error(usage);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runWorkbench(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`Workbench: ${error.message}`);
    process.exitCode = 1;
  }
}
