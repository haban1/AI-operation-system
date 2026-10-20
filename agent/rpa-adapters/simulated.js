import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RpaAdapter } from './base.js';

export class SimulatedRpaAdapter extends RpaAdapter {
  constructor({ logsDir }) {
    super({ platformCode: 'simulated' });
    this.logsDir = logsDir;
    fs.mkdirSync(logsDir, { recursive: true });
  }

  async execute(job) {
    await delay(650);
    const payload = job.payload;
    if (job.job_type === 'DIAGNOSE_ISSUE') return { status: 'SUCCESS', result: { platformCode: payload.platformCode, capturedAt: new Date().toISOString(), safeReadOnly: true, mode: 'READ_ONLY', message: '\u6a21\u62df\u53ea\u8bfb\u8bca\u65ad\u53d6\u8bc1\u5b8c\u6210', pages: (payload.pages || []).map((page, index) => ({ key: page.key, name: page.name, url: page.url, title: page.name, keyText: ['\u6a21\u62df\u9875\u9762\u7a33\u5b9a'], controls: ['\u6a21\u62df\u5173\u952e\u6309\u94ae'], selectorHits: Object.fromEntries((page.selectors || []).map(selector => [selector, true])), structure: { main: 1, button: 1 }, screenshotPath: null, capturedAt: new Date(Date.now() + index).toISOString() })) } };
    if (job.job_type === 'RUN_SMOKE_TEST') return { status: 'CANCELLED', result: { message: '\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u4e0b\u7ebf', safeReadOnly: true } };
    if (job.job_type === 'PUBLISH') return this.publish(payload);
    if (job.job_type === 'REPLY') return this.reply(payload);
    if (job.job_type === 'VERIFY_PUBLISH') {
      const verification = {
        bilibili: { verificationPolicyId: 'bilibili-publish-status-v1', matchedTab: '已通过', platformUrl: 'https://www.bilibili.com/video/BV1SIMULATED/' },
        douyin: { verificationPolicyId: 'douyin-publish-status-v1', matchedTab: '已发布', platformUrl: 'https://creator.douyin.com/creator-micro/content/manage' },
        wechat_channels: { verificationPolicyId: 'wechat-channels-publish-status-v1', matchedTab: '已发表', platformUrl: 'https://channels.weixin.qq.com/platform/post/list' }
      }[payload.platformCode] || {};
      return { status: 'SUCCESS', result: { ...this.evidence(payload, '模拟审核已通过'), ...verification, reviewStatus: 'PUBLISHED' } };
    }
    if (job.job_type === 'COLLECT_MESSAGES') return { status: 'SUCCESS', result: { ...this.evidence(payload, '模拟消息采集完成'), messages: [] } };
    if (job.job_type === 'DETECT_MANUAL_REPLY') return { status: 'SUCCESS', result: { handled: false, message: '模拟未检测到人工回复' } };
    throw new Error(`不支持的 RPA 任务类型：${job.job_type}`);
  }

  publish(payload) {
    const name = path.basename(payload.materialPath || '').toLowerCase();
    if (name.includes('fail')) return { status: 'FAILED', result: this.evidence(payload, '模拟发布失败：素材文件名包含 fail') };
    if (name.includes('confirm')) return { status: 'NEEDS_CONFIRMATION', result: this.evidence(payload, '模拟结果不明确：需要人工到原平台确认') };
    return { status: 'SUCCESS', result: this.evidence(payload, '模拟发布成功') };
  }

  reply(payload) {
    if (String(payload.replyText || '').includes('[FAIL]')) return { status: 'FAILED', result: this.evidence(payload, '模拟回复发送失败') };
    return { status: 'SUCCESS', result: this.evidence(payload, '模拟自动回复成功') };
  }

  evidence(payload, message) {
    const stamp = new Date().toISOString();
    const record = { stamp, message, platformCode: payload.platformCode, profileName: payload.profileName, payload };
    const file = path.join(this.logsDir, `rpa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
    return { message, evidencePath: file, platformCode: payload.platformCode, profileName: payload.profileName, completedAt: stamp };
  }
}
