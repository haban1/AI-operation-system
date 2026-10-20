import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';
import { openWorkspacePage } from './helpers/runtime.js';

const root = path.resolve(import.meta.dirname, '..');

function installedChromePath() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(base, pathname, options = {}) {
  const response = await fetch(base + pathname, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  return { response, data: await response.json() };
}

async function waitFor(base) {
  for (let index = 0; index < 80; index += 1) {
    try { const response = await fetch(base + '/api/health'); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}


test('运营人员可在知识库内容和转人工说法页签之间切换', { skip: !installedChromePath() }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-handoff-tabs-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: dbPath, AUTH_ENABLED: 'false',
      QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false', WECOM_WEBHOOK_URL: '', RAG_ADMIN_ENABLED: 'false',
      RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_BASE_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let browser = null;
  t.after(async () => {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  browser = await chromium.launch({ headless: true, executablePath: installedChromePath() });
  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const page = await browser.newPage();
  await page.goto(base);
  // 分组工作区导航把知识库的「知识库内容 / 转人工说法」切换放在顶部子导航上
  // （设计稿用 .workspace-nav-v2 .knowledge-section-tabs{display:none} 隐藏了页内页签，避免两套切换并存）。
  const knowledgeTab = key => page.locator(`#workspaceSubnav button[data-workspace-item="${key}"]`);
  await openWorkspacePage(page, 'knowledge');
  await knowledgeTab('handoff-rules').click();
  await page.getByRole('heading', { name: '自定义说法与 AI 相似说法' }).waitFor();
  assert.equal(await knowledgeTab('handoff-rules').getAttribute('aria-current'), 'page');
  assert.equal(await knowledgeTab('documents').getAttribute('aria-current'), 'false');

  await knowledgeTab('documents').click();
  await page.getByRole('heading', { name: '知识文档与发布' }).waitFor();
  assert.equal(await knowledgeTab('documents').getAttribute('aria-current'), 'page');
  assert.equal(await knowledgeTab('handoff-rules').getAttribute('aria-current'), 'false');
});
test('运营人员可维护私信转人工说法，停用和删除后立即失效，评论未命中知识时直接转人工', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-handoff-phrases-'));
  const dbPath = path.join(dir, 'test.db');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: dbPath, AUTH_ENABLED: 'false',
      QWEN_MODE: 'mock', RPA_MODE: 'simulated', AUTO_COLLECT_ENABLED: 'false',
      LOCAL_AGENT_AUTO_START: 'false', WECOM_WEBHOOK_URL: '',
      RAG_FORMAL_ROUTING_ENABLED: 'false', RAG_BASE_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await waitFor(base).catch(error => { throw new Error(`${error.message}\n${stderr}`); });
  const bootstrap = (await request(base, '/api/bootstrap')).data;
  const account = bootstrap.accounts.find(item => item.platform_code === 'douyin');
  assert.ok(account);

  const initial = await request(base, '/api/manual-handoff-phrases');
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.data.phrases, []);
  assert.ok(initial.data.builtinExamples.includes('转人工'));

  const builtinDuplicate = await request(base, '/api/manual-handoff-phrases', { method: 'POST', body: JSON.stringify({ phrase: '帮我转人工' }) });
  assert.equal(builtinDuplicate.response.status, 409);

  const created = await request(base, '/api/manual-handoff-phrases', { method: 'POST', body: JSON.stringify({ phrase: '给我安排专员', createdBy: '集成测试' }) });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.phrase.status, 'ENABLED');
  const phraseId = created.data.phrase.id;

  const duplicate = await request(base, '/api/manual-handoff-phrases', { method: 'POST', body: JSON.stringify({ phrase: '给我，安排专员！' }) });
  assert.equal(duplicate.response.status, 409);

  let aliasTask;
  for (let index = 0; index < 50; index += 1) {
    const taskList = await request(base, '/api/manual-handoff-alias-generation-tasks?limit=50');
    aliasTask = taskList.data.tasks.find(item => Number(item.phrase_id) === Number(phraseId));
    if (['COMPLETED', 'FAILED'].includes(aliasTask?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(aliasTask?.status, 'COMPLETED', JSON.stringify(aliasTask));
  const generatedAliases = await request(base, '/api/manual-handoff-phrases/' + phraseId + '/aliases');
  assert.ok(generatedAliases.data.aliases.length > 0);
  const selectableAlias = generatedAliases.data.aliases.find(item => item.alias_text === '请安排专员联系我');
  assert.ok(selectableAlias);
  assert.equal(selectableAlias.status, 'DISABLED');

  const simulate = async ({ content, suffix, messageType = 'PRIVATE_MESSAGE', conversationId = `handoff-${suffix}` }) => {
    const result = await request(base, '/api/messages/simulate', {
      method: 'POST',
      body: JSON.stringify({
        platformCode: 'douyin', accountId: account.id, messageType, externalId: `custom-handoff-${suffix}`,
        userName: '转人工测试用户', content,
        context: { conversationId, messageId: `custom-handoff-message-${suffix}`, direction: 'incoming', sourceVerified: true, chatTitleVerified: true, previewOnly: false, unreadCount: 1, noteId: 'note-custom-handoff' }
      })
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data.message;
  };

  const assertPendingHandoff = message => {
    assert.equal(message.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
    assert.equal(message.status, 'MANUAL_REQUIRED');
    assert.equal(message.reply_job_id, null);
    assert.ok(!message.reply_text);
    assert.ok(message.manual_handoff_intent_id);
  };

  const privateMatched = await simulate({ content: '给我，安排专员！', suffix: 'private-enabled' });
  assertPendingHandoff(privateMatched);

  const aliasBeforeSelection = await simulate({ content: selectableAlias.alias_text, suffix: 'alias-disabled' });
  assert.notEqual(aliasBeforeSelection.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  const selected = await request(base, '/api/manual-handoff-phrases/' + phraseId + '/aliases/selections', { method: 'POST', body: JSON.stringify({ enabledIds: [selectableAlias.id] }) });
  assert.equal(selected.response.status, 200, JSON.stringify(selected.data));
  assert.equal(selected.data.selection.enabled, 1);
  const aliasMatched = await simulate({ content: selectableAlias.alias_text, suffix: 'alias-enabled' });
  assertPendingHandoff(aliasMatched);

  const disabled = await request(base, `/api/manual-handoff-phrases/${phraseId}/disable`, { method: 'POST', body: JSON.stringify({ updatedBy: '集成测试' }) });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.data.phrase.status, 'DISABLED');
  const privateDisabled = await simulate({ content: '给我安排专员', suffix: 'private-disabled' });
  assert.notEqual(privateDisabled.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  const aliasDisabledWithParent = await simulate({ content: selectableAlias.alias_text, suffix: 'alias-parent-disabled' });
  assert.notEqual(aliasDisabledWithParent.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');

  const enabled = await request(base, `/api/manual-handoff-phrases/${phraseId}/enable`, { method: 'POST', body: JSON.stringify({ updatedBy: '集成测试' }) });
  assert.equal(enabled.data.phrase.status, 'ENABLED');
  const dbBeforeComment = new DatabaseSync(dbPath, { readOnly: true });
  const notificationsBeforeComment = dbBeforeComment.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='KNOWLEDGE_GAP_CONFIRMED'").get().count;
  dbBeforeComment.close();
  const comment = await simulate({ content: '给我安排专员', suffix: 'comment-enabled', messageType: 'COMMENT' });
  assert.equal(comment.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');
  assert.equal(comment.status, 'MANUAL_REQUIRED');
  assert.equal(comment.reply_job_id, null);
  assert.equal(comment.reply_text, null);
  assert.equal(comment.manual_handoff_intent_id, null);
  const dbAfterComment = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(dbAfterComment.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='KNOWLEDGE_GAP_CONFIRMED'").get().count, notificationsBeforeComment);
  assert.equal(dbAfterComment.prepare("SELECT COUNT(*) AS count FROM notifications WHERE type='COMMENT_KNOWLEDGE_GAP' AND message_id=?").get(comment.id).count, 1);
  dbAfterComment.close();

  const updated = await request(base, `/api/manual-handoff-phrases/${phraseId}`, { method: 'PUT', body: JSON.stringify({ phrase: '帮我联系业务专员', updatedBy: '集成测试' }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.phrase.phrase, '帮我联系业务专员');
  const updatedMatched = await simulate({ content: '帮我联系业务专员', suffix: 'private-updated' });
  assertPendingHandoff(updatedMatched);

  const deleted = await request(base, `/api/manual-handoff-phrases/${phraseId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const finalList = await request(base, '/api/manual-handoff-phrases');
  assert.equal(finalList.data.phrases.length, 0);
  const afterDelete = await simulate({ content: '帮我联系业务专员', suffix: 'private-deleted' });
  assert.notEqual(afterDelete.decision, 'HUMAN_FOLLOWUP_NOTIFICATION_PENDING');

  const schemaDb = new DatabaseSync(dbPath, { readOnly: true });
  for (const item of [privateMatched, aliasMatched, updatedMatched, comment]) {
    const conversation = schemaDb.prepare('SELECT handling_mode,human_followup_state FROM conversations WHERE id=?').get(item.conversation_id);
    assert.equal(conversation.handling_mode, 'HANDOFF_PENDING');
    assert.equal(conversation.human_followup_state, 'WAITING');
    assert.equal(schemaDb.prepare("SELECT COUNT(*) AS count FROM agent_jobs WHERE job_type='REPLY' AND CAST(json_extract(payload,'$.messageId') AS INTEGER)=?").get(item.id).count, 0);
    assert.equal(schemaDb.prepare("SELECT COUNT(*) AS count FROM notifications WHERE message_id=?").get(item.id).count, 1);
  }
  assert.equal(schemaDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='manual_handoff_phrases'").get().count, 1);
  assert.equal(schemaDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='manual_handoff_phrase_aliases'").get().count, 1);
  assert.equal(schemaDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='manual_handoff_alias_generation_tasks'").get().count, 1);
  assert.equal(schemaDb.prepare('SELECT COUNT(*) AS count FROM manual_handoff_phrase_aliases').get().count, 0);
  assert.equal(schemaDb.prepare('SELECT COUNT(*) AS count FROM manual_handoff_alias_generation_tasks').get().count, 0);
  schemaDb.close();
});
