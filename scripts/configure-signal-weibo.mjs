// Run locally after configuring the Windows browser Agent. No token is printed.
import fs from 'node:fs';
import path from 'node:path';
import { weiboHotTopicsToken } from '../agent/weibo-hot-topics.js';

const root = path.resolve(import.meta.dirname, '..');
const env = fs.readFileSync(path.join(root, '.env.docker'), 'utf8');
const match = env.match(/^\s*AGENT_SHARED_TOKEN\s*=\s*(.+)$/m);
const shared = match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
if (!shared) throw new Error('.env.docker 未配置浏览器执行端共享密钥');
const target = path.join(root, '.env.signal');
const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
const kept = existing.split(/\r?\n/).filter(line => !/^\s*SIGNAL_WEIBO_AGENT_TOKEN\s*=/.test(line));
fs.writeFileSync(target, kept.join('\n').trimEnd() + '\nSIGNAL_WEIBO_AGENT_TOKEN=' + weiboHotTopicsToken(shared) + '\n', { mode: 0o600 });
console.log('已配置微博只读采集凭据。请重建并更新 signal 服务；执行端更新后需重启。');
