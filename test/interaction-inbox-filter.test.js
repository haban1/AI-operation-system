import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/workspace-interactions.js', import.meta.url), 'utf8');
const category = source.slice(source.indexOf('function commentCategory('), source.indexOf('const COMMENT_FILTERS'));
const filter = source.slice(source.indexOf('function applyCommentFilter('), source.indexOf('function selectComment('));

function fixture(key, selected = '1') {
  const messages = [
    { id: 1, status: 'MANUAL_REQUIRED' },
    { id: 2, reply_status: { ai: { replied: true } } },
    { id: 3, handled_at: '2026-11-17T00:00:00Z' }
  ];
  const classes = () => {
    const values = new Set();
    return { toggle: (key, on) => on ? values.add(key) : values.delete(key), contains: key => values.has(key) };
  };
  const cards = messages.map(m => ({ id: String(m.id), classList: classes() }));
  const group = { classList: classes(), querySelectorAll: () => cards };
  const list = {
    querySelector: () => cards[0] || null,
    querySelectorAll: selector => selector === '.comment-post-group' ? [group] : selector.includes(':not(') ? cards.filter(c => !c.classList.contains('v2-filtered-out')) : cards
  };
  const empty = { hidden: true };
  const inbox = { classList: classes(), querySelector: selector => selector === '.v2-inbox-list' ? list : empty, querySelectorAll: () => [] };
  const selections = [];
  const context = vm.createContext({
    PENDING_STATUSES: ['MANUAL_REQUIRED', 'KNOWLEDGE_GAP', 'AI_REPLY_TIMEOUT'],
    latestComments: new Map(messages.map(m => [String(m.id), m])),
    commentFilter: key, selectedCommentId: selected,
    cardMessageId: card => card.id,
    selectComment: (_inbox, id) => selections.push(id)
  });
  vm.runInContext(category + filter, context);
  return { context, inbox, cards, empty, selections };
}

test('切换评论状态时详情跟随可见评论，避免操作已隐藏的旧评论', () => {
  for (const [key, expected] of [['pending', '1'], ['ai', '2'], ['manual', '3']]) {
    const f = fixture(key);
    f.context.applyCommentFilter(f.inbox);
    assert.deepEqual(f.selections, [expected]);
    assert.equal(f.cards.filter(c => !c.classList.contains('v2-filtered-out')).length, 1);
    assert.equal(f.inbox.classList.contains('is-empty'), false);
  }
});

test('全部状态保留当前选中评论', () => {
  const f = fixture('all', '2');
  f.context.applyCommentFilter(f.inbox);
  assert.deepEqual(f.selections, ['2']);
  assert.equal(f.cards.filter(c => !c.classList.contains('v2-filtered-out')).length, 3);
});

test('筛选没有结果时清除详情，显示紧凑空态', () => {
  const f = fixture('manual');
  f.context.latestComments.get('3').handled_at = null;
  f.context.applyCommentFilter(f.inbox);
  assert.deepEqual(f.selections, [null]);
  assert.equal(f.inbox.classList.contains('is-empty'), true);
  assert.equal(f.empty.hidden, false);
});

test('没有任何评论时沿用原同步空态，避免重复提示', () => {
  const f = fixture('all');
  f.cards.splice(0);
  f.context.applyCommentFilter(f.inbox);
  assert.deepEqual(f.selections, [null]);
  assert.equal(f.inbox.classList.contains('is-empty'), true);
  assert.equal(f.empty.hidden, true);
});
