import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BusinessBrowserRouter } from '../agent/browser-control/business-router.js';
import { BilibiliAssistedRpaAdapter } from '../agent/rpa-adapters/bilibili-assisted.js';
import { DouyinAssistedRpaAdapter } from '../agent/rpa-adapters/douyin-assisted.js';
import { resolveRpaAdapter } from '../agent/rpa-adapters/registry.js';
import { WechatChannelsAssistedRpaAdapter } from '../agent/rpa-adapters/wechat-channels-assisted.js';
import { WeiboAssistedRpaAdapter } from '../agent/rpa-adapters/weibo-assisted.js';
import {
  PLATFORM_PUBLISH_VERIFICATION_POLICIES,
  publishVerificationPolicy,
  shouldScheduleUnconfirmedPublishVerification,
  validatePlatformResultProvenance,
  validatePublishTargetIdentity
} from '../src/services/publish-verification-policy.js';

test('publish target identity requires platform, task and account to match the stored target', () => {
  const target = { task_id: 12, account_id: 8, platform_code: 'bilibili' };
  assert.equal(validatePublishTargetIdentity({ taskId: 12, accountId: 8, platformCode: 'bilibili' }, target).ok, true);
  assert.equal(validatePublishTargetIdentity({ taskId: 12, accountId: 8, platformCode: 'douyin' }, target).reason, 'PLATFORM_CODE_MISMATCH');
  assert.equal(validatePublishTargetIdentity({ taskId: 13, accountId: 8, platformCode: 'bilibili' }, target).reason, 'TASK_ID_MISMATCH');
  assert.equal(validatePublishTargetIdentity({ taskId: 12, accountId: 9, platformCode: 'bilibili' }, target).reason, 'ACCOUNT_ID_MISMATCH');
});

test('Bilibili unconfirmed final submission schedules read-only verification only for Bilibili', () => {
  const result = {
    platformCode: 'bilibili',
    stage: 'publish_unconfirmed',
    submitAttempted: true,
    finalActionAuthorized: true,
    submissionStatus: 'UNKNOWN'
  };
  const target = { platform_code: 'bilibili', submit_lock: 'LOCKED' };
  assert.equal(shouldScheduleUnconfirmedPublishVerification({ platformCode: 'bilibili', outerStatus: 'NEEDS_CONFIRMATION', result, target }), true);
  for (const platformCode of ['douyin', 'wechat_channels', 'xiaohongshu', 'weibo']) {
    assert.equal(shouldScheduleUnconfirmedPublishVerification({ platformCode, outerStatus: 'NEEDS_CONFIRMATION', result: { ...result, platformCode }, target: { ...target, platform_code: platformCode } }), false, platformCode);
  }
  assert.equal(shouldScheduleUnconfirmedPublishVerification({ platformCode: 'bilibili', outerStatus: 'NEEDS_CONFIRMATION', result: { ...result, uploadFailed: true }, target }), false);
  assert.equal(shouldScheduleUnconfirmedPublishVerification({ platformCode: 'bilibili', outerStatus: 'NEEDS_CONFIRMATION', result: { ...result, finalActionAuthorized: false }, target }), false);
  assert.equal(shouldScheduleUnconfirmedPublishVerification({ platformCode: 'bilibili', outerStatus: 'NEEDS_CONFIRMATION', result, target: { ...target, submit_lock: 'UNLOCKED' } }), false);
});

test('各平台发布复核证据不能串用其他平台的 URL、状态页或规则', () => {
  const cases = [
    ['bilibili', 'PUBLISHED', '已通过', 'https://www.bilibili.com/video/BV1TEST'],
    ['douyin', 'PUBLISHED', '已发布', 'https://creator.douyin.com/creator-micro/content/manage'],
    ['wechat_channels', 'PUBLISHED', '已发表', 'https://channels.weixin.qq.com/platform/post/list'],
    ['weibo', 'PUBLISHED', '', 'https://weibo.com/7215153159/RdkHah6xI']
  ];
  for (const [platformCode, reviewStatus, matchedTab, platformUrl] of cases) {
    const policy = publishVerificationPolicy(platformCode);
    const valid = validatePlatformResultProvenance(platformCode, {
      platformCode,
      verificationPolicyId: policy.verificationPolicyId,
      reviewStatus,
      matchedTab,
      matchedRecord: { reviewStatus },
      platformUrl
    });
    assert.equal(valid.ok, true, platformCode);
    const foreignPlatformCode = platformCode === 'weibo' ? 'douyin' : 'weibo';
    assert.equal(validatePlatformResultProvenance(platformCode, { platformCode: foreignPlatformCode, reviewStatus }).reason, 'RESULT_PLATFORM_MISMATCH');
    assert.equal(validatePlatformResultProvenance(platformCode, { platformCode, verificationPolicyId: 'another-platform-policy', reviewStatus }).reason, 'VERIFICATION_POLICY_MISMATCH');
    if (matchedTab) assert.equal(validatePlatformResultProvenance(platformCode, { platformCode, reviewStatus, matchedTab: '未通过' }).reason, 'REVIEW_TAB_STATUS_MISMATCH');
    assert.equal(validatePlatformResultProvenance(platformCode, { platformCode, reviewStatus, platformUrl: 'https://example.com/post/1' }).reason, 'PLATFORM_URL_SCOPE_MISMATCH');
  }
  assert.deepEqual(Object.keys(PLATFORM_PUBLISH_VERIFICATION_POLICIES).sort(), ['bilibili', 'douyin', 'wechat_channels', 'weibo']);
});


