import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, composeArgs, parseArguments, project, runWorkbench, supportsCompose } from '../scripts/workbench.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const mount = '/integrations/ai-signal/';
const fixtureEnv = 'ADMIN_USERNAME=launcher-test\nADMIN_PASSWORD=test-only-launcher-password\n';

async function fixture(t, { configured = true, outputs = false, dockerType = 'linux', composeVersion = '2.24.4', fail = '', overrides = {} } = {}) {
  // Spaces and non-ASCII are intentional: Windows checkout paths must stay intact.
  const root = await mkdtemp(path.join(tmpdir(), 'workbench 路径 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (configured) await writeFile(path.join(root, '.env.docker'), fixtureEnv);
  if (outputs) await writeFile(path.join(root, 'compose.outputs.local.yaml'), '# local paths are private\nservices: {}\n');
  const prefix = outputs ? composeArgs('-f', 'compose.outputs.local.yaml') : composeArgs();
  const calls = [];
  const requests = [];
  const logs = [];
  const opened = [];
  const options = {
    root,
    log: text => logs.push(text),
    open: url => opened.push(url),
    run(command, args, settings) {
      calls.push({ command, args, settings });
      assert.equal(settings.root, root);
      if (command === process.execPath) {
        execFileSync(command, args, { cwd: root, stdio: 'pipe' });
        return '';
      }
      assert.equal(command, 'docker');
      if (args[0] === 'info') return dockerType;
      if (args.join(' ') === 'compose version --short') return composeVersion;
      assert.deepEqual(args.slice(0, prefix.length), prefix);
      if (args[prefix.length] === fail) throw new Error(`simulated ${fail} failure`);
      return '';
    },
    async request(url, options = {}) {
      const route = new URL(url).pathname;
      requests.push({ route, options });
      const authenticated = options.headers?.Cookie === 'workbench-session=test-only-session';
      if (overrides[route]) return overrides[route]({ authenticated, options });
      if (route === '/api/health') return Response.json({ service: 'cloud-web' });
      if (route === '/api/auth/login') {
        assert.deepEqual(JSON.parse(options.body), { username: 'launcher-test', password: 'test-only-launcher-password' });
        return Response.json({ ok: true }, { headers: { 'set-cookie': 'workbench-session=test-only-session; HttpOnly; Path=/' } });
      }
      if (route === '/api/auth/logout') return Response.json({ ok: true });
      if (!authenticated) return Response.json({ error: 'login required' }, { status: 401 });
      if (route === '/api/creative-workbench/status') return Response.json({ services: [{ id: 'automatic', online: true, url: mount }] });
      if (route === mount) return new Response(`<title>AI Signal Studio</title><base href="${mount}">`);
      if (route === `${mount}app.js`) return new Response('/* bundled Signal client */');
      if (route === `${mount}api/state`) return Response.json({ runs: [] });
      if (route === `${mount}api/health`) return Response.json({ ok: true, service: 'AI Signal Studio' });
      if (route === '/api/content-library') return Response.json({ items: [] });
      throw new Error(`Unexpected request: ${route}`);
    },
  };
  return { root, calls, requests, logs, opened, options };
}

test('CLI only accepts explicit supported commands and start flags', () => {
  assert.deepEqual(parseArguments(['start', '--no-browser']), { action: 'start', noBrowser: true });
  assert.deepEqual(parseArguments(['verify']), { action: 'verify', noBrowser: false });
  assert.deepEqual(parseArguments(['--help']), { action: 'help' });
  for (const args of [[], ['down'], ['start', '--volumes'], ['stop', '--no-browser'], ['start', '&']]) {
    assert.throws(() => parseArguments(args), /Usage:/);
  }
});

test('Compose version guard enforces support for override and optional env files', () => {
  for (const version of ['2.24.4', 'v2.24.4-desktop.1', '2.25.0', '2.40.3', '3.0.0']) assert.ok(supportsCompose(version), version);
  for (const version of ['2.24.3', '2.23.9', '1.29.2', 'not installed', '2.24']) assert.equal(supportsCompose(version), false, version);
});

test('the CLI entry point works from outside the checkout', () => {
  const output = execFileSync(process.execPath, [path.join(sourceRoot, 'scripts/workbench.mjs'), '--help'], {
    cwd: tmpdir(), encoding: 'utf8',
  });
  assert.match(output, /Usage: node scripts\/workbench.mjs/);
});

test('all commands reuse one project and include the bundled engine overlay', () => {
  assert.deepEqual(composeArgs('ps', '--all'), ['compose', '-p', project, '-f', 'compose.yaml', '-f', 'compose.signal.yaml', 'ps', '--all']);
});

test('the shipped outputs template alone never enables external sources', async t => {
  const f = await fixture(t);
  await cp(path.join(sourceRoot, 'compose.outputs.yaml'), path.join(f.root, 'compose.outputs.yaml'));
  await runWorkbench({ action: 'start', noBrowser: true }, f.options);
  const calls = f.calls.filter(call => call.args[1] === '-p');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.args.includes('compose.outputs.yaml') && !call.args.includes('compose.outputs.local.yaml')));
  assert.ok(f.logs.some(line => line.includes('not configured')));
});

