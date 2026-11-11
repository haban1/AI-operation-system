import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHotTopicKnowledge, HOT_TOPIC_KNOWLEDGE_SCHEMA } from '../src/services/hot-topic-knowledge.js';

const document = () => ({ schemaVersion: 1, title: '社区活动介绍',
  body: '本视频介绍社区文化活动，居民可以参加阅读分享。',
  markdown: '# 社区活动介绍\n\n本视频介绍社区文化活动，居民可以参加阅读分享。',
  questions: ['这条视频介绍了什么？'] });
const material = (changes = {}) => ({ id: 'material-1', source: 'automatic', sourceId: 'video-1',
  sha256: 'a'.repeat(64), hotTopicDocument: document(), ...changes });
const terminal = new Set(['PUBLISHED', 'FAILED', 'REVIEW_REQUIRED']);

function fixture(t, { base = null, enabled = true, options = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(HOT_TOPIC_KNOWLEDGE_SCHEMA);
  t.after(() => db.close());
  const f = { db, time: 1_800_000_000_000, calls: [], behavior: {}, active: base,
    negatives: [], releases: new Map(), members: new Map(), session: 0, release: 0 };
  if (base) f.members.set(base, [{ document_id: 'existing-document', document_version: 2, chunk_id: 'old-chunk' }]);
  const wrap = (name, fallback) => async payload => {
    f.calls.push({ method: name, payload });
    return f.behavior[name] ? f.behavior[name](payload, () => fallback(payload)) : fallback(payload);
  };
  const citation = { documentId: 'document-1', documentVersion: 1, chunkId: 'new-chunk', verificationStatus: 'VERIFIED' };
  const ragClient = {
    request: wrap('request', path => {
      assert.equal(path, '/rag-admin-api/v1/negative-cases?knowledge_base_id=main-business-kb');
      return { negativeCases: [...f.negatives] };
    }),
    uploadDocument: wrap('uploadDocument', () => ({ documentId: 'document-1', documentVersion: 1, status: 'PROCESSING' })),
    getDocument: wrap('getDocument', () => ({ documentId: 'document-1', documentVersion: 1, status: 'READY_FOR_TEST' })),
    listReleases: wrap('listReleases', () => ({ active: f.active ? { release_id: f.active } : null,
      releases: [...f.releases.values()] })),
    getReleaseMembers: wrap('getReleaseMembers', ({ releaseId }) => ({ members: f.members.get(releaseId) || [] })),
    createTestSession: wrap('createTestSession', payload => ({ testSessionId: `session-${++f.session}`,
      mode: payload.mode, baseReleaseId: payload.baseReleaseId || f.active, candidateDocuments: payload.candidateDocuments })),
    queryTestKnowledge: wrap('queryTestKnowledge', () => ({ status: 'ANSWERED', answerId: 'answer-1',
      decision: 'ENABLED', answer: { text: '视频主要介绍社区文化活动和阅读分享。' },
      grounding: { confidence: 0.8, evidenceCoverage: 1 / 3, sourceReferences: [citation] }, sourceReferences: [citation] })),
    createRelease: wrap('createRelease', payload => {
      const release = { releaseId: `release-${++f.release}`, status: 'BUILDING',
        manifest: { requestId: payload.requestId }, input: payload };
      f.releases.set(release.releaseId, release);
      return release;
    }),
    getRelease: wrap('getRelease', ({ releaseId }) => {
      const release = f.releases.get(releaseId);
      release.status = 'PUBLISHED';
      f.active = releaseId;
      f.members.set(releaseId, [...(f.members.get(release.input.baseReleaseId) || []),
        ...release.input.candidateDocuments.map(item => ({ ...item, chunkId: 'new-chunk' }))]);
      return release;
    })
  };
  f.ragClient = ragClient;
  f.settings = { db, ragClient, enabled, now: () => f.time,
    processingPollMs: 10, retryBaseMs: 10, retryMaxMs: 100, leaseMs: 1000, ...options };
  f.worker = createHotTopicKnowledge(f.settings);
  f.enqueue = (value = material(), taskId = 42) => f.worker.enqueue({ taskId, material: value });
  f.row = () => db.prepare('SELECT * FROM hot_topic_knowledge_jobs ORDER BY id LIMIT 1').get();
  f.count = method => f.calls.filter(item => item.method === method).length;
  f.inputs = method => f.calls.filter(item => item.method === method).map(item => item.payload);
  f.step = async () => { f.time += 100; return f.worker.tick(); };
  f.reach = async stage => {
    for (let i = 0; i < 100; i++) {
      if (f.row()?.stage === stage) return f.row();
      if (terminal.has(f.row()?.status)) assert.fail(`Expected stage ${stage}, got ${JSON.stringify(f.row())}`);
      await f.step();
    }
    assert.fail(`Did not reach ${stage}`);
  };
  f.finish = async () => {
    for (let i = 0; i < 100; i++) {
      if (terminal.has(f.row()?.status)) return f.row();
      await f.step();
    }
    assert.fail('Job did not finish');
  };
  return f;
}

test('enqueue only accepts automatic companion documents and participates in the caller transaction', t => {
  const f = fixture(t);
  for (const value of [material({ source: 'upload' }), material({ hotTopicDocument: null }),
    material({ sha256: 'invalid' }), material({ hotTopicDocument: { ...document(), schemaVersion: 2 } })]) {
    assert.equal(f.enqueue(value).enqueued, false);
  }
  f.db.exec('BEGIN');
  assert.equal(f.enqueue().enqueued, true);
  assert.equal(f.row().task_id, 42);
  f.db.exec('ROLLBACK');
  assert.equal(f.row(), undefined);
  assert.equal(f.calls.length, 0);
});

test('empty formal KB completes READY_FOR_TEST, grounded PRE_RELEASE, publication and active member verification', async t => {
  const f = fixture(t);
  f.enqueue();
  assert.equal((await f.finish()).status, 'PUBLISHED');
  const upload = f.inputs('uploadDocument')[0];
  assert.equal(upload.content.toString('utf8'), `${document().markdown}\n`);
  assert.equal(upload.mimeType, 'text/markdown');
  assert.equal(upload.metadata.knowledgeBaseId, 'main-business-kb');
  assert.equal(f.inputs('createTestSession')[0].mode, 'PRE_RELEASE');
  assert.equal(f.inputs('createTestSession')[0].baseReleaseId, null);
  assert.deepEqual(f.inputs('createRelease')[0].candidateDocuments, [{ documentId: 'document-1', documentVersion: 1 }]);
  assert.equal(f.row().release_id, f.active);
  assert.equal(f.count('request'), 3);
  assert.ok(f.row().published_at);
  assert.equal(f.worker.listStatus()[0].document_json, undefined);
});

test('incremental release preserves current formal members and only selects the new document', async t => {
  const f = fixture(t, { base: 'base-1' });
  f.enqueue();
  assert.equal((await f.finish()).status, 'PUBLISHED');
  for (const name of ['createTestSession', 'createRelease']) {
    const payload = f.inputs(name)[0];
    assert.equal(payload.baseReleaseId, 'base-1');
    assert.deepEqual(payload.candidateDocuments, [{ documentId: 'document-1', documentVersion: 1 }]);
  }
  assert.deepEqual(f.members.get(f.active).map(item => item.document_id || item.documentId), ['existing-document', 'document-1']);
});

test('same material/content/document is deduplicated across tasks, including after publication', async t => {
  const f = fixture(t);
  const first = f.enqueue();
  assert.equal(f.enqueue(material(), 99).id, first.id);
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.equal(f.enqueue(material(), 100).status, 'PUBLISHED');
  assert.equal((await f.step()).processed, false);
  assert.equal(f.count('uploadDocument'), 1);
  assert.equal(f.count('createRelease'), 1);
  assert.equal(f.enqueue(material({ sha256: 'b'.repeat(64) })).reused, false);
  assert.equal(f.enqueue(material({ hotTopicDocument: { ...document(), body: '另一篇正文' } })).reused, false);
});

test('PRE_RELEASE captures a newly active base when the KB was empty during BASE lookup', async t => {
  const f = fixture(t);
  f.enqueue();
  await f.reach('SESSION');
  f.active = 'new-base';
  f.members.set('new-base', [{ document_id: 'another-document', document_version: 1 }]);
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.equal(f.inputs('createRelease')[0].baseReleaseId, 'new-base');
  assert.equal(f.members.get(f.active).length, 2);
});

test('NO_ANSWER, unrelated citations, low confidence and unverified citations cannot publish', async t => {
  for (const change of [
    { status: 'NO_ANSWER' }, { decision: 'DISABLED' }, { answer: { text: '' } },
    { grounding: { confidence: 0.4, evidenceCoverage: 1 } },
    { grounding: { confidence: 0.9, evidenceCoverage: 0 } },
    { grounding: { confidence: 0.9, evidenceCoverage: 1, sourceReferences: [{ documentId: 'old-doc', documentVersion: 1, chunkId: 'old-chunk', verificationStatus: 'VERIFIED' }] }, sourceReferences: [] },
    { grounding: { confidence: 0.9, evidenceCoverage: 1, sourceReferences: [{ documentId: 'document-1', documentVersion: 1, chunkId: 'new-chunk', verificationStatus: 'UNVERIFIED' }] }, sourceReferences: [] },
    { grounding: { confidence: 0.9, evidenceCoverage: 1, sourceReferences: [{ documentId: 'document-1', documentVersion: 2, chunkId: 'new-chunk', verificationStatus: 'VERIFIED' }] }, sourceReferences: [] }
  ]) await t.test(JSON.stringify(change), async t => {
    const f = fixture(t);
    f.behavior.queryTestKnowledge = (_payload, fallback) => ({ ...fallback(), ...change });
    f.enqueue();
    assert.equal((await f.finish()).error_code, 'KNOWLEDGE_TEST_FAILED');
    assert.equal(f.count('createRelease'), 0);
  });
});

test('tries the next companion question after a failed positive test', async t => {
  const f = fixture(t);
  f.enqueue(material({ hotTopicDocument: { ...document(), questions: ['第一个问题', '第二个问题'] } }));
  f.behavior.queryTestKnowledge = (payload, fallback) => payload.question === '第一个问题'
    ? { status: 'NO_ANSWER', answerId: 'answer-empty' } : fallback();
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.deepEqual(f.inputs('queryTestKnowledge').map(item => item.question), ['第一个问题', '第二个问题']);
});

test('disabled question and rejected answer text require review before upload regardless of new chunk IDs', async t => {
  for (const negative of [
    { question: '这条视频介绍了什么？', rejected_answer: '无关' },
    { question: '无关的问题', rejected_answer: '居民可以参加阅读分享' },
    { question: '无关的问题', rejected_answer: '阅读分享' },
    { question: '这 条 视 频 介 绍 了 什 么?', rejected_answer: '' }
  ]) await t.test(JSON.stringify(negative), async t => {
    const f = fixture(t);
    f.negatives = [{ ...negative, active: 1, blocked_chunk_ids: ['old-disabled-chunk'] }];
    f.enqueue();
    assert.equal((await f.finish()).status, 'REVIEW_REQUIRED');
    assert.equal(f.row().error_code, 'KNOWLEDGE_REVIEW_REQUIRED');
    assert.equal(f.count('uploadDocument'), 0);
    assert.equal(f.count('createRelease'), 0);
    assert.equal(f.enqueue(material(), 100).status, 'REVIEW_REQUIRED');
    assert.equal((await f.step()).processed, false);
    assert.ok(f.calls.every(item => !/decision|PUT|DELETE/.test(item.method)));
  });
});

test('inactive negative cases do not block; newly disabled content is checked again before release', async t => {
  const f = fixture(t);
  f.negatives = [{ question: document().questions[0], active: 0 }];
  f.enqueue();
  await f.reach('RELEASE');
  f.negatives[0].active = 1;
  assert.equal((await f.finish()).status, 'REVIEW_REQUIRED');
  assert.equal(f.count('uploadDocument'), 1);
  assert.equal(f.count('createRelease'), 0);
});

test('a positive test answer that repeats a disabled answer requires review', async t => {
  const f = fixture(t);
  f.negatives = [{ question: '另一类业务问题', rejected_answer: '视频主要介绍社区文化活动和阅读分享。', active: 1 }];
  f.enqueue();
  assert.equal((await f.finish()).status, 'REVIEW_REQUIRED');
  assert.equal(f.row().stage, 'TEST');
  assert.equal(f.count('createRelease'), 0);
});

test('unavailable or malformed disabled-case guards pause safely without uploading', async t => {
  for (const result of [{}, { status: 'UNAVAILABLE', retryable: true, error: { code: 'RAG_UNAVAILABLE', message: 'offline' } }]) {
    const f = fixture(t);
    f.behavior.request = () => result;
    f.enqueue();
    assert.equal((await f.step()).status, 'RETRY_WAIT');
    assert.equal(f.count('uploadDocument'), 0);
  }
});

test('temporary network and idempotency errors back off with stable upload request IDs', async t => {
  for (const failure of [
    () => { throw new TypeError('fetch failed'); },
    () => ({ status: 'UNAVAILABLE', httpStatus: 503, retryable: true, error: { code: 'RAG_UNAVAILABLE', message: 'retry' } }),
    () => ({ status: 'UNAVAILABLE', httpStatus: 409, retryable: false, error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'pending' } })
  ]) {
    const f = fixture(t);
    let tried = false;
    f.behavior.uploadDocument = (_payload, fallback) => { if (!tried) { tried = true; return failure(); } return fallback(); };
    f.enqueue();
    assert.equal((await f.step()).status, 'RETRY_WAIT');
    assert.equal((await f.worker.tick()).processed, false);
    assert.equal((await f.finish()).status, 'PUBLISHED');
    const requests = f.inputs('uploadDocument');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, requests[1].requestId);
    assert.deepEqual(requests[0].content, requests[1].content);
  }
});

