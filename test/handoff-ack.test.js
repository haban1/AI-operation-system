import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffAckText, isWithinServiceHours, parseServiceHours } from '../src/services/handoff-ack.js';

test('转人工回执：用户主动要求与系统判断分别说明，不承诺具体回复时间', () => {
  assert.match(handoffAckText({ kind: 'REQUESTED' }), /已经帮你联系人工同事/);
  assert.match(handoffAckText({ kind: 'SYSTEM' }), /请人工同事来帮你看看/);
  assert.match(handoffAckText({ kind: 'REQUESTED', script: 'traditional' }), /聯繫人工同事/);
  assert.match(handoffAckText({ kind: 'COMPLAINT' }), /非常抱歉.*跟进处理/);
  for (const text of [handoffAckText(), handoffAckText({ kind: 'SYSTEM' })]) assert.doesNotMatch(text, /\d+\s*分钟|马上|立刻/);
});

test('工作时间：区间内不追加说明，区间外说明非工作时间，支持跨午夜，格式无效视为不限制', () => {
  // 2026-11-23 10:00 / 20:00 / 01:00 Asia/Shanghai
  const morning = new Date('2026-11-23T02:00:00Z');
  const evening = new Date('2026-11-23T12:00:00Z');
  const lateNight = new Date('2026-11-22T17:00:00Z');
  assert.equal(isWithinServiceHours('09:00-18:00', { at: morning }), true);
  assert.equal(isWithinServiceHours('09:00-18:00', { at: evening }), false);
  assert.equal(isWithinServiceHours('20:00-02:00', { at: lateNight }), true);
  assert.equal(isWithinServiceHours('20:00-02:00', { at: morning }), false);
  assert.equal(parseServiceHours('乱写'), null);
  assert.equal(isWithinServiceHours('乱写', { at: evening }), true);
  assert.doesNotMatch(handoffAckText({ serviceHours: '09:00-18:00', at: morning }), /非工作时间/);
  assert.match(handoffAckText({ serviceHours: '09:00-18:00', at: evening }), /非工作时间（09:00-18:00）/);
});

test('转人工回执：英文用户收到英文回执，且不说成已有人在处理', () => {
  assert.match(handoffAckText({ kind: 'REQUESTED', script: 'english' }), /passed this on to a colleague/);
  assert.match(handoffAckText({ kind: 'COMPLAINT', script: 'english' }), /sorry/i);
  assert.match(handoffAckText({ kind: 'REQUESTED' }), /接手后会直接在这里回复你/);
});
