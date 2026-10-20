import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tianhe-upgrade-lock-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const installRoot = path.join(temporaryRoot, '中文 installation');
  async function startRuntime(directory) {
    const executable = path.join(directory, 'runtime/node.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.execPath, executable);
    const child = spawn(executable, ['-e', "process.stdout.write('READY'); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await once(child.stdout, 'data');
    return { child, executable };
  }
  return { installRoot, startRuntime };
}

function prepareForOverwrite(installRoot) {
  // Exercise the stop command used by the current installer against a real,
  // isolated Windows process; no taskkill by name or production PID files.
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'packaging/stop-installed-runtime.ps1'), '-InstallRoot', installRoot, '-WaitSeconds', '3'], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
}

test('upgrade can overwrite a running bundled node.exe even when its PID file is missing', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { installRoot, startRuntime } = await fixture(t);
  const owned = await startRuntime(installRoot);
  const unrelated = await startRuntime(`${installRoot}-other`);
  fs.mkdirSync(path.join(installRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'data/mvp.db'), 'existing customer data');
  fs.writeFileSync(path.join(installRoot, '.env'), 'ADMIN_PASSWORD=existing-password\n');
  fs.mkdirSync(path.join(installRoot, 'logs'), { recursive: true });
  // A stale PID file must not authorize stopping an unrelated process.
  fs.writeFileSync(path.join(installRoot, 'logs/agent.pid'), `${unrelated.child.pid}`);
  assert.throws(() => fs.openSync(owned.executable, 'r+'), { code: 'EBUSY' });

  const result = prepareForOverwrite(installRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotThrow(() => fs.closeSync(fs.openSync(owned.executable, 'r+')), 'installer must release node.exe before overwriting it');
  assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0), 'a different installation must remain running');
  assert.equal(fs.readFileSync(path.join(installRoot, 'data/mvp.db'), 'utf8'), 'existing customer data');
  assert.equal(fs.readFileSync(path.join(installRoot, '.env'), 'utf8'), 'ADMIN_PASSWORD=existing-password\n');
});

test('installer refuses to continue if runtime files are not writable after services stop', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { installRoot } = await fixture(t);
  fs.mkdirSync(path.join(installRoot, 'runtime'), { recursive: true });
  const executable = path.join(installRoot, 'runtime/node.exe');
  fs.copyFileSync(process.execPath, executable);
  // A read-only target models a write failure that stopping services cannot fix.
  assert.equal(spawnSync('attrib.exe', ['+R', executable], { windowsHide: true }).status, 0);
  try {
    const result = prepareForOverwrite(installRoot);
    assert.notEqual(result.status, 0, 'preflight must abort instead of proceeding to a partial install');
    assert.match(result.stdout + result.stderr, /NOT_WRITABLE/);
    assert.equal(fs.statSync(executable).size, fs.statSync(process.execPath).size, 'preflight must not truncate a runtime file');
  } finally {
    spawnSync('attrib.exe', ['-R', executable], { windowsHide: true });
  }
});

test('reinstall after keeping data during uninstall accepts the preserved installation', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { installRoot } = await fixture(t);
  fs.mkdirSync(path.join(installRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'data/mvp.db'), 'preserved database');
  fs.writeFileSync(path.join(installRoot, '.env'), 'ADMIN_PASSWORD=preserved-password\n');
  const result = prepareForOverwrite(installRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(path.join(installRoot, 'data/mvp.db'), 'utf8'), 'preserved database');
  assert.equal(fs.readFileSync(path.join(installRoot, '.env'), 'utf8'), 'ADMIN_PASSWORD=preserved-password\n');
});

test('first installation accepts both an absent and an empty destination directory', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const { installRoot } = await fixture(t);
  assert.equal(prepareForOverwrite(installRoot).status, 0);
  fs.mkdirSync(installRoot);
  const result = prepareForOverwrite(installRoot);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
