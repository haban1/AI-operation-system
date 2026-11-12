import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexPlanner } from '../engines/montage15/src/codex-planner.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'montage-cli-contract-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'fixture-codex.mjs');
  await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli fixture');
  process.exit(0);
}
if (args[0] === 'login') {
  console.log('Logged in using fixture');
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (input.includes('模拟超时') || input.includes('模拟取消')) {
  setInterval(() => {}, 1000);
} else if (input.includes('模拟失败')) {
  console.error('private provider secret');
  process.exit(2);
} else {
  const output = args[args.indexOf('--output-last-message') + 1];
  const schema = args[args.indexOf('--output-schema') + 1];
  await fs.access(schema);
  await fs.writeFile(output, JSON.stringify({ message: '已处理', warnings: [], operations: [] }));
  await fs.writeFile(output + '.args.json', JSON.stringify(args));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
}
`, { mode: 0o700 });
  return { directory, binary };
}

test('CLI adapter uses a structured read-only request and does not expose paths in status', async t => {
  const ctx = await fixture(t);
  const planner = new CodexPlanner({ binary: ctx.binary });
  const status = await planner.status();
  assert.equal(status.available, true);
  assert.doesNotMatch(JSON.stringify(status), /fixture-codex|\/tmp\//);
  const directory = path.join(ctx.directory, 'request');
  const result = await planner.plan({ instruction: '修改标题' }, { directory });
  assert.deepEqual(result, { message: '已处理', warnings: [], operations: [] });
  const args = JSON.parse(await fs.readFile(path.join(directory, 'response.json.args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ephemeral'));
  for (const feature of ['shell_tool', 'apps', 'plugins', 'multi_agent']) {
    assert.equal(args[args.indexOf(feature) - 1], '--disable');
  }
});

test('CLI timeout and cancellation terminate the child and return usable errors', async t => {
  const ctx = await fixture(t);
  const timeout = new CodexPlanner({ binary: ctx.binary, timeoutMs: 100 });
  await assert.rejects(timeout.plan({ instruction: '模拟超时' }, { directory: path.join(ctx.directory, 'timeout') }), { code: 'AI_TIMEOUT' });
  const planner = new CodexPlanner({ binary: ctx.binary });
  await planner.status();
  const controller = new AbortController();
  const task = planner.plan({ instruction: '模拟取消' }, { directory: path.join(ctx.directory, 'cancel'), signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(task, { code: 'AI_CANCELLED' });
  } finally {
    clearTimeout(timer);
  }
});

test('CLI failure and missing installation report status without leaking provider output', async t => {
  const ctx = await fixture(t);
  const planner = new CodexPlanner({ binary: ctx.binary });
  await assert.rejects(planner.plan({ instruction: '模拟失败' }, { directory: path.join(ctx.directory, 'failure') }), error => error.code === 'AI_PROVIDER_FAILED' && !/private|secret/.test(error.message));
  const missing = new CodexPlanner({ binary: path.join(ctx.directory, 'missing') });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.plan({}, { directory: path.join(ctx.directory, 'missing-request') }), { code: 'AI_UNAVAILABLE' });
});
