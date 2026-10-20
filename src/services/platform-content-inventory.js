import { db, now } from '../db.js';

export const PLATFORM_CONTENT_VERIFICATION_STATUSES = Object.freeze([
  'UNVERIFIED',
  'OBSERVED',
  'VERIFIED'
]);

const VERIFICATION_RANK = Object.freeze({
  UNVERIFIED: 0,
  OBSERVED: 1,
  VERIFIED: 2
});

let savepointSequence = 0;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readField(input, ...keys) {
  for (const key of keys) {
    if (own(input, key)) return { present: true, value: input[key] };
  }
  return { present: false, value: undefined };
}

function normalizeRequiredId(value, fieldName, { lowerCase = false } = {}) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object') {
    throw new TypeError(`${fieldName} must be a non-empty text-compatible identifier`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite text-compatible identifier`);
  }
  const normalized = String(value).trim();
  if (!normalized) throw new TypeError(`${fieldName} must not be empty`);
  return lowerCase ? normalized.toLowerCase() : normalized;
}

function normalizeOptionalText(value, fieldName, { nonEmpty = false } = {}) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`${fieldName} must be text or null`);
  }
  const normalized = String(value);
  if (nonEmpty && !normalized.trim()) throw new TypeError(`${fieldName} must be non-empty text or null`);
  return nonEmpty ? normalized.trim() : normalized;
}

function normalizeTimestamp(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${fieldName} must be a valid date-time`);
  return date.toISOString();
}

function normalizeVerificationStatus(value) {
  const status = String(value ?? '').trim().toUpperCase();
  if (!PLATFORM_CONTENT_VERIFICATION_STATUSES.includes(status)) {
    throw new TypeError(`verification_status must be one of ${PLATFORM_CONTENT_VERIFICATION_STATUSES.join(', ')}`);
  }
  return status;
}

function normalizeEvidenceJson(value) {
  if (value === null) return null;
  let evidence = value;
  if (typeof evidence === 'string') {
    try {
      evidence = JSON.parse(evidence);
    } catch {
      throw new TypeError('evidence_json must contain valid JSON');
    }
  }
  let serialized;
  try {
    serialized = JSON.stringify(evidence);
  } catch {
    throw new TypeError('evidence_json must be JSON-serializable');
  }
  if (serialized === undefined) throw new TypeError('evidence_json must be JSON-serializable');
  return serialized;
}

function normalizeMissingCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError('missing_count must be a non-negative safe integer');
  }
  return count;
}

function identityFromInput(input) {
  const platformCode = readField(input, 'platform_code', 'platformCode');
  const accountKey = readField(input, 'platform_account_key', 'platformAccountKey');
  const postId = readField(input, 'platform_post_id', 'platformPostId');
  return {
    platform_code: normalizeRequiredId(platformCode.value, 'platform_code', { lowerCase: true }),
    platform_account_key: normalizeRequiredId(accountKey.value, 'platform_account_key'),
    platform_post_id: normalizeRequiredId(postId.value, 'platform_post_id')
  };
}

function assignOptional(record, input, outputKey, aliases, normalizer) {
  const field = readField(input, ...aliases);
  if (field.present) record[outputKey] = normalizer(field.value, outputKey);
}

/**
 * Pure normalization for observations before persistence. Platform identifiers are
 * always converted to non-empty strings; optional fields remain absent when they
 * were not supplied so an upsert cannot accidentally erase prior evidence.
 */
