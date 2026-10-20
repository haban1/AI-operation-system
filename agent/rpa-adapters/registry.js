import { SimulatedRpaAdapter } from './simulated.js';
import { XiaohongshuAssistedRpaAdapter } from './xiaohongshu-assisted.js';
import { DouyinAssistedRpaAdapter } from './douyin-assisted.js';
import { WechatChannelsAssistedRpaAdapter } from './wechat-channels-assisted.js';
import { BilibiliAssistedRpaAdapter } from './bilibili-assisted.js';
import { WeiboAssistedRpaAdapter } from './weibo-assisted.js';

export const supportedPlatforms = ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'];
const additionalAssistedPlatforms = supportedPlatforms.filter(code => code !== 'xiaohongshu');
const assistedAdapterFactories = Object.freeze({
  douyin: options => new DouyinAssistedRpaAdapter(options),
  wechat_channels: options => new WechatChannelsAssistedRpaAdapter(options),
  bilibili: options => new BilibiliAssistedRpaAdapter(options),
  weibo: options => new WeiboAssistedRpaAdapter(options)
});

export function createRpaRegistry({ mode, logsDir, xiaohongshu = {}, platforms = {}, browserRuntimeManager = null }) {
  const simulated = new SimulatedRpaAdapter({ logsDir });
  const registry = new Map(supportedPlatforms.map(code => [code, simulated]));
  if (mode === 'simulated') return registry;

  if (mode === 'xiaohongshu_assisted' || mode === 'five_platform_assisted') {
    registry.set('xiaohongshu', new XiaohongshuAssistedRpaAdapter({ logsDir, browserRuntimeManager, ...xiaohongshu }));
  }

  if (mode === 'five_platform_assisted') {
    for (const platformCode of additionalAssistedPlatforms) {
      const options = { platformCode, logsDir, browserRuntimeManager, ...(platforms[platformCode] || {}) };
      const createAdapter = assistedAdapterFactories[platformCode];
      if (!createAdapter) throw new Error(`\u672a\u914d\u7f6e\u5e73\u53f0\u8f85\u52a9\u9002\u914d\u5668\uff1a${platformCode}`);
      registry.set(platformCode, createAdapter(options));
    }
    return registry;
  }

  if (mode === 'xiaohongshu_assisted') return registry;
  throw new Error('RPA_MODE=' + mode + ' 尚未配置；可用值：simulated、xiaohongshu_assisted、five_platform_assisted');
}

export function resolveRpaAdapter(registry, job) {
  const platformCode = job?.payload?.platformCode;
  const adapter = registry.get(platformCode);
  if (!adapter) throw new Error('未注册平台 RPA 适配器：' + (platformCode || 'unknown'));
  if (adapter.platformCode !== platformCode && adapter.platformCode !== 'simulated') {
    const error = new Error(`任务平台 ${platformCode || 'unknown'} 与适配器平台 ${adapter.platformCode || 'unknown'} 不一致，已禁止执行`);
    error.code = 'RPA_ADAPTER_PLATFORM_MISMATCH';
    throw error;
  }
  return adapter;
}
