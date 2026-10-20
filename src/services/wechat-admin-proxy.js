import { config } from '../config.js';

export function wechatAdminRoute(method, pathname, search = '') {
  const path = pathname.replace(/^\/api\/wechat/, '');
  if (!pathname.startsWith('/api/wechat/')) return null;
  const allowed = (method === 'GET' && ['/friends', '/handoffs', '/handoff-notifier', '/broadcasts'].includes(path))
    || (method === 'PUT' && path === '/handoff-notifier')
    || (method === 'POST' && path === '/broadcasts')
    || (method === 'POST' && /^\/handoffs\/[a-zA-Z0-9_-]{1,128}\/resume$/.test(path))
    || (method === 'GET' && /^\/broadcasts\/[a-zA-Z0-9_-]{1,128}$/.test(path));
  if (!allowed) return null;
  const params = new URLSearchParams(search);
  if ([...params.keys()].some(key => path !== '/friends' || key !== 'refresh')
      || params.getAll('refresh').length > 1
      || (params.has('refresh') && !['true', 'false'].includes(params.get('refresh')))) return null;
  return '/wechat-robot' + path + (params.size ? '?' + params.toString() : '');
}

export async function proxyWechatAdmin(req, res, url) {
  const respond = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && url.pathname === '/api/wechat/robot-admin' && !url.search) {
    try {
      const address = new URL(config.wechatRobotAdminUrl);
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('Invalid address');
      return respond(200, { url: address.href, ...(config.wechatRobotAdminFollowHost ? { followHost: true } : {}) });
    } catch {
      return respond(503, { ok: false, message: '尚未配置机器人管理后台地址，请设置 WECHAT_ROBOT_ADMIN_URL。' });
    }
  }
  const route = wechatAdminRoute(req.method, url.pathname, url.search);
  if (!route) return respond(404, { ok: false, message: '微信管理接口不存在' });
  return respond(410, { ok: false, message: '此入口已迁移，请刷新页面，在微信机器人管理中使用人工接待和好友群发。' });
}
