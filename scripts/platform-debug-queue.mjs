const sequence = ['weibo', 'douyin', 'wechat_channels', 'bilibili'];
const aliases = new Map([
  ['weibo', 'weibo'], ['微博', 'weibo'],
  ['douyin', 'douyin'], ['抖音', 'douyin'],
  ['wechat_channels', 'wechat_channels'], ['wechat-channels', 'wechat_channels'], ['视频号', 'wechat_channels'],
  ['bilibili', 'bilibili'], ['b站', 'bilibili'], ['B站', 'bilibili']
]);
const baseUrl = String(process.env.CLOUD_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');

async function request(pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} -> ${response.status}: ${data.message || text}`);
  return data;
}

function summarize(data) {
  const platforms = data.platforms || [];
  return {
    masterSwitch: data.masterSwitch || null,
    platforms: platforms.map(item => ({
      platformCode: item.code || item.platform_code,
      desiredState: item.desired_state,
      effectiveState: item.effective_state,
      queuedJobs: Number(item.queued_job_count || 0),
      runningJobs: Number(item.running_job_count || 0)
    }))
  };
}

async function status() {
  return summarize(await request('/api/agent/platform-runtime'));
}

async function stopAll() {
  const result = await request('/api/platforms/runtime/stop-all', {
    method: 'POST',
    body: JSON.stringify({ updatedBy: 'Codex 平台调试队列' })
  });
  return { stopped: true, shutdown: result.shutdown, state: await status() };
}

async function selectPlatform(input, { allowQueued = false } = {}) {
  const platformCode = aliases.get(input);
  if (!sequence.includes(platformCode)) throw new Error(`未知平台：${input || '(empty)'}；顺序为 ${sequence.join(' -> ')}`);
  const before = await status();
  const activeRunning = before.platforms.filter(item => item.runningJobs > 0);
  if (activeRunning.length) {
    throw new Error(`仍有运行中任务，禁止切换调试平台：${activeRunning.map(item => `${item.platformCode}=${item.runningJobs}`).join(', ')}`);
  }
  const targetState = before.platforms.find(item => item.platformCode === platformCode);
  if (!allowQueued && Number(targetState?.queuedJobs || 0) > 0) {
    throw new Error(`${platformCode} has ${targetState.queuedJobs} queued job(s); refusing debug selection because enabling the master switch could execute them. Review the queue first or pass --allow-queued explicitly.`);
  }
  await stopAll();
  await request(`/api/platforms/${platformCode}/runtime`, {
    method: 'POST',
    body: JSON.stringify({ enabled: true, updatedBy: `Codex 调试队列 #${sequence.indexOf(platformCode) + 1}` })
  });
  const after = await status();
  const desiredRunning = after.platforms.filter(item => item.desiredState === 'RUNNING');
  if (desiredRunning.length !== 1 || desiredRunning[0].platformCode !== platformCode) {
    throw new Error(`平台隔离校验失败：期望仅 ${platformCode} 为 RUNNING，实际 ${desiredRunning.map(item => item.platformCode).join(', ') || 'none'}`);
  }
  return {
    selected: platformCode,
    queueNumber: sequence.indexOf(platformCode) + 1,
    masterSwitchEnabled: Boolean(after.masterSwitch?.enabled),
    note: after.masterSwitch?.enabled
      ? '平台已进入单平台调试状态'
      : '平台期望状态已选中，但全局总开关仍关闭；在管理页开启全局开关后才能打开浏览器或领取任务',
    state: after
  };
}

const [command = 'status', argument = '', ...flags] = process.argv.slice(2);
let output;
if (command === 'status') output = await status();
else if (command === 'stop-all') output = await stopAll();
else if (command === 'select') output = await selectPlatform(argument, { allowQueued: flags.includes('--allow-queued') });
else throw new Error('用法：node scripts/platform-debug-queue.mjs status|stop-all|select <weibo|douyin|wechat_channels|bilibili> [--allow-queued]');
console.log(JSON.stringify(output, null, 2));
