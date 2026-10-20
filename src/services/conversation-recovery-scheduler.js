import { eligibleForRecoveryScan, limitRecoveryBatch } from './conversation-recovery-policy.js';

export function buildRecoveryGroups(conversations = [], referenceTime = Date.now()) {
  const groups = new Map();
  for (const conversation of conversations) {
    if (!eligibleForRecoveryScan(conversation, referenceTime).eligible) continue;
    const stableKey = String(conversation.external_conversation_key || '').trim();
    if (!stableKey) continue;
    const groupKey = `${conversation.platform_code}:${conversation.account_id}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(conversation);
  }
  return [...groups.entries()].map(([key, values]) => ({ key, conversations: limitRecoveryBatch(values.sort((a, b) => String(a.last_recovery_scan_at || '').localeCompare(String(b.last_recovery_scan_at || '')))) }));
}

export function recoveryTargets(conversations = []) {
  return conversations.map(item => ({
    conversationId: Number(item.id),
    conversationNamespace: item.namespace,
    externalConversationKey: String(item.external_conversation_key || '').trim(),
    userName: item.user_name || null
  })).filter(item => item.conversationId > 0 && item.externalConversationKey);
}
