import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from '../src/config.js';
import { precheckMaterial } from './precheck.js';
import { recognizeMaterialText } from './material-ocr.js';
import { reviewMaterialWithAi } from './material-ai-review.js';
import { generateMaterialCopyFromAudio } from './material-audio-content-generation.js';
import { generateMaterialCopyFromImage } from './material-image-content-generation.js';
import { predictMaterialTraffic } from './material-traffic-prediction.js';
import { assertRpaOutput } from './rpa-adapters/base.js';
import { createRpaRegistry } from './rpa-adapters/registry.js';
import { checkLoginPrecisely } from './login-monitor.js';
import { executeClaimedJobWithPlatformGuard, isPlatformRunnable, stoppedPlatformStatus } from './platform-runtime-guard.js';
import { PlatformOperationCoordinator } from './platform-operation-coordinator.js';
import { acquireInstanceLock } from '../src/services/instance-lock.js';
import { LoginPollingGate } from './login-polling-gate.js';
import { createBrowserController, createPlatformWebAccessManager } from './browser-control/index.js';
import { BusinessBrowserRouter } from './browser-control/business-router.js';
import { isBrowserCommandNonIdempotent } from '../src/services/browser-control-policy.js';
import { jobOperationLockMode, jobQueueLane, platformWorkerPlans } from './job-operation-lane.js';
import { platformChannelSplitEnabled } from '../src/services/channel-job-scheduler.js';

const execFileAsync = promisify(execFile);
const agentBindingId = config.agentToken ? createHash('sha256').update(`${config.deviceId || ''}\0${config.agentToken}`).digest('hex').slice(0, 24) : null;
const verifiedEntryOverrides = {
  douyin: {
    commentUrl: 'https://creator.douyin.com/creator-micro/data/following/comment',
    messageUrl: 'https://www.douyin.com/user/self'
  },
  wechat_channels: {
    commentUrl: 'https://channels.weixin.qq.com/platform/interaction/comment',
    messageUrl: 'https://channels.weixin.qq.com/platform/private_msg'
  }
};
const uploadTimeoutOptions = {
  minTimeoutMs: config.publishUploadMinTimeoutMs,
  maxTimeoutMs: config.publishUploadMaxTimeoutMs,
  minBytesPerSecond: config.publishUploadMinBytesPerSecond,
  processingGraceMs: config.publishUploadProcessingGraceMs
};
const assistedPlatforms = Object.fromEntries(Object.entries(config.platformRpa).map(([platformCode, item]) => [platformCode, {
  profileDir: item.profileDir,
  executablePath: config.chromeExecutablePath,
  loginTimeoutMs: config.assistedLoginTimeoutMs,
  sendTimeoutMs: config.assistedSendTimeoutMs,
  uploadTimeoutOptions,
  spec: {
    publishUrl: item.publishUrl,
    manageUrl: item.manageUrl,
    commentUrl: verifiedEntryOverrides[platformCode]?.commentUrl || item.commentUrl,
    messageUrl: verifiedEntryOverrides[platformCode]?.messageUrl || item.messageUrl
  }
}]));
const browserRuntimeManager = createPlatformWebAccessManager();
const adapters = createRpaRegistry({
  mode: config.rpaMode,
  browserRuntimeManager,
  logsDir: path.join(ROOT, 'logs'),
  xiaohongshu: {
    profileDir: config.xhsProfileDir,
    executablePath: config.chromeExecutablePath,
    creatorUrl: config.xhsCreatorUrl,
    loginTimeoutMs: config.xhsLoginTimeoutMs,
    sendTimeoutMs: config.xhsSendTimeoutMs,
    uploadTimeoutOptions
  },
  platforms: assistedPlatforms
});
const xiaohongshuAdapter = adapters.get('xiaohongshu');
const browserController = createBrowserController({ webAccessManager: browserRuntimeManager });
const businessBrowserRouter = new BusinessBrowserRouter({ adapters, webAccessManager: browserRuntimeManager });
const AGENT_VERSION = '1.0.0';
let running = true;
let consecutiveCloudControlFailures = 0;
let activeJobCount = 0;
const activeJobCountsByPlatform = new Map();
function changeActivePlatformJobs(platformCode, delta) {
  const code = String(platformCode || '').trim();
  if (!code) return;
  const next = Math.max(0, Number(activeJobCountsByPlatform.get(code) || 0) + Number(delta || 0));
  if (next > 0) activeJobCountsByPlatform.set(code, next);
  else activeJobCountsByPlatform.delete(code);
}
function platformHasActiveJob(platformCode) {
  return Number(activeJobCountsByPlatform.get(String(platformCode || '').trim()) || 0) > 0;
}
const loginPollingGate = new LoginPollingGate({ intervalMs: config.loginStatusPollIntervalMs, initialDelayMs: 15_000 });
let lastLoginPollAt = null;
let lastLoginPollSummary = null;
const agentPlatformAllowlist = [...new Set(String(process.env.AGENT_PLATFORM_ALLOWLIST || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean))];
const agentPlatformAllowlistSet = agentPlatformAllowlist.length ? new Set(agentPlatformAllowlist) : null;

async function stopPlatformsImmediately(platformCodes = []) {
  loginPollingGate.deactivate(platformCodes);
  await Promise.all(platformCodes.map(async platformCode => {
    const adapter = adapters.get(platformCode);
    try {
      if (typeof adapter?.stop === 'function') await adapter.stop();
      await browserController.stopPlatform(platformCode);
      console.log(`[Agent] Platform ${platformCode} stopped: pending operations cancelled and browser contexts closed`);
    } catch (error) {
      console.error(`[Agent] Failed to close ${platformCode} browser context: ${error.message}`);
    }
  }));
}

const platformCoordinator = new PlatformOperationCoordinator({
  fetchControl: () => cloud('/api/agent/platform-runtime'),
  onStopped: stopPlatformsImmediately
});

for (const [platformCode, adapter] of adapters.entries()) {
  if (adapter?.platformCode === platformCode && typeof adapter.setRuntimeGuard === 'function') {
    adapter.setRuntimeGuard(() => platformCoordinator.guardBrowserLaunch(platformCode));
  }
  if (adapter?.platformCode === platformCode && typeof adapter.setSubmitAuthorizer === 'function') {
    adapter.setSubmitAuthorizer((payload, context) => acquireSubmitLock(payload, context));
  }
}

async function rememberPlatformControl(data = {}) {
  await platformCoordinator.update({
    platforms: data.platforms || [],
    masterSwitch: data.masterSwitch || { enabled: platformCoordinator.masterSwitchEnabled }
  });
  syncLoginPollingGateWithRuntime();
  return platformCoordinator.runtimeByCode;
}

async function fetchPlatformRuntime() {
  const data = await cloud('/api/agent/platform-runtime');
  return rememberPlatformControl(data);
}

async function currentPlatformRuntime(platformCode, { refresh = true } = {}) {
  if (refresh || !platformCoordinator.runtimeByCode.has(platformCode)) await fetchPlatformRuntime();
  return platformCoordinator.effectiveRuntime(platformCode);
}

