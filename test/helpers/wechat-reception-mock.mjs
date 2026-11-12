// Isolated manual UI regression fixture. Never proxies requests to WeChat.
// node test/helpers/wechat-reception-mock.mjs <frontend-dist> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'wechat-assistant/wechat-robot-admin-frontend/dist');
if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error('Build the candidate frontend first');
const port = Number(process.argv[3] || 3197);
const robot = { id: 1, wechat_id: 'wxid_mock_robot', nickname: '测试微信', status: 'online' };
const friends = [
  { wechat_id: 'wxid_mock_a', nickname: '测试客户甲' },
  { wechat_id: 'wxid_mock_b', nickname: '测试客户乙' },
  { wechat_id: 'mock@chatroom', nickname: '测试交流群' },
];
const reception = (peer, room = '') => ({
  key: room ? `${room}:${peer}` : peer, peer, room, reason: '模拟转人工通知',
  last_message: '需要人工帮助', started_at: 1794470400, updated_at: 1794470400,
});
let receptions = [reception(friends[0].wechat_id), reception(friends[1].wechat_id), reception(friends[0].wechat_id, 'mock@chatroom')];
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lGkAAAAASUVORK5CYII=', 'base64');
const history = Object.fromEntries(friends.map((friend, index) => [friend.wechat_id, [{
  id: index * 10 + 1, type: 1, content: `这是${friend.nickname}的模拟消息`,
  sender_wxid: index === 2 ? friends[0].wechat_id : friend.wechat_id,
  sender_nickname: index === 2 ? friends[0].nickname : friend.nickname,
  is_chat_room: index === 2, created_at: 1794470400,
}, ...(index === 0 ? [{ id: 2, type: 3, sender_wxid: friend.wechat_id, created_at: 1794470401,
  attachment_url: '/mock-image.png', display_full_content: '模拟图片' }] : [])]]));
const state = { requests: [], sends: [], transitions: [], failText: false, failImage: false, delay: 0 };
let sequence = 100;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  const ok = data => json({ code: 200, data });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (url.pathname === '/_test/state') return ok({ ...state, receptions, robot });
  if (url.pathname === '/_test/config' && req.method === 'POST') {
    const config = JSON.parse(body.toString() || '{}');
    for (const key of ['failText', 'failImage', 'delay']) if (key in config) state[key] = config[key];
    if ('online' in config) robot.status = config.online ? 'online' : 'offline';
    return ok({ configured: true });
  }
  if (url.pathname === '/mock-image.png') { res.setHeader('Content-Type', 'image/png'); return res.end(image); }
  if (url.pathname.startsWith('/wechat-workbench/api/v1/')) {
    const route = url.pathname.slice('/wechat-workbench/api/v1'.length);
    state.requests.push({ method: req.method, route, contact: url.searchParams.get('contact_id') });
    if (route === '/user/self') return ok({ id: 1, nickname: '模拟操作员' });
    if (route === '/robot/list') return ok({ items: [robot], total: 1 });
    if (route === '/robot/view') return ok(robot);
    if (route === '/support' && req.method === 'GET') return ok({
      settings: { notifier: '', knowledge_codes: [] }, friends, receptions, broadcasts: [], categories: [],
    });
    if (route === '/chat/history') {
      const all = history[url.searchParams.get('contact_id')] || [];
      return ok({ items: [...all].reverse(), total: all.length });
    }
    if (route === '/chat-room/members' || route === '/contact/list') return ok({ items: friends, total: friends.length });
    if (route === '/support/reception') {
      const change = JSON.parse(body.toString());
      state.transitions.push(change);
      const item = reception(change.peer, change.room);
      receptions = receptions.filter(row => row.key !== item.key);
      if (change.active) receptions.push(item);
      return ok({});
    }
    if (route === '/message/send/text' || route === '/message/send/image') {
      const isImage = route.endsWith('/image');
      const payload = isImage ? Object.fromEntries(await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()) : JSON.parse(body.toString());
      const send = { kind: isImage ? 'image' : 'text', to: payload.to_wxid, content: isImage ? payload.image.name : payload.content };
      state.sends.push(send);
      if (state.delay) await new Promise(resolve => setTimeout(resolve, Math.min(state.delay, 10000)));
      if (isImage ? state.failImage : state.failText) { send.confirmed = false; return json({ code: 500, message: '模拟发送失败' }); }
      send.confirmed = true;
      (history[send.to] ||= []).push({ id: sequence++, type: isImage ? 3 : 1, content: isImage ? '' : send.content,
        attachment_url: isImage ? '/mock-image.png' : undefined, sender_wxid: robot.wechat_id,
        created_at: Math.floor(Date.now() / 1000) });
      return ok({});
    }
    return json({ code: 404, message: `Unmocked route: ${route}` });
  }
  if (req.method !== 'GET') { res.statusCode = 405; return res.end(); }
  const relative = url.pathname.replace(/^\/wechat-workbench\/?/, '').replace(/^\/+/, '');
  const target = path.resolve(root, relative || 'index.html');
  if (target !== root && !target.startsWith(root + path.sep)) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' })[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Isolated WeChat reception fixture: http://127.0.0.1:${port}/wechat-workbench/`));