test('start, stop, status and verify consistently load the optional local outputs file', async t => {
  for (const action of ['start', 'stop', 'status', 'verify']) {
    const f = await fixture(t, { outputs: true });
    const before = await readFile(path.join(f.root, 'compose.outputs.local.yaml'), 'utf8');
    await runWorkbench({ action, noBrowser: true }, f.options);
    const calls = f.calls.filter(call => call.args[1] === '-p');
    const prefix = composeArgs('-f', 'compose.outputs.local.yaml');
    assert.ok(calls.length >= 2, action);
    for (const call of calls) assert.deepEqual(call.args.slice(0, prefix.length), prefix, action);
    assert.ok(f.logs.some(line => line === 'Using optional outputs configuration: compose.outputs.local.yaml'));
    assert.ok(f.logs.every(line => !line.includes('test-only-launcher-password') && !line.includes('local paths are private')));
    assert.equal(await readFile(path.join(f.root, 'compose.outputs.local.yaml'), 'utf8'), before);
    if (action === 'stop') assert.deepEqual(calls.at(-1).args.slice(prefix.length), ['stop']);
    if (action === 'verify') assert.deepEqual(calls.at(-1).args.slice(prefix.length), ['exec', '-T', 'signal', 'python3', 'scripts/smoke_render.py']);
  }
});

test('invalid local outputs configuration stops before starting any containers', async t => {
  const invalid = await fixture(t);
  await mkdir(path.join(invalid.root, 'compose.outputs.local.yaml'));
  await assert.rejects(runWorkbench({ action: 'start' }, invalid.options), /compose.outputs.local.yaml must be a file/);
  assert.equal(invalid.calls.some(call => call.args[1] === '-p'), false);
  const broken = await fixture(t, { outputs: true, fail: 'config' });
  await assert.rejects(runWorkbench({ action: 'start' }, broken.options), /simulated config failure/);
  assert.equal(broken.calls.some(call => call.args.includes('up')), false);
  assert.deepEqual(broken.opened, []);
});

test('fresh checkout initializes config and stops before launching containers', async t => {
  const f = await fixture(t, { configured: false });
  await mkdir(path.join(f.root, 'scripts'));
  await cp(path.join(sourceRoot, 'scripts/init-docker-dev.mjs'), path.join(f.root, 'scripts/init-docker-dev.mjs'));
  await cp(path.join(sourceRoot, '.env.docker.example'), path.join(f.root, '.env.docker.example'));
  await assert.rejects(runWorkbench({ action: 'start' }, f.options), /Set ADMIN_USERNAME and ADMIN_PASSWORD/);
  const generated = await readFile(path.join(f.root, '.env.docker'), 'utf8');
  assert.ok(generated.includes('ADMIN_USERNAME=admin'));
  assert.ok(!generated.includes('replace-with-random-secret'));
  assert.ok(!generated.includes('replace-with-shared-rag-token'));
  assert.equal(f.calls.some(call => call.args.includes('up')), false);
  assert.deepEqual(f.opened, []);
});

