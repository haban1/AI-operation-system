import crypto from 'node:crypto';

export const HOT_TOPIC_KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hot_topic_knowledge_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_key TEXT NOT NULL UNIQUE,
  task_id INTEGER,
  material_id TEXT NOT NULL,
  material_sha256 TEXT NOT NULL,
  source_id TEXT,
  document_hash TEXT NOT NULL,
  document_json TEXT NOT NULL CHECK(json_valid(document_json)),
  status TEXT NOT NULL DEFAULT 'PENDING',
  stage TEXT NOT NULL DEFAULT 'UPLOAD',
  rag_document_id TEXT,
  rag_document_version INTEGER,
  base_release_id TEXT,
  test_session_id TEXT,
  test_answer_id TEXT,
  question_index INTEGER NOT NULL DEFAULT 0,
  release_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  release_attempt INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(material_id,material_sha256,document_hash)
);
CREATE INDEX IF NOT EXISTS idx_hot_topic_knowledge_due
  ON hot_topic_knowledge_jobs(status,next_attempt_at,lease_until,id);
`;

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const clean = value => typeof value === 'string' ? value.trim() : '';
const fail = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });

function normalizeDocument(value) {
  if (!value || value.schemaVersion !== 1) return null;
  const title = clean(value.title), body = clean(value.body), markdown = clean(value.markdown);
  const questions = [...new Set((Array.isArray(value.questions) ? value.questions : []).map(clean).filter(Boolean))];
  if (!title || !body || !markdown || !questions.length || questions.length > 20) return null;
  if (title.length > 500 || body.length > 100_000 || markdown.length > 100_000 || questions.some(q => q.length > 4000)) return null;
  return { schemaVersion: 1, title, body, markdown: markdown + '\n', questions };
}

function requireResult(result) {
  const code = result?.error?.code;
  if (!result || result.ok === false || Number(result.httpStatus) >= 400 || ['UNAVAILABLE', 'NOT_CONFIGURED', 'INVALID_RESPONSE'].includes(result.status) || code) {
    throw fail(code || 'RAG_UNAVAILABLE', result?.error?.message || '知识服务暂时不可用',
      result?.retryable === true || result?.error?.retryable === true || ['IDEMPOTENCY_IN_PROGRESS', 'RAG_NOT_CONFIGURED'].includes(code));
  }
  return result;
}

/** Schema initialization belongs to the caller; enqueue never performs DDL. */
export function createHotTopicKnowledge({
  db, ragClient, enabled = true, knowledgeBaseId = 'main-business-kb',
  now = () => Date.now(), pollMs = 1000, processingPollMs = 3000,
  retryBaseMs = 5000, retryMaxMs = 15 * 60_000, maxAttempts = 8,
  leaseMs = Math.max(180_000, Number(ragClient?.timeoutMs || 0) * 3 + 30_000),
  operatorId = 'automatic-hot-topic',
  setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  if (!db?.prepare || !ragClient) throw new TypeError('db and ragClient are required');
  let timer = null, started = false, inFlight = null;
  const stamp = () => new Date(now()).toISOString();
  const available = () => typeof enabled === 'function' ? enabled() === true : enabled === true;
  const requestId = (job, stage) => `hot-topic-${hash(`${job.operation_key}:${stage}:${job.generation}:${job.release_attempt}`).slice(0, 48)}`;

  function enqueue({ taskId = null, material } = {}) {
    if (!material || material.source !== 'automatic' || !material.hotTopicDocument) return { enqueued: false, reason: 'NOT_AUTOMATIC_KNOWLEDGE' };
    const document = normalizeDocument(material.hotTopicDocument);
    const materialId = clean(material.id), sha256 = clean(material.sha256).toLowerCase();
    if (!document || !materialId || !/^[a-f0-9]{64}$/.test(sha256)) return { enqueued: false, reason: 'INVALID_DOCUMENT' };
    const documentHash = hash(JSON.stringify(document));
    const key = hash(JSON.stringify([materialId, sha256, documentHash]));
    const at = stamp();
    const inserted = db.prepare(`INSERT OR IGNORE INTO hot_topic_knowledge_jobs
      (operation_key,task_id,material_id,material_sha256,source_id,document_hash,document_json,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(key, taskId, materialId, sha256, clean(material.sourceId) || null, documentHash, JSON.stringify(document), now(), at, at);
    let job = db.prepare('SELECT * FROM hot_topic_knowledge_jobs WHERE operation_key=?').get(key);
    // Reconfirming a previously failed item retries its recorded stage and payload.
    if (!inserted.changes && job.status === 'FAILED') {
      db.prepare("UPDATE hot_topic_knowledge_jobs SET status='PENDING',attempt_count=0,next_attempt_at=?,error_code=NULL,error_message=NULL,updated_at=? WHERE id=? AND status='FAILED'").run(now(), at, job.id);
      job = db.prepare('SELECT * FROM hot_topic_knowledge_jobs WHERE id=?').get(job.id);
    }
    return { enqueued: true, reused: !inserted.changes, id: Number(job.id), status: job.status, stage: job.stage };
  }

  function update(job, values) {
    const entries = Object.entries({ ...values, updated_at: stamp(), lease_token: null, lease_until: 0 });
    return db.prepare(`UPDATE hot_topic_knowledge_jobs SET ${entries.map(([name]) => `${name}=?`).join(',')}
      WHERE id=? AND lease_token=?`).run(...entries.map(([, value]) => value), job.id, job.lease_token);
  }
  function advance(job, values) {
    return update(job, { status: 'PENDING', attempt_count: 0, next_attempt_at: now(), error_code: null, error_message: null, ...values });
  }
  function retry(job, error, extra = {}) {
    const attempts = Number(job.attempt_count) + 1;
    const retryable = error.retryable === true && attempts < maxAttempts;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts - 1, 20));
    update(job, { status: retryable ? 'RETRY_WAIT' : 'FAILED', attempt_count: attempts,
      next_attempt_at: now() + delay, error_code: String(error.code || 'KNOWLEDGE_JOB_FAILED').slice(0, 120),
      error_message: String(error.message || '知识处理失败').slice(0, 1000), ...extra });
  }
  async function step(job) {
    const document=JSON.parse(job.document_json);
    if(job.stage==='UPLOAD'){
      const result=requireResult(await ragClient.saveFile({content:Buffer.from(document.markdown,'utf8'),
        filename:`自动热点知识-${job.document_hash.slice(0,16)}.md`,mimeType:'text/markdown',
        knowledgeBaseId,uploadedBy:operatorId,requestId:requestId(job,'upload')}));
      if(!clean(result.documentId)||!Number.isSafeInteger(result.documentVersion))throw fail('RAG_INVALID_DOCUMENT','知识服务未返回有效文件');
      advance(job,{stage:'DOCUMENT',rag_document_id:result.documentId,rag_document_version:result.documentVersion});
      return;
    }
    if(!job.rag_document_id){advance(job,{stage:'UPLOAD'});return}
    const result=requireResult(await ragClient.listFiles({knowledgeBaseId}));
    const file=(result.documents||[]).find(item=>item.documentId===job.rag_document_id&&Number(item.documentVersion)===Number(job.rag_document_version));
    if(!file)throw fail('KNOWLEDGE_FILE_REMOVED','知识文件已被删除或修改');
    if(file.usageStatus==='ACTIVE')update(job,{status:'PUBLISHED',stage:'DOCUMENT',published_at:stamp(),attempt_count:0,error_code:null,error_message:null,next_attempt_at:0});
    else if(file.usageStatus==='PROCESSING')advance(job,{stage:'DOCUMENT',next_attempt_at:now()+processingPollMs});
    else throw fail(file.error?.code||'FILE_PROCESSING_FAILED',file.error?.message||'知识文件处理失败');
  }

  async function runTick() {
    if (!available()) return { processed: false, paused: true };
    const token = crypto.randomUUID(), time = now();
    const job = db.prepare(`UPDATE hot_topic_knowledge_jobs SET lease_token=?,lease_until=?,updated_at=?
      WHERE id=(SELECT id FROM hot_topic_knowledge_jobs WHERE status IN ('PENDING','RETRY_WAIT')
        AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,id LIMIT 1)
      AND lease_until<=? RETURNING *`).get(token, time + leaseMs, stamp(), time, time, time);
    if (!job) return { processed: false };
    try { await step(job); }
    catch (error) {
      retry(job, Object.assign(error instanceof Error ? error : new Error('知识处理失败'), {
        retryable: error?.retryable === true || ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name)
      }));
    }
    const current = db.prepare('SELECT status,stage,error_code FROM hot_topic_knowledge_jobs WHERE id=?').get(job.id);
    return { processed: true, id: Number(job.id), status: current.status, stage: current.stage, errorCode: current.error_code };
  }
  function tick() {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }
  function schedule() {
    if (!started) return;
    timer = setTimer(async () => {
      timer = null;
      try { await tick(); } catch { /* Queue faults must never become unhandled server errors. */ }
      schedule();
    }, pollMs);
    timer?.unref?.();
  }
  function start() { if (started) return; started = true; schedule(); }
  function stop() { started = false; if (timer !== null) clearTimer(timer); timer = null; return inFlight || Promise.resolve(); }
  function listStatus({ limit = 100 } = {}) {
    return db.prepare(`SELECT id,task_id,material_id,material_sha256,document_hash,status,stage,rag_document_id,
      rag_document_version,base_release_id,test_session_id,release_id,attempt_count,next_attempt_at,error_code,error_message,
      created_at,updated_at,published_at FROM hot_topic_knowledge_jobs ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(limit) || 100)));
  }
  return { enqueue, start, stop, tick, listStatus };
}