export function normalizePlatformContentInventoryInput(input, { clock = now } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('platform content inventory input must be an object');
  }

  const observedAtValue = typeof clock === 'function' ? clock() : clock;
  const firstSeen = readField(input, 'first_seen_at', 'firstSeenAt');
  const lastSeen = readField(input, 'last_seen_at', 'lastSeenAt');
  const record = {
    ...identityFromInput(input),
    first_seen_at: normalizeTimestamp(firstSeen.present ? firstSeen.value : (lastSeen.present ? lastSeen.value : observedAtValue), 'first_seen_at'),
    last_seen_at: normalizeTimestamp(lastSeen.present ? lastSeen.value : observedAtValue, 'last_seen_at')
  };

  if (Date.parse(record.last_seen_at) < Date.parse(record.first_seen_at)) {
    throw new TypeError('last_seen_at must not be earlier than first_seen_at');
  }

  assignOptional(record, input, 'title', ['title'], normalizeOptionalText);
  assignOptional(record, input, 'description', ['description'], normalizeOptionalText);
  assignOptional(record, input, 'published_at_raw', ['published_at_raw', 'publishedAtRaw'], normalizeOptionalText);
  assignOptional(record, input, 'opaque_key', ['opaque_key', 'opaqueKey'], (value, fieldName) => normalizeOptionalText(value, fieldName, { nonEmpty: true }));

  const verificationStatus = readField(input, 'verification_status', 'verificationStatus');
  if (verificationStatus.present) record.verification_status = normalizeVerificationStatus(verificationStatus.value);

  const evidenceJson = readField(input, 'evidence_json', 'evidenceJson', 'evidence');
  if (evidenceJson.present) record.evidence_json = normalizeEvidenceJson(evidenceJson.value);

  const missingCount = readField(input, 'missing_count', 'missingCount');
  if (missingCount.present) record.missing_count = normalizeMissingCount(missingCount.value);

  const deletedAt = readField(input, 'deleted_at', 'deletedAt');
  if (deletedAt.present) {
    record.deleted_at = deletedAt.value === null ? null : normalizeTimestamp(deletedAt.value, 'deleted_at');
  }

  return record;
}

function assertSameIdentity(existing, incoming) {
  for (const key of ['platform_code', 'platform_account_key', 'platform_post_id']) {
    if (String(existing[key]) !== String(incoming[key])) {
      throw new TypeError(`inventory identity mismatch for ${key}`);
    }
  }
}

function laterTimestamp(existingValue, incomingValue) {
  const existingTime = Date.parse(existingValue);
  const incomingTime = Date.parse(incomingValue);
  if (!Number.isFinite(existingTime)) return incomingValue;
  if (!Number.isFinite(incomingTime)) return existingValue;
  return incomingTime >= existingTime ? incomingValue : existingValue;
}

/**
 * Pure conflict merger. Identity columns never change. A VERIFIED observation is
 * monotonic: later weaker observations cannot downgrade it or replace its opaque ID.
 */
export function mergePlatformContentInventory(existing, incoming) {
  if (!existing) return { ...incoming };
  assertSameIdentity(existing, incoming);

  const merged = { ...existing };
  for (const key of ['title', 'description', 'published_at_raw', 'evidence_json', 'missing_count', 'deleted_at']) {
    if (own(incoming, key)) merged[key] = incoming[key];
  }

  const existingStatus = normalizeVerificationStatus(existing.verification_status || 'UNVERIFIED');
  const incomingStatus = own(incoming, 'verification_status')
    ? normalizeVerificationStatus(incoming.verification_status)
    : existingStatus;
  const existingRank = VERIFICATION_RANK[existingStatus];
  const incomingRank = VERIFICATION_RANK[incomingStatus];
  merged.verification_status = incomingRank > existingRank ? incomingStatus : existingStatus;

  if (own(incoming, 'opaque_key')) {
    const existingOpaque = existing.opaque_key ?? null;
    const incomingOpaque = incoming.opaque_key ?? null;
    if (existingStatus === 'VERIFIED' && existingOpaque) {
      merged.opaque_key = existingOpaque;
    } else if (existingRank > incomingRank && existingOpaque) {
      merged.opaque_key = existingOpaque;
    } else if (existingStatus === 'VERIFIED' && incomingStatus !== 'VERIFIED') {
      merged.opaque_key = existingOpaque;
    } else {
      merged.opaque_key = incomingOpaque;
    }
  }

  merged.platform_code = existing.platform_code;
  merged.platform_account_key = existing.platform_account_key;
  merged.platform_post_id = existing.platform_post_id;
  merged.first_seen_at = existing.first_seen_at;
  merged.last_seen_at = laterTimestamp(existing.last_seen_at, incoming.last_seen_at);
  merged.missing_count = normalizeMissingCount(merged.missing_count ?? 0);
  return merged;
}

