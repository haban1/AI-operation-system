import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db, json, now, row, rows, run } from '../db.js';
import { normalizeBrowserCommand } from './browser-control-policy.js';

function serviceError(statusCode, code, message, detail = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.detail = detail;
  return error;
}

function commandView(item) {
  if (!item) return null;
  return {
    ...item,
    params: json(item.params_json, {}),
    result: json(item.result_json, null),
    confirmation_required: Boolean(item.confirmation_required)
  };
}

function sessionView(item) {
  if (!item) return null;
  return { ...item };
}

function event(commandId, eventType, status, detail = {}) {
  run('INSERT INTO browser_command_events(browser_command_id,event_type,status,detail_json,created_at) VALUES(?,?,?,?,?)', commandId, eventType, status || null, JSON.stringify(detail || {}), now());
}

function policy() {
  return {
    defaultProvider: config.browserControlProvider,
    activePlatformCodes: config.activePlatformCodes,
    enabledPlatformCodes: config.browserControlEnabledPlatforms,
    interactiveEnabled: config.browserControlInteractiveEnabled,
    config
  };
}

export function createBrowserCommand(input = {}, { createdBy = '运营席位' } = {}) {
  if (!config.browserControlEnabled) throw serviceError(409, 'BROWSER_CONTROL_DISABLED', '新浏览器控制体系尚未启用');
  const command = normalizeBrowserCommand(input, policy());
  const account = row(`SELECT a.*,p.desired_state,p.lifecycle_state FROM accounts a JOIN platforms p ON p.code=a.platform_code WHERE a.id=?`, command.accountId);
  if (!account || account.platform_code !== command.platformCode) throw serviceError(404, 'BROWSER_ACCOUNT_NOT_FOUND', '浏览器命令绑定的账号不存在或平台不匹配');
  if (!account.enabled) throw serviceError(409, 'BROWSER_ACCOUNT_DISABLED', '浏览器命令绑定的账号已停用');
  if (account.desired_state !== 'RUNNING' || account.lifecycle_state !== 'ACTIVE') throw serviceError(409, 'BROWSER_PLATFORM_STOPPED', '平台当前已停止，禁止创建浏览器命令');

  const idempotencyKey = input.idempotencyKey ? String(input.idempotencyKey).trim().slice(0, 200) : null;
  if (idempotencyKey) {
    const existing = row('SELECT * FROM browser_commands WHERE idempotency_key=?', idempotencyKey);
    if (existing) {
      const sameCommand = existing.platform_code === command.platformCode
        && Number(existing.account_id) === Number(command.accountId)
        && existing.provider === command.provider
        && existing.action === command.action
        && existing.purpose === command.purpose
        && JSON.stringify(json(existing.params_json, {})) === JSON.stringify(command.params)
        && (!command.sessionId || existing.session_id === command.sessionId);
      if (!sameCommand) throw serviceError(409, 'BROWSER_IDEMPOTENCY_CONFLICT', '幂等键已被另一条不同的浏览器命令占用');
      return { command: commandView(existing), session: sessionView(row('SELECT * FROM browser_sessions WHERE id=?', existing.session_id)), reused: true };
    }
  }

  const stamp = now();
  const sessionId = command.sessionId || randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    let session = row('SELECT * FROM browser_sessions WHERE id=?', sessionId);
    if (session) {
      if (session.state !== 'OPEN') throw serviceError(409, 'BROWSER_SESSION_CLOSED', '浏览器 session 已关闭');
      if (session.device_id !== account.device_id || session.platform_code !== command.platformCode || Number(session.account_id) !== Number(account.id) || session.provider !== command.provider) {
        throw serviceError(409, 'BROWSER_SESSION_BINDING_MISMATCH', '浏览器 session 与设备、平台、账号或 Provider 绑定不一致');
      }
      if (command.action === 'OPEN_PAGE' && session.managed_tab_id) throw serviceError(409, 'BROWSER_SESSION_TAB_EXISTS', '该 session 已有受管标签页，请使用 NAVIGATE 或先 CLOSE_TAB');
      if (!['OPEN_PAGE', 'HEALTH_CHECK'].includes(command.action) && !session.managed_tab_id) throw serviceError(409, 'BROWSER_SESSION_TAB_REQUIRED', '当前命令要求 session 已存在受管标签页');
    } else {
      if (!['OPEN_PAGE', 'HEALTH_CHECK'].includes(command.action)) throw serviceError(409, 'BROWSER_SESSION_NOT_FOUND', '请先使用 OPEN_PAGE 创建受管标签页');
      run(`INSERT INTO browser_sessions(id,device_id,platform_code,account_id,provider,purpose,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'OPEN',?,?)`, sessionId, account.device_id, command.platformCode, account.id, command.provider, command.purpose, stamp, stamp);
      session = row('SELECT * FROM browser_sessions WHERE id=?', sessionId);
    }

    const commandId = Number(run(`INSERT INTO browser_commands(session_id,device_id,platform_code,account_id,provider,action,purpose,params_json,status,idempotency_key,confirmation_required,confirmed_at,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?, 'QUEUED',?,?,?,?,?,?)`, sessionId, account.device_id, command.platformCode, account.id, command.provider, command.action, command.purpose,
      JSON.stringify(command.params), idempotencyKey, command.confirmationRequired ? 1 : 0, command.operatorConfirmedAt, createdBy, stamp, stamp).lastInsertRowid);
    const jobPayload = {
      browserCommandId: commandId,
      sessionId,
      managedTabId: session.managed_tab_id || null,
      platformCode: command.platformCode,
      accountId: account.id,
      profileName: account.profile_name,
      provider: command.provider,
      action: command.action,
      purpose: command.purpose,
      params: command.params,
      operatorConfirmedAt: command.operatorConfirmedAt
    };
    const jobId = Number(run(`INSERT INTO agent_jobs(device_id,job_type,payload,status,created_at,idempotency_key,available_at)
      VALUES(?,'BROWSER_COMMAND',?,'QUEUED',?,?,?)`, account.device_id, JSON.stringify(jobPayload), stamp, idempotencyKey ? `browser:${idempotencyKey}` : `browser-command:${commandId}`, stamp).lastInsertRowid);
    run('UPDATE browser_commands SET agent_job_id=? WHERE id=?', jobId, commandId);
    run('UPDATE browser_sessions SET last_command_id=?,updated_at=? WHERE id=?', commandId, stamp, sessionId);
    event(commandId, 'CREATED', 'QUEUED', { jobId, createdBy, action: command.action, provider: command.provider });
    db.exec('COMMIT');
    return { command: commandView(row('SELECT * FROM browser_commands WHERE id=?', commandId)), session: sessionView(row('SELECT * FROM browser_sessions WHERE id=?', sessionId)), reused: false };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function markBrowserCommandClaimed(job, stamp = now()) {
  if (job?.job_type !== 'BROWSER_COMMAND') return;
  const payload = json(job.payload, {});
  if (!payload.browserCommandId) return;
  run("UPDATE browser_commands SET status='RUNNING',claimed_at=COALESCE(claimed_at,?),updated_at=? WHERE id=?", stamp, stamp, payload.browserCommandId);
  event(payload.browserCommandId, 'CLAIMED', 'RUNNING', { agentJobId: job.id, deviceId: job.device_id });
}

export function deferBrowserCommand(job, detail = {}, stamp = now()) {
  if (job?.job_type !== 'BROWSER_COMMAND') return;
  const payload = json(job.payload, {});
  if (!payload.browserCommandId) return;
  run("UPDATE browser_commands SET status='QUEUED',error_message=?,updated_at=? WHERE id=?", detail.message || detail.reason || null, stamp, payload.browserCommandId);
  event(payload.browserCommandId, 'DEFERRED', 'QUEUED', detail);
}

export function completeBrowserCommand(job, outerStatus, result = {}, stamp = now()) {
  if (job?.job_type !== 'BROWSER_COMMAND') return;
  const payload = json(job.payload, {});
  const commandId = Number(payload.browserCommandId);
  if (!commandId) return;
  const status = ['SUCCESS', 'FAILED', 'NEEDS_CONFIRMATION', 'CANCELLED'].includes(outerStatus) ? outerStatus : 'FAILED';
  const evidenceRef = result.evidenceRef || null;
  run('UPDATE browser_commands SET status=?,result_json=?,error_message=?,evidence_ref=?,completed_at=?,updated_at=? WHERE id=?', status, JSON.stringify(result || {}), status === 'FAILED' ? (result.message || '浏览器命令执行失败') : null, evidenceRef, stamp, stamp, commandId);
  const session = row('SELECT * FROM browser_sessions WHERE id=?', payload.sessionId);
  if (session) {
    const managedTabId = Object.prototype.hasOwnProperty.call(result, 'managedTabId') ? result.managedTabId : session.managed_tab_id;
    const state = payload.action === 'CLOSE_TAB' && status === 'SUCCESS' ? 'CLOSED' : session.state;
    const currentUrl = result.url || session.current_url;
    run('UPDATE browser_sessions SET state=?,managed_tab_id=?,current_url=?,updated_at=?,closed_at=? WHERE id=?', state, managedTabId || null, currentUrl || null, stamp, state === 'CLOSED' ? stamp : session.closed_at, payload.sessionId);
  }
  event(commandId, 'COMPLETED', status, { result, evidenceRef });
}

export function getBrowserCommand(id) {
  const command = commandView(row('SELECT * FROM browser_commands WHERE id=?', Number(id)));
  if (!command) return null;
  return {
    command,
    session: sessionView(row('SELECT * FROM browser_sessions WHERE id=?', command.session_id)),
    events: rows('SELECT * FROM browser_command_events WHERE browser_command_id=? ORDER BY id', command.id).map(item => ({ ...item, detail: json(item.detail_json, {}) }))
  };
}

export function listBrowserCommands({ limit = 100, platformCode = null, status = null } = {}) {
  const clauses = [];
  const params = [];
  if (platformCode) { clauses.push('platform_code=?'); params.push(platformCode); }
  if (status) { clauses.push('status=?'); params.push(status); }
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return rows(`SELECT * FROM browser_commands${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${safeLimit}`, ...params).map(commandView);
}

export function browserControlSummary() {
  const device = row("SELECT id,name,status,last_heartbeat,browser_control_json FROM devices WHERE browser_control_json IS NOT NULL ORDER BY CASE status WHEN 'ONLINE' THEN 0 ELSE 1 END,last_heartbeat DESC LIMIT 1");
  const agentControl = json(device?.browser_control_json, {});
  return {
    enabled: config.browserControlEnabled,
    mode: agentControl.mode || String(config.browserControlMode || '').toUpperCase(),
    defaultProvider: agentControl.defaultProvider || config.browserControlProvider,
    primaryProvider: agentControl.primaryProvider || config.browserControlPrimaryProvider,
    fallbackProvider: agentControl.fallbackProvider ?? (config.browserControlLegacyFallbackEnabled ? config.browserControlFallbackProvider : null),
    legacyFallbackEnabled: agentControl.legacyFallbackEnabled ?? config.browserControlLegacyFallbackEnabled,
    businessRouting: agentControl.businessRouting || (config.browserControlMode === 'web_access_primary' ? 'WEB_ACCESS_PRIMARY_WITH_PLAYWRIGHT_CDP_COMPATIBILITY' : 'LEGACY'),
    enabledPlatforms: config.browserControlEnabledPlatforms,
    interactiveEnabled: config.browserControlInteractiveEnabled,
    riskAcknowledged: config.browserControlRiskAcknowledged,
    providers: Array.isArray(agentControl.providers) ? agentControl.providers : [],
    platformRuntimes: Array.isArray(agentControl.platformRuntimes) ? agentControl.platformRuntimes : [],
    latestAgent: device ? { id: device.id, name: device.name, status: device.status, lastHeartbeat: device.last_heartbeat } : null,
    queued: Number(row("SELECT COUNT(*) AS count FROM browser_commands WHERE status='QUEUED'")?.count || 0),
    running: Number(row("SELECT COUNT(*) AS count FROM browser_commands WHERE status='RUNNING'")?.count || 0),
    needsConfirmation: Number(row("SELECT COUNT(*) AS count FROM browser_commands WHERE status='NEEDS_CONFIRMATION'")?.count || 0)
  };
}