test('start waits for the full stack and retains existing configuration', async t => {
  const f = await fixture(t);
  await runWorkbench({ action: 'start' }, f.options);
  const composeCalls = f.calls.filter(call => call.args[0] === 'compose' && call.args[1] === '-p');
  assert.deepEqual(composeCalls.map(call => call.args.slice(7)), [
    ['config', '--quiet'], ['up', '-d', '--build', '--wait', '--wait-timeout', '300'], ['ps', '--all'],
  ]);
  assert.equal(await readFile(path.join(f.root, '.env.docker'), 'utf8'), fixtureEnv);
  assert.deepEqual(f.opened, [`${baseUrl}/#studio`]);
});

test('start supports headless checks and never opens a page after failed startup', async t => {
  const headless = await fixture(t);
  await runWorkbench({ action: 'start', noBrowser: true }, headless.options);
  assert.deepEqual(headless.opened, []);
  const failed = await fixture(t, { fail: 'up' });
  await assert.rejects(runWorkbench({ action: 'start' }, failed.options), /simulated up failure/);
  assert.deepEqual(failed.opened, []);
  assert.deepEqual(failed.requests, []);
});

test('unsupported Docker engine and Compose fail before mutation', async t => {
  for (const setup of [{ dockerType: 'windows' }, { composeVersion: '2.24.3' }]) {
    const f = await fixture(t, setup);
    await assert.rejects(runWorkbench({ action: 'start' }, f.options), /Linux containers|2.24.4/);
    assert.equal(f.calls.some(call => call.args.includes('-p')), false);
  }
});

test('stop retains all volumes and status does not start or stop services', async t => {
  for (const action of ['stop', 'status']) {
    const f = await fixture(t);
    await runWorkbench({ action }, f.options);
    assert.deepEqual(f.calls.at(-1).args, composeArgs(...(action === 'stop' ? ['stop'] : ['ps', '--all'])));
    assert.ok(f.calls.every(call => !call.args.some(arg => ['down', '-v', '--volumes', 'up', 'rm'].includes(arg))));
    assert.equal(await readFile(path.join(f.root, '.env.docker'), 'utf8'), fixtureEnv);
  }
});

test('verify checks authenticated integration then runs only synthetic rendering', async t => {
  const f = await fixture(t);
  await runWorkbench({ action: 'verify' }, f.options);
  assert.deepEqual(f.calls.at(-1).args, composeArgs('exec', '-T', 'signal', 'python3', 'scripts/smoke_render.py'));
  assert.ok(f.requests.some(request => request.route === '/api/content-library' && request.options.headers?.Cookie));
  assert.equal(f.requests.at(-1).route, '/api/auth/logout');
  assert.ok(f.requests.every(request => !request.route.includes('generate') && !request.route.includes('publish')));
  assert.ok(f.logs.at(-1).includes('fully decoded'));
  assert.deepEqual(f.opened, []);
});

test('verify rejects missing authentication or an offline engine without rendering', async t => {
  for (const overrides of [
    { [mount]: () => new Response('unprotected page') },
    { '/api/creative-workbench/status': () => Response.json({ services: [{ id: 'automatic', online: false, url: mount }] }) },
    { '/api/auth/login': () => Response.json({ error: 'bad login' }, { status: 401 }) },
  ]) {
    const f = await fixture(t, { overrides });
    await assert.rejects(runWorkbench({ action: 'verify' }, f.options), /protection failed|not online|Login failed/);
    assert.equal(f.calls.some(call => call.args.includes('exec')), false);
  }
});

test('a failed render cannot be reported as a successful workbench verification', async t => {
  const f = await fixture(t, { fail: 'exec' });
  await assert.rejects(runWorkbench({ action: 'verify' }, f.options), /simulated exec failure/);
  assert.ok(f.logs.every(log => !log.includes('fully decoded')));
});

test('verify detects a fallback main page instead of the bundled Signal interface', async t => {
  const f = await fixture(t, { overrides: {
    [mount]: ({ authenticated }) => authenticated
      ? new Response('<title>Main workbench fallback</title>')
      : new Response('Login required', { status: 401 }),
  } });
  await assert.rejects(runWorkbench({ action: 'verify' }, f.options), /did not serve the bundled Signal page/);
  assert.equal(f.calls.some(call => call.args.includes('exec')), false);
});
