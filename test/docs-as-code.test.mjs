import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const checker = path.join(source, 'scripts/check-docs-as-code.mjs');
const installer = path.join(source, 'scripts/install-docs-hooks.mjs');
const titles = ['背景与目标', '变更与影响', '决策与取舍', '验证与证据', '部署与回退', '未完成与下一步', '上下文与关联'];
const zero = '0'.repeat(40);
const record = (text = '本次修复模拟接口的超时处理，具体行为与复现命令见对应测试。') => `# 变更记录\n\n${titles.map(title => `## ${title}\n\n${text}\n`).join('\n')}`;

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-as-code 路径 '));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Docs Test', GIT_AUTHOR_EMAIL: 'docs-test@example.invalid',
    GIT_COMMITTER_NAME: 'Docs Test', GIT_COMMITTER_EMAIL: 'docs-test@example.invalid'
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  t.after(() => {
    assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content, 'utf8');
  };
  const commit = message => {
    git('add', '--all');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const change = (topic = 'change', text) => write(`docs/changes/2026-11-05-${topic}.md`, record(text));
  const adopt = () => {
    write('docs/development/docs-as-code.md', '# Docs as Code\n');
    write('docs/development/handoff.md', '# 接手入口\n测试隔离仓库。\n');
    change('adopt');
    return commit('docs: adopt policy');
  };
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [checker, ...args], { cwd: root, env, input, encoding: 'utf8' });
    assert.equal(result.error, undefined);
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  return { root, env, git, write, commit, change, adopt, run };
}

test('staged code without a change record fails', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.write('application.js', 'export const ready = true;\n');
  repo.git('add', 'application.js');
  const result = repo.run(['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.output, /每个非空提交/);
});

test('the adoption commit and a code change with a complete staged record pass', t => {
  const repo = fixture(t);
  const adoption = repo.adopt();
  assert.equal(repo.run(['--commit', adoption]).status, 0);
  repo.write('application.js', 'export const ready = true;\n');
  repo.change('code');
  repo.git('add', '--all');
  assert.equal(repo.run(['--staged']).status, 0);
});

test('an unstaged document does not satisfy the index and unstaged repairs do not mask a bad staged record', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.write('application.js', 'export const ready = true;\n');
  repo.git('add', 'application.js');
  repo.change('code');
  assert.equal(repo.run(['--staged']).status, 1);
  repo.change('code', 'TODO');
  repo.git('add', 'docs/changes/2026-11-05-code.md');
  repo.change('code');
  assert.equal(repo.run(['--staged']).status, 1);
});

test('documentation-only changes still include a change record', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.write('README.md', '# 改正启动说明\n');
  repo.git('add', 'README.md');
  assert.equal(repo.run(['--staged']).status, 1);
  repo.change('docs');
  repo.git('add', 'docs/changes/2026-11-05-docs.md');
  assert.equal(repo.run(['--staged']).status, 0);
});

test('all seven sections need content and template placeholders fail', t => {
  const repo = fixture(t);
  repo.adopt();
  for (const placeholder of ['', 'TODO', 'TBD', '待填写', '<填写实际内容>', '<!-- 说明原因 -->', '【填写此项】', '[请填写结果]', '- 结果：TODO', '- 背景：<填写实际内容>']) {
    repo.change('empty', placeholder);
    repo.git('add', '--all');
    const result = repo.run(['--staged']);
    assert.equal(result.status, 1, placeholder);
    assert.match(result.output, /缺少实际内容/);
  }
  repo.write('docs/changes/2026-11-05-empty.md', record().replace('## 决策与取舍', '### 决策与取舍'));
  repo.git('add', '--all');
  assert.match(repo.run(['--staged']).output, /二级标题“决策与取舍”/);
});