test('factory resumes persisted stage and expired lease without reuploading or retesting', async t => {
  const f = fixture(t);
  f.enqueue();
  await f.reach('RELEASE');
  f.db.prepare('UPDATE hot_topic_knowledge_jobs SET lease_token=?,lease_until=?').run('crashed-worker', f.time + 1000);
  f.worker = createHotTopicKnowledge(f.settings);
  assert.equal((await f.worker.tick()).processed, false);
  f.time += 1001;
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.equal(f.count('uploadDocument'), 1);
  assert.equal(f.count('queryTestKnowledge'), 1);
});

test('concurrent ticks and separate workers claim the same pending job once', async t => {
  const f = fixture(t);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let complete;
  f.behavior.uploadDocument = (_payload, fallback) => { enter(); return new Promise(resolve => { complete = () => resolve(fallback()); }); };
  f.enqueue();
  const first = f.worker.tick();
  assert.equal(f.worker.tick(), first);
  await entered;
  const secondWorker = createHotTopicKnowledge(f.settings);
  assert.equal((await secondWorker.tick()).processed, false);
  assert.equal(f.count('uploadDocument'), 1);
  complete();
  await first;
  assert.equal(f.row().stage, 'DOCUMENT');
});

test('CAS change rebuilds PRE_RELEASE and retests against the latest formal base', async t => {
  const f = fixture(t, { base: 'base-1' });
  let changed = false;
  f.behavior.getRelease = (payload, fallback) => {
    if (!changed) {
      changed = true;
      f.active = 'base-2';
      f.members.set('base-2', [{ document_id: 'operator-document', document_version: 3 }]);
      return { releaseId: payload.releaseId, status: 'FAILED', error: { code: 'RELEASE_BASE_CHANGED', message: 'concurrent update' } };
    }
    return fallback();
  };
  f.enqueue();
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.deepEqual(f.inputs('createTestSession').map(item => item.baseReleaseId), ['base-1', 'base-2']);
  assert.equal(f.count('queryTestKnowledge'), 2);
  assert.notEqual(...f.inputs('createTestSession').map(item => item.requestId));
  assert.equal(f.count('uploadDocument'), 1);
  assert.equal(f.members.get(f.active)[0].document_id, 'operator-document');
});

