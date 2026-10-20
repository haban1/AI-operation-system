import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-content-inventory-'));
process.env.DATABASE_PATH = path.join(tempDir, 'inventory.test.db');

const { db } = await import('../src/db.js');
const {
  getPlatformContentInventory,
  listPlatformContentInventory,
  mergePlatformContentInventory,
  normalizePlatformContentInventoryInput,
  upsertPlatformContentInventory
} = await import('../src/services/platform-content-inventory.js');

beforeEach(() => {
  db.exec('DELETE FROM platform_content_inventory');
});

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function directInsert(overrides = {}) {
  const row = {
    platform_code: 'wechat_channels',
    platform_account_key: 'account-1',
    platform_post_id: 'post-1',
    title: 'title',
    description: 'description',
    published_at_raw: '2026-08-18 10:00',
    opaque_key: 'opaque-1',
    verification_status: 'OBSERVED',
    evidence_json: '{"source":"test"}',
    first_seen_at: '2026-08-18T01:00:00.000Z',
    last_seen_at: '2026-08-18T01:00:00.000Z',
    missing_count: 0,
    deleted_at: null,
    ...overrides
  };
  return db.prepare(`
    INSERT INTO platform_content_inventory(
      platform_code,platform_account_key,platform_post_id,title,description,
      published_at_raw,opaque_key,verification_status,evidence_json,
      first_seen_at,last_seen_at,missing_count,deleted_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    row.platform_code,
    row.platform_account_key,
    row.platform_post_id,
    row.title,
    row.description,
    row.published_at_raw,
    row.opaque_key,
    row.verification_status,
    row.evidence_json,
    row.first_seen_at,
    row.last_seen_at,
    row.missing_count,
    row.deleted_at
  );
}

test('统一档案表使用 TEXT 平台标识、三元唯一隔离和数据库约束', () => {
  const columns = new Map(db.prepare('PRAGMA table_info(platform_content_inventory)').all().map(column => [column.name, column]));
  for (const name of ['platform_code', 'platform_account_key', 'platform_post_id', 'opaque_key']) {
    assert.equal(columns.get(name)?.type, 'TEXT');
  }

  const uniqueIndexes = db.prepare('PRAGMA index_list(platform_content_inventory)').all().filter(index => index.unique === 1);
  assert.ok(uniqueIndexes.some(index => {
    const fields = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map(item => item.name);
    return fields.join(',') === 'platform_code,platform_account_key,platform_post_id';
  }));

  directInsert({ platform_code: 123, platform_account_key: 456, platform_post_id: 789, opaque_key: 101112 });
  const storedTypes = db.prepare(`
    SELECT typeof(platform_code) AS platform_code_type,
           typeof(platform_account_key) AS account_key_type,
           typeof(platform_post_id) AS post_id_type,
           typeof(opaque_key) AS opaque_key_type
    FROM platform_content_inventory
  `).get();
  assert.equal(storedTypes.platform_code_type, 'text');
  assert.equal(storedTypes.account_key_type, 'text');
  assert.equal(storedTypes.post_id_type, 'text');
  assert.equal(storedTypes.opaque_key_type, 'text');

  assert.throws(() => directInsert({ platform_post_id: '' }), /CHECK constraint failed/);
  assert.throws(() => directInsert({ platform_post_id: Buffer.from('post') }), /CHECK constraint failed/);
  assert.throws(() => directInsert({ verification_status: 'UNKNOWN' }), /CHECK constraint failed/);
  assert.throws(() => directInsert({ evidence_json: '{invalid' }), /CHECK constraint failed/);
  assert.throws(() => directInsert({ missing_count: -1 }), /CHECK constraint failed/);
});

test('纯函数规范化平台 ID 并对 VERIFIED 身份执行单调保护', () => {
  const normalized = normalizePlatformContentInventoryInput({
    platformCode: 'WECHAT_CHANNELS',
    platformAccountKey: 10001,
    platformPostId: 9007199254740991n,
    opaqueKey: 7788,
    evidence: { locator: 'card-1' },
    verificationStatus: 'verified'
  }, { clock: () => '2026-08-18T02:00:00.000Z' });

  assert.equal(normalized.platform_code, 'wechat_channels');
  assert.equal(normalized.platform_account_key, '10001');
  assert.equal(normalized.platform_post_id, '9007199254740991');
  assert.equal(normalized.opaque_key, '7788');
  assert.equal(normalized.verification_status, 'VERIFIED');
  assert.deepEqual(JSON.parse(normalized.evidence_json), { locator: 'card-1' });
  assert.equal(own(normalized, 'missing_count'), false);

  const merged = mergePlatformContentInventory({
    id: 1,
    ...normalized,
    opaque_key: 'verified-opaque',
    verification_status: 'VERIFIED',
    missing_count: 0
  }, {
    ...normalized,
    opaque_key: 'weaker-opaque',
    verification_status: 'OBSERVED',
    title: 'new title',
    last_seen_at: '2026-08-18T03:00:00.000Z'
  });
  assert.equal(merged.platform_post_id, '9007199254740991');
  assert.equal(merged.opaque_key, 'verified-opaque');
  assert.equal(merged.verification_status, 'VERIFIED');
  assert.equal(merged.title, 'new title');
});

test('旁路 upsert 保存完整作品档案且保持 first_seen_at', () => {
  const inserted = upsertPlatformContentInventory({
    platform_code: 'wechat_channels',
    platform_account_key: 'wx-account-a',
    platform_post_id: 'video-001',
    title: '首条视频',
    description: '作品描述',
    published_at_raw: '2026年8月18日 10:30',
    opaque_key: 'fiber:card:001',
    verification_status: 'OBSERVED',
    evidence_json: { href: '/post/video-001', source: 'sidecar-scan' },
    first_seen_at: '2026-08-18T02:30:00.000Z',
    last_seen_at: '2026-08-18T02:31:00.000Z',
    missing_count: 2,
    deleted_at: '2026-08-18T02:32:00.000Z'
  });

  assert.equal(inserted.title, '首条视频');
  assert.equal(inserted.description, '作品描述');
  assert.equal(inserted.published_at_raw, '2026年8月18日 10:30');
  assert.equal(inserted.opaque_key, 'fiber:card:001');
  assert.equal(inserted.verification_status, 'OBSERVED');
  assert.deepEqual(JSON.parse(inserted.evidence_json), { href: '/post/video-001', source: 'sidecar-scan' });
  assert.equal(inserted.first_seen_at, '2026-08-18T02:30:00.000Z');
  assert.equal(inserted.last_seen_at, '2026-08-18T02:31:00.000Z');
  assert.equal(inserted.missing_count, 2);
  assert.equal(inserted.deleted_at, '2026-08-18T02:32:00.000Z');

  const updated = upsertPlatformContentInventory({
    platform_code: 'wechat_channels',
    platform_account_key: 'wx-account-a',
    platform_post_id: 'video-001',
    title: '更新后的标题',
    last_seen_at: '2026-08-18T03:00:00.000Z',
    deleted_at: null
  }, { clock: () => '2026-08-18T03:00:00.000Z' });

  assert.equal(updated.id, inserted.id);
  assert.equal(updated.title, '更新后的标题');
  assert.equal(updated.description, '作品描述');
  assert.equal(updated.first_seen_at, '2026-08-18T02:30:00.000Z');
  assert.equal(updated.last_seen_at, '2026-08-18T03:00:00.000Z');
  assert.equal(updated.missing_count, 2);
  assert.equal(updated.deleted_at, null);
});

test('相同帖子 ID 在不同平台或账号下独立保存', () => {
  const base = {
    platform_post_id: 'shared-post-id',
    title: 'same external id',
    last_seen_at: '2026-08-18T04:00:00.000Z'
  };
  upsertPlatformContentInventory({ ...base, platform_code: 'wechat_channels', platform_account_key: 'account-a' });
  upsertPlatformContentInventory({ ...base, platform_code: 'wechat_channels', platform_account_key: 'account-b' });
  upsertPlatformContentInventory({ ...base, platform_code: 'douyin', platform_account_key: 'account-a' });

  const count = db.prepare('SELECT COUNT(*) AS count FROM platform_content_inventory').get().count;
  assert.equal(count, 3);
  assert.equal(listPlatformContentInventory({ platformCode: 'wechat_channels', platformAccountKey: 'account-a' }).length, 1);
  assert.equal(getPlatformContentInventory({
    platformCode: 'douyin',
    platformAccountKey: 'account-a',
    platformPostId: 'shared-post-id'
  }).platform_code, 'douyin');
});

test('冲突 upsert 不降级 VERIFIED 状态且不覆盖已验证 opaque ID', () => {
  const verified = upsertPlatformContentInventory({
    platform_code: 'wechat_channels',
    platform_account_key: 'account-a',
    platform_post_id: 'verified-post-id',
    opaque_key: 'verified-opaque-id',
    verification_status: 'VERIFIED',
    evidence_json: { proof: 'stable platform locator' },
    last_seen_at: '2026-08-18T05:00:00.000Z'
  });

  const conflicted = upsertPlatformContentInventory({
    platform_code: 'wechat_channels',
    platform_account_key: 'account-a',
    platform_post_id: 'verified-post-id',
    opaque_key: 'unverified-replacement',
    verification_status: 'UNVERIFIED',
    title: 'fresh metadata remains mergeable',
    missing_count: 1,
    evidence_json: { proof: 'new scan evidence' },
    last_seen_at: '2026-08-18T05:10:00.000Z'
  });

  assert.equal(conflicted.id, verified.id);
  assert.equal(conflicted.platform_post_id, 'verified-post-id');
  assert.equal(conflicted.opaque_key, 'verified-opaque-id');
  assert.equal(conflicted.verification_status, 'VERIFIED');
  assert.equal(conflicted.title, 'fresh metadata remains mergeable');
  assert.equal(conflicted.missing_count, 1);
  assert.deepEqual(JSON.parse(conflicted.evidence_json), { proof: 'new scan evidence' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platform_content_inventory').get().count, 1);
});

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