test('the actual reusable change-record template is rejected until its instructions are replaced', t => {
  const repo = fixture(t);
  repo.adopt();
  const template = readFileSync(path.join(source, '.agents/skills/docs-as-code-handoff/assets/change-record.md'), 'utf8');
  repo.write('docs/changes/2026-11-05-from-template.md', template);
  repo.git('add', '--all');
  const result = repo.run(['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.output, /缺少实际内容或仍是模板占位/);
});

test('deleted records do not count and handoff must exist in the index', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.git('rm', 'docs/changes/2026-11-05-adopt.md');
  assert.equal(repo.run(['--staged']).status, 1);
  repo.change('replacement');
  repo.git('add', '--all');
  repo.git('rm', 'docs/development/handoff.md');
  repo.write('docs/development/handoff.md', '# Unstaged replacement\n');
  const result = repo.run(['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.output, /缺少已纳入该版本的 docs\/development\/handoff.md/);
});

test('ranges check every introduced commit rather than only the combined diff', t => {
  const repo = fixture(t);
  const base = repo.adopt();
  repo.write('application.js', 'export const ready = true;\n');
  const bad = repo.commit('fix: missing record');
  repo.change('later');
  const head = repo.commit('docs: add later record');
  const result = repo.run(['--range', `${base}..${head}`]);
  assert.equal(result.status, 1);
  assert.match(result.output, new RegExp(bad.slice(0, 12)));
});

test('older commits before policy adoption are skipped, while deleting the policy cannot disable checks', t => {
  const repo = fixture(t);
  repo.write('legacy.js', 'legacy\n');
  const old = repo.commit('legacy root');
  repo.write('legacy.js', 'legacy second change\n');
  repo.commit('legacy second');
  const adoption = repo.adopt();
  assert.equal(repo.run(['--range', `${old}..${adoption}`]).status, 0);
  repo.git('rm', 'docs/development/docs-as-code.md');
  const removed = repo.commit('remove policy without record');
  assert.equal(repo.run(['--commit', removed]).status, 1);
});

test('merge commits are checked against their first parent', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write('feature.js', 'feature\n');
  repo.commit('bad feature commit');
  repo.git('checkout', '-q', 'main');
  repo.write('main.js', 'main\n');
  repo.change('main');
  repo.commit('main change');
  repo.git('merge', '--no-ff', '-q', 'feature', '-m', 'merge feature');
  assert.equal(repo.run(['--commit', 'HEAD']).status, 1);
});

test('missing range bases fail explicitly without fetching', t => {
  const repo = fixture(t);
  repo.adopt();
  const result = repo.run(['--range', `${'1'.repeat(40)}..HEAD`]);
  assert.equal(result.status, 1);
  assert.match(result.output, /不存在于本地/);
  assert.match(result.output, /不会自动 fetch/);
});

test('push updates check introduced commits and do not use unstaged repairs', t => {
  const repo = fixture(t);
  const base = repo.adopt();
  repo.write('application.js', 'changed\n');
  const bad = repo.commit('missing record');
  repo.change('unstaged');
  const line = `refs/heads/main ${bad} refs/heads/main ${base}\n`;
  assert.equal(repo.run(['--pre-push', 'origin', 'unused'], line).status, 1);
  repo.change('fixed');
  const good = repo.commit('record later');
  assert.equal(repo.run(['--pre-push', 'origin', 'unused'], `refs/heads/main ${good} refs/heads/main ${bad}\n`).status, 0);
});

test('new branch pushes exclude existing remote tracking history', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.write('application.js', 'old published change\n');
  const published = repo.commit('published baseline without record');
  repo.git('update-ref', 'refs/remotes/origin/main', published);
  repo.write('application.js', 'new compliant change\n');
  repo.change('new-branch');
  const head = repo.commit('new branch change');
  assert.equal(repo.run(['--pre-push', 'origin', 'unused'], `refs/heads/topic ${head} refs/heads/topic ${zero}\n`).status, 0);
});

test('new branches without tracking refs skip historical commits before adoption', t => {
  const repo = fixture(t);
  repo.write('legacy.js', 'legacy\n');
  repo.commit('legacy root');
  const head = repo.adopt();
  assert.equal(repo.run(['--pre-push', 'origin', 'unused'], `refs/heads/topic ${head} refs/heads/topic ${zero}\n`).status, 0);
});

test('zero-base CI checks all adopted history even if checkout created a tracking ref at HEAD', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.write('application.js', 'missing intermediate documentation\n');
  const bad = repo.commit('undocumented intermediate change');
  repo.change('latest');
  const head = repo.commit('latest documented change');
  repo.git('update-ref', 'refs/remotes/origin/topic', head);
  const result = repo.run(['--pre-push'], `refs/heads/topic ${head} refs/heads/topic ${zero}\n`);
  assert.equal(result.status, 1);
  assert.match(result.output, new RegExp(bad.slice(0, 12)));
});

test('ref deletion is ignored and malformed push input fails', t => {
  const repo = fixture(t);
  const base = repo.adopt();
  assert.equal(repo.run(['--pre-push', 'origin', 'unused'], `(delete) ${zero} refs/heads/topic ${base}\n`).status, 0);
  assert.equal(repo.run(['--pre-push', 'origin', 'unused'], 'malformed input\n').status, 1);
});

