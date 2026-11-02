import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const timers = source.slice(source.indexOf('let refreshTimer=null;'), source.indexOf('function clearWorkspaceSession()'));

function fixture(tagName = 'SELECT') {
  const state = { page: 'messages' };
  const document = { activeElement: { tagName }, hidden: false, querySelector: () => null };
  const calls = [];
  const context = vm.createContext({ state, document, Date,
    $: () => ({ contains: () => true }),
    capturePageOwner: () => ({ page: state.page }),
    ownsPageOwner: owner => owner.page === state.page,
    api: async () => { calls.push('fetch'); return { messages: [{ id: 66, content: '自动采集的新私信' }] }; },
    messageRefreshSignature: data => JSON.stringify(data),
    renderMessages: async data => { calls.push(data.messages[0].content); }
  });
  vm.runInContext(timers, context);
  return { context, state, document, calls };
}

test('account or interval select focus does not freeze automatic arrival of new messages', async () => {
  const { context, calls } = fixture();
  await context.refreshMessagesFromTimer();
  assert.deepEqual(calls, ['fetch', '自动采集的新私信']);
});

test('typing and confirmation dialogs still protect input from background rendering', async () => {
  for (const tag of ['INPUT', 'TEXTAREA']) {
    const { context, calls } = fixture(tag);
    await context.refreshMessagesFromTimer();
    assert.deepEqual(calls, []);
  }
  const { context, document, calls } = fixture();
  document.querySelector = () => ({});
  await context.refreshMessagesFromTimer();
  assert.deepEqual(calls, []);
});

test('late refresh cannot overwrite a page navigated away from while waiting for HTTP', async () => {
  const { context, state, calls } = fixture();
  context.api = async () => { state.page = 'tasks'; return { messages: [] }; };
  await context.refreshMessagesFromTimer();
  assert.deepEqual(calls, []);
});

test('typing begun during a refresh request is also preserved', async () => {
  const { context, document, calls } = fixture();
  context.api = async () => { document.activeElement = { tagName: 'TEXTAREA' }; return { messages: [] }; };
  await context.refreshMessagesFromTimer();
  assert.deepEqual(calls, []);
});
