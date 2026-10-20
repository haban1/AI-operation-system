import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = 'http://127.0.0.1:3100';
const local = 'http://127.0.0.1:17831';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] || path.join(root, 'data', 'xiaohongshu-test-result.json');
const material = path.join(root, 'sample-material', 'demo-success.png');

async function request(url, options = {}, expectedStatus = 200) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (response.status !== expectedStatus) throw new Error(`${url} 预期 ${expectedStatus}，实际 ${response.status}: ${text}`);
  return data;
}

async function waitFor(check, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('等待异步任务完成超时');
}

const startedAt = new Date().toISOString();
const bootstrap = await request(`${base}/api/bootstrap`);
const account = bootstrap.accounts.find(item => item.platform_code === 'xiaohongshu' && item.login_status === 'READY');
if (!account) throw new Error('没有可用的小红书 READY 测试账号映射');

const pre = await request(`${local}/precheck`, {
  method: 'POST',
  body: JSON.stringify({
    materialPath: material,
    title: '天河港澳社区 MVP 小红书测试',
    body: '用于验证本地素材预检、任务下发和RPA执行状态回传，不会发布到真实小红书。',
    platforms: ['xiaohongshu']
  })
});

const publish = await request(`${base}/api/publish/tasks`, {
  method: 'POST',
  body: JSON.stringify({
    title: '天河港澳社区 MVP 小红书测试',
    body: '用于验证本地素材预检、任务下发和RPA执行状态回传，不会发布到真实小红书。',
    materialPath: material,
    materialMeta: pre.precheck.meta,
    precheck: pre.precheck,
    targets: [{ platformCode: 'xiaohongshu', accountId: account.id }]
  })
}, 201);

const finalTask = await waitFor(async () => {
  const tasks = await request(`${base}/api/tasks`);
  const item = tasks.tasks.find(task => task.id === publish.task.id);
  return item && !['QUEUED', 'EXECUTING'].includes(item.status) ? item : null;
});

const cases = [
  { type: '知识回复', question: '请问社区服务中心几点上班？', expectedDecision: 'AUTO_REPLY' },
  { type: '知识回复', question: '香港居民能报名社区活动吗？', expectedDecision: 'AUTO_REPLY' },
  { type: '知识回复', question: '这个活动要收费吗？', expectedDecision: 'AUTO_REPLY' },
  { type: '知识回复', question: '最近有粤语班吗？', expectedDecision: 'AUTO_REPLY' },
  { type: '知识回复', question: '活动已经满员了还能报名吗？', expectedDecision: 'AUTO_REPLY' },
  { type: '风险转人工', question: '我要投诉，请转人工处理', expectedDecision: 'MANUAL_RISK' }
];

const results = [];
for (const item of cases) {
  const response = await request(`${base}/api/messages/simulate`, {
    method: 'POST',
    body: JSON.stringify({
      platformCode: 'xiaohongshu', accountId: account.id, messageType: 'COMMENT',
      userName: '小红书MVP测试用户', content: item.question
    })
  }, 201);
  const id = response.message.id;
  const final = await waitFor(async () => {
    const messages = await request(`${base}/api/messages`);
    const message = messages.messages.find(entry => entry.id === id);
    return message && !['NEW', 'REPLY_QUEUED'].includes(message.status) ? message : null;
  });
  results.push({
    ...item,
    messageId: id,
    actualDecision: final.decision,
    status: final.status,
    confidence: final.confidence,
    reply: final.reply_text || '',
    reason: final.reason || '',
    passed: final.decision === item.expectedDecision && (item.expectedDecision !== 'AUTO_REPLY' || final.status === 'AUTO_REPLIED')
  });
}

const report = {
  testName: '小红书通道MVP测试',
  startedAt,
  completedAt: new Date().toISOString(),
  rpaMode: 'simulated',
  notice: '本次测试未连接或操作真实小红书账号，仅验证小红书通道、本地素材预检、任务下发、真实千问回复和RPA模拟执行。',
  account: { id: account.id, displayName: account.display_name, profileName: account.profile_name },
  publish: {
    taskId: finalTask.id,
    precheck: pre.precheck.overall,
    taskStatus: finalTask.status,
    targetStatus: finalTask.targets?.[0]?.status || '',
    evidencePath: finalTask.targets?.[0]?.evidence_path || finalTask.targets?.[0]?.evidencePath || ''
  },
  replyTests: results,
  passed: pre.precheck.overall === 'PASSED' && finalTask.status === 'SUCCESS' && results.every(item => item.passed)
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
