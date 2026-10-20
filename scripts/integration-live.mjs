import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const base = 'http://127.0.0.1:3100';
const local = 'http://127.0.0.1:17831';
const material = fileURLToPath(new URL('../sample-material/demo-success.png', import.meta.url));

async function request(url, options = {}, expectedStatus = 200) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json; charset=utf-8', ...(options.headers || {}) } });
  const data = await response.json();
  if (response.status !== expectedStatus) throw new Error(`${url} 预期 ${expectedStatus}，实际 ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(check, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('等待异步任务完成超时');
}

if (!fs.existsSync(material)) throw new Error(`演示素材不存在：${material}`);

const bootstrap = await request(base + '/api/bootstrap');
const account = bootstrap.accounts.find(item => item.platform_code === 'xiaohongshu' && item.login_status === 'READY');
if (!account) throw new Error('没有可用的小红书 READY 账号');

const pre = await request(local + '/precheck', {
  method: 'POST',
  body: JSON.stringify({ materialPath: material, title: 'MVP 联调测试', body: 'MVP 联调正文', platforms: ['xiaohongshu'] })
});
console.log('precheck', pre.precheck.overall, pre.precheck.meta?.name);

const publishBody = {
  title: 'MVP 联调测试', body: 'MVP 联调正文', materialPath: material,
  materialMeta: pre.precheck.meta,
  targets: [{ platformCode: 'xiaohongshu', accountId: account.id }]
};
const rejected = await request(base + '/api/publish/tasks', { method: 'POST', body: JSON.stringify(publishBody) }, 400);
console.log('publish without precheck => rejected:', rejected.message);

const created = await request(base + '/api/publish/tasks', {
  method: 'POST', body: JSON.stringify({ ...publishBody, precheck: pre.precheck })
}, 201);
const finalTask = await waitFor(async () => {
  const tasks = await request(base + '/api/tasks');
  const task = tasks.tasks.find(item => item.id === created.task.id);
  return task && !['QUEUED', 'EXECUTING'].includes(task.status) ? task : null;
});
console.log('publish final', finalTask.status, finalTask.targets.map(item => item.status).join(','));

for (const content of ['社区服务中心几点上班？', '社区有没有粤语课程？', '我要投诉，请转人工处理']) {
  const response = await request(base + '/api/messages/simulate', {
    method: 'POST',
    body: JSON.stringify({ platformCode: 'xiaohongshu', accountId: account.id, messageType: 'COMMENT', userName: '联调用户', content })
  }, 201);
  console.log('message', content, '=>', response.message.decision, response.message.status, response.message.confidence);
}

await waitFor(async () => {
  const messages = await request(base + '/api/messages');
  return messages.messages.some(item => item.content === '社区服务中心几点上班？' && item.status === 'AUTO_REPLIED');
});
console.log('integration live => PASS');

