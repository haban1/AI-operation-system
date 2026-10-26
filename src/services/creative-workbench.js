import { resolveWorkbenchUrls } from './workbench-urls.js';

const definitions = [
  { id: 'automatic', title: '自动化成片', product: 'AI Signal Studio', urlKey: 'aiSignalStudioUrl', healthKey: 'aiSignalStudioHealthUrl', healthPath: '/api/health' },
  { id: 'editing', title: '素材剪辑', product: 'OpenChatCut', urlKey: 'videoEditingUrl', healthKey: 'videoEditingHealthUrl', healthPath: '/' },
  { id: 'creation', title: 'AIGC 创作', product: 'Toonflow', urlKey: 'aigcCreationUrl', healthKey: 'aigcCreationHealthUrl', healthPath: '/' },
];

function checkHealth(health, healthHost, verifyIdentity) {
  return new Promise(resolve => {
    let settled = false;
    let request;
    const finish = online => {
      if (settled) return;
      settled = true;
      resolve(online);
      request?.destroy();
    };
    try {
      // Container networking chooses the connection target; the browser origin
      // supplies the virtual Host expected by local servers such as Vite.
      const send = health.protocol === 'https:' ? httpsRequest : httpRequest;
      request = send(health, {
        method: 'GET',
        headers: { Host: healthHost, Accept: verifyIdentity ? 'application/json' : 'text/html', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(3000),
      }, response => {
        const successful = response.statusCode >= 200 && response.statusCode < 300;
        // Node's request does not follow redirects. No cookies or authorization
        // are forwarded, and homepage content is unnecessary for availability.
        if (!successful || !verifyIdentity) {
          finish(successful);
          response.destroy();
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 16384) {
            finish(false);
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(data?.ok === true && data?.service === 'AI Signal Studio');
          } catch { finish(false); }
        });
        response.once('error', () => finish(false));
        response.once('aborted', () => finish(false));
      });
      request.once('error', () => finish(false));
      request.end();
    } catch { finish(false); }
  });
}

export async function getCreativeWorkbenchStatus(config = {}) {
  const services = await Promise.all(definitions.map(async definition => {
    const service = { id: definition.id, title: definition.title, product: definition.product, url: '', online: false };
    if (!String(config[definition.urlKey] || '').trim()) return service;
    let health;
    let healthHost;
    try {
      const urls = resolveWorkbenchUrls(config[definition.urlKey], config[definition.healthKey], definition.healthPath, { allowSignalPath: definition.id === 'automatic' });
      health = urls.health;
      healthHost = urls.healthHost;
      service.url = urls.browserUrl;
    } catch { return service; }
    try {
      service.online = await checkHealth(health, healthHost, definition.id === 'automatic');
    } catch { service.online = false; }
    return service;
  }));
  return { checkedAt: new Date().toISOString(), services };
}
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