test('failed resource returned directly by createRelease is handled as CAS domain failure', async t => {
  const f = fixture(t, { base: 'base-1' });
  let changed = false;
  f.behavior.createRelease = (_payload, fallback) => {
    if (!changed) { changed = true; f.active = 'base-2'; return { status: 'FAILED', error: { code: 'RELEASE_BASE_CHANGED' } }; }
    return fallback();
  };
  f.enqueue();
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.equal(f.count('createTestSession'), 2);
});

test('BUILDING is polled; service restart retries with a new release ID without another test', async t => {
  const f = fixture(t);
  let poll = 0;
  f.behavior.getRelease = (payload, fallback) => {
    if (++poll === 1) return { releaseId: payload.releaseId, status: 'BUILDING' };
    if (poll === 2) return { releaseId: payload.releaseId, status: 'FAILED', error: { code: 'SERVICE_RESTARTED' } };
    return fallback();
  };
  f.enqueue();
  assert.equal((await f.finish()).status, 'PUBLISHED');
  assert.equal(f.count('createRelease'), 2);
  assert.equal(f.count('getRelease'), 3);
  assert.equal(f.count('queryTestKnowledge'), 1);
  assert.notEqual(...f.inputs('createRelease').map(item => item.requestId));
});

test('disabled-source publish validation becomes REVIEW_REQUIRED and leaves the active release intact', async t => {
  const f = fixture(t, { base: 'base-1' });
  f.behavior.getRelease = ({ releaseId }) => ({ releaseId, status: 'FAILED',
    error: { code: 'DISABLED_CASE_VALIDATION_FAILED', message: 'blocked source' } });
  f.enqueue();
  assert.equal((await f.finish()).status, 'REVIEW_REQUIRED');
  assert.equal(f.active, 'base-1');
  assert.equal(f.enqueue().status, 'REVIEW_REQUIRED');
});