async function requirePlatformRunning(platformCode, options = {}) {
  return platformCoordinator.requireRunning(platformCode, { refresh: true, ...options });
}

function withGuardedPlatformOperation(platformCode, task, options = {}) {
  return platformCoordinator.run(platformCode, task, options);
}

function loginMonitorStatus() {
  return {
    enabled: config.loginStatusPollEnabled,
    intervalMs: config.loginStatusPollIntervalMs,
    logoutConfirmations: config.loginStatusLogoutConfirmations,
    confirmDelayMs: config.loginStatusConfirmDelayMs,
    nextPollAt: config.loginStatusPollEnabled ? loginPollingGate.snapshot().nextPollAt : null,
    monitoredPlatformCodes: loginPollingGate.snapshot().platformCodes,
    lastPollAt: lastLoginPollAt,
    lastSummary: lastLoginPollSummary
  };
}

async function cloud(pathname, options = {}) {
  try {
    const response = await fetch(`${config.cloudBaseUrl}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {}), ...(options.headers || {}) }
    });
    if (!response.ok) throw new Error(`???? ${pathname} ?? ${response.status}: ${await response.text()}`);
    return response.json();
  } catch (error) {
    error.code = 'CLOUD_REQUEST_FAILED';
    error.cloudPathname = pathname;
    throw error;
  }
}


async function runtimeAiSettings() {
  try {
    const response = await cloud('/api/agent/settings/ai');
    return response.settings || {};
  } catch (error) {
    console.error(`[Agent] 读取动态 AI 配置失败，回退到本机配置：${error.message}`);
    return { mode: config.qwenMode, apiKey: config.qwenApiKey, baseUrl: config.qwenBaseUrl, model: config.aiReviewModel, visionModel: config.qwenVisionModel, asrModel: config.audioAsrModel, contentModel: config.audioContentModel, imageContentModel: config.imageContentModel, trafficPredictionModel: config.trafficPredictionModel };
  }
}

async function reportAiUsage(payload) {
  try { await cloud('/api/agent/ai-usage', { method: 'POST', body: JSON.stringify(payload) }); }
  catch (error) { console.error(`[Agent] AI 调用日志上报失败：${error.message}`); }
}

async function acquireSubmitLock(payload = {}, context = {}) {
  const targetId = Number(payload.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    const error = new Error('\u6700\u7ec8\u6295\u7a3f\u524d\u5fc5\u987b\u63d0\u4f9b\u6709\u6548\u7684 targetId \u4ee5\u83b7\u53d6\u6295\u7a3f\u9501');
    error.code = 'SUBMIT_TARGET_MISSING';
    throw error;
  }
  const data = await cloud(`/api/agent/publish-targets/${targetId}/acquire-submit-lock`, {
    method: 'POST',
    body: JSON.stringify({
      deviceId: config.deviceId,
      taskId: Number(payload.taskId) || null,
      targetId,
      accountId: Number(payload.accountId) || null,
      platformCode: payload.platformCode || null,
      draftFingerprint: payload.draftFingerprint || null,
      reason: context.reason || 'FINAL_PUBLISH_CLICK',
      source: context.source || 'LOCAL_AGENT'
    })
  });
  return data;
}

async function heartbeat() {
  const data = await cloud('/api/agent/heartbeat', { method: 'POST', body: JSON.stringify({ deviceId: config.deviceId, version: AGENT_VERSION, browserControl: browserController.capabilities() }) });
  await rememberPlatformControl(data);
  return data;
}

function runnableClaimPlatformCodes() {
  const codes = platformCoordinator.runnablePlatformCodes();
  return agentPlatformAllowlistSet ? codes.filter(code => agentPlatformAllowlistSet.has(code)) : codes;
}

function syncLoginPollingGateWithRuntime() {
  const platformCodes = config.loginStatusPollEnabled ? runnableClaimPlatformCodes() : [];
  loginPollingGate.sync(platformCodes);
  return platformCodes;
}

async function claim(requestedPlatformCodes = null, { queueLanes = null } = {}) {
  const runnableCodes = runnableClaimPlatformCodes();
  const runnableSet = new Set(runnableCodes);
  const platformCodes = Array.isArray(requestedPlatformCodes)
    ? [...new Set(requestedPlatformCodes)].filter(code => runnableSet.has(code))
    : runnableCodes;
  const normalizedQueueLanes = Array.isArray(queueLanes)
    ? [...new Set(queueLanes.map(item => String(item || '').trim().toUpperCase()).filter(Boolean))]
    : [];
  if (!platformCodes.length) return { job: null, locallyPaused: true, platforms: [...platformCoordinator.runtimeByCode.values()] };
  const data = await cloud('/api/agent/jobs/claim', {
    method: 'POST',
    body: JSON.stringify({ deviceId: config.deviceId, platformCodes, ...(normalizedQueueLanes.length ? { queueLanes: normalizedQueueLanes } : {}) })
  });
  await rememberPlatformControl(data);
  return data;
}

async function defer(job, runtime) {
  return cloud(`/api/agent/jobs/${job.id}/defer`, {
    method: 'POST',
    body: JSON.stringify({
      reason: runtime?.blocked_reason || 'PLATFORM_STOPPED_PRE_EXECUTION',
      message: stoppedPlatformStatus(job?.payload?.platformCode, runtime).message
    })
  });
}

async function complete(jobId, output) {
  return cloud(`/api/agent/jobs/${jobId}/complete`, { method: 'POST', body: JSON.stringify(output) });
}

async function syncPlatformLoginStatus(platformCode, status) {
  if (!status?.checkedAt) return;
  try {
    const data = await cloud('/api/agent/accounts');
    const account = data.accounts?.find(item => item.platform_code === platformCode);
    if (!account) return;
    await cloud(`/api/agent/accounts/${account.id}/login-state`, { method: 'POST', body: JSON.stringify({
      state: status.state || 'UNKNOWN', checkedAt: status.checkedAt, message: status.message || '',
      url: status.url || '', evidence: status.evidence || [], confidence: status.confidence || 'UNCONFIRMED',
      confirmedSamples: Number(status.confirmedSamples || 0), checkMode: status.checkMode || 'MANUAL'
    }) });
  } catch (error) { console.error(`[Agent] \u540c\u6b65${platformCode}\u767b\u5f55\u72b6\u6001\u5931\u8d25\uff1a${error.message}`); }
}

function unavailableStatus(platformCode, message = '\u5f53\u524d\u6a21\u5f0f\u4e0d\u652f\u6301\u771f\u5b9e\u767b\u5f55\u68c0\u67e5') {
  return { platformCode, browser: 'UNAVAILABLE', loggedIn: false, state: 'UNAVAILABLE', confidence: 'UNCONFIRMED', evidence: [], checkedAt: new Date().toISOString(), url: null, message };
}

async function fetchEnabledPlatformCodes() {
  try {
    await fetchPlatformRuntime();
    return new Set(platformCoordinator.runnablePlatformCodes());
  } catch (error) {
    console.warn(`[Agent] Platform runtime control unavailable; treating all platforms as stopped: ${error.message}`);
    return new Set();
  }
}

async function runPlatformBatch(action, { mode = 'MANUAL', platformCodes = null } = {}) {
  const statuses = {};
  const enabledPlatformCodes = await fetchEnabledPlatformCodes();
  const selectedPlatformCodes = Array.isArray(platformCodes)
    ? new Set(platformCodes.filter(code => enabledPlatformCodes.has(code)))
    : enabledPlatformCodes;
  const tokens = new Map();
  for (const platformCode of selectedPlatformCodes) {
    tokens.set(platformCode, { platformCode, generation: platformCoordinator.generation(platformCode) });
  }
  for (const [platformCode, adapter] of adapters.entries()) {
    if (agentPlatformAllowlistSet && !agentPlatformAllowlistSet.has(platformCode)) continue;
    if (Array.isArray(platformCodes) && !selectedPlatformCodes.has(platformCode)) continue;
    const token = tokens.get(platformCode);
    if (!token) {
      statuses[platformCode] = { ...stoppedPlatformStatus(platformCode, platformCoordinator.effectiveRuntime(platformCode)), checkMode: mode, confirmedSamples: 0 };
      continue;
    }
    try {
      statuses[platformCode] = await platformCoordinator.queuePrepared(token, async () => {
        if (action === 'open') {
          loginPollingGate.activate(platformCode);
          return typeof adapter?.openLogin === 'function'
            ? adapter.openLogin()
            : unavailableStatus(platformCode);
        }
        if (action === 'check' && typeof adapter?.checkLogin === 'function') {
          return checkLoginPrecisely({
            check: () => adapter.checkLogin({ preserveInteractiveLogin: true }),
          recheck: typeof adapter.recheckLogin === 'function' ? () => adapter.recheckLogin() : undefined,
            mode,
            logoutConfirmations: config.loginStatusLogoutConfirmations,
            confirmDelayMs: config.loginStatusConfirmDelayMs
          });
        }
        return unavailableStatus(platformCode);
      });
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) {
        statuses[platformCode] = { ...stoppedPlatformStatus(platformCode, error.runtime || platformCoordinator.effectiveRuntime(platformCode)), checkMode: mode, confirmedSamples: 0 };
      } else {
        statuses[platformCode] = { platformCode, browser: 'ERROR', loggedIn: false, state: 'ERROR', confidence: 'UNCONFIRMED', evidence: ['exception'], checkedAt: action === 'check' ? new Date().toISOString() : null, url: null, message: error.message, checkMode: mode, confirmedSamples: 0 };
      }
    }
    if (action === 'check') await syncPlatformLoginStatus(platformCode, statuses[platformCode]);
  }
  return statuses;
}
async function syncXiaohongshuLoginStatus(status) {
  return syncPlatformLoginStatus('xiaohongshu', status);
}

function agentJobScope(job = {}) {
  const platformCode = String(job?.payload?.platformCode || 'unknown').trim() || 'unknown';
  const lane = jobQueueLane(job);
  const laneLabel = lane === 'COMMENT' ? 'comment' : lane === 'PRIVATE_MESSAGE' ? 'private' : lane === 'GENERAL' ? 'general' : 'combined';
  return `${platformCode}:${laneLabel}`;
}

async function processClaimedJob(job) {
  const jobScope = agentJobScope(job);
  console.log(`[Agent:${jobScope}] 领取 Job#${job.id} ${job.job_type}`);
  const activePlatformCode = String(job?.payload?.platformCode || '').trim();
  activeJobCount += 1;
  changeActivePlatformJobs(activePlatformCode, 1);
  try {
    let guarded;
    try {
      const platformCode = job?.payload?.platformCode;
      guarded = await withGuardedPlatformOperation(platformCode, () => executeClaimedJobWithPlatformGuard({
        job,
        getRuntime: code => currentPlatformRuntime(code, { refresh: true }),
        deferJob: defer,
        resolveAdapter: currentJob => currentJob?.job_type === 'BROWSER_COMMAND' ? browserController : businessBrowserRouter,
        executeAdapter: async (adapter, currentJob) => assertRpaOutput(await adapter.execute(currentJob))
      }), { lockMode: jobOperationLockMode(job) });
    } catch (error) {
      if (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code)) {
        const nonIdempotent = ['PUBLISH', 'REPLY'].includes(job.job_type) || (job.job_type === 'BROWSER_COMMAND' && isBrowserCommandNonIdempotent(job.payload));
        const writeMayHaveOccurred = error.writeAttempted !== false;
        if (nonIdempotent && error.platformOperationStarted && writeMayHaveOccurred) {
          const output = {
            status: 'NEEDS_CONFIRMATION',
            result: {
              message: 'Platform stopped during a non-idempotent operation. The result may be uncertain; automatic retry is disabled and manual verification is required.',
              interruptedByPlatformStop: true,
              platformCode: job?.payload?.platformCode
            }
          };
          await complete(job.id, output);
          console.log(`[Agent:${jobScope}] Job#${job.id} -> NEEDS_CONFIRMATION (interrupted by platform stop)`);
        } else {
          await defer(job, error.runtime || platformCoordinator.effectiveRuntime(job?.payload?.platformCode));
          console.log(`[Agent:${jobScope}] Job#${job.id} deferred after platform stop; it was not marked failed`);
        }
      } else {
        const output = {
          status: 'FAILED',
          result: {
            message: error.message,
            code: error.code || null,
            retryable: error.retryable === true,
            platformState: error.platformState || null,
            platformMessage: error.platformMessage || null,
            stack: error.stack
          }
        };
        await complete(job.id, output);
        console.log(`[Agent:${jobScope}] Job#${job.id} -> ${output.status}`);
      }
      return;
    }
    if (guarded.deferred) {
      console.log(`[Agent:${job?.payload?.platformCode}] Job#${job.id} 执行前发现平台已停止，已退回排队`);
      return;
    }
    await complete(job.id, guarded.output);
    console.log(`[Agent:${jobScope}] Job#${job.id} -> ${guarded.output.status}`);
  } finally {
    activeJobCount = Math.max(0, activeJobCount - 1);
    changeActivePlatformJobs(activePlatformCode, -1);
  }
}

async function platformWorkerLoop({ platformCode, name, queueLanes = null }) {
  console.log(`[Agent:${name}] Worker 已启动，${queueLanes?.length ? `监听 ${queueLanes.join('、')} 队列` : '监听通用队列'}，每 ${config.agentPollMs}ms 检查一次`);
  while (running) {
    try {
      const data = await claim([platformCode], { queueLanes });
      if (data.job) await processClaimedJob(data.job);
    } catch (error) {
      console.error(`[Agent:${name}] ${error.message}`);
    }
    if (running) await new Promise(resolve => setTimeout(resolve, config.agentPollMs));
  }
}

async function controlLoop() {
  while (running) {
    try {
      await heartbeat();
      consecutiveCloudControlFailures = 0;
      if (config.loginStatusPollEnabled && loginPollingGate.isDue()) {
        const runnableCodes = platformCoordinator.runnablePlatformCodes();
        const desiredCodes = loginPollingGate.eligible(runnableCodes);
        const pollableCodes = desiredCodes.filter(platformCode => !platformHasActiveJob(platformCode));
        const skippedBusyCodes = desiredCodes.filter(platformHasActiveJob);
        if (pollableCodes.length) {
          lastLoginPollAt = new Date().toISOString();
          loginPollingGate.markPolled();
          try {
            const statuses = await runPlatformBatch('check', { mode: 'POLL', platformCodes: pollableCodes });
          lastLoginPollSummary = Object.fromEntries(Object.entries(statuses).map(([code, status]) => [code, {
            state: status.state,
            confidence: status.confidence,
            checkedAt: status.checkedAt,
            confirmedSamples: status.confirmedSamples || 0
          }]));
            if (skippedBusyCodes.length) lastLoginPollSummary._skippedBusyPlatforms = skippedBusyCodes;
            console.log(`[Agent] 登录状态轮询完成：${Object.entries(statuses).map(([code, status]) => `${code}=${status.state}`).join(', ')}${skippedBusyCodes.length ? `；忙碌平台稍后检查：${skippedBusyCodes.join(', ')}` : ''}`);
          } catch (error) {
            lastLoginPollSummary = { error: error.message, skippedBusyPlatforms: skippedBusyCodes };
            console.error(`[Agent] 登录状态轮询失败：${error.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`[Agent] ${error.message}`);
      if (error.code === 'CLOUD_REQUEST_FAILED') {
        consecutiveCloudControlFailures += 1;
        console.error(`[Agent] Web control connection failed ${consecutiveCloudControlFailures}/${config.agentCloudFailureShutdownThreshold} (${error.cloudPathname || 'unknown endpoint'})`);
        if (consecutiveCloudControlFailures >= config.agentCloudFailureShutdownThreshold) {
          await shutdown('CLOUD_WEB_UNREACHABLE');
          break;
        }
      }
    }
    if (running) await new Promise(resolve => setTimeout(resolve, config.agentPollMs));
  }
}

async function loop() {
  const workerCodes = [...adapters.keys()].filter(code => !agentPlatformAllowlistSet || agentPlatformAllowlistSet.has(code));
  const workerPlans = workerCodes.flatMap(platformCode => platformWorkerPlans(platformCode, { splitEnabled: platformChannelSplitEnabled(platformCode) }));
  console.log(`[Agent] 启动按平台/通道隔离的并行 Worker：${workerPlans.map(item => item.name).join(', ')}`);
  await Promise.all([controlLoop(), ...workerPlans.map(platformWorkerLoop)]);
}

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.requestBodyMaxBytes) {
      const error = new Error('请求体过大'); error.statusCode = 413; error.code = 'REQUEST_BODY_TOO_LARGE'; throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('请求体必须使用 application/json'); error.statusCode = 415; error.code = 'JSON_CONTENT_TYPE_REQUIRED'; throw error;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('请求体不是有效 JSON'); error.statusCode = 400; error.code = 'INVALID_JSON'; throw error; }
}
function applyAgentCors(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  if (!config.agentAllowedOrigins.includes(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  return true;
}
function tokenMatches(supplied, expected) {
  const left = Buffer.from(String(supplied || '')); const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
function agentRequestAuthorized(req) {
  return !config.agentToken || tokenMatches(req.headers['x-agent-token'], config.agentToken);
}
function reply(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

const materialPreviews = new Map();
const previewMimeTypes = new Map([
  ['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.png','image/png'],['.webp','image/webp'],
  ['.mp4','video/mp4'],['.mov','video/quicktime']
]);

function registerMaterialPreview(materialPath, precheck) {
  if (!precheck?.exists || !['image','video'].includes(precheck.meta?.type)) return null;
  const token = randomUUID();
  materialPreviews.set(token, { path: path.resolve(materialPath), createdAt: Date.now() });
  for (const [key, value] of materialPreviews) {
    if (Date.now() - value.createdAt > 30 * 60 * 1000 || materialPreviews.size > 50) materialPreviews.delete(key);
  }
  return `/material-preview/${token}`;
}

function streamMaterialPreview(req, res, token) {
  const item = materialPreviews.get(token);
  const expired = item && Date.now() - item.createdAt > 30 * 60 * 1000;
  if (expired) materialPreviews.delete(token);
  if (!item || expired || !fs.existsSync(item.path)) return reply(res, 404, { ok: false, message: '???????????????' });
  const stat = fs.statSync(item.path);
  if (!stat.isFile()) return reply(res, 404, { ok: false, message: '?????????' });
  const contentType = previewMimeTypes.get(path.extname(item.path).toLowerCase()) || 'application/octet-stream';
  const range = req.headers.range;
  const common = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300' };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || stat.size <= 0) {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    let start;
    let end;
    if (!match[1]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      start = Math.max(stat.size - suffixLength, 0);
      end = stat.size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...common, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(item.path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...common, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(item.path).pipe(res);
}

let filePickerPromise = null;

async function pickFile() {
  if (process.platform !== 'win32') throw new Error('MVP \u539f\u751f\u6587\u4ef6\u9009\u62e9\u5668\u76ee\u524d\u4ec5\u652f\u6301 Windows');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NativeWindowHelper { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$owner = New-Object System.Windows.Forms.Form
$owner.Text = '\u6570\u5b57\u5458\u5de5\u8fd0\u8425\u5e73\u53f0 - \u672c\u5730\u7d20\u6750\u9009\u62e9'
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0.01
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '\u9009\u62e9\u8981\u53d1\u5e03\u7684\u672c\u5730\u7d20\u6750'
$dialog.Filter = '\u5a92\u4f53\u6587\u4ef6|*.jpg;*.jpeg;*.png;*.webp;*.mp4;*.mov|\u6240\u6709\u6587\u4ef6|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.RestoreDirectory = $true
try {
  $owner.Show()
  $owner.Activate()
  [NativeWindowHelper]::SetForegroundWindow($owner.Handle) | Out-Null
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}`;
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 5 * 60 * 1000 }
    );
    return stdout.trim();
  } catch (error) {
    if (error.killed || error.signal) throw new Error('\u6587\u4ef6\u9009\u62e9\u7a97\u53e3\u7b49\u5f85\u8d85\u65f6\uff0c\u8bf7\u91cd\u65b0\u70b9\u51fb\u201c\u9009\u62e9\u6587\u4ef6\u201d');
    throw new Error(`\u65e0\u6cd5\u6253\u5f00\u672c\u5730\u6587\u4ef6\u9009\u62e9\u7a97\u53e3\uff1a${error.message}`);
  }
}

function selectLocalFile() {
  if (!filePickerPromise) {
    filePickerPromise = pickFile().finally(() => { filePickerPromise = null; });
  }
  return filePickerPromise;
}

const localServer = http.createServer(async (req, res) => {
  if (!applyAgentCors(req, res)) return reply(res, 403, { ok: false, code: 'CORS_ORIGIN_DENIED', message: '请求来源不在允许列表中' });
  if (req.method === 'OPTIONS') return reply(res, 204, {});
  try {
    const requestUrl = new URL(req.url, `http://127.0.0.1:${config.agentPort}`);
    const previewMatch = requestUrl.pathname.match(/^\/material-preview\/([0-9a-f-]+)$/i);
    const isMaterialPreview = ['GET','HEAD'].includes(req.method) && Boolean(previewMatch);
    const isHealthCheck = req.method === 'GET' && requestUrl.pathname === '/health';
    if (!isHealthCheck && !isMaterialPreview && !agentRequestAuthorized(req)) {
      return reply(res, 401, { ok: false, code: 'AGENT_AUTH_REQUIRED', message: 'Local Agent \u9274\u6743\u5931\u8d25' });
    }
    if (isMaterialPreview) return streamMaterialPreview(req, res, previewMatch[1]);
    const scopedPlatformMatch = requestUrl.pathname.match(/^\/platforms\/([a-z_]+)\/(.+)$/);
    const scopedPlatformCode = scopedPlatformMatch?.[1];
    const scopedAction = scopedPlatformMatch?.[2];
    if (scopedPlatformCode && adapters.has(scopedPlatformCode) && scopedAction !== 'status') await requirePlatformRunning(scopedPlatformCode);
    const legacyXhsOperation = requestUrl.pathname.startsWith('/xiaohongshu/')
      && !['/xiaohongshu/status','/xiaohongshu/main-status'].includes(requestUrl.pathname);
    if (legacyXhsOperation) await requirePlatformRunning('xiaohongshu');
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, deviceId: config.deviceId, bindingId: agentBindingId, version: AGENT_VERSION, rpaMode: config.rpaMode, platformAllowlist: agentPlatformAllowlist, masterSwitchEnabled: platformCoordinator.masterSwitchEnabled, browserControl: browserController.capabilities(), ocrEnabled: config.ocrEnabled, ocrMode: config.qwenMode === 'online' && config.qwenApiKey ? 'ONLINE' : 'MANUAL_FALLBACK', loginMonitor: loginMonitorStatus() });
    if (req.method === 'POST' && req.url === '/control/shutdown') {
      const data = await readBody(req);
      running = false;
      reply(res, 202, { ok: true, shuttingDown: true, reason: data.reason || 'MASTER_SWITCH_OFF' });
      setImmediate(() => shutdown(data.reason || 'MASTER_SWITCH_OFF').catch(error => {
        console.error(`[Agent] Graceful shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/control/refresh') {
      await fetchPlatformRuntime();
      return reply(res, 200, {
        ok: true,
        masterSwitch: { enabled: platformCoordinator.masterSwitchEnabled },
        platforms: [...platformCoordinator.runtimeByCode.keys()].map(code => platformCoordinator.effectiveRuntime(code))
      });
    }
    if (req.method === 'GET' && req.url === '/platforms/login-monitor/status') return reply(res, 200, { ok: true, loginMonitor: loginMonitorStatus() });
    if (req.method === 'GET' && req.url === '/platforms/status') {
      const statuses = {};
      let runtime;
      try { runtime = await fetchPlatformRuntime(); }
      catch { runtime = new Map(); }
      for (const [platformCode, adapter] of adapters.entries()) {
        const platformState = platformCoordinator.effectiveRuntime(platformCode);
        statuses[platformCode] = isPlatformRunnable(platformState)
          ? (typeof adapter?.status === 'function' ? await adapter.status() : unavailableStatus(platformCode))
          : stoppedPlatformStatus(platformCode, platformState);
      }
      return reply(res, 200, { ok: true, statuses });
    }
    if (req.method === 'POST' && req.url === '/platforms/open-login') return reply(res, 200, { ok: true, statuses: await runPlatformBatch('open') });
    if (req.method === 'POST' && req.url === '/platforms/check-login') return reply(res, 200, { ok: true, statuses: await runPlatformBatch('check', { mode: 'MANUAL' }) });
    const platformStatusMatch = req.url.match(/^\/platforms\/([a-z_]+)\/status$/);
    if (req.method === 'GET' && platformStatusMatch) {
      const platformCode = platformStatusMatch[1]; const adapter = adapters.get(platformCode);
      const runtime = await currentPlatformRuntime(platformCode, { refresh: true });
      const status = isPlatformRunnable(runtime)
        ? (typeof adapter?.status === 'function' ? await adapter.status() : unavailableStatus(platformCode))
        : stoppedPlatformStatus(platformCode, runtime);
      return reply(res, 200, { ok: true, status });
    }
    const platformCheckMatch = req.url.match(/^\/platforms\/([a-z_]+)\/check-login$/);
    if (req.method === 'POST' && platformCheckMatch) {
      const platformCode = platformCheckMatch[1]; const adapter = adapters.get(platformCode);
      const status = await withGuardedPlatformOperation(platformCode, async () => typeof adapter?.checkLogin === 'function'
        ? checkLoginPrecisely({
          check: () => adapter.checkLogin({ preserveInteractiveLogin: true }),
          recheck: typeof adapter.recheckLogin === 'function' ? () => adapter.recheckLogin() : undefined,
          mode: 'MANUAL',
          logoutConfirmations: config.loginStatusLogoutConfirmations,
          confirmDelayMs: config.loginStatusConfirmDelayMs
        })
        : unavailableStatus(platformCode));
      await syncPlatformLoginStatus(platformCode, status);
      return reply(res, 200, { ok: true, status });
    }
    const platformOpenMatch = req.url.match(/^\/platforms\/([a-z_]+)\/open-login$/);
    if (req.method === 'POST' && platformOpenMatch) {
      const platformCode = platformOpenMatch[1]; const adapter = adapters.get(platformCode);
      loginPollingGate.activate(platformCode);
      if (typeof adapter?.openLogin !== 'function') return reply(res, 200, { ok: true, status: unavailableStatus(platformCode) });
      const status = await withGuardedPlatformOperation(platformCode, () => adapter.openLogin());
      return reply(res, 200, { ok: true, status });
    }
    const platformManualActionMatch = req.url.match(/^\/platforms\/([a-z_]+)\/open-manual-action$/);
    if (req.method === 'POST' && platformManualActionMatch) {
      const platformCode = platformManualActionMatch[1]; const adapter = adapters.get(platformCode);
      loginPollingGate.activate(platformCode);
      const openManualAction = typeof adapter?.openManualAction === 'function'
        ? () => adapter.openManualAction()
        : typeof adapter?.openLogin === 'function'
          ? () => adapter.openLogin()
          : null;
      if (!openManualAction) return reply(res, 200, { ok: true, status: unavailableStatus(platformCode) });
      const status = await withGuardedPlatformOperation(platformCode, openManualAction);
      return reply(res, 200, { ok: true, status });
    }
    const platformInspectTextMatch = req.url.match(/^\/platforms\/([a-z_]+)\/inspect-text$/);
    if (req.method === 'POST' && platformInspectTextMatch) {
      const platformCode = platformInspectTextMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.inspectText !== 'function') throw new Error(`\u5e73\u53f0 ${platformCode} \u9875\u9762\u6587\u5b57\u68c0\u67e5\u529f\u80fd\u4e0d\u53ef\u7528`);
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.inspectText(data.text)) });
    }
    const platformClickNavigationMatch = req.url.match(/^\/platforms\/([a-z_]+)\/click-navigation$/);
    if (req.method === 'POST' && platformClickNavigationMatch) {
      const platformCode = platformClickNavigationMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.clickNavigationText !== 'function') throw new Error(`\u5e73\u53f0 ${platformCode} \u5bfc\u822a\u70b9\u51fb\u529f\u80fd\u4e0d\u53ef\u7528`);
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.clickNavigationText(data.text)) });
    }
    const platformInspectStrangerMatch = req.url.match(/^\/platforms\/([a-z_]+)\/inspect-stranger-inbox$/);
    if (req.method === 'POST' && platformInspectStrangerMatch) {
      const platformCode = platformInspectStrangerMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.inspectStrangerInbox !== 'function') throw new Error(`\u5e73\u53f0 ${platformCode} \u964c\u751f\u4eba\u6536\u4ef6\u7bb1\u68c0\u67e5\u529f\u80fd\u4e0d\u53ef\u7528`);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.inspectStrangerInbox()) });
    }
    const platformInspectConversationMatch = req.url.match(/^\/platforms\/([a-z_]+)\/inspect-conversation$/);
    if (req.method === 'POST' && platformInspectConversationMatch) {
      const platformCode = platformInspectConversationMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.inspectConversation !== 'function') throw new Error(`\u5e73\u53f0 ${platformCode} \u79c1\u4fe1\u4f1a\u8bdd\u68c0\u67e5\u529f\u80fd\u4e0d\u53ef\u7528`);
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.inspectConversation(data.userName)) });
    }
    const platformInspectReplyTargetMatch = req.url.match(/^\/platforms\/([a-z_]+)\/inspect-reply-target$/);
    if (req.method === 'POST' && platformInspectReplyTargetMatch) {
      const platformCode = platformInspectReplyTargetMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.inspectReplyTarget !== 'function') throw new Error(`\u5e73\u53f0 ${platformCode} \u56de\u590d\u76ee\u6807\u68c0\u67e5\u529f\u80fd\u4e0d\u53ef\u7528`);
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.inspectReplyTarget(data)) });
    }
    const platformInspectUrlMatch = req.url.match(/^\/platforms\/([a-z_]+)\/inspect-url$/);
    if (req.method === 'POST' && platformInspectUrlMatch) {
      const platformCode = platformInspectUrlMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.inspectUrl !== 'function') throw new Error(`\u5e73\u53f0 ${platformCode} URL \u68c0\u67e5\u529f\u80fd\u4e0d\u53ef\u7528`);
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.inspectUrl(data.url)) });
    }
    if (req.method === 'POST' && req.url === '/platforms/bilibili/submit-existing-draft') {
      const adapter = adapters.get('bilibili');
      if (typeof adapter?.submitExistingDraft !== 'function') throw new Error('Bilibili existing draft submit is unavailable');
      const data = await readBody(req);
      const output = await withGuardedPlatformOperation('bilibili', () => adapter.submitExistingDraft(data));
      const shouldRecord = data.prepareOnly !== true && Number(data.targetId) > 0
        && (output?.result?.submitAttempted === true || output?.result?.reconciledBeforeSubmit === true);
      if (shouldRecord) {
        await cloud(`/api/agent/publish-targets/${Number(data.targetId)}/record-submit-result`, {
          method: 'POST',
          body: JSON.stringify({
            status: output.status,
            result: output.result,
            profileName: data.profileName || null,
            draftFingerprint: data.draftFingerprint || null
          })
        });
      }
      return reply(res, 200, { ok: true, output });
    }
    if (req.method === 'GET' && req.url === '/platforms/bilibili/inspect-message-api') {
      const adapter = adapters.get('bilibili');
      if (typeof adapter?.inspectMessageApi !== 'function') throw new Error('B\u7ad9\u6d88\u606f API \u8bca\u65ad\u80fd\u529b\u4e0d\u53ef\u7528');
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('bilibili', () => adapter.inspectMessageApi()) });
    }
    const platformDebugMatch = req.url.match(/^\/platforms\/([a-z_]+)\/debug$/);
    if (req.method === 'GET' && platformDebugMatch) {
      const platformCode = platformDebugMatch[1];
      const adapter = adapters.get(platformCode);
      if (typeof adapter?.debug !== 'function') throw new Error(`平台 ${platformCode} 页面检查功能不可用`);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation(platformCode, () => adapter.debug()) });
    }
    if (req.method === 'GET' && req.url === '/xiaohongshu/status') {
      const runtime = await currentPlatformRuntime('xiaohongshu', { refresh: true });
      if (!isPlatformRunnable(runtime)) return reply(res, 200, { ok: true, status: stoppedPlatformStatus('xiaohongshu', runtime) });
      const status = typeof xiaohongshuAdapter?.status === 'function'
        ? await xiaohongshuAdapter.status()
        : { browser: 'UNAVAILABLE', loggedIn: false, message: '\u5f53\u524d\u672a\u542f\u7528\u5c0f\u7ea2\u4e66\u4eba\u5de5\u786e\u8ba4\u6a21\u5f0f' };
      await syncXiaohongshuLoginStatus(status);
      return reply(res, 200, { ok: true, status });
    }
    if (req.method === 'GET' && req.url === '/xiaohongshu/debug') {
      if (typeof xiaohongshuAdapter?.debug !== 'function') throw new Error('当前未启用小红书人工确认模式');
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.debug()) });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/inspect-url') {
      if (typeof xiaohongshuAdapter?.inspectUrl !== 'function') throw new Error('xiaohongshu adapter unavailable');
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.inspectUrl(data.url)) });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/inspect') {
      if (typeof xiaohongshuAdapter?.inspectSection !== 'function') throw new Error('小红书页面检查功能不可用');
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.inspectSection(data.targetText)) });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/open-login') {
      if (typeof xiaohongshuAdapter?.openLogin !== 'function') throw new Error('请先将 RPA_MODE 配置为 xiaohongshu_assisted');
      const status = await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.openLogin());
      await syncXiaohongshuLoginStatus(status);
      return reply(res, 200, { ok: true, status });
    }
    if (req.method === 'GET' && req.url === '/xiaohongshu/main-status') {
      const runtime = await currentPlatformRuntime('xiaohongshu', { refresh: true });
      if (!isPlatformRunnable(runtime)) return reply(res, 200, { ok: true, status: stoppedPlatformStatus('xiaohongshu', runtime) });
      if (typeof xiaohongshuAdapter?.mainSiteStatus !== 'function') throw new Error('\u5c0f\u7ea2\u4e66\u4e3b\u7ad9\u72b6\u6001\u68c0\u67e5\u529f\u80fd\u4e0d\u53ef\u7528');
      return reply(res, 200, { ok: true, status: await xiaohongshuAdapter.mainSiteStatus() });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/open-main-site') {
      if (typeof xiaohongshuAdapter?.openMainSite !== 'function') throw new Error('当前未启用小红书主站自动化模式');
      return reply(res, 200, { ok: true, status: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.openMainSite()) });
    }
    if (req.method === 'GET' && req.url === '/xiaohongshu/main-debug') {
      if (typeof xiaohongshuAdapter?.debugMain !== 'function') throw new Error('小红书主站检查功能不可用');
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.debugMain()) });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/main-inspect-url') {
      if (typeof xiaohongshuAdapter?.inspectMainUrl !== 'function') throw new Error('小红书主站页面检查功能不可用');
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.inspectMainUrl(data.url)) });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/inspect-comment-reply') {
      if (typeof xiaohongshuAdapter?.inspectCommentReply !== 'function') throw new Error('小红书评论回复检查功能不可用');
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.inspectCommentReply(data)) });
    }
    if (req.method === 'POST' && req.url === '/xiaohongshu/inspect-conversation') {
      if (typeof xiaohongshuAdapter?.inspectConversation !== 'function') throw new Error('小红书私信会话检查功能不可用');
      const data = await readBody(req);
      return reply(res, 200, { ok: true, debug: await withGuardedPlatformOperation('xiaohongshu', () => xiaohongshuAdapter.inspectConversation(data)) });
    }
    if (req.method === 'POST' && req.url === '/pick-file') {
      const materialPath = await selectLocalFile();
      return reply(res, 200, { ok: true, materialPath, cancelled: !materialPath });
    }
    if (req.method === 'POST' && req.url === '/precheck') {
      const data = await readBody(req);
      const precheck = await precheckMaterial(data);
      const previewUrl = registerMaterialPreview(data.materialPath, precheck);
      return reply(res, 200, { ok: true, precheck, previewUrl });
    }
    if (req.method === 'POST' && req.url === '/ai-review') {
      const data = await readBody(req);
      const precheck = await precheckMaterial({ materialPath: data.materialPath, platforms: [] });
      if (!precheck.exists || !['image', 'video'].includes(precheck.meta?.type)) {
        return reply(res, 400, { ok: false, message: precheck.message || '当前素材不支持 AI 图片审核' });
      }
      const suppliedSha = String(data.precheck?.meta?.sha256 || '').toLowerCase();
      const actualSha = String(precheck.meta?.sha256 || '').toLowerCase();
      if (suppliedSha && suppliedSha !== actualSha) {
        return reply(res, 409, { ok: false, message: '素材文件已发生变化，请先重新检测素材格式' });
      }
      const ai = await runtimeAiSettings();
      const review = await reviewMaterialWithAi({
        title: data.title, body: data.body, contentOrigin: data.contentOrigin,
        materialPath: data.materialPath, precheck, force: data.force === true,
        mode: ai.mode, model: ai.model || config.aiReviewModel, apiKey: ai.apiKey, baseUrl: ai.baseUrl
      });
      await reportAiUsage({ taskType: 'CONTENT_REVIEW', taskId: data.taskId || null, sourceModule: 'local-agent-material-review', mode: ai.mode, model: review.model || ai.model || config.aiReviewModel, status: review.status === 'SUCCESS' ? 'SUCCESS' : ai.mode === 'mock' ? 'SUCCESS' : 'FAILED', usage: review.usage || null, durationMs: review.elapsedMs || 0, errorCode: review.status === 'SUCCESS' ? null : 'AI_REVIEW_FAILED', errorMessage: review.status === 'SUCCESS' ? null : review.summary || review.message || 'AI 素材审核失败' });
      return reply(res, 200, { ok: true, review });
    }
    if (req.method === 'POST' && req.url === '/traffic-prediction') {
      const data = await readBody(req);
      const platformCodes = Array.isArray(data.platformCodes) ? data.platformCodes : [];
      if (!platformCodes.length) {
        return reply(res, 400, { ok: false, message: '请至少选择一个发布平台后再生成内容潜力评分', code: 'TRAFFIC_PLATFORM_REQUIRED' });
      }
      const precheck = await precheckMaterial({ materialPath: data.materialPath, platforms: [] });
      if (!precheck.exists || !['image', 'video'].includes(precheck.meta?.type)) {
        return reply(res, 400, { ok: false, message: precheck.message || '当前素材不支持内容潜力评估', code: 'TRAFFIC_MATERIAL_UNSUPPORTED' });
      }
      const suppliedSha = String(data.precheck?.meta?.sha256 || data.materialSha256 || '').toLowerCase();
      const actualSha = String(precheck.meta?.sha256 || '').toLowerCase();
      if (suppliedSha && suppliedSha !== actualSha) {
        return reply(res, 409, { ok: false, message: '素材文件已发生变化，请先重新检测素材格式', code: 'MATERIAL_SHA_CHANGED' });
      }
      const ai = await runtimeAiSettings();
      const prediction = await predictMaterialTraffic({
        title: data.title,
        body: data.body,
        contentOrigin: data.contentOrigin,
        platformCodes,
        materialMeta: precheck.meta,
        contentContext: data.contentContext || {},
        aiReview: data.aiReview || {},
        force: data.force === true,
        mode: ai.mode,
        model: ai.trafficPredictionModel || ai.model || config.trafficPredictionModel,
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl
      });
      await reportAiUsage({
        taskType: 'MATERIAL_TRAFFIC_PREDICTION',
        taskId: data.taskId || null,
        sourceModule: 'local-agent-material-traffic-prediction',
        mode: ai.mode,
        model: prediction.model || ai.trafficPredictionModel || ai.model || config.trafficPredictionModel,
        status: prediction.status === 'SUCCESS' ? 'SUCCESS' : ai.mode === 'mock' ? 'SUCCESS' : 'FAILED',
        usage: prediction.usage || null,
        durationMs: prediction.elapsedMs || 0,
        errorCode: prediction.status === 'SUCCESS' ? null : prediction.code || 'TRAFFIC_PREDICTION_FAILED',
        errorMessage: prediction.status === 'SUCCESS' ? null : prediction.message || '平台内容潜力预测失败'
      });
      return reply(res, 200, { ok: true, prediction });
    }
    if (req.method === 'POST' && ['/material-content-generation', '/audio-content-generation'].includes(req.url)) {
      const data = await readBody(req);
      const precheck = await precheckMaterial({ materialPath: data.materialPath, platforms: [] });
      const sourceType = precheck.meta?.type;
      if (!precheck.exists || !['image', 'video'].includes(sourceType)) {
        return reply(res, 400, { ok: false, message: precheck.message || '只有图片或视频素材可生成标题和文案', code: 'MATERIAL_TYPE_UNSUPPORTED' });
      }
      if (sourceType === 'video' && precheck.meta?.hasAudio !== true) {
        return reply(res, 400, { ok: false, message: '视频中未检测到音轨，无法根据音频生成文案', code: 'MATERIAL_AUDIO_MISSING' });
      }
      if (sourceType === 'video' && (!Number.isFinite(Number(precheck.meta?.durationSeconds)) || Number(precheck.meta.durationSeconds) <= 0)) {
        return reply(res, 400, { ok: false, message: '无法确认视频时长，请重新检测素材格式', code: 'MATERIAL_DURATION_UNKNOWN' });
      }
      if (sourceType === 'video' && Number(precheck.meta.durationSeconds) > config.audioMaxDurationSeconds) {
        return reply(res, 400, { ok: false, message: '视频时长超过 ' + config.audioMaxDurationSeconds + ' 秒上限', code: 'MATERIAL_DURATION_EXCEEDED' });
      }
      const suppliedSha = String(data.precheck?.meta?.sha256 || data.materialSha256 || '').toLowerCase();
      const actualSha = String(precheck.meta?.sha256 || '').toLowerCase();
      if (suppliedSha && suppliedSha !== actualSha) {
        return reply(res, 409, { ok: false, message: '素材文件已发生变化，请先重新检测素材格式', code: 'MATERIAL_SHA_CHANGED' });
      }
      const ai = await runtimeAiSettings();
      const platformCodes = Array.isArray(data.platformCodes) ? data.platformCodes : [];
      const generation = sourceType === 'image'
        ? await generateMaterialCopyFromImage({
          materialPath: data.materialPath,
          precheck,
          platformCodes,
          force: data.force === true,
          previousCopy: data.previousCopy || null,
          generationNonce: data.generationNonce || (data.force === true ? randomUUID() : ''),
          mode: ai.mode,
          contentModel: ai.imageContentModel || ai.model || config.imageContentModel,
          apiKey: ai.apiKey,
          baseUrl: ai.baseUrl
        })
        : await generateMaterialCopyFromAudio({
          materialPath: data.materialPath,
          precheck,
          platformCodes,
          force: data.force === true,
          previousCopy: data.previousCopy || null,
          generationNonce: data.generationNonce || (data.force === true ? randomUUID() : ''),
          mode: ai.mode,
          asrModel: ai.asrModel || config.audioAsrModel,
          knowledgeOnly: data.knowledgeOnly === true,
          contentModel: ai.contentModel || config.audioContentModel,
          apiKey: ai.apiKey,
          baseUrl: ai.baseUrl
        });
      const usageLogs = sourceType === 'image'
        ? [['MATERIAL_IMAGE_CONTENT_GENERATION', 'local-agent-material-image-copy-generation', generation.calls?.content, ai.imageContentModel || ai.model || config.imageContentModel]]
        : [
          ['MATERIAL_AUDIO_TRANSCRIPTION', 'local-agent-material-audio-asr', generation.calls?.asr, ai.asrModel || config.audioAsrModel],
          ['MATERIAL_COPY_GENERATION', 'local-agent-material-copy-generation', generation.calls?.content, ai.contentModel || config.audioContentModel],
          ['MATERIAL_KNOWLEDGE_GENERATION', 'local-agent-material-knowledge-generation', generation.calls?.knowledge, ai.contentModel || config.audioContentModel]
        ];
      await Promise.all(usageLogs.map(([taskType, sourceModule, call, fallbackModel]) => reportAiUsage({
        taskType,
        taskId: data.taskId || null,
        sourceModule,
        mode: ai.mode,
        model: call?.model || fallbackModel,
        status: call?.status === 'SUCCESS' ? 'SUCCESS' : call?.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
        usage: call?.usage || null,
        durationMs: call?.elapsedMs || 0,
        errorCode: call?.errorCode || null,
        errorMessage: call?.errorMessage || null
      })));
      return reply(res, 200, { ok: true, generation });
    }
    if (req.method === 'POST' && req.url === '/ocr') {
      const data = await readBody(req);
      const precheck = data.precheck?.meta ? data.precheck : await precheckMaterial({ materialPath: data.materialPath, platforms: [] });
      if (!precheck.exists || !['image', 'video'].includes(precheck.meta?.type)) {
        return reply(res, 400, { ok: false, message: precheck.message || '当前素材不支持 OCR 识别' });
      }
      const ai = await runtimeAiSettings();
      const ocr = await recognizeMaterialText({ materialPath: data.materialPath, precheck, force: data.force === true, mode: ai.mode, model: ai.visionModel, apiKey: ai.apiKey, baseUrl: ai.baseUrl });
      await reportAiUsage({ taskType: 'OCR', taskId: data.taskId || null, sourceModule: 'local-agent-ocr', mode: ai.mode, model: ocr.model || ai.visionModel, status: ocr.status === 'SUCCESS' || ocr.status === 'NO_TEXT' ? 'SUCCESS' : ocr.status === 'UNAVAILABLE' ? 'SKIPPED' : 'FAILED', usage: ocr.usage || null, durationMs: ocr.elapsedMs || 0, errorCode: ['SUCCESS','NO_TEXT'].includes(ocr.status) ? null : `OCR_${ocr.status}`, errorMessage: ['SUCCESS','NO_TEXT'].includes(ocr.status) ? null : ocr.message });
      return reply(res, 200, { ok: true, ocr });
    }
    return reply(res, 404, { ok: false, message: '本地 Agent 接口不存在' });
  } catch (error) {
    return reply(res, error.statusCode || (['PLATFORM_STOPPED', 'PLATFORM_OPERATION_CANCELLED'].includes(error.code) ? 409 : 500), { ok: false, message: error.message, code: error.code || 'LOCAL_AGENT_ERROR', runtime: error.runtime || null });
  }
});

const agentInstanceLock = acquireInstanceLock(path.join(ROOT, 'logs', `agent-${config.agentPort}.lock`), { enabled: config.instanceLockEnabled, label: 'local-agent' });
localServer.on('error', error => { agentInstanceLock.release(); console.error(`[Agent] 启动失败：${error.message}`); });
localServer.listen(config.agentPort, config.agentHost, () => {
  console.log(`Local Agent 已启动：http://${config.agentHost}:${config.agentPort}`);
  console.log(`设备：${config.deviceId}，RPA 模式：${config.rpaMode}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  loginPollingGate.clear();
  console.log(`[Agent] Received ${signal}; stop claiming jobs and close all platform browser contexts`);
  await stopPlatformsImmediately([...adapters.keys()]);
  await browserController.stop();
  await new Promise(resolve => localServer.close(resolve));
  agentInstanceLock.release();
  process.exitCode = 0;
}
process.on('exit', () => agentInstanceLock.release());
process.on('SIGINT', () => { shutdown('SIGINT').catch(error => { console.error(error); process.exitCode = 1; }); });
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(error => { console.error(error); process.exitCode = 1; }); });
loop().catch(error => { console.error(`[Agent] 主循环异常：${error.message}`); process.exitCode = 1; });
