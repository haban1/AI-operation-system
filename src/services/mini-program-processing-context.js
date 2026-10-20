import { AsyncLocalStorage } from 'node:async_hooks';
import { immediateTransaction, now, row, run } from '../db.js';
import { withConversationSerial } from './conversation-store.js';

const processingContext = new AsyncLocalStorage();

export function ownsMiniProgramProcessingClaim(claim) {
  const current = row('SELECT * FROM mini_program_processing_jobs WHERE id=?', claim.id);
  return current?.status === 'RUNNING' && current.attempt_count === claim.attempt_count
    && current.claimed_at === claim.claimed_at && current.message_id === claim.message_id
    && current.conversation_id === claim.conversation_id && current.lease_expires_at > now();
}

export function safeMiniProgramProcessingError(error) {
  const timeout = ['AbortError', 'TimeoutError'].includes(error?.name);
  return Object.assign(new Error(timeout ? '小程序消息处理超时' : '小程序消息处理失败'), {
    name: timeout ? 'TimeoutError' : 'Error',
    code: error?.code === 'MINI_PROGRAM_PROCESSING_LEASE_LOST' ? error.code : 'MINI_PROGRAM_PROCESSING_ERROR'
  });
}

function assertClaim(claim, active = true) {
  if (!active || !ownsMiniProgramProcessingClaim(claim)) {
    throw Object.assign(new Error('小程序消息处理租约已失效'), { code: 'MINI_PROGRAM_PROCESSING_LEASE_LOST' });
  }
}

// A durable claim is not lock ownership: acquire the lock before establishing this context.
export function withMiniProgramProcessingClaim(claim, work) {
  const ownedClaim = Object.freeze({ ...claim });
  return withConversationSerial(ownedClaim.conversation_id, async () => {
    assertClaim(ownedClaim);
    const context = { claim: ownedClaim, active: true };
    try { return await processingContext.run(context, work); }
    finally { context.active = false; }
  });
}

export function miniProgramProcessingLockHeld(message) {
  const context = processingContext.getStore();
  if (!context) return false;
  const { claim } = context;
  assertClaim(claim, context.active);
  if (claim.message_id !== message.id || claim.conversation_id !== message.conversation_id) {
    throw Object.assign(new Error('小程序消息处理任务不匹配'), { code: 'MINI_PROGRAM_PROCESSING_LEASE_LOST' });
  }
  return true;
}

export function miniProgramProcessingTransaction(work) {
  return immediateTransaction(() => {
    const context = processingContext.getStore();
    if (context) assertClaim(context.claim, context.active);
    return work();
  });
}

// Fence shared-server writes only while a mini-program worker's async claim context is active.
export function runWithMiniProgramProcessingClaim(...args) {
  if (!processingContext.getStore()) return run(...args);
  return miniProgramProcessingTransaction(() => run(...args));
}
