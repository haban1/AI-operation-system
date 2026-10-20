import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageReplyCsv, messageReplyExportFilename, messageReplyExportRows } from '../src/services/message-export.js';

test('reply export contains completed AI and manual reply records', () => {
  const rows = messageReplyExportRows([
    { id: 1, platform_code: 'douyin', platform_name: '抖音', account_name: '账号A', message_type: 'COMMENT', user_name: '用户甲', content: '怎么报名？', status: 'AUTO_REPLIED', reply_text: '请私信报名。', handled_at: '2026-08-19T04:00:00.000Z', handled_by: 'AI_RPA', post_title: '活动视频' },
    { id: 2, platform_code: 'wechat_channels', platform_name: '视频号', account_name: '账号B', message_type: 'PRIVATE_MESSAGE', user_name: '用户乙', content: '谢谢', status: 'MANUAL_HANDLED', handled_at: '2026-08-19T05:00:00.000Z', handled_by: '运营人员', handler_note: '已在App回复' },
    { id: 3, platform_code: 'douyin', platform_name: '抖音', account_name: '账号A', message_type: 'COMMENT', user_name: '用户丙', content: '还没回复', status: 'NEW' },
    { id: 4, platform_code: 'douyin', platform_name: '抖音', account_name: '账号A', message_type: 'COMMENT', user_name: '已删除用户', content: '已删除回复记录', status: 'AUTO_REPLIED', reply_text: '不应导出', handled_at: '2026-08-19T06:00:00.000Z', handled_by: 'AI_RPA', deleted_at: '2026-08-20T01:00:00.000Z' },
    { id: 5, platform_code: 'douyin', platform_name: '抖音', account_name: '账号A', message_type: 'COMMENT', user_name: '账号A', content: '己方发出的回复', status: 'IGNORED_SELF', decision: 'SELF_MESSAGE', handled_at: '2026-08-19T06:30:00.000Z', handled_by: 'PLATFORM_DETECTED' }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][7], 'AI自动回复');
  assert.equal(rows[1][3], '私信');
  assert.equal(rows[1][4], '私信会话');
  assert.equal(rows.some(row => row[0] === 4), false);
  assert.equal(rows.some(row => row[0] === 5), false);
});

test('reply export CSV is Excel friendly and blocks formula injection', () => {
  const csv = buildMessageReplyCsv([{ id: 9, platform_name: '抖音', account_name: '账号', message_type: 'COMMENT', user_name: '=危险公式', content: '第一行\n第二行', status: 'AUTO_REPLIED', reply_text: '正常回复', handled_at: '2026-08-19T04:00:00.000Z', handled_by: 'AI_RPA' }]);
  assert.ok(csv.startsWith('\uFEFF"记录编号"'));
  assert.match(csv, /"'=危险公式"/);
  assert.match(csv, /"第一行\n第二行"/);
  assert.match(csv, /"2026-08-19 12:00:00"/);
});

test('reply export filename uses a readable timestamp', () => {
  assert.equal(messageReplyExportFilename(new Date('2026-08-19T04:05:06.000Z')), '平台回复记录-20260819-120506.csv');
});
