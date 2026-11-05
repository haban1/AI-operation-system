import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reuse the deployed robot identity without printing its credential to the console.
const [container] = JSON.parse(execFileSync('docker', ['inspect', 'wechat-robot-admin-backend'], { encoding: 'utf8' }));
const token = container?.Config?.Env?.find(value => value.startsWith('LOGIN_TOKEN='))?.slice('LOGIN_TOKEN='.length);
if (!token || /[\r\n\0]/.test(token)) throw new Error('微信后台尚未配置有效的 LOGIN_TOKEN');
const target = fileURLToPath(new URL('../.env.wechat-workbench', import.meta.url));
writeFileSync(target, 'WECHAT_ROBOT_ADMIN_LOGIN_TOKEN=' + token + '\n', { mode: 0o600 });
console.log('已将现有微信后台登录凭据写入 .env.wechat-workbench（仅服务端使用，已由 Git 忽略）。');
