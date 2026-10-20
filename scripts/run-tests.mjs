import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, process.argv.slice(2), {
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;