test('repeated CAS and build failures stop after the configured generation/attempt limit', async t => {
  for (const code of ['RELEASE_BASE_CHANGED', 'RELEASE_BUILD_FAILED']) {
    const f = fixture(t, { base: 'base-1', options: { maxAttempts: 3 } });
    f.behavior.getRelease = ({ releaseId }) => ({ releaseId, status: 'FAILED', error: { code } });
    f.enqueue();
    assert.equal((await f.finish()).status, 'FAILED');
    assert.equal(f.count('createRelease'), 3);
    assert.equal(f.row().error_code, code);
    assert.equal(f.active, 'base-1');
  }
});

test('PROCESS_FAILED stays visible and never marks legacy knowledge imported', async t => {
  const f = fixture(t);
  f.behavior.getDocument = () => ({ status: 'PROCESS_FAILED', error: { code: 'PARSE_FAILED', message: 'invalid document' } });
  f.enqueue();
  assert.equal((await f.finish()).error_code, 'PARSE_FAILED');
  assert.equal(f.row().status, 'FAILED');
  assert.equal(f.count('createTestSession'), 0);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(item => item.name), ['hot_topic_knowledge_jobs']);
});

test('already active document is reused; rollback after publish is never overwritten', async t => {
  await t.test('already active', async t => {
    const f = fixture(t, { base: 'already-published' });
    f.members.set('already-published', [{ document_id: 'document-1', document_version: 1 }]);
    f.enqueue();
    assert.equal((await f.finish()).status, 'PUBLISHED');
    assert.equal(f.count('createTestSession'), 0);
    assert.equal(f.count('createRelease'), 0);
  });
  await t.test('operator rollback', async t => {
    const f = fixture(t, { base: 'base-1' });
    f.enqueue();
    await f.reach('VERIFY');
    f.active = 'base-1';
    assert.equal((await f.finish()).error_code, 'PUBLISHED_RELEASE_SUPERSEDED');
    assert.equal(f.active, 'base-1');
    assert.equal(f.count('createRelease'), 1);
  });
});

test('disabled worker still persists enqueue; start/stop waits for the current operation and cancels polling', async t => {
  const scheduled = [], cancelled = [];
  let enabled = false;
  const f = fixture(t, { enabled: () => enabled, options: {
    setTimer: callback => { const timer = { callback, unref() {} }; scheduled.push(timer); return timer; },
    clearTimer: timer => cancelled.push(timer)
  } });
  f.enqueue();
  assert.deepEqual(await f.worker.tick(), { processed: false, paused: true });
  assert.equal(f.calls.length, 0);
  f.worker.start();
  f.worker.start();
  assert.equal(scheduled.length, 1);
  await f.worker.stop();
  assert.deepEqual(cancelled, [scheduled[0]]);
  enabled = true;
  let enter, complete;
  const entered = new Promise(resolve => { enter = resolve; });
  f.behavior.uploadDocument = (_payload, fallback) => { enter(); return new Promise(resolve => { complete = () => resolve(fallback()); }); };
  f.worker.start();
  const running = scheduled[1].callback();
  await entered;
  let stopped = false;
  const stopping = f.worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  complete();
  await Promise.all([running, stopping]);
  assert.equal(stopped, true);
  assert.equal(scheduled.length, 2);
});
