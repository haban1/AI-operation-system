import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { DEFAULT_KNOWLEDGE_SUBCATEGORY, PUBLIC_KNOWLEDGE_CATEGORY, SYSTEM_KNOWLEDGE_CATEGORIES, classifyKnowledgeCategory } from './services/knowledge-category.js';
import { acquireInstanceLock } from './services/instance-lock.js';
import { assessCollectedMessageIdentity } from './services/message-sender-identity.js';

const WEIBO_MAIN_ACCOUNT_NAME = '天河港澳社区';
const databaseInitializationWaitMs = Math.max(15_000, Number(config.sqliteBusyTimeoutMs) || 15_000);

function acquireDatabaseInitializationLock() {
  return acquireInstanceLock(`${config.databasePath}.init.lock`, {
    label: 'database initialization',
    waitMs: databaseInitializationWaitMs
  });
}

const databaseOpenLock = acquireDatabaseInitializationLock();
let openedDatabase;
try {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  openedDatabase = new DatabaseSync(config.databasePath);
  openedDatabase.exec(`PRAGMA busy_timeout = ${Math.max(1000, Number(config.sqliteBusyTimeoutMs) || 15000)}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;`);
} finally {
  databaseOpenLock.release();
}
export const db = openedDatabase;

export function now() {
  return new Date().toISOString();
}

