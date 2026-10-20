import crypto from 'node:crypto';

const COOKIE_NAME = 'tianhe_admin_session';
const encode = value => Buffer.from(value).toString('base64url');
const decode = value => Buffer.from(value, 'base64url').toString('utf8');
const revokedSessions = new Map();

export function parseCookies(header = '') {
  return Object.fromEntries(String(header || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return index < 0 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
  }));
}

function signature(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenExpiry(token) {
  try {
    const [payload] = String(token || '').split('.');
    const session = JSON.parse(decode(payload));
    return Number.isFinite(session.exp) ? session.exp : Date.now();
  } catch {
    return Date.now();
  }
}

function cleanupRevokedSessions(nowMs = Date.now()) {
  for (const [fingerprint, expiresAt] of revokedSessions) {
    if (expiresAt <= nowMs) revokedSessions.delete(fingerprint);
  }
}

export function createSessionToken({ username, secret, ttlMs, nowMs = Date.now() }) {
  const payload = encode(JSON.stringify({ sub: username, iat: nowMs, exp: nowMs + ttlMs, nonce: crypto.randomBytes(12).toString('hex') }));
  return payload + '.' + signature(payload, secret);
}

export function revokeSessionToken(token) {
  if (!token) return false;
  cleanupRevokedSessions();
  revokedSessions.set(tokenFingerprint(token), tokenExpiry(token));
  return true;
}

export function verifySessionToken(token, { username, secret, nowMs = Date.now() }) {
  const [payload, supplied] = String(token || '').split('.');
  if (!payload || !supplied || !secret) return null;
  cleanupRevokedSessions(nowMs);
  if (revokedSessions.has(tokenFingerprint(token))) return null;
  const expected = signature(payload, secret);
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(decode(payload));
    if (session.sub !== username || !Number.isFinite(session.exp) || session.exp <= nowMs) return null;
    return session;
  } catch { return null; }
}

export function sessionTokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

export function sessionFromRequest(req, options) {
  return verifySessionToken(sessionTokenFromRequest(req), options);
}

export function revokeSessionFromRequest(req) {
  return revokeSessionToken(sessionTokenFromRequest(req));
}

export function sessionCookie(token, { ttlMs, secure = false }) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function credentialsMatch(inputUsername, inputPassword, expectedUsername, expectedPassword) {
  const leftUser = Buffer.from(String(inputUsername || '')); const rightUser = Buffer.from(String(expectedUsername || ''));
  const leftPassword = Buffer.from(String(inputPassword || '')); const rightPassword = Buffer.from(String(expectedPassword || ''));
  return leftUser.length === rightUser.length && leftPassword.length === rightPassword.length
    && crypto.timingSafeEqual(leftUser, rightUser) && crypto.timingSafeEqual(leftPassword, rightPassword);
}
