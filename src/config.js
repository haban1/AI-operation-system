import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSINESS_GUIDANCE_MAX_ATTEMPTS } from './services/conversation-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const runningUnderNodeTest = Boolean(process.env.NODE_TEST_CONTEXT);
if (process.env.NODE_ENV !== 'test' && !runningUnderNodeTest) loadEnvFile();

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanEnv(name, fallback = true) {
  if (!(name in process.env)) return fallback;
  return !['false', '0', 'off', 'no'].includes(String(process.env[name]).trim().toLowerCase());
}

const messageCollectMinIntervalMs = Math.max(15_000, numberEnv('MESSAGE_COLLECT_MIN_INTERVAL_MS', 5 * 60 * 1000));
const messageCollectMaxIntervalMs = Math.max(messageCollectMinIntervalMs, numberEnv('MESSAGE_COLLECT_MAX_INTERVAL_MS', 6 * 60 * 1000));
const splitEnv = (name, fallback = '') => String(process.env[name] ?? fallback).split(',').map(item => item.trim()).filter(Boolean);
const ragBaseUrl = String(process.env.RAG_BASE_URL || '').trim().replace(/\/$/, '');

export const config = {
  modelGatewayToken: process.env.TIANHE_MODEL_TOKEN || '',
  aiSignalStudioUrl: String(process.env.AI_SIGNAL_STUDIO_URL || '').trim(),
  aiSignalStudioHealthUrl: String(process.env.AI_SIGNAL_STUDIO_HEALTH_URL || '').trim(),
  aiSignalStudioInternalUrl: String(process.env.AI_SIGNAL_STUDIO_INTERNAL_URL || '').trim(),
  videoEditingUrl: String(process.env.VIDEO_EDITING_URL || '').trim(),
  videoEditingHealthUrl: String(process.env.VIDEO_EDITING_HEALTH_URL || '').trim(),
  aigcCreationUrl: String(process.env.AIGC_CREATION_URL || '').trim(),
  aigcCreationHealthUrl: String(process.env.AIGC_CREATION_HEALTH_URL || '').trim(),
  contentLibrarySignalRoot: String(process.env.CONTENT_LIBRARY_SIGNAL_ROOT || '').trim(),
  contentLibraryEditingRoot: String(process.env.CONTENT_LIBRARY_EDITING_ROOT || '').trim(),
  contentLibraryCreationRoot: String(process.env.CONTENT_LIBRARY_CREATION_ROOT || '').trim(),
  contentLibraryDir: path.resolve(ROOT, process.env.CONTENT_LIBRARY_DIR || path.join(path.dirname(process.env.DATABASE_PATH || './data/mvp.db'), 'content-library')),
  contentLibrarySeedRoot: path.resolve(ROOT, process.env.CONTENT_LIBRARY_SEED_ROOT || 'bundled/content-library'),
  contentLibrarySeedEnabled: booleanEnv('CONTENT_LIBRARY_SEED_ENABLED', true),
  contentLibraryMaxFileBytes: Math.max(1024, Math.min(20 * 1024 ** 3, numberEnv('CONTENT_LIBRARY_MAX_FILE_BYTES', 2 * 1024 ** 3))),
  wechatRobotAdminUrl: process.env.WECHAT_ROBOT_ADMIN_URL || '',
  wechatRobotAdminFollowHost: booleanEnv('WECHAT_ROBOT_ADMIN_FOLLOW_HOST', false),
  port: numberEnv('PORT', 3100),
  host: process.env.SERVER_HOST || '127.0.0.1',
  agentPort: numberEnv('AGENT_PORT', 17831),
  agentHost: process.env.AGENT_HOST || '127.0.0.1',
  allowedOrigins: splitEnv('ALLOWED_ORIGINS', 'http://127.0.0.1:3100,http://localhost:3100'),
  agentAllowedOrigins: splitEnv('AGENT_ALLOWED_ORIGINS', 'http://127.0.0.1:3100,http://localhost:3100'),
  requestBodyMaxBytes: Math.max(64 * 1024, numberEnv('REQUEST_BODY_MAX_BYTES', 2_000_000)),
  authEnabled: booleanEnv('AUTH_ENABLED', false),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionTtlMs: Math.max(15 * 60 * 1000, numberEnv('SESSION_TTL_MS', 12 * 60 * 60 * 1000)),
  sessionCookieSecure: booleanEnv('SESSION_COOKIE_SECURE', false),
  agentToken: process.env.AGENT_SHARED_TOKEN || '',
  sqliteBusyTimeoutMs: Math.max(1_000, numberEnv('SQLITE_BUSY_TIMEOUT_MS', 15_000)),
  sqliteBusyRetries: Math.max(0, Math.min(10, numberEnv('SQLITE_BUSY_RETRIES', 4))),
  sqliteBusyRetryDelayMs: Math.max(5, numberEnv('SQLITE_BUSY_RETRY_DELAY_MS', 50)),
  instanceLockEnabled: booleanEnv('INSTANCE_LOCK_ENABLED', true),
  channelSplitEnabled: booleanEnv('CHANNEL_SPLIT_ENABLED', false),
  messageEventLedgerEnabled: booleanEnv('MESSAGE_EVENT_LEDGER_ENABLED', false),
  privateReconciliationEnabled: booleanEnv('PRIVATE_RECONCILIATION_ENABLED', false),
  privateLiveRecheckEnabled: booleanEnv('PRIVATE_LIVE_RECHECK_ENABLED', false),
  privateAutoSendV2Enabled: booleanEnv('PRIVATE_AUTO_SEND_V2_ENABLED', false),
  commentChannelV2Enabled: booleanEnv('COMMENT_CHANNEL_V2_ENABLED', false),
  syncHealthUiEnabled: booleanEnv('SYNC_HEALTH_UI_ENABLED', false),
  platformChannelSplitDouyin: booleanEnv('PLATFORM_CHANNEL_SPLIT_DOUYIN', false),
  platformChannelSplitXiaohongshu: booleanEnv('PLATFORM_CHANNEL_SPLIT_XIAOHONGSHU', false),
  platformChannelSplitWechatChannels: booleanEnv('PLATFORM_CHANNEL_SPLIT_WECHAT_CHANNELS', false),
  platformChannelSplitBilibili: booleanEnv('PLATFORM_CHANNEL_SPLIT_BILIBILI', false),
  platformChannelSplitWeibo: booleanEnv('PLATFORM_CHANNEL_SPLIT_WEIBO', false),
  localAgentAutoStart: process.env.LOCAL_AGENT_AUTO_START !== 'false',
  localAgentStartTimeoutMs: Math.max(1_000, numberEnv('LOCAL_AGENT_START_TIMEOUT_MS', 10_000)),
  localAgentWatchdogIntervalMs: Math.max(2_000, numberEnv('LOCAL_AGENT_WATCHDOG_INTERVAL_MS', 5_000)),
  localAgentEntryPath: path.resolve(ROOT, process.env.LOCAL_AGENT_ENTRY || './agent/local-agent.js'),
  cloudBaseUrl: process.env.CLOUD_BASE_URL || 'http://127.0.0.1:3100',
  deviceId: process.env.DEVICE_ID || 'device-rpa-01',
  databasePath: path.resolve(ROOT, process.env.DATABASE_PATH || './data/mvp.db'),
  qwenMode: process.env.QWEN_MODE || 'mock',
  qwenApiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
  qwenBaseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, ''),
  qwenModel: process.env.QWEN_MODEL || 'qwen3.7-plus',
  qwenVisionModel: process.env.QWEN_VISION_MODEL || 'qwen3.5-ocr',
  audioContentGenerationEnabled: booleanEnv('AI_AUDIO_CONTENT_GENERATION_ENABLED', true),
  audioContentAutoTrigger: booleanEnv('AI_AUDIO_CONTENT_AUTO_TRIGGER', true),
  audioAsrModel: process.env.QWEN_ASR_MODEL || 'qwen3-asr-flash',
  audioContentModel: process.env.QWEN_CONTENT_MODEL || process.env.QWEN_MODEL || 'qwen3.7-plus',
  imageContentModel: process.env.QWEN_IMAGE_CONTENT_MODEL || process.env.QWEN_MODEL || 'qwen3.7-plus',
  trafficPredictionEnabled: booleanEnv('AI_TRAFFIC_PREDICTION_ENABLED', true),
  trafficPredictionModel: process.env.QWEN_TRAFFIC_PREDICTION_MODEL || process.env.QWEN_MODEL || 'qwen3.7-plus',
  trafficPredictionTimeoutMs: Math.max(10_000, numberEnv('AI_TRAFFIC_PREDICTION_TIMEOUT_MS', 45_000)),
  audioMaxDurationSeconds: Math.max(30, numberEnv('AI_AUDIO_MAX_DURATION_SECONDS', 300)),
  audioMaxBytes: Math.max(256 * 1024, numberEnv('AI_AUDIO_MAX_BYTES', 10 * 1024 * 1024)),
  audioExtractTimeoutMs: Math.max(5_000, numberEnv('AI_AUDIO_EXTRACT_TIMEOUT_MS', 30_000)),
  audioAsrTimeoutMs: Math.max(10_000, numberEnv('AI_ASR_TIMEOUT_MS', 60_000)),
  audioContentTimeoutMs: Math.max(10_000, numberEnv('AI_CONTENT_TIMEOUT_MS', 30_000)),
  audioKnowledgeTimeoutMs: Math.max(10_000, numberEnv('AI_KNOWLEDGE_TIMEOUT_MS', 60_000)),
  audioTotalTimeoutMs: Math.max(30_000, Math.min(110_000, numberEnv('AI_AUDIO_TOTAL_TIMEOUT_MS', 110_000))),
  audioCacheMaxAgeMs: Math.max(60_000, numberEnv('AI_AUDIO_CACHE_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000)),
  aiReviewEnabled: process.env.AI_REVIEW_ENABLED !== 'false',
  aiReviewModel: process.env.AI_REVIEW_MODEL || process.env.QWEN_MODEL || 'qwen3.7-plus',
  aiReviewTimeoutMs: Math.max(15_000, numberEnv('AI_REVIEW_TIMEOUT_MS', 120_000)),
  aiReviewMaxAgeMs: Math.max(5 * 60 * 1000, numberEnv('AI_REVIEW_MAX_AGE_MS', 24 * 60 * 60 * 1000)),
  ocrEnabled: process.env.OCR_ENABLED !== 'false',
  ocrTimeoutMs: Math.max(10_000, numberEnv('OCR_TIMEOUT_MS', 90_000)),
  ocrMaxImageEdge: Math.max(800, numberEnv('OCR_MAX_IMAGE_EDGE', 1600)),
  ocrVideoFrameCount: Math.max(3, Math.min(5, numberEnv('OCR_VIDEO_FRAME_COUNT', 5))),
  autoReplyThreshold: numberEnv('AUTO_REPLY_THRESHOLD', 0.58),
  businessGuidanceMaxAttempts: Math.max(1, Math.min(20, numberEnv('BUSINESS_GUIDANCE_MAX_ATTEMPTS', BUSINESS_GUIDANCE_MAX_ATTEMPTS))),
  wecomWebhookUrl: process.env.WECOM_WEBHOOK_URL || '',
  rpaMode: process.env.RPA_MODE || 'simulated',
  ragBaseUrl,
  ragFormalRoutingEnabled: booleanEnv('RAG_FORMAL_ROUTING_ENABLED', Boolean(ragBaseUrl)),
  ragAdminEnabled: booleanEnv('RAG_ADMIN_ENABLED', Boolean(ragBaseUrl)),
  ragKnowledgeBaseId: process.env.RAG_KNOWLEDGE_BASE_ID || 'main-business-kb',
  ragUploadMaxBytes: Math.max(1024 * 1024, numberEnv('RAG_UPLOAD_MAX_BYTES', 50 * 1024 * 1024)),
  ragToken: process.env.RAG_TOKEN || '',
  ragTimeoutMs: Math.max(1_000, numberEnv('RAG_TIMEOUT_MS', 90_000)),
  miniProgramApiEnabled: booleanEnv('MINI_PROGRAM_API_ENABLED', false),
  miniProgramAppId: String(process.env.MINI_PROGRAM_APP_ID || '').trim(),
  miniProgramSharedSecret: String(process.env.MINI_PROGRAM_SHARED_SECRET || ''),
  miniProgramCallbackUrl: String(process.env.MINI_PROGRAM_CALLBACK_URL || '').trim(),
  miniProgramCallbackTimeoutMs: Math.max(1_000, Math.min(30_000, numberEnv('MINI_PROGRAM_CALLBACK_TIMEOUT_MS', 12_000))),
  aiPageAdjudicationMode: 'shadow',
  aiDirectPublishAllowed: false,
  aiFinalClickAllowed: false,
  publishStatusPollingEnabled: false,
  browserControlEnabled: booleanEnv('BROWSER_CONTROL_ENABLED', false),
  browserControlMode: process.env.BROWSER_CONTROL_MODE || 'web_access_primary',
  browserControlProvider: process.env.BROWSER_CONTROL_PROVIDER || 'web_access_cdp',
  browserControlPrimaryProvider: process.env.BROWSER_CONTROL_PRIMARY_PROVIDER || 'web_access_cdp',
  browserControlFallbackProvider: process.env.BROWSER_CONTROL_FALLBACK_PROVIDER || 'playwright',
  browserControlLegacyFallbackEnabled: booleanEnv('BROWSER_CONTROL_LEGACY_FALLBACK_ENABLED', true),
  browserControlEnabledPlatforms: splitEnv('BROWSER_CONTROL_ENABLED_PLATFORMS', ''),
  browserControlInteractiveEnabled: booleanEnv('BROWSER_CONTROL_INTERACTIVE_ENABLED', false),
  browserControlRiskAcknowledged: booleanEnv('BROWSER_CONTROL_RISK_ACKNOWLEDGED', false),
  browserControlCdpProxyPort: Math.max(1024, Math.min(65530, numberEnv('BROWSER_CONTROL_CDP_PROXY_PORT', 3456))),
  browserControlBrowserDebugBasePort: Math.max(1024, Math.min(65530, numberEnv('BROWSER_CONTROL_BROWSER_DEBUG_BASE_PORT', 9310))),
  browserControlBrowser: process.env.BROWSER_CONTROL_BROWSER || 'chrome',
  browserControlProxyAutoStart: booleanEnv('BROWSER_CONTROL_PROXY_AUTO_START', true),
  browserControlRequestTimeoutMs: Math.max(2_000, numberEnv('BROWSER_CONTROL_REQUEST_TIMEOUT_MS', 30_000)),
  browserControlTabIdleTimeoutMs: Math.max(60_000, numberEnv('BROWSER_CONTROL_TAB_IDLE_TIMEOUT_MS', 15 * 60 * 1000)),
  browserControlAllowedHosts: splitEnv('BROWSER_CONTROL_ALLOWED_HOSTS', ''),
  browserControlEvidenceDir: path.resolve(ROOT, process.env.BROWSER_CONTROL_EVIDENCE_DIR || './logs/browser-control'),
  browserControlFileRoots: splitEnv('BROWSER_CONTROL_FILE_ROOTS', './data/uploads,./data/materials').map(item => path.resolve(ROOT, item)),
  activePlatformCodes: ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'],
  plannedPlatformCodes: [],
  supportedPlatformCodes: ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'],
  chromeExecutablePath: process.env.CHROME_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  xhsProfileDir: path.resolve(ROOT, process.env.XHS_PROFILE_DIR || './data/browser-profiles/profile-xhs-main'),
  xhsCreatorUrl: process.env.XHS_CREATOR_URL || 'https://creator.xiaohongshu.com/publish/publish',
  xhsManageUrl: process.env.XHS_MANAGE_URL || 'https://creator.xiaohongshu.com/new/note-manager',
  xhsCommentUrl: process.env.XHS_COMMENT_URL || 'https://www.xiaohongshu.com/notification',
  xhsMessageUrl: process.env.XHS_MESSAGE_URL || 'https://www.xiaohongshu.com/chat',
  xhsLoginTimeoutMs: numberEnv('XHS_LOGIN_TIMEOUT_MS', 10 * 60 * 1000),
  xhsSendTimeoutMs: numberEnv('XHS_SEND_TIMEOUT_MS', 30 * 60 * 1000),
  assistedLoginTimeoutMs: numberEnv('ASSISTED_LOGIN_TIMEOUT_MS', 10 * 60 * 1000),
  assistedSendTimeoutMs: numberEnv('ASSISTED_SEND_TIMEOUT_MS', 3 * 60 * 1000),
  publishUploadMinTimeoutMs: Math.max(60_000, numberEnv('PUBLISH_UPLOAD_MIN_TIMEOUT_MS', 10 * 60 * 1000)),
  publishUploadMaxTimeoutMs: Math.max(60_000, numberEnv('PUBLISH_UPLOAD_MAX_TIMEOUT_MS', 30 * 60 * 1000)),
  publishUploadMinBytesPerSecond: Math.max(32 * 1024, numberEnv('PUBLISH_UPLOAD_MIN_BYTES_PER_SECOND', 256 * 1024)),
  publishUploadProcessingGraceMs: Math.max(0, numberEnv('PUBLISH_UPLOAD_PROCESSING_GRACE_MS', 3 * 60 * 1000)),
  agentJobLeaseMs: Math.max(60_000, numberEnv('AGENT_JOB_LEASE_MS', 10 * 60 * 1000)),
  agentPublishJobLeaseMs: Math.max(10 * 60 * 1000, numberEnv('AGENT_PUBLISH_JOB_LEASE_MS', 45 * 60 * 1000)),
  platformRpa: {
    douyin: {
      profileDir: path.resolve(ROOT, process.env.DOUYIN_PROFILE_DIR || './data/browser-profiles/profile-douyin-main'),
      publishUrl: process.env.DOUYIN_PUBLISH_URL || 'https://creator.douyin.com/creator-micro/content/upload',
      manageUrl: process.env.DOUYIN_MANAGE_URL || 'https://creator.douyin.com/creator-micro/content/manage',
      commentUrl: process.env.DOUYIN_COMMENT_URL || 'https://creator.douyin.com/creator-micro/data/following/comment',
      messageUrl: process.env.DOUYIN_MESSAGE_URL || 'https://www.douyin.com/user/self'
    },
    wechat_channels: {
      profileDir: path.resolve(ROOT, process.env.CHANNELS_PROFILE_DIR || './data/browser-profiles/profile-channels-main'),
      publishUrl: process.env.CHANNELS_PUBLISH_URL || 'https://channels.weixin.qq.com/platform/post/create',
      manageUrl: process.env.CHANNELS_MANAGE_URL || 'https://channels.weixin.qq.com/platform/post/list',
      commentUrl: process.env.CHANNELS_COMMENT_URL || 'https://channels.weixin.qq.com/platform/interaction/comment',
      messageUrl: process.env.CHANNELS_MESSAGE_URL || 'https://channels.weixin.qq.com/platform/private_msg'
    },
    bilibili: {
      profileDir: path.resolve(ROOT, process.env.BILIBILI_PROFILE_DIR || './data/browser-profiles/profile-bilibili-main'),
      publishUrl: process.env.BILIBILI_PUBLISH_URL || 'https://member.bilibili.com/platform/upload/video/frame',
      manageUrl: process.env.BILIBILI_MANAGE_URL || 'https://member.bilibili.com/platform/upload-manager/article',
      commentUrl: process.env.BILIBILI_COMMENT_URL || 'https://message.bilibili.com/#/reply',
      messageUrl: process.env.BILIBILI_MESSAGE_URL || 'https://message.bilibili.com/#/whisper'
    },
    weibo: {
      profileDir: path.resolve(ROOT, process.env.WEIBO_PROFILE_DIR || './data/browser-profiles/profile-weibo-main'),
      publishUrl: process.env.WEIBO_PUBLISH_URL || 'https://weibo.com/',
      manageUrl: process.env.WEIBO_MANAGE_URL || 'https://weibo.com/',
      commentUrl: process.env.WEIBO_COMMENT_URL || 'https://weibo.com/comment/inbox',
      messageUrl: process.env.WEIBO_MESSAGE_URL || 'https://api.weibo.com/chat/#/chat'
    }
  },
  agentPollMs: numberEnv('AGENT_POLL_MS', 1500),
  agentCloudFailureShutdownThreshold: Math.max(2, Math.min(20, numberEnv('AGENT_CLOUD_FAILURE_SHUTDOWN_THRESHOLD', 3))),
  loginStatusPollEnabled: booleanEnv('LOGIN_STATUS_POLL_ENABLED', true),
  loginStatusPollIntervalMs: Math.max(60_000, numberEnv('LOGIN_STATUS_POLL_INTERVAL_MS', 2 * 60 * 1000)),
  loginStatusLogoutConfirmations: Math.max(2, Math.min(5, numberEnv('LOGIN_STATUS_LOGOUT_CONFIRMATIONS', 3))),
  loginStatusConfirmDelayMs: Math.max(500, numberEnv('LOGIN_STATUS_CONFIRM_DELAY_MS', 2_000)),
  issueDiagnosisEnabled: booleanEnv('ISSUE_DIAGNOSIS_ENABLED', false),
  issueDiagnosisBrowserReadonly: booleanEnv('ISSUE_DIAGNOSIS_BROWSER_READONLY', true),
  issueDiagnosisTimeoutMs: Math.max(10_000, numberEnv('ISSUE_DIAGNOSIS_TIMEOUT_MS', 120_000)),
  issueDiagnosisPageSettleMs: Math.max(500, numberEnv('ISSUE_DIAGNOSIS_PAGE_SETTLE_MS', 2_000)),
  issueDiagnosisEvidenceDir: path.resolve(ROOT, process.env.ISSUE_DIAGNOSIS_EVIDENCE_DIR || './logs/issue-diagnosis'),
  smokeTestScreenshotDir: path.resolve(ROOT, process.env.SMOKE_TEST_SCREENSHOT_DIR || './logs/smoke-tests'),
  autoCollectEnabled: process.env.AUTO_COLLECT_ENABLED !== 'false',
  messageCollectMinIntervalMs,
  messageCollectMaxIntervalMs
};


