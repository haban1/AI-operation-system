import { config } from '../config.js';
import { checkLocalAgentHealth } from './local-agent-process.js';

// Only platform operations leave the container. Media and AI APIs stay local.
export function usesBrowserAgent(agentPath) {
  return Boolean(config.browserAgentUrl) && agentPath.startsWith('/platforms/');
}

export async function checkBrowserAgentHealth() {
  if (!config.browserAgentUrl) return null;
  const url = new URL(config.browserAgentUrl);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') {
    throw new Error('BROWSER_AGENT_URL 必须是可信执行电脑的 http 地址，不能包含路径或凭据');
  }
  const status = await checkLocalAgentHealth({ host: url.hostname, port: Number(url.port || 80), timeoutMs: 1500 });
  const realBrowser = status.health?.role === 'browser' && status.health?.rpaMode === 'five_platform_assisted';
  return {
    ...status,
    online: status.online && realBrowser,
    message: !status.online ? status.message : realBrowser ? 'Windows Chrome 真实执行端已连接' : '执行端尚未切换到五平台真实模式'
  };
}
