import crypto from 'node:crypto';

const COOKIE_NAME = 'tianhe_admin_session';
// Renew the persistent browser cookie on authenticated requests.
const PERSISTENT_COOKIE_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const encode = value => Buffer.from(value).toString('base64url');
const decode = value => Buffer.from(value, 'base64url').toString('utf8');
const revokedSessions = new Set();

export function createSessionRevocationStore(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS admin_session_revocations (
    session_key TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL
  )`);
  const find = database.prepare('SELECT 1 FROM admin_session_revocations WHERE session_key=?');
  const insert = database.prepare('INSERT OR IGNORE INTO admin_session_revocations (session_key,revoked_at) VALUES (?,?)');
  return {
    has: key => Boolean(find.get(key)),
    add: key => insert.run(key, Date.now())
  };
}

export function parseCookies(header = '') {
  return Object.fromEntries(String(header || '').split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=');
    if (index < 0) return [item, ''];
    try { return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))]; }
    catch { return [item.slice(0, index), '']; }
  }));
}

function signature(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function sessionKey(session) {
  // Keep the same logout identity when upgrading an existing timed session.
  return crypto.createHash('sha256').update(JSON.stringify([session.sub, session.iat, session.nonce])).digest('hex');
}

export function createSessionToken({ username, secret, ttlMs = 0, nowMs = Date.now(), nonce = crypto.randomBytes(12).toString('hex') }) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError('Invalid session lifetime');
  const session = { sub: username, iat: nowMs, exp: ttlMs > 0 ? nowMs + ttlMs : null, nonce };
  if (ttlMs === 0) session.persistent = true;
  const payload = encode(JSON.stringify(session));
  return payload + '.' + signature(payload, secret);
}

export function verifySessionToken(token, { username, secret, nowMs = Date.now(), revocationStore = revokedSessions }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, supplied] = parts;
  if (!payload || !supplied || !secret) return null;
  const expected = signature(payload, secret);
  const a = Buffer.from(supplied); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let session;
  try { session = JSON.parse(decode(payload)); } catch { return null; }
  if (!session || session.sub !== username || !Number.isFinite(session.iat) || !/^[a-f0-9]{24}$/.test(session.nonce)) return null;
  const persistent = session.persistent === true && session.exp === null;
  if (!persistent && (!Number.isFinite(session.exp) || session.exp <= nowMs)) return null;
  if (revocationStore.has(sessionKey(session))) return null;
  return session;
}

export function revokeSessionToken(token, options) {
  const session = verifySessionToken(token, options);
  if (!session) return false;
  (options.revocationStore || revokedSessions).add(sessionKey(session));
  return true;
}

export function sessionTokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

export function sessionFromRequest(req, options) {
  return verifySessionToken(sessionTokenFromRequest(req), options);
}

export function revokeSessionFromRequest(req, options) {
  return revokeSessionToken(sessionTokenFromRequest(req), options);
}

export function sessionCookie(token, { ttlMs = 0, secure = false } = {}) {
  const cookieTtlMs = ttlMs > 0 ? ttlMs : PERSISTENT_COOKIE_TTL_MS;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(cookieTtlMs / 1000)}${secure ? '; Secure' : ''}`;
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
