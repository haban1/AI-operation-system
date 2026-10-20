import { immediateTransaction, now, row, run } from '../db.js';
import { requestMiniProgramHandoff } from './mini-program-channel.js';
import { cancelConversationAutomation, conversationAutomationDisabled } from './conversation-control.js';
import { ownsMiniProgramProcessingClaim, withMiniProgramProcessingClaim } from './mini-program-processing-context.js';

export const MINI_PROGRAM_PROCESSING_RETRY_DELAYS_MS = Object.freeze([5_000, 30_000, 120_000]);
let workerTimer = null;
let workerBusy = false;

function jobById(id) { return row('SELECT * FROM mini_program_processing_jobs WHERE id=?', id); }
function ownsClaim(claim) {
  return ownsMiniProgramProcessingClaim(claim);
}
function futureIso(stamp, delay) { return new Date(Date.parse(stamp) + delay).toISOString(); }

export function claimMiniProgramProcessingJob({ leaseMs = 30_000 } = {}) {
  return immediateTransaction(() => {
    const stamp = now();
    run(`UPDATE mini_program_processing_jobs SET status='RETRY_WAIT',available_at=?,claimed_at=NULL,lease_expires_at=NULL,updated_at=?
      WHERE status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`, stamp, stamp, stamp);
    const candidate = row(`SELECT candidate.* FROM mini_program_processing_jobs candidate
      WHERE candidate.status IN ('PENDING','RETRY_WAIT') AND candidate.available_at<=?
        AND NOT EXISTS (SELECT 1 FROM mini_program_processing_jobs earlier
          WHERE earlier.conversation_id=candidate.conversation_id AND earlier.id<candidate.id
            AND earlier.status NOT IN ('COMPLETED','FAILED'))
      ORDER BY candidate.available_at,candidate.id LIMIT 1`, stamp);
    if (!candidate) return null;
    // An expired final lease still needs the same serialized, transactional exhaustion handoff.
    const exhausted = candidate.attempt_count >= candidate.max_attempts;
    const claimed = run(`UPDATE mini_program_processing_jobs SET status='RUNNING',attempt_count=attempt_count+?,
      claimed_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND status IN ('PENDING','RETRY_WAIT')`,
    exhausted ? 0 : 1, stamp, futureIso(stamp, Math.max(1, Number(leaseMs) || 30_000)), stamp, candidate.id);
    return claimed.changes === 1 ? { ...jobById(candidate.id), exhausted } : null;
  });
}

function finishJob(claim, error = null) {
  return immediateTransaction(() => {
    if (!ownsClaim(claim)) return jobById(claim.id);
    const stamp = now();
    const conversation = row('SELECT * FROM conversations WHERE id=?', claim.conversation_id);
    const automationDisabled = conversationAutomationDisabled(conversation);
    const notification = automationDisabled && row(`SELECT n.* FROM notifications n JOIN messages m ON m.id=n.message_id
      WHERE n.idempotency_key=? AND n.conversation_id=? AND m.conversation_id=n.conversation_id`,
    `wecom:mini-program:handoff:conversation:${claim.conversation_id}`, claim.conversation_id);
    let handoffRecorded = false;
    try { handoffRecorded = Boolean(notification && JSON.parse(notification.metadata_json).handoff === true); } catch {}
    if (automationDisabled && handoffRecorded) cancelConversationAutomation(claim.conversation_id, { reason: conversation.handoff_reason || 'CONVERSATION_HANDOFF' });
    if ((!error && !automationDisabled) || handoffRecorded) {
      run(`UPDATE mini_program_processing_jobs SET status='COMPLETED',claimed_at=NULL,lease_expires_at=NULL,
        last_error_code=NULL,last_error_message=NULL,completed_at=?,updated_at=?
        WHERE id=? AND status='RUNNING' AND attempt_count=? AND claimed_at=?`, stamp, stamp, claim.id, claim.attempt_count, claim.claimed_at);
    } else {
      const exhausted = claim.attempt_count >= claim.max_attempts;
      // Upstream exceptions may contain source text, payloads or credentials. Persist only stable diagnostics.
      const timeout = ['AbortError', 'TimeoutError'].includes(error?.name);
      const code = timeout ? 'MINI_PROGRAM_PROCESSING_TIMEOUT' : 'MINI_PROGRAM_PROCESSING_ERROR';
      const message = timeout ? '小程序消息处理超时' : '小程序消息处理失败';
      if (exhausted) requestMiniProgramHandoff({
        conversationId: claim.conversation_id, messageId: claim.message_id,
        reason: '消息处理技术异常', type: 'MINI_PROGRAM_PROCESSING_FAILED'
      });
      run(`UPDATE mini_program_processing_jobs SET status=?,available_at=?,claimed_at=NULL,lease_expires_at=NULL,
        last_error_code=?,last_error_message=?,completed_at=?,updated_at=?
        WHERE id=? AND status='RUNNING' AND attempt_count=? AND claimed_at=?`,
      exhausted ? 'FAILED' : 'RETRY_WAIT', exhausted ? stamp : futureIso(stamp, MINI_PROGRAM_PROCESSING_RETRY_DELAYS_MS[Math.min(2, Math.max(0, claim.attempt_count - 1))]),
      code, message, exhausted ? stamp : null, stamp, claim.id, claim.attempt_count, claim.claimed_at);
    }
    return jobById(claim.id);
  });
}

export async function processMiniProgramJobOnce({ processMessage } = {}) {
  if (typeof processMessage !== 'function') throw new TypeError('processMessage must be a function');
  const claim = claimMiniProgramProcessingJob();
  if (!claim) return null;
  const renewal = setInterval(() => {
    try {
      const stamp = now();
      run(`UPDATE mini_program_processing_jobs SET lease_expires_at=?,updated_at=?
        WHERE id=? AND status='RUNNING' AND attempt_count=? AND claimed_at=? AND lease_expires_at>?`,
      futureIso(stamp, 30_000), stamp, claim.id, claim.attempt_count, claim.claimed_at, stamp);
    } catch {}
  }, 10_000);
  renewal.unref?.();
  try {
    return await withMiniProgramProcessingClaim(claim, async () => {
      let failure = null;
      try {
        const conversation = row('SELECT * FROM conversations WHERE id=?', claim.conversation_id);
        if (conversationAutomationDisabled(conversation)) {
          requestMiniProgramHandoff({ conversationId: claim.conversation_id, messageId: claim.message_id, reason: conversation.handoff_reason || '用户请求转人工' });
        } else if (claim.exhausted) {
          throw new Error('PROCESSING_LEASE_EXPIRED');
        } else {
          await processMessage(claim.message_id);
        }
      } catch (error) { failure = error || new Error('PROCESSING_FAILED'); }
      return finishJob(claim, failure);
    });
  } catch (error) {
    if (error?.code === 'MINI_PROGRAM_PROCESSING_LEASE_LOST') return jobById(claim.id);
    throw error;
  } finally { clearInterval(renewal); }
}

export function startMiniProgramProcessingWorker({ processMessage, intervalMs = 1_000 } = {}) {
  if (workerTimer) return workerTimer;
  if (typeof processMessage !== 'function') throw new TypeError('processMessage must be a function');
  workerTimer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try { await processMiniProgramJobOnce({ processMessage }); } catch {}
    finally { workerBusy = false; }
  }, Math.max(1_000, Number(intervalMs) || 1_000));
  workerTimer.unref?.();
  return workerTimer;
}

export function stopMiniProgramProcessingWorker() {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
