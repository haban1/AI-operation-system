import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const policy = 'docs/development/docs-as-code.md';
const handoff = 'docs/development/handoff.md';
const recordPattern = /^docs\/changes\/\d{4}-\d{2}-\d{2}-[^/]+\.md$/;
const requiredSections = ['背景与目标', '变更与影响', '决策与取舍', '验证与证据', '部署与回退', '未完成与下一步', '上下文与关联'];
const zero = /^0+$/;

function git(args, optional = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (optional) return null;
    throw new Error(`Git 命令失败（git ${args.join(' ')}）：${error.stderr?.toString().trim() || error.message}`);
  }
}

function commitId(ref) {
  const result = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], true);
  if (!result) throw new Error(`提交 ${ref} 不存在于本地；请先取得正确的基线后重试。检查器不会自动 fetch。`);
  return result.trim();
}

function exists(tree, file) {
  return git(['cat-file', '-e', tree ? `${tree}:${file}` : `:${file}`], true) !== null;
}

function read(tree, file) {
  return git(['show', tree ? `${tree}:${file}` : `:${file}`]);
}

function names(args) {
  return git(args).split('\0').filter(Boolean);
}

function hasActualText(section) {
  const cleaned = section.replace(/<!--[\s\S]*?-->/g, '');
  return cleaned.split(/\r?\n/).some(line => {
    if (/\b(?:TODO|TBD|TBC)\b|待填写|请填写|在此填写|填写这里|此处填写|替换为|\{\{[^}]*\}\}|<(?!https?:)[^>]*>|【[^】]*】|\[(?:填写|请填写|在此|此处|待填写|占位)[^\]]*\]/i.test(line)) return false;
    const content = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s*)?/, '').replace(/[`*_#]/g, '').trim();
    return /[\p{L}\p{N}]/u.test(content)
      && !/^(?:TODO|TBD|TBC|待填写|待补充|待完成|待验证|请填写|占位(?:符)?)(?:\s*[：:。.!！-]*)?$/i.test(content)
      && !/^(?:填写|请填写|在此填写|填写这里|替换为|此处填写)/.test(content);
  });
}

function validateRecord(content, file) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const headings = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*(```|~~~)/.test(lines[index])) inFence = !inFence;
    const heading = !inFence && /^##\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (heading) headings.push({ title: heading[1].trim(), index });
  }
  const errors = [];
  for (const title of requiredSections) {
    const matches = headings.filter(item => item.title === title);
    if (matches.length !== 1) {
      errors.push(`${file}：二级标题“${title}”必须出现一次。`);
      continue;
    }
    const position = headings.indexOf(matches[0]);
    const end = headings[position + 1]?.index ?? lines.length;
    if (!hasActualText(lines.slice(matches[0].index + 1, end).join('\n'))) {
      errors.push(`${file}：“${title}”缺少实际内容或仍是模板占位。`);
    }
  }
  return errors;
}

function checkSnapshot({ label, tree, parent, changed, nonempty, enforce = false }) {
  if (!nonempty || (!enforce && !exists(tree, policy) && !(parent && exists(parent, policy)))) return { checked: false, errors: [] };
  const errors = [];
  if (!exists(tree, policy)) errors.push(`${label}：缺少已纳入该版本的 ${policy}，不能删除或仅在工作区保留规范。`);
  if (!exists(tree, handoff)) errors.push(`${label}：缺少已纳入该版本的 ${handoff}。`);
  const records = changed.filter(file => recordPattern.test(file));
  if (!records.length) errors.push(`${label}：每个非空提交必须新增或修改 docs/changes/YYYY-MM-DD-<topic>.md；仅工作区未暂存的文档、删除记录不计入。`);
  for (const file of records) errors.push(...validateRecord(read(tree, file), file).map(error => `${label}：${error}`));
  return { checked: true, errors };
}

function checkCommit(ref) {
  const tree = commitId(ref);
  const parent = git(['rev-list', '--parents', '-n', '1', tree]).trim().split(/\s+/)[1];
  const diff = parent ? ['diff', '--no-renames', parent, tree] : ['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', tree];
  return checkSnapshot({
    label: tree.slice(0, 12), tree, parent,
    nonempty: names([...diff, '--name-only', '-z', '--']).length > 0,
    changed: names([...diff, '--name-only', '--diff-filter=AM', '-z', '--'])
  });
}

function rangeCommits(range) {
  const parts = range.split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].startsWith('.')) throw new Error('--range 需要 base..head，且两个提交都必须存在于本地。');
  const base = commitId(parts[0]);
  const head = commitId(parts[1]);
  return git(['rev-list', '--reverse', `${base}..${head}`]).trim().split(/\s+/).filter(Boolean);
}

function pushCommits(input, remote) {
  const commits = new Set();
  for (const line of input.split(/\r?\n/).filter(line => line.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f\d]{40,64}$/i.test(fields[1]) || !/^[a-f\d]{40,64}$/i.test(fields[3])) throw new Error('pre-push 输入应为 local-ref local-sha remote-ref remote-sha。');
    const [, local, , previous] = fields;
    if (zero.test(local)) continue;
    const head = commitId(local);
    let added;
    if (!zero.test(previous)) {
      added = rangeCommits(`${previous}..${head}`);
    } else {
      const tracking = remote
        ? git(['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}/`]).trim().split(/\s+/).filter(Boolean)
        : [];
      added = git(['rev-list', '--reverse', head, ...(tracking.length ? ['--not', ...tracking] : [])]).trim().split(/\s+/).filter(Boolean);
    }
    for (const id of added) commits.add(id);
  }
  return [...commits];
}

function main() {
  const [mode, value, ...extra] = process.argv.slice(2);
  if (mode === '--help') {
    console.log('用法：node scripts/check-docs-as-code.mjs --staged | --commit HEAD | --range base..head | --pre-push [remote-name remote-url]');
    return;
  }
  const results = [];
  if (mode === '--staged' && !value) {
    const parent = git(['rev-parse', '--verify', 'HEAD'], true)?.trim();
    results.push(checkSnapshot({
      label: '暂存区', tree: null, parent, enforce: true,
      nonempty: names(['diff', '--cached', '--name-only', '-z', '--']).length > 0,
      changed: names(['diff', '--cached', '--no-renames', '--name-only', '--diff-filter=AM', '-z', '--'])
    }));
  } else if (mode === '--commit' && value && !extra.length) {
    results.push(checkCommit(value));
  } else if (mode === '--range' && value && !extra.length) {
    results.push(...rangeCommits(value).map(checkCommit));
  } else if (mode === '--pre-push' && extra.length <= 1) {
    results.push(...pushCommits(readFileSync(0, 'utf8'), value).map(checkCommit));
  } else {
    throw new Error('参数无效；使用 --help 查看用法。');
  }
  const errors = results.flatMap(result => result.errors);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Docs as Code 检查通过：检查 ${results.filter(result => result.checked).length} 个采用规范后的非空版本；跳过 ${results.filter(result => !result.checked).length} 个空版本或历史版本。仅验证结构，内容准确性仍需审查。`);
}

try {
  main();
} catch (error) {
  console.error(`Docs as Code 检查失败：\n${error.message}`);
  process.exitCode = 1;
}