test('RPA adapter registry and browser router reject cross-platform execution and result evidence', async () => {
  const wrongAdapterRegistry = new Map([['douyin', { platformCode: 'bilibili' }]]);
  assert.throws(
    () => resolveRpaAdapter(wrongAdapterRegistry, { payload: { platformCode: 'douyin' } }),
    error => error.code === 'RPA_ADAPTER_PLATFORM_MISMATCH'
  );

  const router = new BusinessBrowserRouter({
    adapters: new Map([['douyin', {
      platformCode: 'douyin',
      async execute() {
        return { status: 'SUCCESS', result: { platformCode: 'bilibili', reviewStatus: 'PUBLISHED' } };
      }
    }]])
  });
  await assert.rejects(
    router.execute({ job_type: 'VERIFY_PUBLISH', payload: { platformCode: 'douyin' } }),
    error => error.code === 'RPA_RESULT_PLATFORM_MISMATCH'
  );
});

test('Bilibili、Douyin、WeChat Channels 和 Weibo 各自拥有独立发布复核规则', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-platform-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapters = {
    bilibili: new BilibiliAssistedRpaAdapter({ logsDir: path.join(dir, 'bilibili') }),
    douyin: new DouyinAssistedRpaAdapter({ logsDir: path.join(dir, 'douyin') }),
    wechat_channels: new WechatChannelsAssistedRpaAdapter({ logsDir: path.join(dir, 'wechat_channels') }),
    weibo: new WeiboAssistedRpaAdapter({ logsDir: path.join(dir, 'weibo') })
  };
  const expected = {
    bilibili: {
      policyId: 'bilibili-publish-status-v1',
      ownUrl: 'https://member.bilibili.com/platform/upload-manager/article',
      foreignUrls: ['https://creator.douyin.com/creator-micro/content/manage', 'https://channels.weixin.qq.com/platform/post/list', 'https://weibo.com/7215153159/RdkHah6xI'],
      tabs: [['已通过', 'PUBLISHED'], ['进行中', 'REVIEWING'], ['未通过', 'REJECTED']]
    },
    douyin: {
      policyId: 'douyin-publish-status-v1',
      ownUrl: 'https://creator.douyin.com/creator-micro/content/manage',
      foreignUrls: ['https://member.bilibili.com/platform/upload-manager/article', 'https://channels.weixin.qq.com/platform/post/list', 'https://weibo.com/7215153159/RdkHah6xI'],
      tabs: [['已发布', 'PUBLISHED'], ['审核中', 'REVIEWING'], ['未通过', 'REJECTED']]
    },
    wechat_channels: {
      policyId: 'wechat-channels-publish-status-v1',
      ownUrl: 'https://channels.weixin.qq.com/platform/post/list',
      foreignUrls: ['https://member.bilibili.com/platform/upload-manager/article', 'https://creator.douyin.com/creator-micro/content/manage', 'https://weibo.com/7215153159/RdkHah6xI'],
      tabs: [['已发表', 'PUBLISHED'], ['审核中', 'REVIEWING'], ['未通过', 'REJECTED']]
    },
    weibo: {
      policyId: 'weibo-publish-status-v1',
      ownUrl: 'https://weibo.com/7215153159/RdkHah6xI',
      foreignUrls: ['https://member.bilibili.com/platform/upload-manager/article', 'https://creator.douyin.com/creator-micro/content/manage', 'https://channels.weixin.qq.com/platform/post/list'],
      tabs: []
    }
  };

  for (const [platformCode, adapter] of Object.entries(adapters)) {
    const rule = expected[platformCode];
    assert.equal(adapter.platformCode, platformCode);
    assert.equal(adapter.spec.verificationPolicyId, rule.policyId);
    assert.equal(adapter.spec.verifyPageUrlPattern.test(rule.ownUrl), true);
    for (const foreignUrl of rule.foreignUrls) {
      assert.equal(adapter.spec.verifyPageUrlPattern.test(foreignUrl), false, `${platformCode} must reject ${foreignUrl}`);
    }
    assert.deepEqual((adapter.spec.verifyTabs || []).map(tab => [tab.label, tab.reviewStatus]), rule.tabs);
  }
  assert.equal(new Set(Object.values(adapters).map(adapter => adapter.spec.verificationPolicyId)).size, 4);
});
