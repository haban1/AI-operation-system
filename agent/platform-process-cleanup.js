import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalized(value) {
  return String(value || '').replaceAll('/', '\\').toLowerCase();
}

export function collectProcessTreeIds(processes = [], seedIds = []) {
  const selected = new Set(seedIds.map(Number).filter(Number.isInteger));
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      const processId = Number(process.processId ?? process.ProcessId);
      const parentProcessId = Number(process.parentProcessId ?? process.ParentProcessId);
      if (Number.isInteger(processId) && selected.has(parentProcessId) && !selected.has(processId)) {
        selected.add(processId);
        changed = true;
      }
    }
  }
  return [...selected];
}

export function profileProcessTreeIds(processes = [], profileDir = '') {
  const needle = normalized(profileDir);
  if (!needle) return [];
  const seedIds = processes
    .filter(process => normalized(process.commandLine ?? process.CommandLine).includes(needle))
    .map(process => Number(process.processId ?? process.ProcessId))
    .filter(Number.isInteger);
  return collectProcessTreeIds(processes, seedIds);
}

export async function listWindowsProcesses() {
  if (process.platform !== 'win32') return [];
  const command = "$items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine); if($items.Count -eq 0){'[]'} else {$items | ConvertTo-Json -Compress}";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024
  });
  const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function terminateWindowsProcessIds(processIds = []) {
  if (process.platform !== 'win32') return [];
  const ids = [...new Set(processIds.map(Number).filter(processId => Number.isInteger(processId) && processId > 0 && processId !== process.pid))];
  if (!ids.length) return [];
  const command = `$ids=@(${ids.join(',')}); foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 10_000
  }).catch(() => {});
  return ids;
}

export async function forceStopProfileProcesses(profileDir, { knownProcessIds = [] } = {}) {
  if (process.platform !== 'win32' || !profileDir) return [];
  await new Promise(resolve => setTimeout(resolve, 150));
  const refreshed = await listWindowsProcesses().catch(() => []);
  const ids = [...new Set([...knownProcessIds, ...profileProcessTreeIds(refreshed, profileDir)])];
  return terminateWindowsProcessIds(ids);
}
