export const CONVERSATION_HANDLING_MODE = Object.freeze({
  BOT_ACTIVE: 'BOT_ACTIVE',
  HANDOFF_PENDING: 'HANDOFF_PENDING',
  HUMAN_MANAGED: 'HUMAN_MANAGED'
});

export const NOTIFICATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  CONFIRMED: 'CONFIRMED',
  RETRY_WAIT: 'RETRY_WAIT',
  FAILED: 'FAILED',
  SIMULATED: 'SIMULATED'
});

export const BUSINESS_JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  LEASED: 'LEASED',
  RUNNING: 'RUNNING',
  RETRY_WAIT: 'RETRY_WAIT',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  OBSOLETE: 'OBSOLETE'
});

export const SEND_STATUS = Object.freeze({
  NOT_CREATED: 'NOT_CREATED',
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  UNCERTAIN: 'UNCERTAIN',
  CANCELLED: 'CANCELLED'
});

const HANDLING_MODES = new Set(Object.values(CONVERSATION_HANDLING_MODE));

export function normalizeHandlingMode(value, legacyHumanFollowupState = 'NONE') {
  const explicit = String(value || '').trim().toUpperCase();
  if (HANDLING_MODES.has(explicit)) return explicit;
  const legacy = String(legacyHumanFollowupState || '').trim().toUpperCase();
  if (['WAITING', 'NOTIFIED', 'HUMAN_MANAGED'].includes(legacy)) return CONVERSATION_HANDLING_MODE.HUMAN_MANAGED;
  if (['PENDING', 'NOTIFY_QUEUED', 'HANDOFF_PENDING'].includes(legacy)) return CONVERSATION_HANDLING_MODE.HANDOFF_PENDING;
  return CONVERSATION_HANDLING_MODE.BOT_ACTIVE;
}

export function automationDisabledForHandlingMode(value, legacyHumanFollowupState = 'NONE') {
  return normalizeHandlingMode(value, legacyHumanFollowupState) !== CONVERSATION_HANDLING_MODE.BOT_ACTIVE;
}

export function isNotificationConfirmed(status) {
  return ['CONFIRMED', 'SENT'].includes(String(status || '').trim().toUpperCase());
}
