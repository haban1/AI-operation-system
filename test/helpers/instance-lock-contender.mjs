import fs from 'node:fs';
import { acquireInstanceLock } from '../../src/services/instance-lock.js';

const [lockPath, criticalPath, startAtText] = process.argv.slice(2);
const sleepSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const sleep = milliseconds => Atomics.wait(sleepSignal, 0, 0, Math.max(1, milliseconds));

while (Date.now() < Number(startAtText)) sleep(Math.min(10, Number(startAtText) - Date.now()));

let lock = null;
let criticalFd = null;
try {
  lock = acquireInstanceLock(lockPath, { label: 'contender', waitMs: 10_000, retryDelayMs: 5 });
  criticalFd = fs.openSync(criticalPath, 'wx');
  sleep(75);
} catch (error) {
  console.error(error?.code || error?.message || String(error));
  process.exitCode = 2;
} finally {
  if (criticalFd !== null) {
    fs.closeSync(criticalFd);
    fs.rmSync(criticalPath, { force: true });
  }
  lock?.release();
}