export function json(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function initializeDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platforms (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      desired_state TEXT NOT NULL DEFAULT 'RUNNING',
      runtime_updated_at TEXT,
      runtime_updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OFFLINE',
      agent_version TEXT,
      last_heartbeat TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      display_name TEXT NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(id),
      profile_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      login_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publish_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      material_path TEXT NOT NULL,
      material_meta TEXT,
      retry_of_task_id INTEGER REFERENCES publish_tasks(id),
      status TEXT NOT NULL DEFAULT 'QUEUED',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publish_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES publish_tasks(id) ON DELETE CASCADE,
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      status TEXT NOT NULL DEFAULT 'QUEUED',
      result TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_publish_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_key TEXT NOT NULL UNIQUE,
      scheduled_at TEXT NOT NULL,
      scheduled_local_text TEXT NOT NULL,
      timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      title TEXT NOT NULL,
      target_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      publish_task_id INTEGER REFERENCES publish_tasks(id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      triggered_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PUBLISHED',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_subcategory_cache (
      category TEXT NOT NULL,
      subcategory TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY(category, subcategory)
    );
    CREATE TABLE IF NOT EXISTS knowledge_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PREVIEWED',
      total_rows INTEGER NOT NULL DEFAULT 0,
      valid_rows INTEGER NOT NULL DEFAULT 0,
      duplicate_rows INTEGER NOT NULL DEFAULT 0,
      similar_rows INTEGER NOT NULL DEFAULT 0,
      error_rows INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0,
      preview_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      committed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      message_type TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      user_name TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',
      decision TEXT,
      confidence REAL,
      reply_text TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
      normalized_question TEXT NOT NULL,
      suggested_answer TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'ERROR',
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      related_type TEXT,
      related_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_call_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      task_id TEXT,
      source_module TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS material_knowledge_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_sha256 TEXT NOT NULL,
      material_filename TEXT,
      material_path TEXT,
      transcript_hash TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      key_facts_json TEXT NOT NULL DEFAULT '[]',
      faqs_json TEXT NOT NULL DEFAULT '[]',
      uncertain_facts_json TEXT NOT NULL DEFAULT '[]',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      content_markdown TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      generator_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
      rag_document_id TEXT,
      rag_document_version INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_material_knowledge_drafts_status_created
      ON material_knowledge_drafts(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_material_knowledge_drafts_material
      ON material_knowledge_drafts(material_sha256, generator_version, created_at DESC);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL DEFAULT 'WECOM',
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      sent_at TEXT,
      response_json TEXT,
      error_message TEXT
    );
    CREATE TABLE IF NOT EXISTS smoke_test_baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      fingerprint_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      screenshot_paths_json TEXT,
      source_run_id INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      confirmed_by TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS smoke_test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      trigger_type TEXT NOT NULL DEFAULT 'DAILY',
      schedule_bucket TEXT,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      baseline_id INTEGER REFERENCES smoke_test_baselines(id),
      fingerprint_hash TEXT,
      snapshot_json TEXT,
      diff_json TEXT,
      screenshot_paths_json TEXT,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_action TEXT,
      review_note TEXT,
      agent_job_id INTEGER REFERENCES agent_jobs(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id),
      job_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      provider TEXT NOT NULL,
      purpose TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'OPEN',
      managed_tab_id TEXT,
      current_url TEXT,
      last_command_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS browser_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES browser_sessions(id),
      agent_job_id INTEGER REFERENCES agent_jobs(id),
      device_id TEXT NOT NULL REFERENCES devices(id),
      platform_code TEXT NOT NULL REFERENCES platforms(code),
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      provider TEXT NOT NULL,
      action TEXT NOT NULL,
      purpose TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      result_json TEXT,
      error_message TEXT,
      idempotency_key TEXT,
      confirmation_required INTEGER NOT NULL DEFAULT 0,
      confirmed_at TEXT,
      evidence_ref TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_command_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      browser_command_id INTEGER NOT NULL REFERENCES browser_commands(id),
      event_type TEXT NOT NULL,
      status TEXT,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_content_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_code TEXT NOT NULL CHECK(typeof(platform_code) = 'text' AND length(trim(platform_code)) > 0),
      platform_account_key TEXT NOT NULL CHECK(typeof(platform_account_key) = 'text' AND length(trim(platform_account_key)) > 0),
      platform_post_id TEXT NOT NULL CHECK(typeof(platform_post_id) = 'text' AND length(trim(platform_post_id)) > 0),
      title TEXT CHECK(title IS NULL OR typeof(title) = 'text'),
      description TEXT CHECK(description IS NULL OR typeof(description) = 'text'),
      published_at_raw TEXT CHECK(published_at_raw IS NULL OR typeof(published_at_raw) = 'text'),
      opaque_key TEXT CHECK(opaque_key IS NULL OR (typeof(opaque_key) = 'text' AND length(trim(opaque_key)) > 0)),
      verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK(verification_status IN ('UNVERIFIED','OBSERVED','VERIFIED')),
      evidence_json TEXT CHECK(evidence_json IS NULL OR (typeof(evidence_json) = 'text' AND json_valid(evidence_json))),
      first_seen_at TEXT NOT NULL CHECK(typeof(first_seen_at) = 'text' AND length(trim(first_seen_at)) > 0),
      last_seen_at TEXT NOT NULL CHECK(typeof(last_seen_at) = 'text' AND length(trim(last_seen_at)) > 0),
      missing_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(missing_count) = 'integer' AND missing_count >= 0),
      deleted_at TEXT CHECK(deleted_at IS NULL OR (typeof(deleted_at) = 'text' AND length(trim(deleted_at)) > 0)),
      UNIQUE(platform_code, platform_account_key, platform_post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_call_logs_created ON ai_call_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_call_logs_task ON ai_call_logs(task_type,status,id DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_device_status ON agent_jobs(device_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_jobs_platform_status ON agent_jobs(json_extract(payload,'$.platformCode'), status, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_commands_idempotency ON browser_commands(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_browser_commands_device_status ON browser_commands(device_id,status,id);
    CREATE INDEX IF NOT EXISTS idx_browser_commands_session ON browser_commands(session_id,id);
    CREATE INDEX IF NOT EXISTS idx_browser_events_command ON browser_command_events(browser_command_id,id);
    CREATE INDEX IF NOT EXISTS idx_platform_content_inventory_account_seen ON platform_content_inventory(platform_code,platform_account_key,last_seen_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_platform_content_inventory_opaque ON platform_content_inventory(platform_code,platform_account_key,opaque_key) WHERE opaque_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_targets_task ON publish_targets(task_id);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smoke_schedule_bucket ON smoke_test_runs(platform_code,schedule_bucket) WHERE schedule_bucket IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_smoke_runs_platform_status ON smoke_test_runs(platform_code,status,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smoke_baseline_active ON smoke_test_baselines(platform_code) WHERE active=1;
  `);
  migrateSchema();
  migrateMiniProgramChannel();
  migrateMiniProgramChannelIdentity();
  migrateChannelLedgerFoundation();
  migrateChannelReplyBatchRuntime();
  migrateXiaozhiTestDecisions();
  seed();
  migrateWeiboMainAccountName();
  removeLegacySmokeGate();
  activateXiaohongshuPlatform();
  migrateLegacyKnowledgeCategories();
  correctLegacyKnowledgeCategories();
  migrateKnowledgeLibraryScopes();
  seedPlatformKnowledgeIsolationMarkers();
  backfillKnowledgeSubcategoryCache();
  repairLegacySelfReplyEchoes();
}

export function initDb() {
  const initializationLock = acquireDatabaseInitializationLock();
  try {
    return initializeDb();
  } finally {
    initializationLock.release();
  }
}

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(item => item.name));
}

function ensureColumn(table, name, definition) {
  if (!tableColumns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function migrateSchema() {
  db.exec(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL UNIQUE, platform_code TEXT NOT NULL,
    account_id INTEGER NOT NULL, message_type TEXT NOT NULL, external_conversation_key TEXT, user_name TEXT,
    identity_confidence TEXT NOT NULL DEFAULT 'LOW', identity_source TEXT, entry_type TEXT,
    context_enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 0,
    last_incoming_message_id INTEGER, last_message_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
  const additions = {
    devices: { browser_control_json: 'TEXT' },
    platforms: { desired_state: "TEXT NOT NULL DEFAULT 'RUNNING'", runtime_updated_at: 'TEXT', runtime_updated_by: 'TEXT', lifecycle_state: "TEXT NOT NULL DEFAULT 'ACTIVE'", smoke_gate_state: "TEXT NOT NULL DEFAULT 'CLEAR'", smoke_gate_reason: 'TEXT', smoke_gate_run_id: 'INTEGER', smoke_gate_updated_at: 'TEXT' },
    accounts: {
      login_checked_at: 'TEXT', login_message: 'TEXT', login_url: 'TEXT', login_source: 'TEXT', login_evidence: 'TEXT',
      platform_user_id: 'TEXT', platform_user_name: 'TEXT', platform_user_aliases: 'TEXT', identity_updated_at: 'TEXT', identity_source: 'TEXT'
    },
    conversations: { ledger_version: 'INTEGER NOT NULL DEFAULT 0', last_incoming_event_id: 'INTEGER' },
    publish_tasks: {
      idempotency_key: 'TEXT', compliance_json: 'TEXT', compliance_rule_version: 'TEXT', confirmed_at: 'TEXT',
      retry_of_task_id: 'INTEGER REFERENCES publish_tasks(id)'
    },
    publish_targets: {
      submission_status: "TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'", review_status: "TEXT NOT NULL DEFAULT 'UNKNOWN'",
      platform_post_id: 'TEXT', platform_url: 'TEXT', submitted_at: 'TEXT', reviewed_at: 'TEXT',
      last_checked_at: 'TEXT', review_message: 'TEXT', evidence_json: 'TEXT',
      publish_attempt_state: "TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED'",
      submit_lock: "TEXT NOT NULL DEFAULT 'UNLOCKED'", submit_authorized_at: 'TEXT', submit_attempted_at: 'TEXT',
      submit_attempt_count: 'INTEGER NOT NULL DEFAULT 0', submit_lock_reason: 'TEXT', draft_fingerprint: 'TEXT'
    },
    messages: {
      external_url: 'TEXT', parent_external_id: 'TEXT', context_json: 'TEXT', collected_at: 'TEXT',
      handled_at: 'TEXT', handled_by: 'TEXT', handler_note: 'TEXT', knowledge_id: 'INTEGER',
      rule_version: 'TEXT', reply_job_id: 'INTEGER',
      knowledge_question_snapshot: 'TEXT', knowledge_answer_snapshot: 'TEXT',
      manual_handoff_intent_id: 'INTEGER', message_group_id: 'TEXT',
      subquestions_json: 'TEXT', response_mode: 'TEXT',
      conversation_id: 'INTEGER REFERENCES conversations(id)', conversation_key_snapshot: 'TEXT',
      conversation_version: 'INTEGER', identity_confidence: 'TEXT', identity_source: 'TEXT',
      reply_generation_version: 'INTEGER', reply_context_json: 'TEXT',
      wecom_notification_status: "TEXT NOT NULL DEFAULT 'NOT_REQUIRED'", wecom_notification_id: 'INTEGER',
      deleted_at: 'TEXT', deleted_by: 'TEXT', delete_reason: 'TEXT'
    },
    knowledge: {
      source: "TEXT NOT NULL DEFAULT 'MANUAL'", review_status: "TEXT NOT NULL DEFAULT 'APPROVED'",
      reviewed_by: 'TEXT', reviewed_at: 'TEXT', published_at: 'TEXT', category: "TEXT NOT NULL DEFAULT '其他'",
      subcategory: "TEXT NOT NULL DEFAULT '\u672a\u5206\u7c7b'",
      source_file: 'TEXT', import_batch_id: 'INTEGER', match_status: 'TEXT', matched_knowledge_id: 'INTEGER', clean_notes: 'TEXT'
    },
    knowledge_gaps: { review_note: 'TEXT', reviewed_by: 'TEXT', reviewed_at: 'TEXT', resolved_at: 'TEXT', deleted_at: 'TEXT', deleted_by: 'TEXT', delete_reason: 'TEXT' },
    issues: {
      occurrences: 'INTEGER NOT NULL DEFAULT 1', last_seen_at: 'TEXT', screenshot_path: 'TEXT',
      resolution: 'TEXT', assignee: 'TEXT', retryable: 'INTEGER NOT NULL DEFAULT 0',
      resolution_type: 'TEXT', resolved_by: 'TEXT', resolved_at: 'TEXT',
      block_scope: 'TEXT', block_key: 'TEXT', diagnosis_status: 'TEXT',
      diagnosis_summary: 'TEXT', latest_diagnosis_id: 'INTEGER'
    },
    notifications: {
      response_json: 'TEXT', error_message: 'TEXT', conversation_id: 'INTEGER REFERENCES conversations(id)',
      message_id: 'INTEGER REFERENCES messages(id)', idempotency_key: 'TEXT', attempt_count: 'INTEGER NOT NULL DEFAULT 0',
      max_attempts: 'INTEGER NOT NULL DEFAULT 20', available_at: 'TEXT', claimed_at: 'TEXT', lease_expires_at: 'TEXT',
      confirmed_at: 'TEXT', last_attempt_at: 'TEXT', updated_at: 'TEXT', metadata_json: 'TEXT'
    },
    agent_jobs: { idempotency_key: 'TEXT', lease_expires_at: 'TEXT', available_at: 'TEXT', channel_type: 'TEXT', queue_lane: 'TEXT', conversation_namespace: 'TEXT', first_pending_at: 'TEXT', priority: 'INTEGER NOT NULL DEFAULT 100' }
  };
  additions.conversations = {
    ...additions.conversations,
    clarification_attempts: 'INTEGER NOT NULL DEFAULT 0',
    pending_intent_json: 'TEXT',
    handoff_offered_at: 'TEXT',
    wecom_notified_at: 'TEXT',
    human_followup_state: "TEXT NOT NULL DEFAULT 'NONE'",
    handling_mode: "TEXT NOT NULL DEFAULT 'BOT_ACTIVE'",
    handoff_reason: 'TEXT',
    handoff_source_message_id: 'INTEGER REFERENCES messages(id)',
    handoff_requested_at: 'TEXT',
    handoff_confirmed_at: 'TEXT',
    handoff_notification_id: 'INTEGER REFERENCES notifications(id)',
    last_recovery_scan_at: 'TEXT'
  };
  for (const [table, columns] of Object.entries(additions)) {
    for (const [name, definition] of Object.entries(columns)) ensureColumn(table, name, definition);
  }
  run(`UPDATE agent_jobs SET priority=CASE
    WHEN job_type='SCAN_OLD_CONVERSATIONS' OR json_extract(payload,'$.oldConversationScan')=1 OR json_extract(payload,'$.recoveryScan')=1
      OR UPPER(COALESCE(json_extract(payload,'$.scanMode'),json_extract(payload,'$.collectionScope'),json_extract(payload,'$.recoveryMode'),''))
        IN ('OLD_CONVERSATIONS','CONVERSATION_RECOVERY','STALE_CONVERSATION_RECOVERY') THEN 80
    WHEN job_type='REPLY' AND UPPER(COALESCE(channel_type,json_extract(payload,'$.channelType'),json_extract(payload,'$.messageType'),''))='COMMENT' THEN 30
    WHEN job_type='REPLY' THEN 10
    WHEN job_type='DETECT_MANUAL_REPLY' THEN 25
    WHEN job_type='COLLECT_MESSAGES' AND UPPER(COALESCE(channel_type,queue_lane,json_extract(payload,'$.channelType'),json_extract(payload,'$.queueLane'),''))='COMMENT' THEN 40
    WHEN job_type='COLLECT_MESSAGES' THEN 20
    WHEN job_type='PUBLISH' THEN 50
    WHEN job_type IN ('VERIFY_PUBLISH','PUBLISH_STATUS_CHECK') THEN 60
    ELSE COALESCE(priority,100) END`);
  run(`UPDATE notifications SET available_at=COALESCE(available_at,created_at),updated_at=COALESCE(updated_at,created_at),
    confirmed_at=COALESCE(confirmed_at,CASE WHEN status='SENT' THEN sent_at END),
    status=CASE WHEN status='SENT' THEN 'CONFIRMED' ELSE status END`);
  // 旧版 WAITING/NOTIFIED 可能来自未配置 Webhook 的模拟成功，不能据此认定企微已经送达。
  // 只有保存了 CONFIRMED 通知回执（或新版明确写入 handoff_confirmed_at）才迁移为 HUMAN_MANAGED；
  // 其余旧人工状态一律保守迁移为 HANDOFF_PENDING，继续由 Outbox 可靠重试。
  run(`UPDATE conversations SET handling_mode=CASE
    WHEN handoff_confirmed_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM notifications n
      WHERE n.status='CONFIRMED' AND (
        n.id=conversations.handoff_notification_id OR
        (n.conversation_id=conversations.id AND json_extract(COALESCE(n.metadata_json,'{}'),'$.handoff')=1)
      )
    ) THEN 'HUMAN_MANAGED'
    WHEN UPPER(COALESCE(handling_mode,'')) IN ('HANDOFF_PENDING','HUMAN_MANAGED')
      OR UPPER(COALESCE(human_followup_state,'')) IN ('WAITING','NOTIFIED','HUMAN_MANAGED','PENDING','NOTIFY_QUEUED','HANDOFF_PENDING')
      THEN 'HANDOFF_PENDING'
    ELSE 'BOT_ACTIVE' END`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL UNIQUE,
      platform_code TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      message_type TEXT NOT NULL,
      external_conversation_key TEXT,
      user_name TEXT,
      identity_confidence TEXT NOT NULL DEFAULT 'LOW',
      identity_source TEXT,
      entry_type TEXT,
      context_enabled INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      last_incoming_message_id INTEGER,
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_processing_registry (
      identity_key TEXT PRIMARY KEY,
      identity_source TEXT NOT NULL,
      platform_code TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      message_type TEXT NOT NULL,
      canonical_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      canonical_external_id TEXT,
      processing_status TEXT NOT NULL DEFAULT 'SEEN',
      handled_at TEXT,
      handled_by TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT
    );
    CREATE TABLE IF NOT EXISTS platform_collection_cursors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform_code TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      cursor_json TEXT NOT NULL DEFAULT '{}',
      last_success_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(platform_code, account_id, scope)
    );
    CREATE TABLE IF NOT EXISTS issue_diagnoses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      agent_job_id INTEGER REFERENCES agent_jobs(id),
      mode TEXT NOT NULL DEFAULT 'READ_ONLY',
      status TEXT NOT NULL DEFAULT 'QUEUED',
      category TEXT,
      failed_stage TEXT,
      confidence REAL,
      page_changed INTEGER,
      safe_to_retry INTEGER NOT NULL DEFAULT 0,
      suggested_block_scope TEXT,
      summary TEXT,
      evidence_json TEXT,
      recommendations_json TEXT,
      error_message TEXT,
      requested_by TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      scope TEXT NOT NULL,
      block_key TEXT NOT NULL,
      feature TEXT,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      released_at TEXT,
      released_by TEXT,
      release_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS knowledge_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      knowledge_version INTEGER NOT NULL,
      alias_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'AI',
      status TEXT NOT NULL DEFAULT 'ENABLED',
      confidence REAL NOT NULL DEFAULT 1,
      validation_status TEXT NOT NULL DEFAULT 'VALID',
      conflict_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_alias_generation_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      knowledge_version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      requested_by TEXT,
      model TEXT,
      generated_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS semantic_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL DEFAULT 'SYNONYM',
      source_text TEXT NOT NULL,
      target_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ENABLED',
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manual_handoff_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key TEXT NOT NULL,
      platform_code TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      message_type TEXT NOT NULL,
      user_name TEXT,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      request_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'WAITING_USER_CONFIRMATION',
      expires_at TEXT NOT NULL,
      requested_at TEXT,
      notified_at TEXT,
      notification_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manual_handoff_phrases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phrase TEXT NOT NULL,
      normalized_phrase TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'ENABLED' CHECK(status IN ('ENABLED','DISABLED')),
      version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manual_handoff_phrase_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phrase_id INTEGER NOT NULL REFERENCES manual_handoff_phrases(id) ON DELETE CASCADE,
      phrase_version INTEGER NOT NULL DEFAULT 1,
      alias_text TEXT NOT NULL,
      normalized_text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'AI',
      status TEXT NOT NULL DEFAULT 'DISABLED' CHECK(status IN ('ENABLED','DISABLED')),
      confidence REAL NOT NULL DEFAULT 1,
      validation_status TEXT NOT NULL DEFAULT 'VALID' CHECK(validation_status IN ('VALID','CONFLICT','REJECTED')),
      validation_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(phrase_id,phrase_version,normalized_text)
    );
    CREATE TABLE IF NOT EXISTS manual_handoff_alias_generation_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phrase_id INTEGER NOT NULL REFERENCES manual_handoff_phrases(id) ON DELETE CASCADE,
      phrase_version INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','DISCARDED')),
      requested_by TEXT,
      model TEXT,
      generated_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_idempotency ON notifications(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notifications_outbox_claim ON notifications(channel,status,available_at,lease_expires_at,id);
    CREATE INDEX IF NOT EXISTS idx_notifications_conversation ON notifications(conversation_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_handling_mode ON conversations(handling_mode,last_message_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_recovery_scan ON conversations(message_type,handling_mode,last_message_at,last_recovery_scan_at);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_priority_claim ON agent_jobs(device_id,status,priority,available_at,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_blocks_issue_active ON runtime_blocks(issue_id) WHERE status='ACTIVE';
    CREATE INDEX IF NOT EXISTS idx_runtime_blocks_scope_active ON runtime_blocks(scope,block_key,status);
    CREATE INDEX IF NOT EXISTS idx_issue_diagnoses_issue ON issue_diagnoses(issue_id,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_diagnoses_active ON issue_diagnoses(issue_id) WHERE status IN ('QUEUED','RUNNING');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_tasks_idempotency ON publish_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_scheduled_publish_due ON scheduled_publish_tasks(status,scheduled_at,id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_publish_task ON scheduled_publish_tasks(publish_task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_jobs_idempotency ON agent_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_targets_review ON publish_targets(platform_code, review_status, id);
    CREATE INDEX IF NOT EXISTS idx_targets_message_candidates ON publish_targets(platform_code, account_id, submission_status, status, submitted_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_targets_submit_lock ON publish_targets(submit_lock, publish_attempt_state, id);
    CREATE INDEX IF NOT EXISTS idx_messages_external_lookup ON messages(platform_code, account_id, message_type, external_id);
    CREATE INDEX IF NOT EXISTS idx_messages_reply_job ON messages(reply_job_id);
    CREATE INDEX IF NOT EXISTS idx_messages_visible ON messages(deleted_at,id DESC);
    CREATE INDEX IF NOT EXISTS idx_message_processing_scope ON message_processing_registry(platform_code,account_id,message_type,processing_status,last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_processing_canonical ON message_processing_registry(canonical_message_id);
    CREATE INDEX IF NOT EXISTS idx_platform_collection_cursors_scope ON platform_collection_cursors(platform_code,account_id,scope);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,id);
    CREATE INDEX IF NOT EXISTS idx_conversations_scope ON conversations(platform_code,account_id,message_type,updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category_status ON knowledge(category,status,id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_category_subcategory_status ON knowledge(category,subcategory,status,id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_import_batch ON knowledge(import_batch_id,id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_import_batches_status ON knowledge_import_batches(status,id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_subcategory_cache_recent ON knowledge_subcategory_cache(category,last_used_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_alias_unique ON knowledge_aliases(knowledge_id,normalized_text);
    CREATE INDEX IF NOT EXISTS idx_knowledge_alias_lookup ON knowledge_aliases(status,normalized_text,knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_alias_task_status ON knowledge_alias_generation_tasks(status,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_alias_task_active ON knowledge_alias_generation_tasks(knowledge_id,knowledge_version) WHERE status IN ('QUEUED','RUNNING');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_rule_unique ON semantic_rules(rule_type,source_text,target_text);
    CREATE INDEX IF NOT EXISTS idx_manual_handoff_conversation ON manual_handoff_intents(conversation_key,status,expires_at,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_handoff_active ON manual_handoff_intents(conversation_key) WHERE status IN ('WAITING_USER_CONFIRMATION','REQUESTED','NOTIFY_QUEUED');
    CREATE INDEX IF NOT EXISTS idx_manual_handoff_phrases_status ON manual_handoff_phrases(status,id DESC);
    CREATE INDEX IF NOT EXISTS idx_manual_handoff_phrase_alias_lookup ON manual_handoff_phrase_aliases(status,normalized_text,phrase_id);
    CREATE INDEX IF NOT EXISTS idx_manual_handoff_alias_task_status ON manual_handoff_alias_generation_tasks(status,id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_handoff_alias_task_active ON manual_handoff_alias_generation_tasks(phrase_id,phrase_version) WHERE status IN ('QUEUED','RUNNING');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smoke_schedule_bucket ON smoke_test_runs(platform_code,schedule_bucket) WHERE schedule_bucket IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_smoke_runs_platform_status ON smoke_test_runs(platform_code,status,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smoke_baseline_active ON smoke_test_baselines(platform_code) WHERE active=1;
  `);
  ensureColumn('manual_handoff_phrases', 'version', 'INTEGER NOT NULL DEFAULT 1');
  const stamp = now();
  run(`UPDATE publish_targets SET submission_status=CASE WHEN status IN ('SUCCESS','SUBMITTED','REVIEWING','PUBLISHED') THEN 'SUBMITTED' ELSE submission_status END WHERE submission_status='NOT_SUBMITTED'`);
  run(`UPDATE publish_targets SET review_status=CASE WHEN status='PUBLISHED' THEN 'PUBLISHED' WHEN status='REJECTED' THEN 'REJECTED' WHEN status IN ('SUCCESS','SUBMITTED','REVIEWING') THEN 'UNKNOWN' ELSE review_status END WHERE review_status='UNKNOWN'`);
  run(`UPDATE publish_targets SET publish_attempt_state=CASE
    WHEN status='PUBLISHED' OR review_status='PUBLISHED' THEN 'PUBLISHED'
    WHEN status='REJECTED' OR review_status='REJECTED' THEN 'REJECTED'
    WHEN submission_status='SUBMITTED' OR status IN ('SUCCESS','SUBMITTED','REVIEWING') THEN 'SUBMITTED'
    WHEN json_extract(result,'$.submitAttempted')=1 THEN 'SUBMIT_ATTEMPTED_UNCONFIRMED'
    WHEN json_extract(result,'$.stage') LIKE '%draft%' THEN 'DRAFT_BLOCKED'
    ELSE publish_attempt_state END
    WHERE publish_attempt_state='NOT_ATTEMPTED'`);
  run(`UPDATE publish_targets SET submit_lock='LOCKED',submit_attempted_at=COALESCE(submit_attempted_at,submitted_at,updated_at),submit_attempt_count=MAX(submit_attempt_count,1),submit_lock_reason=COALESCE(submit_lock_reason,'MIGRATED_SUBMISSION_EVIDENCE')
    WHERE submit_lock='UNLOCKED' AND (submission_status='SUBMITTED' OR json_extract(result,'$.submitAttempted')=1)`);
  run(`UPDATE knowledge SET subcategory='\u672a\u5206\u7c7b' WHERE subcategory IS NULL OR TRIM(subcategory)=''`);
  run(`UPDATE knowledge SET published_at=COALESCE(published_at,updated_at,created_at), reviewed_at=COALESCE(reviewed_at,updated_at,created_at), reviewed_by=COALESCE(reviewed_by,'system-migration') WHERE status='PUBLISHED'`);
  run(`UPDATE issues SET last_seen_at=COALESCE(last_seen_at,updated_at,created_at)`);
  run(`UPDATE agent_jobs SET available_at=COALESCE(available_at,created_at)`);
  const semanticRules = [
    ['行不行', '可不可以'], ['能不能', '可不可以'], ['是否可以', '可不可以'], ['能否', '可不可以'],
    ['要不要钱', '是否收费'], ['多少钱', '费用'], ['收费吗', '是否收费'], ['免费吗', '是否收费'],
    ['在哪儿', '地址'], ['在哪里', '地址'], ['怎么去', '地址'], ['具体位置', '地址'],
    ['什么时候', '时间'], ['几点开始', '开始时间'], ['如何报名', '报名'], ['怎么报名', '报名'],
    ['小孩', '孩子'], ['儿童', '孩子'], ['小朋友', '孩子']
  ];
  const insertRule = db.prepare(`INSERT OR IGNORE INTO semantic_rules(rule_type,source_text,target_text,status,priority,created_at,updated_at) VALUES('SYNONYM',?,?,'ENABLED',100,?,?)`);
  for (const [sourceText, targetText] of semanticRules) insertRule.run(sourceText, targetText, stamp, stamp);
}



function migrateChannelLedgerFoundation() {
  const migrationId = '2026-08-24-channel-message-ledger-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_code TEXT NOT NULL REFERENCES platforms(code),
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        channel_type TEXT NOT NULL CHECK(channel_type IN ('PRIVATE_MESSAGE','COMMENT')),
        platform_message_id TEXT NOT NULL,
        conversation_id INTEGER REFERENCES conversations(id),
        conversation_namespace TEXT NOT NULL,
        platform_user_id TEXT,
        direction TEXT NOT NULL DEFAULT 'INBOUND' CHECK(direction IN ('INBOUND','OUTBOUND','UNKNOWN')),
        content TEXT NOT NULL DEFAULT '',
        occurred_at TEXT,
        collected_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1 CHECK(seen_count >= 1),
        identity_confidence TEXT NOT NULL DEFAULT 'LOW' CHECK(identity_confidence IN ('HIGH','MEDIUM','LOW')),
        identity_source TEXT,
        reply_disposition TEXT NOT NULL DEFAULT 'PENDING_REPLY',
        conversation_version INTEGER NOT NULL DEFAULT 0,
        source_message_id INTEGER REFERENCES messages(id),
        raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform_code,account_id,channel_type,platform_message_id)
      );
      CREATE TABLE IF NOT EXISTS reply_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_code TEXT NOT NULL REFERENCES platforms(code),
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        channel_type TEXT NOT NULL CHECK(channel_type IN ('PRIVATE_MESSAGE','COMMENT')),
        conversation_id INTEGER REFERENCES conversations(id),
        conversation_namespace TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        first_pending_at TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_event_ids_json)),
        source_message_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_message_ids_json)),
        conversation_version INTEGER NOT NULL DEFAULT 0,
        reply_text TEXT,
        invalidation_reason TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reply_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reply_batch_id INTEGER NOT NULL REFERENCES reply_batches(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'PREPARED',
        pre_send_version INTEGER,
        post_send_version INTEGER,
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        error_message TEXT,
        prepared_at TEXT NOT NULL,
        sent_at TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(reply_batch_id,attempt_no)
      );
      CREATE TABLE IF NOT EXISTS collection_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_code TEXT NOT NULL REFERENCES platforms(code),
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        channel_type TEXT NOT NULL CHECK(channel_type IN ('PRIVATE_MESSAGE','COMMENT')),
        scope_key TEXT NOT NULL DEFAULT 'default',
        cursor_value TEXT,
        last_complete_scan_at TEXT,
        last_event_at TEXT,
        scan_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform_code,account_id,channel_type,scope_key)
      );
      CREATE TABLE IF NOT EXISTS channel_runtime_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_code TEXT NOT NULL REFERENCES platforms(code),
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        channel_type TEXT NOT NULL CHECK(channel_type IN ('PRIVATE_MESSAGE','COMMENT')),
        state TEXT NOT NULL DEFAULT 'IDLE',
        consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
        last_scan_started_at TEXT,
        last_scan_completed_at TEXT,
        last_success_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_result_json TEXT CHECK(last_result_json IS NULL OR json_valid(last_result_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(platform_code,account_id,channel_type)
      );
      CREATE INDEX IF NOT EXISTS idx_message_events_conversation ON message_events(platform_code,account_id,channel_type,conversation_namespace,id);
      CREATE INDEX IF NOT EXISTS idx_message_events_disposition ON message_events(reply_disposition,collected_at,id);
      CREATE INDEX IF NOT EXISTS idx_reply_batches_claim ON reply_batches(channel_type,status,first_pending_at,id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_batches_one_active_conversation
        ON reply_batches(platform_code,account_id,channel_type,conversation_namespace)
        WHERE status IN ('PENDING','GENERATING','READY','SENDING','NEEDS_CONFIRMATION');
      CREATE INDEX IF NOT EXISTS idx_channel_runtime_state ON channel_runtime_states(state,updated_at);
    `);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}


function migrateChannelReplyBatchRuntime() {
  const migrationId = '2026-08-24-channel-reply-batch-runtime-v2';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const stamp = now();
  const columns = tableColumns('reply_batches');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!columns.has('agent_job_id')) db.exec('ALTER TABLE reply_batches ADD COLUMN agent_job_id INTEGER REFERENCES agent_jobs(id)');
    if (!columns.has('generation_message_id')) db.exec('ALTER TABLE reply_batches ADD COLUMN generation_message_id INTEGER REFERENCES messages(id)');
    if (!columns.has('generation_started_at')) db.exec('ALTER TABLE reply_batches ADD COLUMN generation_started_at TEXT');
    if (!columns.has('send_started_at')) db.exec('ALTER TABLE reply_batches ADD COLUMN send_started_at TEXT');
    if (!columns.has('last_attempt_id')) db.exec('ALTER TABLE reply_batches ADD COLUMN last_attempt_id INTEGER REFERENCES reply_attempts(id)');
    db.exec(`
      DROP INDEX IF EXISTS idx_reply_batches_one_active_conversation;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_batches_one_pre_send_conversation
        ON reply_batches(platform_code,account_id,channel_type,conversation_namespace)
        WHERE status IN ('PENDING','GENERATING','READY');
      CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_batches_one_sending_conversation
        ON reply_batches(platform_code,account_id,channel_type,conversation_namespace)
        WHERE status='SENDING';
      CREATE INDEX IF NOT EXISTS idx_reply_batches_agent_job ON reply_batches(agent_job_id) WHERE agent_job_id IS NOT NULL;
    `);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function removeLegacySmokeGate() {
  const migrationId = '2026-08-13-remove-smoke-gate-add-issue-diagnosis-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE platforms SET smoke_gate_state='CLEAR',smoke_gate_reason=NULL,smoke_gate_run_id=NULL,smoke_gate_updated_at=?").run(stamp);
    db.prepare("UPDATE agent_jobs SET status='CANCELLED',result=?,completed_at=?,lease_expires_at=NULL WHERE job_type='RUN_SMOKE_TEST' AND status IN ('QUEUED','RUNNING')").run(JSON.stringify({ message: '\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u79fb\u9664\uff0c\u5386\u53f2\u4efb\u52a1\u5df2\u53d6\u6d88' }), stamp);
    db.prepare("UPDATE smoke_test_runs SET status='CANCELLED',error_message=COALESCE(error_message,'\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u79fb\u9664'),completed_at=COALESCE(completed_at,?),updated_at=? WHERE status IN ('QUEUED','RUNNING','REVIEW_REQUIRED','CHANGE_DETECTED')").run(stamp, stamp);
    db.prepare("UPDATE issues SET status='RESOLVED',resolution_type='SYSTEM_MIGRATION',resolution='\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u79fb\u9664\uff0c\u5386\u53f2\u95ee\u9898\u7531\u7cfb\u7edf\u8fc1\u79fb\u5173\u95ed',resolved_by='system-migration',resolved_at=?,updated_at=? WHERE source='SMOKE_TEST' AND status IN ('OPEN','RETRYING','DIAGNOSING','DIAGNOSED')").run(stamp, stamp);
    db.prepare("UPDATE runtime_blocks SET status='RELEASED',released_at=?,released_by='system-migration',release_reason='\u9875\u9762\u5de1\u68c0\u529f\u80fd\u79fb\u9664\uff0c\u91ca\u653e\u5386\u53f2\u963b\u65ad' WHERE status='ACTIVE' AND issue_id IN (SELECT id FROM issues WHERE source='SMOKE_TEST')").run(stamp);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function migrateXiaozhiTestDecisions() {
  const migrationId = '2026-08-28-xiaozhi-test-decisions-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS xiaozhi_test_answers (
        answer_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        operator_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        question TEXT NOT NULL,
        reply_text TEXT NOT NULL DEFAULT '',
        route_decision TEXT NOT NULL DEFAULT 'UNKNOWN',
        response_mode TEXT,
        platform_code TEXT,
        message_type TEXT,
        scope TEXT NOT NULL DEFAULT 'published' CHECK(scope IN ('published','import_batch')),
        import_batch_id INTEGER,
        knowledge_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(knowledge_ids_json)),
        source_references_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_references_json)),
        decision TEXT NOT NULL DEFAULT 'ENABLED' CHECK(decision IN ('ENABLED','DISABLED')),
        reason_code TEXT,
        reason TEXT,
        decision_version INTEGER NOT NULL DEFAULT 1 CHECK(decision_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS xiaozhi_test_answer_decision_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        answer_id TEXT NOT NULL REFERENCES xiaozhi_test_answers(answer_id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK(decision IN ('ENABLED','DISABLED')),
        reason_code TEXT,
        reason TEXT,
        operator_id TEXT NOT NULL,
        decision_version INTEGER NOT NULL CHECK(decision_version > 0),
        created_at TEXT NOT NULL,
        UNIQUE(answer_id, decision_version)
      );
      CREATE INDEX IF NOT EXISTS idx_xiaozhi_test_answers_session
        ON xiaozhi_test_answers(session_id, sequence_no);
      CREATE INDEX IF NOT EXISTS idx_xiaozhi_test_answers_decision
        ON xiaozhi_test_answers(decision, updated_at);
      CREATE INDEX IF NOT EXISTS idx_xiaozhi_test_answer_history_answer
        ON xiaozhi_test_answer_decision_history(answer_id, decision_version);
    `);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function activateXiaohongshuPlatform() {
  const migrationId = '2026-08-12-xiaohongshu-activate-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE platforms
      SET lifecycle_state='ACTIVE',desired_state='STOPPED',runtime_updated_by='system-xhs-activation',runtime_updated_at=?
      WHERE code='xiaohongshu'`).run(stamp);
    db.prepare(`UPDATE accounts
      SET enabled=0,login_status='DISABLED',login_checked_at=NULL,login_message='小红书已升级为正式平台；账号默认停用，请在 Web 显式启用账号后再开启平台',login_url=NULL,login_source=NULL,login_evidence=NULL
      WHERE platform_code='xiaohongshu'`).run();
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}


function migrateLegacyKnowledgeCategories() {
  const migrationId = '2026-08-04-knowledge-category-backfill-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const items = db.prepare("SELECT id,question,answer,category FROM knowledge WHERE category IS NULL OR TRIM(category)='' OR TRIM(category)='其他'").all();
  const update = db.prepare('UPDATE knowledge SET category=?,updated_at=? WHERE id=?');
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      const inferred = classifyKnowledgeCategory(item.question, item.answer).category;
      if (inferred !== '其他') update.run(inferred, stamp, item.id);
      else if (!String(item.category || '').trim()) update.run('其他', stamp, item.id);
    }
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}


function correctLegacyKnowledgeCategories() {
  const migrationId = '2026-08-04-knowledge-category-correction-v2';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const items = db.prepare("SELECT id,question,answer FROM knowledge WHERE source='MANUAL' AND reviewed_by='system-migration'").all();
  const update = db.prepare('UPDATE knowledge SET category=?,updated_at=? WHERE id=?');
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) update.run(classifyKnowledgeCategory(item.question, item.answer).category, stamp, item.id);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function migrateKnowledgeLibraryScopes() {
  const migrationId = '2026-08-10-knowledge-platform-scopes-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const items = db.prepare('SELECT id,question,answer,category,subcategory,updated_at FROM knowledge ORDER BY id').all();
  const update = db.prepare('UPDATE knowledge SET category=?,subcategory=?,updated_at=? WHERE id=?');
  const fixedCategories = new Set(SYSTEM_KNOWLEDGE_CATEGORIES);
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      const oldCategory = String(item.category || '').trim();
      const oldSubcategory = String(item.subcategory || '').trim();
      const inferred = classifyKnowledgeCategory(item.question, item.answer);
      const category = fixedCategories.has(oldCategory) ? oldCategory : PUBLIC_KNOWLEDGE_CATEGORY;
      let subcategory = oldSubcategory && oldSubcategory !== DEFAULT_KNOWLEDGE_SUBCATEGORY ? oldSubcategory : '';
      if (!subcategory && oldCategory && !fixedCategories.has(oldCategory) && oldCategory !== '其他') subcategory = oldCategory;
      if (!subcategory) subcategory = inferred.suggestedSubcategory || DEFAULT_KNOWLEDGE_SUBCATEGORY;
      if (category !== oldCategory || subcategory !== oldSubcategory) update.run(category, subcategory, stamp, item.id);
    }
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seedPlatformKnowledgeIsolationMarkers() {
  const migrationId = '2026-08-12-platform-knowledge-isolation-markers-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const items = [
    {
      category: '抖音知识库',
      question: '紫藤风铃的校验码是什么？',
      answer: '抖音平台专属口令是 DY-ONLY-8264；这条知识只允许抖音平台调用。',
      keywords: '紫藤风铃,DY-ONLY-8264,抖音专属校验码'
    },
    {
      category: '视频号知识库',
      question: '银杏邮筒的识别码是什么？',
      answer: '视频号平台专属口令是 WXCH-ONLY-7319；这条知识只允许视频号平台调用。',
      keywords: '银杏邮筒,WXCH-ONLY-7319,视频号专属识别码'
    },
    {
      category: 'B站知识库',
      question: '蓝鲸拼图的通行码是什么？',
      answer: 'B站平台专属口令是 BILI-ONLY-4582；这条知识只允许B站平台调用。',
      keywords: '蓝鲸拼图,BILI-ONLY-4582,B站专属通行码'
    },
    {
      category: '微博知识库',
      question: '星河纸鹤的验证串是什么？',
      answer: '微博平台专属口令是 WB-ONLY-6047；这条知识只允许微博平台调用。',
      keywords: '星河纸鹤,WB-ONLY-6047,微博专属验证串'
    }
  ];
  const find = db.prepare("SELECT id FROM knowledge WHERE status!='DISABLED' AND category=? AND question=?");
  const insert = db.prepare(`INSERT INTO knowledge(question,answer,keywords,status,version,source,review_status,reviewed_by,reviewed_at,published_at,category,subcategory,created_at,updated_at)
    VALUES(?,?,?,'PUBLISHED',1,'SYSTEM_TEST','APPROVED','system-isolation-test',?,?,?,?,?,?)`);
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      if (find.get(item.category, item.question)) continue;
      insert.run(item.question, item.answer, item.keywords, stamp, stamp, item.category, '平台隔离测试', stamp, stamp);
    }
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function backfillKnowledgeSubcategoryCache() {
  const migrationId = '2026-08-10-knowledge-subcategory-cache-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const items = db.prepare(`SELECT category,subcategory,MAX(COALESCE(updated_at,created_at)) AS last_used_at
    FROM knowledge
    WHERE subcategory IS NOT NULL AND TRIM(subcategory)<>'' AND subcategory<>?
    GROUP BY category,subcategory
    ORDER BY last_used_at DESC`).all(DEFAULT_KNOWLEDGE_SUBCATEGORY);
  const insert = db.prepare(`INSERT INTO knowledge_subcategory_cache(category,subcategory,last_used_at) VALUES(?,?,?)
    ON CONFLICT(category,subcategory) DO UPDATE SET last_used_at=excluded.last_used_at`);
  const counts = new Map();
  const fixedCategories = new Set(SYSTEM_KNOWLEDGE_CATEGORIES);
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      if (!fixedCategories.has(item.category)) continue;
      const count = counts.get(item.category) || 0;
      if (count >= 10) continue;
      insert.run(item.category, item.subcategory, item.last_used_at || stamp);
      counts.set(item.category, count + 1);
    }
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function repairLegacySelfReplyEchoes() {
  const migrationId = '2026-08-08-ignore-self-reply-echoes-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const candidates = db.prepare(`SELECT * FROM messages
    WHERE message_type IN ('COMMENT','PRIVATE_MESSAGE')
      AND status NOT IN ('AUTO_REPLIED','MANUAL_HANDLED','CLOSED','IGNORED_SELF')
    ORDER BY id`).all();
  const outgoingQuery = db.prepare(`SELECT id,message_type,reply_text,parent_external_id,context_json,created_at,updated_at,handled_at
    FROM messages
    WHERE platform_code=? AND account_id=? AND message_type=? AND status='AUTO_REPLIED' AND reply_text IS NOT NULL
    ORDER BY COALESCE(handled_at,updated_at,created_at) DESC,id DESC LIMIT 100`);
  const accountQuery = db.prepare('SELECT * FROM accounts WHERE id=?');
  const markIgnored = db.prepare(`UPDATE messages
    SET status='IGNORED_SELF',decision='SELF_MESSAGE',reason=?,rule_version='sender-identity-2026.08.08.1',reply_job_id=NULL,updated_at=?
    WHERE id=?`);
  const deleteGap = db.prepare('DELETE FROM knowledge_gaps WHERE message_id=?');
  const cancelJobs = db.prepare(`UPDATE agent_jobs SET status='CANCELLED',completed_at=?,result=?
    WHERE id=? AND status IN ('QUEUED','RUNNING')`);
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const message of candidates) {
      const account = accountQuery.get(message.account_id) || {};
      const assessment = assessCollectedMessageIdentity({
        data: {
          messageType: message.message_type,
          userName: message.user_name,
          content: message.content,
          parentExternalId: message.parent_external_id,
          context: json(message.context_json, {})
        },
        account,
        recentOutgoingReplies: outgoingQuery.all(message.platform_code, message.account_id, message.message_type),
        collectedAt: message.collected_at || message.created_at || stamp
      });
      if (!assessment.isSelf) continue;
      const reason = `历史数据修复：${assessment.reason}`;
      markIgnored.run(reason, stamp, message.id);
      deleteGap.run(message.id);
      if (message.reply_job_id) cancelJobs.run(stamp, JSON.stringify({ message: '消息已判定为己方回复，取消自动回复任务' }), message.reply_job_id);
    }
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function migrateMiniProgramChannel() {
  const migrationId = '2026-09-05-mini-program-channel-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  const stamp = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mini_program_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        external_user_id TEXT NOT NULL,
        first_handoff_at TEXT,
        last_handoff_at TEXT,
        last_conversation_id INTEGER REFERENCES conversations(id),
        handoff_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, external_user_id)
      );
      CREATE TABLE IF NOT EXISTS mini_program_request_nonces (
        app_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(app_id, nonce)
      );
      CREATE TABLE IF NOT EXISTS mini_program_processing_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 4,
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mini_program_callback_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        app_id TEXT NOT NULL,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 10,
        available_at TEXT,
        claimed_at TEXT,
        lease_expires_at TEXT,
        last_attempt_at TEXT,
        http_status INTEGER,
        response_excerpt TEXT,
        error_message TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mini_program_users_history
        ON mini_program_users(account_id, external_user_id, first_handoff_at);
      CREATE INDEX IF NOT EXISTS idx_mini_program_nonce_expiry
        ON mini_program_request_nonces(expires_at);
      CREATE INDEX IF NOT EXISTS idx_mini_program_processing_claim
        ON mini_program_processing_jobs(status, available_at, lease_expires_at, id);
      CREATE INDEX IF NOT EXISTS idx_mini_program_callback_claim
        ON mini_program_callback_outbox(status, available_at, lease_expires_at, conversation_id, id);
    `);
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateMiniProgramChannelIdentity() {
  const migrationId = '2026-09-06-mini-program-channel-identity-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  immediateTransaction(() => {
    if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS mini_program_channel_identity (
      id INTEGER PRIMARY KEY CHECK(id=1),
      account_id INTEGER UNIQUE CHECK(account_id>0) REFERENCES accounts(id),
      binding_state TEXT NOT NULL DEFAULT 'UNBOUND' CHECK(binding_state IN ('UNBOUND','BOUND')),
      created_at TEXT NOT NULL,
      CHECK((binding_state='UNBOUND' AND account_id IS NULL) OR (binding_state='BOUND' AND account_id IS NOT NULL))
    )`);
    db.prepare("INSERT INTO mini_program_channel_identity(id,account_id,binding_state,created_at) VALUES(1,NULL,'UNBOUND',?)").run(now());
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, now());
  });
}

function migrateWeiboMainAccountName() {
  const migrationId = '2026-09-11-weibo-main-account-name-v1';
  if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
  immediateTransaction(() => {
    if (db.prepare('SELECT id FROM schema_migrations WHERE id=?').get(migrationId)) return;
    const stamp = now();
    // Apply the confirmed rename once so later collected identities remain authoritative.
    db.prepare(`UPDATE accounts SET platform_user_name=?,platform_user_aliases=?,identity_updated_at=?,identity_source=?
      WHERE platform_code='weibo' AND profile_name='profile-weibo-main'`)
      .run(WEIBO_MAIN_ACCOUNT_NAME, JSON.stringify([WEIBO_MAIN_ACCOUNT_NAME]), stamp, 'USER_CONFIRMED_ACCOUNT_RENAME');
    db.prepare('INSERT INTO schema_migrations(id,applied_at) VALUES(?,?)').run(migrationId, stamp);
  });
}

function seed() {
  const platforms = [
    ['xiaohongshu', '小红书', 1], ['douyin', '抖音', 2], ['wechat_channels', '视频号', 3],
    ['bilibili', 'B站', 4], ['weibo', '微博', 5], ['mini_program', '小程序', 6]
  ];
  const upsertPlatform = db.prepare(`INSERT INTO platforms(code,name,sort_order) VALUES(?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name,sort_order=excluded.sort_order`);
  for (const item of platforms) upsertPlatform.run(...item);
  db.prepare("UPDATE platforms SET lifecycle_state='ACTIVE' WHERE code IN ('xiaohongshu','douyin','wechat_channels','bilibili','weibo')").run();

  db.prepare(`INSERT OR IGNORE INTO devices(id,name,status,agent_version,last_heartbeat,created_at)
    VALUES(?,?,?,?,?,?)`).run('device-rpa-01', 'RPA 运营电脑 01', 'OFFLINE', '0.1.0', null, now());

  db.prepare("UPDATE accounts SET enabled=0,login_status='DISABLED' WHERE platform_code IN ('instagram','tiktok')").run();
  const accountSeeds = [
    ['xiaohongshu', '港澳社区-小红书', 'profile-xhs-main', 'UNKNOWN'],
    ['douyin', '港澳社区-抖音', 'profile-douyin-main', 'UNKNOWN'],
    ['wechat_channels', '港澳社区-视频号', 'profile-channels-main', 'UNKNOWN'],
    ['bilibili', '港澳社区-B站', 'profile-bilibili-main', 'UNKNOWN'],
    ['weibo', `${WEIBO_MAIN_ACCOUNT_NAME}-微博`, 'profile-weibo-main', 'UNKNOWN'],
    ['mini_program', '小程序服务端', 'mini-program-api-main', 'NOT_REQUIRED']
  ];
  const findAccount = db.prepare('SELECT id FROM accounts WHERE platform_code=? AND profile_name=? LIMIT 1');
  const insertAccount = db.prepare(`INSERT INTO accounts(platform_code,display_name,device_id,profile_name,enabled,login_status,created_at)
    VALUES(?,?,?,?,1,?,?)`);
  for (const [platformCode, displayName, profileName, loginStatus] of accountSeeds) {
    if (platformCode === 'mini_program') {
      immediateTransaction(() => {
        const binding = db.prepare('SELECT * FROM mini_program_channel_identity WHERE id=1').get();
        if (!binding) return;
        let accountId;
        if (binding.account_id !== null) {
          const account = db.prepare('SELECT id FROM accounts WHERE id=? AND platform_code=? AND profile_name=?')
            .get(binding.account_id, platformCode, profileName);
          if (!account) return;
          accountId = account.id;
        } else {
          if (binding.binding_state !== 'UNBOUND') return;
          const candidates = db.prepare('SELECT id FROM accounts WHERE platform_code=? AND profile_name=? LIMIT 2')
            .all(platformCode, profileName);
          // Ambiguous legacy identities require an explicit operator choice, never an ID-based election.
          if (candidates.length > 1) return;
          accountId = candidates[0]?.id ?? Number(insertAccount.run(platformCode, displayName, 'device-rpa-01', profileName, loginStatus, now()).lastInsertRowid);
          if (!Number.isSafeInteger(accountId) || accountId <= 0) return;
          db.prepare("UPDATE mini_program_channel_identity SET account_id=?,binding_state='BOUND' WHERE id=1 AND binding_state='UNBOUND'").run(accountId);
        }
        db.prepare("UPDATE accounts SET display_name=?,enabled=1,login_status='NOT_REQUIRED' WHERE id=?").run(displayName, accountId);
      });
      continue;
    }
    const existing = findAccount.get(platformCode, profileName);
    if (existing) db.prepare('UPDATE accounts SET display_name=? WHERE id=?').run(displayName, existing.id);
    else insertAccount.run(platformCode, displayName, 'device-rpa-01', profileName, loginStatus, now());
  }

  const knowledgeCount = db.prepare('SELECT COUNT(*) AS c FROM knowledge').get().c;
  if (!knowledgeCount) {
    const insert = db.prepare(`INSERT INTO knowledge(question,answer,keywords,status,version,created_at,updated_at)
      VALUES(?,?,?,?,1,?,?)`);
    const stamp = now();
    insert.run('社区服务中心的办公时间是什么？', '社区服务中心工作时间为周一至周五 9:00—18:00；节假日安排以最新公告为准。', '办公时间,上班时间,几点开门,营业时间', 'PUBLISHED', stamp, stamp);
    insert.run('如何报名参加社区活动？', '可通过社区活动公告中的报名入口提交信息；如未看到入口，请在工作时间联系社区工作人员。', '活动报名,怎么报名,参加活动', 'PUBLISHED', stamp, stamp);
    insert.run('社区服务中心在哪里？', '请以官方主页公布的地址和地图定位为准；出发前建议再次核对最新公告。', '地址,在哪里,怎么去,位置', 'PUBLISHED', stamp, stamp);
  }
}

function isBusyError(error) {
  return error?.code === 'SQLITE_BUSY' || /database is locked|SQLITE_BUSY/i.test(String(error?.message || ''));
}
function busyDelay(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withBusyRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt <= config.sqliteBusyRetries; attempt += 1) {
    try { return operation(); }
    catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt >= config.sqliteBusyRetries) throw error;
      busyDelay(config.sqliteBusyRetryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

export function rows(sql, ...params) {
  return withBusyRetry(() => db.prepare(sql).all(...params));
}

export function row(sql, ...params) {
  return withBusyRetry(() => db.prepare(sql).get(...params));
}

export function run(sql, ...params) {
  return withBusyRetry(() => db.prepare(sql).run(...params));
}

let nestedTransactionSequence = 0;

export function immediateTransaction(operation) {
  if (typeof operation !== 'function') throw new TypeError('transaction operation must be a function');
  return withBusyRetry(() => {
    if (db.isTransaction) {
      const savepoint = `nested_tx_${++nestedTransactionSequence}`;
      db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = operation(db);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {}
        throw error;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  });
}

function isNonIdempotentRecoveryJob(jobType, payload = {}) {
  return ['PUBLISH', 'REPLY'].includes(jobType) || (jobType === 'BROWSER_COMMAND' && ['CLICK', 'CLICK_AT', 'SET_FILES'].includes(String(payload.action || '').toUpperCase()));
}

export function recoverInterruptedJobs() {
  const stamp = now();
  const interrupted = rows("SELECT * FROM agent_jobs WHERE status='RUNNING'");
  for (const job of interrupted) {
    const payload = json(job.payload, {});
    if (isNonIdempotentRecoveryJob(job.job_type, payload)) {
      const result = JSON.stringify({ reason: 'PROCESS_RESTART_NON_IDEMPOTENT', message: '\u670d\u52a1\u91cd\u542f\u65f6\u4efb\u52a1\u4ecd\u5728\u6267\u884c\uff0c\u9700\u4eba\u5de5\u6838\u5bf9\u5e73\u53f0\u5b9e\u9645\u7ed3\u679c\uff0c\u7981\u6b62\u81ea\u52a8\u91cd\u8bd5' });
      run("UPDATE agent_jobs SET status='NEEDS_CONFIRMATION',result=?,completed_at=?,lease_expires_at=NULL WHERE id=?", result, stamp, job.id);
      if (job.job_type === 'BROWSER_COMMAND' && payload.browserCommandId) {
        run("UPDATE browser_commands SET status='NEEDS_CONFIRMATION',result_json=?,error_message=?,completed_at=?,updated_at=? WHERE id=?", result, 'Local Agent restarted during an interactive browser command.', stamp, stamp, payload.browserCommandId);
        run("INSERT INTO browser_command_events(browser_command_id,event_type,status,detail_json,created_at) VALUES(?,'RECOVERED','NEEDS_CONFIRMATION',?,?)", payload.browserCommandId, result, stamp);
      }
      if (job.job_type === 'PUBLISH' && payload.targetId) {
        run("UPDATE publish_targets SET status='NEEDS_CONFIRMATION',publish_attempt_state=CASE WHEN submit_lock='LOCKED' OR submit_attempted_at IS NOT NULL THEN 'SUBMIT_ATTEMPTED_UNCONFIRMED' ELSE 'DRAFT_BLOCKED' END,result=?,updated_at=? WHERE id=?", result, stamp, payload.targetId);
        if (payload.taskId) run("UPDATE publish_tasks SET status='NEEDS_CONFIRMATION',updated_at=? WHERE id=?", stamp, payload.taskId);
      }
      if (job.job_type === 'REPLY' && payload.messageId) {
        run("UPDATE messages SET status='MANUAL_REQUIRED',decision='TECHNICAL_ERROR',reason=?,updated_at=? WHERE id=? AND handled_at IS NULL", '\u670d\u52a1\u91cd\u542f\u65f6\u56de\u590d\u4efb\u52a1\u72b6\u6001\u4e0d\u786e\u5b9a\uff0c\u9700\u4eba\u5de5\u6838\u5bf9', stamp, payload.messageId);
        if (payload.replyBatchId) {
          run(`UPDATE reply_batches SET status='SEND_UNCERTAIN',invalidation_reason='PROCESS_RESTART_NON_IDEMPOTENT',completed_at=NULL,updated_at=?
            WHERE id=? AND status='SENDING' AND agent_job_id=?`, stamp, Number(payload.replyBatchId), job.id);
          if (payload.replyAttemptId) {
            run(`UPDATE reply_attempts SET state='SEND_UNCERTAIN',result_json=?,error_message='PROCESS_RESTART_NON_IDEMPOTENT',updated_at=?
              WHERE id=? AND reply_batch_id=? AND state='PREPARED'`, result, stamp, Number(payload.replyAttemptId), Number(payload.replyBatchId));
          }
        }
      }
    } else if (job.job_type === 'RUN_SMOKE_TEST') {
      const result = JSON.stringify({ recovered: true, reason: 'SMOKE_TEST_REMOVED', message: '\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u79fb\u9664\uff0c\u5386\u53f2\u4efb\u52a1\u5df2\u53d6\u6d88' });
      run("UPDATE agent_jobs SET status='CANCELLED',result=?,completed_at=?,lease_expires_at=NULL WHERE id=?", result, stamp, job.id);
      if (payload.smokeRunId) run("UPDATE smoke_test_runs SET status='CANCELLED',error_message=COALESCE(error_message,'\u9875\u9762\u5de1\u68c0\u529f\u80fd\u5df2\u79fb\u9664'),completed_at=COALESCE(completed_at,?),updated_at=? WHERE id=?", stamp, stamp, payload.smokeRunId);
    } else {
      run("UPDATE agent_jobs SET status='QUEUED',claimed_at=NULL,lease_expires_at=NULL,available_at=?,result=? WHERE id=?", stamp, JSON.stringify({ recovered: true, reason: 'PROCESS_RESTART_SAFE_REQUEUE' }), job.id);
      if (job.job_type === 'BROWSER_COMMAND' && payload.browserCommandId) {
        run("UPDATE browser_commands SET status='QUEUED',claimed_at=NULL,error_message=NULL,updated_at=? WHERE id=?", stamp, payload.browserCommandId);
        run("INSERT INTO browser_command_events(browser_command_id,event_type,status,detail_json,created_at) VALUES(?,'RECOVERED','QUEUED',?,?)", payload.browserCommandId, JSON.stringify({ reason: 'PROCESS_RESTART_SAFE_REQUEUE' }), stamp);
      }
      if (job.job_type === 'DIAGNOSE_ISSUE' && payload.diagnosisId) {
        run("UPDATE issue_diagnoses SET status='QUEUED',started_at=NULL,completed_at=NULL,updated_at=? WHERE id=?", stamp, payload.diagnosisId);
        if (payload.issueId) run("UPDATE issues SET status='DIAGNOSING',diagnosis_status='QUEUED',updated_at=? WHERE id=? AND status='DIAGNOSING'", stamp, payload.issueId);
      }
    }
  }
  return interrupted.length;
}

initDb();
recoverInterruptedJobs();

