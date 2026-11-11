import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPublishedDouyinContent } from '../src/services/douyin-published-content-match.js';

const target = { id: 15, platform_code: 'douyin', status: 'PUBLISHED', title: '先建台账，再跑审计', body: 'Trending 快照里总星数约五万二，本周新增约一万四。数字只说明关注度。反过来的用法，是把它当扫描器。', submitted_at: '2026-11-03T07:37:23.107Z' };
const observation = { platformPostId: '7703845128141589796', title: `${target.title} ${target.body}`, publishedAtRaw: '发布于2026年11月03日 15:33', verificationStatus: 'VERIFIED', evidenceJson: { sourceVerified: true } };
test('verified Douyin work enriches exactly one published target by title body and time', () => {
  assert.deepEqual(matchPublishedDouyinContent(observation, [target]), { targetId: 15, platformPostId: observation.platformPostId, platformUrl: `https://www.douyin.com/video/${observation.platformPostId}` });
});
test('unverified, ambiguous, stale and different works cannot link a publish target', () => {
  assert.equal(matchPublishedDouyinContent({ ...observation, verificationStatus: 'OBSERVED' }, [target]), null);
  assert.equal(matchPublishedDouyinContent(observation, [target, { ...target, id: 16 }]), null);
  assert.equal(matchPublishedDouyinContent(observation, [{ ...target, submitted_at: '2026-11-02T07:33:00Z' }]), null);
  assert.equal(matchPublishedDouyinContent(observation, [{ ...target, body: '其他内容'.repeat(20) }]), null);
  assert.equal(matchPublishedDouyinContent(observation, [{ ...target, platform_post_id: '7703845128141589797' }]), null);
  assert.equal(matchPublishedDouyinContent(observation, [{ ...target, status: 'SYNCING' }]), null);
});
