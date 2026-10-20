import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const sleepSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function sleepSync(milliseconds) {
  Atomics.wait(sleepSignal, 0, 0, milliseconds);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function legacyLockSnapshot(lockPath, malformedGraceMs) {
  let before;
  try {
    before = fs.statSync(lockPath);
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'MISSING' : 'INCOMPLETE', fingerprint: null };
  }
  let raw;
  let after;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
    after = fs.statSync(lockPath);
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'MISSING' : 'INCOMPLETE', fingerprint: null };
  }
  if (!sameFileIdentity(before, after)) return { state: 'INCOMPLETE', fingerprint: null };
  const fingerprint = crypto.createHash('sha256')
    .update(`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.birthtimeMs}:`)
    .update(raw)
    .digest('hex');
  try {
    const metadata = JSON.parse(raw);
    return { state: processExists(Number(metadata?.pid)) ? 'ACTIVE' : 'STALE', fingerprint };
  } catch {
    const ageMs = Math.max(0, Date.now() - after.mtimeMs);
    return { state: ageMs >= malformedGraceMs ? 'STALE' : 'INCOMPLETE', fingerprint };
  }
}

function removeStaleLegacyLock(lockPath, observed, malformedGraceMs) {
  if (observed?.state !== 'STALE' || !observed.fingerprint) return false;
  const confirmed = legacyLockSnapshot(lockPath, malformedGraceMs);
  if (confirmed.state !== 'STALE' || confirmed.fingerprint !== observed.fingerprint) return false;
  try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return true;
}

function lockConflict(label, lockPath) {
  const conflict = new Error(`${label} already running (lock: ${lockPath})`);
  conflict.code = 'INSTANCE_ALREADY_RUNNING';
  return conflict;
}

function closeLockDatabase(database) {
  if (!database) return;
  try { database.exec('ROLLBACK'); } catch {}
  try { database.close(); } catch {}
}

export function acquireInstanceLock(lockPath, {
  enabled = true,
  label = 'process',
  waitMs = 0,
  retryDelayMs = 50,
  malformedGraceMs = 2_000
} = {}) {
  if (!enabled) return { acquired: false, release() {} };
  const resolved = path.resolve(lockPath);
  const lockDatabasePath = `${resolved}.sqlite`;
  const maximumWaitMs = Math.max(0, Math.trunc(Number(waitMs) || 0));
  const retryMs = Math.max(1, Math.trunc(Number(retryDelayMs) || 50));
  const legacyGraceMs = Math.max(0, Math.trunc(Number(malformedGraceMs) || 0));
  const deadline = Date.now() + maximumWaitMs;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  for (;;) {
    const legacySnapshot = legacyLockSnapshot(resolved, legacyGraceMs);
    if (legacySnapshot.state === 'ACTIVE' || legacySnapshot.state === 'INCOMPLETE') {
      if (Date.now() < deadline) {
        sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      throw lockConflict(label, resolved);
    }

    let lockDatabase = null;
    const token = crypto.randomUUID();
    try {
      // The open transaction is the lock: SQLite and the OS release it on
      // process exit, so ownership never depends on unlinking a shared file.
      lockDatabase = new DatabaseSync(lockDatabasePath);
      const remainingWaitMs = Math.max(0, deadline - Date.now());
      lockDatabase.exec(`PRAGMA busy_timeout = ${Math.min(2_147_483_647, remainingWaitMs)}; BEGIN EXCLUSIVE;`);
      lockDatabase.exec('CREATE TABLE IF NOT EXISTS instance_lock_owner (token TEXT PRIMARY KEY, pid INTEGER NOT NULL, label TEXT NOT NULL, started_at TEXT NOT NULL)');
      lockDatabase.prepare('DELETE FROM instance_lock_owner').run();
      lockDatabase.prepare('INSERT INTO instance_lock_owner(token,pid,label,started_at) VALUES(?,?,?,?)')
        .run(token, process.pid, String(label), new Date().toISOString());

      // Older releases used the requested path as a JSON lock. Recheck after
      // acquiring the SQLite transaction so an active legacy owner still wins.
      const confirmedLegacy = legacyLockSnapshot(resolved, legacyGraceMs);
      if (confirmedLegacy.state === 'STALE' && !removeStaleLegacyLock(resolved, confirmedLegacy, legacyGraceMs)) {
        closeLockDatabase(lockDatabase);
        lockDatabase = null;
        if (Date.now() < deadline) {
          sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        throw lockConflict(label, resolved);
      }
      if (confirmedLegacy.state === 'ACTIVE' || confirmedLegacy.state === 'INCOMPLETE') {
        closeLockDatabase(lockDatabase);
        lockDatabase = null;
        if (Date.now() < deadline) {
          sleepSync(Math.min(retryMs, Math.max(1, deadline - Date.now())));
          continue;
        }
        throw lockConflict(label, resolved);
      }

      let released = false;
      return {
        acquired: true,
        path: resolved,
        token,
        release() {
          if (released) return;
          released = true;
          closeLockDatabase(lockDatabase);
          lockDatabase = null;
        }
      };
    } catch (error) {
      closeLockDatabase(lockDatabase);
      if (error?.code === 'INSTANCE_ALREADY_RUNNING') throw error;
      if (error?.code === 'ERR_SQLITE_ERROR' && /database is locked|SQLITE_BUSY/i.test(String(error?.message || ''))) {
        throw lockConflict(label, resolved);
      }
      throw error;
    }
  }
}