function selectInventoryRow(database, identity) {
  return database.prepare(`
    SELECT * FROM platform_content_inventory
    WHERE platform_code=? AND platform_account_key=? AND platform_post_id=?
  `).get(identity.platform_code, identity.platform_account_key, identity.platform_post_id) || null;
}

function withSavepoint(database, action) {
  const name = `platform_content_inventory_${++savepointSequence}`;
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    database.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { database.exec(`ROLLBACK TO SAVEPOINT ${name}`); } catch {}
    try { database.exec(`RELEASE SAVEPOINT ${name}`); } catch {}
    throw error;
  }
}

/**
 * Sidecar upsert. It only reads/writes platform_content_inventory and is not wired
 * into publishing or reply execution paths.
 */
export function upsertPlatformContentInventory(input, { database = db, clock = now } = {}) {
  const incoming = normalizePlatformContentInventoryInput(input, { clock });
  return withSavepoint(database, () => {
    const insertResult = database.prepare(`
      INSERT INTO platform_content_inventory(
        platform_code,platform_account_key,platform_post_id,title,description,
        published_at_raw,opaque_key,verification_status,evidence_json,
        first_seen_at,last_seen_at,missing_count,deleted_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(platform_code,platform_account_key,platform_post_id) DO NOTHING
    `).run(
      incoming.platform_code,
      incoming.platform_account_key,
      incoming.platform_post_id,
      incoming.title ?? null,
      incoming.description ?? null,
      incoming.published_at_raw ?? null,
      incoming.opaque_key ?? null,
      incoming.verification_status ?? 'UNVERIFIED',
      incoming.evidence_json ?? null,
      incoming.first_seen_at,
      incoming.last_seen_at,
      incoming.missing_count ?? 0,
      incoming.deleted_at ?? null
    );

    if (Number(insertResult.changes) === 0) {
      const existing = selectInventoryRow(database, incoming);
      if (!existing) throw new Error('platform content inventory conflict row disappeared during upsert');
      const merged = mergePlatformContentInventory(existing, incoming);
      database.prepare(`
        UPDATE platform_content_inventory SET
          title=?,description=?,published_at_raw=?,opaque_key=?,verification_status=?,
          evidence_json=?,first_seen_at=?,last_seen_at=?,missing_count=?,deleted_at=?
        WHERE id=?
      `).run(
        merged.title ?? null,
        merged.description ?? null,
        merged.published_at_raw ?? null,
        merged.opaque_key ?? null,
        merged.verification_status,
        merged.evidence_json ?? null,
        merged.first_seen_at,
        merged.last_seen_at,
        merged.missing_count,
        merged.deleted_at ?? null,
        existing.id
      );
    }
    return selectInventoryRow(database, incoming);
  });
}

export function getPlatformContentInventory(identity, { database = db } = {}) {
  return selectInventoryRow(database, identityFromInput(identity));
}

export function listPlatformContentInventory({ platform_code, platformCode, platform_account_key, platformAccountKey }, { database = db } = {}) {
  const identity = {
    platform_code: normalizeRequiredId(platform_code ?? platformCode, 'platform_code', { lowerCase: true }),
    platform_account_key: normalizeRequiredId(platform_account_key ?? platformAccountKey, 'platform_account_key')
  };
  return database.prepare(`
    SELECT * FROM platform_content_inventory
    WHERE platform_code=? AND platform_account_key=?
    ORDER BY last_seen_at DESC,id DESC
  `).all(identity.platform_code, identity.platform_account_key);
}
