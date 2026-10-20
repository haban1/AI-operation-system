param(
  [string]$Target = '',
  [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Target) {
  $RegisteredRoot = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\TianheAIDigitalEmployee' -ErrorAction SilentlyContinue).InstallLocation
  foreach ($Candidate in @($PSScriptRoot, $RegisteredRoot, (Join-Path $env:LOCALAPPDATA 'TianheAIDigitalEmployee'))) {
    if ($Candidate -and (Test-Path -LiteralPath (Join-Path $Candidate 'runtime\node.exe')) -and (Test-Path -LiteralPath (Join-Path $Candidate '.env'))) {
      $Target = $Candidate
      break
    }
  }
}
if (-not $Target) { throw '未找到平台安装目录。请将这两个诊断文件放入平台安装目录后双击运行。' }
$Target = [IO.Path]::GetFullPath($Target)
$Node = Join-Path $Target 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $Node)) { throw "未找到平台内置 Node：$Node" }
if (-not $OutputPath) { $OutputPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ('天河发布诊断-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt') }
$QueryPath = Join-Path ([IO.Path]::GetTempPath()) ('tianhe-publish-diagnostic-' + [Guid]::NewGuid().ToString('N') + '.cjs')
$Query = @'
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(process.argv[2]);
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .map(line => line.trim()).filter(line => line && !line.startsWith('#') && line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const databasePath = path.resolve(root, env.DATABASE_PATH || './data/mvp.db');
if (!fs.existsSync(databasePath)) throw new Error('未找到当前数据库：' + databasePath);
const db = new DatabaseSync(databasePath, { readOnly: true });
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const countTables = ['publish_tasks','publish_targets','messages','notifications','agent_jobs'];
const settingNames = ['operations.master_enabled'];
const envNames = ['PORT','AGENT_PORT','RPA_MODE','DEVICE_ID','CLOUD_BASE_URL','AUTO_COLLECT_ENABLED',
  'CHANNEL_SPLIT_ENABLED','PLATFORM_CHANNEL_SPLIT_DOUYIN','PLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS'];
const report = { generatedAt: new Date().toISOString(), installDirectory: root, databasePath,
  settings: Object.fromEntries(envNames.map(name => [name, env[name] ?? null])) };
try {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  report.historyCounts = Object.fromEntries(countTables.filter(table => tables.has(table))
    .map(table => [table, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
  report.masterSwitch = tables.has('system_settings') ? db.prepare('SELECT encrypted_value value FROM system_settings WHERE setting_key=?').get(settingNames[0])?.value : null;
  report.platforms = db.prepare("SELECT code,desired_state,lifecycle_state FROM platforms WHERE code IN ('douyin','wechat_channels')").all();
  report.accounts = db.prepare("SELECT id,platform_code,device_id,enabled,login_status,login_checked_at FROM accounts WHERE platform_code IN ('douyin','wechat_channels')").all();
  report.devices = db.prepare('SELECT id,status,last_heartbeat,agent_version FROM devices').all();
  report.tasks = db.prepare('SELECT id,status,material_path,material_meta,created_at,updated_at FROM publish_tasks ORDER BY id DESC LIMIT 10').all().map(task => {
    const meta = parse(task.material_meta);
    return { id: task.id, status: task.status, publishMode: meta.publishMode || null,
      materialExists: Boolean(task.material_path && fs.existsSync(path.resolve(root, task.material_path))),
      createdAt: task.created_at, updatedAt: task.updated_at };
  });
  report.targets = db.prepare("SELECT id,task_id,platform_code,status,publish_attempt_state,submit_lock,submit_attempted_at,result,updated_at FROM publish_targets WHERE platform_code IN ('douyin','wechat_channels') ORDER BY id DESC LIMIT 20").all().map(target => {
    const result = parse(target.result);
    const { result: ignored, ...fields } = target;
    return { ...fields, message: result.message || null, stage: result.stage || null, code: result.code || result.errorCode || null };
  });
  report.jobs = db.prepare("SELECT id,job_type,status,attempts,payload,result,created_at,available_at,claimed_at,lease_expires_at FROM agent_jobs WHERE json_extract(payload,'$.platformCode') IN ('douyin','wechat_channels') ORDER BY id DESC LIMIT 35").all().map(job => {
    const payload = parse(job.payload), result = parse(job.result);
    const { payload: ignoredPayload, result: ignoredResult, ...fields } = job;
    return { ...fields, platformCode: payload.platformCode, taskId: payload.taskId || null, targetId: payload.targetId || null,
      channel: payload.channelType || payload.queueLane || null, publishMode: payload.publishMode || null,
      managementConfirmed: payload.managementConfirmed === true, message: result.message || null,
      stage: result.stage || null, code: result.code || result.errorCode || null };
  });
  report.activeBlocks = tables.has('runtime_blocks') ? db.prepare("SELECT scope,block_key,feature,reason FROM runtime_blocks WHERE status='ACTIVE'").all() : [];
  report.serverSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, 'src/server.js'))).digest('hex');
} finally { db.close(); }
process.stdout.write(JSON.stringify(report, null, 2));
'@
try {
  [IO.File]::WriteAllText($QueryPath, $Query, [Text.UTF8Encoding]::new($false))
  $Report = & $Node --no-warnings $QueryPath $Target
  if ($LASTEXITCODE -ne 0) { throw '读取发布诊断失败，请确认平台安装完整。' }
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), ($Report -join [Environment]::NewLine), [Text.UTF8Encoding]::new($true))
  Write-Host "诊断已保存：$OutputPath"
  Write-Host '请将这个文件发给维护人员。工具只读取状态，不会清空记录、重启服务或执行发布。'
} finally {
  if (Test-Path -LiteralPath $QueryPath) { Remove-Item -LiteralPath $QueryPath -Force }
}
