import { createHash } from 'node:crypto';
// Session-local evidence: a restart requires a fresh test, rather than claiming stale health.
let lastTest = null;
let sequence = 0;
function fingerprint(settings) {
  return createHash('sha256').update(JSON.stringify([settings.mode, settings.baseUrl, settings.apiKey, settings.model, settings.visionModel])).digest('hex');
}
export function clearAiConnectionStatus() { sequence += 1; lastTest = null; }
export function beginAiConnectionTest(settings) {
  const token = { sequence: ++sequence, fingerprint: fingerprint(settings) };
  lastTest = null;
  return token;
}
export function finishAiConnectionTest(token, status) {
  if (token.sequence !== sequence) return;
  lastTest = { fingerprint: token.fingerprint, status, testedAt: new Date().toISOString() };
}
export function getAiConnectionStatus(settings) {
  if (settings.mode === 'mock') return { status: 'SIMULATED', testedAt: null };
  if (!settings.apiKey) return { status: 'UNCONFIGURED', testedAt: null };
  if (lastTest?.fingerprint === fingerprint(settings)) return { status: lastTest.status, testedAt: lastTest.testedAt };
  return { status: 'UNTESTED', testedAt: null };
}
