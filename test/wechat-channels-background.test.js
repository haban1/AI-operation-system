import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';
import { tempRuntimeDir, cleanupDir } from './helpers/runtime.js';

const executablePath = process.env.CHROME_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('视频号并发采集各用独立后台标签页，不重用操作员的页面', {skip:!fs.existsSync(executablePath)}, async t => {
  const dir = tempRuntimeDir('channels-background-');
  t.after(() => cleanupDir(dir));
  const context = await chromium.launchPersistentContext(dir, {executablePath, headless:true, viewport:null});
  t.after(() => context.close());
  const adapter = Object.create(WechatChannelsAssistedRpaAdapter.prototype);
  Object.assign(adapter,{spec:{hostHints:['channels.weixin.qq.com']},channelPages:new Map(),ensureContext:async()=>context});
  const interactive = await adapter.getPage({bringToFront:true});
  const [comment, privatePage, analytics] = await Promise.all([
    adapter.getChannelPage('COMMENT'), adapter.getChannelPage('PRIVATE_MESSAGE'), adapter.createBackgroundPage(context)
  ]);
  assert.equal(new Set([interactive, comment, privatePage, analytics]).size,4);
  assert.equal(await adapter.getChannelPage('COMMENT'),comment);
  assert.equal(interactive.url(),'about:blank');
  await analytics.close();
  assert.equal(interactive.isClosed(),false);
});

test('视频号等待安全验证不置前，手动打开仍定位到原页',async()=>{
  const adapter = Object.create(WechatChannelsAssistedRpaAdapter.prototype);
  adapter.platformCode='wechat_channels';
  adapter.evidence=async()=>({});
  adapter.status=async()=>({});
  let fronts=0;
  const page={bringToFront:async()=>{fronts++;},isClosed:()=>false};
  assert.equal((await adapter.waitForManualSecurityVerification(page,{})).status,'NEEDS_CONFIRMATION');
  assert.equal(fronts,0);
  await adapter.openManualAction();
  assert.equal(fronts,1);
});