test('an empty index passes and a new repository can stage its adoption commit', t => {
  const repo = fixture(t);
  assert.equal(repo.run(['--staged']).status, 0);
  repo.write('docs/development/docs-as-code.md', '# Policy\n');
  repo.write('docs/development/handoff.md', '# Handoff\n');
  repo.change('adopt');
  repo.git('add', '--all');
  assert.equal(repo.run(['--staged']).status, 0);
});

test('staging only code before adoption fails even when policy and documents exist in the working tree', t => {
  const repo = fixture(t);
  repo.write('docs/development/docs-as-code.md', '# Policy only in the working tree\n');
  repo.write('docs/development/handoff.md', '# Handoff only in the working tree\n');
  repo.change('not-staged');
  repo.write('application.js', 'export const ready = true;\n');
  repo.git('add', 'application.js');
  const result = repo.run(['--staged']);
  assert.equal(result.status, 1);
  assert.match(result.output, /缺少已纳入该版本的 docs\/development\/docs-as-code.md/);
  assert.match(result.output, /缺少已纳入该版本的 docs\/development\/handoff.md/);
  assert.match(result.output, /每个非空提交/);
});

test('deleting the policy fails even with a complete staged or committed change record', t => {
  const repo = fixture(t);
  repo.adopt();
  repo.git('rm', 'docs/development/docs-as-code.md');
  repo.change('delete-policy');
  repo.git('add', '--all');
  assert.match(repo.run(['--staged']).output, /缺少已纳入该版本的 docs\/development\/docs-as-code.md/);
  const removed = repo.commit('remove policy with a record');
  const result = repo.run(['--commit', removed]);
  assert.equal(result.status, 1);
  assert.match(result.output, /缺少已纳入该版本的 docs\/development\/docs-as-code.md/);
});

function installFiles(repo) {
  for (const file of ['.githooks/pre-commit', '.githooks/pre-push', 'scripts/check-docs-as-code.mjs']) {
    repo.write(file, readFileSync(path.join(source, file), 'utf8'));
  }
}

test('installer preserves a custom hooksPath and provides integration commands', t => {
  const repo = fixture(t);
  repo.git('config', '--local', 'core.hooksPath', 'custom-hooks');
  const result = spawnSync(process.execPath, [installer], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /已保留/);
  assert.match(result.stderr, /--staged/);
  assert.match(result.stderr, /--pre-push/);
  assert.equal(repo.git('config', '--get', 'core.hooksPath'), 'custom-hooks');
  assert.throws(() => repo.git('config', '--get', 'extensions.worktreeConfig'));
});

test('installer preserves existing default pre-commit and pre-push hooks', t => {
  for (const hook of ['pre-commit', 'pre-push']) {
    const repo = fixture(t);
    installFiles(repo);
    const hookPath = path.join(repo.git('rev-parse', '--git-path', 'hooks'), hook);
    const content = '#!/bin/sh\n# Existing project hook\n';
    repo.write(hookPath, content);
    const result = spawnSync(process.execPath, [installer], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /默认 hooks 目录/);
    assert.match(result.stderr, /已保留，未切换 hooksPath/);
    assert.equal(readFileSync(path.resolve(repo.root, hookPath), 'utf8'), content);
    assert.throws(() => repo.git('config', '--get', 'core.hooksPath'));
    assert.throws(() => repo.git('config', '--get', 'extensions.worktreeConfig'));
  }
});

test('installer enables hooks only for the current checkout and the hook runs the checker', t => {
  const repo = fixture(t);
  repo.adopt();
  const other = path.join(repo.root, 'linked-checkout');
  repo.git('worktree', 'add', '-q', '-b', 'other', other);
  installFiles(repo);
  const result = spawnSync(process.execPath, [installer], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git config --worktree --unset core\.hooksPath/);
  assert.equal(repo.git('config', '--worktree', '--get', 'core.hooksPath'), '.githooks');
  const otherHooks = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: other, env: repo.env, encoding: 'utf8' });
  assert.equal(otherHooks.status, 1);
  repo.write('application.js', 'missing record\n');
  repo.git('add', 'application.js');
  const attempted = spawnSync('git', ['commit', '-m', 'must fail'], { cwd: repo.root, env: repo.env, encoding: 'utf8' });
  assert.equal(attempted.status, 1);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /每个非空提交/);
});
