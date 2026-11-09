import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

function git(args, optional = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (optional) return null;
    throw new Error(error.stderr?.toString().trim() || error.message);
  }
}

try {
  if (process.argv.slice(2).length) throw new Error('用法：在目标 checkout 中执行 node scripts/install-docs-hooks.mjs。');
  const root = git(['rev-parse', '--show-toplevel']);
  const current = git(['config', '--get', 'core.hooksPath'], true);
  if (current && current !== '.githooks') {
    throw new Error(`现有 core.hooksPath=${current}，已保留，未修改配置。请在现有 pre-commit 中调用 node "${root}/scripts/check-docs-as-code.mjs" --staged；在现有 pre-push 中调用 node "${root}/scripts/check-docs-as-code.mjs" --pre-push "$@"，保留其 stdin 和其他钩子逻辑。`);
  }
  if (!current) {
    const hooks = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']));
    const existing = ['pre-commit', 'pre-push'].filter(name => existsSync(path.join(hooks, name)));
    if (existing.length) {
      throw new Error(`默认 hooks 目录 ${hooks} 已有 ${existing.join('、')}，已保留，未切换 hooksPath。请在既有 pre-commit 中调用 node "${root}/scripts/check-docs-as-code.mjs" --staged；在既有 pre-push 中调用 node "${root}/scripts/check-docs-as-code.mjs" --pre-push "$@"，保留其 stdin 和其他钩子逻辑。`);
    }
  }
  for (const file of ['.githooks/pre-commit', '.githooks/pre-push', 'scripts/check-docs-as-code.mjs']) {
    if (!existsSync(path.join(root, file))) throw new Error(`缺少 ${file}，未修改 Git 配置。`);
  }
  if (git(['config', '--local', '--get', 'extensions.worktreeConfig'], true) !== 'true') {
    if (git(['config', '--local', '--get', 'core.worktree'], true) || git(['config', '--local', '--get', 'core.bare'], true) === 'true') {
      throw new Error('当前仓库存在 core.worktree 或 bare 配置。请先按 Git worktree 文档迁移这些配置，再为此 checkout 设置 git config --worktree core.hooksPath .githooks；安装器未修改配置。');
    }
    git(['config', '--local', 'extensions.worktreeConfig', 'true']);
  }
  git(['config', '--worktree', 'core.hooksPath', '.githooks']);
  for (const hook of ['pre-commit', 'pre-push']) chmodSync(path.join(root, '.githooks', hook), 0o755);
  console.log('已将 .githooks 写入当前 checkout 的 worktree 配置；未修改其他 checkout 的 hooksPath。需要 Git、Node.js 和 Git Bash（Windows）。');
  console.log('回退当前 checkout：git config --worktree --unset core.hooksPath；这会恢复继承的默认或已有公共 hooks 配置，不删除钩子文件。');
} catch (error) {
  console.error(`安装文档钩子失败：${error.message}`);
  process.exitCode = 1;
}
