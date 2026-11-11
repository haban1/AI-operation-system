import { browserStatusModel, browserStatusMarkup, bindBrowserStatus } from './browser-status.js?v=20261110-browser-status';
import { renderKnowledgeFiles, cleanupKnowledgeFiles } from './knowledge-files.js?v=20261111-v2c';
import { renderAnswerProfile, renderRagPlayground, cleanupKnowledgeTools, resetKnowledgeTools } from './knowledge-tools.js?v=20261111-v2c';
import { patchBackgroundContent } from './background-dom.js?v=20261112-refresh';
import { applyWorkspacePresentation, refreshDashboardOrb } from './workspace-presentation.js?v=20261112-controls';
import { applyInteractionPresentation } from './workspace-interactions.js?v=20261112-inbox-merge';
import { platformLogo } from './platform-icons.js?v=20261111-v2';
import { aiConnectionPresentation, bindAiModelSettings } from './ai-model-settings.js';
import { renderWechatAdmin, cleanupWechatAdmin } from './wechat-admin.js';
import { renderHotTopicStudio, hideHotTopicStudio } from './hot-topic-studio.js?v=20261111-creation-nav';
import { openContentLibraryPicker, closeContentLibraryPicker } from './content-library-picker.js';
const navItems = [
  ['dashboard','dashboard','运营总览','推广、内容、活动转化与 AI 运营建议'],
  ['create','create','内容生成','自动热点与混剪：成片库、视频制作和素材库'],
  ['platforms','accounts','平台启停','五个平台独立启停；未开启平台绝不唤醒；账号与智能回复统一管理，设备和登录状态集中展示在运行总览'],
  ['publish','publish','内容发布','本地选材、格式预检、合规审核和一键发布'],
  ['tasks','tasks','任务中心','区分已提交、审核中、已发布和审核失败'],
  ['messages','messages','评论与私信','真实采集、自动回复、转人工和处理状态'],
  ['miniProgram','messages','小程序对话','查看小程序文字咨询、AI 回复、回调与转人工状态'],
  ['handoffs','messages','转人工记录','只展示通知人工的会话与企业微信送达状态'],
  ['knowledge','knowledge','知识库','上传文件与文件增删改查'],
  ['wechat','wecom','微信客服','人工接待、好友群发与机器人管理'],
  ['browser','browser','浏览器状态','查看连接状态与修复方法'],
  ['issues','issues','问题汇总','千问、知识库、RPA、登录、发布和发送异常'],
  ['wecom','wecom','模型与通知','企业微信通知、AI 服务配置和调用日志']
];
const hiddenNavPages=new Set([]);
const iconPaths={
  create:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="m10 9 5 3.5-5 3.5z"/><path d="m16 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>',
  dashboard:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="4" rx="2"/><rect x="14" y="11" width="7" height="10" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/>',
  publish:'<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  tasks:'<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  messages:'<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/><path d="M8 9h8M8 13h5"/>',
  knowledge:'<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22z"/>',
  issues:'<path d="M12 3 2.8 19a1.3 1.3 0 0 0 1.1 2h16.2a1.3 1.3 0 0 0 1.1-2z"/><path d="M12 9v4M12 17h.01"/>',
  wecom:'<path d="M8.5 4C4.9 4 2 6.4 2 9.4c0 1.7 1 3.3 2.6 4.3L4 17l3.5-1.8c.3 0 .7.1 1 .1 3.6 0 6.5-2.4 6.5-5.4S12.1 4 8.5 4z"/><path d="M14.5 9c4.1 0 7.5 2.7 7.5 6 0 1.9-1.1 3.6-2.9 4.8l.7 3.2-3.9-2c-.5.1-.9.1-1.4.1-3.5 0-6.5-2-7.3-4.7"/>',
  accounts:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  browser:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/><path d="M7 6.5h.01M10 6.5h.01"/><path d="m9 15 2 2 4-5"/>',
  'workspace-settings':'<path d="m10 3-.6 2.5-2 .9L5.2 5 3 8.8l1.8 1.7-.1 2.4L3 14.5l2.2 3.8 2.3-.7 2 .9L10 21h4l.6-2.5 2-.9 2.2.7 2.2-3.8-1.7-1.6-.1-2.4L21 8.8 18.8 5l-2.2 1.4-2-.9L14 3z"/><circle cx="12" cy="12" r="3"/>'
};
const iconSvg=name=>`<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]||iconPaths.dashboard}</svg>`;
let publishLayoutCleanup=null;
let publishSchedulePollTimer=null;
let pageRenderGeneration=0;
let pageRenderInFlightGeneration=0;
let bootstrapRequestGeneration=0;
let publishPrecheckRequestGeneration=0;
let miniProgramRenderGeneration=0;
const expandedCommentPosts=new Set();
const commentPostReadPositions=new Map();
const commentPostReadStoragePrefix='tianhe:comment-post-read:v1:';
const state={publishSchedules:[],page:'dashboard',workspacePresentation:null,dashboardRange:'7d',dashboardPlatform:'all',operationsDashboard:null,auth:null,appStarted:false,bootstrap:null,precheck:null,compliance:null,trafficPrediction:{status:'IDLE',result:null,error:null,requestToken:null,platformCodes:[]},contentGeneration:{status:'IDLE',stage:null,sourceType:null,materialSha256:null,result:null,error:null,titleDirty:false,bodyDirty:false,requestToken:null,applied:false,needsManualApply:false},knowledgeView:'rag',knowledgeCategory:null,knowledgeSubcategory:null,knowledgeCategoryData:null,knowledgeCreateExpanded:false,publishHistoryPage:1,materialPreviewUrl:null,wecomCategory:'ALL',settingsConfigPanel:null,messageView:'COMMENT',messageAccountId:null,miniProgramFilter:'ALL',miniProgramConversationId:null,miniProgramPendingActions:new Set(),taskPlatform:'ALL',taskStatus:'ALL',retryDraft:null,retrySourceTaskId:null,};
const $=s=>document.querySelector(s); const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const cleanText=v=>String(v??'').replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,'').replace(/\s{3,}/g,' ').trim();
const fmt=v=>{if(!v)return '—';const date=new Date(v);return Number.isNaN(date.getTime())?String(v).replace(/^发布于\s*/,''):date.toLocaleString('zh-CN',{hour12:false})};
function fmtTaskPublishTime(value){if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';const pad=number=>String(number).padStart(2,'0');return `${date.getFullYear()}年${pad(date.getMonth()+1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`}
const STATUS_LABELS = Object.freeze({
  // 任务、发布与审核
  QUEUED:'待执行', EXECUTING:'执行中', RUNNING:'执行中', PROCESSING:'处理中', UPLOADED:'已上传', READY_FOR_TEST:'待测试', TESTED:'已测试', BUILDING:'构建中', PROCESS_FAILED:'处理失败', ROLLED_BACK:'已回滚',
  SUBMITTED:'已提交', REVIEWING:'审核中', PUBLISHED:'已发布', PUBLISHED_ON_PLATFORM:'平台已发布',
  REJECTED:'审核失败', SUCCESS:'执行成功', FAILED:'失败', PARTIAL_SUCCESS:'部分采集完成', PARTIAL_FAILED:'部分失败',
  RECOVERED:'已恢复', AUTO_RECOVERED:'已自动恢复', RECOVERED_BY_RETRY:'已补发成功',
  WAITING_MANUAL_SECURITY:'待人工安全验证发布', NEEDS_CONFIRMATION:'待人工确认', UNKNOWN:'待复核', NOT_SUBMITTED:'未提交',
  NOT_ATTEMPTED:'未尝试', DRAFT_BLOCKED:'草稿阻塞', DRAFT_ONLY:'仅有草稿',
  SUBMITTING:'正在提交', SUBMIT_ATTEMPTED_UNCONFIRMED:'提交结果待核对',
  SUBMIT_RESULT_UNCONFIRMED:'提交结果待核对', AUTOMATIC_UNCONFIRMED_SUBMIT:'自动提交结果待核对',
  UPLOAD_NOT_STARTED:'上传未启动', UPLOAD_FAILED:'视频上传失败', PLATFORM_UPLOAD_FAILED:'平台上传失败',
  LOCKED:'已锁定', UNLOCKED:'未锁定', SUBMIT_ALREADY_LOCKED:'投稿锁已锁定',
  SUBMIT_LOCK_PREVENTED_RETRY:'投稿锁阻止重复提交', PASSED:'通过', APPROVED:'已审核',
  PENDING_REVIEW:'待审核', PENDING_CONFIRMATION:'待确认', IMPORTING:'正在加入知识库', IMPORTED:'已加入知识库', IGNORED:'已忽略', WARNING:'警告', BLOCKED:'阻断', CANCELLED:'已取消',
  RETRYING:'重试中', COMPLETED:'已完成', STOPPED:'已停止', CLOSED:'已关闭',
  OPEN:'处理中', PAUSED:'已暂停', RELEASED:'已解除阻断',
  // 登录、设备与运行状态
  READY:'登录正常', LOGIN:'未登录', EXPIRED:'登录过期', LOGIN_EXPIRED:'登录已失效',
  VERIFY_REQUIRED:'需要验证', DISABLED:'已停用', OFFLINE:'离线', ONLINE:'在线',
  ERROR:'检查失败', UNAVAILABLE:'当前模式不可检查', UNKNOWN_LOGIN:'无法确认登录状态',
  PLATFORM_STOPPED:'平台已停止', PLATFORM_STOPPED_PRE_EXECUTION:'平台未启动，未执行',
  // 回复、采集与消息处理
  AUTO_REPLY:'高可信自动回复', SMALL_TALK:'闲聊回复', CASUAL_CHAT:'闲聊消息',
  AUTO_REPLIED:'已自动回复', REPLY_QUEUED:'待发送', REPLY_RUNNING:'发送中',
  HANDOFF_PENDING:'转人工通知中', HUMAN_MANAGED:'已转人工', NOT_CONFIGURED:'未配置回调', RETRY_WAIT:'等待重试', SENDING:'发送中',
  ACCEPTED:'已接收', IGNORED_HANDOFF_COMPLETED:'已转人工，停止采集', BOT_ACTIVE:'AI 服务中',
  SIMPLE_GREETING:'简单问候', ROUTER_IGNORED:'路由忽略',
  RAG_ANSWERED:'知识库已回复', RAG_KNOWLEDGE_GAP:'知识证据不足', RAG_NEED_CLARIFICATION:'需要补充信息', RAG_CLARIFICATION_LIMIT:'引导已达上限，转人工', KNOWLEDGE_GUIDANCE_LIMIT:'引导已达上限，转人工', RAG_SERVICE_UNAVAILABLE:'知识服务不可用',
  HUMAN_HANDOFF:'转人工', HUMAN_FOLLOWUP_NOTIFIED:'已通知历史对接人工', HUMAN_FOLLOWUP_NOTIFICATION_PENDING:'历史人工通知中',
  REPLIED:'已回复', NOT_REPLIED:'未回复', MANUAL_REPLY:'人工回复',
  KNOWLEDGE_GAP:'知识不足', MANUAL_REQUIRED:'需人工处理', MANUAL_HANDLED:'人工已处理', PLATFORM_REPLY_DETECTED:'平台已有回复',
  MANUAL_RISK:'风险转人工', TECHNICAL_ERROR:'技术异常', AI_REPLY_TIMEOUT:'AI回复超时', IGNORE:'已忽略',
  IGNORED_SELF:'账号自身回复，已忽略', IGNORED_OFFICIAL:'官方/系统通知，已忽略',
  NEW:'新消息', COMMENT:'评论', PRIVATE_MESSAGE:'私信', SENT:'已发送',
  SIMULATED:'未真实发送', SKIPPED:'已跳过', DUPLICATE:'重复消息',
  // 消息定位、精度和平台来源标记
  READ_ONLY:'仅读取', READ_ONLY_INCOMPLETE_TARGET:'仅采集展示，评论定位信息不完整',
  EXACT_API_TARGET:'已精确定位评论目标', EXACT_API_SESSION_MESSAGE:'已精确定位私信消息',
  DETERMINISTIC_TARGET_VERIFIED:'已确认唯一目标', FULL_MESSAGE_OR_NON_PREVIEW_CONTEXT:'已获取完整消息',
  FULL_MESSAGE_SOURCE_NOT_VERIFIED:'已获取消息，但来源尚未核验', FULL_SOURCE_TEXT_REQUIRED:'需要完整原文',
  PRIVATE_PREVIEW_INCOMPLETE:'私信预览信息不完整', PRIVATE_PREVIEW_MULTIPLE_UNREAD:'存在多条未读私信，无法确认目标',
  PRIVATE_PREVIEW_UNREAD_COUNT_UNVERIFIED:'未核实未读私信数量', SIDEBAR_PREVIEW_NOT_SENDABLE:'侧边栏预览不可直接回复',
  SOURCE_PAGE_NOT_VERIFIED:'来源页面尚未核验', SOURCE_TEXT_HASH_MISMATCH:'来源文本校验不一致',
  STABLE_COMMENT_ID_REQUIRED:'缺少稳定评论编号', STABLE_MESSAGE_ID_REQUIRED:'缺少稳定消息编号',
  STABLE_CONVERSATION_ID_REQUIRED:'缺少稳定会话编号', STABLE_POST_ID_REQUIRED:'缺少稳定帖子编号',
  COMMENT_STABLE_ID:'评论编号已确认', COMMENT_SEMANTIC_OCCURRENCE:'已通过语义和出现位置定位评论',
  WEIBO_MESSAGE_PRECISION:'微博消息定位信息不足', EXACT_ACCOUNT_NAME_MATCH:'已精确匹配账号',
  // 自动回复决策与业务引导
  AUTO_REPLY_INELIGIBLE:'不满足自动回复条件', KNOWLEDGE_GAP_GUIDANCE:'知识库未命中，正在引导用户补充',
  AUTO_REPLY_PARTIAL_KNOWLEDGE:'部分问题已回复，仍有问题待确认', GREETING_GUIDANCE:'问候引导',
  BUSINESS_GUIDANCE:'业务引导', BUSINESS_CLARIFICATION:'正在澄清业务意图', KNOWLEDGE_INTENT_CLARIFICATION:'正在确认咨询意图',
  MULTI_QUESTION:'多问题消息', SINGLE_KNOWLEDGE:'单条知识命中', KNOWLEDGE_MATCH:'已命中知识库',
  RESOLVED_BY_KNOWLEDGE:'已通过知识库处理', NOT_EXPLICIT_SMALL_TALK:'不是明确闲聊', NOT_EXPLICIT_HANDOFF:'未明确要求转人工',
  // 转人工与去重
  EXPLICIT_HANDOFF_COMMAND:'用户明确要求转人工', HANDOFF_GUIDANCE:'已引导用户发送“转人工”',
  HANDOFF_CONFIRMATION:'已确认转人工', HANDOFF_SUBMITTED:'已提交人工处理', HANDOFF_WAITING:'等待人工处理',
  HANDOFF_WAITING_ACK:'等待人工通知确认', HANDOFF_ALREADY_SUBMITTED:'人工通知已提交，避免重复通知',
  HANDOFF_NOT_FOUND:'未找到可关联的人工通知', HANDOFF_NOTIFY_FAILED:'人工通知失败',
  DUPLICATE_PROCESSED_MESSAGE:'重复消息，已跳过', SKIP_ALREADY_REPLIED:'已回复过，跳过重复处理',
  SUPERSEDED:'已被新消息替代', SUPERSEDED_BY_NEW_MESSAGE:'新消息已到达，旧回复已作废',
  SOURCE_GONE:'原消息已不存在', SKIP_SOURCE_GONE:'原消息不存在，已跳过',
  DEFERRED:'已延期处理', DEFERRED_PAGE_UNAVAILABLE:'平台页面暂不可用，已延期', OFFICIAL_MESSAGE:'官方或系统消息，已忽略',
  // 回复验证阶段（服务端保留英文枚举，页面统一显示中文）
  reply_sent:'回复已发送并核验', private_reply_sent:'私信已发送并核验', reply_unconfirmed:'回复结果待人工核对',
  private_reply_unconfirmed:'私信发送结果待核对', reply_rejected:'平台拒绝了回复',
  reply_validation_failed:'回复前校验失败', reply_private_preview_blocked:'私信定位不完整，已阻止发送',
  manual_detect_requires_review:'需要人工复核', manual_reply_detected:'已检测到人工回复', manual_detect_failed:'人工回复检测失败',
  messages_collected:'消息采集完成', messages_partially_collected:'消息部分采集完成', message_collection_partial:'消息部分采集完成', message_collection_failed:'消息采集失败',
  // 问题诊断类别
  LOGIN_EXPIRED:'账号登录状态已失效', NETWORK_ERROR:'网络或平台连接异常', BROWSER_CRASH:'浏览器执行环境异常',
  MATERIAL_INVALID:'发布素材不符合执行条件', CONTENT_REJECTED:'内容被平台拒绝或审核失败', RATE_LIMITED:'平台触发频率限制',
  PERMISSION_DENIED:'账号权限不足', PLATFORM_ERROR:'平台执行流程返回异常', LOCATOR_MISMATCH:'页面控件定位器未匹配',
  PAGE_CHANGED:'页面结构疑似发生变化', TIMEOUT:'执行阶段超时', RESULT_UNCERTAIN:'写操作结果不明确，必须人工确认',
  SYSTEM_ERROR:'本地系统或 Agent 异常', UNKNOWN_ERROR:'未知错误',
  AI_CONNECTION_FAILED:'AI 服务连接失败', AI_REQUEST_FAILED:'AI 请求失败', AI_REVIEW_FAILED:'AI 审核失败',
  AI_TIMEOUT:'AI 请求超时', AI_UNAVAILABLE:'AI 服务暂不可用', AI_KEY_MISSING:'AI 密钥未配置',
  PLATFORM_FEATURE:'平台功能', PUBLISH_TARGET:'发布目标', MESSAGE:'消息',
  PUBLISH:'发布', REPLY:'回复', COLLECT_MESSAGES:'采集消息', DETECT_MANUAL_REPLY:'检测人工回复',
  // 本地 Agent / Web 控制错误
  LOCAL_AGENT_OFFLINE:'Local Agent 未连接', LOCAL_AGENT_START_TIMEOUT:'Local Agent 启动超时',
  LOCAL_AGENT_ENTRY_MISSING:'Local Agent 入口文件缺失', LOCAL_AGENT_INVALID_RESPONSE:'Local Agent 返回格式异常',
  LOCAL_AGENT_PROXY_FAILED:'Local Agent 代理失败', BROWSER_CONTROL_DISABLED:'浏览器控制未启用',
  BROWSER_PLATFORM_STOPPED:'平台已停止，浏览器控制未执行', BROWSER_SESSION_CLOSED:'浏览器会话已关闭',
  BROWSER_SESSION_NOT_FOUND:'未找到浏览器会话', BROWSER_ACTION_NOT_ALLOWED:'浏览器动作不允许执行',
  BROWSER_PROVIDER_NOT_ALLOWED:'浏览器 Provider 不允许使用', BROWSER_PLATFORM_NOT_ALLOWED:'平台不允许执行此操作',
  BROWSER_COMMAND_FORBIDDEN_FIELD:'命令包含禁止字段', BROWSER_URL_INVALID:'页面地址无效',
  BROWSER_URL_PROTOCOL_BLOCKED:'页面协议被阻止', BROWSER_DOMAIN_NOT_ALLOWED:'页面域名不在允许范围',
  BROWSER_SESSION_BINDING_MISMATCH:'浏览器会话绑定不一致', BROWSER_OPERATOR_CONFIRMATION_REQUIRED:'需要运营人员确认',
  BROWSER_OPERATOR_CONFIRMATION_EXPIRED:'运营人员确认已过期', BROWSER_TAB_REQUIRED:'需要先打开平台页面',
  // 通知、知识库与导入
  NOTIFIED:'已通知', NOTIFY_QUEUED:'通知排队中', ACKNOWLEDGEMENT:'已收到确认',
  PENDING:'待补充', DRAFT:'草稿', FILE_IMPORT:'文档导入', PREVIEWED:'已预处理', COMMITTED:'已导入',
  CONFIG_TEST:'连接测试', CONNECTION_TEST:'连接测试', EXACT_DUPLICATE:'完全重复', SIMILAR_REVIEW:'相似待审核',
  CONFLICT:'存在冲突', STALE_ALIAS_TASK:'相似问法生成任务已过期',
  // 常见通用枚举
  ACTIVE:'启用中', ENABLED:'已启用', DISABLED:'已停用', CONFIRMED:'已确认', NOTIFIED:'已通知',
  IN_PROGRESS:'进行中', COMPLETED:'已完成', HIGH:'高', MEDIUM:'中', LOW:'低', TRUE:'是', FALSE:'否'
});
function statusName(v){
  if(v===null||v===undefined||String(v).trim()==='')return '—';
  const key=String(v).trim();
  return STATUS_LABELS[key]||STATUS_LABELS[key.toUpperCase()]||key;
}
function matchMethodName(v){
  if(v===null||v===undefined||String(v).trim()==='')return '—';
  return String(v).split(',').map(part=>{
    const raw=part.trim();
    if(!raw)return '';
    const lower=raw.toLowerCase();
    if(lower.startsWith('context:'))return `结合上下文匹配（${matchMethodName(raw.slice(raw.indexOf(':')+1))}）`;
    return ({direct:'直接匹配',semantic:'语义匹配',qwen:'千问语义匹配',keyword:'关键词匹配',alias:'相似问法匹配',unmatched:'未匹配','context-unmatched':'结合上下文后仍未匹配','greeting-rule':'问候规则'}[lower]||statusName(raw));
  }).filter(Boolean).join('、')||'—';
}
const badge=v=>`<span class="badge ${String(v||'').toLowerCase()}">${esc(statusName(v))}</span>`;
const loginPlatforms=[
  {code:'xiaohongshu',acceptanceNote:'暂缓调试，未验收',name:'\u5c0f\u7ea2\u4e66',purpose:'\u5185\u5bb9\u53d1\u5e03\u3001\u53d1\u5e03\u72b6\u6001\u590d\u6838\u3001\u8bc4\u8bba\u4e0e\u79c1\u4fe1\u5904\u7406'},
  {code:'douyin',name:'\u6296\u97f3',purpose:'\u521b\u4f5c\u8005\u4e2d\u5fc3\u5185\u5bb9\u53d1\u5e03\u3001\u4e92\u52a8\u91c7\u96c6\u4e0e\u56de\u590d'},
  {code:'wechat_channels',name:'\u89c6\u9891\u53f7',purpose:'\u89c6\u9891\u53f7\u52a9\u624b\u5185\u5bb9\u53d1\u5e03\u3001\u4e92\u52a8\u91c7\u96c6\u4e0e\u56de\u590d'},
  {code:'bilibili',name:'B\u7ad9',purpose:'\u521b\u4f5c\u4e2d\u5fc3\u89c6\u9891\u6295\u7a3f\u3001\u7a3f\u4ef6\u7ba1\u7406\u4e0e\u4e92\u52a8\u5904\u7406'},
  {code:'weibo',name:'\u5fae\u535a',purpose:'\u56fe\u6587/\u89c6\u9891\u53d1\u5e03\u3001\u8bc4\u8bba\u4e0e\u79c1\u4fe1\u5904\u7406'}
];
const activeLoginPlatforms=loginPlatforms;
function accountLoginState(account){if(account?.platform_desired_state==='STOPPED')return 'STOPPED';if(account?.enabled===0||account?.login_status==='DISABLED')return 'DISABLED';return account?.login_source==='LOCAL_AGENT'&&account?.login_checked_at?(account.login_status==='EXPIRED'?'LOGIN':account.login_status):'UNKNOWN'}
function loginStatusMeta(value){const state=value?.state||value||'UNKNOWN';return ({READY:{text:'\u5df2\u767b\u5f55',cls:'ready'},LOGIN:{text:'\u672a\u767b\u5f55',cls:'expired'},EXPIRED:{text:'\u672a\u767b\u5f55',cls:'expired'},VERIFY_REQUIRED:{text:'\u9700\u8981\u9a8c\u8bc1',cls:'verify_required'},DISABLED:{text:'\u5df2\u505c\u7528',cls:'disabled'},STOPPED:{text:'\u5e73\u53f0\u5df2\u505c\u6b62',cls:'stopped'},ERROR:{text:'\u68c0\u67e5\u5931\u8d25',cls:'failed'},UNAVAILABLE:{text:'\u5f53\u524d\u6a21\u5f0f\u4e0d\u53ef\u68c0\u67e5',cls:'unknown'},CLOSED:{text:'\u5c1a\u672a\u4e3b\u52a8\u68c0\u67e5',cls:'unknown'},UNKNOWN:{text:'\u65e0\u6cd5\u786e\u8ba4',cls:'unknown'}}[state]||{text:'\u65e0\u6cd5\u786e\u8ba4',cls:'unknown'})}
function persistedLoginStatus(account){const state=accountLoginState(account);return {state,loggedIn:state==='READY',checkedAt:account?.login_checked_at,message:account?.login_message||'',url:account?.login_url||''}}
function accountLoginDetail(account){return account?.enabled===0?'\u5f53\u524d\u5df2\u505c\u7528\uff0c\u4e0d\u6267\u884c\u767b\u5f55\u68c0\u67e5':account?.login_checked_at?`\u6700\u540e\u68c0\u67e5 ${fmt(account.login_checked_at)}`:'\u5c1a\u65e0\u53ef\u4fe1\u68c0\u67e5\u8bb0\u5f55'}

function toast(m,e=false){const el=$('#toast');el.textContent=m;el.className=`toast show${e?' error':''}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',3500)}
async function api(p,o={}){const r=await fetch(p,{credentials:'same-origin',...o,headers:{'Content-Type':'application/json',...(o.headers||{})}});const d=await r.json().catch(()=>({ok:false,message:'Response format error'}));if(!r.ok||d.ok===false){
  /* 只有「管理员会话失效」（服务端固定返回 code=AUTH_REQUIRED）才强制登出。
     下游代理（RAG 服务 UNAUTHORIZED、Local Agent AGENT_AUTH_REQUIRED）返回 401 属于该模块自身
     鉴权问题，不能把运营席位踢回登录页 —— 否则打开知识资料等页面会莫名登出。 */
  const x=new Error(d.message||`HTTP ${r.status}`);x.detail=d.detail;x.code=d.code;x.status=r.status;
  if(r.status===401&&d.code==='AUTH_REQUIRED'&&!p.startsWith('/api/auth/'))queueMicrotask(()=>showLoginScreen('Session expired'));
  throw x}return d}
function confirmDelete({title,message,details=[],requiredText='',inputLabel='确认文字',confirmLabel='确认删除'}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay';
    overlay.innerHTML=`<div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmDeleteTitle"><div class="confirm-icon">!</div><h3 id="confirmDeleteTitle">${esc(title)}</h3><p>${esc(message)}</p>${details.length?`<ul>${details.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}${requiredText?`<label>${esc(inputLabel)}<input class="confirm-input" autocomplete="off" placeholder="请输入：${esc(requiredText)}"><small>输入内容完全一致后才能删除。</small></label>`:''}<div class="confirm-actions"><button class="btn secondary confirm-cancel" type="button">取消</button><button class="btn danger confirm-submit" type="button" ${requiredText?'disabled':''}>${esc(confirmLabel)}</button></div></div>`;
    document.body.appendChild(overlay);
    const input=overlay.querySelector('.confirm-input');const submit=overlay.querySelector('.confirm-submit');
    const close=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
    const onKey=event=>{if(event.key==='Escape')close(false)};document.addEventListener('keydown',onKey);
    overlay.querySelector('.confirm-cancel').onclick=()=>close(false);
    overlay.onclick=event=>{if(event.target===overlay)close(false)};
    if(input){input.oninput=()=>{submit.disabled=input.value.trim()!==requiredText};setTimeout(()=>input.focus(),0)}
    submit.onclick=()=>close(true);
  });
}
/* 页内输入/确认弹窗，替代浏览器原生 prompt/confirm：取消返回 null / false，与原生行为一致。 */
function uiDialog({title,message='',label='',value='',input=false,multiline=true,maxLength=0,required=false,confirmLabel='确定',danger=false}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay ui-dialog-overlay';
    const field=input?(multiline?`<textarea class="ui-dialog-input" rows="4" ${maxLength?`maxlength="${maxLength}"`:''}>${esc(value)}</textarea>`:`<input class="ui-dialog-input" autocomplete="off" value="${esc(value)}" ${maxLength?`maxlength="${maxLength}"`:''}>`):'';
    overlay.innerHTML=`<div class="confirm-dialog ui-dialog ${danger?'is-danger':''}" role="dialog" aria-modal="true" aria-labelledby="uiDialogTitle"><h3 id="uiDialogTitle">${esc(title)}</h3>${message?`<p>${esc(message)}</p>`:''}${input?`<label class="ui-dialog-field"><span>${esc(label)}</span>${field}${maxLength?`<small class="ui-dialog-count"></small>`:''}</label>`:''}<div class="confirm-actions"><button type="button" class="btn secondary confirm-cancel">取消</button><button type="button" class="btn ${danger?'danger':''} confirm-submit">${esc(confirmLabel)}</button></div></div>`;
    document.body.appendChild(overlay);
    const control=overlay.querySelector('.ui-dialog-input'),submit=overlay.querySelector('.confirm-submit'),count=overlay.querySelector('.ui-dialog-count');
    const sync=()=>{if(!control)return;const length=control.value.length;if(count)count.textContent=`${length} / ${maxLength}`;submit.disabled=required&&!control.value.trim()};
    const close=result=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(result)};
    const accept=()=>{if(submit.disabled)return;close(control?control.value:true)};
    const onKey=event=>{if(event.key==='Escape')close(control?null:false);else if(event.key==='Enter'&&(!control||control.tagName==='INPUT'||event.metaKey||event.ctrlKey)){event.preventDefault();accept()}};
    document.addEventListener('keydown',onKey);
    overlay.querySelector('.confirm-cancel').onclick=()=>close(control?null:false);
    overlay.onclick=event=>{if(event.target===overlay)close(control?null:false)};
    submit.onclick=accept;
    if(control){control.oninput=sync;sync();setTimeout(()=>{control.focus();control.setSelectionRange?.(control.value.length,control.value.length)},0)}else setTimeout(()=>submit.focus(),0);
  });
}
const uiPrompt=(label,value='',options={})=>uiDialog({input:true,label,value,title:options.title||label,...options});
const uiConfirm=(message,options={})=>uiDialog({message,title:options.title||'确认操作',...options});
/* 问题记录“误判”：说明、平台实际结果、可选链接/ID 合并为一个弹窗；提交字段与原流程一致。 */
function falsePositiveDialog(type){
  const outcome=type==='PUBLISH_TARGET'?{yes:'PUBLISHED',yesLabel:'平台上已发布成功',yesHint:'会锁定投稿，防止重复发布',noLabel:'未发布或不确定'}:type==='MESSAGE'?{yes:'SENT',yesLabel:'平台上已发送成功',yesHint:'会标记人工已处理，防止重复发送',noLabel:'未发送或不确定'}:null;
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay ui-dialog-overlay';
    overlay.innerHTML=`<div class="confirm-dialog ui-dialog" role="dialog" aria-modal="true" aria-labelledby="fpTitle"><h3 id="fpTitle">标记为误判</h3><label class="ui-dialog-field"><span>误判说明</span><textarea class="ui-dialog-input" rows="3" data-fp="resolution">已人工核对，确认属于误判</textarea></label>${outcome?`<fieldset class="ui-dialog-choice"><legend>平台上的实际结果</legend><label><input type="radio" name="fpOutcome" value="${outcome.yes}"><span><b>${outcome.yesLabel}</b><small>${outcome.yesHint}</small></span></label><label><input type="radio" name="fpOutcome" value="UNKNOWN" checked><span><b>${outcome.noLabel}</b></span></label></fieldset>${type==='PUBLISH_TARGET'?`<div class="ui-dialog-optional" hidden><label class="ui-dialog-field"><span>平台内容链接（可选）</span><input class="ui-dialog-input" data-fp="url" autocomplete="off"></label><label class="ui-dialog-field"><span>平台内容 ID（可选）</span><input class="ui-dialog-input" data-fp="id" autocomplete="off"></label></div>`:''}`:''}<div class="confirm-actions"><button type="button" class="btn secondary confirm-cancel">取消</button><button type="button" class="btn confirm-submit">确认误判</button></div></div>`;
    document.body.appendChild(overlay);
    const get=key=>overlay.querySelector(`[data-fp="${key}"]`);const optional=overlay.querySelector('.ui-dialog-optional');
    const close=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
    const onKey=event=>{if(event.key==='Escape')close(null)};document.addEventListener('keydown',onKey);
    overlay.querySelectorAll('input[name="fpOutcome"]').forEach(radio=>radio.onchange=()=>{if(optional)optional.hidden=radio.value!=='PUBLISHED'||!radio.checked});
    overlay.querySelector('.confirm-cancel').onclick=()=>close(null);
    overlay.onclick=event=>{if(event.target===overlay)close(null)};
    overlay.querySelector('.confirm-submit').onclick=()=>{
      const actualOutcome=overlay.querySelector('input[name="fpOutcome"]:checked')?.value||'UNKNOWN';
      const published=actualOutcome==='PUBLISHED';
      close({resolution:get('resolution').value,actualOutcome,platformUrl:published?(get('url')?.value.trim()||null):null,platformPostId:published?(get('id')?.value.trim()||null):null});
    };
    setTimeout(()=>get('resolution').focus(),0);
  });
}
function agentResourceUrl(resourcePath){
  if(!resourcePath)return null;
  const base=(state.bootstrap?.config?.localAgentBaseUrl||'/api/local-agent').replace(/\/+$/,'');
  const suffix=String(resourcePath).startsWith('/')?String(resourcePath):`/${resourcePath}`;
  return `${base}${suffix}`;
}
async function agent(p,o={}){
  const base=(state.bootstrap?.config?.localAgentBaseUrl||'/api/local-agent').replace(/\/+$/,'');
  try{return await api(`${base}${p}`,o)}
  catch(error){
    if(error?.code||error?.status)throw error;
    const offline=new Error('Local Agent 未连接。请先打开全局运行开关；若仍失败，请重新启动系统。');
    offline.code='LOCAL_AGENT_OFFLINE';
    offline.cause=error;
    throw offline;
  }
}
function availableReplyExportPlatforms(){
  const activeCodes=state.bootstrap?.config?.activePlatformCodes||[];
  const platformMap=new Map((state.bootstrap?.platforms||[]).map(item=>[item.code,item]));
  return activeCodes.map(code=>({code,name:platformMap.get(code)?.name||(state.bootstrap?.accounts||[]).find(account=>account.platform_code===code)?.platform_name||code}));
}
function chooseReplyExportPlatforms(defaultPlatformCode){
  return new Promise(resolve=>{
    const platforms=availableReplyExportPlatforms();
    if(!platforms.length)return resolve([]);
    const initialCode=platforms.some(item=>item.code===defaultPlatformCode)?defaultPlatformCode:platforms[0].code;
    const overlay=document.createElement('div');overlay.className='confirm-overlay reply-export-overlay';
    overlay.innerHTML=`<div class="confirm-dialog reply-export-dialog" role="dialog" aria-modal="true" aria-labelledby="replyExportTitle"><div class="reply-export-heading"><div class="reply-export-icon" aria-hidden="true">导</div><div><h3 id="replyExportTitle">导出回复记录</h3><p>选择要导出的平台，文件会包含评论和私信中已经完成的 AI 回复、人工回复记录。</p></div><button class="knowledge-edit-close reply-export-close" type="button" aria-label="关闭">×</button></div><label class="reply-export-select-all"><input type="checkbox" class="reply-export-all"><span><b>一键全选</b><small>选择全部平台的回复记录</small></span></label><div class="reply-export-platforms">${platforms.map(item=>`<label class="reply-export-platform"><input type="checkbox" name="replyExportPlatform" value="${esc(item.code)}" ${item.code===initialCode?'checked':''}>${platformLogo(item.code,28)}<span><b>${esc(item.name)}</b></span><i>✓</i></label>`).join('')}</div><div class="reply-export-note">导出格式为 CSV，可直接使用 Excel 打开。只导出已经确认回复成功或已人工处理且未删除的记录，不会把“待回复”“回复失败”或已删除记录混在里面。</div><div class="confirm-actions"><button class="btn secondary reply-export-cancel" type="button">取消</button><button class="btn reply-export-submit" type="button">导出所选平台</button></div></div>`;
    document.body.appendChild(overlay);
    const allBox=overlay.querySelector('.reply-export-all');const submit=overlay.querySelector('.reply-export-submit');const boxes=[...overlay.querySelectorAll('input[name="replyExportPlatform"]')];
    const sync=()=>{const checked=boxes.filter(box=>box.checked).length;allBox.checked=checked===boxes.length;allBox.indeterminate=checked>0&&checked<boxes.length;submit.disabled=checked===0;boxes.forEach(box=>box.closest('.reply-export-platform')?.classList.toggle('is-selected',box.checked))};
    const close=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
    const onKey=event=>{if(event.key==='Escape')close(null)};document.addEventListener('keydown',onKey);
    allBox.onchange=()=>{boxes.forEach(box=>{box.checked=allBox.checked});sync()};boxes.forEach(box=>box.onchange=sync);
    overlay.querySelector('.reply-export-close').onclick=()=>close(null);overlay.querySelector('.reply-export-cancel').onclick=()=>close(null);overlay.onclick=event=>{if(event.target===overlay)close(null)};
    submit.onclick=()=>close(boxes.filter(box=>box.checked).map(box=>box.value));sync();
  });
}
async function downloadReplyExport(platformCodes,button){
  const original=button?.innerHTML;if(button){button.disabled=true;button.textContent='正在导出…'}
  try{
    const response=await fetch(`/api/messages/export?platforms=${encodeURIComponent(platformCodes.join(','))}`,{credentials:'same-origin'});
    if(!response.ok){const data=await response.json().catch(()=>({}));if(response.status===401&&data.code==='AUTH_REQUIRED')queueMicrotask(()=>showLoginScreen('\u8bf7\u5148\u767b\u5f55\u7ba1\u7406\u7aef'));const error=new Error(data.message||`导出失败（HTTP ${response.status}）`);error.status=response.status;throw error}
    const blob=await response.blob();const disposition=response.headers.get('Content-Disposition')||'';const encodedName=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];const filename=encodedName?decodeURIComponent(encodedName):'平台回复记录.csv';
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const count=Number(response.headers.get('X-Export-Count')||0);toast(count?`已导出 ${count} 条回复记录`:'回复记录已导出');
  }finally{if(button){button.disabled=false;button.innerHTML=original}}
}
/* ==========================================================================
   分组工作区导航（智慧驱动版）
   - 侧边栏按运营任务分组；组内页面通过顶部子导航切换。
   - 内容生成统一使用自动热点与混剪；旧创作入口兼容跳转到 #studio。
   - 发布管理独立保留；hiddenNavPages 仅隐藏导航，不影响对应页面访问。
   ========================================================================== */
const workspaceGroups=[
  {id:'overview',label:'运营总览',icon:'dashboard',section:'work',description:'推广、内容、活动转化与 AI 运营建议。',items:[
    {key:'overview',label:'运营总览',page:'dashboard'}]},
  {id:'content',label:'内容创作',icon:'create',section:'work',description:'自动热点与混剪：统一管理成片、视频制作和素材。',items:[
    {key:'studio',label:'创作方式',page:'create'}]},
  {id:'publishing',label:'发布管理',icon:'publish',section:'work',description:'素材预检、审核、发布排期与任务状态，继续使用运营系统的发布流程。',items:[
    {key:'publishing',label:'发布内容',page:'publish',presentation:'content'},
    {key:'schedule',label:'发布排期',page:'publish',presentation:'schedule'},
    {key:'publish-tasks',label:'发布任务',page:'tasks'}]},
  {id:'inbox',label:'用户互动',icon:'messages',section:'work',description:'统一处理平台评论、私信、小程序会话与需要人工接手的记录。',items:[
    {key:'comments',label:'评论',page:'messages',view:'COMMENT'},
    {key:'private-messages',label:'私信',page:'messages',view:'PRIVATE_MESSAGE'},
    {key:'mini-program',label:'小程序对话',page:'miniProgram'},
    {key:'human-handoffs',label:'转人工记录',page:'handoffs'}]},
  {id:'wechat',label:'微信客服',icon:'wecom',section:'work',description:'处理微信人工接待、好友群发与机器人管理。',items:[
    {key:'wechat-service',label:'微信客服',page:'wechat'}]},
  {id:'knowledge',label:'知识库',icon:'knowledge',section:'work',description:'管理知识文件，配置回答人设并测试问答效果。',items:[
    {key:'documents',label:'文件管理',page:'knowledge',view:'rag',presentation:'documents'},
    {key:'answer-style',label:'回答风格 / 人设',page:'knowledge',view:'persona',presentation:'persona'},
    {key:'reply-test',label:'RAG 问答测试',page:'knowledge',view:'playground',presentation:'playground'}]},
  {id:'channels',label:'平台账号',icon:'accounts',section:'manage',description:'管理平台启停、账号、登录状态与浏览器执行环境。',items:[
    {key:'accounts',label:'平台账号',page:'platforms'}]},
  {id:'settings',label:'系统设置',icon:'workspace-settings',section:'manage',description:'配置通知与 AI 服务，集中查看调用记录与运行问题。',items:[
    {key:'services',label:'AI 服务',page:'wecom',presentation:'ai'},
    {key:'creation-settings',label:'创作设置',page:'creativeSettings'},
    {key:'notifications',label:'消息通知',page:'wecom',presentation:'notifications'},
    {key:'usage',label:'调用记录',page:'wecom',presentation:'usage'},
    {key:'browser-tools',label:'浏览器状态',page:'browser'},
    {key:'diagnostics',label:'问题记录',page:'issues'}]}
];
const workspaceLastRoute={};
let workspaceNavigationSequence=0;
function presentWorkspace(extra={}){
  applyWorkspacePresentation($('#content'),{page:state.page,view:state.workspacePresentation,onNavigate:openWorkspaceItem,...extra});
}
function presentInteractions(extra={}){
  applyInteractionPresentation($('#content'),{page:state.page,messageView:state.messageView,miniProgramConversationId:state.miniProgramConversationId,messageAccountId:state.messageAccountId,...extra});
}
function currentWorkspaceRoute(){
  const view=state.page==='messages'?state.messageView:state.page==='knowledge'?state.knowledgeView:null;
  for(const group of workspaceGroups){const item=group.items.find(i=>i.page===state.page&&(!i.view||i.view===view)&&(!i.presentation||i.presentation===state.workspacePresentation));if(item)return {group,item}}
  for(const group of workspaceGroups){const item=group.items.find(i=>i.page===state.page);if(item)return {group,item}}
  return {group:workspaceGroups[0],item:workspaceGroups[0].items[0]};
}
function openWorkspaceGroup(id){
  const group=workspaceGroups.find(g=>g.id===id);if(!group)return;
  const visible=group.items.filter(i=>!hiddenNavPages.has(i.page));
  const pool=visible.length?visible:group.items;
  const remembered=workspaceLastRoute[id];
  const item=pool.find(i=>i.key===remembered)||pool[0];
  navigate(item.page,item.view||null,item.presentation||null);
}
function openWorkspaceItem(key){
  for(const group of workspaceGroups){const item=group.items.find(i=>i.key===key);if(item){navigate(item.page,item.view||null,item.presentation||null);return}}
}
function syncWorkspaceNavigation(){
  const {group,item}=currentWorkspaceRoute();
  workspaceLastRoute[group.id]=item.key;
  document.body.dataset.workspace=group.id;
  const title=$('#pageTitle'),subtitle=$('#pageSubtitle');
  if(title)title.textContent=state.page==='create'&&state.contentWorkspaceTitle?state.contentWorkspaceTitle:item.label;
  const context=$('#pageContext');
  if(context){context.textContent=group.label;context.hidden=group.items.length<2}
  if(subtitle)subtitle.textContent=group.description;
  const eyebrow=$('.page-heading .eyebrow');
  if(eyebrow)eyebrow.textContent=group.section==='manage'?'WORKSPACE / MANAGEMENT':'WORKSPACE / OPERATIONS';
  document.querySelectorAll('#nav [data-workspace]').forEach(button=>{
    const active=button.dataset.workspace===group.id;
    button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  const container=$('#workspaceSubnav');if(!container)return;
  const items=group.items.filter(i=>!hiddenNavPages.has(i.page));
  container.hidden=items.length<=1;
  container.setAttribute('aria-label',group.label+'栏目');
  const html=items.map(i=>`<button type="button" aria-current="${i.key===item.key?'page':'false'}" aria-controls="content" class="ws-section-tab ${i.key===item.key?'active':''}" data-workspace-item="${i.key}"><span>${i.label}</span>${i.hint?`<small>${i.hint}</small>`:''}</button>`).join('');
  if(container.innerHTML!==html){
    const focused=container.contains(document.activeElement)?document.activeElement.dataset.workspaceItem:null;
    container.innerHTML=html;
    if(focused)container.querySelector(`[data-workspace-item="${focused}"]`)?.focus({preventScroll:true});
  }
}
function buildWorkspaceNav(){
  document.body.classList.add('workspace-nav-v2');
  const nav=$('#nav');
  nav.innerHTML=['work','manage'].map(section=>`<div class="ws-nav-group">${section==='manage'?'<div class="ws-nav-caption">管理配置</div>':''}${workspaceGroups.filter(g=>g.section===section).map(g=>`<button type="button" class="ws-primary" data-workspace="${g.id}"><span class="icon">${iconSvg(g.icon)}</span><span class="ws-primary-label">${g.label}</span></button>`).join('')}</div>`).join('');
  nav.onclick=event=>{const b=event.target.closest('button[data-workspace]');if(b)openWorkspaceGroup(b.dataset.workspace)};
  let sections=$('#workspaceSubnav');
  if(!sections){sections=document.createElement('nav');sections.id='workspaceSubnav';sections.className='workspace-subnav';sections.setAttribute('aria-label','工作区栏目');$('#content').before(sections)}
  sections.onclick=event=>{const b=event.target.closest('button[data-workspace-item]');if(b)openWorkspaceItem(b.dataset.workspaceItem)};
  sections.onkeydown=event=>{
    if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
    const tabs=[...sections.querySelectorAll('button')];const index=tabs.indexOf(event.target);if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    tabs[next].focus();tabs[next].click();
  };
  syncWorkspaceNavigation();
}
function buildNav(){buildWorkspaceNav()}
function syncMasterSwitch(settings=state.bootstrap?.config?.masterSwitch){
  const enabled=settings?.enabled!==false;
  const agentOnline=isLocalAgentOnline();
  const button=$('#masterSwitch');
  if(button){button.classList.toggle('is-on',enabled);button.classList.toggle('is-off',!enabled);button.classList.toggle('agent-offline',enabled&&!agentOnline);button.setAttribute('aria-checked',String(enabled));button.querySelector('b').textContent=enabled?'\u5168\u5c40\u8fd0\u884c':'\u5168\u90e8\u505c\u6b62';button.querySelector('small').textContent=enabled?(agentOnline?'\u81ea\u52a8\u4efb\u52a1\u5df2\u5f00\u542f \u00b7 Local Agent \u5df2\u8fde\u63a5':'\u5168\u5c40\u5f00\u5173\u5df2\u5f00\u542f \u00b7 Local Agent \u672a\u8fde\u63a5'):'Local Agent \u5df2\u5173\u95ed';button.title=enabled?(agentOnline?'\u70b9\u51fb\u505c\u6b62\u4efb\u52a1\u5e76\u5173\u95ed Local Agent':'\u5168\u5c40\u5f00\u5173\u5df2\u5f00\u542f\uff0c\u4f46 Local Agent \u5c1a\u672a\u8fde\u63a5'):'\u70b9\u51fb\u542f\u52a8 Local Agent \u5e76\u6062\u590d\u5168\u5c40\u8fd0\u884c'}
  document.body.classList.toggle('operations-paused',!enabled);
  const badge=$('#operationsBadge');if(badge){badge.textContent=enabled?'LIVE':'STOPPED';badge.classList.toggle('paused',!enabled)}
}
function isLocalAgentOnline(bootstrap=state.bootstrap){if(typeof bootstrap?.localAgent?.online==='boolean')return bootstrap.localAgent.online;return Boolean(bootstrap?.devices?.some(d=>d.status==='ONLINE'&&Date.now()-new Date(d.last_heartbeat).getTime()<20000))}
async function waitForLocalAgentOnline(timeoutMs=10000,pageOwner=capturePageOwner()){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(!await refreshBootstrap(pageOwner))return false;
    if(isLocalAgentOnline())return true;
    await new Promise(resolve=>setTimeout(resolve,400));
  }
  return false;
}
async function toggleMasterSwitch(){
  const button=$('#masterSwitch');if(!button||button.disabled)return;
  const pageOwner=capturePageOwner();
  const current=state.bootstrap?.config?.masterSwitch?.enabled!==false;
  if(current){const confirmed=await confirmDelete({title:'\u505c\u6b62\u5168\u5c40\u8fd0\u884c\u5e76\u5173\u95ed Agent\uff1f',message:'\u5c06\u505c\u6b62\u9886\u53d6\u65b0\u4efb\u52a1\uff0c\u5173\u95ed\u6240\u6709\u5e73\u53f0\u6d4f\u89c8\u5668\u548c Profile\uff0c\u5e76\u9000\u51fa Local Agent\u3002Web \u7ba1\u7406\u9875\u4f1a\u4fdd\u7559\uff0c\u4e4b\u540e\u53ef\u518d\u6b21\u5f00\u542f\u3002',details:['\u5df2\u6392\u961f\u4efb\u52a1\u4fdd\u6301\u7b49\u5f85\uff0c\u4e0d\u4f1a\u6807\u8bb0\u5931\u8d25','\u5df2\u8fdb\u5165\u975e\u5e42\u7b49\u53d1\u9001\u9636\u6bb5\u7684\u4efb\u52a1\u6309\u5b89\u5168\u89c4\u5219\u8f6c\u4eba\u5de5\u786e\u8ba4'],confirmLabel:'\u5168\u90e8\u505c\u6b62'});if(!confirmed)return}
  button.disabled=true;button.classList.add('is-loading');
  if(current){button.querySelector('b').textContent='\u6b63\u5728\u505c\u6b62';button.querySelector('small').textContent='\u6b63\u5728\u5173\u95ed Local Agent\u2026';setStatus('#agentDot','#agentStatus',false,'\u6b63\u5728\u505c\u6b62')}
  else{button.querySelector('b').textContent='\u6b63\u5728\u5f00\u542f';button.querySelector('small').textContent='\u6b63\u5728\u8fde\u63a5 Local Agent\u2026';setStatus('#agentDot','#agentStatus',false,'\u8fde\u63a5\u4e2d')}
  try{
    const result=await api('/api/settings/operations',{method:'POST',body:JSON.stringify({enabled:!current,updatedBy:'\u8fd0\u8425\u5e2d\u4f4d'})});
    state.bootstrap.config.masterSwitch=result.settings;syncMasterSwitch(result.settings);
    let agentOnline=true;
    if(result.settings.enabled)agentOnline=await waitForLocalAgentOnline(10000,pageOwner);
    else{agentOnline=false;if(state.bootstrap.localAgent)state.bootstrap.localAgent={...state.bootstrap.localAgent,online:false,reachable:false,message:'Local Agent 已关闭'};state.bootstrap.devices=(state.bootstrap.devices||[]).map(device=>({...device,status:'OFFLINE'}));setStatus('#agentDot','#agentStatus',false,'\u5df2\u5173\u95ed')}
    if(state.page==='dashboard')renderDashboard();
    if(result.settings.enabled)toast(agentOnline?'\u5168\u5c40\u8fd0\u884c\u5df2\u6062\u590d\uff0cLocal Agent \u5df2\u542f\u52a8':'\u5168\u5c40\u8fd0\u884c\u5df2\u5f00\u542f\uff0cLocal Agent \u5fc3\u8df3\u540c\u6b65\u4e2d',!agentOnline);else toast(result.agentShutdown?.stopped?'\u5df2\u505c\u6b62\u5168\u5c40\u4efb\u52a1\u5e76\u5173\u95ed Local Agent':'\u5168\u5c40\u4efb\u52a1\u5df2\u505c\u6b62\uff0c\u4f46 Local Agent \u8fdb\u7a0b\u9000\u51fa\u9700\u8981\u68c0\u67e5',!result.agentShutdown?.stopped);
  }catch(error){syncMasterSwitch();toast(error.message,true)}finally{button.disabled=false;button.classList.remove('is-loading')}
}
async function fetchBootstrap(){return api('/api/bootstrap')}
function commitBootstrap(bootstrap){state.bootstrap=bootstrap;$('#qwenMode').textContent=`AI：${state.bootstrap.config.qwenMode==='mock'?'模拟模式':'在线模式'}`;syncMasterSwitch();const online=isLocalAgentOnline();setStatus('#cloudDot','#cloudStatus',true,'\u6b63\u5e38');setStatus('#agentDot','#agentStatus',online,online?'\u5728\u7ebf':'\u672a\u8fde\u63a5')}
function capturePageOwner(){return {page:state.page,pageGeneration:pageRenderGeneration}}
function ownsPageOwner(owner){return Boolean(owner)&&owner.page===state.page&&owner.pageGeneration===pageRenderGeneration}
function beginBootstrapRequest(pageOwner){
  if(!ownsPageOwner(pageOwner))return null;
  return {...pageOwner,requestGeneration:++bootstrapRequestGeneration};
}
function ownsBootstrapRequest(owner){return ownsPageOwner(owner)&&owner.requestGeneration===bootstrapRequestGeneration}
async function refreshBootstrap(pageOwner){
  const owner=beginBootstrapRequest(pageOwner);
  if(!owner)return null;
  const bootstrap=await fetchBootstrap();
  if(!ownsBootstrapRequest(owner))return null;
  commitBootstrap(bootstrap);
  return bootstrap;
}
function setStatus(d,s,on,t){$(d).className=on?'online':'offline';$(s).textContent=t}
function clearPublishLayoutSync(){
  if(!publishLayoutCleanup)return;
  publishLayoutCleanup();
  publishLayoutCleanup=null;
}
function setupPublishLayoutSync(expectedGeneration=pageRenderGeneration){
  clearPublishLayoutSync();
  if(state.page!=='publish'||expectedGeneration!==pageRenderGeneration)return;
  const mainPanel=$('.publish-main-column > .panel');
  const sideColumn=$('.publish-side-column');
  const sidePanel=$('.publish-side-column > .panel:not(.publish-history-panel)');
  const history=$('#publishHistory');
  if(!mainPanel||!sideColumn||!sidePanel||!history)return;
  let active=true,frame=0;
  const ownsPage=()=>active&&state.page==='publish'&&expectedGeneration===pageRenderGeneration&&mainPanel.isConnected&&sidePanel.isConnected&&history.isConnected;
  const clearHeight=()=>{
    history.classList.remove('is-height-limited');
    history.style.removeProperty('--publish-history-max-height');
  };
  const apply=()=>{
    if(!ownsPage())return;
    if(window.matchMedia('(max-width:960px)').matches){clearHeight();return}
    const sideStyles=getComputedStyle(sideColumn);
    const gap=parseFloat(sideStyles.rowGap||sideStyles.gap)||18;
    const available=Math.floor(mainPanel.getBoundingClientRect().height-sidePanel.getBoundingClientRect().height-gap);
    if(available<=0){clearHeight();return}
    history.style.setProperty('--publish-history-max-height',`${available}px`);
    history.classList.add('is-height-limited');
  };
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(apply)};
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  observer?.observe(mainPanel);
  observer?.observe(sidePanel);
  window.addEventListener('resize',schedule,{passive:true});
  schedule();
  publishLayoutCleanup=()=>{
    active=false;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize',schedule);
    clearHeight();
  };
}
function navigate(p,view=null,presentation=null){
  cleanupKnowledgeFiles();
  cleanupKnowledgeTools();
  if(p==='knowledge'){view=['persona','playground'].includes(view)?view:'rag';presentation=({persona:'persona',playground:'playground',rag:'documents'})[view]}
  const nextPresentation=presentation||({publish:'content',knowledge:'documents',wecom:'ai'}[p]||null);
  const sectionReady=$(({publish:'#publishForm',wecom:'[data-settings-config-frame]',knowledge:'.rag-knowledge-page'}[p])||'#workspace-section-unavailable');
  const sameSection=Boolean(presentation)&&Boolean(sectionReady)&&state.page===p&&['publish','wecom','knowledge'].includes(p)&&(p!=='knowledge'||state.knowledgeView===(view||'rag'))&&!$('#content').dataset.pageLoading&&$('#content').children.length>0;
  state.workspacePresentation=nextPresentation;
  if(sameSection){presentWorkspace();syncWorkspaceNavigation();syncNavigationHash();window.scrollTo({top:0,left:0,behavior:'auto'});return Promise.resolve();}
  clearPublishLayoutSync();
  /* 每次进入页面都重新拉取运营看板数据，保证切换/刷新后看到的是最新口径。 */
  operationsDashboardKey=null;
  if(publishSchedulePollTimer){clearInterval(publishSchedulePollTimer);publishSchedulePollTimer=null;}
  if(['studio','topics','script','material-editing','library','editing'].includes(p))p='create';
  if(p==='accounts')p='platforms';
  if(p==='gaps'){state.knowledgeView='rag';p='knowledge'}
  else if(p==='knowledge'){state.knowledgeView=view||'rag'}
  else if(p==='messages'&&['COMMENT','PRIVATE_MESSAGE'].includes(view)){state.messageView=view}
  state.page=p;
  if(p!=='publish'){state.precheck=null;state.compliance=null;state.trafficPrediction=createTrafficPredictionState();state.retryDraft=null;state.retrySourceTaskId=null}
  if(p!=='knowledge'){state.knowledgeCategory=null;state.knowledgeSubcategory=null}
  const sequence=++workspaceNavigationSequence;
  syncWorkspaceNavigation();
  $('#content').setAttribute('aria-busy','true');
  $('#content').dataset.pageLoading=p;
  $('#content').innerHTML='<div class="empty page-loading" role="status">正在加载…</div>';
  return render().then(()=>{
    if(sequence!==workspaceNavigationSequence)return;
    syncWorkspaceNavigation();
    syncNavigationHash();
    window.scrollTo({top:0,left:0,behavior:'auto'});
  }).catch(e=>{
    if(sequence!==workspaceNavigationSequence)return;
    toast(e.message,true);
    $('#content').innerHTML=`<div class="empty">页面加载失败：${esc(e.message)}</div>`;
    window.scrollTo({top:0,left:0,behavior:'auto'});
  }).finally(()=>{if(sequence===workspaceNavigationSequence){$('#content').removeAttribute('aria-busy');delete $('#content').dataset.pageLoading}});
}
function syncNavigationHash(){
  try{
    const {item}=currentWorkspaceRoute();
    const hash='#'+item.key;
    if(location.hash!==hash)history.replaceState(null,'',hash);
  }catch{}
}
/* 地址栏 hash 与工作区导航双向同步：
   1) 启动时按 #key 打开页面（#studio / #publishing / #publish-tasks 等）；
      旧创作页面深链统一跳转到 #studio。
   2) 手动改地址栏或用浏览器前进后退时同步切换工作区。
   注意：navigate() 内部用 replaceState 写 hash，不会触发 hashchange，故此处不会自激循环。 */
function resolveWorkspaceHash(rawHash){
  const raw=String(rawHash||'').replace(/^#/,'').trim().toLowerCase();
  if(!raw)return null;
  if(['versions','aliases','handoff-rules'].includes(raw))return workspaceGroups.find(group=>group.id==='knowledge').items[0];
  if(raw==='xiaozhi')return workspaceGroups.find(group=>group.id==='knowledge').items.find(item=>item.key==='reply-test');
  if(['topics','script','material-editing','library','create','editing'].includes(raw)){
    return workspaceGroups.find(group=>group.id==='content').items[0];
  }
  /* 刻意不出现在侧边栏的页面（浏览器控制 / 相似问法 / 问题汇总）同样允许用深链直达，
     隐藏的是导航入口而不是页面本身。 */
  for(const group of workspaceGroups){
    const item=group.items.find(i=>i.key===raw);
    if(item)return item;
  }
  /* 兼容设计稿的 `#页面名` 写法（#dashboard / #create / #browser / #knowledge ...）：
     设计稿把 hash 直接当作 state.page，本项目主键是栏目 key，两种写法都接受，
     以免旧链接与手工书签失效。 */
  for(const group of workspaceGroups){
    const item=group.items.find(i=>String(i.page).toLowerCase()===raw);
    if(item)return item;
  }
  return null;
}
function applyWorkspaceHash(rawHash){
  const target=resolveWorkspaceHash(rawHash);
  if(!target)return false;
  const {item:current}=currentWorkspaceRoute();
  if(current&&current.key===target.key&&state.page===target.page){syncNavigationHash();return false}
  navigate(target.page,target.view||null,target.presentation||null);
  return true;
}
window.addEventListener('hashchange',()=>{if(!state.appStarted)return;applyWorkspaceHash(location.hash)});
// Only read requests are overlapped with bootstrap. Nothing is cached across navigations.
function settlePageRead(promise){return promise.then(data=>({data}),error=>({error}))}
function preloadPageData(page){
  if(page==='tasks'){const selected=state.taskPlatform&&state.taskPlatform!=='ALL'?state.taskPlatform:null;return settlePageRead(api('/api/tasks'+(selected?`?platformCode=${encodeURIComponent(selected)}`:'')))}
  if(page==='messages')return settlePageRead(api('/api/messages'));
  if(page==='handoffs')return settlePageRead(api('/api/manual-handoffs?limit=500'));
  if(page==='wecom')return settlePageRead(Promise.all([api('/api/settings/wecom'),api('/api/settings/ai?limit=100')]));
  if(page==='knowledge'&&state.knowledgeView==='rag')return settlePageRead(loadRagKnowledgeData());
  return null;
}
async function render(){
  cleanupKnowledgeTools();
  cleanupWechatAdmin();
  hideHotTopicStudio();
  $('#content').onclick=null;$('#content').oninput=null;$('#content').onchange=null;
  const page=state.page;
  const generation=++pageRenderGeneration;
  pageRenderInFlightGeneration=generation;
  const ownsRender=()=>generation===pageRenderGeneration&&state.page===page;
  const pendingData=preloadPageData(page);
  try{
    const bootstrap=await refreshBootstrap({page,pageGeneration:generation});
    if(!bootstrap||!ownsRender())return;
    const prefetched=pendingData?await pendingData:null;
    if(!ownsRender())return;
    if(prefetched?.error)throw prefetched.error;
    if(page==='wechat')return renderWechatAdmin($('#content'));
    const renderer=({dashboard:renderDashboard,create:renderContentStudio,creativeSettings:renderContentStudio,editing:renderMaterialEditor,publish:renderPublish,tasks:renderTasks,messages:renderMessages,miniProgram:renderMiniProgramConversations,handoffs:renderManualHandoffs,knowledge:renderKnowledge,browser:renderBrowserControl,issues:renderIssues,wecom:renderWecom,platforms:renderPlatformRuntimePage}[page]||renderDashboard);
    const result=page==='publish'||page==='miniProgram'?await renderer({pageGeneration:generation}):await renderer(prefetched?.data);
    if(ownsRender())presentInteractions();
    return result;
  }catch(error){
    if(!ownsRender())return;
    throw error;
  }finally{if(pageRenderInFlightGeneration===generation){pageRenderInFlightGeneration=0;$('#content').removeAttribute('aria-busy');delete $('#content').dataset.pageLoading}}
}
function metric(l,v,h,tone,icon,target){return `<button type="button" class="metric metric-action" data-go="${target}" aria-label="查看${l}" style="--metric-tone:${tone}"><div class="metric-top"><span class="metric-icon">${iconSvg(icon)}</span><span class="metric-live">查看 →</span></div><span class="metric-label">${l}</span><div class="metric-value"><strong>${v}</strong><i></i></div><small>${h}</small></button>`}
function aiUsageMetric(summary={}){const calls=Number(summary.calls||0).toLocaleString('zh-CN');const tokens=Number(summary.total_tokens||0).toLocaleString('zh-CN');return metric('今日 AI 用量',`${calls} 次`,`Token ${tokens} · 估算费用 ${aiCostValue(summary.estimated_cost_cny)}`,'#6455d9','wecom','wecom')}
/* ==========================================================================
   运营总览看板（智慧驱动）
   数据来源：GET /api/operations-dashboard（服务端按既有业务表聚合）
   口径约定：未接入数据源的核心指标不展示，不编造任何数值。
   ========================================================================== */
const operationsRangeLabels={'7d':'近 7 天','30d':'近 30 天'};
/* 已加载的看板筛选键（range|platform）。为空或与当前筛选不一致时才重新请求，
   避免仪表盘每次重绘、每次定时刷新都打一次接口。 */
let operationsDashboardKey=null;
let operationsAnalyticsRefreshTimer=null;
let operationsDashboardRequest=0;
let operationsDashboardSignatureValue='';
let operationsDashboardRefreshOwner=null;
// Response generation time changes on every read; only displayed data should rebuild the dashboard.
function operationsDashboardSignature(data){
  const values={...data,updatedAt:undefined,analytics:{...data.analytics,updatedAt:undefined}};
  return JSON.stringify({range:state.dashboardRange,platform:state.dashboardPlatform,data:values,bootstrap:state.bootstrap});
}
function scheduleOperationsDashboardRefresh(){
  if(operationsAnalyticsRefreshTimer)clearTimeout(operationsAnalyticsRefreshTimer);
  operationsAnalyticsRefreshTimer=setTimeout(()=>{
    operationsAnalyticsRefreshTimer=null;
    void refreshOperationsDashboard({background:true});
  },30000);
}
function operationsFormat(key,value){
  const rounded=Math.round(Number(value)||0);
  if(key==='exposure'&&rounded>=10000)return `${(rounded/10000).toFixed(1).replace(/\.0$/,'')}万`;
  return rounded.toLocaleString('zh-CN');
}
function operationsPending(note){return `<span class="operations-pending" title="${esc(note||'待接入数据源')}">待接入</span>`}
function operationsKpiValue(item){
  if(item.status==='READY'&&item.value!==null&&item.value!==undefined)return operationsFormat(item.key,item.value);
  return operationsPending(item.pendingNote);
}
async function loadOperationsDashboard(){
  const request=++operationsDashboardRequest;
  const key=`${state.dashboardRange}|${state.dashboardPlatform}`;
  const params=new URLSearchParams({range:state.dashboardRange,platform:state.dashboardPlatform});
  try{
    const d=await api(`/api/operations-dashboard?${params.toString()}`);
    if(request===operationsDashboardRequest&&key===`${state.dashboardRange}|${state.dashboardPlatform}`)state.operationsDashboard=d.dashboard||null;
  }catch(error){
    if(request===operationsDashboardRequest&&key===`${state.dashboardRange}|${state.dashboardPlatform}`)state.operationsDashboard={error:error.message,kpis:[],channels:[],content:[],funnel:[],trend:[],recommendations:[],updatedAt:null};
  }
}
function operationsDashboardData(){
  const d=state.operationsDashboard||{};
  return {
    error:d.error||null,
    updatedAt:d.updatedAt||null,
    pendingNote:d.pendingNote||'该指标需要接入平台数据源后才能统计',
    kpis:Array.isArray(d.kpis)?d.kpis:[],
    published:d.published&&typeof d.published==='object'?d.published:null,
    analytics:d.analytics&&typeof d.analytics==='object'?d.analytics:{accounts:[],coverage:{}},
    channels:Array.isArray(d.channels)?d.channels:[],
    content:Array.isArray(d.content)?d.content:[],
    funnel:Array.isArray(d.funnel)?d.funnel:[],
    recommendations:Array.isArray(d.recommendations)?d.recommendations:[],
    trend:Array.isArray(d.trend)?d.trend:[]
  };
}
function operationsSectionTitle(number,title,description){return `<div class="operations-section-title"><span>${number}</span><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div></div>`}
function operationsAnalyticsMarkup(analytics={}){
  const accounts=Array.isArray(analytics.accounts)?analytics.accounts:[];
  const coverage=analytics.coverage||{};
  const names={douyin:'抖音',wechat_channels:'视频号',bilibili:'B站',weibo:'微博',xiaohongshu:'小红书'};
  const cards=accounts.map(account=>{
    const metrics=(Array.isArray(account.metrics)?account.metrics:[]).filter(metric=>Number.isFinite(metric.value));
    const identity=account.accountIdentity?.name||account.identity?.name||account.accountName||'';
    return `<article class="operations-analytics-account"><div class="operations-analytics-account-head"><div><b>${esc(names[account.platformCode]||account.platformCode)}</b><span>${esc(identity)}</span></div><small>${account.status==='STALE'?'历史读数 · ':''}${esc(account.capturedAt?fmt(account.capturedAt):'等待采集')}</small></div><dl>${metrics.map(metric=>{
      const date=value=>new Date(value).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
      const scope=metric.scope==='PERIOD'&&metric.periodStart&&metric.periodEnd?`${date(metric.periodStart)} 至 ${date(metric.periodEnd)}`:'平台页面最新读数';
      return `<div><dt>${esc(metric.label)}</dt><dd>${metric.approximate?'约 ':''}${esc(metric.approximate&&metric.rawValue?metric.rawValue:operationsFormat(metric.key,metric.value))}</dd><small>${esc(scope)}</small></div>`;
    }).join('')}</dl></article>`;
  }).join('');
  const pending=Array.isArray(coverage.missing)?coverage.missing:[];
  const reasons={ACCOUNT_NOT_READY:'账号未登录',PLATFORM_PAUSED:'平台已停止',IDENTITY_CHANGED:'账号身份待核对',ACCOUNT_IDENTITY_CHANGED:'登录账号与绑定账号不一致',NEVER_COLLECTED:'等待首次采集',COLLECTION_QUEUED:'等待业务空闲采集',COLLECTION_RUNNING:'正在采集',DATA_PAGE_TIMEOUT:'数据页加载超时，稍后重试',DATA_PAGE_NOT_READY:'暂未读取到平台指标'};
  return `<section class="operations-surface operations-analytics-panel"><header><div><h2>平台运营数据</h2><p>平台最新读数，累计值不计入周期新增。</p></div><button type="button" class="btn secondary" id="collectOperationsAnalytics">采集平台数据</button></header>${cards?`<div class="operations-analytics-grid">${cards}</div>`:'<p class="operations-analytics-empty">等待首次采集，可手动采集平台数据。</p>'}${pending.length?`<p class="operations-analytics-coverage">${pending.map(item=>`${esc(names[item.platformCode]||item.platformCode)}：${esc(reasons[item.reason]||'等待有效数据')}`).join('；')}</p>`:''}<p class="operations-analytics-note">每 30 分钟尝试更新，业务任务优先；未接入指标保留空缺。</p></section>`;
}
function operationsTrendChart(items){
  if(!items.length)return `<div class="operations-chart-empty">${operationsPending('曝光、关注、引流需要平台数据源')}<p>接入平台曝光与粉丝数据后，这里会显示每日趋势曲线。</p></div>`;
  const left=52,right=686,top=24,bottom=184;
  const x=index=>left+(right-left)*(index/Math.max(1,items.length-1));
  const exposureMax=Math.max(...items.map(item=>item.exposure),1)*1.12;
  const peopleMax=Math.max(...items.flatMap(item=>[item.followers,item.leads]),1)*1.12;
  const y=(value,max)=>bottom-(bottom-top)*(value/max);
  const path=(key,max)=>items.map((item,index)=>`${index?'L':'M'} ${x(index).toFixed(1)} ${y(item[key],max).toFixed(1)}`).join(' ');
  const exposurePath=path('exposure',exposureMax);
  const area=`${exposurePath} L ${right} ${bottom} L ${left} ${bottom} Z`;
  const grid=[0,.25,.5,.75,1].map(ratio=>{const lineY=bottom-(bottom-top)*ratio;return `<line x1="${left}" y1="${lineY}" x2="${right}" y2="${lineY}"/><text x="3" y="${lineY+4}">${operationsFormat('exposure',exposureMax*ratio)}</text><text x="696" y="${lineY+4}">${operationsFormat('followers',peopleMax*ratio)}</text>`}).join('');
  const labels=items.map((item,index)=>`<text class="operations-trend-x" x="${x(index)}" y="207" text-anchor="middle">${esc(item.label)}</text>`).join('');
  const exposureDots=items.map((item,index)=>`<circle class="operations-exposure-dot" cx="${x(index)}" cy="${y(item.exposure,exposureMax)}" r="3"/>`).join('');
  const last=items.at(-1);
  return `<svg class="operations-trend-svg" viewBox="0 0 740 218" role="img" aria-label="曝光、关注与引流趋势图"><defs><linearGradient id="operationsExposureArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#78e6cb" stop-opacity=".24"/><stop offset="1" stop-color="#78e6cb" stop-opacity=".02"/></linearGradient></defs><g class="operations-chart-grid">${grid}</g><path class="operations-exposure-area" d="${area}"/><path class="operations-exposure-line" d="${exposurePath}"/><path class="operations-followers-line" d="${path('followers',peopleMax)}"/><path class="operations-leads-line" d="${path('leads',peopleMax)}"/>${exposureDots}${labels}<g class="operations-chart-tip" transform="translate(${Math.max(left,right-91)} 8)"><rect width="86" height="34" rx="5"/><text x="9" y="13">${esc(last.label)}曝光</text><text class="operations-chart-tip-value" x="9" y="27">${operationsFormat('exposure',last.exposure)}</text></g><text class="operations-chart-axis" x="4" y="13">曝光</text><text class="operations-chart-axis" x="704" y="13">关注/引流</text></svg>`;
}
function operationsFunnelValue(item){return item.status==='READY'&&item.value!==null&&item.value!==undefined?operationsFormat(item.key,item.value):operationsPending(item.pendingNote)}
function operationsConversion(from,to){
  const read=item=>item&&item.status==='READY'&&item.value!==null&&item.value!==undefined?Number(item.value):null;
  const a=read(from),b=read(to);
  if(a===null||b===null||a===0)return operationsPending('需要曝光的完整转化数据');
  return `${(b/Math.max(1,a)*100).toFixed(2)}%`;
}
async function renderDashboard({background=false}={}){
  const generation=pageRenderGeneration;
  const key=`${state.dashboardRange}|${state.dashboardPlatform}`;
  if(operationsDashboardKey!==key){
    operationsDashboardKey=key;
    await loadOperationsDashboard();
    if(generation!==pageRenderGeneration||state.page!=='dashboard'||key!==`${state.dashboardRange}|${state.dashboardPlatform}`)return;
  }
  const data=operationsDashboardData();
  const signature=operationsDashboardSignature(data);
  if(background&&$('#content .operations-dashboard')&&signature===operationsDashboardSignatureValue){
    const stamp=$('[data-operations-updated-at]');
    const updated= data.updatedAt ? fmt(data.updatedAt) : '刚刚';
    if(stamp&&stamp.textContent!==updated)stamp.textContent=updated;
    return;
  }
  const running=state.bootstrap.config.masterSwitch?.enabled!==false;
  const publishedKpi=data.published;
  const maxPublished=Math.max(...data.channels.map(item=>Number(item.published)||0),1);
  const readyKpis=data.kpis.filter(item=>item.status==='READY'&&item.value!==null&&item.value!==undefined);
  const updatedAt=data.updatedAt?new Date(data.updatedAt):null;
  const updatedText=updatedAt&&!Number.isNaN(updatedAt.getTime())?fmt(updatedAt.toISOString()):'刚刚';
  const topPublished=[...data.channels].sort((a,b)=>(Number(b.published)||0)-(Number(a.published)||0))[0];
  const funnelOf=key=>data.funnel.find(item=>item.key===key);
  const defaultPlatforms=[
    {code:'douyin',name:'抖音'},{code:'xiaohongshu',name:'小红书'},{code:'wechat_channels',name:'视频号'},
    {code:'bilibili',name:'B站'},{code:'weibo',name:'微博'}
  ];
  const channelOptions=data.channels.length?data.channels:defaultPlatforms;
  const target=background?document.createElement('section'):$('#content');
  target.innerHTML=`<div class="operations-dashboard">
    <div class="operations-overview-head">
      <div><h2>运营指标</h2><p>口径：${esc(operationsRangeLabels[state.dashboardRange]||'近 7 天')} · ${state.dashboardPlatform==='all'?'全部平台':'单平台'} · 数据更新时间：<span data-operations-updated-at>${esc(updatedText)}</span></p></div>
      <div class="operations-filters">
        <label><span>平台</span><select id="operationsPlatformFilter" aria-label="平台筛选"><option value="all">全部平台</option>${channelOptions.map(item=>`<option value="${esc(item.code)}"${state.dashboardPlatform===item.code?' selected':''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label><span>周期</span><select id="operationsRangeFilter" aria-label="统计周期"><option value="7d"${state.dashboardRange==='7d'?' selected':''}>近 7 天</option><option value="30d"${state.dashboardRange==='30d'?' selected':''}>近 30 天</option></select></label>
      </div>
    </div>
    ${running?'':`<div class="operations-pause-banner"><span>II</span><div><b>全局运行与 Local Agent 已停止</b><p>运营数据仍可查看，但当前不会领取新任务。</p></div><button type="button" data-master-resume>\u542f\u52a8 Agent \u5e76\u6062\u590d\u8fd0\u884c</button></div>`}
    ${data.error?`<div class="notice warn"><span class="notice-icon">!</span><div><b>运营看板数据读取失败</b><p>${esc(data.error)}</p></div></div>`:''}
    ${readyKpis.length?`<section class="operations-kpi-grid" aria-label="核心运营指标">${readyKpis.map(item=>`<article class="operations-kpi"><div class="operations-kpi-head"><span class="operations-kpi-icon">${iconSvg(item.icon)}</span><span class="operations-kpi-label">${esc(item.label)}</span></div><strong>${operationsKpiValue(item)}</strong><p><b>${esc(item.scope||'本周期')}</b><span>${esc(item.note||'按发布时间统计')}</span></p></article>`).join('')}</section>`:''}
    ${operationsAnalyticsMarkup(data.analytics)}
    <div class="operations-analysis-grid">
      <section class="operations-surface operations-trend-panel">
        <header>${operationsSectionTitle('02','推广趋势','曝光、关注与引流的每日变化')}<div class="operations-legend"><span><i class="is-exposure"></i>曝光</span><span><i class="is-followers"></i>关注</span><span><i class="is-leads"></i>引流</span></div></header>
        <div class="operations-chart">${operationsTrendChart(data.trend)}</div>
      </section>
      <section class="operations-surface operations-channel-panel">
        <header>${operationsSectionTitle('03','渠道效果','各平台发布量与曝光、引流贡献')}</header>
        <div class="operations-channel-summary">
          <div><span>发布量最高</span><strong>${topPublished&&topPublished.published?`${esc(topPublished.name)} ${operationsFormat('published',topPublished.published)} 条`:'暂无发布'}</strong></div>
          <div><span>曝光与引流</span><strong>${operationsPending('需要平台曝光与引流数据源')}</strong></div>
        </div>
        <div class="operations-channel-list">${channelOptions.map(item=>{const published=Number(item.published)||0;return `<div class="operations-channel-row"><b>${esc(item.name)}</b><div class="operations-channel-track" aria-label="${esc(item.name)}发布量 ${published} 条"><i style="width:${(published/maxPublished*100).toFixed(1)}%"></i><em style="width:0%"></em></div><span>${published?`发布 ${published} 条`:'暂无发布'} / ${operationsPending('曝光、引流待接入')}</span></div>`}).join('')}</div>
      </section>
    </div>
    <div class="operations-detail-grid">
      <section class="operations-surface operations-content-panel">
        <header>${operationsSectionTitle('04','内容效果','已发布内容清单与表现')}<button type="button" data-go="tasks">查看全部 <span>→</span></button></header>
        <div class="operations-table-wrap"><table class="operations-content-table"><thead><tr><th>内容</th><th>曝光量</th><th>有效引流</th><th>发布状态</th></tr></thead><tbody>${data.content.length?data.content.map((item,index)=>`<tr><td><div class="operations-content-name"><span class="${index===0?'is-top':''}">${index+1}</span><div><b>${esc(item.title||'未命名内容')}</b><small>${esc(item.platformName||'')} · ${esc(item.publishedAt?fmt(item.publishedAt):'未记录发布时间')}</small></div></div></td><td>${operationsPending('需要平台曝光数据源')}</td><td>${operationsPending('需要引流归因数据源')}</td><td><em>${esc(item.statusLabel||'已发布')}</em></td></tr>`).join(''):`<tr><td colspan="4" class="operations-empty">当前筛选条件下暂无已发布内容</td></tr>`}</tbody></table></div>
      </section>
      <section class="operations-surface operations-funnel-panel">
        <header>${operationsSectionTitle('05','活动转化','曝光 → 报名 → 到场 → 入群')}</header>
        <div class="operations-funnel">${data.funnel.map(item=>`<div><span>${esc(item.label)}</span><strong>${operationsFunnelValue(item)}</strong></div>`).join('')}</div>
        <div class="operations-conversions">
          <div><span>曝光 → 报名</span><strong>${operationsConversion(funnelOf('exposure'),funnelOf('registrations'))}</strong></div>
          <div><span>报名 → 到场</span><strong>${operationsConversion(funnelOf('registrations'),funnelOf('attendance'))}</strong></div>
          <div><span>到场 → 入群</span><strong>${operationsConversion(funnelOf('attendance'),funnelOf('groups'))}</strong></div>
        </div>
        <p class="operations-funnel-note">报名、签到及入群数据待接入。</p>
      </section>
    </div>
    <section class="operations-ai-panel">
      <div class="operations-ai-intro"><span>06 · AI OPERATIONS</span><div class="operations-section-title"><i>AI</i><div><h2>AI 运营建议</h2><p>今日建议</p></div></div><small>${iconSvg('dashboard')}当前周期发布量 ${publishedKpi&&publishedKpi.status==='READY'?operationsFormat('published',publishedKpi.value):'待接入'} 条</small></div>
      <div class="operations-recommendations">${data.recommendations.length?data.recommendations.map(item=>`<article><div><span>${esc(item.type)}</span><em>${esc(item.priority)}</em></div><strong>${esc(item.title)}</strong><p>${esc(item.description)}</p><button type="button" data-go="${esc(item.target)}">${esc(item.actionLabel)} <span>→</span></button></article>`).join(''):'<article><div><span>数据不足</span><em>提示</em></div><strong>暂无可生成的运营建议</strong><p>当系统产生发布、互动或知识缺口记录后，这里会自动给出优先动作。</p><button type="button" data-go="publish">去创建内容 <span>→</span></button></article>'}</div>
    </section>
  </div>
  ${dashboardRuntimeMarkup()}`;
  const context={page:'dashboard',onNavigate:openWorkspaceItem,data,stats:state.bootstrap.stats,accounts:state.bootstrap.accounts||[],localAgent:state.bootstrap.localAgent||{}};
  applyWorkspacePresentation(target,context);
  if(background){
    patchBackgroundContent($('#content'),target);
    refreshDashboardOrb($('#content'),context);
  }
  bindOperationsDashboard();
  bindDashboardRuntime();
  operationsDashboardSignatureValue=signature;
}
function bindOperationsDashboard(){
  document.querySelectorAll('#content [data-go]').forEach(button=>button.onclick=()=>navigate(button.dataset.go));
  const resume=$('[data-master-resume]');if(resume)resume.onclick=()=>toggleMasterSwitch();
  const platformFilter=$('#operationsPlatformFilter');
  if(platformFilter)platformFilter.onchange=()=>{state.dashboardPlatform=platformFilter.value;refreshOperationsDashboard()};
  const rangeFilter=$('#operationsRangeFilter');
  if(rangeFilter)rangeFilter.onchange=()=>{state.dashboardRange=rangeFilter.value;refreshOperationsDashboard()};
  const collectAnalytics=$('#collectOperationsAnalytics');
  if(collectAnalytics)collectAnalytics.onclick=async()=>{
    collectAnalytics.disabled=true;
    try{
      const result=await api('/api/operations-dashboard/collect',{method:'POST',body:JSON.stringify({platformCode:state.dashboardPlatform})});
      toast(result.paused?'当前执行模式未启用平台数据采集':result.jobs?.length?`已安排 ${result.jobs.length} 个平台数据采集任务，完成后自动更新`:'平台正在处理业务或刚刚采集，请稍后查看');
      await refreshOperationsDashboard();
    }catch(error){toast(error.message,true)}finally{if(collectAnalytics.isConnected)collectAnalytics.disabled=false}
  };
  scheduleOperationsDashboardRefresh();
}
async function refreshOperationsDashboard({background=false}={}){
  if(state.page!=='dashboard')return;
  if(background&&(operationsDashboardRefreshOwner||document.hidden||document.querySelector('.confirm-overlay,#collectOperationsAnalytics:disabled,#dashboardOpenPlatforms:disabled,#dashboardCheckPlatforms:disabled')||messageFormHasEditingFocus())){
    scheduleOperationsDashboardRefresh();
    return;
  }
  const owner=capturePageOwner();
  operationsDashboardRefreshOwner=owner;
  if(!background)$('#content').setAttribute('aria-busy','true');
  try{
    operationsDashboardKey=null;
    await renderDashboard({background});
  }catch(error){if(ownsPageOwner(owner))toast(error.message,true)}
  finally{
    if(operationsDashboardRefreshOwner===owner)operationsDashboardRefreshOwner=null;
    if(ownsPageOwner(owner)){
      if(!background)$('#content').setAttribute('aria-busy','false');
      scheduleOperationsDashboardRefresh();
    }
  }
}
function dashboardRuntimeMarkup(){
  const s=state.bootstrap.stats;
  const running=state.bootstrap.config.masterSwitch?.enabled!==false;
  const loginPoll=state.bootstrap.config.loginStatusPoll||{};
  const loginPollMinutes=Math.max(1,Math.round(Number(loginPoll.intervalMs||120000)/60000));
  const loginAuditText=loginPoll.enabled?`自动轮询已开启：每 ${loginPollMinutes} 分钟检查；退出登录需连续 ${loginPoll.logoutConfirmations||3} 次明确证据一致后才发送企微告警。`:'自动轮询未开启；可使用右侧按钮进行人工检查。';
  const devices=state.bootstrap.devices||[];
  const accounts=state.bootstrap.accounts||[];
  const activeCodes=state.bootstrap?.config?.activePlatformCodes||loginPlatforms.map(item=>item.code);
  const enabledActiveAccounts=accounts.filter(account=>activeCodes.includes(account.platform_code)&&account.enabled!==0);
  const loggedInCount=enabledActiveAccounts.filter(account=>accountLoginState(account)==='READY').length;
  const onlineDeviceCount=devices.filter(device=>device.status==='ONLINE').length;
  const deviceHealthy=devices.length>0&&onlineDeviceCount===devices.length;
  const latestLoginCheck=enabledActiveAccounts.map(account=>account.login_checked_at).filter(Boolean).sort((a,b)=>new Date(b)-new Date(a))[0]||null;
  const latestDeviceHeartbeat=devices.map(device=>device.last_heartbeat).filter(Boolean).sort((a,b)=>new Date(b)-new Date(a))[0]||null;
  const dashboardDeviceCards=devices.length?devices.map((device,index)=>{
    const online=device.status==='ONLINE';
    return `<article class="dashboard-device-card ${online?'is-online':'is-offline'}" id="dashboardDeviceCard-${index}"><div class="dashboard-device-card-head"><span class="dashboard-device-icon">${iconSvg('accounts')}</span><div><small>LOCAL AGENT DEVICE</small><b>${esc(device.name)}</b></div>${badge(device.status)}</div><div class="dashboard-device-meta"><span><small>设备 ID</small><b>${esc(device.id)}</b></span><span><small>Agent 版本</small><b>${esc(device.agent_version||'—')}</b></span></div><div class="dashboard-device-heartbeat"><span><i></i>${online?'连接正常':'连接异常'}</span><b>最近心跳 ${fmt(device.last_heartbeat)}</b></div></article>`;
  }).join(''):'<div class="dashboard-device-empty"><span>'+iconSvg('accounts')+'</span><div><b>暂未发现 RPA 设备</b><small>Local Agent 上线后会自动显示在这里。</small></div></div>';

  return `    <div class="section-title"><div><span>07 · EXECUTION ENVIRONMENT</span><h2>运行情况</h2></div><p></p></div>
    <div class="grid cols-3 metric-grid">
      ${metric('转人工记录',s.handoffRecords,'已创建的人工接管通知','#ef6a71','issues','handoffs')}
      ${metric('AI 已回复',s.autoReplies,'自动处理完成','#35b68a','messages','messages')}
      ${aiUsageMetric(s.aiUsageToday)}    </div>
    <div class="panel platform-login-overview dashboard-runtime-overview${deviceHealthy?'':' has-device-alert'}">
      <div class="panel-head dashboard-runtime-head"><div><span class="panel-kicker">EXECUTION ENVIRONMENT</span><h2>设备与登录状态</h2><p><br>${esc(loginAuditText)}</p></div><div class="button-row"><button class="btn secondary" id="dashboardOpenPlatforms">打开已启用平台</button><button class="btn" id="dashboardCheckPlatforms">检查登录状态</button><button class="btn ghost" type="button" data-go="platforms">平台启停</button></div></div>
      <div class="dashboard-runtime-layout">
        <section class="dashboard-runtime-zone dashboard-device-zone">
          <div class="dashboard-runtime-zone-head"><div><span>RPA DEVICE</span><h3>执行设备</h3></div><strong class="dashboard-zone-stat ${deviceHealthy?'is-healthy':'is-alert'}" id="dashboardDeviceSummaryCount">${devices.length?`${onlineDeviceCount}/${devices.length} 在线`:'暂无设备'}</strong></div>
          <div class="dashboard-device-list">${dashboardDeviceCards}</div>
          <div class="dashboard-zone-foot"><span>素材与登录态保留在本机</span><b id="dashboardDeviceLatest">最近心跳 ${fmt(latestDeviceHeartbeat)}</b></div>
        </section>
        <section class="dashboard-runtime-zone dashboard-login-zone">
          <div class="dashboard-runtime-zone-head"><div><span>PLATFORM LOGIN</span><h3>五平台登录状态</h3></div><strong class="dashboard-zone-stat ${loggedInCount===enabledActiveAccounts.length&&enabledActiveAccounts.length?'is-healthy':'is-alert'}" id="dashboardLoginSummaryCount">${loggedInCount}/${enabledActiveAccounts.length} 已登录</strong></div>
          <div class="platform-login-grid">${loginPlatforms.map(p=>{const a=accounts.find(x=>x.platform_code===p.code);const runtime=state.bootstrap.platforms?.find(x=>x.code===p.code);const planned=runtime?.lifecycle_state==='PLANNED';const m=planned?{text:'RPA方案规划中',cls:'planned'}:loginStatusMeta(accountLoginState(a));const detail=planned?'平台尚未正式接入':accountLoginDetail(a);return `<div class="platform-login-item${planned?' planned':''}" id="dashboardPlatformCard-${p.code}"><b>${esc(p.name)}</b>${p.acceptanceNote?`<span class="badge warning">${esc(p.acceptanceNote)}</span>`:''}<span class="badge ${m.cls}" id="dashboardPlatformStatus-${p.code}">${m.text}</span><small id="dashboardPlatformDetail-${p.code}">${detail}</small></div>`}).join('')}</div>
          <div class="dashboard-zone-foot"><span>无法确认时不冒充已登录</span><b id="dashboardLoginSummaryLatest">最近检查 ${fmt(latestLoginCheck)}</b></div>
        </section>
      </div>
    </div>
    <div class="dashboard-layout">
      <div class="panel operation-panel">
        <div class="panel-head"><div><span class="panel-kicker">OPERATIONS PIPELINE</span><h2>五平台运营闭环</h2><p>从本地素材到互动回复，每一步都有明确状态与人工兜底。</p></div><span class="panel-status${running?'':' paused'}"><i></i>${running?'流程在线':'流程已暂停'}</span></div>
        <div class="operations-pipeline">
          <div class="pipeline-step"><span>01</span><i>${iconSvg('publish')}</i><div><b>本地选材</b><small>素材不上云</small></div></div><div class="pipeline-line"></div>
          <div class="pipeline-step"><span>02</span><i>${iconSvg('tasks')}</i><div><b>平台预检</b><small>格式与账号</small></div></div><div class="pipeline-line"></div>
          <div class="pipeline-step"><span>03</span><i>${iconSvg('issues')}</i><div><b>内容合规</b><small>规则与风险</small></div></div><div class="pipeline-line"></div>
          <div class="pipeline-step"><span>04</span><i>${iconSvg('dashboard')}</i><div><b>RPA 提交</b><small>本机执行</small></div></div><div class="pipeline-line"></div>
          <div class="pipeline-step"><span>05</span><i>${iconSvg('knowledge')}</i><div><b>审核复核</b><small>结果确认</small></div></div><div class="pipeline-line"></div>
          <div class="pipeline-step"><span>06</span><i>${iconSvg('messages')}</i><div><b>互动闭环</b><small>回复与沉淀</small></div></div>
        </div>
        <div class="notice warn operations-notice"><span class="notice-icon">!</span><div><b>发布状态安全口径</b><p>“已提交”需经平台确认才记为“已发布”；结果不明时暂停并转人工。</p></div></div>
      </div>
      <aside class="panel safety-panel">
        <div class="panel-head"><div><span class="panel-kicker">SAFETY PRINCIPLES</span><h2>安全执行原则</h2></div></div>
        <div class="safety-list">
          <div><span>${iconSvg('knowledge')}</span><p><b>素材本地化</b><small>原始文件始终留在执行电脑</small></p></div>
          <div><span>${iconSvg('issues')}</span><p><b>异常即停止</b><small>结果不明不盲目重试</small></p></div>
          <div><span>${iconSvg('accounts')}</span><p><b>人工可接管</b><small>高风险动作始终保留审批</small></p></div>
        </div>
        <button class="safety-link" data-go="platforms">检查平台与账号 <span>→</span></button>
      </aside>
    </div>`
}
function bindDashboardRuntime(){
  document.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>navigate(button.dataset.go));
  const resume=$('[data-master-resume]');if(resume)resume.onclick=()=>toggleMasterSwitch();
  const openAll=$('#dashboardOpenPlatforms');if(openAll)openAll.onclick=()=>batchPlatformAction('open',openAll);
  const checkAll=$('#dashboardCheckPlatforms');if(checkAll)checkAll.onclick=()=>batchPlatformAction('check',checkAll);
}



function accountOptions(code){return state.bootstrap.accounts.filter(a=>!code||a.platform_code===code).map(a=>`<option value="${a.id}">${esc(a.platform_name)} · ${esc(a.display_name)}</option>`).join('')}
function publishPlatformAccounts(){
  const runtimeByPlatform=new Map((state.bootstrap?.platforms||[]).map(item=>[item.code,item]));
  const activeCodes=new Set(activeLoginPlatforms.map(item=>item.code));
  return (state.bootstrap?.accounts||[]).filter(account=>account.enabled!==0&&activeCodes.has(account.platform_code)&&runtimeByPlatform.get(account.platform_code)?.lifecycle_state==='ACTIVE');
}
function runnablePublishAccounts(){
  const runtimeByPlatform=new Map((state.bootstrap?.platforms||[]).map(item=>[item.code,item]));
  return publishPlatformAccounts().filter(account=>runtimeByPlatform.get(account.platform_code)?.task_execution_state==='RUNNING');
}
function publishPlatformAvailability(account){
  const runtime=(state.bootstrap?.platforms||[]).find(item=>item.code===account.platform_code)||{};
  if(runtime.task_execution_state==='RUNNING')return {runnable:true,label:'可选择',detail:`${account.profile_name} · ${statusName(account.login_status)}`,cls:'running'};
  if(runtime.desired_state==='STOPPED')return {runnable:false,label:'平台已停止',detail:'请先到“平台启停”启用账号并显式开启该平台。',cls:'stopped'};
  if(runtime.task_blocked_reason==='ACTIVE_ISSUE_BLOCK'||Number(runtime.active_block_count||0)>0)return {runnable:false,label:'问题处理中',detail:'关联问题正在阻断该平台或功能，请到“问题汇总”进行人工处理或误判确认。',cls:'warning'};
  if(runtime.blocked_reason==='NO_ENABLED_ACCOUNT')return {runnable:false,label:'无启用账号',detail:'平台开关已开启，但没有可执行账号。',cls:'warning'};
  return {runnable:false,label:'暂不可执行',detail:'请检查账号登录、Local Agent、平台开关，或到“问题汇总”查看关联异常。',cls:'warning'};
}
let contentLibraryRequestSequence=0;
async function publishContentLibraryItem(id){
  const requestSequence=++contentLibraryRequestSequence;
  const sourcePageGeneration=pageRenderGeneration;
  try{
    const draft=await api(`/api/content-library/${encodeURIComponent(id)}/publish-draft`);
    if(state.auth?.authenticated===false||requestSequence!==contentLibraryRequestSequence||sourcePageGeneration!==pageRenderGeneration)return;
    state.retryDraft={...draft,origin:'content-library',sourceTaskId:null,targets:[]};
    await navigate('publish');
  }catch(error){if(requestSequence===contentLibraryRequestSequence&&sourcePageGeneration===pageRenderGeneration)toast(error.message,true)}
}
async function renderPublish({pageGeneration=pageRenderGeneration}={}){
  const ownsPage=()=>state.page==='publish'&&pageGeneration===pageRenderGeneration;
  if(!ownsPage())return;
  clearPublishLayoutSync();
  if(publishSchedulePollTimer){clearInterval(publishSchedulePollTimer);publishSchedulePollTimer=null}
  const accounts=publishPlatformAccounts();
  const accountAvailability=accounts.map(account=>({account,availability:publishPlatformAvailability(account)}));
  const blockedAccounts=accountAvailability.filter(item=>!item.availability.runnable);
  $('#content').innerHTML=`<form id="publishForm"><div id="retryPublishNotice" class="retry-publish-notice" hidden></div>
    <div class="grid cols-2 publish-grid">
      <div class="publish-column publish-main-column">
        <div class="panel" style="margin-top:0">
        <div class="panel-head"><div><h2>素材与文案</h2><p>选择素材后自动预检。</p></div></div>
        <div class="section-actions library-publish-actions"><button type="button" class="btn secondary" id="pickFromContentLibrary">从素材库选择</button></div>
        <label>本地素材</label>
        <input id="materialFile" type="file" accept=".jpg,.jpeg,.png,.webp,.mp4,.mov" aria-label="选择图片或视频" hidden>
        <label class="field full local-material-path-field"><span>素材路径</span><input id="materialPath" name="materialPath" type="text" placeholder="选择文件或填写本机路径" autocomplete="off" required></label>
        <div id="materialPreview" class="material-preview material-preview-empty material-picker" role="button" tabindex="0" aria-label="选择本地素材">
          <div class="material-picker-placeholder"><span class="material-picker-icon" aria-hidden="true">＋</span><b>点击选择本地素材</b><span>支持 JPG、PNG、WEBP、MP4、MOV</span><small>上传后自动预检，原文件保留在本机</small></div>
        </div>
        <div id="precheckBox" class="notice material-check"><b>素材状态：等待上传</b><br>上传后仅展示视频格式与所选平台适配状态。</div>
        <div class="section-actions audio-copy-actions"><button type="button" class="btn secondary" id="generateAudioCopy">AI 生成标题和文案</button><button type="button" class="btn secondary" id="applyAudioCopy" hidden>使用 AI 结果</button></div>
        <div id="audioCopyBox" data-empty-state="true" class="ai-status-card is-idle is-generation" role="status" aria-live="polite">${aiStatusMarkup({variant:'generation',state:'idle',eyebrow:'AI CONTENT ENGINE',title:'AI 文案',description:'依据图片或视频音频生成文案。',stages:['素材理解','主题提炼','文案润色','风险校验']})}</div>
        <label>标题</label><input id="publishTitle" name="title" maxlength="20" required placeholder="最多 20 字">
        <label>正文</label><textarea id="publishBody" name="body" rows="7" required placeholder="填写发布正文"></textarea>
        <div class="publish-origin-card" id="contentOriginCard">
          <div class="publish-origin-head">
            <span class="publish-origin-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6.6v5.8c0 4.1 2.8 7.6 7.5 8.6 4.7-1 7.5-4.5 7.5-8.6V6.6L12 3Z"></path><path d="m9.2 12 1.8 1.8 3.9-4"></path></svg></span>
            <div class="publish-origin-title"><label for="contentOrigin">内容来源</label><small>用于平台必填声明</small></div>
            <span class="publish-origin-required"><i></i>发布必填</span>
          </div>
          <div class="publish-origin-select-wrap">
            <select id="contentOrigin" name="contentOrigin" aria-describedby="contentOriginHint" required>
              <option value="">请选择，系统不会自动猜测</option>
              <option value="AI_GENERATED">AI生成或包含AI生成内容</option>
              <option value="HUMAN_ORIGINAL">真人原创且不含AI生成内容</option>
            </select>
            <span class="publish-origin-select-state" id="contentOriginState" aria-hidden="true">等待选择</span>
            <span class="publish-origin-chevron" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m6 8 4 4 4-4"></path></svg></span>
          </div>
          <div class="publish-origin-notice" id="contentOriginHint">
            <span class="publish-origin-notice-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5"></circle><path d="M10 9v4M10 6.5h.01"></path></svg></span>
            <div><b>声明依据</b><p>微博等平台提交前会要求内容来源。系统只按这里的明确选择操作，未选择时禁止自动发布。</p></div>
          </div>
        </div>
        <div class="section-actions publish-review-actions">
          <button type="button" class="btn secondary publish-action-card publish-precheck-action" id="runPrecheck">
            <span class="publish-action-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 5v6h-6"></path><path d="M8.5 12h7M12 8.5v7"></path></svg></span>
            <span class="publish-action-copy"><b class="publish-action-title">重新预检</b><small class="publish-action-detail">校验文件参数与平台适配</small></span>
            <span class="publish-action-arrow" aria-hidden="true">›</span>
          </button>
          <button type="button" class="btn secondary publish-action-card publish-compliance-action" id="runCompliance">
            <span class="publish-action-icon publish-action-ai" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.5 14 8l4.5 2-4.5 2-2 4.5-2-4.5-4.5-2L10 8l2-4.5Z"></path><path d="m18 15 .9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15Z"></path></svg></span>
            <span class="publish-action-copy"><b class="publish-action-title">审核内容</b><small class="publish-action-detail">检查文案、来源与代表画面</small></span>
            <span class="publish-action-live" aria-hidden="true"><i></i>AI</span>
          </button>
        </div>
        </div>
      </div>
      <div class="publish-column publish-side-column">
        <div class="panel" style="margin-top:0">
        <div class="panel-head"><div><h2>发布平台</h2><p>支持抖音、视频号、B站与微博；小红书待验收。</p></div><div class="platform-select-actions"><span id="platformSelectionSummary">已选 0/0</span><button type="button" class="btn secondary platform-select-all" id="selectAllPlatforms" aria-pressed="false">全选平台</button></div></div>
        ${accountAvailability.length?accountAvailability.map(({account:a,availability:v})=>`<label class="check-card publish-platform-card ${v.runnable?'is-runnable':'is-blocked'}"><input type="checkbox" class="platform-check" data-platform="${esc(a.platform_code)}" data-account="${a.id}" ${v.runnable?'':'disabled'}><span><span class="publish-platform-title"><b>${esc(a.platform_name)} · ${esc(a.display_name)}</b><i class="badge ${v.cls}">${esc(v.label)}</i></span><small>${esc(v.detail)}</small></span></label>`).join(''):'<div class="empty"><b>当前没有已配置的五平台账号</b><br>请先到“平台启停”检查账号和登录状态。</div>'}
        ${blockedAccounts.length?`<div class="notice warn publish-platform-blocked-notice"><b>${blockedAccounts.length} 个平台当前不可选择</b><br>请检查账号、登录、Local Agent、平台开关，或处理关联问题。<div class="section-actions"><button type="button" class="btn secondary" data-go="issues">查看问题汇总</button><button type="button" class="btn secondary" data-go="platforms">查看平台启停</button></div></div>`:''}
        <div class="notice info"><b>素材适配：</b>B站当前仅接视频投稿；微博支持图文和视频。系统不自动裁切或转码，请以平台适配状态为准。</div>
        <div id="complianceBox" data-empty-state="true" class="ai-status-card is-idle is-review" role="status" aria-live="polite">${aiStatusMarkup({variant:'review',state:'idle',eyebrow:'AI SAFETY SCANNER',title:'内容审核',description:'检查文案、内容来源与画面风险。',stages:['文案校验','来源核对','代表帧抽取','画面识别','结果汇总'],bodyHtml:trafficPredictionMarkup()})}</div>
        <label class="check-card"><input id="warningConfirmed" type="checkbox"><span><b>我已人工核对 AI 审核警告</b><small>仅在 AI 返回警告时需要；阻断项和审核失败不能放行。</small></span></label>
        <label class="check-card"><input id="autoPublish" type="checkbox"><span><b>自动提交发布</b><small>勾选后按平台逐一提交；未勾选仅准备草稿并等待人工确认。</small></span></label>
        <button class="btn full" id="publishSubmitButton" type="submit">创建已选平台发布任务</button>
        <button class="btn secondary full scheduled-publish-open" id="scheduledPublishButton" type="button"><span>创建定时发布任务</span><small>选择电脑本地年月日、时分秒</small></button>
        </div>
      </div>
    </div>
    <section class="publish-records-zone" aria-labelledby="publishRecordsTitle">
      <div class="publish-records-overview">
        <div class="publish-records-overview-copy">
          <span>发布管理</span>
          <h2 id="publishRecordsTitle">任务计划与发布记录</h2>
          <p>左侧查看即将执行的发布安排，右侧回看已经完成的发布结果。</p>
        </div>
        <div class="publish-records-legend" aria-label="定时任务状态说明">
          <span class="is-pending"><i></i>待执行</span>
          <span class="is-running"><i></i>执行中</span>
          <span class="is-completed"><i></i>已完成</span>
        </div>
      </div>
      <div class="publish-records-grid">
        <section id="publishSchedules" class="publish-queue-board publish-schedule-panel"><div class="loading compact-loading">正在加载未来定时发布任务…</div></section>
        <section id="publishHistory" class="publish-queue-board publish-history-panel"><div class="loading compact-loading">正在加载发布历史…</div></section>
      </div>
    </section>
  </form>`;

  presentWorkspace();
  resetAudioContentGeneration();
  const materialInput=$('#materialPath');
  const materialPicker=$('#materialPreview');
  const materialFile=$('#materialFile');
  $('#pickFromContentLibrary').onclick=()=>openContentLibraryPicker({onSelect:publishContentLibraryItem,onUnauthorized:()=>showLoginScreen('登录已过期，请重新登录')});
  let materialPickerBusy=false;
  const openMaterialPicker=()=>{
    if(materialPickerBusy)return;
    materialFile.value='';
    materialFile.click();
  };
  materialFile.addEventListener('change',async()=>{
    const file=materialFile.files?.[0];
    if(!file||materialPickerBusy)return;
    const maxBytes=state.bootstrap?.localAgent?.materialUploadMaxBytes||2*1024**3;
    if(!/\.(jpe?g|png|webp|mp4|mov)$/i.test(file.name)){toast('支持 JPG、PNG、WEBP、MP4、MOV 格式',true);return}
    if(!file.size||file.size>maxBytes){toast(!file.size?'不能上传空文件':`单个素材不能超过 ${Math.round(maxBytes/1024**2)} MB`,true);return}
    materialPickerBusy=true;
    materialInput.readOnly=true;
    materialInput.value='';
    publishPrecheckRequestGeneration+=1;
    state.precheck=null;state.materialPreviewUrl=null;resetAudioContentGeneration();invalidateCompliance();
    materialPicker.classList.add('is-picking');
    materialPicker.setAttribute('aria-busy','true');
    $('#precheckBox').className='notice material-check info';
    $('#precheckBox').innerHTML=`<b>素材状态：正在上传…</b><br>${esc(file.name)} · 上传完成后自动检测，请稍候。`;
    try{
      const d=await agent(`/upload-material?filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
      if(!ownsPage()||!materialInput.isConnected)return;
      materialInput.value=d.materialPath;
      $('#precheckBox').className='notice material-check info';
      $('#precheckBox').innerHTML='<b>素材状态：正在自动检测…</b><br>上传完成，正在检测格式与平台适配状态。';
      await runPrecheck(true,{pageGeneration});
    }catch(e){if(ownsPage()&&materialInput.isConnected){showMaterialCheckError(e.message);toast(e.message,true)}}
    finally{
      materialPickerBusy=false;
      materialInput.readOnly=false;
      materialFile.value='';
      materialPicker.classList.remove('is-picking');
      materialPicker.removeAttribute('aria-busy');
    }
  });
  materialPicker.addEventListener('click',event=>{if(!event.target.closest('video'))openMaterialPicker()});
  materialPicker.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openMaterialPicker()}});
  const platformChecks=()=>[...document.querySelectorAll('.platform-check:not(:disabled)')];
  const syncPlatformSelection=()=>{
    const checks=platformChecks();
    const selected=checks.filter(c=>c.checked).length;
    const totalConfigured=document.querySelectorAll('.publish-platform-card').length;
    const allSelected=checks.length>0&&selected===checks.length;
    const summary=$('#platformSelectionSummary');
    const selectAll=$('#selectAllPlatforms');
    if(summary)summary.textContent=`已选 ${selected} · 可选 ${checks.length}/${totalConfigured}`;
    if(selectAll){selectAll.textContent=allSelected?'取消全选':'全选平台';selectAll.setAttribute('aria-pressed',String(allSelected));selectAll.disabled=!checks.length}
  };
  const onPlatformSelectionChanged=()=>{syncPlatformSelection();state.precheck=null;resetTrafficPrediction();if(materialInput.value.trim())runPrecheck(true,{pageGeneration})};
  platformChecks().forEach(c=>c.addEventListener('change',onPlatformSelectionChanged));
  const selectAllPlatforms=$('#selectAllPlatforms');
  if(selectAllPlatforms)selectAllPlatforms.onclick=()=>{
    const checks=platformChecks();
    const shouldSelect=!checks.every(c=>c.checked);
    checks.forEach(c=>{c.checked=shouldSelect});
    syncPlatformSelection();
    state.precheck=null;
    resetTrafficPrediction();
    if(materialInput.value.trim())runPrecheck(true,{pageGeneration});
    toast(shouldSelect?`已选择全部 ${checks.length} 个平台`:'已取消全部平台');
  };
  syncPlatformSelection();
  $('#runPrecheck').onclick=()=>runPrecheck(false,{pageGeneration});
  $('#runCompliance').onclick=runCompliance;
  $('#generateAudioCopy').onclick=()=>runAudioContentGeneration({ force: true });
  $('#applyAudioCopy').onclick=()=>applyAudioCopyResult(true);
  $('#publishTitle')?.addEventListener('input',()=>{state.contentGeneration.titleDirty=true;invalidateCompliance()});
  $('#publishBody')?.addEventListener('input',()=>{state.contentGeneration.bodyDirty=true;invalidateCompliance()});
  materialInput.addEventListener('input',()=>{publishPrecheckRequestGeneration+=1;state.precheck=null;state.materialPreviewUrl=null;resetAudioContentGeneration();invalidateCompliance()});
  materialInput.addEventListener('change',()=>{state.precheck=null;state.materialPreviewUrl=null;resetAudioContentGeneration();if(materialInput.value.trim())runPrecheck(true,{pageGeneration})});
  const contentOriginSelect=$('#contentOrigin');
  const syncContentOriginVisual=()=>{
    const selected=Boolean(contentOriginSelect?.value);
    $('#contentOriginCard')?.classList.toggle('has-selection',selected);
    const originState=$('#contentOriginState');
    if(originState)originState.textContent=selected?'已明确声明':'等待选择';
  };
  contentOriginSelect?.addEventListener('change',()=>{syncContentOriginVisual();invalidateCompliance()});
  syncContentOriginVisual();
  document.querySelectorAll('#publishForm [data-go]').forEach(button=>button.onclick=()=>navigate(button.dataset.go));
  $('#publishForm').onsubmit=submitPublish;
  $('#scheduledPublishButton').onclick=openScheduledPublishDialog;
  $('#publishSchedules').onclick=handleScheduledPublishQueueClick;
  $('#publishHistory').onclick=e=>{
    const b=e.target.closest('[data-history-page]');
    if(b&&!b.disabled)loadPublishHistory(Number(b.dataset.historyPage));
  };
  const retryDraft=state.retryDraft;
  if(retryDraft){
    const fromLibrary=retryDraft.origin==='content-library';
    const fromStudio=retryDraft.origin==='studio'||fromLibrary;
    state.retrySourceTaskId=fromStudio?null:retryDraft.sourceTaskId;
    const retryNotice=$('#retryPublishNotice');
    if(retryNotice){
      retryNotice.hidden=false;
      retryNotice.innerHTML=fromLibrary
        ?`<b>已从共享成片库带入作品</b><span>素材、标题和正文已填入。请核对内容来源、选择平台，并完成原有素材预检与发布审核。</span>`
        :fromStudio
        ?`<b>已从内容创作带入文稿</b><span>标题、正文与素材路径已填充到发布工作区。请核对平台账号与合规信息后创建任务；最终发布授权不会自动勾选。</span>`
        :`<b>正在再次发送任务 #${retryDraft.sourceTaskId}</b><span>已自动填充失败任务的文案、素材和失败平台。请重新检查素材与合规内容，再确认创建任务；最终发布授权不会自动勾选。</span>`;
      const submitButton=$('#publishSubmitButton');if(submitButton)submitButton.textContent=fromStudio?'创建发布任务':'创建再次发送任务';
    }
    $('#publishTitle').value=retryDraft.title||'';
    $('#publishBody').value=retryDraft.body||'';
    materialInput.value=retryDraft.materialPath||'';
    state.precheck=null;state.compliance=null;state.trafficPrediction=createTrafficPredictionState();state.materialPreviewUrl=null;
    const retryTargetKeys=new Set((retryDraft.targets||[]).map(item=>`${item.platformCode}:${Number(item.accountId)}`));
    platformChecks().forEach(check=>{check.checked=retryTargetKeys.has(`${check.dataset.platform}:${Number(check.dataset.account)}`)});
    syncPlatformSelection();
    if(fromLibrary){
      state.materialPreviewUrl=retryDraft.mediaUrl;
      materialPicker.className='material-preview material-picker';
      materialPicker.innerHTML=materialPreviewHtml(retryDraft.mediaUrl,{...retryDraft.meta,type:retryDraft.mediaType,name:retryDraft.meta?.name||retryDraft.title,size:retryDraft.sizeBytes});
      $('#precheckBox').className='notice material-check info';
      $('#precheckBox').innerHTML='<b>素材已从成片库读取 · 待发布预检</b><br>选择目标平台后检测素材格式，再核对内容来源和发布审核。';
      toast('成片已带入发布，等待你选择平台和审核');
    }else if(!materialInput.value.trim()){
      showMaterialCheckError('原任务没有可用的素材路径，请重新选择本地素材');
      toast(fromStudio?'创作文稿已填充，请重新选择本地素材':'失败任务内容已填充，请重新选择本地素材',true);
    }else if(!selectedTargets().length){
      showMaterialCheckError('原任务失败的平台账号当前不可用，请重新选择平台账号');
      toast(fromStudio?'创作文稿已填充，但原平台账号当前不可用':'失败任务内容已填充，但原平台账号当前不可用',true);
    }else{
      $('#precheckBox').className='notice material-check info';
      $('#precheckBox').innerHTML='<b>素材状态：正在重新检测…</b><br>正在更新视频格式与平台适配状态。';
      const precheckCommitted=await runPrecheck(true,{pageGeneration});
      if(!ownsPage())return;
      const filledMessage=fromStudio?'创作文稿已填充，请重新检查合规后发送':`失败任务 #${retryDraft.sourceTaskId} 已填充，请重新检查合规后发送`;
      toast(precheckCommitted&&state.precheck?filledMessage:'内容已填充，但素材重新检测失败',!(precheckCommitted&&state.precheck));
    }
  }
  await Promise.all([loadPublishHistory(state.publishHistoryPage),loadPublishSchedules()]);
  if(!ownsPage())return;
  setupPublishLayoutSync(pageGeneration);
  publishSchedulePollTimer=setInterval(()=>{if(state.page==='publish'&&!document.hidden&&!document.querySelector('.confirm-overlay'))loadPublishSchedules(true)},2000);
}
function materialPreviewHtml(url,meta={}){
  const changeHint='<span class="material-change-hint">点击重新选择</span>';
  if(!url)return `<div><b>素材已选择</b><span>已读取素材信息，但当前格式无法在页面内预览</span></div>${changeHint}`;
  const src=esc(url);
  const videoInfo=[meta.width&&meta.height?`${meta.width}×${meta.height}`:'',meta.durationSeconds?formatDuration(meta.durationSeconds):'',meta.frameRate?`${meta.frameRate} fps`:''].filter(Boolean).join(' · ');
  if(meta.type==='video')return `<video controls preload="metadata" src="${src}"></video><div class="material-caption"><b>${esc(meta.name||'本地视频')}</b><span>${videoInfo?videoInfo+' · ':''}${formatBytes(meta.size)}</span></div>${changeHint}`;
  return `<img src="${src}" alt="${esc(meta.name||'本地素材预览')}"><div class="material-caption"><b>${esc(meta.name||'本地图片')}</b><span>${meta.width&&meta.height?`${meta.width}×${meta.height} · `:''}${formatBytes(meta.size)}</span></div>${changeHint}`;
}
function formatBytes(size){const n=Number(size||0);if(!n)return '—';if(n<1024)return `${n} B`;if(n<1024*1024)return `${Math.round(n/1024)} KB`;return `${(n/1024/1024).toFixed(1)} MB`}
function formatBitRate(value){const n=Number(value||0);if(!n)return '未读取';if(n<1000)return `${n} bps`;if(n<1000*1000)return `${(n/1000).toFixed(0)} Kbps`;return `${(n/1000/1000).toFixed(2)} Mbps`}
function formatDuration(seconds){const n=Number(seconds||0);if(!n)return '未读取';const minutes=Math.floor(n/60);const rest=(n%60).toFixed(n<10?1:0);return minutes?`${minutes}分${rest}秒`:`${rest}秒`}
function showMaterialCheckError(message){state.precheck=null;resetAudioContentGeneration();const box=$('#precheckBox');if(box){box.className='notice material-check warn';box.innerHTML=`<b>素材状态：检测失败</b><br>${esc(message)}`}}
function renderMaterialPrecheck(precheck,previewUrl,platformCodes=[]){
  const m=precheck.meta||{};
  const hasPlatformScope=platformCodes.length>0;
  const results=hasPlatformScope?(precheck.results||[]):[];
  const preview=$('#materialPreview');
  if(preview){preview.className='material-preview material-picker has-material';preview.innerHTML=materialPreviewHtml(previewUrl,m)}
  const box=$('#precheckBox');
  if(!box)return;
  const overall=String(precheck.overall||'PENDING').toUpperCase();
  const tone=!hasPlatformScope?'info':overall==='PASSED'?'ok':overall==='BLOCKED'?'blocked':'warn';
  const label=!hasPlatformScope?'素材格式已识别，待选择平台':overall==='PASSED'?'平台适配检测通过':overall==='WARNING'?'平台适配需人工确认':'平台适配未通过';
  const stateBadge=hasPlatformScope?badge(overall):'<span class="badge pending">待选平台</span>';
  const rawFormat=String(m.format||m.extension||'').replace(/^\./,'').trim();
  const formatLabel=rawFormat?rawFormat.toUpperCase():'未知格式';
  const typeLabel=m.type==='image'?'图片格式':'视频格式';
  const passedCount=results.filter(result=>String(result.status||'').toUpperCase()==='PASSED').length;
  const platformSummary=hasPlatformScope?`${passedCount}/${results.length} 个平台通过`:'选择发布平台后显示检测状态';
  const platformItems=results.length
    ? results.map(result=>{
        const status=String(result.status||'PENDING').toUpperCase();
        const statusClass=status==='PASSED'?'passed':status==='WARNING'?'warning':status==='BLOCKED'?'blocked':'pending';
        const statusLabel=status==='PASSED'?'通过':status==='WARNING'?'待确认':status==='BLOCKED'?'未通过':statusName(status);
        const glyph=status==='PASSED'?'✓':status==='WARNING'?'!':status==='BLOCKED'?'×':'·';
        return `<span class="material-platform-chip is-${statusClass}"><i aria-hidden="true">${glyph}</i><b>${esc(platformName(result.platformCode))}</b><em>${esc(statusLabel)}</em></span>`;
      }).join('')
    : '<span class="material-platform-empty">选择目标平台后，这里会显示各平台是否通过。</span>';
  box.className=`notice material-check ${tone} is-${overall.toLowerCase()}`;
  box.innerHTML=`<div class="material-check-head"><span class="material-check-icon" aria-hidden="true">${overall==='PASSED'?'✓':overall==='BLOCKED'?'×':'i'}</span><div><b>${esc(label)}</b><small>${esc(platformSummary)}</small></div>${stateBadge}</div><div class="material-check-content"><div class="material-format-tile"><span>${typeLabel}</span><strong>${esc(formatLabel)}</strong></div><div class="material-platform-status"><span class="material-platform-label">平台状态</span><div class="material-platform-list">${platformItems}</div></div></div>`;
}
function publishHistoryHtml(data){
  const records=data.records||[];
  const page=data.page||1,totalPages=data.totalPages||1;
  return `<header class="queue-board-head history-board-head"><div class="queue-board-heading"><span class="queue-board-icon history-board-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7.5h14M7 4.5h10a2 2 0 0 1 2 2v13H5v-13a2 2 0 0 1 2-2Z"></path><path d="m9 13 2 2 4-4"></path></svg></span><div><span class="queue-board-eyebrow">历史结果</span><h3>发布历史</h3><p>展开查看详情</p></div></div><span class="queue-board-count">${data.total||0}<small>条记录</small></span></header>
    <div class="queue-board-body"><div class="publish-history-list">${records.length?records.map(r=>`<details class="publish-history-item"><summary><span class="history-result-icon ${r.publish_status==='SUCCESS'?'success':'failed'}" aria-hidden="true">${r.publish_status==='SUCCESS'?'✓':'!'}</span><span class="history-title-block"><b class="history-title">${esc(r.title)}</b><small>发布任务 #${r.id}</small></span><span class="history-time">${fmt(r.publish_time)}</span><span class="history-status ${r.publish_status==='SUCCESS'?'success':'failed'}">${r.publish_status==='SUCCESS'?'成功':'失败'}</span><span class="history-chevron">›</span></summary><div class="history-detail"><div><b>正文内容</b><p>${esc(r.body)}</p></div><div class="history-detail-grid"><div><b>发布时间</b><span>${fmt(r.publish_time)}</span></div><div><b>发布结果</b><span>${r.publish_status==='SUCCESS'?'发布成功':'发布失败'}</span></div><div><b>素材</b><span>${esc(r.material_meta?.name||r.material_meta?.meta?.name||r.material_meta?.precheck?.meta?.name||r.material_path||'—')}</span></div><div><b>任务编号</b><span>#${r.id}</span></div></div>${(r.targets||[]).map(t=>`<div class="history-target"><b>${esc(t.platform_name)} · ${esc(t.account_name)}</b><span>执行：${esc(statusName(t.status))}　审核：${esc(statusName(t.review_status))}</span>${t.review_message?`<small>${esc(statusName(t.review_message))}</small>`:''}</div>`).join('')}</div></details>`).join(''):`<div class="queue-empty-state history-empty-state"><span class="queue-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 4.5h12v15H6z"></path><path d="M9 9h6M9 13h6"></path></svg></span><b>还没有发布记录</b><p>完成发布后，结果会按最新时间显示在这里。</p></div>`}</div>
    ${data.total>5?`<div class="history-pagination"><button type="button" class="btn secondary" data-history-page="${page-1}" ${page<=1?'disabled':''}>上一页</button><span>第 ${page} / ${totalPages} 页</span><button type="button" class="btn secondary" data-history-page="${page+1}" ${page>=totalPages?'disabled':''}>下一页</button></div>`:''}</div>`;
}
async function loadPublishHistory(page=1){
  const host=$('#publishHistory');if(!host)return;
  host.classList.add('is-loading');
  try{const d=await api(`/api/publish/history?page=${Math.max(1,page)}&pageSize=5`);state.publishHistoryPage=d.page;host.innerHTML=publishHistoryHtml(d);const list=host.querySelector('.publish-history-list');if(list)list.scrollTop=0}
  catch(e){host.innerHTML=`<div class="empty">发布记录加载失败：${esc(e.message)}</div>`;toast(e.message,true)}
  finally{host.classList.remove('is-loading')}
}
function aiStatusMarkup({variant='generation',state='idle',eyebrow='',title='',description='',stages=[],meta=[],bodyHtml='',footer='',actionsHtml=''}){
  const glyph=variant==='review'?'审':'AI';
  const stateLabels={idle:'待机',running:'运行中',success:'已完成',warning:'需确认',blocked:'已阻断',failed:'异常'};
  const stageState=state==='running'?'flow':state==='success'?'done':state==='blocked'?'blocked':state==='failed'?'failed':'waiting';
  const stageHtml=stages.length?`<div class="ai-stage-list" aria-label="AI 处理链路">${stages.map((stage,index)=>`<span class="ai-stage-item is-${stageState}" style="--stage-index:${index}"><i></i>${esc(stage)}</span>`).join('')}</div>`:'';
  const metaHtml=meta.length?`<div class="ai-status-meta">${meta.map(item=>`<div class="ai-status-meta-item${item.wide?' is-wide':''}"><span>${esc(item.label)}</span><b>${esc(item.value||'—')}</b></div>`).join('')}</div>`:'';
  return `<span class="ai-status-grid" aria-hidden="true"></span><span class="ai-status-scan" aria-hidden="true"></span><span class="ai-particle ai-particle-one" aria-hidden="true"></span><span class="ai-particle ai-particle-two" aria-hidden="true"></span><span class="ai-particle ai-particle-three" aria-hidden="true"></span>
    <div class="ai-status-core" aria-hidden="true"><span class="ai-core-halo"></span><span class="ai-core-ring ai-core-ring-one"></span><span class="ai-core-ring ai-core-ring-two"></span><span class="ai-core-value">${glyph}</span><i class="ai-core-node ai-core-node-one"></i><i class="ai-core-node ai-core-node-two"></i></div>
    <div class="ai-status-content"><div class="ai-status-topline"><span class="ai-status-eyebrow"><i></i>${esc(eyebrow)}</span><span class="ai-status-state">${esc(stateLabels[state]||stateLabels.idle)}</span></div><h3>${esc(title)}</h3><p class="ai-status-description">${esc(description)}</p>${stageHtml}${metaHtml}${bodyHtml?`<div class="ai-status-body">${bodyHtml}</div>`:''}${actionsHtml?`<div class="ai-status-actions">${actionsHtml}</div>`:''}${footer?`<small class="ai-status-footer">${esc(footer)}</small>`:''}</div>
    <div class="ai-signal-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>`;
}
function renderAiStatus(box,options){
  if(!box)return;
  const variant=options.variant||'generation',status=options.state||'idle';
  box.className=`ai-status-card is-${status} is-${variant}`;
  box.dataset.emptyState=String(status==='idle'&&['AI 文案','内容审核'].includes(options.title));
  box.setAttribute('role','status');box.setAttribute('aria-live','polite');
  box.innerHTML=aiStatusMarkup(options);
}
const legacyAudioContentGenerationEndpoint='/audio-content-generation'; // 兼容旧版 Local Agent 路由
function createAudioContentGenerationState(){return {status:'IDLE',stage:null,sourceType:null,materialSha256:null,result:null,error:null,titleDirty:false,bodyDirty:false,requestToken:null,applied:false,needsManualApply:false}}
function resetAudioContentGeneration(){state.contentGeneration=createAudioContentGenerationState();renderAudioCopyStatus()}
function materialCopyUiContext(){
  const sourceType=state.contentGeneration?.sourceType||state.contentGeneration?.result?.sourceType||state.precheck?.meta?.type||'';
  if(sourceType==='image')return {
    sourceType,
    modeLabel:'IMAGE MODE',
    stages:['图片压缩','画面理解','主题提炼','文案润色','风险校验'],
    runningTitle:'正在理解图片并生成文案',
    runningDescription:'处理链路正在依次执行：压缩图片、识别画面与可见文字、提炼核心主题、润色文案并校验风险。',
    runningFooter:'仅发送本机压缩后的图片给千问；不会发送文件名、目录或其他本地文件。',
    idleDescription:'选择图片后，AI 会理解画面主体和可见文字，围绕核心主题生成标题和正文。',
    idleFooter:'图片会先在本机压缩，再发送给千问进行视觉理解；生成结果仍需人工确认。',
    summaryLabel:'图片摘要'
  };
  return {
    sourceType:sourceType||'video',
    modeLabel:'AUDIO MODE',
    stages:['音频提取','语音识别','主题提炼','文案润色','风险校验'],
    runningTitle:'正在理解音频并生成文案',
    runningDescription:'处理链路正在依次执行：提取临时音频、识别语音、提炼核心主题、润色文案并校验风险。',
    runningFooter:'仅发送本机临时提取的音频，不分析或上传视频画面；完成后会删除临时音频。',
    idleDescription:'上传图片时理解画面与可见文字；上传带音轨视频时仅根据音频生成，不分析视频画面。',
    idleFooter:'图片仅发送本机压缩副本；视频仅临时提取音频，视频原片和画面不会上传。',
    summaryLabel:'音频摘要'
  };
}
function renderAudioCopyStatus(){
  const box=$('#audioCopyBox'),generate=$('#generateAudioCopy'),apply=$('#applyAudioCopy');if(!box)return;
  const enabled=state.bootstrap?.config?.audioContentGenerationEnabled!==false;
  const generation=state.contentGeneration||createAudioContentGenerationState();
  const ui=materialCopyUiContext(),stages=ui.stages;
  if(generate){const running=generation.status==='RUNNING';generate.disabled=!enabled||running;generate.textContent=running?'AI 正在生成…':'AI 生成标题和文案';generate.classList.toggle('is-ai-running',running);generate.setAttribute('aria-busy',String(running))}
  if(apply)apply.hidden=!(generation.status==='SUCCESS'&&generation.result?.result&&generation.needsManualApply);
  if(!enabled){renderAiStatus(box,{variant:'generation',state:'idle',eyebrow:'AI CONTENT ENGINE',title:'AI 文案功能未启用',description:'当前仍可人工填写标题和正文，需要时可在 AI 设置中重新启用。',stages});return}
  if(generation.status==='RUNNING'){renderAiStatus(box,{variant:'generation',state:'running',eyebrow:'AI CONTENT ENGINE · '+ui.modeLabel,title:ui.runningTitle,description:ui.runningDescription,stages,footer:ui.runningFooter});return}
  if(generation.status==='FAILED'){renderAiStatus(box,{variant:'generation',state:'failed',eyebrow:'AI CONTENT ENGINE',title:'文案生成未完成',description:generation.error||'请重试或人工填写标题和正文。',stages,footer:'本次失败不会阻止人工填写和后续发布。'});return}
  if(generation.status==='SUCCESS'){
    const result=generation.result?.result||{};
    if(generation.result?.mock===true){
      const mockTarget=ui.sourceType==='image'?'图片内容':'视频音频';
      renderAiStatus(box,{variant:'generation',state:'warning',eyebrow:'AI CONTENT ENGINE · MOCK',title:'当前为 Mock 演示模式',description:'系统未读取或分析'+mockTarget+'，因此不会自动填写标题和正文。请使用系统当前已配置的千问 Key 并启用 Online 在线模式。',stages,actionsHtml:'<button type="button" class="btn secondary" id="openAiOnlineSettings">去开启 Online 模式</button>',footer:'Mock 模式仅用于演示流程，不代表已生成真实文案。'});const openOnline=$('#openAiOnlineSettings');if(openOnline)openOnline.onclick=()=>navigate('wecom');return
    }
    const summary=result.sourceSummary||result.imageSummary||result.audioSummary||'';
    const meta=[
      {label:'素材理解',value:ui.sourceType==='image'?'图片视觉理解':'视频音频理解'},
      ...(result.coreTheme?[{label:'核心主题',value:result.coreTheme,wide:true}]:[]),
      ...(result.contentAngle?[{label:'内容角度',value:result.contentAngle,wide:true}]:[]),
      ...(Array.isArray(result.keyPoints)&&result.keyPoints.length?[{label:'提炼重点',value:result.keyPoints.join('；'),wide:true}]:[]),
      ...(summary?[{label:ui.summaryLabel,value:summary,wide:true}]:[])
    ];
    const applied=generation.applied?(generation.needsManualApply?'已填入可安全填写的空白字段；现有内容未覆盖，可点击“使用 AI 结果”主动替换。':'已安全填入标题和正文，并已将内容来源设为“AI生成或包含AI生成内容”。'):'已生成结果，但检测到现有内容或等待期间的人工修改，因此未覆盖。';
    renderAiStatus(box,{variant:'generation',state:'success',eyebrow:'AI CONTENT ENGINE · COMPLETE',title:'已围绕核心主题生成文案',description:(ui.sourceType==='image'?'图片视觉理解':'音频内容理解')+'与文案润色已完成，结果已通过生成侧风险关键词校验。',stages,meta,bodyHtml:'<b>'+esc(applied)+'</b>',footer:'请人工确认标题和正文是否准确突出主题；修改后需重新执行 AI 审核，系统不会自动发布。'});return
  }
  renderAiStatus(box,{variant:'generation',state:'idle',eyebrow:'AI CONTENT ENGINE',title:'AI 文案',description:ui.idleDescription,stages,footer:ui.idleFooter});
}
function applyAudioCopyResult(overwrite=false){
  const generation=state.contentGeneration;
  const copy=generation?.result?.result;
  const titleInput=$('#publishTitle'),bodyInput=$('#publishBody'),origin=$('#contentOrigin');
  if(!copy||generation?.result?.mock===true||!titleInput||!bodyInput)return false;
  let applied=false;
  if(overwrite||(!titleInput.value.trim()&&!generation.titleDirty)){titleInput.value=copy.title||'';applied=Boolean(copy.title)||applied}
  if(overwrite||(!bodyInput.value.trim()&&!generation.bodyDirty)){bodyInput.value=copy.body||'';applied=Boolean(copy.body)||applied}
  if(applied&&origin)origin.value='AI_GENERATED';
  generation.applied=applied;
  generation.needsManualApply=titleInput.value!==(copy.title||'')||bodyInput.value!==(copy.body||'');
  if(applied)invalidateCompliance();
  renderAudioCopyStatus();
  if(overwrite&&applied)toast('已使用 AI 生成的标题和正文，请人工确认后重新执行合规审核');
  return applied;
}
async function runAudioContentGeneration({automatic=false,force=false}={}){
  if(state.bootstrap?.config?.audioContentGenerationEnabled===false){if(!automatic)toast('AI 素材文案功能未启用',true);return}
  const precheck=state.precheck,meta=precheck?.meta||{},materialPath=$('#materialPath')?.value.trim();
  if(!materialPath){if(!automatic)toast('请先选择本地素材',true);return}
  if(!precheck){if(!automatic)toast('请先完成素材格式检测',true);return}
  if(!['image','video'].includes(meta.type)){if(!automatic)toast('只有图片或视频素材可生成标题和文案',true);return}
  if(meta.type==='video'&&meta.hasAudio!==true){if(!automatic)toast('视频中未检测到音轨',true);return}
  if(precheck.overall==='BLOCKED'){if(!automatic)toast('素材格式不符合要求，不能生成文案',true);return}
  const current=state.contentGeneration||createAudioContentGenerationState();
  if(current.status==='RUNNING')return;
  if(automatic&&current.status==='SUCCESS'&&current.materialSha256===meta.sha256)return;
  if(automatic&&current.status==='FAILED'&&current.materialSha256===meta.sha256)return;
  const requestToken=globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random();
  const startTitle=$('#publishTitle')?.value||'',startBody=$('#publishBody')?.value||'';
  state.contentGeneration={status:'RUNNING',stage:meta.type==='image'?'IMAGE_AND_COPY':'AUDIO_AND_COPY',sourceType:meta.type,materialSha256:meta.sha256,result:null,error:null,titleDirty:false,bodyDirty:false,requestToken,applied:false,needsManualApply:false};
  renderAudioCopyStatus();
  try{
    const platformCodes=[...new Set(selectedTargets().map(item=>item.platformCode))];
    const d=await agent('/material-content-generation',{method:'POST',body:JSON.stringify({materialPath,precheck,materialSha256:meta.sha256,platformCodes,force,previousCopy:force?current.result?.result||null:null,generationNonce:force?(globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random()):''})});
    if(state.contentGeneration.requestToken!==requestToken)return;
    const generation=d.generation;
    const currentSha=String(state.precheck?.meta?.sha256||'').toLowerCase();
    if(!generation||String(generation.materialSha256||'').toLowerCase()!==currentSha||currentSha!==String(meta.sha256||'').toLowerCase()){resetAudioContentGeneration();return}
    if(generation.status!=='SUCCESS')throw Object.assign(new Error(generation.message||'AI 文案生成失败'),{code:generation.code});
    state.contentGeneration={...state.contentGeneration,status:'SUCCESS',stage:null,sourceType:generation.sourceType||meta.type,result:generation,error:null,materialSha256:generation.materialSha256};
    if(generation.mock===true){
      state.contentGeneration.needsManualApply=false;
      renderAudioCopyStatus();
      if(!automatic)toast('当前为 Mock 演示模式，未分析'+(meta.type==='image'?'图片内容':'视频音频')+'，请先启用在线模型',true);
      return
    }
    const titleUnchanged=($('#publishTitle')?.value||'')===startTitle;
    const bodyUnchanged=($('#publishBody')?.value||'')===startBody;
    if(!titleUnchanged)state.contentGeneration.titleDirty=true;
    if(!bodyUnchanged)state.contentGeneration.bodyDirty=true;
    const applied=applyAudioCopyResult(false);
    if(!applied)renderAudioCopyStatus();
    let knowledgeDraftSaved=false;
    let knowledgeDraftSaveError=null;
    const knowledgeGenerationFailed=meta.type==='video'&&String(generation.calls?.knowledge?.status||'').toUpperCase()==='FAILED';
    if(meta.type==='video'&&generation.knowledgeDraft){
      try{
        await api('/api/material-knowledge-drafts',{method:'POST',body:JSON.stringify({...generation.knowledgeDraft,materialPath,materialFilename:String(materialPath).split(/[\\/]/).pop()||generation.knowledgeDraft.sourceMaterialName||''})});
        knowledgeDraftSaved=true;
      }catch(error){knowledgeDraftSaveError=error}
    }
    const sourceLabel=meta.type==='image'?'图片核心主题':'视频音频内容';
    if(knowledgeDraftSaved)toast('标题和正文已生成，知识草稿已放到知识库');
    else if(knowledgeDraftSaveError)toast('标题和正文已生成，但知识草稿保存失败：'+(knowledgeDraftSaveError.message||'未知错误'),true);
    else if(knowledgeGenerationFailed)toast('标题和正文已生成，但知识草稿生成失败，请点击重新生成文案后再试',true);
    else toast(applied?sourceLabel+'已理解，标题和正文已生成并填入':'AI 文案已生成，现有内容未被覆盖');
  }catch(error){
    if(state.contentGeneration.requestToken!==requestToken)return;
    state.contentGeneration={...state.contentGeneration,status:'FAILED',stage:null,error:error.message||'AI 文案生成失败',result:null,applied:false,needsManualApply:false};
    renderAudioCopyStatus();
    if(!automatic)toast(error.message||'AI 文案生成失败',true);
  }
}
function createTrafficPredictionState(overrides={}){
  return {status:'IDLE',result:null,error:null,requestToken:null,platformCodes:[],...overrides};
}
function resetTrafficPrediction(message=''){
  state.trafficPrediction=createTrafficPredictionState({error:message||null});
  if(state.compliance)renderAiReview(state.compliance);
}
function trafficScoreTone(score){return score>=85?'peak':score>=75?'high':score>=60?'medium':score>=40?'normal':'low'}
function trafficPredictionMarkup(){
  const current=state.trafficPrediction||createTrafficPredictionState();
  if(current.status==='RUNNING')return `<section class="traffic-potential-panel is-running"><div class="traffic-potential-head"><div><span class="traffic-potential-kicker"><i></i>AI 潜力评估 · 正在评估</span><h4>正在评估平台内容适配潜力</h4><p>结合所选平台的内容生态与通用内容规律，逐个平台计算内容适配潜力评分。</p></div><span class="traffic-potential-loader" aria-hidden="true"><i></i><i></i><i></i></span></div><div class="traffic-skeleton-grid">${(current.platformCodes||[]).map(code=>`<div class="traffic-skeleton"><span></span><i></i><i></i></div>`).join('')}</div><small class="traffic-potential-disclaimer">内容适配潜力评分仅供查看，不参与 AI 审核放行或发布阻断。</small></section>`;
  if(current.status==='FAILED')return `<section class="traffic-potential-panel is-failed"><div class="traffic-potential-head"><div><span class="traffic-potential-kicker"><i></i>AI 潜力评估 · 评估异常</span><h4>AI平台内容适配潜力评分暂不可用</h4><p>${esc(current.error||'预测服务暂时不可用，可稍后重新执行 AI 审核。')}</p></div><span class="traffic-potential-status">不影响发布</span></div><small class="traffic-potential-disclaimer">AI 根据平台公开内容趋势及通用大数据规律推测，仅作为参考，非平台官方结论，具体内容表现以平台实际数据为准。</small></section>`;
  if(current.status!=='SUCCESS'||!current.result)return `<section class="traffic-potential-panel is-idle"><div class="traffic-potential-head"><div><span class="traffic-potential-kicker"><i></i>AI 潜力评估</span><h4>AI平台内容适配潜力评分</h4><p>${esc(current.error||'完成 AI 审核后，将按所选平台自动生成内容适配潜力评分与优势因素。')}</p></div><span class="traffic-potential-status">待评估</span></div><small class="traffic-potential-disclaimer">不读取账号近期表现，不预测具体播放量；评分只用于发布前参考。</small></section>`;
  const result=current.result;
  const cards=(result.platformPredictions||[]).map(item=>{const score=Math.max(0,Math.min(100,Number(item.score)||0));const strengths=(item.strengths||[]).map(value=>`<li><i>+</i><span>${esc(value)}</span></li>`).join('');return `<article class="traffic-platform-card is-${trafficScoreTone(score)}" style="--traffic-score:${score}"><div class="traffic-score-ring"><div><strong>${score}</strong><small>潜力分</small></div></div><div class="traffic-platform-copy"><div class="traffic-platform-title"><span>${esc(item.platformName||platformName(item.platformCode))}</span><b>${esc(item.level||'潜力评估')}</b></div><div class="traffic-strength-title">优势因素</div><ul>${strengths}</ul></div></article>`}).join('');
  return `<section class="traffic-potential-panel is-success"><div class="traffic-potential-head"><div><span class="traffic-potential-kicker"><i></i>AI 潜力评估 · RESULT</span><h4>AI平台内容适配潜力评分</h4><p>已根据当前文案与不同平台的内容偏好完成独立推测。</p></div><span class="traffic-overall-score"><b>${Number(result.overallScore)||0}</b><small>综合适配潜力</small></span></div><div class="traffic-platform-grid">${cards}</div>${result.mock===true?'<div class="traffic-mock-note">当前为 Mock 演示结果，未调用在线模型分析当前内容。</div>':''}<small class="traffic-potential-disclaimer">${esc(result.disclaimer||'AI 根据平台公开内容趋势及通用大数据规律推测，仅作为参考，非平台官方结论，具体内容表现以平台实际数据为准。')}</small></section>`;
}
function invalidateCompliance(){
  const hadResult=Boolean(state.compliance)||state.trafficPrediction?.status!=='IDLE';
  state.compliance=null;
  state.trafficPrediction=createTrafficPredictionState();
  const confirmed=$('#warningConfirmed');if(confirmed)confirmed.checked=false;
  if(!hadResult)return;
  const box=$('#complianceBox');
  renderAiStatus(box,{variant:'review',state:'idle',eyebrow:'AI SAFETY SCANNER · OUTDATED',title:'内容已变化，需要重新审核',description:'标题、正文或素材发生了变化，之前的审核与内容适配潜力结果已失效。',stages:['文案校验','来源核对','代表帧抽取','画面识别','结果汇总'],bodyHtml:trafficPredictionMarkup(),footer:'重新执行审核后，系统才会使用新的审核结果。'});
}
function renderAiReview(review){
  const box=$('#complianceBox');if(!box)return;
  const findings=Array.isArray(review.findings)?review.findings:[];
  const mediaLabel=review.sourceType==='video'?'视频画面':'图片画面';
  const resultState=review.status!=='SUCCESS'?'failed':review.overall==='BLOCKED'?'blocked':review.overall==='PASSED'?'success':'warning';
  const resultTitle=review.status!=='SUCCESS'?'AI 审核未成功完成':review.overall==='PASSED'?'AI 审核通过':review.overall==='BLOCKED'?'AI 审核发现阻断风险':'AI 审核发现需确认项';
  const meta=[
    {label:'文案审核',value:statusName(review.textReview?.overall||review.overall)},
    {label:mediaLabel,value:statusName(review.imageReview?.overall||review.overall)},
    {label:'检查画面',value:`${Number(review.frameCount||review.imageReview?.checkedFrames||0)} 张`},
    ...(review.model?[{label:'审核模型',value:review.model}]:[])
  ];
  const findingsHtml=findings.length?`<div class="ai-finding-list">${findings.map(f=>{const findingTone=['blocked','failed','warning','passed'].includes(String(f.level||'').toLowerCase())?String(f.level).toLowerCase():'warning';return `<div class="ai-finding-item is-${findingTone}"><span>${esc(f.level||'风险')}</span><p>${f.frameIndex?`画面 ${esc(f.frameIndex)}：`:''}${esc(f.message)}</p></div>`}).join('')}</div>`:'<div class="ai-review-clear"><i>✓</i><span>未发现明确风险</span></div>';
  renderAiStatus(box,{variant:'review',state:resultState,eyebrow:'AI SAFETY SCANNER · RESULT',title:resultTitle,description:review.summary||'审核结果已返回。',stages:['文案校验','来源核对','代表帧抽取','画面识别','结果汇总'],meta,bodyHtml:findingsHtml+trafficPredictionMarkup(),footer:'原始素材未上传，仅向 AI 发送压缩图片或视频代表帧。AI平台内容适配潜力评分不参与发布放行判断。'});
}
async function runTrafficPrediction({force=true}={}){
  if(!state.compliance||state.compliance.status!=='SUCCESS')return false;
  const platformCodes=[...new Set(selectedTargets().map(item=>item.platformCode))];
  if(!platformCodes.length){state.trafficPrediction=createTrafficPredictionState({error:'请先选择平台账号，再重新执行 AI 审核生成平台潜力评分。'});renderAiReview(state.compliance);return false}
  const requestToken=`traffic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.trafficPrediction=createTrafficPredictionState({status:'RUNNING',requestToken,platformCodes});
  renderAiReview(state.compliance);
  const actionDetail=$('#runCompliance')?.querySelector('.publish-action-detail');if(actionDetail)actionDetail.textContent='正在计算所选平台潜力评分';
  try{
    const contentResult=state.contentGeneration?.result?.result||state.contentGeneration?.result||{};
    const d=await agent('/traffic-prediction',{method:'POST',body:JSON.stringify({
      title:$('#publishTitle')?.value.trim()||'',
      body:$('#publishBody')?.value.trim()||'',
      contentOrigin:$('#contentOrigin')?.value||'',
      materialPath:$('#materialPath')?.value.trim()||'',
      precheck:state.precheck,
      platformCodes,
      contentContext:{coreTheme:contentResult.coreTheme,contentAngle:contentResult.contentAngle,keyPoints:contentResult.keyPoints,sourceSummary:contentResult.sourceSummary||contentResult.imageSummary||contentResult.audioSummary},
      aiReview:state.compliance,
      force
    })});
    if(state.trafficPrediction.requestToken!==requestToken)return false;
    if(d.prediction?.status==='SUCCESS'){
      state.trafficPrediction=createTrafficPredictionState({status:'SUCCESS',result:d.prediction,platformCodes});
      renderAiReview(state.compliance);
      return true;
    }
    state.trafficPrediction=createTrafficPredictionState({status:'FAILED',error:d.prediction?.message||'平台内容适配潜力评估未成功',platformCodes});
    renderAiReview(state.compliance);
    return false;
  }catch(error){
    if(state.trafficPrediction.requestToken!==requestToken)return false;
    state.trafficPrediction=createTrafficPredictionState({status:'FAILED',error:error.message||'平台内容适配潜力评估失败',platformCodes});
    renderAiReview(state.compliance);
    return false;
  }
}
function selectedTargets(){
  const runnableKeys=new Set(runnablePublishAccounts().map(account=>`${account.platform_code}:${account.id}`));
  return [...document.querySelectorAll('.platform-check:checked')].map(c=>({platformCode:c.dataset.platform,accountId:Number(c.dataset.account)})).filter(target=>runnableKeys.has(`${target.platformCode}:${target.accountId}`));
}
async function runPrecheck(automatic=false,{pageGeneration=pageRenderGeneration}={}){
  const materialInput=$('#materialPath');
  const ownsPage=()=>state.page==='publish'&&pageGeneration===pageRenderGeneration&&materialInput?.isConnected;
  if(!ownsPage())return false;
  const t=selectedTargets();
  const targetSnapshot=t.map(target=>`${target.platformCode}:${target.accountId}`).sort().join('|');
  const platforms=[...new Set(t.map(x=>x.platformCode))];
  const materialPath=materialInput.value.trim();
  const requestGeneration=++publishPrecheckRequestGeneration;
  const ownsRequest=()=>ownsPage()&&requestGeneration===publishPrecheckRequestGeneration&&materialInput.value.trim()===materialPath&&selectedTargets().map(target=>`${target.platformCode}:${target.accountId}`).sort().join('|')===targetSnapshot;
  if(!materialPath){showMaterialCheckError('请先选择本地素材');if(!automatic)toast('请先选择本地素材',true);return false}
  const button=$('#runPrecheck');
  if(button){
    button.disabled=true;
    button.classList.add('is-checking');
    button.setAttribute('aria-busy','true');
    const actionTitle=button.querySelector('.publish-action-title');
    const actionDetail=button.querySelector('.publish-action-detail');
    if(actionTitle)actionTitle.textContent='正在检测素材…';
    if(actionDetail)actionDetail.textContent='读取格式参数与平台规则';
  }
  try{
    const d=await agent('/precheck',{method:'POST',body:JSON.stringify({materialPath,platforms})});
    if(!ownsRequest())return false;
    const previousSha=state.precheck?.meta?.sha256;
    const generationSha=state.contentGeneration?.materialSha256;
    state.precheck=d.precheck;
    if((previousSha&&previousSha!==d.precheck?.meta?.sha256)||(generationSha&&generationSha!==d.precheck?.meta?.sha256)){resetAudioContentGeneration();invalidateCompliance()}
    state.materialPreviewUrl=agentResourceUrl(d.previewUrl);
    renderMaterialPrecheck(d.precheck,state.materialPreviewUrl,platforms);
    if(!platforms.length)toast('素材基础检测完成；选择可执行平台后会自动进行平台适配检测');
    else toast(d.precheck.overall==='PASSED'?'平台适配检测完成：通过':d.precheck.overall==='WARNING'?'平台适配检测完成：需人工确认':'平台适配检测完成：不符合要求',d.precheck.overall==='BLOCKED');
    const meta=d.precheck?.meta||{};
    const canGenerate=meta.type==='image'||(meta.type==='video'&&meta.hasAudio===true);
    const shouldGenerate=state.bootstrap?.config?.audioContentAutoTrigger!==false&&d.precheck?.overall!=='BLOCKED'&&canGenerate&&state.contentGeneration.status==='IDLE';
    if(shouldGenerate)void runAudioContentGeneration({automatic:true,force:false});else renderAudioCopyStatus();
    return true;
  }catch(e){if(!ownsRequest())return false;showMaterialCheckError(e.message);toast(e.message,true);return false}
  finally{
    if(ownsRequest()&&button?.isConnected){
      button.disabled=false;
      button.classList.remove('is-checking');
      button.setAttribute('aria-busy','false');
      const actionTitle=button.querySelector('.publish-action-title');
      const actionDetail=button.querySelector('.publish-action-detail');
      if(actionTitle)actionTitle.textContent='重新预检';
      if(actionDetail)actionDetail.textContent='校验文件参数与平台适配';
    }
  }
}
async function runCompliance(){
  const title=$('#publishTitle').value.trim(),body=$('#publishBody').value.trim(),contentOrigin=$('#contentOrigin').value,materialPath=$('#materialPath').value.trim();
  if(!title||!body)return toast('请先填写标题和正文',true);
  if(!contentOrigin)return toast('请先选择内容来源',true);
  if(!materialPath)return toast('请先选择本地素材',true);
  if(!state.precheck)return toast('请先完成素材格式检测',true);
  if(state.precheck.overall==='BLOCKED')return toast('素材格式不符合要求，不能执行 AI 审核',true);
  const button=$('#runCompliance'),box=$('#complianceBox');
  state.trafficPrediction=createTrafficPredictionState();
  if(button){button.disabled=true;button.classList.add('is-ai-running');button.setAttribute('aria-busy','true');const actionTitle=button.querySelector('.publish-action-title');const actionDetail=button.querySelector('.publish-action-detail');if(actionTitle)actionTitle.textContent='AI 正在审核…';if(actionDetail)actionDetail.textContent='扫描文案、来源与代表画面'}
  renderAiStatus(box,{variant:'review',state:'running',eyebrow:'AI SAFETY SCANNER · LIVE',title:'正在审核内容与视频画面',description:'AI 正在联合分析标题、正文、内容来源，并抽取代表帧识别画面风险。',stages:['文案校验','来源核对','代表帧抽取','画面识别','结果汇总'],bodyHtml:trafficPredictionMarkup(),footer:'原始文件不会上传；视频仅在本机抽取并压缩代表帧后发送给 AI。'});
  try{
    const d=await agent('/ai-review',{method:'POST',body:JSON.stringify({title,body,contentOrigin,materialPath,precheck:state.precheck,force:true})});
    state.compliance=d.review;
    renderAiReview(d.review);
    let trafficReady=false;
    if(d.review.status==='SUCCESS')trafficReady=await runTrafficPrediction({force:true});
    const auditSucceeded=d.review.status==='SUCCESS';
    const message=auditSucceeded?(trafficReady?'AI 审核与平台内容适配潜力评估完成':'AI 审核完成，内容适配潜力评分仅供参考或暂不可用'):'AI 审核未成功，请重试';
    toast(message,!auditSucceeded||d.review.overall==='BLOCKED');
  }catch(e){
    state.compliance=null;
    state.trafficPrediction=createTrafficPredictionState({status:'FAILED',error:'AI 审核未成功，暂不生成AI平台内容适配潜力评分。'});
    renderAiStatus(box,{variant:'review',state:'failed',eyebrow:'AI SAFETY SCANNER · ERROR',title:'AI 审核失败',description:e.message||'审核服务暂时不可用，请稍后重试。',stages:['文案校验','来源核对','代表帧抽取','画面识别','结果汇总'],bodyHtml:trafficPredictionMarkup(),footer:'审核失败不能放行自动发布。'});
    toast(e.message,true);
  }finally{
    if(button){button.disabled=false;button.classList.remove('is-ai-running');button.setAttribute('aria-busy','false');const actionTitle=button.querySelector('.publish-action-title');const actionDetail=button.querySelector('.publish-action-detail');if(actionTitle)actionTitle.textContent='审核内容';if(actionDetail)actionDetail.textContent='检查文案、来源、代表画面与平台潜力'}
  }
}
function buildPublishRequestPayload(){
  const form=$('#publishForm');
  const targets=selectedTargets();
  if(!targets.length)throw new Error('请选择至少一个平台账号');
  if(!state.precheck)throw new Error('素材尚未完成自动检测');
  if(state.precheck.overall==='BLOCKED')throw new Error('素材格式不符合要求，不能发布');
  if(!state.compliance)throw new Error('请先执行 AI 内容与图片审核');
  if(state.compliance.status!=='SUCCESS')throw new Error('AI 审核未成功完成，不能发布');
  if(state.compliance.overall==='BLOCKED')throw new Error('AI 审核存在阻断项，不能发布');
  if(state.compliance.overall==='WARNING'&&!$('#warningConfirmed').checked)throw new Error('请人工核对并确认 AI 审核警告');
  const f=new FormData(form);
  const title=String(f.get('title')||'').trim(),body=String(f.get('body')||'').trim(),materialPath=String(f.get('materialPath')||'').trim(),contentOrigin=String(f.get('contentOrigin')||'').trim();
  if(!title||!body||!materialPath)throw new Error('标题、正文和本地素材路径不能为空');
  if(targets.some(target=>target.platformCode==='weibo')&&!contentOrigin)throw new Error('发布到微博前必须选择内容来源');
  const libraryDraft=state.retryDraft?.origin==='content-library'&&state.retryDraft.materialPath===materialPath?state.retryDraft:null;
  return {title,body,materialPath,contentOrigin,targets,precheck:state.precheck,materialMeta:state.precheck?.meta||{},aiReview:state.compliance,complianceConfirmed:$('#warningConfirmed').checked,publishMode:$('#autoPublish').checked?'AUTO':'DRAFT_ONLY',managementConfirmed:$('#autoPublish').checked,retryOfTaskId:state.retrySourceTaskId,...(libraryDraft?{contentLibraryItemId:libraryDraft.id}:{})};
}
async function submitPublish(e){
  e.preventDefault();
  try{
    const payload=buildPublishRequestPayload();
    const d=await api('/api/publish/tasks',{method:'POST',body:JSON.stringify(payload)});
    toast(`任务 #${d.task.id} 已创建`);navigate('tasks');
  }catch(err){if(err.detail?.findings){state.compliance=err.detail;renderAiReview(err.detail)}toast(err.message,true)}
}
const SCHEDULE_STATUS_VIEW={PENDING:['待执行','pending'],TRIGGERING:['正在创建任务','running'],RUNNING:['执行中','running'],COMPLETED:['执行完成','success'],FAILED:['执行失败','failed'],CANCELLED:['已取消','muted']};
function scheduleCountdown(value){
  const ms=new Date(value).getTime()-Date.now();
  if(!Number.isFinite(ms))return '时间无效';
  if(ms<=0)return '已到计划时间';
  const seconds=Math.ceil(ms/1000),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;
  if(days)return `还有 ${days}天 ${hours}小时`;
  if(hours)return `还有 ${hours}小时 ${minutes}分`;
  if(minutes)return `还有 ${minutes}分 ${rest}秒`;
  return `还有 ${rest}秒`;
}
function publishSchedulesHtml(data){
  const records=data.records||[];state.publishSchedules=records;
  const pendingCount=records.filter(item=>item.status==='PENDING').length;
  return `<header class="queue-board-head schedule-board-head"><div class="queue-board-heading"><span class="queue-board-icon schedule-board-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path><path d="M7 3.5 5 5.5M17 3.5l2 2"></path></svg></span><div><span class="queue-board-eyebrow">未来计划</span><h3>未来定时发布任务</h3><p>使用电脑本地时间，到点自动进入正式发布流程。</p></div></div><span class="queue-board-count">${data.total||0}<small>${pendingCount?'待执行':'条任务'}</small></span></header><div class="queue-board-body"><div class="publish-schedule-list">${records.length?records.map(item=>{const view=SCHEDULE_STATUS_VIEW[item.status]||[statusName(item.status),'pending'];const targetText=(item.targets||[]).map(target=>target.platformName).filter((value,index,array)=>array.indexOf(value)===index).join('、')||`${item.target_count||0} 个平台`;return `<article class="publish-schedule-item is-${view[1]}"><div class="schedule-item-head"><div><span class="schedule-number">定时任务 #${item.id}</span><h3>${esc(item.title)}</h3></div><span class="schedule-status ${view[1]}"><i></i>${esc(view[0])}</span></div><div class="schedule-time-block"><small>计划发布时间</small><strong>${fmtTaskPublishTime(item.scheduled_at)}</strong><span data-schedule-countdown="${esc(item.scheduled_at)}">${item.status==='PENDING'?scheduleCountdown(item.scheduled_at):view[0]}</span></div><div class="schedule-meta"><span>${esc(targetText)}</span><span>创建于 ${fmt(item.created_at)}</span>${item.publish_task_id?`<span>正式任务 #${item.publish_task_id}</span>`:''}</div>${item.error_message?`<div class="schedule-error"><b>失败原因</b><span>${esc(item.error_message)}</span></div>`:''}<div class="schedule-actions">${item.status==='PENDING'?`<button type="button" class="btn secondary" data-cancel-schedule="${item.id}">取消任务</button>`:''}${item.publish_task_id?`<button type="button" class="btn secondary" data-open-publish-task="${item.publish_task_id}">查看正式任务</button>`:''}</div></article>`}).join(''):`<div class="queue-empty-state schedule-empty-state"><span class="queue-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 8v4l3 2"></path><path d="M12 3.5v-2M4.5 6l-1.5-1.5M19.5 6 21 4.5"></path></svg></span><b>暂时没有未来发布安排</b><p>创建后会在这里显示执行时间、倒计时和任务状态。</p><button type="button" class="queue-empty-action" data-open-schedule-picker>创建定时发布任务</button></div>`}</div></div>`;
}
async function loadPublishSchedules(silent=false){
  const host=$('#publishSchedules');if(!host)return;
  if(!silent)host.classList.add('is-loading');
  try{const data=await api('/api/publish/schedules?limit=50');host.innerHTML=publishSchedulesHtml(data)}catch(error){if(!silent){host.innerHTML=`<div class="empty">定时任务加载失败：${esc(error.message)}</div>`;toast(error.message,true)}}finally{host.classList.remove('is-loading')}
}
async function handleScheduledPublishQueueClick(event){
  const create=event.target.closest('[data-open-schedule-picker]');
  if(create){openScheduledPublishDialog();return}
  const cancel=event.target.closest('[data-cancel-schedule]');
  if(cancel){
    const id=Number(cancel.dataset.cancelSchedule);
    if(!window.confirm(`确认取消定时任务 #${id}？取消后不会到点发布。`))return;
    cancel.disabled=true;
    try{await api(`/api/publish/schedules/${id}/cancel`,{method:'POST',body:'{}'});toast(`定时任务 #${id} 已取消`);await loadPublishSchedules()}catch(error){toast(error.message,true);cancel.disabled=false}
    return;
  }
  const open=event.target.closest('[data-open-publish-task]');
  if(open){state.taskPlatform='ALL';state.taskStatus='ALL';navigate('tasks')}
}
function localScheduleText(date){const pad=value=>String(value).padStart(2,'0');return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`}
function openScheduledPublishDialog(){
  let payload;
  try{payload=buildPublishRequestPayload()}catch(error){toast(error.message,true);return}
  const base=new Date(Date.now()+5*60*1000);base.setMilliseconds(0);
  const selected={year:base.getFullYear(),month:base.getMonth()+1,day:base.getDate(),hour:base.getHours(),minute:base.getMinutes(),second:base.getSeconds()};
  const overlay=document.createElement('div');overlay.className='confirm-overlay schedule-picker-overlay';
  const units=[['year','年'],['month','月'],['day','日'],['hour','时'],['minute','分'],['second','秒']];
  overlay.innerHTML=`<div class="confirm-dialog schedule-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="schedulePickerTitle"><div class="knowledge-edit-heading"><div><span>电脑本地定时</span><h3 id="schedulePickerTitle">选择定时发布时间</h3></div><button class="knowledge-edit-close schedule-picker-close" type="button" aria-label="关闭">×</button></div><div class="computer-clock"><span>电脑当前时间</span><b id="scheduleComputerClock"></b></div><div class="schedule-wheel-grid">${units.map(([unit,label])=>`<div class="schedule-wheel-column"><b>${label}</b><div class="schedule-wheel" data-schedule-unit="${unit}" role="listbox" aria-label="${label}"></div></div>`).join('')}</div><div class="schedule-selection-summary"><small>计划发布时间</small><strong id="scheduleSelectedTime"></strong><span id="scheduleSelectedCountdown"></span></div><div class="schedule-picker-note">系统使用这台电脑的本地时间，到点后自动进入现有发布执行链路。请确保电脑和本地服务保持运行；即使服务中途重启，未执行任务也会从本地数据库恢复。</div><div class="confirm-actions"><button class="btn secondary schedule-picker-close" type="button">取消</button><button class="btn" id="scheduleCreateSubmit" type="button">创建任务</button></div></div>`;
  let clockTimer=null,scrollTimer=null;
  const close=()=>{if(clockTimer)clearInterval(clockTimer);window.removeEventListener('keydown',onKeyDown);overlay.remove()};
  const onKeyDown=event=>{if(event.key==='Escape')close()};
  const valuesFor=unit=>{if(unit==='year')return Array.from({length:6},(_,index)=>new Date().getFullYear()+index);if(unit==='month')return Array.from({length:12},(_,index)=>index+1);if(unit==='day')return Array.from({length:new Date(selected.year,selected.month,0).getDate()},(_,index)=>index+1);if(unit==='hour')return Array.from({length:24},(_,index)=>index);return Array.from({length:60},(_,index)=>index)};
  const displayValue=(unit,value)=>unit==='year'?String(value):String(value).padStart(2,'0');
  const selectedDate=()=>new Date(selected.year,selected.month-1,selected.day,selected.hour,selected.minute,selected.second,0);
  const updateSummary=()=>{const date=selectedDate();const selectedTime=overlay.querySelector('#scheduleSelectedTime');if(selectedTime)selectedTime.textContent=fmtTaskPublishTime(date.toISOString());const countdown=overlay.querySelector('#scheduleSelectedCountdown');if(countdown){const ms=date.getTime()-Date.now();countdown.textContent=ms>0?scheduleCountdown(date.toISOString()):'请选择晚于当前时间的时间';countdown.classList.toggle('is-invalid',ms<3000)}};
  const syncHighlights=wheel=>{const buttons=[...wheel.querySelectorAll('button')];if(!buttons.length)return;const center=wheel.scrollTop+wheel.clientHeight/2;const index=buttons.reduce((closest,button,buttonIndex)=>Math.abs((button.offsetTop+button.offsetHeight/2)-center)<Math.abs((buttons[closest].offsetTop+buttons[closest].offsetHeight/2)-center)?buttonIndex:closest,0);buttons.forEach((button,buttonIndex)=>{const active=buttonIndex===index;button.classList.toggle('is-selected',active);button.setAttribute('aria-selected',String(active))});const unit=wheel.dataset.scheduleUnit;const value=Number(buttons[index]?.dataset.value);if(Number.isFinite(value)&&selected[unit]!==value){selected[unit]=value;if((unit==='year'||unit==='month')){const maxDay=new Date(selected.year,selected.month,0).getDate();selected.day=Math.min(selected.day,maxDay);renderWheel('day')}updateSummary()}};
  const centerWheelOnButton=(wheel,button)=>{if(!wheel||!button)return;wheel.scrollTop=Math.max(0,button.offsetTop-(wheel.clientHeight-button.offsetHeight)/2)};
  const renderWheel=unit=>{const wheel=overlay.querySelector(`[data-schedule-unit="${unit}"]`);if(!wheel)return;const values=valuesFor(unit);if(!values.includes(selected[unit]))selected[unit]=values.at(-1);wheel.innerHTML=values.map(value=>`<button type="button" role="option" data-value="${value}">${displayValue(unit,value)}</button>`).join('');const index=Math.max(0,values.indexOf(selected[unit]));requestAnimationFrame(()=>{const buttons=[...wheel.querySelectorAll('button')];wheel.style.scrollBehavior='auto';centerWheelOnButton(wheel,buttons[index]);buttons.forEach((button,buttonIndex)=>{const active=buttonIndex===index;button.classList.toggle('is-selected',active);button.setAttribute('aria-selected',String(active))});wheel.style.scrollBehavior='smooth'})};
  units.forEach(([unit])=>renderWheel(unit));updateSummary();
  overlay.querySelectorAll('.schedule-wheel').forEach(wheel=>{wheel.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>syncHighlights(wheel),70)},{passive:true});wheel.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;wheel.scrollTo({top:Math.max(0,button.offsetTop-(wheel.clientHeight-button.offsetHeight)/2),behavior:'smooth'})})});
  const tick=()=>{const nowDate=new Date();const clock=overlay.querySelector('#scheduleComputerClock');if(clock)clock.textContent=fmtTaskPublishTime(nowDate.toISOString());updateSummary()};tick();clockTimer=setInterval(tick,1000);
  overlay.querySelectorAll('.schedule-picker-close').forEach(button=>button.onclick=close);overlay.onclick=event=>{if(event.target===overlay)close()};window.addEventListener('keydown',onKeyDown);
  overlay.querySelector('#scheduleCreateSubmit').onclick=async event=>{const date=selectedDate();if(date.getTime()-Date.now()<3000)return toast('定时发布时间至少需要晚于电脑当前时间 3 秒',true);event.currentTarget.disabled=true;event.currentTarget.textContent='正在创建…';try{const result=await api('/api/publish/schedules',{method:'POST',body:JSON.stringify({...payload,scheduledAt:date.toISOString(),scheduledLocal:localScheduleText(date),timezoneOffsetMinutes:date.getTimezoneOffset(),createdBy:'运营席位'})});toast(`定时任务 #${result.schedule.id} 已创建，将于 ${fmtTaskPublishTime(result.schedule.scheduled_at)} 执行`);close();await loadPublishSchedules()}catch(error){toast(error.message,true);event.currentTarget.disabled=false;event.currentTarget.textContent='创建任务'}};
  document.body.appendChild(overlay);
}

function platformName(c){return state.bootstrap.platforms.find(p=>p.code===c)?.name||c}
function taskPlatformIcon(code){return ({ALL:'全',xiaohongshu:'小',douyin:'抖',wechat_channels:'视',bilibili:'B',weibo:'微'}[code]||String(code||'?').slice(0,2))}
function taskPlatformTabs(platformCounts,total){
  const configured=(state.bootstrap?.platforms||[]).slice().sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  const countMap=new Map((platformCounts||[]).map(item=>[item.code,Number(item.task_count||0)]));
  const mode=state.bootstrap?.config?.rpaMode||'simulated';
  const tabs=[{code:'ALL',name:'全部平台',task_count:Number(total||0),ready:true},...configured.map(item=>{
    const assisted=mode==='five_platform_assisted'||(mode==='xiaohongshu_assisted'&&item.code==='xiaohongshu');
    return {...item,task_count:countMap.get(item.code)||0,ready:assisted,simulated:!assisted};
  })];
  return `<div class="task-platform-tabs" role="tablist" aria-label="按发布平台筛选任务">${tabs.map(item=>{const active=state.taskPlatform===item.code;const hint=item.code==='ALL'?'查看所有平台任务':item.ready?'辅助浏览器链路已接入':'当前使用模拟适配器';return `<button type="button" class="task-platform-tab ${active?'active':''} ${item.ready?'ready':'pending'}" data-task-platform="${esc(item.code)}" role="tab" aria-selected="${active}"><span class="task-platform-icon">${item.code==='ALL'?'全':platformLogo(item.code,26)}</span><span><b>${esc(item.name)}</b><small>${esc(hint)}</small></span><em>${item.task_count}</em></button>`}).join('')}</div>`;
}

function taskFailureMessage(task){
  const failed=(task.targets||[]).filter(target=>['FAILED','REJECTED'].includes(target.status));
  const details=failed.map(target=>{
    const raw=target.review_message||(typeof target.result==='string'?target.result:target.result?.message)||'';
    return raw?`${target.platform_name||platformName(target.platform_code)}：${cleanText(raw)}`:'';
  }).filter(Boolean);
  return details.join('；');
}
function taskDisplayStatus(task,platformScoped=false){
  if(task.retryRecovery?.recovered||task.displayStatus==='RECOVERED_BY_RETRY')return 'RECOVERED_BY_RETRY';
  const pendingSecurity=(task.targets||[]).some(target=>target.status==='NEEDS_CONFIRMATION'&&taskTargetResult(target).manualSecurityVerificationRequired===true);
  if(pendingSecurity&&!(task.targets||[]).some(target=>['FAILED','REJECTED'].includes(target.status)))return 'WAITING_MANUAL_SECURITY';
  if(!platformScoped)return task.displayStatus||task.status;
  const statuses=(task.targets||[]).map(target=>target.status);
  if(statuses.length&&statuses.every(status=>['PUBLISHED','SUCCESS'].includes(status)))return statuses.every(status=>status==='PUBLISHED')?'PUBLISHED':'SUCCESS';
  if(statuses.some(status=>['FAILED','REJECTED'].includes(status)))return 'FAILED';
  if(statuses.some(status=>status==='NEEDS_CONFIRMATION'))return 'NEEDS_CONFIRMATION';
  if(statuses.some(status=>status==='REVIEWING'))return 'REVIEWING';
  if(statuses.some(status=>status==='SYNCING'))return 'SYNCING';
  if(statuses.some(status=>status==='SUBMITTED'))return 'SUBMITTED';
  return task.displayStatus||task.status;
}
function canAutoRetryTarget(target){
  const terminalAttemptStates=['DRAFT_BLOCKED','SUBMITTING','SUBMIT_ATTEMPTED_UNCONFIRMED','SUBMITTED','PUBLISHED','REJECTED'];
  const result=taskTargetResult(target);
  return ['FAILED','REJECTED'].includes(target.status)&&result.manualActionRequired!==true&&target.submit_lock!=='LOCKED'&&!target.submit_attempted_at&&!terminalAttemptStates.includes(target.publish_attempt_state);
}
function targetSubmitRisk(target){
  if(taskTargetResult(target).manualSecurityVerificationRequired===true)return '请在原平台完成安全验证并发布，系统等待你的发布确认。';
  if(target.publish_attempt_state==='UPLOAD_NOT_STARTED')return '平台没有真正启动上传，也没有生成草稿；可直接重新发送，不会造成重复发布';
  if(target.publish_attempt_state==='UPLOAD_FAILED')return '视频尚未提交平台，上传过程中出现网络异常；检查网络后可重新发送，不会造成重复发布';
  if(target.publish_attempt_state==='SUBMIT_ATTEMPTED_UNCONFIRMED')return '已提交平台，正在确认发布结果；为防止重复发布，暂时禁止再次投稿';
  if(target.submit_lock==='LOCKED'&&!['PUBLISHED','REJECTED'].includes(target.publish_attempt_state))return '已提交平台，正在确认发布结果；为防止重复发布，暂时禁止再次投稿';
  if(target.publish_attempt_state==='DRAFT_BLOCKED')return '草稿阶段已阻断，未执行最终投稿';
  return '';
}
function targetSubmitNoticeClass(target){
  if(target.publish_attempt_state==='SUBMIT_ATTEMPTED_UNCONFIRMED')return 'is-verifying';
  if(target.submit_lock==='LOCKED'&&!['PUBLISHED','REJECTED'].includes(target.publish_attempt_state))return 'is-verifying';
  return targetSubmitRisk(target)?'has-risk':'';
}
function taskTargetResult(target){return target?.result&&typeof target.result==='object'?target.result:{}}
function bilibiliDraftActionState(target){
  if(target.platform_code!=='bilibili')return {canResume:false,label:''};
  const result=taskTargetResult(target);const assessment=result.draftAssessment||{};const fingerprint=target.draft_fingerprint;
  const canResume=Boolean(fingerprint?.fingerprintHash&&(result.draftResumeAvailable===true||assessment.resumeAllowed===true)&&assessment.managed===true&&target.submit_lock!=='LOCKED'&&!target.submit_attempted_at);
  const hasVerifiedDraft=Boolean(result.draftSaved===true||result.draftPreservedInBrowser===true||result.draftExists===true||result.draftResumeAvailable===true||assessment.managed===true);
  let label='';
  if(result.stage==='existing_draft_requires_verification'||target.publish_attempt_state==='SUBMIT_ATTEMPTED_UNCONFIRMED')label='投稿结果待核验：已禁止重投';
  else if(result.stage==='existing_draft_blocked'&&canResume)label='未提交：检测到可续接的系统草稿';
  else if(result.stage==='existing_draft_blocked'&&hasVerifiedDraft)label='未提交：检测到遗留草稿，已安全保留';
  else if(target.publish_attempt_state==='DRAFT_BLOCKED'&&hasVerifiedDraft)label='未提交：检测到遗留草稿，已安全保留';
  else if(target.publish_attempt_state==='DRAFT_BLOCKED'||result.stage==='draft_prepare_blocked'||result.stage==='draft_prepare_unconfirmed')label='未提交：草稿创建未完成，当前没有确认到B站草稿';
  return {canResume,label};
}
function publishVerificationState(target){
  const result=taskTargetResult(target);
  const terminal=['PUBLISHED','REJECTED'].includes(target.status)||['PUBLISHED','REJECTED'].includes(target.publish_attempt_state);
  const canVerify=!terminal&&result.manualSecurityVerificationRequired!==true&&Boolean(result.verificationRequired===true||target.submission_status==='SUBMITTED'||target.submit_lock==='LOCKED'||['DRAFT_BLOCKED','SUBMITTING','SUBMIT_ATTEMPTED_UNCONFIRMED','SUBMITTED','REVIEWING','UNKNOWN'].includes(target.publish_attempt_state)||['SUBMITTED','REVIEWING','SYNCING','NEEDS_CONFIRMATION'].includes(target.status));
  const jobStatus=String(target.verification_job_status||'').toUpperCase();
  const source=String(target.verification_source||'').toUpperCase();
  const manualVerification=['MANUAL','MANUAL_PUBLISHED_CONFIRMATION'].includes(source);
  let scheduleLabel='';
  if(jobStatus==='RUNNING')scheduleLabel='正在核验平台状态';
  else if(jobStatus==='QUEUED'&&manualVerification)scheduleLabel='人工确认后的核验已排队，等待当前平台操作完成';
  else if(jobStatus==='QUEUED'&&target.next_verification_at)scheduleLabel=`下次自动核验：${fmt(target.next_verification_at)}`;
  else if(target.last_checked_at)scheduleLabel=`上次核验：${fmt(target.last_checked_at)}`;
  const buttonLabel=jobStatus==='RUNNING'?'正在核验…':jobStatus==='QUEUED'&&manualVerification?'人工核验已排队':'立即查询平台状态';
  return {canVerify,scheduleLabel,buttonLabel,jobStatus,source};
}
function bilibiliManagementBlockReason(target){
  if(target?.platform_code!=='bilibili')return null;
  const result=taskTargetResult(target);
  const precheck=result.managementPrecheck||{};
  const reason=String(result.reason||precheck.reason||'').toUpperCase();
  if(reason!=='RECORD_PREDATES_TASK')return null;
  const match=precheck.managementMatch||precheck.match||result.managementMatch||result.match||{};
  const submittedAt=match.submittedAt||precheck.submittedAt||result.submittedAt;
  const submittedTime=submittedAt?fmtTaskPublishTime(submittedAt):'';
  const title=match.title||result.title||'';
  const postId=match.platformPostId||precheck.platformPostId||result.platformPostId||'';
  const details=[];
  if(title)details.push(`标题“${title}”`);
  if(submittedTime&&submittedTime!=='—')details.push(`发布时间：${submittedTime}`);
  if(postId)details.push(`BV号：${postId}`);
  return {
    reason,
    label:`检测到B站管理页已有历史同款视频${details.length?`（${details.join('，')}）`:''}。为避免重复投稿，本次未点击最终发布，请人工确认。`,
    detail:'系统动作：已在最终投稿前阻断，未实际提交；请到B站确认该历史视频是否就是本次任务的发布结果。'
  };
}
function manualPublishFallbackState(target){
  const result=taskTargetResult(target);
  const terminal=['PUBLISHED','REJECTED'].includes(target.status)||['PUBLISHED','REJECTED'].includes(target.publish_attempt_state);
  const notSubmitted=target.submission_status!=='SUBMITTED';
  const uploadFailed=['UPLOAD_NOT_STARTED','UPLOAD_FAILED'].includes(target.publish_attempt_state)||result.uploadDefinitelyNotStarted===true||result.uploadFailed===true||['upload_not_started','upload_failed'].includes(result.stage);
  const required=!uploadFailed&&!terminal&&Boolean(result.manualActionRequired===true||target.publish_attempt_state==='DRAFT_BLOCKED'||target.publish_attempt_state==='SUBMIT_ATTEMPTED_UNCONFIRMED'||(['FAILED','NEEDS_CONFIRMATION'].includes(target.status)&&notSubmitted));
  const bilibiliBlock=required?bilibiliManagementBlockReason(target):null;
  let label=''; let detail='';
  if(required&&result.manualSecurityVerificationRequired===true){label='待人工安全验证发布';detail='在原平台完成安全验证并发布后，点击“我已发布，开始核验”。平台核验通过后才会显示已发布。';}
  else if(result.manualSubmissionConfirmed===true){label=terminal?(target.status==='PUBLISHED'?'人工发布已通过平台核验':'平台审核未通过'):'已确认人工发布，正在自动核验平台结果';}
  else if(bilibiliBlock){label=bilibiliBlock.label;detail=bilibiliBlock.detail;}
  else if(required&&target.publish_attempt_state==='SUBMIT_ATTEMPTED_UNCONFIRMED')label='已提交平台，但状态尚未确认；请先查询平台状态，如平台已发布可人工确认';
  else if(required&&result.draftSaved===true)label='自动发布未成功，草稿已保存，需要人工处理';
  else if(required&&(result.draftPreservedInBrowser===true||result.draftSaved===true||result.draftExists===true))label='自动发布未成功，草稿已确认保留，需要人工处理';
  else if(required&&target.publish_attempt_state==='DRAFT_BLOCKED')label='自动发布未成功，当前没有确认到草稿，需要重新准备后再发送';
  else if(required)label='自动发布未成功，需要人工处理';
  return {required,canOpen:required,canConfirm:required&&result.manualSubmissionConfirmed!==true,label,detail,reason:bilibiliBlock?.reason||null};
}
function taskTargetDetails(task){
  return (task.targets||[]).map(target=>{
    const recovery=target.retryRecovery;
    const recovered=recovery?.recovered===true;
    const risk=recovered?'':targetSubmitRisk(target);
    const draft=recovered?{canResume:false,label:''}:bilibiliDraftActionState(target);
    const verification=recovered?{canVerify:false,scheduleLabel:''}:publishVerificationState(target);
    const manual=recovered?{canOpen:false,canConfirm:false,label:''}:manualPublishFallbackState(target);
    const actions=[
      draft.canResume?`<button type="button" class="btn task-target-action resume-bilibili-draft" data-task-id="${task.id}" data-target-id="${target.id}">继续系统草稿</button>`:'',
      verification.canVerify?`<button type="button" class="btn secondary task-target-action verify-publish-target" data-target-id="${target.id}" ${verification.jobStatus==='RUNNING'?'disabled':''}>${esc(verification.buttonLabel)}</button>`:'',
      manual.canOpen?`<button type="button" class="btn secondary task-target-action open-manual-publish" data-platform="${esc(target.platform_code)}" data-target-id="${target.id}">打开平台处理</button>`:'',
      manual.canConfirm?`<button type="button" class="btn success task-target-action confirm-manual-published" data-target-id="${target.id}">我已发布，开始核验</button>`:'' ]
      .filter(Boolean).join('');
    const actionLabel=manual.label||draft.label;
    const executionLabel=taskTargetResult(target).manualSecurityVerificationRequired===true?'待人工安全验证发布':recovered?`已补发成功（原记录：${statusName(target.status)}）`:statusName(target.status);
    const recoveryLabel=recovered?`<strong class="task-recovered-state">已通过补发任务 #${recovery.retryTaskId} 发布成功${recovery.recoveredAt?`　确认时间：${fmt(recovery.recoveredAt)}`:''}</strong>`:'';
    return `<div class="task-target-detail ${recovered?'is-recovered':targetSubmitNoticeClass(target)}"><b>${esc(target.platform_name||platformName(target.platform_code))} · ${esc(target.account_name||target.profile_name||'—')}</b><span>执行：${esc(executionLabel)}　投稿阶段：${esc(statusName(target.publish_attempt_state||'NOT_ATTEMPTED'))}　投稿锁：${esc(statusName(target.submit_lock||'UNLOCKED'))}　尝试次数：${Number(target.submit_attempt_count||0)}</span>${recoveryLabel}${verification.scheduleLabel?`<small class="task-verification-state">${esc(verification.scheduleLabel)}${target.last_checked_at&&verification.jobStatus?`　上次核验：${esc(fmt(target.last_checked_at))}`:''}</small>`:''}${actionLabel?`<strong class="task-draft-state">${esc(actionLabel)}</strong>`:''}${manual.detail?`<small class="task-manual-detail">${esc(manual.detail)}</small>`:''}${risk?`<em>${esc(risk)}</em>`:''}${actions?`<div class="task-target-actions">${actions}</div>`:''}</div>`;
  }).join('');
}
function taskMaterialFileName(value){return String(value||'').split(/[\\/]/).filter(Boolean).pop()||''}
async function resumeBilibiliDraft(taskId,targetId,button){
  const originalText=button?.textContent||'\u7ee7\u7eed\u7cfb\u7edf\u8349\u7a3f';if(button){button.disabled=true;button.textContent='\u68c0\u67e5\u4e2d\u2026'}
  try{
    const data=await api(`/api/tasks/${taskId}`);const task=data.task;const target=(task?.targets||[]).find(item=>Number(item.id)===Number(targetId));
    if(!task||!target||target.platform_code!=='bilibili')throw new Error('\u672a\u627e\u5230B\u7ad9\u53d1\u5e03\u76ee\u6807');
    const draft=bilibiliDraftActionState(target);if(!draft.canResume)throw new Error('\u8be5\u8349\u7a3f\u5df2\u4e0d\u6ee1\u8db3\u5b89\u5168\u7eed\u63a5\u6761\u4ef6\uff0c\u8bf7\u5148\u91cd\u65b0\u6838\u9a8c');
    const material=task.material_meta||{};const materialMeta=material.meta||material;const contentOrigin=material.contentOrigin||materialMeta.contentOrigin;const fingerprint=target.draft_fingerprint||{};const expectedMaterial=fingerprint.materialName||taskMaterialFileName(task.material_path);
    if(!contentOrigin)throw new Error('\u4efb\u52a1\u7f3a\u5c11\u5185\u5bb9\u6765\u6e90\uff0c\u7981\u6b62\u731c\u6d4b\u540e\u7eed\u63a5\u8349\u7a3f');
    if(!fingerprint.fingerprintHash||!fingerprint.materialSha256||!expectedMaterial)throw new Error('\u8349\u7a3f\u6307\u7eb9\u4e0d\u5b8c\u6574\uff0c\u7981\u6b62\u81ea\u52a8\u7eed\u63a5');
    if(!window.confirm('\u7cfb\u7edf\u5c06\u6253\u5f00B\u7ad9\u8349\u7a3f\uff0c\u518d\u6b21\u6838\u5bf9\u5b9e\u9645\u6807\u9898\u548c\u7d20\u6750\uff0c\u7136\u540e\u6267\u884c\u6700\u7ec8\u6295\u7a3f\u3002\n\n\u5df2\u5c1d\u8bd5\u6295\u7a3f\u7684\u8349\u7a3f\u4e0d\u4f1a\u91cd\u6295\u3002\u662f\u5426\u7ee7\u7eed\uff1f'))return;
    if(button)button.textContent='\u7eed\u63a5\u4e2d\u2026';
    const response=await agent('/platforms/bilibili/submit-existing-draft',{method:'POST',body:JSON.stringify({authorized:true,taskId:Number(task.id),targetId:Number(target.id),accountId:Number(target.account_id),profileName:target.profile_name||'',expectedTitle:task.title,expectedMaterial,materialPath:task.material_path,materialSha256:fingerprint.materialSha256,materialMeta,draftFingerprint:fingerprint,body:task.body,contentOrigin})});
    const output=response.output||{};toast(output.status==='SUCCESS'?'B\u7ad9\u8349\u7a3f\u7eed\u63a5\u5df2\u5b8c\u6210':'B\u7ad9\u8349\u7a3f\u4ecd\u9700\u4eba\u5de5\u786e\u8ba4',output.status!=='SUCCESS');await renderTasks();
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}
async function verifyPublishTarget(targetId,button){
  const originalText=button?.textContent||'立即查询平台状态';if(button){button.disabled=true;button.textContent='正在提交核验…'}
  try{
    const data=await api(`/api/publish/targets/${targetId}/verify`,{method:'POST',body:'{}'});
    const message=data.action==='ALREADY_RUNNING'?'平台状态正在核验，无需重复提交':data.waitingForPlatform?'人工核验已排队，将在当前平台操作完成后立即执行':data.action==='ALREADY_QUEUED'?'已有人工核验任务，已调整为立即执行':'人工核验已立即排队';
    toast(`${message}（Job#${data.jobId}）`);await renderTasks();
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}
async function openManualPublish(platformCode,button){
  const originalText=button?.textContent||'打开平台处理';
  if(button){button.disabled=true;button.textContent='正在打开…'}
  try{
    await agent(`/platforms/${platformCode}/open-manual-action`,{method:'POST',body:'{}'});
    toast(`${platformName(platformCode)}已打开；请核对本次内容，在平台侧完成验证及发布后再点击“我已发布，开始核验”`);
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}
async function confirmManualPublished(targetId,button){
  const confirmed=window.confirm('请只在已经进入对应平台，并确认本次内容已实际发布后点击。\n\n确认后系统会锁定本次任务并自动核验平台结果；核验通过后才显示已发布，不会再次投稿。');
  if(!confirmed)return;
  const originalText=button?.textContent||'我已发布，开始核验';
  if(button){button.disabled=true;button.textContent='正在确认…'}
  try{
    await api(`/api/publish/targets/${targetId}/manual-published`,{method:'POST',body:JSON.stringify({handledBy:'运营人员'})});
    toast('已确认人工提交，正在自动核验平台结果');
    await renderTasks();
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}

function taskVisualState(task,platformScoped=false){
  const status=taskDisplayStatus(task,platformScoped);
  if(['PUBLISHED','SUCCESS','RECOVERED_BY_RETRY'].includes(status))return {key:'SUCCESS',tone:'success',label:status==='RECOVERED_BY_RETRY'?'补发恢复完成':'执行闭环完成',detail:status==='RECOVERED_BY_RETRY'?'异常目标已通过补发恢复':'发布链路已完成，可查看平台结果',status};
  if(status==='WAITING_MANUAL_SECURITY')return {key:'REVIEW',tone:'review',label:'待人工安全验证发布',detail:'完成平台验证并发布后，请确认开始结果核验',status};
  if(['FAILED','PARTIAL_FAILED','REJECTED'].includes(status))return {key:'FAILED',tone:'failed',label:status==='PARTIAL_FAILED'?'部分目标异常':'发布链路异常',detail:'保留失败审计，可按安全策略重新发送',status};
  if(['SUBMITTED','REVIEWING','SYNCING','NEEDS_CONFIRMATION','UNKNOWN'].includes(status))return {key:'REVIEW',tone:'review',label:'等待结果确认',detail:'内容已进入平台侧，正在核验最终状态',status};
  return {key:'ACTIVE',tone:'running',label:status==='QUEUED'?'等待执行':'发布执行中',detail:status==='QUEUED'?'任务已入列，等待平台执行资源':'自动化发布链路正在实时推进',status};
}
function taskProgressModel(task,platformScoped=false){
  const visual=taskVisualState(task,platformScoped);
  const stages=['任务入列','内容校验','平台队列','自动执行','结果核验'];
  let current=1;
  if(visual.key==='SUCCESS')current=stages.length;
  else if(visual.status==='WAITING_MANUAL_SECURITY'){current=4;stages[3]='人工安全验证';}
  else if(visual.key==='REVIEW')current=stages.length;
  else if(visual.key==='FAILED'){
    const targetStates=(task.targets||[]).flatMap(target=>[target.status,target.publish_attempt_state,target.submission_status]);
    current=targetStates.some(status=>['SUBMITTED','REVIEWING','SYNCING','NEEDS_CONFIRMATION','SUBMIT_ATTEMPTED_UNCONFIRMED'].includes(status))?5:targetStates.some(status=>['EXECUTING','RUNNING','PROCESSING','SUBMITTING','UPLOAD_FAILED','PLATFORM_UPLOAD_FAILED','DRAFT_BLOCKED'].includes(status))?4:3;
  }else if(['EXECUTING','RUNNING','PROCESSING','RETRYING','SUBMITTING'].includes(visual.status))current=4;
  else if(['QUEUED','PENDING'].includes(visual.status))current=1;
  else current=2;
  return {stages,current,visual};
}
function taskProgressMarkup(task,platformScoped=false){
  const model=taskProgressModel(task,platformScoped);
  return `<div class="task-progress ${model.visual.tone}" aria-label="发布进程：${esc(model.visual.label)}"><div class="task-progress-track" aria-hidden="true"><span style="--task-progress:${Math.max(0,(model.current-1)/(model.stages.length-1))*100}%"></span></div><div class="task-progress-stages">${model.stages.map((stage,index)=>{const step=index+1;const done=model.visual.key==='SUCCESS'||step<model.current;const active=step===model.current&&model.visual.key!=='SUCCESS';const failed=active&&model.visual.key==='FAILED';return `<span class="task-progress-step ${done?'is-done':''} ${active?'is-active':''} ${failed?'is-failed':''}"><i>${done?'✓':step}</i><b>${esc(stage)}</b></span>`}).join('')}</div></div>`;
}
function taskStatusCounts(tasks,platformScoped=false){
  const counts={ALL:tasks.length,ACTIVE:0,REVIEW:0,FAILED:0,SUCCESS:0};
  tasks.forEach(task=>{const key=taskVisualState(task,platformScoped).key;counts[key]=(counts[key]||0)+1});
  return counts;
}
function taskStatusFilters(counts){
  const filters=[['ALL','全部任务','总览'],['ACTIVE','执行中','LIVE'],['REVIEW','待确认','VERIFY'],['FAILED','异常','ALERT'],['SUCCESS','已完成','DONE']];
  return `<nav class="task-state-filters" aria-label="按任务状态筛选">${filters.map(([key,label,code])=>{const active=(state.taskStatus||'ALL')===key;return `<button type="button" class="task-state-filter ${active?'active':''} is-${key.toLowerCase()}" data-task-status="${key}" aria-pressed="${active}"><span><i></i>${label}</span><b>${Number(counts[key]||0)}</b><small>${code}</small></button>`}).join('')}</nav>`;
}
function taskCommandCenter(counts,currentName){
  const live=Number(counts.ACTIVE||0)+Number(counts.REVIEW||0);
  const headline=live?'发布链路正在运行':'发布链路处于待命状态';
  const detail=live?`${live} 个任务正在执行或等待平台确认`:'暂无进行中任务，新任务进入后将实时展示执行轨迹';
  return `<section class="task-command-center ${live?'is-live':'is-idle'}"><div class="task-command-grid" aria-hidden="true"></div><div class="task-command-scan" aria-hidden="true"></div><div class="task-command-copy"><span class="task-command-kicker"><i></i> PUBLISHING CONTROL NODE · ${live?'LIVE':'STANDBY'}</span><h2>${headline}</h2><p>${esc(detail)}，当前视图：${esc(currentName)}。</p><div class="task-signal-bars" aria-hidden="true">${Array.from({length:18},(_,index)=>`<i style="--bar:${(index%6)+1};--delay:-${index*0.08}s"></i>`).join('')}</div></div><div class="task-orbit" aria-hidden="true"><span class="task-orbit-ring ring-one"></span><span class="task-orbit-ring ring-two"></span><span class="task-orbit-core"><i></i><b>${live}</b><small>ACTIVE</small></span><em class="task-orbit-satellite satellite-one"></em><em class="task-orbit-satellite satellite-two"></em></div><div class="task-command-metrics"><div><span>全部任务</span><b>${Number(counts.ALL||0)}</b><small>TOTAL QUEUE</small></div><div class="is-live"><span>执行 / 待确认</span><b>${live}</b><small>IN FLIGHT</small></div><div class="is-alert"><span>异常待处理</span><b>${Number(counts.FAILED||0)}</b><small>NEED ACTION</small></div><div class="is-done"><span>已完成</span><b>${Number(counts.SUCCESS||0)}</b><small>CLOSED LOOP</small></div></div></section>`;
}
function taskCard(task,{retryable=false,displayStatus=task.status,platformScoped=false}={}){
  const targetDetails=taskTargetDetails(task);
  const recovery=task.retryRecovery;
  const recovered=recovery?.recovered===true;
  const failureMessage=(retryable||recovered)?taskFailureMessage(task):'';
  const canRetry=retryable&&!recovered&&(task.targets||[]).some(canAutoRetryTarget);
  const publishTime=fmtTaskPublishTime(task.created_at);
  const visual=taskVisualState(task,platformScoped);
  const recoveryNotice=recovered?`<div class="task-retry-recovery"><b>已补发成功</b><span>原失败平台已通过补发任务 #${recovery.retryTaskId} 发布成功${recovery.recoveredAt?`，确认时间：${fmt(recovery.recoveredAt)}`:''}。原失败记录继续保留。</span></div>`:'';
  const failureLabel=recovered?'原失败记录':'失败原因';
  return `<article class="task-card compact-task-card task-stream-card is-${visual.tone} ${retryable?"is-failed":""} ${recovered?"is-recovered":""}"><div class="task-stream-rail" aria-hidden="true"><span></span><i></i><small>#${task.id}</small></div><div class="task-card-content"><div class="task-card-top"><div class="meta compact-task-meta"><span>任务 #${task.id} ${badge(displayStatus)} ${badge(task.compliance?.overall)}<time class="task-publish-time" datetime="${esc(task.created_at||'')}">发布时间：${esc(publishTime)}</time></span>${task.retry_of_task_id?`<span class="retry-source">再次发送自 #${task.retry_of_task_id}</span>`:""}</div><div class="task-live-status"><i></i><span><b>${esc(visual.label)}</b><small>${esc(visual.detail)}</small></span></div></div><h3>${esc(task.title)}</h3><p>${esc(task.body).slice(0,220)}</p>${taskProgressMarkup(task,platformScoped)}${recoveryNotice}${targetDetails?`<div class="task-target-details">${targetDetails}</div>`:""}${failureMessage?`<div class="task-failure-reason ${recovered?'is-audit':''}">${failureLabel}：${esc(failureMessage)}</div>`:""}</div><div class="task-card-actions">${canRetry?`<button type="button" class="btn retry-task-button" data-retry-task="${task.id}">再次发送</button>`:""}<button type="button" class="btn danger delete-task-button" data-delete-task="${task.id}">删除</button></div></article>`;
}
function taskStream(tasks,{platformScoped=false,emptyText='暂无符合条件的任务'}={}){
  return `<section class="task-stream"><header class="task-stream-head"><div><span class="task-stream-eyebrow"><i></i> REAL-TIME TASK STREAM</span><h3>任务执行流</h3><p>成功、异常、待确认与补发恢复统一按时间展示，通过状态轨道快速识别当前进度。</p></div><span class="task-stream-count">${tasks.length} 条记录</span></header><div class="task-stream-list">${tasks.length?tasks.map(task=>{const visual=taskVisualState(task,platformScoped);return taskCard(task,{retryable:visual.key==='FAILED',displayStatus:visual.status,platformScoped})}).join(''):`<div class="task-stream-empty"><span><i></i></span><b>${esc(emptyText)}</b><p>可切换上方平台或状态筛选查看其他任务。</p></div>`}</div></section>`;
}async function deleteTask(task,button){
  if(!task?.id)return;
  const confirmed=await confirmDelete({
    title:`删除任务 #${task.id}？`,
    message:task.title?`“${task.title}”将从任务中心永久删除。`:'该发布任务将从任务中心永久删除。',
    details:[
      '任务记录和对应的平台目标将被删除，此操作不可恢复。',
      '尚未开始的排队发布会自动取消；已完成的 Agent 执行日志仍保留用于审计。',
      '如果任务正在平台执行，系统会阻止删除，避免实际操作与管理记录失去对应关系。'
    ],
    confirmLabel:'删除任务'
  });
  if(!confirmed)return;
  const originalText=button?.textContent||'删除';
  if(button){button.disabled=true;button.textContent='删除中…'}
  try{
    const data=await api(`/api/tasks/${task.id}`,{method:'DELETE'});
    const cancelled=Number(data.deleted?.cancelledJobs||0);
    toast(cancelled?`任务 #${task.id} 已删除，并取消 ${cancelled} 个排队执行`:`任务 #${task.id} 已删除`);
    await renderTasks();
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}

async function prepareTaskRetry(taskId,button){
  if(button){button.disabled=true;button.textContent='正在载入…'}
  try{
    const data=await api(`/api/tasks/${taskId}`);
    const task=data.task;
    if(!task||!['FAILED','PARTIAL_FAILED'].includes(task.status))throw new Error('只有发送失败或部分失败的任务可以再次发送');
    const failedTargets=(task.targets||[]).filter(canAutoRetryTarget);
    if(!failedTargets.length)throw new Error('\u8be5\u4efb\u52a1\u6ca1\u6709\u5141\u8bb8\u81ea\u52a8\u91cd\u53d1\u7684\u5931\u8d25\u5e73\u53f0\uff1b\u5df2\u83b7\u53d6\u6295\u7a3f\u9501\u7684\u76ee\u6807\u53ea\u80fd\u5bf9\u8d26');
    const material=task.material_meta||{};
    state.retryDraft={
      sourceTaskId:task.id,
      title:task.title||'',
      body:task.body||'',
      materialPath:task.material_path||'',
      targets:failedTargets.map(target=>({platformCode:target.platform_code,accountId:Number(target.account_id)}))
    };
    navigate('publish');
  }catch(error){toast(error.message,true);if(button){button.disabled=false;button.textContent='再次发送'}}
}
async function renderTasks(prefetchedData=null){
  const owner=capturePageOwner();
  const selected=state.taskPlatform&&state.taskPlatform!=='ALL'?state.taskPlatform:null;
  const data=prefetchedData||await api('/api/tasks'+(selected?`?platformCode=${encodeURIComponent(selected)}`:''));
  if(!ownsPageOwner(owner)||state.page!=='tasks'||selected!==(state.taskPlatform&&state.taskPlatform!=='ALL'?state.taskPlatform:null))return;
  taskRefreshSignatureValue=JSON.stringify(data);
  const tasks=(data.tasks||[]).slice().sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
  const platforms=state.bootstrap?.platforms||[];
  const current=selected?platforms.find(item=>item.code===selected):null;
  const platformScoped=Boolean(selected);
  const counts=taskStatusCounts(tasks,platformScoped);
  const activeFilter=state.taskStatus||'ALL';
  const filtered=activeFilter==='ALL'?tasks:tasks.filter(task=>taskVisualState(task,platformScoped).key===activeFilter);
  const filterLabel=({ALL:'全部任务',ACTIVE:'执行中任务',REVIEW:'待确认任务',FAILED:'异常任务',SUCCESS:'已完成任务'}[activeFilter]||'任务');
  $('#content').innerHTML=`<div class="panel task-center-panel task-center-redesign" style="margin-top:0"><div class="panel-head task-center-head"><div><span class="panel-kicker">AUTOMATED PUBLISHING MATRIX</span><h2>发布任务</h2><p>统一任务流实时呈现发布、核验、异常与补发恢复，不再割裂成功和失败记录。</p></div><button class="btn secondary task-refresh-button" id="refreshTasks"><span>刷新</span></button></div>${taskCommandCenter(counts,current?.name||'全部平台')}${taskPlatformTabs(data.platformCounts,data.total)}<div class="task-platform-context"><b>当前查看：${esc(current?.name||"全部平台")}</b><span>执行完成不等于平台审核通过，最终状态以平台核验结果为准。</span></div>${taskStatusFilters(counts)}${taskStream(filtered,{platformScoped,emptyText:`暂无${current?.name||'当前范围'}的${filterLabel}`})}</div>`;
  presentInteractions({tasks});
  $('#refreshTasks').onclick=()=>renderTasks().catch(e=>toast(e.message,true));
  document.querySelectorAll('[data-task-platform]').forEach(button=>button.onclick=()=>{state.taskPlatform=button.dataset.taskPlatform;state.taskStatus='ALL';renderTasks().then(()=>window.scrollTo({top:0,left:0,behavior:'smooth'})).catch(e=>toast(e.message,true))});
  document.querySelectorAll('[data-task-status]').forEach(button=>button.onclick=()=>{state.taskStatus=button.dataset.taskStatus;renderTasks().catch(e=>toast(e.message,true))});
  document.querySelectorAll('[data-retry-task]').forEach(button=>button.onclick=()=>prepareTaskRetry(Number(button.dataset.retryTask),button));
  document.querySelectorAll('[data-delete-task]').forEach(button=>button.onclick=()=>deleteTask(tasks.find(task=>task.id===Number(button.dataset.deleteTask)),button));
  document.querySelectorAll('.resume-bilibili-draft').forEach(button=>button.onclick=()=>resumeBilibiliDraft(Number(button.dataset.taskId),Number(button.dataset.targetId),button));
  document.querySelectorAll('.verify-publish-target').forEach(button=>button.onclick=()=>verifyPublishTarget(Number(button.dataset.targetId),button));
  document.querySelectorAll('.open-manual-publish').forEach(button=>button.onclick=()=>openManualPublish(button.dataset.platform,button));
  document.querySelectorAll('.confirm-manual-published').forEach(button=>button.onclick=()=>confirmManualPublished(Number(button.dataset.targetId),button));
}
function messageSourceBadge(m){const simulated=m.context?.simulated===true||String(m.external_id||'').startsWith('mvp-');return simulated?'<span class="badge warning">模拟/历史联调</span>':'<span class="badge success">真实采集</span>'}
function replyStatusChip(kind,status={}){const ai=kind==='ai';const stateName=status.state||'NOT_REPLIED';const label=ai?({REPLIED:'AI已回复',QUEUED:'AI待发送',SENDING:'AI发送中',PROCESSING:'AI处理中',FAILED:'AI回复失败',NOT_REPLIED:'AI未回复'}[stateName]||'AI未回复'):({REPLIED:'人工已回复',QUEUED:'人工待发送',SENDING:'人工发送中',PROCESSING:'人工处理中',FAILED:'人工回复失败',PENDING:'待人工回复',NOT_REPLIED:'人工未回复'}[stateName]||'人工未回复');return `<span class="reply-status-chip ${ai?'ai':'manual'} ${String(stateName).toLowerCase()}"><i></i>${label}</span>`}
function messageReplyBadges(m){return m.reply_status?.platform?.replied?'<span class="reply-status-chip platform detected"><i></i>平台已有回复</span>':`${replyStatusChip('ai',m.reply_status?.ai)}${replyStatusChip('manual',m.reply_status?.manual)}${badge(m.status)}`}
function hasPreciseWeiboReplySource(m){const c=m.context||{};if(m.platform_code!=='weibo'||c.historical===true||c.sourceVerified!==true)return false;if(m.message_type==='COMMENT')return Boolean(String(c.commentId||'').trim());if(m.message_type==='PRIVATE_MESSAGE')return c.previewOnly!==true&&Boolean(String(c.messageId||'').trim())&&String(c.direction||'').toLowerCase()==='incoming'&&c.chatTitleVerified===true;return false}
function messageActions(m){const simulated=m.context?.simulated===true||String(m.external_id||'').startsWith('mvp-');const ignored=['IGNORED_SELF','IGNORED_OFFICIAL'].includes(m.status);const official=m.context?.officialSource===true||m.status==='IGNORED_OFFICIAL';const pendingManual=['MANUAL_REQUIRED','KNOWLEDGE_GAP'].includes(m.status)&&!m.handled_at;const manualProcessing=m.reply_status?.manual?.state==='PROCESSING'||['REPLY_QUEUED','REPLY_RUNNING'].includes(m.status);const canManualReply=pendingManual&&!simulated&&!official&&!manualProcessing&&hasPreciseWeiboReplySource(m);const deleteBlocked=m.status==='REPLY_RUNNING';return `<div class="section-actions">${m.external_url?`<button class="btn secondary open-message" data-url="${esc(m.external_url)}">打开原消息</button>`:''}${canManualReply?`<button class="btn manual-reply" data-id="${m.id}">人工回复</button>`:''}${pendingManual&&!simulated?`<button class="btn secondary detect-manual" data-id="${m.id}">检测App人工回复</button>`:''}${!m.handled_at&&!ignored?`<button class="btn secondary mark-handled" data-id="${m.id}">人工已处理</button>`:''}${pendingManual?`<button class="btn secondary retry-message" data-id="${m.id}">重新判断</button>`:''}<button class="btn secondary delete-message" data-id="${m.id}" ${deleteBlocked?'disabled title="回复正在发送中，完成后才能删除"':''}>删除</button></div>`}
function aiTimeoutNoticeStatus(m){
  return ({SENT:'已通知人工',PENDING:'正在通知人工',FAILED:'人工通知发送失败',SIMULATED:'未配置企微，仅在 Web 记录'}[String(m.wecom_notification_status||'').toUpperCase()]||'等待通知人工');
}
function aiTimeoutAlert(m){
  if(m.decision!=='AI_REPLY_TIMEOUT')return '';
  return `<div class="ai-timeout-alert"><span class="ai-timeout-alert-icon">!</span><div><b>AI回复超时</b><span>需要人工处理 · ${esc(aiTimeoutNoticeStatus(m))}</span></div></div>`;
}
function messageDecisionDetail(m){const platformReply=m.reply_status?.platform?.replied;const platformNote='已检测到平台回复，发送方式未确认；为避免重复，未再次发送。';return `${aiTimeoutAlert(m)}<div class="message-decision-detail"><span>处理结果：${esc(platformReply?'平台已有回复':statusName(m.decision||m.status))}</span><span>置信度：${m.confidence??'—'}</span><span>知识：${m.knowledge_id?'#'+m.knowledge_id:'—'}</span>${m.reason?`<span class="wide">原因：${esc(platformReply?platformNote:m.decision==='AI_REPLY_TIMEOUT'?'AI回复超时':statusName(m.reason))}</span>`:''}${m.reply_text?`<span class="wide">${platformReply?'平台回复内容':'AI回复内容'}：${esc(m.reply_text)}</span>`:''}${m.handler_note?`<span class="wide">${platformReply?'同步记录':'人工处理记录'}：${esc(platformReply?platformNote:m.handler_note)}</span>`:''}</div>`}
function commentMessageCard(m){return `<article class="interaction-card comment-item" data-refresh-key="message:${m.id}"><div class="interaction-head"><div><span class="user-avatar">${esc(String(m.user_name||'?').trim().slice(0,1)||'?')}</span><b>${esc(cleanText(m.user_name)||'未知用户')}</b></div><time>${fmt(m.collected_at||m.created_at)}</time></div><div class="message-content"><span class="content-label">评论内容</span><p>${esc(m.content)}</p></div><div class="reply-status-row">${replyStatusChip('ai',m.reply_status?.ai)}${replyStatusChip('manual',m.reply_status?.manual)}${badge(m.status)}${messageSourceBadge(m)}</div>${messageDecisionDetail(m)}${messageActions(m)}</article>`}
function privateMessageCard(m){return `<article class="interaction-card private-item" data-refresh-key="message:${m.id}"><div class="interaction-head"><div><span class="user-avatar private">${esc(String(m.user_name||'?').trim().slice(0,1)||'?')}</span><span><b>${esc(cleanText(m.user_name)||'未知用户')}</b><small>${esc(m.platform_name)} · ${esc(m.account_name)}</small></span></div><time>${fmt(m.collected_at||m.created_at)}</time></div><div class="message-content private-content"><span class="content-label">私信内容</span><p>${esc(m.content)}</p></div><div class="reply-status-row">${messageReplyBadges(m)}${messageSourceBadge(m)}</div>${messageDecisionDetail(m)}${messageActions(m)}</article>`}
function commentPostPublishedTimestamp(value){
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const text=String(value).trim().replace(/^(?:发布于|发布时间[：:]?)\s*/,'');
  if(/^\d{10}$|^\d{13}$/.test(text)){
    const timestamp=Number(text)*(text.length===10?1000:1);
    return Number.isFinite(new Date(timestamp).getTime())?timestamp:null;
  }
  const local=text.match(/^(\d{4})(?:年|[/.\-])(\d{1,2})(?:月|[/.\-])(\d{1,2})日?(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(local){
    const [,year,month,day,hour='0',minute='0',second='0']=local;
    const date=new Date(Number(year),Number(month)-1,Number(day),Number(hour),Number(minute),Number(second));
    return date.getFullYear()===Number(year)&&date.getMonth()===Number(month)-1&&date.getDate()===Number(day)&&date.getHours()===Number(hour)&&date.getMinutes()===Number(minute)&&date.getSeconds()===Number(second)?date.getTime():null;
  }
  const timestamp=Date.parse(text);
  return Number.isFinite(timestamp)?timestamp:null;
}
function commentPostReadPosition(key){
  let position=commentPostReadPositions.get(key)||0;
  try{
    const saved=Number(localStorage.getItem(commentPostReadStoragePrefix+key));
    if(Number.isSafeInteger(saved)&&saved>position)position=saved;
  }catch{}
  commentPostReadPositions.set(key,position);
  return position;
}
function commentMessageSequence(message){const id=Number(message.id);return Number.isSafeInteger(id)&&id>0?id:0}
function unreadCommentCount(group){const position=commentPostReadPosition(group.key);return group.items.filter(message=>commentMessageSequence(message)>position).length}
function markCommentPostRead(group){
  const position=Math.max(commentPostReadPosition(group.key),...group.items.map(commentMessageSequence));
  commentPostReadPositions.set(group.key,position);
  try{localStorage.setItem(commentPostReadStoragePrefix+group.key,String(position))}catch{}
}
function commentPostGroup(group){
  const post=group.post||{};
  const title=post.title||'未识别关联帖子';
  const aiCount=group.items.filter(m=>m.reply_status?.ai?.replied).length;
  const manualCount=group.items.filter(m=>m.reply_status?.manual?.replied).length;
  const pendingCount=group.items.filter(m=>['MANUAL_REQUIRED','KNOWLEDGE_GAP'].includes(m.status)&&!m.reply_status?.manual?.replied).length;
  const unread=unreadCommentCount(group);
  const published=group.publishedAtMs===null?'发布时间暂未获取':('发布于 '+fmt(group.publishedAtMs));
  return `<details class="comment-post-group" data-comment-post="${esc(group.key)}" data-refresh-key="post:${esc(group.key)}" ${expandedCommentPosts.has(group.key)?'open':''}>
    <summary class="comment-post-head comment-post-toggle"><span class="post-icon" aria-hidden="true">帖</span><span class="comment-post-title" title="${esc(title)}">${esc(title)}</span><span class="comment-post-controls">${unread?`<span class="comment-unread-count" aria-live="polite">新增评论 <b>${unread}</b></span>`:''}<span class="comment-post-chevron" aria-hidden="true"></span></span></summary>
    <div class="comment-post-body"><div class="comment-post-meta"><div class="post-info"><div class="post-title-row">${post.matched?'<span class="badge success">已匹配发布记录</span>':'<span class="badge warning">待确认帖子</span>'}</div><p>${esc(group.items[0]?.platform_name||'')} · ${esc(group.items[0]?.account_name||'')} · ${esc(published)}</p><div class="post-summary"><span>评论 ${group.items.length}</span><span>AI已回复 ${aiCount}</span><span>人工已回复 ${manualCount}</span>${pendingCount?`<span class="pending">待人工 ${pendingCount}</span>`:''}</div></div>${post.url?`<button class="btn secondary open-message" data-url="${esc(post.url)}">打开帖子</button>`:''}</div><div class="comment-items">${group.items.map(commentMessageCard).join('')}</div></div>
  </details>`;
}
/* 每个帖子分组只绑定一次；展开时读取最新一次渲染的分组数据（后台刷新原位合并后节点不变）。 */
const boundCommentPostGroups=new WeakSet();
let latestCommentGroupsByKey=new Map();
function bindCommentPostGroups(groups){
  latestCommentGroupsByKey=new Map(groups.map(group=>[group.key,group]));
  document.querySelectorAll('details[data-comment-post]').forEach(details=>{
    if(boundCommentPostGroups.has(details))return;
    boundCommentPostGroups.add(details);
    let wasOpen=details.open;
    details.addEventListener('toggle',()=>{
      if(!details.isConnected||details.open===wasOpen)return;
      wasOpen=details.open;
      const key=details.dataset.commentPost;
      if(details.open){
        expandedCommentPosts.add(key);
        const group=latestCommentGroupsByKey.get(key);
        if(group)markCommentPostRead(group);
        details.querySelector('.comment-unread-count')?.remove();
      }else expandedCommentPosts.delete(key);
    });
  });
}
function groupCommentsByPost(comments){
  const groups=new Map();
  for(const message of comments){
    const post=message.post||{};
    const key=JSON.stringify([String(message.platform_code||message.platform_name||''),String(message.account_id??message.account_name??''),String(post.key||post.id||post.url||post.title||message.parent_external_id||'UNMATCHED_POST')]);
    const publishedAtMs=commentPostPublishedTimestamp(post.publishedAt);
    if(!groups.has(key))groups.set(key,{key,post:{...post},publishedAtMs,items:[]});
    const group=groups.get(key);
    for(const field of ['id','url','title'])if(!group.post[field]&&post[field])group.post[field]=post[field];
    if(group.publishedAtMs===null&&publishedAtMs!==null){group.publishedAtMs=publishedAtMs;group.post.publishedAt=post.publishedAt}
    group.post.matched=group.post.matched||post.matched;
    group.items.push(message);
  }
  return [...groups.values()].sort((a,b)=>((b.publishedAtMs??-Infinity)-(a.publishedAtMs??-Infinity))||a.key.localeCompare(b.key,'zh-CN'));
}

function messageRefreshSignature(data){
  return JSON.stringify({
    messages:(data?.messages||[]).map(message=>[
      message.id,message.external_id,message.content,message.collected_at,message.updated_at,
      message.platform_code,message.account_id,message.post?.key,message.post?.id,
      message.post?.title,message.post?.url,message.post?.publishedAt,message.post?.matched,
      message.status,message.decision,message.reason,message.reply_text,message.handled_at,
      message.handled_by,message.handler_note,message.reply_job_id,
      message.wecom_notification_status,message.wecom_notification_id,
      message.reply_status?.ai?.state,message.reply_status?.manual?.state,message.reply_status?.platform?.state
    ]),
    channelRuntimeStates:(data?.channelRuntimeStates||[]).map(runtime=>[
      runtime.platform_code,runtime.account_id,runtime.channel_type,runtime.state,
      runtime.consecutive_failures,runtime.last_scan_started_at,runtime.last_scan_completed_at,
      runtime.last_success_at,runtime.last_error_code,runtime.last_error_message,
      runtime.active_job_id,runtime.active_job_status,runtime.updated_at
    ])
  });
}
const collectionTerminalStatuses=new Set(['SUCCESS','PARTIAL_SUCCESS','FAILED','NEEDS_CONFIRMATION','CANCELLED']);
function normalizedCollectionJobIds(jobIds){return [...new Set((Array.isArray(jobIds)?jobIds:[jobIds]).map(Number).filter(id=>Number.isInteger(id)&&id>0))]}
async function waitForCollectionJobs(jobIds, timeoutMs=120000){
  const ids=normalizedCollectionJobIds(jobIds);
  if(!ids.length)throw new Error('采集接口没有返回有效的任务编号');
  const deadline=Date.now()+timeoutMs;
  const completed=new Map();
  while(Date.now()<deadline&&completed.size<ids.length){
    const pendingIds=ids.filter(id=>!completed.has(id));
    const results=await Promise.all(pendingIds.map(async id=>{
      const data=await api(`/api/jobs/${encodeURIComponent(id)}?t=${Date.now()}`);
      return [id,data.job||{}];
    }));
    for(const [id,job] of results){
      if(collectionTerminalStatuses.has(String(job.status||'').toUpperCase()))completed.set(id,job);
    }
    if(completed.size<ids.length)await new Promise(resolve=>setTimeout(resolve,2000));
  }
  const unfinished=ids.filter(id=>!completed.has(id));
  if(unfinished.length)throw new Error(`采集任务执行超时，仍未结束的任务：${unfinished.map(id=>`Job#${id}`).join('、')}。请到任务中心查看状态`);
  return ids.map(id=>completed.get(id));
}
function collectionJobChannelLabel(job,index,total){const channel=String(job?.channel_type||job?.queue_lane||'').toUpperCase();if(channel==='PRIVATE_MESSAGE')return '私信';if(channel==='COMMENT')return '评论';return total===1?'私信和评论':`通道${index+1}`}
function messageChannelRuntime(data,account,channelType){return (data?.channelRuntimeStates||[]).find(item=>Number(item.account_id)===Number(account?.id)&&item.platform_code===account?.platform_code&&item.channel_type===channelType)||null}
function messageChannelPresentation(runtime,label,hasItems){
  if(!runtime)return {banner:'',empty:`<div class="empty">${hasItems?'':`尚未完成首次${label}采集，当前不能确认平台上是否有新${label}。`}</div>`};
  const runtimeState=String(runtime.state||'').toUpperCase();
  const completedText=runtime.last_scan_completed_at?` · ${fmt(runtime.last_scan_completed_at)}`:'';
  if(['QUEUED','RUNNING'].includes(runtimeState))return {banner:`<div class="message-sync-state running"><b>${label}正在同步</b><span>${runtime.active_job_id?`Job#${runtime.active_job_id} `:''}${runtimeState==='QUEUED'?'等待执行':'正在执行'}，结束前不要把当前列表当作完整结果。</span></div>`,empty:`<div class="empty">${label}正在同步，请等待采集任务结束。</div>`};
  if(runtimeState==='ERROR'){
    const detail=cleanText(runtime.last_error_message||runtime.last_error_code||'采集未完成');
    return {banner:`<div class="message-sync-state error"><b>最近一次${label}同步失败${completedText}</b><span>${esc(detail)}。当前列表可能不完整，请重新采集或到任务中心查看。</span></div>`,empty:`<div class="empty danger">无法确认当前是否没有${label}：最近一次同步失败。</div>`};
  }
  if(runtimeState==='DEGRADED'){
    const detail=cleanText(runtime.last_error_message||runtime.last_error_code||'部分区域未可靠完成');
    return {banner:`<div class="message-sync-state degraded"><b>最近一次${label}同步不完整${completedText}</b><span>${esc(detail)}。已显示采集成功的部分，其余请重新采集或人工核对。</span></div>`,empty:`<div class="empty danger">${label}同步不完整，不能把空列表当作平台没有消息。</div>`};
  }
  return {banner:'',empty:`<div class="empty">同步完成，当前暂无${label}。</div>`};
}
function messageChannelPollCard({label,channelType,runtime,nextCollectionAt}) {
  const rawState=String(runtime?.state||'IDLE').toUpperCase();
  const hasHistory=Boolean(runtime?.last_scan_completed_at||runtime?.last_success_at||runtime?.last_scan_started_at);
  // 采集任务完成后运行态会回到 IDLE，但这不代表从未采集过；避免页面一直显示“等待首次采集”。
  const stateName=rawState==='IDLE'&&hasHistory?'WAITING_NEXT':rawState;
  const stateMap={QUEUED:['等待执行','queued'],RUNNING:['扫描中','running'],SUCCESS:['同步正常','success'],DEGRADED:['部分完成','degraded'],FAILED:['同步异常','error'],ERROR:['同步异常','error'],WAITING_NEXT:['等待下轮','idle'],IDLE:['等待首次采集','idle']};
  const [stateLabel,stateClass]=stateMap[stateName]||['状态监测中','idle'];
  const lastScan=runtime?.last_scan_completed_at||runtime?.last_success_at||runtime?.last_scan_started_at;
  const result=runtime?.last_result||{};
  const count=Number(result.messageCount);
  const resultText=Number.isFinite(count)?`本轮新增 ${count} 条`:'等待本轮结果';
  const nextText=nextCollectionAt?`下轮预计：${fmt(nextCollectionAt)}`:'等待调度';
  const pageLabel=channelType==='COMMENT'?'评论页面':'私信页面';
  const activeJob=runtime?.active_job_id?` · Job#${runtime.active_job_id}`:'';
  const nextAttr=nextCollectionAt?` data-next-collection-at="${esc(nextCollectionAt)}"`:'';
  return `<article class="message-channel-poll-card ${stateClass}"><div class="message-channel-poll-head"><div><span class="message-channel-poll-icon">${channelType==='COMMENT'?'评':'信'}</span><b>${label}采集</b></div><span class="message-channel-poll-state"><i></i>${stateLabel}${activeJob}</span></div><div class="message-channel-poll-meta"><span>页面：<b>${pageLabel}</b></span><span>${resultText}</span></div><div class="message-channel-poll-times"><span>上次：${lastScan?fmt(lastScan):'尚未执行'}</span><span class="message-channel-poll-next"${nextAttr}>${nextText}</span></div></article>`;
}
function updateMessageChannelCountdowns(){
  document.querySelectorAll('.message-channel-poll-next[data-next-collection-at]').forEach(element=>{
    const target=Date.parse(element.dataset.nextCollectionAt||'');
    if(!Number.isFinite(target))return;
    const remaining=Math.max(0,target-Date.now());
    if(remaining<=0){element.textContent='下轮即将开始';return}
    const totalSeconds=Math.ceil(remaining/1000);
    const minutes=Math.floor(totalSeconds/60);
    const seconds=String(totalSeconds%60).padStart(2,'0');
    element.textContent=minutes?`下轮预计：${minutes}分${seconds}秒后`:`下轮预计：${seconds}秒后`;
  });
}
const miniProgramFilters=[
  ['ALL','全部'],
  ['PROCESSING','AI 处理中'],
  ['CALLBACK_PENDING','回复待发送'],
  ['HANDOFF_PENDING','转人工通知中'],
  ['HUMAN_MANAGED','已转人工'],
  ['ERROR','异常']
];
const miniProgramStatusLabels=Object.freeze({
  conversation:Object.freeze({BOT_ACTIVE:'AI 服务中',HANDOFF_PENDING:'转人工通知中',HUMAN_MANAGED:'已转人工',UNKNOWN:'未知状态'}),
  processing:Object.freeze({PENDING:'待处理',RUNNING:'处理中',RETRY_WAIT:'等待重试',COMPLETED:'处理完成',FAILED:'处理失败',UNKNOWN:'未知状态'}),
  callback:Object.freeze({PENDING:'等待发送',SENDING:'发送中',RETRY_WAIT:'等待重试',NOT_CONFIGURED:'未配置回调',FAILED:'发送失败',SENT:'已发送',CANCELLED:'已取消',UNKNOWN:'未知状态'}),
  notification:Object.freeze({PENDING:'等待通知',SENDING:'通知中',RETRY_WAIT:'等待重试',FAILED:'通知失败',SENT:'已通知',CONFIRMED:'已确认',UNKNOWN:'未知状态'}),
  message:Object.freeze({NEW:'新消息',REPLY_QUEUED:'待发送',REPLY_RUNNING:'发送中',AUTO_REPLIED:'已自动回复',MANUAL_REQUIRED:'需人工处理',MANUAL_HANDLED:'人工已处理',CLOSED:'已关闭',SUPERSEDED:'已被新消息替代',UNKNOWN:'未知状态'}),
  decision:Object.freeze({AUTO_REPLY:'高可信自动回复',AUTO_REPLY_PARTIAL_KNOWLEDGE:'部分问题已回复，仍有问题待确认',SMALL_TALK:'闲聊回复',GREETING_GUIDANCE:'问候引导',KNOWLEDGE_GAP_GUIDANCE:'知识库未命中，正在引导用户补充',SIMPLE_GREETING:'简单问候',ROUTER_IGNORED:'路由忽略',AUTO_REPLY_INELIGIBLE:'不满足自动回复条件',SUPERSEDED_BY_NEW_MESSAGE:'新消息已到达，旧回复已作废',RAG_ANSWERED:'知识库已回复',RAG_KNOWLEDGE_GAP:'知识证据不足', RAG_NEED_CLARIFICATION:'需要补充信息',RAG_CLARIFICATION_LIMIT:'引导已达上限，转人工',KNOWLEDGE_GUIDANCE_LIMIT:'引导已达上限，转人工',RAG_SERVICE_UNAVAILABLE:'知识服务不可用',HUMAN_HANDOFF:'转人工',HUMAN_FOLLOWUP_NOTIFIED:'已通知历史对接人工',HUMAN_FOLLOWUP_NOTIFICATION_PENDING:'历史人工通知中',MANUAL_HANDLED:'人工已处理',UNKNOWN:'未知状态'})
});
function miniProgramStatusMeta(value,kind='message'){
  const labels=miniProgramStatusLabels[kind]||miniProgramStatusLabels.message;
  const key=typeof value==='string'&&Object.prototype.hasOwnProperty.call(labels,value)?value:'UNKNOWN';
  return {key,label:labels[key],className:key.toLowerCase()};
}
function miniProgramStateBadge(value,kind){const meta=miniProgramStatusMeta(value,kind);return `<span class="mini-program-status is-${meta.className}"><i></i>${esc(meta.label)}</span>`}
function miniProgramRecordId(value){return Number.isSafeInteger(value)&&value>0?value:null}
function miniProgramElementId(value){if(!/^[1-9]\d*$/.test(String(value||'')))return null;return miniProgramRecordId(Number(value))}
function miniProgramCount(value){return Number.isSafeInteger(value)&&value>=0?value:0}
function miniProgramText(value,fallback=''){return typeof value==='string'&&value.trim()?value:fallback}
function miniProgramValidIsoDate(value){
  if(typeof value!=='string')return false;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match||!Number.isFinite(Date.parse(value)))return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return false;
  const zone=match[7];
  if(zone!=='Z'){const zoneHour=Number(zone.slice(1,3)),zoneMinute=Number(zone.slice(4,6));if(zoneHour>14||zoneMinute>59||(zoneHour===14&&zoneMinute!==0))return false}
  return true;
}
function miniProgramDate(value){if(!miniProgramValidIsoDate(value))return '—';return new Date(value).toLocaleString('zh-CN',{hour12:false})}
function miniProgramMessageDateValue(item){if(miniProgramValidIsoDate(item?.receivedAt))return item.receivedAt;if(miniProgramValidIsoDate(item?.sentAt))return item.sentAt;return null}
function miniProgramActionAttributes(actionKey){const pending=state.miniProgramPendingActions.has(actionKey);return ` data-action-key="${esc(actionKey)}"${pending?' disabled aria-busy="true"':''}`}
function syncMiniProgramPendingActions(){document.querySelectorAll('.mini-program-action[data-action-key]').forEach(button=>{const pending=state.miniProgramPendingActions.has(button.dataset.actionKey);button.disabled=pending;if(pending)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy')})}
function miniProgramSummaryItem(label,value,detail,tone='neutral'){return `<div class="mini-program-summary-item is-${tone}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(detail)}</small></div>`}

function miniProgramLinkMeta(connection={},transport={}){
  if(connection.loadError)return ['状态读取失败','warning',connection.loadError];
  if(!connection.configured)return ['等待配置','warning','保存完整配置后，再检查连接与协议'];
  if(connection.mode==='push')return ['外部推送模式','neutral','需要可访问本地的入口；不代表公网已联通'];
  const states={
    NOT_CONFIGURED:['等待配置','warning','填入小程序服务器的对接地址后开始连接'],
    PAUSED:['接收已暂停','neutral','不会领取新消息，已接收任务与回复继续处理'],
    STOPPED:['连接未启动','warning','请确认本地服务正常运行'],
    CONNECTING:['正在连接','neutral','本地正在向小程序服务器请求消息'],
    CONNECTED:['最近连接正常','ready','消息领取通道正常；真实回复送达请查看会话记录'],
    RETRYING:['断线重连中','danger',transport.lastError||'暂时无法连接，将自动重试']
  };
  return states[transport.state]||['等待连接','warning','尚未完成连接检查'];
}
function miniProgramConnectionPanel(connection={},transport={}){
  const c=connection;const [label,tone,description]=miniProgramLinkMeta(c,transport);
  const mode=c.mode==='push'?'push':'pull';
  return `<section class="mini-link-card" aria-label="小程序连接管理">
    <div class="mini-link-overview"><div><span class="mini-program-kicker">连接方式</span><h3>本地运行，也能接入小程序</h3><p>${mode==='pull'?'本机主动连接对方服务器，无需为这台电脑购买域名或开放端口。':'当前使用外部推送：对方需要能访问本机接口。若本机不对外开放，请改用本地主动连接。'}</p></div><span class="mini-link-badge is-${tone}" id="miniLinkState"><i></i>${esc(label)}</span></div>
    <div class="mini-link-flow"><div><span class="mini-link-step">01</span><b>小程序服务器</b><small>保存用户咨询</small></div><span class="mini-link-arrow">${mode==='pull'?'← 主动取消息':'推送消息 →'}</span><div class="is-local"><span class="mini-link-step">02</span><b>这台本地电脑</b><small>知识检索 · AI 处理</small></div><span class="mini-link-arrow">回复发送 →</span><div><span class="mini-link-step">03</span><b>小程序会话</b><small>用户收到回复</small></div></div>
    <div class="mini-link-runtime"><span id="miniLinkDescription">${esc(description)}</span><span>最近连接：<b id="miniLinkLastConnected">${miniProgramDate(transport.lastConnectedAt)}</b></span><span>待确认收件：<b id="miniLinkPending">${miniProgramCount(transport.pendingReceipts)}</b></span></div>
    <details class="mini-link-settings" ${!c.configured?'open':''}><summary><span>连接配置</span><small>${c.configured?'已保存 · 展开查看与修改':'首次接入 · 配置小程序服务器地址'}</small></summary>
      <form id="miniConnectionForm" autocomplete="off"><div class="mini-link-form-grid">
        <label>连接方式<select name="mode"><option value="pull" ${mode==='pull'?'selected':''}>本地主动连接（推荐）</option><option value="push" ${mode==='push'?'selected':''}>外部推送（兼容原接口）</option></select></label>
        <label>应用标识<input name="appId" required maxlength="128" value="${esc(c.appId||'')}" placeholder="双方约定的 appId"></label>
        <label class="mini-link-wide" id="miniGatewayField">小程序服务器对接地址<input name="gatewayUrl" type="url" value="${esc(c.gatewayUrl||'')}" placeholder="https://小程序服务器/mini-program-bridge/v1"><small>这是对方服务器的协议根地址，不是小程序页面地址，也不是本机地址。</small></label>
        <label class="mini-link-wide" id="miniCallbackField" hidden>回复回调地址<input name="callbackUrl" type="url" value="${esc(c.callbackUrl||'')}" placeholder="https://小程序服务器/接收回复路径"></label>
        <label>共享密钥<input name="sharedSecret" type="password" autocomplete="new-password" maxlength="4096" placeholder="${c.secretConfigured?'已保存；留空保留原密钥':'首次填写双方约定的随机密钥'}"><small>本地加密保存，不回显已保存的密钥。</small></label>
        <label>空闲拉取间隔（秒）<input name="pollSeconds" type="number" min="2" max="60" value="${c.pollSeconds||5}" required><small>断网自动重试，不重复处理已接收消息。</small></label>
      </div><div class="mini-link-form-footer"><label class="mini-link-switch"><input name="enabled" type="checkbox" ${c.enabled?'checked':''}>保存后接收新消息</label><button class="btn primary" type="submit">保存连接配置</button></div></form>
    </details>
    <div class="mini-link-actions"><div><b>先配置，再检查，最后联调</b><small>对方服务器需支持约定的消息领取与回复接收协议；填入普通网址不能直接接通。</small></div><div><button type="button" class="btn secondary" id="miniTestConnection" ${!c.configured||c.mode!=='pull'?'disabled':''}>检查连通性</button><button type="button" class="btn secondary" id="miniToggleConnection" ${!c.configured?'disabled':''}>${c.enabled?'暂停接收':'开始接收'}</button></div></div>
    <p id="miniConnectionFeedback" class="mini-link-feedback" role="status" aria-live="polite"></p>
  </section>`;
}
function bindMiniProgramConnection(connection){
  const form=$('#miniConnectionForm');if(!form)return;
  let dirty=false,busy=false;
  const feedback=$('#miniConnectionFeedback');
  const show=(text,error=false)=>{feedback.textContent=text;feedback.classList.toggle('is-error',error)};
  const switchMode=()=>{const pull=form.elements.mode.value==='pull';$('#miniGatewayField').hidden=!pull;$('#miniCallbackField').hidden=pull;form.elements.gatewayUrl.required=pull;form.elements.gatewayUrl.disabled=!pull;form.elements.callbackUrl.required=!pull;form.elements.callbackUrl.disabled=pull};
  switchMode();form.elements.mode.onchange=switchMode;
  form.addEventListener('input',()=>{dirty=true});form.addEventListener('change',()=>{dirty=true});
  const run=async work=>{if(busy)return;busy=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);$('#miniTestConnection').disabled=true;$('#miniToggleConnection').disabled=true;try{await work()}catch(e){show(e.message||'连接操作失败',true)}finally{busy=false;if(form.isConnected){form.querySelectorAll('button').forEach(b=>b.disabled=false);$('#miniTestConnection').disabled=!connection.configured||connection.mode!=='pull';$('#miniToggleConnection').disabled=!connection.configured}}};
  const save=async value=>{
    const page=pageRenderGeneration;
    await api('/api/mini-program/connection',{method:'POST',body:JSON.stringify(value)});
    if(state.page==='miniProgram'&&page===pageRenderGeneration){await renderMiniProgramConversations({preserveSelection:true,pageGeneration:page});const box=$('#miniConnectionFeedback');if(box)box.textContent='配置已保存。可检查连通性；检查成功不等于已完成真实消息联调。'}
  };
  form.onsubmit=event=>{event.preventDefault();run(async()=>{
    const e=form.elements;await save({mode:e.mode.value,enabled:e.enabled.checked,appId:e.appId.value.trim(),sharedSecret:e.sharedSecret.value,gatewayUrl:e.gatewayUrl.value.trim(),callbackUrl:e.callbackUrl.value.trim(),pollSeconds:Number(e.pollSeconds.value)});
  })};
  $('#miniTestConnection').onclick=()=>run(async()=>{
    if(dirty){show('配置尚未保存，请先保存再检查。',true);return}
    show('正在检查连接与协议，不会领取用户消息…');
    const data=await api('/api/mini-program/connection/test',{method:'POST',body:'{}'});
    show(data.result?.message||'检查完成');
  });
  $('#miniToggleConnection').onclick=()=>run(async()=>{
    if(dirty){show('配置尚未保存，请先保存再切换接收状态。',true);return}
    await save({mode:connection.mode,enabled:!connection.enabled,appId:connection.appId,sharedSecret:'',gatewayUrl:connection.gatewayUrl||'',callbackUrl:connection.callbackUrl||'',pollSeconds:connection.pollSeconds||5});
  });
  // Only refresh connection labels, never replace an in-progress form or conversation selection.
  const page=pageRenderGeneration;
  const timer=setInterval(async()=>{
    if(!form.isConnected||state.page!=='miniProgram'||page!==pageRenderGeneration){clearInterval(timer);return}
    if(busy||document.hidden)return;
    try{const data=await api('/api/mini-program/connection');if(!form.isConnected||busy)return;const [label,tone,description]=miniProgramLinkMeta(data.connection,data.transport);const badge=$('#miniLinkState');if(badge){badge.className=`mini-link-badge is-${tone}`;badge.textContent=label;$('#miniLinkDescription').textContent=description;$('#miniLinkLastConnected').textContent=miniProgramDate(data.transport?.lastConnectedAt);$('#miniLinkPending').textContent=miniProgramCount(data.transport?.pendingReceipts)}}catch{if(form.isConnected)show('连接状态刷新失败，请检查本地服务。',true)}
  },5000);
}

function miniProgramConversationRows(conversations=[]){
  if(!conversations.length)return '<div class="mini-program-empty"><b>暂无符合条件的会话</b><span>切换筛选或稍后刷新。</span></div>';
  return conversations.map(item=>{const id=miniProgramRecordId(item.id);return `<button type="button" class="mini-program-conversation ${state.miniProgramConversationId===id?'active':''}" data-conversation-id="${id}"><span class="mini-program-conversation-head"><span>${miniProgramStateBadge(item.handlingMode,'conversation')}</span><time>${miniProgramDate(item.lastActivityAt)}</time></span><strong>${esc(miniProgramText(item.userId,'未知用户'))}</strong><small class="mini-program-id">会话 ${esc(miniProgramText(item.conversationId,'—'))}</small><span class="mini-program-preview">${esc(miniProgramText(item.lastTextPreview,'暂无已保存文字'))}</span><span class="mini-program-conversation-foot">${item.historicalUser===true?'<em>历史人工用户</em>':'<em class="is-standard">首次咨询</em>'}${item.processingStatus?miniProgramStateBadge(item.processingStatus,'processing'):''}${item.callbackStatus?miniProgramStateBadge(item.callbackStatus,'callback'):''}${item.notificationStatus?miniProgramStateBadge(item.notificationStatus,'notification'):''}</span></button>`}).join('');
}
function miniProgramDelivery(label,value,kind){
  if(!value||typeof value!=='object'||Array.isArray(value))return `<div class="mini-program-delivery"><span>${esc(label)}</span><b>—</b><small>暂无记录</small></div>`;
  const httpStatus=Number.isSafeInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599?value.httpStatus:null;
  const error=miniProgramText(value.error);
  const detail=[`已尝试 ${miniProgramCount(value.attemptCount)} 次`,kind==='callback'&&httpStatus!==null?`HTTP ${httpStatus}`:'',value.sentAt?`发送 ${miniProgramDate(value.sentAt)}`:'',value.confirmedAt?`确认 ${miniProgramDate(value.confirmedAt)}`:''].filter(Boolean).join(' · ')||'等待状态更新';
  return `<div class="mini-program-delivery ${error?'is-error':''}"><span>${esc(label)}</span>${miniProgramStateBadge(value.status,kind)}<small>${esc(detail)}</small>${error?`<p>${esc(error)}</p>`:''}</div>`;
}
function miniProgramMessageRows(messages=[]){
  const ordered=messages.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)).map((item,index)=>{const date=miniProgramMessageDateValue(item);return {item,index,time:date===null?null:Date.parse(date)}}).sort((left,right)=>{
    if(left.time!==null&&right.time!==null)return left.time-right.time||(miniProgramRecordId(left.item.id)||0)-(miniProgramRecordId(right.item.id)||0)||left.index-right.index;
    if(left.time!==null)return -1;
    if(right.time!==null)return 1;
    return left.index-right.index;
  }).map(entry=>entry.item);
  if(!ordered.length)return '<div class="mini-program-empty"><b>该会话暂无已保存文字</b><span>转人工完成后的新消息不会继续采集。</span></div>';
  return ordered.map(item=>{
    const id=miniProgramRecordId(item.id);
    const knowledgeId=miniProgramRecordId(item.knowledgeId);
    const callbackId=miniProgramRecordId(item.callback?.id);
    const notificationId=miniProgramRecordId(item.notification?.id);
    const callbackRetry=Boolean(item.callback?.retryable===true&&callbackId!==null&&['FAILED','NOT_CONFIGURED'].includes(item.callback.status));
    const notificationRetry=Boolean(item.notification?.retryable===true&&notificationId!==null&&['FAILED','RETRY_WAIT'].includes(item.notification.status));
    const callbackKey=callbackRetry?`callback:${callbackId}`:null;
    const notificationKey=notificationRetry?`notification:${notificationId}`:null;
    const messageLabel=miniProgramText(item.messageId)||(id!==null?`#${id}`:'未编号消息');
    const messageText=miniProgramText(item.text,'—');
    const replyText=miniProgramText(item.replyText);
    const knowledgeQuestion=miniProgramText(item.knowledgeQuestionSnapshot,'未命中知识问法');
    const decision=item.decision?miniProgramStatusMeta(item.decision,'decision').label:'暂无决策';
    const actionHtml=callbackRetry||notificationRetry?`<div class="mini-program-message-actions">${callbackRetry?`<button type="button" class="btn secondary mini-program-action mini-program-retry-callback" data-callback-id="${callbackId}"${miniProgramActionAttributes(callbackKey)}>${iconSvg('tasks')}<span>重试回调</span></button>`:''}${notificationRetry?`<button type="button" class="btn secondary mini-program-action mini-program-retry-notification" data-notification-id="${notificationId}"${miniProgramActionAttributes(notificationKey)}>${iconSvg('wecom')}<span>重试企微通知</span></button>`:''}</div>`:'';
    return `<article class="mini-program-message"${id!==null?` data-message-id="${id}"`:''}><header><span>消息 ${esc(messageLabel)}</span><time>${miniProgramDate(miniProgramMessageDateValue(item))}</time></header><div class="mini-program-inbound"><span>用户文字</span><p>${esc(messageText)}</p></div>${replyText?`<div class="mini-program-ai-reply"><span>${iconSvg('messages')} AI 回复</span><p>${esc(replyText)}</p></div>`:''}<div class="mini-program-message-meta"><div><span>处理结果</span>${miniProgramStateBadge(item.status,'message')}<small>${esc(decision)}</small></div><div><span>知识命中</span><b>${knowledgeId!==null?`#${knowledgeId}`:'—'}</b><small>${esc(knowledgeQuestion)}</small></div></div><div class="mini-program-delivery-grid">${miniProgramDelivery('消息处理',item.processing,'processing')}${miniProgramDelivery('回复回调',item.callback,'callback')}${miniProgramDelivery('企微通知',item.notification,'notification')}</div>${actionHtml}</article>`;
  }).join('');
}
function miniProgramDetail(detail){
  if(!detail?.conversation||typeof detail.conversation!=='object'||Array.isArray(detail.conversation))return `<section class="mini-program-detail"><div class="mini-program-empty"><b>${detail?.notFound?'小程序记录不存在':'请选择一个会话'}</b><span>从左侧会话列表查看终止前保存的文字与送达状态。</span></div></section>`;
  const conversation=detail.conversation;
  const conversationId=miniProgramRecordId(conversation.id);
  const messages=Array.isArray(detail.messages)?detail.messages.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)):[];
  const handoffKey=conversationId!==null&&conversation.handlingMode==='BOT_ACTIVE'?`handoff:${conversationId}`:null;
  return `<section class="mini-program-detail" aria-label="小程序会话详情"><header class="mini-program-detail-head"><div><span class="mini-program-kicker">CONVERSATION DETAIL</span><h3>${esc(miniProgramText(conversation.userId,'未知用户'))}</h3><p class="mini-program-id">${esc(miniProgramText(conversation.conversationId,'—'))}</p></div><div class="mini-program-detail-state">${miniProgramStateBadge(conversation.handlingMode,'conversation')}${conversation.historicalUser===true?'<span class="mini-program-history">历史人工用户</span>':''}</div></header><div class="mini-program-detail-toolbar"><span>已保存文字 ${messages.length} 条</span>${handoffKey?`<button type="button" class="btn mini-program-action mini-program-handoff" data-conversation-id="${conversationId}"${miniProgramActionAttributes(handoffKey)}>${iconSvg('accounts')}<span>转人工</span></button>`:''}</div><div class="mini-program-message-list">${miniProgramMessageRows(messages)}</div></section>`;
}
async function loadMiniProgramData({filter,preferredConversationId,preserveSelection}){
  const [statusData,listData,linkData]=await Promise.all([api('/api/mini-program/status'),api(`/api/mini-program/conversations?status=${encodeURIComponent(filter)}&limit=200`),api('/api/mini-program/connection').catch(error=>{if(error.status===401)throw error;return {connection:{loadError:'连接配置读取失败，请刷新重试'},transport:{}}})]);
  let conversations=(Array.isArray(listData?.conversations)?listData.conversations:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&miniProgramRecordId(item.id)!==null);
  const listedSelection=conversations.find(item=>item.id===preferredConversationId)||null;
  let selectedId=listedSelection?listedSelection.id:preserveSelection&&preferredConversationId!==null?preferredConversationId:conversations[0]?.id||null;
  let detail=null;
  if(selectedId!==null){
    try{detail=await api(`/api/mini-program/conversations/${selectedId}/messages`)}
    catch(error){
      if(error.status!==404||error.code!=='MINI_PROGRAM_ADMIN_NOT_FOUND')throw error;
      // A missing record is not a filtered-out conversation; never retarget its actions.
      conversations=conversations.filter(item=>item.id!==selectedId);
      selectedId=null;
      detail={notFound:true};
    }
  }
  return {status:statusData?.status&&typeof statusData.status==='object'&&!Array.isArray(statusData.status)?statusData.status:{},conversations,detail,selectedId,connection:linkData.connection||{},transport:linkData.transport||{}};
}
async function runMiniProgramAction(button,{actionKey,pathname,body='{}',successMessage}){
  if(!button||!actionKey||state.miniProgramPendingActions.has(actionKey))return;
  state.miniProgramPendingActions.add(actionKey);syncMiniProgramPendingActions();
  let actionError=null;
  try{await api(pathname,{method:'POST',body});toast(successMessage)}catch(error){actionError=error;toast(error.message||'操作失败',true)}
  try{if(state.page==='miniProgram')await renderMiniProgramConversations({preserveSelection:true})}catch(error){if(!actionError)toast(error.message||'刷新小程序对话失败',true)}
  finally{state.miniProgramPendingActions.delete(actionKey);syncMiniProgramPendingActions()}
}
function bindMiniProgramWorkbench(){
  document.querySelectorAll('.mini-program-filter').forEach(button=>button.onclick=async()=>{if(button.dataset.filter===state.miniProgramFilter)return;state.miniProgramFilter=button.dataset.filter;try{await renderMiniProgramConversations()}catch(error){toast(error.message||'筛选会话失败',true)}});
  document.querySelectorAll('.mini-program-conversation').forEach(button=>button.onclick=async()=>{const id=miniProgramElementId(button.dataset.conversationId);if(id===null||id===state.miniProgramConversationId)return;state.miniProgramConversationId=id;try{await renderMiniProgramConversations({preserveSelection:true})}catch(error){toast(error.message||'读取会话失败',true)}});
  const refresh=$('.mini-program-refresh');if(refresh)refresh.onclick=async()=>{refresh.disabled=true;try{const rendered=await renderMiniProgramConversations({preserveSelection:true});if(rendered)toast('小程序对话已刷新')}catch(error){toast(error.message||'刷新小程序对话失败',true)}finally{if(document.body.contains(refresh))refresh.disabled=false}};
  document.querySelectorAll('.mini-program-handoff').forEach(button=>button.onclick=()=>{const id=miniProgramElementId(button.dataset.conversationId);if(id===null)return;runMiniProgramAction(button,{actionKey:`handoff:${id}`,pathname:`/api/mini-program/conversations/${id}/handoff`,body:JSON.stringify({idempotencyKey:`mini-program-handoff:${id}`}),successMessage:'已提交企微转人工通知'})});
  document.querySelectorAll('.mini-program-retry-notification').forEach(button=>button.onclick=()=>{const id=miniProgramElementId(button.dataset.notificationId);if(id===null)return;runMiniProgramAction(button,{actionKey:`notification:${id}`,pathname:`/api/mini-program/notifications/${id}/retry`,successMessage:'企微通知已重新排队'})});
  document.querySelectorAll('.mini-program-retry-callback').forEach(button=>button.onclick=()=>{const id=miniProgramElementId(button.dataset.callbackId);if(id===null)return;runMiniProgramAction(button,{actionKey:`callback:${id}`,pathname:`/api/mini-program/callbacks/${id}/retry`,successMessage:'回复回调已重新排队'})});
}
async function renderMiniProgramConversations({preserveSelection=false,pageGeneration=pageRenderGeneration}={}){
  const generation=++miniProgramRenderGeneration;
  const ownsRender=()=>generation===miniProgramRenderGeneration&&pageGeneration===pageRenderGeneration&&state.page==='miniProgram';
  const filter=miniProgramFilters.some(([value])=>value===state.miniProgramFilter)?state.miniProgramFilter:'ALL';
  const preferredConversationId=miniProgramRecordId(state.miniProgramConversationId);
  let data;
  try{data=await loadMiniProgramData({filter,preferredConversationId,preserveSelection})}
  catch(error){if(!ownsRender()||state.miniProgramFilter!==filter)return false;throw error}
  if(!ownsRender()||state.miniProgramFilter!==filter)return false;
  const {status,conversations,detail,selectedId,connection,transport}=data;
  state.miniProgramFilter=filter;
  state.miniProgramConversationId=selectedId;
  const counts=status.counts&&typeof status.counts==='object'&&!Array.isArray(status.counts)?status.counts:{};
  const processingFailed=miniProgramCount(counts.processingFailed),callbackFailed=miniProgramCount(counts.callbackFailed),notificationFailed=miniProgramCount(counts.notificationFailed);
  $('#content').innerHTML=`<section class="mini-program-page"><section class="mini-program-summary" aria-labelledby="miniProgramTitle"><header class="mini-program-summary-head"><div><span class="mini-program-kicker">小程序 · 智能咨询</span><h2 id="miniProgramTitle">小程序对话</h2><p>连接小程序服务器，在本地处理咨询，将回复送回用户。</p></div><button type="button" class="btn secondary mini-program-action mini-program-refresh" aria-label="刷新小程序对话">${iconSvg('tasks')}<span>刷新</span></button></header><div class="mini-program-summary-grid">${miniProgramSummaryItem('最近接收',status.lastReceivedAt==null?'暂无消息':miniProgramDate(status.lastReceivedAt),'仅统计本地已保存文字','neutral')}${miniProgramSummaryItem('AI 待处理',String(miniProgramCount(counts.processing)),processingFailed?`${processingFailed} 条处理异常`:'已接收消息的处理队列',processingFailed?'danger':'neutral')}${miniProgramSummaryItem('回复待发送',String(miniProgramCount(counts.callbackPending)),callbackFailed?`${callbackFailed} 条发送失败`:'以服务器确认接收为准',callbackFailed?'danger':'neutral')}${miniProgramSummaryItem('企微失败',String(notificationFailed),notificationFailed?'可在会话中重新通知':'人工通知状态正常',notificationFailed?'danger':'neutral')}</div></section>${miniProgramConnectionPanel(connection,transport)}<div class="mini-program-workbench"><section class="mini-program-list-pane" aria-label="小程序会话列表"><div class="mini-program-list-head"><div><span class="mini-program-kicker">咨询记录</span><h3>会话列表</h3></div><span>${conversations.length} 条</span></div><nav class="mini-program-filters" aria-label="小程序会话状态筛选">${miniProgramFilters.map(([value,label])=>`<button type="button" class="mini-program-filter ${state.miniProgramFilter===value?'active':''}" data-filter="${value}" aria-pressed="${state.miniProgramFilter===value}">${esc(label)}</button>`).join('')}</nav><div class="mini-program-conversation-list">${miniProgramConversationRows(conversations)}</div></section>${miniProgramDetail(detail)}</div></section>`;
  bindMiniProgramConnection(connection);
  bindMiniProgramWorkbench();
  syncMiniProgramPendingActions();
  presentInteractions();
  return true;
}
async function renderManualHandoffs(prefetchedData=null){
  const owner=capturePageOwner();
  const data=prefetchedData||await api('/api/manual-handoffs?limit=500');
  if(!ownsPageOwner(owner)||state.page!=='handoffs')return;
  const items=data.handoffs||[];
  const totalHandoffs=Number.isFinite(Number(data.totalHandoffs))?Number(data.totalHandoffs):items.length;
  const succeeded=items.filter(item=>item.handoff_succeeded).length;
  const pending=items.length-succeeded;
  const platformName=code=>state.bootstrap?.platforms?.find(item=>item.code===code)?.name||state.bootstrap?.accounts?.find(item=>item.platform_code===code)?.platform_name||code||'未知平台';
  const rowsHtml=items.map(item=>`<tr>
    <td><b>${esc(platformName(item.platform_code))}</b><small>通知 #${item.id}</small></td>
    <td><b>${esc(item.user_name||'未知用户')}</b></td>
    <td><code>${esc(item.user_id||'未识别')}</code></td>
    <td><span class="handoff-reason">${esc(cleanText(item.handoff_reason||'人工处理'))}</span></td>
    <td><div class="handoff-content">${esc(cleanText(item.conversation_content||''))}</div></td>
    <td><span class="handoff-delivery ${item.handoff_succeeded?'success':'pending'}">${item.handoff_succeeded?'已成功通知':'通知重试中'}</span><small>${fmt(item.confirmed_at||item.created_at)}</small></td>
  </tr>`).join('');
  $('#content').innerHTML=`<div class="handoff-page">
    <section class="panel handoff-summary"><div class="panel-head"><div><span class="eyebrow">HUMAN HANDOFF</span><h2>转人工记录</h2><p>企业微信明确返回成功后才显示“已成功通知”；失败或未配置会持续重试，机器人保持禁用。</p></div><button class="btn secondary" id="refreshHandoffs" type="button">刷新状态</button></div>
      <div class="handoff-metrics"><article><span>通知记录</span><b>${totalHandoffs}</b></article><article class="success"><span>已成功通知</span><b>${succeeded}</b></article><article class="pending"><span>通知重试中</span><b>${pending}</b></article></div>
    </section>
    <section class="panel handoff-table-panel"><div class="panel-head"><div><h2>人工处理明细</h2><p>人工人员收到企业微信通知后直接到对应平台查看和处理，本系统不判断是否接单。</p></div></div>
      <div class="handoff-table-wrap">${items.length?`<table><thead><tr><th>平台</th><th>用户名称</th><th>用户 ID</th><th>转人工原因</th><th>对话内容</th><th>是否成功转人工</th></tr></thead><tbody>${rowsHtml}</tbody></table>`:'<div class="empty">暂无转人工通知记录</div>'}</div>
    </section>
  </div>`;
  $('#refreshHandoffs').onclick=()=>renderManualHandoffs().catch(error=>toast(error.message,true));
}

async function renderMessages(prefetchedData=null,{background=false}={}){
  const owner=capturePageOwner();
  const data=prefetchedData||await api('/api/messages');
  if(!ownsPageOwner(owner)||state.page!=='messages')return;
  messageRefreshSignatureValue=messageRefreshSignature(data);
  const allMessages=(data.messages||[]).filter(message=>!(message.status==='SUPERSEDED'&&message.decision==='DUPLICATE_PROCESSED_MESSAGE'));
  const activeCodes=state.bootstrap?.config?.activePlatformCodes||['xiaohongshu','douyin','wechat_channels','bilibili','weibo'];
  const accounts=state.bootstrap.accounts.filter(a=>a.enabled!==0&&activeCodes.includes(a.platform_code));
  if(!accounts.some(a=>a.id===Number(state.messageAccountId))){
    state.messageAccountId=(accounts.find(a=>a.platform_code==='xiaohongshu')||accounts[0]||{}).id||null;
  }
  const selectedAccount=accounts.find(a=>a.id===Number(state.messageAccountId))||null;
  const messages=selectedAccount?allMessages.filter(m=>m.account_id===selectedAccount.id):allMessages;
  const comments=messages.filter(m=>m.message_type==='COMMENT');
  const privateMessages=messages.filter(m=>m.message_type==='PRIVATE_MESSAGE');
  const commentGroups=groupCommentsByPost(comments);
  const isComment=state.messageView!=='PRIVATE_MESSAGE';
  const activeChannelType=isComment?'COMMENT':'PRIVATE_MESSAGE';
  const activeChannelLabel=isComment?'评论':'私信';
  const activeItems=isComment?commentGroups:privateMessages;
  const activeRuntime=messageChannelRuntime(data,selectedAccount,activeChannelType);
  const syncPresentation=messageChannelPresentation(activeRuntime,activeChannelLabel,activeItems.length>0);
  const aiReplyCount=messages.filter(message=>message.reply_status?.ai?.replied).length;
  const manualReplyCount=messages.filter(message=>message.reply_status?.manual?.replied).length;
  const platformReplyCount=messages.filter(message=>message.reply_status?.platform?.replied).length;
  const manualPendingCount=messages.filter(message=>(['MANUAL_REQUIRED','KNOWLEDGE_GAP','AI_REPLY_TIMEOUT'].includes(message.status)||['MANUAL_REQUIRED','KNOWLEDGE_GAP','AI_REPLY_TIMEOUT'].includes(message.decision))&&!message.reply_status?.manual?.replied).length;
  const syncState=String(activeRuntime?.state||'IDLE').toUpperCase();
  const syncStateLabel=({RUNNING:'通道扫描中',SUCCESS:'同步正常',DEGRADED:'部分同步',FAILED:'同步异常',ERROR:'同步异常',IDLE:'等待采集'}[syncState]||'状态监测中');
  const messageListContent=isComment
    ?(commentGroups.length?commentGroups.map(commentPostGroup).join(''):syncPresentation.empty)
    :(privateMessages.length?`<div class="private-message-list">${privateMessages.map(privateMessageCard).join('')}</div>`:syncPresentation.empty);
  const listHtml=`${syncPresentation.banner}${messageListContent}`;
  const accountOptionsHtml=accounts.map(a=>`<option value="${a.id}" ${selectedAccount?.id===a.id?'selected':''}>${esc(a.platform_name)} · ${esc(a.display_name)}</option>`).join('');
  const collection=state.bootstrap?.config?.messageCollection||{};
  const pollOptions=Array.isArray(collection.options)&&collection.options.length?collection.options:[
    {value:'1-2',label:'1\uff5e2 \u5206\u949f'},{value:'2-3',label:'2\uff5e3 \u5206\u949f'},{value:'3-4',label:'3\uff5e4 \u5206\u949f'},{value:'4-5',label:'4\uff5e5 \u5206\u949f'}
  ];
  const selectedPoll=collection.value||'4-5';
  const pollOptionsHtml=pollOptions.map(option=>`<option value="${esc(option.value)}" ${option.value===selectedPoll?'selected':''}>${esc(option.label)}</option>`).join('');
  const nextCollectionText=collection.enabled===false?'\u81ea\u52a8\u91c7\u96c6\u672a\u542f\u7528':collection.nextCollectionAt?`\u4e0b\u6b21\u9884\u8ba1\u91c7\u96c6\uff1a${fmt(collection.nextCollectionAt)}`:'\u6b63\u5728\u7b49\u5f85\u4e0a\u4e00\u8f6e\u91c7\u96c6\u5b8c\u6210\u540e\u91cd\u65b0\u6392\u7a0b';
  const messageTarget=background&&$('#content .message-ops-page')?document.createElement('div'):$('#content');
  messageTarget.innerHTML=`
    <div class="message-ops-page ${isComment?'channel-comments':'channel-private'}">
      <section class="message-command-center">
        <div class="message-command-grid" aria-hidden="true"></div>
        <div class="message-command-flow" aria-hidden="true"></div>
        <div class="message-command-copy">
          <span class="message-command-eyebrow"><i></i> INTERACTION INTELLIGENCE</span>
          <h2>用户互动</h2>
          <p>查看采集与回复状态</p>
          <div class="message-command-tags">
            <span><i></i>${selectedAccount?`${esc(selectedAccount.platform_name)} · ${esc(selectedAccount.display_name)}`:'未选择平台账号'}</span>
            <span>${activeChannelLabel}通道</span>
            <span class="sync-${esc(syncState.toLowerCase())}">${esc(syncStateLabel)}</span>
          </div>
        </div>
        <div class="message-command-radar" aria-hidden="true">
          <span class="radar-ring ring-one"></span><span class="radar-ring ring-two"></span><span class="radar-ring ring-three"></span>
          <span class="radar-sweep"></span><span class="radar-core"><b>AI</b><small>LIVE</small></span>
          <span class="radar-node node-one"></span><span class="radar-node node-two"></span><span class="radar-node node-three"></span>
        </div>
        <div class="message-command-metrics">
          <div><span>消息总量</span><b>${messages.length}</b><small>当前账号数据</small></div>
          <div><span>AI 已回复</span><b>${aiReplyCount}</b><small>自动处理完成</small></div>
          <div class="is-manual ${manualPendingCount?'is-warning':''}"><span>待人工</span><b>${manualPendingCount}</b><small>需要运营接管</small></div>

        </div>
      </section>

      <div class="panel interaction-panel message-workbench" style="margin-top:16px">
        <div class="message-toolbar">
          <div class="message-toolbar-title"><span>⌁</span><div><b>采集设置</b><small></small></div></div>
          <div class="message-collection-controls">
            <button class="btn secondary message-export-open" id="exportMessages" type="button"><span aria-hidden="true">⇩</span> 导出</button>
            <label class="message-poll-control"><span>平台账号</span><select id="messageAccount" aria-label="选择采集账号">${accountOptionsHtml}</select></label>
            <label class="message-poll-control"><span>采集间隔</span><select id="messagePollInterval" aria-label="选择采集间隔">${pollOptionsHtml}</select></label>
            <button class="btn message-collect-button" id="collectMessages" ${selectedAccount?'':'disabled'}><i></i><span>立即采集</span></button>
          </div>
        </div>
        <div class="message-poll-meta"><b>采集间隔：${esc(collection.label||pollOptions.find(option=>option.value===selectedPoll)?.label||selectedPoll)}，随机执行</b><span>${esc(nextCollectionText)}</span><small>更改间隔不影响正在执行的采集。</small></div>
        <div class="message-channel-poll-grid">${messageChannelPollCard({label:'评论',channelType:'COMMENT',runtime:messageChannelRuntime(data,selectedAccount,'COMMENT'),nextCollectionAt:collection.nextCollectionAt})}${messageChannelPollCard({label:'私信',channelType:'PRIVATE_MESSAGE',runtime:messageChannelRuntime(data,selectedAccount,'PRIVATE_MESSAGE'),nextCollectionAt:collection.nextCollectionAt})}</div>
        <div class="interaction-tabs" role="tablist">
          <button type="button" class="interaction-tab ${isComment?'active':''}" data-message-view="COMMENT"><span class="interaction-tab-icon">评</span><span><b>评论</b><small>按发布帖子分类查看</small></span><em>${comments.length}</em><i class="interaction-tab-flow" aria-hidden="true"></i></button>
          <button type="button" class="interaction-tab ${!isComment?'active':''}" data-message-view="PRIVATE_MESSAGE"><span class="interaction-tab-icon private">信</span><span><b>私信</b><small>查看内容和回复状态</small></span><em>${privateMessages.length}</em><i class="interaction-tab-flow" aria-hidden="true"></i></button>
        </div>
        <details class="simulate-box" hidden><summary><span>◇</span> 添加模拟消息 <small>仅用于知识/千问决策测试</small></summary><form id="simulateForm" class="inline-form"><select name="messageType"><option value="COMMENT">评论</option><option value="PRIVATE_MESSAGE">私信</option></select><input name="userName" value="测试用户"><input name="content" placeholder="输入测试问题" required><button class="btn secondary" ${selectedAccount?'':'disabled'}>提交模拟消息</button></form></details>
        <div class="message-list-heading"><div><span class="message-list-live"><i></i> LIVE STREAM</span><b>${activeChannelLabel}消息流</b></div><small>AI 回复 ${aiReplyCount} · 人工回复 ${manualReplyCount}${platformReplyCount?` · 平台已有回复 ${platformReplyCount}`:''} · 待处理 ${manualPendingCount}</small></div>
        <div class="interaction-list">${listHtml}</div>
      </div>
    </div>`;
  if(messageTarget!==$('#content')){
    // 后台刷新：在离屏节点完成同样的展示层整理，再原位合并，避免整页重画
    applyInteractionPresentation(messageTarget,{page:state.page,messageView:state.messageView,miniProgramConversationId:state.miniProgramConversationId,messageAccountId:state.messageAccountId,messages,privateMessages});
    patchBackgroundContent($('#content'),messageTarget);
  }else presentInteractions({messages,privateMessages});
  bindCommentPostGroups(commentGroups);
  $('#messageAccount').onchange=e=>{state.messageAccountId=Number(e.target.value);renderMessages().catch(error=>toast(error.message,true))};
  $('#exportMessages').onclick=async event=>{const selected=await chooseReplyExportPlatforms(selectedAccount?.platform_code);if(!selected?.length)return;try{await downloadReplyExport(selected,event.currentTarget)}catch(error){toast(error.message,true)}};
  $('#messagePollInterval').onchange=async event=>{
    const select=event.currentTarget;select.disabled=true;
    try{
      const result=await api('/api/settings/message-collection',{method:'POST',body:JSON.stringify({interval:select.value,updatedBy:'\u8fd0\u8425\u5e2d\u4f4d'})});
      state.bootstrap.config.messageCollection=result.settings;
      state.bootstrap.config.messageCollectMinIntervalMs=result.settings.minMs;
      state.bootstrap.config.messageCollectMaxIntervalMs=result.settings.maxMs;
      toast(`\u81ea\u52a8\u91c7\u96c6\u5df2\u6539\u4e3a\u6bcf\u8f6e\u5728 ${result.settings.label} \u5185\u91cd\u65b0\u968f\u673a`);
      await renderMessages();
    }catch(error){toast(error.message,true);select.disabled=false}
  };
  $('#collectMessages').onclick=async()=>{
    if(!selectedAccount)return toast('暂无可用平台账号',true);
    const pageOwner=capturePageOwner();
    const button=$('#collectMessages');
    if(button)button.disabled=true;
    try{
      const d=await api(`/api/platforms/${encodeURIComponent(selectedAccount.platform_code)}/collect`,{method:'POST',body:JSON.stringify({accountId:selectedAccount.id})});
      const jobIds=normalizedCollectionJobIds(d.jobIds?.length?d.jobIds:[d.jobId]);
      toast(`${selectedAccount.platform_name}采集任务 ${jobIds.map(id=>`Job#${id}`).join('、')} 已创建，正在等待全部通道结束…`);
      await renderMessages();
      const jobs=await waitForCollectionJobs(jobIds);
      if(!await refreshBootstrap(pageOwner))return;
      await renderMessages();
      const summary=jobs.map((job,index)=>{
        const resultMessage=cleanText(job.result?.message||'');
        return `${collectionJobChannelLabel(job,index,jobs.length)}：${statusName(job.status)}${resultMessage?`（${resultMessage}）`:''}`;
      }).join('；');
      const allSucceeded=jobs.every(job=>String(job.status||'').toUpperCase()==='SUCCESS');
      toast(`${selectedAccount.platform_name}采集${allSucceeded?'完成':'结束'}：${summary}`,!allSucceeded);
    }catch(e){toast(e.message,true)}finally{if(button&&document.body.contains(button))button.disabled=false}
  };
  document.querySelectorAll('[data-message-view]').forEach(b=>b.onclick=()=>{state.messageView=b.dataset.messageView;renderMessages().catch(e=>toast(e.message,true))});
  $('#simulateForm').onsubmit=async e=>{
    e.preventDefault();
    if(!selectedAccount)return toast('暂无可用平台账号',true);
    const p=Object.fromEntries(new FormData(e.target));
    try{
      await api('/api/messages/simulate',{method:'POST',body:JSON.stringify({...p,platformCode:selectedAccount.platform_code,accountId:selectedAccount.id})});
      state.messageView=p.messageType;
      toast(`模拟消息已进入${selectedAccount.platform_name}决策流程`);
      renderMessages();
    }catch(err){toast(err.message,true)}
  };
  document.querySelectorAll('.open-message').forEach(b=>b.onclick=()=>window.open(b.dataset.url,'_blank'));
  document.querySelectorAll('.delete-message').forEach(b=>b.onclick=async()=>{
    const message=messages.find(item=>Number(item.id)===Number(b.dataset.id));
    if(!message)return;
    const typeLabel=message.message_type==='PRIVATE_MESSAGE'?'私信':'评论';
    const preview=cleanText(message.content).slice(0,80);
    const confirmed=await confirmDelete({
      title:`删除这条${typeLabel}记录？`,
      message:preview?`${cleanText(message.user_name)||'未知用户'}：${preview}`:'确认从系统列表中移除这条记录。',
      details:['删除后，该记录会同时从“评论与私信”列表和“导出回复记录”中隐藏。','不会删除平台上的原评论或私信，也不会清除本地去重、回复判断和审计数据。',...(!message.handled_at?['如果消息尚未处理，系统会取消排队中的回复任务并停止后续自动处理。']:[])],
      confirmLabel:'确认删除'
    });
    if(!confirmed)return;
    const originalText=b.textContent;b.disabled=true;b.textContent='删除中…';
    try{
      const result=await api(`/api/messages/${message.id}`,{method:'DELETE',body:JSON.stringify({deletedBy:'运营人员',reason:'运营人员从评论与私信页面删除，并同步从导出回复记录中隐藏'})});
      toast(result.processingClosed?'记录已删除，排队中的后续处理已停止':'记录已删除，并已从导出回复记录中隐藏');
      await renderMessages();
    }catch(error){toast(error.message,true);b.disabled=false;b.textContent=originalText}
  });
  document.querySelectorAll('.mark-handled').forEach(b=>b.onclick=async()=>{
    const platform=selectedAccount?.platform_name||'原平台';
    const note=await uiPrompt('处理说明',`已在${platform} App人工回复`,{title:'标记为人工已处理',message:'确认已在原平台 App 中人工处理这条消息。标记后系统不会再自动补发回复。',confirmLabel:'标记已处理'});
    if(note===null)return;
    await api(`/api/messages/${b.dataset.id}/handled`,{method:'POST',body:JSON.stringify({note,handledBy:'运营人员'})});
    toast('已标记人工处理，自动回复任务已禁止补发');
    renderMessages();
  });
  document.querySelectorAll('.manual-reply').forEach(b=>b.onclick=async()=>{
    const message=messages.find(item=>Number(item.id)===Number(b.dataset.id));
    const policy=data.replyLimits?.[message?.platform_code]?.[message?.message_type];
    const limit=policy?.safeMax;
    const replyText=await uiPrompt('回复内容','',{title:'人工回复',message:'输入要发送到微博的完整回复，提交后由系统代为发送。',maxLength:limit||0,required:true,confirmLabel:'发送回复'});
    if(replyText===null)return;
    const normalized=replyText.trim().normalize('NFC');
    if(!normalized)return toast('人工回复不能为空',true);
    const count=policy?.countingMode==='UTF16'?normalized.length:Array.from(normalized).length;
    if(limit&&count>limit)return toast(`人工回复不能超过 ${limit} 字符`,true);
    const originalText=b.textContent;
    b.disabled=true;b.textContent='提交中…';
    try{
      const d=await api(`/api/messages/${b.dataset.id}/manual-reply`,{method:'POST',body:JSON.stringify({replyText:normalized,handledBy:'运营人员'})});
      toast(`微博人工回复任务 Job#${d.jobId} 已创建，系统将精确定位并核验发送回执`);
      await renderMessages();
    }catch(e){toast(e.message,true);b.disabled=false;b.textContent=originalText}
  });
  document.querySelectorAll('.detect-manual').forEach(b=>b.onclick=async()=>{
    const platform=selectedAccount?.platform_name||'原平台';
    const expectedReply=await uiPrompt('已发送的回复内容','',{title:'核验 App 中的人工回复',message:`粘贴你在${platform} App 中已经发送的完整回复，系统只核验，不会再次发送。`,required:true,confirmLabel:'开始核验'});
    if(expectedReply===null)return;
    try{const d=await api(`/api/messages/${b.dataset.id}/detect-manual`,{method:'POST',body:JSON.stringify({expectedReply})});toast(`人工回复检测任务 Job#${d.jobId} 已创建`)}catch(e){toast(e.message,true)}
  });
  document.querySelectorAll('.retry-message').forEach(b=>b.onclick=async()=>{try{await api(`/api/messages/${b.dataset.id}/retry`,{method:'POST',body:'{}'});toast('消息已重新进入决策');renderMessages()}catch(e){toast(e.message,true)}});
}

async function loadRagKnowledgeData(){
  const statusData=await api('/api/rag/status');
  const rag=statusData.rag||{};
  if(!rag.enabled||!rag.configured)return {rag};
  return {rag,documentData:await api('/api/rag/files')};
}
async function renderRagKnowledge(prefetchedData=null){
  const owner=capturePageOwner();

  const data=prefetchedData||await loadRagKnowledgeData();
  if(!ownsPageOwner(owner))return;
  renderKnowledgeFiles($('#content'),{api,esc,fmt,toast,confirmDelete,data,isCurrent:()=>ownsPageOwner(owner),onRefresh:()=>renderRagKnowledge()});
}

async function renderKnowledge(prefetchedData=null){
  const owner=capturePageOwner(),view=state.knowledgeView;
  const options={api,esc,isCurrent:()=>ownsPageOwner(owner)&&state.knowledgeView===view};
  if(view==='persona')return renderAnswerProfile($('#content'),options);
  if(view==='playground')return renderRagPlayground($('#content'),options);
  return renderRagKnowledge(prefetchedData);
}
function browserJson(value,fallback={}){if(value&&typeof value==='object')return value;try{return JSON.parse(value||'')||fallback}catch{return fallback}}
function browserActionName(action){return ({HEALTH_CHECK:'连接自检',OPEN_PAGE:'打开页面',NAVIGATE:'页面导航',READ_PAGE_STATE:'读取页面状态',READ_TEXT:'读取文字',SCROLL:'滚动页面',SCREENSHOT:'保存截图',CLOSE_TAB:'关闭受管标签页',CLICK:'辅助点击',CLICK_AT:'坐标点击',SET_FILES:'准备本地文件'}[action]||action||'—')}
function browserProviderName(provider){return ({web_access_cdp:'Web Access CDP',playwright:'Playwright'}[provider]||provider||'—')}
function bindBrowserStatusPanel(){
  const panel=$('#browserStatusPanel');if(!panel)return;
  const model=browserStatusModel(state.bootstrap),owner=capturePageOwner();
  panel.dataset.browserSnapshot=JSON.stringify(model);
  bindBrowserStatus(panel,model,{onAccounts:()=>navigate('platforms'),onIssues:()=>navigate('issues')});
  const refresh=$('#browserRefresh');refresh.onclick=async()=>{refresh.disabled=true;refresh.textContent='刷新中…';try{if(await refreshBootstrap(owner))await renderBrowserControl()}catch(error){toast('状态刷新失败，请稍后重试',true)}finally{if(refresh.isConnected){refresh.disabled=false;refresh.textContent='刷新状态'}}};
}
function refreshBrowserStatusPanel(){
  const panel=$('#browserStatusPanel');if(!panel||$('#browserRefresh')?.disabled||document.querySelector('dialog.browser-repair-dialog'))return;
  const model=browserStatusModel(state.bootstrap);if(panel.dataset.browserSnapshot===JSON.stringify(model))return;
  const active=document.activeElement,helpKey=active?.dataset.browserHelp,wasRefresh=active?.id==='browserRefresh';
  const holder=document.createElement('div');holder.innerHTML=browserStatusMarkup(model);panel.replaceWith(holder.firstElementChild);bindBrowserStatusPanel();
  if(wasRefresh)$('#browserRefresh').focus();else if(helpKey)[...document.querySelectorAll('[data-browser-help]')].find(button=>button.dataset.browserHelp===helpKey)?.focus();
}
async function renderBrowserControl(){
  const owner=capturePageOwner();
  const [{browserControl:summary},{commands=[]}]=await Promise.all([api('/api/browser-control/summary'),api('/api/browser-control/commands?limit=100')]);
  if(!ownsPageOwner(owner))return;
  const platforms=state.bootstrap?.platforms||[];
  const accounts=state.bootstrap?.accounts||[];
  const platformNames=new Map(platforms.map(item=>[item.code,item.name||item.display_name||item.code]));
  const accountNames=new Map(accounts.map(item=>[Number(item.id),item.display_name||`账号 #${item.id}`]));
  const enabledPlatforms=Array.isArray(summary.enabledPlatforms)?summary.enabledPlatforms:[];
  const selectablePlatforms=(enabledPlatforms.length?platforms.filter(item=>enabledPlatforms.includes(item.code)):platforms).filter(item=>item.lifecycle_state==='ACTIVE'||item.desired_state==='RUNNING');
  const selectableCodes=new Set(selectablePlatforms.map(item=>item.code));
  const selectableAccounts=accounts.filter(item=>item.enabled!==0&&selectableCodes.has(item.platform_code));
  const devices=(state.bootstrap?.devices||[]).map(device=>({...device,browserControl:browserJson(device.browser_control_json,{})}));
  const heartbeatControl=devices.find(device=>device.status==='ONLINE'&&device.browserControl?.mode)?.browserControl||devices.find(device=>device.browserControl?.mode)?.browserControl||{};
  const mode=heartbeatControl.mode||summary.mode||'—';
  const primaryProvider=heartbeatControl.primaryProvider||summary.primaryProvider||summary.defaultProvider;
  const fallbackProvider=heartbeatControl.fallbackProvider??summary.fallbackProvider;
  const businessRouting=heartbeatControl.businessRouting||summary.businessRouting||'—';
  const platformRuntimes=Array.isArray(heartbeatControl.platformRuntimes)&&heartbeatControl.platformRuntimes.length?heartbeatControl.platformRuntimes:(Array.isArray(summary.platformRuntimes)?summary.platformRuntimes:[]);
  const runtimeByCode=new Map(platformRuntimes.map(item=>[item.platformCode||item.runtime?.platformCode,item]));
  const recentSessions=[];const sessionSeen=new Set();
  for(const command of commands){if(command.session_id&&!sessionSeen.has(command.session_id)){sessionSeen.add(command.session_id);recentSessions.push(command)}}
  /* 修复既有缺陷：WORKTREE_DIFF_20260902.patch 删除了本行定义却保留了下方 `${platformOptions}` 的使用，
     导致整页抛 ReferenceError、只显示「页面加载失败」。这里按原实现恢复。 */
  const platformOptions=selectablePlatforms.map(item=>`<option value="${esc(item.code)}">${esc(item.name||item.display_name||item.code)}</option>`).join('');
  const accountOptionsHtml=selectableAccounts.map(item=>`<option value="${item.id}" data-platform="${esc(item.platform_code)}">${esc(platformNames.get(item.platform_code)||item.platform_code)} · ${esc(item.display_name||`账号 #${item.id}`)}</option>`).join('');
  const sessionOptions=recentSessions.slice(0,20).map(item=>`<option value="${esc(item.session_id)}">#${item.id} ${esc(browserActionName(item.action))} · ${esc(statusName(item.status))}</option>`).join('');
  const deviceCards=devices.length?devices.map(device=>{const cap=device.browserControl||{};const providers=Array.isArray(cap.providers)?cap.providers:[];return `<article class="browser-device-card"><div class="browser-device-head"><span class="browser-led ${device.status==='ONLINE'?'online':'offline'}"></span><div><b>${esc(device.name||`设备 #${device.id}`)}</b><small>${esc(device.status==='ONLINE'?'Local Agent 在线':'Local Agent 离线')} · ${fmt(device.last_heartbeat)}</small></div></div><dl><div><dt>控制模式</dt><dd>${esc(cap.mode||'尚未上报')}</dd></div><div><dt>主 Provider</dt><dd>${esc(browserProviderName(cap.primaryProvider||cap.defaultProvider))}</dd></div><div><dt>正式业务路由</dt><dd>${esc(cap.businessRouting||'尚未上报')}</dd></div><div><dt>兼容 / 回退</dt><dd>${esc(cap.fallbackProvider?`${browserProviderName(cap.fallbackProvider)}（仅故障回退）`:'已关闭')}</dd></div><div><dt>Provider</dt><dd>${esc(providers.map(item=>typeof item==='string'?item:(item.name||item.code||item.provider)).filter(Boolean).join('、')||'尚未上报')}</dd></div></dl></article>`}).join(''):'<div class="empty">尚未登记 Local Agent 设备。</div>';
  const runtimeCards=enabledPlatforms.map((code,index)=>{const info=runtimeByCode.get(code)||{};const runtime=info.runtime||{};const actual=info.actual||runtime.provider||null;const started=Boolean(runtime.startedAt||runtime.connected||runtime.contextConnected);const proxyPort=runtime.proxyPort||summary.cdpProxyPort||(3456+index);const debugPort=runtime.browserDebugPort||summary.browserDebugBasePort||(9310+index);return `<article class="browser-device-card"><div class="browser-device-head"><span class="browser-led ${started?'online':'offline'}"></span><div><b>${esc(platformNames.get(code)||code)}</b><small>${started?'Web Access 隔离运行时已连接':'按需启动，当前未占用浏览器'}</small></div></div><dl><div><dt>实际 Provider</dt><dd>${esc(actual?browserProviderName(actual):'待首次业务执行')}</dd></div><div><dt>执行层</dt><dd>${esc(runtime.compatibilityLayer||'Playwright connectOverCDP')}</dd></div><div><dt>Proxy / Debug</dt><dd>${esc(`${proxyPort} / ${debugPort}`)}</dd></div><div><dt>Profile 隔离</dt><dd><span class="browser-state on">是</span></dd></div>${runtime.lastError?`<div><dt>最近错误</dt><dd class="browser-command-error">${esc(runtime.lastError.message||runtime.lastError.code)}</dd></div>`:''}</dl></article>`}).join('')||'<div class="empty">尚未配置 Web Access 平台运行时。</div>';
  const rowsHtml=commands.length?commands.map(command=>{const result=command.result||{};const requested=result.providerRequested||command.provider;const used=result.providerUsed||result.provider||command.provider;const fallback=result.fallbackUsed?` · 已回退 ${browserProviderName(used)}`:'';const reason=result.fallbackReason?.message||result.fallbackReason?.code||'';const message=command.error_message||result.message||reason||'';return `<tr><td><b>#${command.id}</b><small>${fmt(command.created_at)}</small></td><td><span>${esc(platformNames.get(command.platform_code)||command.platform_code)}</span><small>${esc(accountNames.get(Number(command.account_id))||`账号 #${command.account_id}`)}</small></td><td><b>${esc(browserActionName(command.action))}</b><small>请求 ${esc(browserProviderName(requested))} · 实际 ${esc(browserProviderName(used))}${esc(fallback)}</small></td><td><code>${esc(command.session_id||'—')}</code><button class="browser-copy-session" type="button" data-session="${esc(command.session_id||'')}" ${command.session_id?'':'disabled'}>复制</button></td><td>${badge(command.status)}${command.confirmation_required?'<small class="browser-confirm-mark">需人工确认</small>':''}</td><td><span>${esc(command.evidence_ref||result.evidenceRef||'—')}</span>${message?`<small class="browser-command-error">${esc(statusName(message))}</small>`:''}</td></tr>`}).join(''):'<tr><td colspan="6"><div class="empty">尚无浏览器控制命令。建议先执行“连接自检”和只读诊断。</div></td></tr>';
  const browserStatus=browserStatusModel(state.bootstrap);
  $('#content').innerHTML=`
    ${browserStatusMarkup(browserStatus)}
    <details id="browserMaintenance" class="preview-details browser-maintenance"><summary>维护详情</summary>
      ${summary.enabled?'':'<p class="muted">高级检查未开启，日常任务使用现有浏览器。</p>'}
      <section class="panel browser-command-panel"><div class="panel-head"><h2>高级检查</h2></div>
        <form id="browserCommandForm" class="browser-command-form">
          <fieldset ${summary.enabled?'':'disabled'}>
            <input type="hidden" name="provider" value="web_access_cdp">
            <div class="form-grid">
              <div class="field"><label>平台</label><select name="platformCode" required>${platformOptions||'<option value="">无可用平台</option>'}</select></div>
              <div class="field"><label>绑定账号</label><select name="accountId" required>${accountOptionsHtml||'<option value="">无可用账号</option>'}</select></div>
              <div class="field"><label>安全动作</label><select name="action"><option value="HEALTH_CHECK">连接自检</option><option value="OPEN_PAGE">打开平台页面</option><option value="NAVIGATE">导航到平台页面</option><option value="READ_PAGE_STATE">读取页面状态</option><option value="READ_TEXT">读取页面文字</option><option value="SCROLL">滚动页面</option><option value="SCREENSHOT">保存截图证据</option><option value="CLOSE_TAB">关闭受管标签页</option></select></div>
              <div class="field"><label>执行体系</label><input value="Web Access 主控（固定）" disabled></div>
              <div class="field full"><label>Session ID（后续命令复用已有 Session）</label><input name="sessionId" list="browserSessions" placeholder="首次连接自检/打开页面可留空"><datalist id="browserSessions">${sessionOptions}</datalist></div>
              <div class="field full browser-url-field" hidden><label>HTTPS 页面地址</label><input name="url" type="url" placeholder="必须属于所选平台的域名白名单"></div>
              <div class="field browser-selector-field" hidden><label>读取区域 Selector（可选）</label><input name="selector" placeholder="例如 main 或 .content"></div>
              <div class="field browser-scroll-field" hidden><label>滚动方式</label><select name="direction"><option value="down">向下</option><option value="up">向上</option><option value="top">回到顶部</option><option value="bottom">滚动到底部</option></select></div>
            </div>
            <div class="browser-command-submit"><small>仅供维护人员检查。</small><button class="btn" type="submit">提交命令</button></div>
          </fieldset>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>浏览器信息</h2></div><div class="browser-device-grid">${runtimeCards}</div></section>
      <section class="panel"><div class="panel-head"><h2>设备信息</h2></div><div class="browser-device-grid">${deviceCards}</div></section>
      <section class="panel"><div class="panel-head"><h2>检查记录</h2><span class="browser-command-count">排队 ${Number(summary.queued)||0} · 执行 ${Number(summary.running)||0} · 待确认 ${Number(summary.needsConfirmation)||0}</span></div>
        <div class="table-wrap browser-command-table"><table><thead><tr><th>命令</th><th>平台 / 账号</th><th>动作 / Provider</th><th>Session</th><th>状态</th><th>证据 / 说明</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      </section>
    </details>`;
  bindBrowserStatusPanel();
  const form=$('#browserCommandForm');
  const actionSelect=form?.elements.action;
  const platformSelect=form?.elements.platformCode;
  const accountSelect=form?.elements.accountId;
  const syncBrowserFields=()=>{if(!form)return;const action=actionSelect.value;$('.browser-url-field').hidden=!['OPEN_PAGE','NAVIGATE'].includes(action);$('.browser-selector-field').hidden=action!=='READ_TEXT';$('.browser-scroll-field').hidden=action!=='SCROLL';form.elements.url.required=['OPEN_PAGE','NAVIGATE'].includes(action)};
  const syncBrowserAccounts=()=>{if(!form)return;const code=platformSelect.value;const options=[...accountSelect.options];let selected=false;for(const option of options){const visible=!option.dataset.platform||option.dataset.platform===code;option.hidden=!visible;option.disabled=!visible;if(visible&&!selected){option.selected=true;selected=true}}};
  if(actionSelect){actionSelect.onchange=syncBrowserFields;syncBrowserFields()}
  if(platformSelect){platformSelect.onchange=syncBrowserAccounts;syncBrowserAccounts()}
  if(form)form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;try{const values=Object.fromEntries(new FormData(form));const params={};if(['OPEN_PAGE','NAVIGATE'].includes(values.action))params.url=values.url;if(values.action==='READ_TEXT'){params.selector=values.selector||'';params.maxChars=8000}if(values.action==='SCROLL'){params.direction=values.direction||'down';params.y=1200}const payload={platformCode:values.platformCode,accountId:Number(values.accountId),provider:'web_access_cdp',action:values.action,purpose:'DIAGNOSTIC',params,idempotencyKey:`web-console-${Date.now()}-${Math.random().toString(16).slice(2)}`};if(values.sessionId?.trim())payload.sessionId=values.sessionId.trim();const created=await api('/api/browser-control/commands',{method:'POST',body:JSON.stringify(payload)});toast(created.reused?'已复用相同 Web Access 命令':'Web Access 命令已进入安全队列');await renderBrowserControl()}catch(error){toast(error.message,true)}finally{button.disabled=false}};
  document.querySelectorAll('.browser-copy-session').forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(button.dataset.session);toast('Session ID 已复制')}catch{toast('无法复制，请手动选择 Session ID',true)}});
}

async function renderIssues(){
  const owner=capturePageOwner();
  const items=(await api('/api/issues')).issues||[];
  if(!ownsPageOwner(owner))return;
  const activeStatuses=new Set(['OPEN','DIAGNOSING','DIAGNOSED','RETRYING']);
  const cards=items.map(i=>{
    const active=activeStatuses.has(i.status);
    const block=i.active_block;
    return `<article class="issue-card"><div class="meta"><span>${badge(i.status)} <span class="badge">${esc(statusName(i.source))} / ${esc(statusName(i.category))}</span></span><span>首次 ${fmt(i.created_at)} · 最近 ${fmt(i.last_seen_at)} · ×${i.occurrences||1}</span></div>
      <p><b>${esc(i.title)}</b></p><p>${esc(cleanText(i.detail)).slice(0,1200)}</p>
      <div class="muted">关联：${esc(statusName(i.related_type))} #${esc(i.related_id||'—')}<br>阻断：${block?`${esc(statusName(block.scope))} / ${esc(statusName(block.block_key))}${block.feature?` · ${esc(statusName(block.feature))}`:''}`:'无活动阻断'}${i.screenshot_path?'<br>截图：'+esc(i.screenshot_path):''}${i.resolution?'<br>处理结果：'+esc(i.resolution):''}${i.resolved_by?`<br>处理人：${esc(i.resolved_by)} · ${fmt(i.resolved_at)}`:''}</div>
      <div class="section-actions">${active?`<button class="btn secondary manual-resolve-issue" data-id="${i.id}">人工已处理</button><button class="btn secondary false-positive-issue" data-id="${i.id}" data-type="${esc(i.related_type||'')}">误判</button>`:''}</div>
    </article>`;
  }).join('');
  $('#content').innerHTML=`<div class="panel" style="margin-top:0"><div class="panel-head"><div><h2>问题汇总</h2><p>发布、采集、回复、登录、RPA、AI 与知识库异常在此统一查看和处理。</p></div></div><div class="notice warn"><b>处理说明：</b>请核对问题关联的平台、账号与页面证据，并使用“人工已处理”或“误判”完成确认。</div><div class="card-list">${cards||'<div class="empty">当前没有系统异常。</div>'}</div></div>`;
  document.querySelectorAll('.manual-resolve-issue').forEach(button=>button.onclick=async()=>{const pageOwner=capturePageOwner();const resolution=await uiPrompt('处理结果','已人工核对并处理，软件恢复正常运行逻辑',{title:'标记问题已人工处理',confirmLabel:'确认已处理'});if(resolution===null)return;try{await api(`/api/issues/${button.dataset.id}/manual-resolve`,{method:'POST',body:JSON.stringify({resolution,resolvedBy:state.auth?.username||'管理员'})});if(!await refreshBootstrap(pageOwner))return;toast('已标记人工处理并释放本问题阻断');renderIssues()}catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true)}});
  document.querySelectorAll('.false-positive-issue').forEach(button=>button.onclick=async()=>{const pageOwner=capturePageOwner();const answer=await falsePositiveDialog(button.dataset.type);if(!answer)return;const {resolution,actualOutcome,platformUrl,platformPostId}=answer;try{await api(`/api/issues/${button.dataset.id}/false-positive`,{method:'POST',body:JSON.stringify({resolution,resolvedBy:state.auth?.username||'管理员',actualOutcome,platformUrl,platformPostId})});if(!await refreshBootstrap(pageOwner))return;toast('已标记误判并恢复本问题关联运行逻辑');renderIssues()}catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true)}});
}
const wecomNotificationCategories=[
  {key:'ALL',label:'全部'},
  {key:'RISK_MANUAL',label:'风险转人工'},
  {key:'KNOWLEDGE_GAP',label:'知识待补充'},
  {key:'TECHNICAL_MANUAL',label:'技术异常'},
  {key:'PLATFORM_LOGIN_EXPIRED',label:'账号退出登录'},
  {key:'CONFIG_TEST',label:'连接测试'},
  {key:'OTHER',label:'其他'}
];
function wecomNotificationCategory(type){return wecomNotificationCategories.some(item=>item.key===type)?type:'OTHER'}
function wecomNotificationTypeName(type){return wecomNotificationCategories.find(item=>item.key===wecomNotificationCategory(type))?.label||'其他'}
function wecomNotificationSummary(notification){
  const lines=String(notification.content||'').split(/\r?\n/).map(line=>cleanText(line)).filter(Boolean);
  if(notification.type==='CONFIG_TEST')return cleanText(notification.content||notification.title).slice(0,90);
  const field=label=>lines.find(line=>line.startsWith(`${label}：`))?.slice(label.length+1).trim()||'';
  if(notification.type==='PLATFORM_LOGIN_EXPIRED'){
    const platform=field('平台');const account=field('账号');const conclusion=field('审核结论');
    return [platform,account,conclusion].filter(Boolean).join(' · ').slice(0,150);
  }
  const platform=field('发布平台');
  const userName=field('用户名称');
  const source=field('消息来源');
  const message=field('评论内容')||field('私信内容');
  if(platform||userName||source||message)return [platform,source,userName,message].filter(Boolean).join(' · ').slice(0,150);
  const actor=lines[0]||'';
  const useful=lines.slice(1).filter(line=>!/^请(先)?到对应平台|^处理后回到 Web 端/.test(line));
  const reason=useful.find(line=>line.startsWith('原因：'));
  const legacyMessage=useful.find(line=>!line.startsWith('原因：'));
  return [actor,legacyMessage,reason].filter(Boolean).join(' · ').slice(0,150)||cleanText(notification.title).slice(0,90);
}
function renderWecomNotifications(notifications){
  const counts=notifications.reduce((result,item)=>{const category=wecomNotificationCategory(item.type);result[category]=(result[category]||0)+1;return result},{});
  const available=new Set(['ALL',...notifications.map(item=>wecomNotificationCategory(item.type))]);
  if(!available.has(state.wecomCategory))state.wecomCategory='ALL';
  const filtered=state.wecomCategory==='ALL'?notifications:notifications.filter(item=>wecomNotificationCategory(item.type)===state.wecomCategory);
  return `<div class="wecom-category-tabs" role="tablist" aria-label="通知分类">${wecomNotificationCategories.filter(item=>item.key==='ALL'||counts[item.key]).map(item=>`<button type="button" class="wecom-category-tab ${state.wecomCategory===item.key?'active':''}" data-wecom-category="${item.key}" role="tab" aria-selected="${state.wecomCategory===item.key}">${esc(item.label)}<span>${item.key==='ALL'?notifications.length:counts[item.key]||0}</span></button>`).join('')}</div>
    <div class="wecom-record-list">${filtered.length?filtered.map(notification=>`<details class="wecom-record"><summary><span class="wecom-record-main"><span class="wecom-record-badges">${badge(notification.status)}<span class="badge wecom-type-badge">${esc(wecomNotificationTypeName(notification.type))}</span></span><span class="wecom-record-summary">${esc(wecomNotificationSummary(notification))}</span></span><time>${fmt(notification.sent_at||notification.created_at)}</time><span class="wecom-record-chevron">›</span></summary><div class="wecom-record-detail"><b>${esc(notification.title)}</b><p>${esc(notification.content)}</p>${notification.error_message?`<div class="notice warn">${esc(notification.error_message)}</div>`:''}</div></details>`).join(''):'<div class="empty">该分类暂无通知记录。</div>'}</div>`;
}
function aiTaskTypeName(value){
  return ({
    SMART_REPLY:'智能回复',
    SMART_REPLY_FACT_CHECK:'回复事实核验',
    CONTENT_REVIEW:'素材合规审核',
    OCR:'图片文字识别',
    CONNECTION_TEST:'连接测试',
    KNOWLEDGE_ALIAS_GENERATION:'知识别名生成',
    KNOWLEDGE_INTENT_CLARIFICATION:'知识意图澄清',
    KNOWLEDGE_MATCH:'知识内容匹配',
    KNOWLEDGE_METADATA_RECOMMENDATION:'知识信息推荐',
    MANUAL_HANDOFF_ALIAS_GENERATION:'人工转接信息整理',
    ISSUE_DIAGNOSIS:'问题诊断',
    MATERIAL_TRAFFIC_PREDICTION:'素材潜力预测',
    MATERIAL_AUDIO_TRANSCRIPTION:'音视频转文字',
    MATERIAL_COPY_GENERATION:'素材文案生成',
    MATERIAL_KNOWLEDGE_GENERATION:'视频知识内容生成',
    UNIFIED_MODEL_CALL:'统一模型调用',
    OTHER:'其他任务'
  }[value]||'其他任务');
}
function aiSourceModuleName(value){
  return ({
    'local-agent-material-review':'本地服务 · 素材审核',
    'local-agent-material-traffic-prediction':'本地服务 · 素材潜力预测',
    'local-agent-material-copy-generation':'本地服务 · 素材文案生成',
    'local-agent-material-knowledge-generation':'本地服务 · 视频知识提取',
    'local-agent-material-audio-asr':'本地服务 · 音视频转文字',
    'local-agent-ocr':'本地服务 · 图片文字识别',
    'issue-diagnosis':'问题诊断服务',
    'ai-settings':'AI 服务配置',
    'wechat-agent':'微信客服 Agent',
    'rag-generation':'知识库答案生成',
    'wechat-robot':'微信机器人',
    'knowledge-alias':'知识别名生成服务',
    'knowledge-metadata-suggestion':'知识信息推荐服务',
    'knowledge-semantic-clarification':'知识意图澄清服务',
    'knowledge-semantic-match':'知识内容匹配服务',
    'manual-handoff-alias':'人工转接信息整理服务',
    'message-reply-grounding-verifier':'回复事实核验服务',
    'message-reply-multi':'多轮消息回复服务',
    'message-reply-smalltalk':'日常交流回复服务',
    'message-reply':'消息回复服务'
  }[value]||'系统服务模块');
}
function aiModeName(value){return value==='online'?'\u5728\u7ebf\u8c03\u7528':'\u6a21\u62df\u6a21\u5f0f'}
function aiLogStatus(value){return value==='SUCCESS'?'<span class="badge success">\u6210\u529f</span>':value==='SKIPPED'?'<span class="badge warning">\u5df2\u8df3\u8fc7</span>':'<span class="badge blocked">\u5931\u8d25</span>'}
function aiCostValue(value){
  const amount=Math.max(0,Number(value||0));
  if(amount>0&&amount<0.0001)return '< ¥0.0001';
  return `¥${amount.toLocaleString('zh-CN',{minimumFractionDigits:amount<1?4:2,maximumFractionDigits:amount<1?4:2})}`;
}
function aiDailyCallChart(daily=[]){
  const values=Array.isArray(daily)?daily:[];
  const maximum=Math.max(1,...values.map(item=>Number(item.calls||0)));
  return `<div class="ai-daily-chart" role="img" aria-label="近 ${values.length} 日 AI 每日调用量柱状图">${values.map((item,index)=>{
    const calls=Number(item.calls||0);const height=calls?Math.max(8,Math.round(calls/maximum*100)):2;
    const label=String(item.date||'').slice(5).replace('-','/');const today=index===values.length-1;
    return `<div class="ai-daily-column" title="${esc(item.date)}：${calls} 次，${Number(item.total_tokens||0).toLocaleString('zh-CN')} Token"><span class="ai-daily-count">${calls}</span><span class="ai-daily-bar-track"><i class="ai-daily-bar ${today?'is-today':''}" style="--bar-height:${height}%"></i></span><span class="ai-daily-label ${today?'is-today':''}">${today?'今日':esc(label)}</span></div>`;
  }).join('')}</div>`;
}
function aiTokenDonut(summary={}){
  const input=Number(summary.input_tokens||0);const output=Number(summary.output_tokens||0);const total=input+output;
  const inputRatio=total?Math.round(input/total*1000)/10:0;
  const donutBackground=total?`conic-gradient(#4f7cff 0 ${inputRatio}%,#35bea0 ${inputRatio}% 100%)`:'#e8edf4';
  return `<div class="ai-token-donut" style="--donut-background:${donutBackground}" role="img" aria-label="今日输入 Token ${input.toLocaleString('zh-CN')}，输出 Token ${output.toLocaleString('zh-CN')}"><div><b>${Number(summary.total_tokens||0).toLocaleString('zh-CN')}</b><span>Token</span></div></div><div class="ai-token-legend"><span><i class="input"></i>输入 <b>${input.toLocaleString('zh-CN')}</b><small>${total?inputRatio:0}%</small></span><span><i class="output"></i>输出 <b>${output.toLocaleString('zh-CN')}</b><small>${total?Math.round((100-inputRatio)*10)/10:0}%</small></span></div>`;
}
function captureSettingsDraft(form){
  if(!form)return null;
  const fields=[...form.elements].filter(field=>field.name&&!field.disabled);
  const dirty=fields.some(field=>field.tagName==='SELECT'?field.value!==([...field.options].find(option=>option.defaultSelected)?.value||field.options[0]?.value):field.value!==field.defaultValue);
  return dirty?Object.fromEntries(new FormData(form)):null;
}
function restoreSettingsDraft(form,draft){
  if(!form||!draft)return;
  for(const [name,value] of Object.entries(draft)){const field=form.elements.namedItem(name);if(field)field.value=value;}
  form.dispatchEvent(new Event('input',{bubbles:true}));
}
async function renderWecom(prefetchedData=null,changedPanel=null){
  const owner=capturePageOwner();
  const [wecomData,aiData]=prefetchedData||await Promise.all([api('/api/settings/wecom'),api('/api/settings/ai?limit=100')]);
  if(!ownsPageOwner(owner)||state.page!=='wecom')return;
  const drafts={ai:changedPanel==='ai'?null:captureSettingsDraft($('#aiSettingsForm')),wecom:changedPanel==='wecom'?null:captureSettingsDraft($('#wecomForm'))};
  const settings=wecomData.settings||{};
  const notifications=wecomData.notifications||[];
  const ai=aiData.settings||{};
  const aiConnection=aiConnectionPresentation(ai);
  $('#qwenMode').textContent=ai.mode==='mock'?'AI：模拟模式':'AI：在线模式';
  const summary=aiData.summary||{};
  const logs=aiData.logs||[];
  const daily=aiData.daily||[];
  const pricing=aiData.pricing||{};
  const modelCosts=aiData.model_costs||[];
  const sourceName={DATABASE:'\u7ba1\u7406\u9875\u9762',ENVIRONMENT:'\u73af\u5883\u53d8\u91cf',NONE:'\u672a\u914d\u7f6e'}[settings.source]||settings.source;
  const aiSourceName={DATABASE:'\u7ba1\u7406\u9875\u9762',ENVIRONMENT:'\u73af\u5883\u53d8\u91cf',NONE:'\u672a\u914d\u7f6e'}[ai.source]||ai.source;
  const tokenValue=value=>Number(value||0).toLocaleString('zh-CN');
  const aiLogRows=logs.length?logs.map(log=>`<tr><td>${fmt(log.created_at)}</td><td><b>${esc(aiTaskTypeName(log.task_type))}</b><small>${esc(log.source_module?aiSourceModuleName(log.source_module):'\u2014')}${log.task_id?` \u00b7 #${esc(log.task_id)}`:''}</small></td><td>${esc(aiModeName(log.mode))}</td><td>${esc(log.model||'\u2014')}</td><td>${aiLogStatus(log.status)}</td><td><span>${tokenValue(log.input_tokens)} / ${tokenValue(log.output_tokens)}</span><small>\u603b\u8ba1 ${tokenValue(log.total_tokens)}</small></td><td>${Number(log.duration_ms||0).toLocaleString('zh-CN')} ms</td><td class="ai-log-error">${esc(log.error_message||'\u2014')}</td></tr>`).join(''):'<tr><td colspan="8"><div class="empty">\u6682\u65e0 AI \u8c03\u7528\u65e5\u5fd7\u3002\u6a21\u62df\u6a21\u5f0f\u4e0d\u4f1a\u4f2a\u9020 Token \u6d88\u8017\u3002</div></td></tr>';
  const modelCostRows=modelCosts.filter(item=>Number(item.total_tokens||0)>0).map(item=>`<div class="ai-model-cost-row"><div><b>${esc(item.model||'未记录模型')}</b><small>${item.priced?esc(item.price_description||'按官方 Token 单价估算'):item.billing_type==='duration'?esc(item.price_description||'按音频时长计费，不纳入 Token 费用'):'当前未配置该模型 Token 单价'}</small></div><span>${item.priced?aiCostValue(item.estimated_cost_cny):item.billing_type==='duration'?'按时长计费':'未计价'}</span></div>`).join('')||'<div class="ai-model-cost-row is-empty"><div><b>今日暂无在线 Token 消耗</b><small>模拟调用或 0 Token 调用不会产生 Token 费用</small></div><span>¥0.0000</span></div>';
  $('#content').innerHTML=`
  <section class="settings-page-head wecom-settings-hero">
    <div class="settings-hero-copy">
      <span class="settings-hero-icon">${iconSvg('wecom')}</span>
      <div><span class="panel-kicker">WECOM & AI CONTROL</span><h2>模型与通知</h2><p></p></div>
    </div>
    <div class="settings-hero-status ${aiConnection.passed?'is-online':'is-standby'}"><span>AI 服务状态</span><b><i></i>${esc(aiModeName(ai.mode))}</b><small>${esc(aiConnection.label)}</small></div>
  </section>
  <section class="settings-config-flow-frame ${state.settingsConfigPanel?'is-expanded':''}" data-settings-config-frame>
    <div class="settings-config-strip" role="group" aria-label="通知与 AI 服务配置">
      <button class="settings-config-toggle wecom ${state.settingsConfigPanel==='wecom'?'active':''}" type="button" data-settings-config-toggle="wecom" aria-label="${state.settingsConfigPanel==='wecom'?'收起':'展开'}企业微信通知配置" title="企业微信通知配置" aria-expanded="${state.settingsConfigPanel==='wecom'}" aria-controls="wecomSettingsDrawer">
        <span class="settings-card-icon wecom">${iconSvg('wecom')}</span>
        <span class="settings-toggle-copy"><small>NOTIFICATION CHANNEL</small><b>企业微信通知</b><em>${settings.configured?'通知通道已连接':'等待配置通知通道'}</em></span>
        <span class="settings-toggle-status ${settings.configured?'is-ready':'is-pending'}"><i></i>${settings.configured?'正常':'待配置'}</span>
        <span class="settings-toggle-action">${state.settingsConfigPanel==='wecom'?'收起':'展开'}</span><span class="settings-toggle-chevron" aria-hidden="true">⌄</span>
      </button>
      <button class="settings-config-toggle ai ${state.settingsConfigPanel==='ai'?'active':''}" type="button" data-settings-config-toggle="ai" aria-label="${state.settingsConfigPanel==='ai'?'收起':'展开'}AI 服务配置" title="AI 服务配置" aria-expanded="${state.settingsConfigPanel==='ai'}" aria-controls="aiSettingsDrawer">
        <span class="settings-card-icon ai">AI</span>
        <span class="settings-toggle-copy"><small>AI SERVICE</small><b>AI 服务配置</b><em>${esc(aiConnection.label)}</em></span>
        <span class="settings-toggle-status ${aiConnection.tone}"><i></i>${esc(aiConnection.short)}</span>
        <span class="settings-toggle-action">${state.settingsConfigPanel==='ai'?'收起':'展开'}</span><span class="settings-toggle-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
    <div id="wecomSettingsDrawer" class="settings-config-drawer wecom-settings-drawer" ${state.settingsConfigPanel==='wecom'?'':'hidden'}>
      <div class="settings-drawer-heading"><div><span class="settings-card-eyebrow">NOTIFICATION CHANNEL</span><h2>企业微信通知</h2><p>转人工与运行异常通知</p></div>${settings.configured?badge('READY'):badge('PENDING')}</div>
      <div class="settings-status-card ${settings.configured?'is-ready':'is-warning'}">
        <span class="settings-status-dot"></span>
        <div><b>${settings.configured?'通知通道已连接':'等待配置通知通道'}</b><p>${settings.configured?`Webhook：<code>${esc(settings.maskedUrl)}</code>`:'尚未填写机器人 Webhook，通知只会在系统内生成记录。'}</p><small>${settings.configured?`来源：${esc(sourceName)}${settings.updatedAt?` · 更新于 ${fmt(settings.updatedAt)}`:''}`:'未配置时会生成 SIMULATED 记录，不会实际发送到企业微信群。'}</small></div>
      </div>
      <form id="wecomForm" class="form-grid settings-form wecom-config-form">
        <label class="full settings-field"><span class="settings-field-label">机器人 Webhook 地址</span><div class="settings-input-wrap"><span class="settings-input-prefix">URL</span><input type="password" name="webhookUrl" autocomplete="new-password" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." ${settings.configured?'':'required'}></div><small>通知地址加密保存，不回显。</small></label>
        <label class="settings-field"><span class="settings-field-label">更新人</span><input name="updatedBy" value="技术部" maxlength="100" placeholder="填写配置维护人"></label>
        <div class="settings-mini-card" aria-label="Webhook 安全说明"><span>安全存储</span><b>AES-256-GCM</b><small>敏感地址加密保存，不写入普通日志</small></div>
        <div class="full button-row settings-form-actions"><button class="btn" type="submit">保存企微配置</button><button class="btn secondary" type="button" id="wecomTest" ${settings.configured?'':'disabled'}>发送测试消息</button><button class="btn danger" type="button" id="wecomClear" ${settings.source==='DATABASE'?'':'disabled'}>清除页面配置</button></div>
      </form>
    </div>
    <div id="aiSettingsDrawer" class="settings-config-drawer ai-settings-drawer" ${state.settingsConfigPanel==='ai'?'':'hidden'}>
      <div class="settings-drawer-heading"><div><span class="settings-card-eyebrow">AI SERVICE</span><h2>AI 服务配置</h2><p>配置对话、知识回复与微信客服使用的模型。</p></div>${aiConnection.passed?badge('READY'):ai.mode==='mock'?badge('SIMULATED'):badge('PENDING')}</div>
      <div class="settings-status-card ${aiConnection.tone}">
        <span class="settings-status-dot"></span>
        <div><b>${esc(aiConnection.label)}</b><p>AI Key：<code>${ai.configured?esc(ai.maskedApiKey):'未配置'}</code></p><small>来源：${esc(aiSourceName)}${ai.updatedAt?` · 更新于 ${fmt(ai.updatedAt)}`:''}</small><small>${esc(aiConnection.detail)}${ai.connectionTest?.testedAt?` · 测试于 ${fmt(ai.connectionTest.testedAt)}`:''}</small></div>
      </div>
      <form id="aiSettingsForm" class="form-grid ai-settings-grid settings-form">
        <label class="settings-field settings-select-field"><span class="settings-field-label">AI 调用模式</span><select name="mode"><option value="mock" ${ai.mode==='mock'?'selected':''}>模拟模式（不调用在线 AI）</option><option value="online" ${ai.mode==='online'?'selected':''}>在线调用</option></select></label>
        <label class="settings-field"><span class="settings-field-label">更新人</span><input name="updatedBy" value="技术部" maxlength="100" placeholder="填写配置维护人"></label>
        <div class="full ai-mode-card ${ai.mode==='online'?'is-online':'is-standby'}"><span class="ai-mode-card-icon">${ai.mode==='online'?'✓':'↗'}</span><div><b>${ai.mode==='online'?'Online 在线模式已启用':'需要使用真实 AI 能力？'}</b><p>${ai.mode==='online'?'当前会按下方模型配置进行真实调用。':'切换到 Online 模式后，确认 AI Key 与模型参数并保存。'}</p></div><button class="btn secondary" type="button" id="selectAiOnlineMode" ${ai.mode==='online'?'disabled':''}>${ai.mode==='online'?'已启用 Online 模式':'切换为 Online'}</button></div>
        <label class="full settings-field"><span class="settings-field-label">AI Key</span><div class="settings-input-wrap"><span class="settings-input-prefix">KEY</span><input type="password" name="apiKey" autocomplete="new-password" placeholder="${ai.configured?'留空表示保留当前 Key':'输入 AI Key'}"></div><small class="ai-key-status">完整 Key 不会回传页面或写入普通日志；${ai.configured?`当前仅显示 ${esc(ai.maskedApiKey)}`:'当前未配置'}。</small></label>
        <label class="full settings-field"><span class="settings-field-label">Base URL</span><div class="settings-input-wrap"><span class="settings-input-prefix">API</span><input name="baseUrl" value="${esc(ai.baseUrl||'')}" required placeholder="填写服务商提供的兼容接口地址，例如 https://api.example.com/v1"></div><small>仅向此地址查询模型。更换平台域名时需重新输入 Key，不会向其他平台试探。</small></label>
        <div class="full settings-field"><div class="button-row"><button class="btn secondary" type="button" id="aiFetchModels">获取可用模型</button></div><small id="aiModelDiscoveryStatus" role="status" aria-live="polite">填写 Key 和接口地址后获取模型；不支持列表的平台仍可手动填写。获取列表不会保存配置。</small></div>
        <label class="settings-field"><span class="settings-field-label">对话模型</span><select data-ai-model-picker="model" aria-label="选择可用对话模型" disabled><option value="">获取模型后可在此选择，也可在下方手动填写</option></select><input name="model" aria-label="手动填写对话模型 ID" value="${esc(ai.model||'')}" required placeholder="选择或手动填写模型 ID"><small>选择后仍可手动修改，保存后测试是否可调用。</small></label>
        <label class="settings-field"><span class="settings-field-label">视觉 / OCR 模型</span><select data-ai-model-picker="visionModel" aria-label="选择可用视觉模型" disabled><option value="">获取模型后可在此选择，也可在下方手动填写</option></select><input name="visionModel" aria-label="手动填写视觉模型 ID" value="${esc(ai.visionModel||'')}" required placeholder="选择或手动填写视觉模型 ID"><small>此列表不区分能力，请选择服务商明确支持图片 / OCR 的模型。</small></label>
        <details class="full"><summary>专用模型（按需配置）</summary><div class="form-grid settings-form">
          <label class="settings-field"><span class="settings-field-label">音视频转文字模型</span><input name="asrModel" value="${esc(ai.modelOverrides?.asrModel||'')}" placeholder="${esc(ai.asrModel||'local:whisper-small')}"><small>本地识别填写 local:whisper-small，无需语音 API Key。DeepSeek 接口不支持千问语音识别。</small></label>
          <label class="settings-field"><span class="settings-field-label">音视频文案模型</span><input name="contentModel" value="${esc(ai.modelOverrides?.contentModel||'')}" placeholder="留空跟随对话模型"></label>
          <label class="settings-field"><span class="settings-field-label">图片文案模型</span><input name="imageContentModel" value="${esc(ai.modelOverrides?.imageContentModel||'')}" placeholder="留空跟随对话模型"></label>
          <label class="settings-field"><span class="settings-field-label">素材潜力预测模型</span><input name="trafficPredictionModel" value="${esc(ai.modelOverrides?.trafficPredictionModel||'')}" placeholder="留空跟随对话模型"></label>
          <label class="settings-field"><span class="settings-field-label">微信知识库向量模型</span><input name="embeddingModel" value="${esc(ai.embeddingModel||'')}" placeholder="local:BAAI/bge-small-zh-v1.5"></label>
          <p class="full muted">微信原生知识库默认使用 local:BAAI/bge-small-zh-v1.5（本地 512 维向量）。改用其他向量模型时需同步机器人向量维度并重建索引。local: 模型在本机运行；在线专用模型共用上方接口和密钥，请填写服务商实际支持的模型。</p>
        </div></details>
        <small class="full" id="aiConnectionTestNote" role="status"></small>
        <div class="full button-row settings-form-actions"><button class="btn" type="submit">保存 AI 配置</button><button class="btn secondary" type="button" id="aiConnectionTest" ${ai.mode==='online'&&!ai.configured?'disabled':''}>测试对话连接</button><button class="btn danger" type="button" id="aiKeyClear" ${ai.source==='DATABASE'?'':'disabled'}>清除 AI Key</button></div>
      </form>
    </div>
  </section>
  <div class="panel ai-usage-panel">
    <div class="panel-head"><div><h2>调用记录</h2><p>费用按 Token 估算，模拟调用不计费。</p></div><span class="muted">今日 ${Number(summary.calls||0)} 次</span></div>
    <div class="ai-summary-grid"><article><span>今日调用</span><b>${Number(summary.calls||0)}</b></article><article><span>总 Token</span><b>${tokenValue(summary.total_tokens)}</b><small>输入 ${tokenValue(summary.input_tokens)} · 输出 ${tokenValue(summary.output_tokens)}</small></article><article class="cost"><span>今日 Token 估算费用</span><b>${aiCostValue(summary.estimated_cost_cny)}</b><small>${Number(summary.unpriced_tokens||0)>0?`${tokenValue(summary.unpriced_tokens)} Token 未计价`:Number(summary.non_token_billed_calls||0)>0?`${Number(summary.priced_calls||0)} 次按 Token · ${Number(summary.non_token_billed_calls||0)} 次按时长`:'已计价 Token 调用 '+Number(summary.priced_calls||0)+' 次'}</small></article><article><span>平均耗时</span><b>${Number(summary.average_duration_ms||0).toLocaleString('zh-CN')}<em> ms</em></b></article></div>
    <div class="ai-usage-visual-grid">
      <article class="ai-visual-card ai-daily-card"><div class="ai-visual-head"><div><span>DAILY CALLS</span><h3>近 7 日每日调用量</h3></div><b>${daily.reduce((sum,item)=>sum+Number(item.calls||0),0)}<small> 次</small></b></div>${aiDailyCallChart(daily)}</article>
      <article class="ai-visual-card ai-cost-card"><div class="ai-visual-head"><div><span>TODAY TOKEN COST</span><h3>今日 Token 构成与费用</h3></div><b>${aiCostValue(summary.estimated_cost_cny)}</b></div><div class="ai-cost-overview"><div class="ai-token-chart">${aiTokenDonut(summary)}</div><div class="ai-model-cost-list">${modelCostRows}</div></div>${Number(summary.unpriced_tokens||0)>0?`<div class="ai-pricing-warning">另有 ${tokenValue(summary.unpriced_tokens)} Token 因模型未匹配计价表，未计入今日费用。</div>`:''}<div class="ai-pricing-note">${esc(pricing.note||'费用为估算值，以服务商账单为准。')} <a href="${esc(pricing.source_url||'https://help.aliyun.com/zh/model-studio/model-pricing')}" target="_blank" rel="noopener noreferrer">查看官方价格</a>${pricing.checked_at?` · 本地计价表核对于 ${esc(pricing.checked_at)}`:''}</div></article>
    </div>
    <div class="table-wrap ai-log-table"><table><thead><tr><th>时间</th><th>任务类型</th><th>模式</th><th>模型</th><th>状态</th><th>Token 输入/输出</th><th>耗时</th><th>错误摘要</th></tr></thead><tbody>${aiLogRows}</tbody></table></div>
  </div>
  <section class="panel wecom-history-panel wecom-history-wide">
    <div class="panel-head"><div><span class="settings-card-eyebrow">NOTIFICATION HISTORY</span><h2>通知记录</h2><p>展开记录查看内容与结果。</p></div><span class="records-count-pill">共 ${notifications.length} 条</span></div>
    <div id="wecomNotificationRecords">${notifications.length?renderWecomNotifications(notifications):'<div class="empty">暂无企微通知记录。</div>'}</div>
  </section>`;
  const bindWecomCategoryTabs=()=>document.querySelectorAll('[data-wecom-category]').forEach(button=>button.onclick=()=>{state.wecomCategory=button.dataset.wecomCategory;$('#wecomNotificationRecords').innerHTML=renderWecomNotifications(notifications);bindWecomCategoryTabs()});
  bindWecomCategoryTabs();
  const syncSettingsConfigPanel=()=>{
    const frame=document.querySelector('[data-settings-config-frame]');
    document.querySelectorAll('[data-settings-config-toggle]').forEach(button=>{
      const open=button.dataset.settingsConfigToggle===state.settingsConfigPanel;
      button.classList.toggle('active',open);
      button.setAttribute('aria-expanded',String(open));
      const action=button.querySelector('.settings-toggle-action');
      if(action)action.textContent=open?'收起':'展开';
    });
    const activeDrawerId=state.settingsConfigPanel==='wecom'?'wecomSettingsDrawer':state.settingsConfigPanel==='ai'?'aiSettingsDrawer':'';
    document.querySelectorAll('.settings-config-drawer').forEach(drawer=>{drawer.hidden=drawer.id!==activeDrawerId});
    if(frame)frame.classList.toggle('is-expanded',Boolean(state.settingsConfigPanel));
  };
  document.querySelectorAll('[data-settings-config-toggle]').forEach(button=>button.onclick=()=>{
    const panel=button.dataset.settingsConfigToggle;
    state.settingsConfigPanel=state.settingsConfigPanel===panel?null:panel;
    state.workspacePresentation=panel==='wecom'?'notifications':'ai';
    syncSettingsConfigPanel();
    presentWorkspace();syncWorkspaceNavigation();syncNavigationHash();
  });
  syncSettingsConfigPanel();
  presentWorkspace();
  $('#wecomForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));if(!String(values.webhookUrl||'').trim())return toast('\u8bf7\u8f93\u5165\u65b0\u7684\u673a\u5668\u4eba Webhook \u5730\u5740',true);try{await api('/api/settings/wecom',{method:'POST',body:JSON.stringify(values)});toast('\u4f01\u5fae Webhook \u5df2\u5b89\u5168\u4fdd\u5b58');renderWecom(null,'wecom')}catch(error){toast(error.message,true)}};
  $('#wecomTest').onclick=async()=>{const button=$('#wecomTest');button.disabled=true;button.textContent='\u53d1\u9001\u4e2d\u2026';try{await api('/api/settings/wecom/test',{method:'POST',body:'{}'});toast('\u6d4b\u8bd5\u6d88\u606f\u53d1\u9001\u6210\u529f');renderWecom()}catch(error){toast(`${error.message}${error.detail?'\uff1a'+error.detail:''}`,true);button.disabled=false;button.textContent='\u53d1\u9001\u6d4b\u8bd5\u6d88\u606f'}};
  $('#wecomClear').onclick=async()=>{if(!await uiConfirm('\u786e\u5b9a\u6e05\u9664\u7ba1\u7406\u9875\u9762\u4fdd\u5b58\u7684\u4f01\u5fae Webhook \u5417\uff1f',{title:'清除企微 Webhook',danger:true,confirmLabel:'清除'}))return;try{await api('/api/settings/wecom/clear',{method:'POST',body:'{}'});toast('\u4f01\u5fae\u9875\u9762\u914d\u7f6e\u5df2\u6e05\u9664');renderWecom(null,'wecom')}catch(error){toast(error.message,true)}};
  $('#selectAiOnlineMode').onclick=()=>{const form=$('#aiSettingsForm'),mode=form?.querySelector('[name="mode"]'),key=form?.querySelector('[name="apiKey"]');if(mode){mode.value='online';mode.dispatchEvent(new Event('change',{bubbles:true}));}if(key&&!key.value&&ai.configured!==true)key.focus();toast(ai.configured?'已选择 Online 在线模式，请点击“保存 AI 配置”使其生效':'已选择 Online 在线模式，请填写 AI Key 后点击“保存 AI 配置”');};
  $('#aiSettingsForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await api('/api/settings/ai',{method:'POST',body:JSON.stringify(values)});toast('AI 配置已保存，天河、知识库与微信服务的后续调用将使用新配置');renderWecom(null,'ai')}catch(error){toast(error.message,true)}};
  bindAiModelSettings({form:$('#aiSettingsForm'),ai,api,toast,refresh:renderWecom});
  restoreSettingsDraft($('#aiSettingsForm'),drafts.ai);
  restoreSettingsDraft($('#wecomForm'),drafts.wecom);
  $('#aiKeyClear').onclick=async()=>{if(!await uiConfirm('\u786e\u5b9a\u6e05\u9664\u7ba1\u7406\u9875\u9762\u4fdd\u5b58\u7684 AI Key \u5417\uff1f\u5728\u7ebf\u6a21\u5f0f\u5c06\u65e0\u6cd5\u8c03\u7528 AI\u3002',{title:'清除 AI Key',danger:true,confirmLabel:'清除'}))return;try{await api('/api/settings/ai/clear-key',{method:'POST',body:'{}'});toast('AI Key \u5df2\u6e05\u9664');renderWecom(null,'ai')}catch(error){toast(error.message,true)}};
}
function renderLoginBadge(code,status,prefix='platformStatus-'){const el=document.getElementById(`${prefix}${code}`);if(!el)return;const m=loginStatusMeta(status);el.textContent=m.text;el.className=`badge ${m.cls}`;el.title=[status?.message,status?.checkedAt?`\u68c0\u67e5\u65f6\u95f4\uff1a${fmt(status.checkedAt)}`:''].filter(Boolean).join('\n')}
function dashboardPlatformLoginView(platform){const account=(state.bootstrap?.accounts||[]).find(item=>item.platform_code===platform.code);const runtime=(state.bootstrap?.platforms||[]).find(item=>item.code===platform.code);const planned=runtime?.lifecycle_state==='PLANNED';return {account,runtime,planned,meta:planned?{text:'RPA\u65b9\u6848\u89c4\u5212\u4e2d',cls:'planned'}:loginStatusMeta(accountLoginState(account)),detail:planned?'\u5e73\u53f0\u5c1a\u672a\u6b63\u5f0f\u63a5\u5165':accountLoginDetail(account)}}
function refreshDashboardLoginStatus(){if(state.page!=='dashboard'||!state.bootstrap)return;for(const platform of loginPlatforms){const view=dashboardPlatformLoginView(platform);const card=document.getElementById(`dashboardPlatformCard-${platform.code}`);const badgeEl=document.getElementById(`dashboardPlatformStatus-${platform.code}`);const detailEl=document.getElementById(`dashboardPlatformDetail-${platform.code}`);if(card)card.className=`platform-login-item${view.planned?' planned':''}`;if(badgeEl){badgeEl.textContent=view.meta.text;badgeEl.className=`badge ${view.meta.cls}`;badgeEl.title=[view.account?.login_message,view.account?.login_checked_at?`\u68c0\u67e5\u65f6\u95f4\uff1a${fmt(view.account.login_checked_at)}`:''].filter(Boolean).join('\n')}if(detailEl)detailEl.textContent=view.detail}}
let platformRuntimeSignatureValue='';
let platformActionsInFlight=0;
async function runPlatformAction(action){
  platformActionsInFlight+=1;
  try{return await action()}finally{platformActionsInFlight-=1}
}
function platformRuntimeSignature(){
  const {accounts,platforms,devices,localAgent,config}=state.bootstrap;
  return JSON.stringify({accounts,platforms,devices,localAgent,activeCodes:config.activePlatformCodes,plannedCodes:config.plannedPlatformCodes,rpaMode:config.rpaMode});
}
function refreshPlatformLoginStatus(){
  if(state.page!=='platforms'||!state.bootstrap||platformActionsInFlight||document.hidden||document.querySelector('.confirm-overlay')||messageFormHasEditingFocus())return;
  if(!$('#content .platform-runtime-grid')||platformRuntimeSignature()!==platformRuntimeSignatureValue)renderPlatformRuntimePage({background:true});
}
async function batchPlatformAction(action,button){
  const pageOwner=capturePageOwner();
  const original=button?.textContent;
  if(button){button.disabled=true;button.textContent=action==='open'?'正在打开已开启平台…':'正在检查已开启平台…'}
  try{
    const d=await agent(`/platforms/${action==='open'?'open-login':'check-login'}`,{method:'POST',body:'{}'});
    const statuses=d.statuses||{};
    if(action==='check'){
      if(!await refreshBootstrap(pageOwner))return;
      if(state.page==='platforms')renderPlatformRuntimePage();
      else if(state.page==='dashboard')renderDashboard();
    }
    if(!ownsPageOwner(pageOwner))return;
    for(const p of activeLoginPlatforms)renderLoginBadge(p.code,statuses[p.code],state.page==='dashboard'?'dashboardPlatformStatus-':'platformStatus-');
    if(action==='check'){
      const values=Object.values(statuses);const count=x=>values.filter(s=>x.includes(s.state)).length;
      toast(`\u68c0\u67e5\u5b8c\u6210\uff1a\u5df2\u767b\u5f55 ${count(['READY'])}\uff0c\u672a\u767b\u5f55 ${count(['LOGIN','EXPIRED'])}\uff0c\u9700\u9a8c\u8bc1 ${count(['VERIFY_REQUIRED'])}\uff0c\u65e0\u6cd5\u786e\u8ba4 ${count(['UNKNOWN','ERROR','UNAVAILABLE'])}`);
    }else{
      const values=Object.values(statuses);const opened=values.filter(s=>s.browser==='OPEN').length;
      toast(`\u6279\u91cf\u6253\u5f00\u7ed3\u679c\uff1a\u5df2\u6253\u5f00 ${opened}\uff0c\u672a\u80fd\u6253\u5f00 ${values.length-opened}`,opened===0);
    }
  }catch(e){if(ownsPageOwner(pageOwner))toast(e.message,true)}
  finally{if(button){button.disabled=false;button.textContent=original}}
}
async function togglePlatformAccount(accountId,enable,button){
  if(button?.disabled)return;
  const pageOwner=capturePageOwner();
  const account=(state.bootstrap?.accounts||[]).find(item=>Number(item.id)===Number(accountId));
  const name=account?.platform_name||account?.display_name||'\u5e73\u53f0\u8d26\u53f7';
  if(!enable){
    const confirmed=await confirmDelete({title:`\u505c\u7528${name}\u8d26\u53f7\uff1f`,message:'\u505c\u7528\u540e\u8be5\u8d26\u53f7\u4e0d\u518d\u53c2\u4e0e\u767b\u5f55\u68c0\u67e5\u3001\u91c7\u96c6\u6216\u4efb\u52a1\u6267\u884c\u3002',details:['\u5982\u679c\u8be5\u5e73\u53f0\u6ca1\u6709\u5176\u4ed6\u542f\u7528\u8d26\u53f7\uff0c\u5e73\u53f0\u5c06\u540c\u65f6\u505c\u6b62\u3002','Local Agent \u4f1a\u6536\u5230\u65b0\u7684\u8fd0\u884c\u95e8\u7981\uff0c\u5e76\u5173\u95ed\u8be5\u5e73\u53f0\u5df2\u6709\u7684 Browser Context\u3002'],confirmLabel:'\u786e\u8ba4\u505c\u7528'});
    if(!confirmed)return;
  }
  if(button){button.disabled=true;button.classList.add('is-loading')}
  try{
    const result=await api(`/api/accounts/${Number(accountId)}/runtime`,{method:'POST',body:JSON.stringify({enabled:enable,updatedBy:'\u8fd0\u8425\u5e2d\u4f4d'})});
    if(!await refreshBootstrap(pageOwner))return;
    if(state.page==='platforms')renderPlatformRuntimePage();
    toast(result.message||(`\u8d26\u53f7\u5df2${enable?'\u542f\u7528':'\u505c\u7528'}`));
  }catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true);if(button){button.disabled=false;button.classList.remove('is-loading')}}
}
async function togglePlatformRuntime(platformCode,enable,button){
  if(button?.disabled)return;
  const pageOwner=capturePageOwner();
  const runtime=state.bootstrap?.platforms?.find(item=>item.code===platformCode);
  const name=runtime?.name||loginPlatforms.find(item=>item.code===platformCode)?.name||platformCode;
  if(!enable){
    const details=['停止后立即不再领取新任务，排队任务保持等待。','不打开浏览器或 Profile，不执行登录检查、采集或平台任务。',Number(runtime?.running_job_count||0)>0?'已在执行的任务不强制中断，完成后安全关闭。':'当前没有运行中任务。'];
    const confirmed=await confirmDelete({title:`停止${name}？`,message:'确认关闭该平台的运行开关？',details,confirmLabel:'确认停止'});
    if(!confirmed)return;
  }
  if(button){button.disabled=true;button.classList.add('is-loading')}
  try{
    const result=await api(`/api/platforms/${platformCode}/runtime`,{method:'POST',body:JSON.stringify({enabled:enable,updatedBy:'运营席位'})});
    if(!await refreshBootstrap(pageOwner))return;
    if(state.page==='platforms')renderPlatformRuntimePage();
    const platformRunning=result.platform?.effective_state==='RUNNING';
    const taskRunning=result.platform?.task_execution_state==='RUNNING';
    if(enable){
      const issueBlocked=result.platform?.task_blocked_reason==='ACTIVE_ISSUE_BLOCK'||Number(result.platform?.active_block_count||0)>0;
      toast(taskRunning?`${name}已开启，可正常领取任务`:platformRunning&&issueBlocked?`${name}已开启，但存在关联问题阻断；请到问题汇总处理`:`${name}未能进入运行态，请检查账号登录和 Local Agent`,!taskRunning);
    }
    else toast(`${name}已停止，排队任务将等待重新开启`);
  }catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true);if(button){button.disabled=false;button.classList.remove('is-loading')}}
}
async function togglePlatformSmartReply(platformCode,enable,button){
  if(button?.disabled)return;
  const pageOwner=capturePageOwner();
  const runtime=state.bootstrap?.platforms?.find(item=>item.code===platformCode);
  const name=runtime?.name||loginPlatforms.find(item=>item.code===platformCode)?.name||platformCode;
  if(!enable){
    const confirmed=await confirmDelete({title:`\u5173\u95ed${name}\u667a\u80fd\u56de\u590d\uff1f`,message:'\u5173\u95ed\u540e\uff0c\u65b0\u8bc4\u8bba\u548c\u79c1\u4fe1\u4ecd\u53ef\u4fdd\u7559\uff0c\u4f46\u4e0d\u4f1a\u751f\u6210\u6216\u9886\u53d6\u81ea\u52a8\u56de\u590d\u4efb\u52a1\u3002',details:['\u5df2\u6392\u961f\u7684\u56de\u590d\u4efb\u52a1\u4fdd\u6301\u7b49\u5f85\uff0c\u4e0d\u4f1a\u8bef\u6807\u5931\u8d25\u3002','Local Agent\u6267\u884c\u524d\u8fd8\u4f1a\u518d\u6b21\u68c0\u67e5\uff0c\u4e0d\u4f1a\u8c03\u7528\u5e73\u53f0\u9002\u914d\u5668\u6216\u6253\u5f00\u6d4f\u89c8\u5668\u3002'],confirmLabel:'\u786e\u8ba4\u5173\u95ed'});
    if(!confirmed)return;
  }
  if(button){button.disabled=true;button.classList.add('is-loading')}
  try{
    const result=await api(`/api/platforms/${platformCode}/smart-reply`,{method:'POST',body:JSON.stringify({enabled:enable,updatedBy:'\u8fd0\u8425\u5e2d\u4f4d'})});
    if(!await refreshBootstrap(pageOwner))return;
    if(state.page==='platforms')renderPlatformRuntimePage();
    const effective=result.platform?.smart_reply_effective_state==='RUNNING';
    if(enable)toast(effective?`${name}\u667a\u80fd\u56de\u590d\u5df2\u5f00\u542f\u5e76\u8fd0\u884c`:`${name}\u667a\u80fd\u56de\u590d\u5df2\u5f00\u542f\uff0c\u5f85\u5168\u5c40\u548c\u5e73\u53f0\u8fd0\u884c\u540e\u751f\u6548`);
    else toast(`${name}\u667a\u80fd\u56de\u590d\u5df2\u5173\u95ed\uff0c\u56de\u590d\u4efb\u52a1\u5c06\u4fdd\u6301\u7b49\u5f85`);
  }catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true);if(button){button.disabled=false;button.classList.remove('is-loading')}}
}

async function startAllPlatforms(button){
  if(button?.disabled)return;
  const pageOwner=capturePageOwner();
  const activeCodes=state.bootstrap?.config?.activePlatformCodes||['xiaohongshu','douyin','wechat_channels','bilibili','weibo'];
  const platforms=state.bootstrap?.platforms||[];
  const accounts=state.bootstrap?.accounts||[];
  const alreadyEnabled=activeCodes.every(code=>{
    const runtime=platforms.find(item=>item.code===code);
    return runtime?.desired_state==='RUNNING'&&accounts.some(account=>account.platform_code===code&&account.enabled!==0);
  });
  if(alreadyEnabled)return toast('\u4e94\u4e2a\u5e73\u53f0\u5df2\u7ecf\u5168\u90e8\u5f00\u542f');
  const original=button?.textContent||'\u4e00\u952e\u5f00\u542f\u5168\u90e8\u5e73\u53f0';
  if(button){button.disabled=true;button.classList.add('is-loading');button.textContent='\u6b63\u5728\u5f00\u542f\u5168\u90e8\u5e73\u53f0\u2026'}
  try{
    const result=await api('/api/platforms/runtime/start-all',{method:'POST',body:JSON.stringify({updatedBy:'\u8fd0\u8425\u5e2d\u4f4d'})});
    if(!await refreshBootstrap(pageOwner))return;
    if(state.page==='platforms')renderPlatformRuntimePage();
    const started=(result.platforms||[]).filter(item=>activeCodes.includes(item.code)&&item.desired_state==='RUNNING').length;
    toast(`\u5df2\u5f00\u542f ${started||activeCodes.length} \u4e2a\u5e73\u53f0\uff0c\u4e0b\u65b9\u7684\u5e73\u53f0\u5f00\u5173\u5df2\u7edf\u4e00\u5207\u6362\u4e3a\u5f00\u542f`);
  }catch(error){
    if(ownsPageOwner(pageOwner))toast(error.message,true);
    if(button&&document.body.contains(button)){button.disabled=false;button.classList.remove('is-loading');button.textContent=original}
  }
}

async function stopAllPlatforms(button){
  if(button?.disabled)return;
  const pageOwner=capturePageOwner();
  const running=(state.bootstrap?.platforms||[]).filter(item=>item.desired_state==='RUNNING');
  if(!running.length)return toast('\u6240\u6709\u5e73\u53f0\u5df2\u7ecf\u505c\u6b62');
  const runningJobs=running.reduce((sum,item)=>sum+Number(item.running_job_count||0),0);
  const confirmed=await confirmDelete({title:'\u4e00\u952e\u505c\u6b62\u5168\u90e8\u5e73\u53f0\uff1f',message:`\u786e\u8ba4\u505c\u6b62 ${running.length} \u4e2a\u5e73\u53f0\u7684\u8fd0\u884c\u5f00\u5173\uff1f`,details:['\u505c\u6b62\u540e\u7acb\u5373\u4e0d\u518d\u9886\u53d6\u4efb\u4f55\u5e73\u53f0\u7684\u65b0\u4efb\u52a1\uff0c\u6392\u961f\u4efb\u52a1\u4fdd\u6301\u7b49\u5f85\u3002','\u6240\u6709\u5e73\u53f0\u5747\u4e0d\u518d\u6253\u5f00\u6d4f\u89c8\u5668\u6216 Profile\uff0c\u4e0d\u6267\u884c\u767b\u5f55\u68c0\u67e5\u3001\u91c7\u96c6\u3001\u53d1\u5e03\u6216\u56de\u590d\u3002',runningJobs>0?`\u5f53\u524d\u6709 ${runningJobs} \u4e2a\u5df2\u8fdb\u5165\u6267\u884c\u7684\u4efb\u52a1\uff1b\u4e0d\u4f1a\u5f3a\u6740\uff0c\u907f\u514d\u975e\u5e42\u7b49\u64cd\u4f5c\u91cd\u590d\u6267\u884c\u3002`:'\u5f53\u524d\u6ca1\u6709\u8fd0\u884c\u4e2d\u4efb\u52a1\u3002'],confirmLabel:'\u786e\u8ba4\u5168\u90e8\u505c\u6b62'});
  if(!confirmed)return;
  button.disabled=true;button.classList.add('is-loading');
  const original=button.textContent;button.textContent='\u6b63\u5728\u5168\u90e8\u505c\u6b62\u2026';
  try{
    const result=await api('/api/platforms/runtime/stop-all',{method:'POST',body:JSON.stringify({updatedBy:'\u8fd0\u8425\u5e2d\u4f4d'})});
    if(!await refreshBootstrap(pageOwner))return;
    renderPlatformRuntimePage();
    toast(`\u5df2\u505c\u6b62\u5168\u90e8 ${result.platforms?.length||5} \u4e2a\u5e73\u53f0\uff0c\u6392\u961f\u4efb\u52a1\u4fdd\u6301\u7b49\u5f85`);
  }catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true);button.disabled=false;button.classList.remove('is-loading');button.textContent=original}
}
function renderPlatformRuntimePage({background=false}={}){
  const {devices=[],accounts=[],platforms=[]}=state.bootstrap;
  const activeCodes=state.bootstrap?.config?.activePlatformCodes||['xiaohongshu','douyin','wechat_channels','bilibili','weibo'];
  const plannedCodes=state.bootstrap?.config?.plannedPlatformCodes||[];
  const accountByPlatform=new Map(accounts.map(account=>[account.platform_code,account]));
  const runtimeByPlatform=new Map(platforms.map(item=>[item.code,item]));
  const activeRuntime=platforms.filter(item=>activeCodes.includes(item.code));
  const runnableCount=activeRuntime.filter(item=>item.task_execution_state==='RUNNING').length;
  const openedCount=activeRuntime.filter(item=>item.effective_state==='RUNNING').length;
  const desiredRunningCount=activeRuntime.filter(item=>item.desired_state==='RUNNING').length;
  const allPlatformsEnabled=activeCodes.every(code=>runtimeByPlatform.get(code)?.desired_state==='RUNNING'&&accounts.some(account=>account.platform_code===code&&account.enabled!==0));
  const runtimeCards=loginPlatforms.map(platform=>{
    const runtime=runtimeByPlatform.get(platform.code)||{code:platform.code,name:platform.name,desired_state:'STOPPED',effective_state:'STOPPED',blocked_reason:'PLATFORM_STOPPED'};
    const account=accountByPlatform.get(platform.code);
    const planned=plannedCodes.includes(platform.code)||runtime.lifecycle_state==='PLANNED';
    if(planned)return `<article class="platform-runtime-card is-planned"><div class="platform-runtime-heading"><div><b>${esc(platform.name)}</b>${platform.acceptanceNote?`<span class="badge warning">${esc(platform.acceptanceNote)}</span>`:''}<span class="badge planned">\u5c1a\u672a\u6b63\u5f0f\u63a5\u5165</span></div></div><p>\u5f53\u524d\u4e0d\u53c2\u4e0e\u8c03\u5ea6\u3001\u767b\u5f55\u6216\u4efb\u52a1\u6267\u884c\u3002</p></article>`;
    const desiredRunning=runtime.desired_state==='RUNNING';
    const platformRunning=runtime.effective_state==='RUNNING';
    const taskRunning=runtime.task_execution_state==='RUNNING';
    const accountEnabled=account?.enabled!==0;
    const issueBlocked=runtime.task_blocked_reason==='ACTIVE_ISSUE_BLOCK'||Number(runtime.active_block_count||0)>0;
    const loginReady=account?.login_status==='READY'&&isLocalAgentOnline();
    const stateText=taskRunning?(loginReady?'可执行':'登录待确认'):platformRunning&&issueBlocked?'已开启 · 问题阻断':!accountEnabled?'账号已停用':'已停止';
    const detail=taskRunning?(loginReady?'已确认平台账号登录，可按已启用的功能执行任务。':'平台已开启，请先打开专用 Chrome 并登录，再检查登录状态。'):platformRunning&&issueBlocked?'平台已开启，但关联问题正在阻断对应范围；请到问题汇总进行人工处置。':!accountEnabled?'账号未启用，平台保持 STOPPED；不会启动浏览器、Profile 或登录检查。':'平台已停止；不领取任务，不打开浏览器/Profile，不执行登录检查或采集。';
    const smartReplyEnabled=runtime.smart_reply_enabled===true;
    const smartReplyRunning=runtime.smart_reply_effective_state==='RUNNING';
    const smartReplyText=smartReplyRunning?'\u8fd0\u884c\u4e2d':smartReplyEnabled?'\u5df2\u5f00\u542f \u00b7 \u5f85\u5e73\u53f0\u53ef\u6267\u884c':'\u5df2\u5173\u95ed';
    const smartReplyDetail=smartReplyRunning?'评论和私信将采集后按知识库自动回复。':smartReplyEnabled?'配置已保存；平台停止或存在关联问题阻断时不会领取回复任务。':'消息保留等待，不生成或领取自动回复任务。';
    return `<article data-refresh-key="${platform.code}" class="platform-runtime-card ${platformRunning?'is-running':'is-stopped'}"><div class="platform-runtime-heading"><div><b>${esc(platform.name)}</b>${platform.acceptanceNote?`<span class="badge warning">${esc(platform.acceptanceNote)}</span>`:''}<span class="badge ${taskRunning?'running':platformRunning?(issueBlocked?'warning':'running'):'stopped'}">${stateText}</span></div><button type="button" class="platform-runtime-toggle ${desiredRunning?'is-on':'is-off'}" data-platform="${platform.code}" data-enable="${desiredRunning?'false':'true'}" aria-pressed="${desiredRunning?'true':'false'}" ${!desiredRunning&&!accountEnabled?'disabled title="\u8bf7\u5148\u542f\u7528\u8d26\u53f7\uff1b\u542f\u7528\u8d26\u53f7\u672c\u8eab\u4e0d\u4f1a\u5524\u9192 Local Agent"':''}><span class="runtime-switch-track"><i></i></span><strong>${desiredRunning?'\u505c\u6b62\u5e73\u53f0':'\u5f00\u542f\u5e73\u53f0'}</strong></button></div><p>${detail}</p><div class="button-row"><button type="button" class="btn ${accountEnabled?'danger':'secondary'} platform-account-toggle" data-account="${account?.id||''}" data-enable="${accountEnabled?'false':'true'}" ${account?'':'disabled'}>${accountEnabled?'\u505c\u7528\u8d26\u53f7':'\u542f\u7528\u8d26\u53f7\uff08\u4e0d\u5524\u9192\uff09'}</button>${accountEnabled&&!desiredRunning?'<small class="muted">\u4e0b\u4e00\u6b65\uff1a\u663e\u5f0f\u5f00\u542f\u5e73\u53f0</small>':''}</div><div class="smart-reply-control ${smartReplyRunning?'is-running':smartReplyEnabled?'is-waiting':'is-stopped'}"><div><b>\u667a\u80fd\u56de\u590d \u00b7 ${smartReplyText}</b><small>${smartReplyDetail}</small></div><button type="button" class="btn ${smartReplyEnabled?'danger':'secondary'} platform-smart-reply-toggle" data-platform="${platform.code}" data-enable="${smartReplyEnabled?'false':'true'}">${smartReplyEnabled?'\u5173\u95ed\u667a\u80fd\u56de\u590d':'\u5f00\u542f\u667a\u80fd\u56de\u590d'}</button></div><div class="platform-runtime-metrics"><span>\u542f\u7528\u8d26\u53f7 <b>${Number(runtime.enabled_account_count||0)}</b></span><span>\u5f85\u6267\u884c <b>${Number(runtime.queued_job_count||0)}</b></span><span>\u8fd0\u884c\u4e2d <b>${Number(runtime.running_job_count||0)}</b></span></div>${issueBlocked?'<div class="section-actions"><button type="button" class="btn secondary" data-go="issues">处理关联问题</button></div>':''}<div class="muted">\u8d26\u53f7\uff1a${esc(account?.display_name||'\u672a\u914d\u7f6e')} \u00b7 Profile\uff1a${esc(account?.profile_name||'\u672a\u914d\u7f6e')}</div><div class="section-actions"><span class="badge">登录状态：${esc(({READY:'已登录',UNKNOWN:'待检查',DISABLED:'已停用'})[account?.login_status||'UNKNOWN']||statusName(account.login_status))}</span><button class="btn success platform-login-action" data-platform="${platform.code}" data-action="open-login" ${platformRunning?'':'disabled'}>打开 Chrome 登录 / 切换</button><button class="btn secondary platform-login-action" data-platform="${platform.code}" data-action="check-login" ${platformRunning?'':'disabled'}>检查登录</button></div>${runtime.runtime_updated_at?`<small>\u6700\u540e\u8c03\u6574\uff1a${fmt(runtime.runtime_updated_at)}${runtime.runtime_updated_by?' \u00b7 '+esc(runtime.runtime_updated_by):''}</small>`:''}</article>`;
  }).join('');
  const target=background?document.createElement('section'):$('#content');
  target.innerHTML=`<section class="platform-runtime-page-head"><div><span class="panel-kicker">PLATFORM RUNTIME CONTROL</span><h2>\u4e94\u5e73\u53f0\u8fd0\u884c\u63a7\u5236 \u00b7 \u8d26\u53f7\u4e0e\u667a\u80fd\u56de\u590d\u7ba1\u7406</h2><p>\u5c0f\u7ea2\u4e66\u3001\u6296\u97f3\u3001\u89c6\u9891\u53f7\u3001B\u7ad9\u3001\u5fae\u535a\u5747\u53ef\u72ec\u7acb\u542f\u505c\u3002\u8d26\u53f7\u542f\u7528\u4e0d\u4f1a\u5524\u9192 Local Agent\uff1b\u53ea\u6709\u663e\u5f0f\u5f00\u542f\u5e73\u53f0\u540e\u624d\u5141\u8bb8\u767b\u5f55\u548c\u4efb\u52a1\u6267\u884c\u3002</p></div><span class="runtime-summary">${runnableCount}/${activeCodes.length} \u53ef\u6267\u884c \u00b7 ${openedCount}/${activeCodes.length} \u5df2\u5f00\u542f</span></section><div class="notice warn"><b>\u5b89\u5168\u5173\u95ed\u8bed\u4e49\uff1a</b>STOPPED \u5e73\u53f0\u4e0d\u9886\u53d6\u4efb\u52a1\u3001\u4e0d\u767b\u5f55\u68c0\u67e5\u3001\u4e0d\u91c7\u96c6\u3001\u4e0d\u521b\u5efa\u6216\u6253\u5f00 Chrome/Profile\uff1b\u505c\u6b62\u65f6\u901a\u77e5 Local Agent \u5173\u95ed\u5df2\u6709 Browser Context\u3002</div><div class="panel platform-runtime-panel"><div class="panel-head"><div><h2>\u5e73\u53f0\u8fd0\u884c\u5f00\u5173</h2><p>\u4e94\u4e2a\u5df2\u63a5\u5165\u5e73\u53f0\u5747\u652f\u6301\u8d26\u53f7\u542f\u505c\u3001\u5e73\u53f0\u542f\u505c\u548c\u667a\u80fd\u56de\u590d\u72ec\u7acb\u63a7\u5236\u3002</p></div><div class="button-row"><button type="button" class="btn" id="enableAllPlatforms" title="\u5c06\u4e0b\u65b9\u4e94\u4e2a\u5e73\u53f0\u7684\u8d26\u53f7\u4e0e\u5e73\u53f0\u8fd0\u884c\u5f00\u5173\u7edf\u4e00\u5207\u6362\u4e3a\u5f00\u542f" ${allPlatformsEnabled?'disabled':''}>\u4e00\u952e\u5f00\u542f\u5168\u90e8\u5e73\u53f0</button><button type="button" class="btn success" id="openSelectedPlatforms" title="\u53ea\u6253\u5f00\u4e0b\u65b9\u5df2\u542f\u7528\u8d26\u53f7\u4e14\u8fd0\u884c\u5f00\u5173\u4e3a RUNNING \u7684\u5e73\u53f0\uff1b\u672a\u542f\u7528\u5e73\u53f0\u4e0d\u4f1a\u88ab\u5524\u9192" ${openedCount?'':'disabled'}>\u4e00\u952e\u6253\u5f00\u6240\u9009\u5e73\u53f0</button><button type="button" class="btn danger" id="stopAllPlatforms" ${desiredRunningCount?'':'disabled'}>\u505c\u6b62\u5168\u90e8\u5e73\u53f0</button><button type="button" class="btn secondary" data-go="issues">\u95ee\u9898\u6c47\u603b</button></div></div><div class="platform-runtime-grid">${runtimeCards}</div></div>`;
  const realMode=state.bootstrap?.config?.rpaMode==='five_platform_assisted';
  const browserOnline=isLocalAgentOnline();
  target.insertAdjacentHTML('afterbegin', '<div class="notice '+(realMode&&browserOnline?'':'warn')+'"><b>'+ (realMode?'真实账号模式':'模拟模式')+'</b> · '+(browserOnline?'浏览器执行端已连接':'浏览器执行端未连接')+'<p>点击平台的“打开 Chrome 登录 / 切换”，在运营电脑弹出的独立 Chrome 窗口中扫码或登录。完成后点击“检查登录”。登录会保存在该平台的专用浏览器中；切换账号时先在平台内退出，再登录新账号。内网访问也会在这台运营电脑上打开 Chrome。</p></div>');
  if(background){
    applyInteractionPresentation(target,{page:'platforms'});
    patchBackgroundContent($('#content'),target);
  }
  document.querySelectorAll('.platform-runtime-toggle').forEach(button=>button.onclick=()=>runPlatformAction(()=>togglePlatformRuntime(button.dataset.platform,button.dataset.enable==='true',button)));
  document.querySelectorAll('.platform-account-toggle').forEach(button=>button.onclick=()=>runPlatformAction(()=>togglePlatformAccount(Number(button.dataset.account),button.dataset.enable==='true',button)));
  document.querySelectorAll('.platform-smart-reply-toggle').forEach(button=>button.onclick=()=>runPlatformAction(()=>togglePlatformSmartReply(button.dataset.platform,button.dataset.enable==='true',button)));

  document.querySelectorAll('.platform-login-action').forEach(button=>button.onclick=()=>runPlatformAction(()=>openPlatformAccountLogin(button)));
  const enableAll=$('#enableAllPlatforms');if(enableAll)enableAll.onclick=()=>runPlatformAction(()=>startAllPlatforms(enableAll));
  const openSelected=$('#openSelectedPlatforms');if(openSelected)openSelected.onclick=()=>runPlatformAction(()=>batchPlatformAction('open',openSelected));
  presentInteractions();
  const stopAll=$('#stopAllPlatforms');if(stopAll)stopAll.onclick=()=>runPlatformAction(()=>stopAllPlatforms(stopAll));
  document.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>navigate(button.dataset.go));
  platformRuntimeSignatureValue=platformRuntimeSignature();
}



let refreshTimer=null;
let taskRefreshTimer=null;
let messageRefreshTimer=null;
let messageCountdownTimer=null;
let taskRefreshInFlight=false;
let taskRefreshSignatureValue='';
let messageRefreshInFlight=false;
let messageRefreshSignatureValue='';
function messageFormHasEditingFocus(){
  const active=document.activeElement;
  return active&&(active.isContentEditable||['INPUT','TEXTAREA'].includes(active.tagName))&&$('#content')?.contains(active);
}
async function refreshTasksFromTimer(){
  if(state.page!=='tasks'||pageRenderInFlightGeneration===pageRenderGeneration||document.hidden||taskRefreshInFlight||document.querySelector('.confirm-overlay'))return;
  taskRefreshInFlight=true;
  const owner=capturePageOwner(),selected=state.taskPlatform;
  try{
    const data=await api('/api/tasks'+(selected&&selected!=='ALL'?`?platformCode=${encodeURIComponent(selected)}`:''));
    if(!ownsPageOwner(owner)||selected!==state.taskPlatform)return;
    if(JSON.stringify(data)!==taskRefreshSignatureValue)await renderTasks(data);
  }catch{}finally{taskRefreshInFlight=false}
}
async function refreshMessagesFromTimer(){
  if(state.page!=='messages'||pageRenderInFlightGeneration===pageRenderGeneration||document.hidden||messageRefreshInFlight||messageFormHasEditingFocus()||document.querySelector('.confirm-overlay'))return;
  const pageOwner=capturePageOwner();
  messageRefreshInFlight=true;
  try{
    const data=await api(`/api/messages?t=${Date.now()}`);
    if(!ownsPageOwner(pageOwner)||messageFormHasEditingFocus()||document.querySelector('.confirm-overlay'))return;
    const signature=messageRefreshSignature(data);
    if(signature!==messageRefreshSignatureValue)await renderMessages(data,{background:true});
  }catch{}finally{messageRefreshInFlight=false}
}
function clearWorkspaceSession(){
  expandedCommentPosts.clear();
  commentPostReadPositions.clear();
  if(state.materialPreviewUrl){try{URL.revokeObjectURL(state.materialPreviewUrl)}catch{}}
  Object.assign(state,{
    page:'dashboard',
    bootstrap:null,
    precheck:null,
    compliance:null,
    knowledgeView:'rag',
    knowledgeCategory:null,
    knowledgeSubcategory:null,



    knowledgeCategoryData:null,




    knowledgeCreateExpanded:false,
    publishHistoryPage:1,
    materialPreviewUrl:null,
    wecomCategory:'ALL',
    messageView:'COMMENT',
    messageAccountId:null,
    taskPlatform:'ALL',
    retryDraft:null,
    retrySourceTaskId:null
  });
  /* 运营看板数据属于会话内敏感内容，退出登录时一并清除，避免下一个登录者看到上一位的数据。 */
  operationsDashboardKey=null;
  state.operationsDashboard=null;
  document.querySelectorAll('.confirm-overlay').forEach(element=>element.remove());
  const content=$('#content');
  if(content)content.innerHTML='<div class="loading session-cleared"><span>\u8bf7\u767b\u5f55\u540e\u8fdb\u5165\u8fd0\u8425\u5de5\u4f5c\u53f0</span></div>';
  const operator=$('.operator small');if(operator)operator.textContent='\u7ba1\u7406\u5458';
  const toastElement=$('#toast');if(toastElement)toastElement.className='toast';
}
function showLoginScreen(message=''){
  resetKnowledgeTools();
  cleanupWechatAdmin();
  hideHotTopicStudio({reset:true});
  closeContentLibraryPicker();
  if(refreshTimer){clearInterval(refreshTimer);refreshTimer=null}
  if(taskRefreshTimer){clearInterval(taskRefreshTimer);taskRefreshTimer=null}
  if(messageRefreshTimer){clearInterval(messageRefreshTimer);messageRefreshTimer=null}
  if(messageCountdownTimer){clearInterval(messageCountdownTimer);messageCountdownTimer=null}
  messageRefreshInFlight=false;messageRefreshSignatureValue='';
  clearWorkspaceSession();
  state.auth={...(state.auth||{}),authenticated:false};
  document.body.classList.add('auth-locked');
  const shell=$('.shell');if(shell){shell.hidden=true;shell.setAttribute('aria-hidden','true')}
  const logout=$('#logoutBtn');if(logout)logout.hidden=true;
  const screen=$('#loginScreen');if(!screen)return;screen.hidden=false;
  $('#loginError').textContent=message;
  const form=$('#loginForm');form.onsubmit=async event=>{event.preventDefault();const submit=$('#loginSubmit');submit.disabled=true;$('#loginError').textContent='';try{const values=Object.fromEntries(new FormData(form));state.auth=await api('/api/auth/login',{method:'POST',body:JSON.stringify(values)});form.reset();startWorkspace()}catch(error){$('#loginError').textContent=error.message}finally{submit.disabled=false}};
  setTimeout(()=>form.querySelector('input[name="username"]')?.focus(),0);
}
function startWorkspace(){
  document.body.classList.remove('auth-locked');
  const shell=$('.shell');if(shell){shell.hidden=false;shell.removeAttribute('aria-hidden')}
  const screen=$('#loginScreen');if(screen)screen.hidden=true;
  const logout=$('#logoutBtn');if(logout)logout.hidden=state.auth?.authEnabled===false;
  const operator=$('.operator small');if(operator)operator.textContent=state.auth?.username||'\u7ba1\u7406\u5458';
  if(!state.appStarted){window.appRefresh=()=>render();$('#refreshBtn').onclick=()=>render();$('#masterSwitch').onclick=()=>toggleMasterSwitch();if(logout)logout.onclick=logoutAdmin;buildNav();state.appStarted=true}
  const initialRoute=resolveWorkspaceHash(location.hash);
  navigate(initialRoute?initialRoute.page:(state.page||'dashboard'),initialRoute?initialRoute.view||null:null,initialRoute?.presentation||null);
  if(!refreshTimer)refreshTimer=setInterval(()=>{const page=state.page,pageGeneration=pageRenderGeneration;if(['dashboard','tasks','messages','browser','issues','wecom','platforms'].includes(page)&&pageRenderInFlightGeneration!==pageGeneration)refreshBootstrap({page,pageGeneration}).then(bootstrap=>{if(!bootstrap||state.page!==page||pageRenderGeneration!==pageGeneration)return;if(state.page==='dashboard')refreshDashboardLoginStatus();else if(state.page==='platforms')refreshPlatformLoginStatus();else if(state.page==='browser')refreshBrowserStatusPanel();else if(state.page==='issues')renderIssues()}).catch(()=>{})},5000);
  if(!taskRefreshTimer)taskRefreshTimer=setInterval(refreshTasksFromTimer,2000);
  if(!messageRefreshTimer)messageRefreshTimer=setInterval(refreshMessagesFromTimer,3000);
  if(!messageCountdownTimer)messageCountdownTimer=setInterval(updateMessageChannelCountdowns,1000);
  updateMessageChannelCountdowns();
}
async function logoutAdmin(){
  try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch(error){toast('\u9000\u51fa\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\uff1a'+error.message);return}
  state.auth={authenticated:false,authEnabled:true};
  showLoginScreen('\u5df2\u5b89\u5168\u9000\u51fa\u7ba1\u7406\u7aef');
}
/* ==========================================================================
   内容工作台移植三路径统一 WebUI，三路产物由共享成片库交接给发布管理。
   保留既有素材与发布辅助函数供其他流程复用；旧创作路由统一进入 Studio。
   发布管理继续负责素材预检、审核、排期与任务记录，不自动同步或发布成片。
   ========================================================================== */
const contentStudio={
  tab:'topics',
  materialPath:'',
  materialPreviewUrl:null,
  precheck:null,
  precheckError:null,
  copy:{status:'IDLE',error:null,result:null,mock:false},
  traffic:{status:'IDLE',error:null,result:null,platformCodes:[]},
  library:{status:'IDLE',error:null,records:[],total:0},
  title:'',
  body:'',
  busy:null
};
function studioResetMaterial(){
  contentStudio.materialPath='';
  contentStudio.materialPreviewUrl=null;
  contentStudio.precheck=null;
  contentStudio.precheckError=null;
  contentStudio.copy={status:'IDLE',error:null,result:null,mock:false};
  contentStudio.traffic={status:'IDLE',error:null,result:null,platformCodes:[]};
  contentStudio.title='';
  contentStudio.body='';
}
function studioPlatformCodes(){
  const accounts=state.bootstrap?.accounts||[];
  const configured=new Set(accounts.filter(account=>account.enabled!==0).map(account=>account.platform_code));
  const active=state.bootstrap?.config?.activePlatformCodes||[];
  const list=active.filter(code=>configured.has(code));
  return list.length?list:active;
}
function studioTargets(){
  const accounts=state.bootstrap?.accounts||[];
  const codes=studioPlatformCodes();
  return accounts.filter(account=>account.enabled!==0&&(!codes.length||codes.includes(account.platform_code)))
    .map(account=>({platformCode:account.platform_code,accountId:account.id}));
}
function contentStudioTabs(){
  const tabs=[
    ['topics','▤','热点自动生成','从热点库选择选题'],
    ['script','✎','文稿与分镜','用本地素材生成标题与正文'],
    ['library','▦','作品库','已发布作品与发布结果']
  ];
  return `<div class="knowledge-section-tabs" role="tablist" aria-label="内容创作步骤">${tabs.map(([key,icon,label,desc])=>`<button class="knowledge-section-tab ${contentStudio.tab===key?'active':''}" type="button" data-studio-tab="${key}" role="tab" aria-selected="${contentStudio.tab===key}"><span class="knowledge-tab-icon">${icon}</span><span><b>${label}</b><small>${desc}</small></span></button>`).join('')}</div>`;
}
function studioPrecheckNotices(){
  const precheck=contentStudio.precheck;
  if(contentStudio.precheckError)return `<div class="notice warn"><span class="notice-icon">!</span><div><b>素材检测失败</b><p>${esc(contentStudio.precheckError)}</p></div></div>`;
  if(!precheck)return `<div class="notice info"><span class="notice-icon">i</span><div><b>尚未检测素材</b><p>选择本地素材后会自动执行格式检测；AI 文案生成需要先通过检测。</p></div></div>`;
  const meta=precheck.meta||{};
  const overall=precheck.overall==='PASSED'?'notice ok':precheck.overall==='WARNING'?'notice warn':'notice warn';
  const tone=precheck.overall==='PASSED'?'检测通过':precheck.overall==='WARNING'?'需人工确认':'不符合要求';
  const platformResults=Array.isArray(precheck.platforms)?precheck.platforms:[];
  return `<div class="${overall}"><span class="notice-icon">${precheck.overall==='PASSED'?'✓':'!'}</span><div><b>素材检测：${esc(tone)}</b><p>类型 ${esc(meta.type||'未知')}${meta.format?` · 格式 ${esc(meta.format)}`:''}${meta.width?` · ${meta.width}×${meta.height}`:''}${meta.durationSeconds?` · ${meta.durationSeconds}s`:''}${meta.hasAudio===false?' · 未检测到音轨':''}</p>${platformResults.length?`<ul class="studio-check-list">${platformResults.map(item=>`<li><i class="${item.status==='PASSED'?'is-ok':item.status==='WARNING'?'is-warn':'is-block'}"></i>${esc(item.platformName||item.platformCode)} · ${esc(item.message||item.status||'')}</li>`).join('')}</ul>`:''}</div></div>`;
}
function studioCopyView(){
  const copy=contentStudio.copy;
  const result=copy.result||{};
  const generating=copy.status==='RUNNING';
  return `<section class="panel">
    <div class="panel-head"><div><span class="panel-kicker">STEP 02 · COPY</span><h2>标题与正文</h2><p>由 AI 依据素材内容生成；生成结果必须人工确认后才能发布。</p></div></div>
    <div id="studioCopyStatus">${generating?'<div class="notice info"><span class="notice-icon">i</span><div><b>正在生成标题与正文…</b><p>处理链路：读取素材 → 提炼主题 → 生成标题正文 → 风险校验。</p></div></div>':''}</div>
    ${copy.status==='FAILED'&&copy.error?`<div class="notice warn"><span class="notice-icon">!</span><div><b>文案生成失败</b><p>${esc(copy.error)}</p></div></div>`:''}
    ${copy.mock?`<div class="notice warn"><span class="notice-icon">!</span><div><b>当前为 Mock 演示模式</b><p>未真实分析素材内容，请在「模型与通知」中启用在线模型后重新生成。</p></div></div>`:''}
    <div class="gap-form">
      <label>作品标题<input id="studioTitle" maxlength="30" value="${esc(contentStudio.title||result.title||'')}" placeholder="生成后在此确认标题"></label>
      <label>正文<textarea id="studioBody" rows="7" placeholder="生成后在此确认正文">${esc(contentStudio.body||result.body||'')}</textarea></label>
    </div>
    ${result.keyPoints?.length?`<div class="studio-copy-meta"><b>核心要点</b><ul>${result.keyPoints.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''}
    ${result.hashtags?.length?`<div class="studio-copy-meta"><b>建议话题</b><p>${result.hashtags.map(item=>`<span>#${esc(item)}</span>`).join('')}</p></div>`:''}
    ${result.riskFlags?.length?`<div class="notice warn"><span class="notice-icon">!</span><div><b>风险提示</b><ul class="studio-check-list">${result.riskFlags.map(item=>`<li><i class="is-warn"></i>${esc(item)}</li>`).join('')}</ul></div></div>`:''}
    ${typeof result.confidence==='number'&&result.confidence>0?`<div class="studio-copy-meta"><b>AI 置信度</b><p>${(result.confidence*100).toFixed(0)}%</p></div>`:''}
    <div class="notice info"><span class="notice-icon">i</span><div><b>分镜、配音与动效：待接入</b><p>当前后端没有视频剪辑、配音与动效能力，本页不会生成示例分镜。已有的真实能力是标题、正文、话题与风险提示。</p></div></div>
    <div class="section-actions">
      <button class="btn" type="button" id="studioGenerateCopy" ${generating?'disabled':''}>${copy.status==='SUCCESS'?'重新生成标题与正文':'AI 生成标题与正文'}</button>
      <button class="btn secondary" type="button" id="studioToPublish">带入内容发布 →</button>
    </div>
  </section>`;
}
function studioPrecheckFailed(){return !contentStudio.precheck||contentStudio.precheck.overall==='BLOCKED'}
function contentStudioScriptView(){
  return `<div class="studio-script-grid">
    <section class="panel">
      <div class="panel-head"><div><span class="panel-kicker">STEP 01 · MATERIAL</span><h2>选择本地素材</h2><p>素材只在本机处理，不会上传原文件；生成文案时仅发送必要的处理结果。</p></div></div>
      <div class="studio-material-row">
        <button class="btn" type="button" id="studioPickMaterial">选择本地素材</button>
        <input id="studioMaterialPath" readonly value="${esc(contentStudio.materialPath)}" placeholder="尚未选择素材" />
      </div>
      ${studioPrecheckNotices()}
      ${contentStudio.materialPreviewUrl?`<div class="material-preview">${(contentStudio.precheck?.meta?.type==='video')?`<video src="${esc(contentStudio.materialPreviewUrl)}" controls muted playsinline></video>`:`<img src="${esc(contentStudio.materialPreviewUrl)}" alt="素材预览" />`}</div>`:''}
      ${contentStudio.traffic.status!=='IDLE'?studioTrafficView():''}
      <div class="section-actions">
        <button class="btn secondary" type="button" id="studioPredictTraffic" ${studioPrecheckFailed()?'disabled':''}>预测内容适配潜力</button>
      </div>
    </section>
    ${studioCopyView()}
  </div>`;
}
function studioTrafficView(){
  const traffic=contentStudio.traffic;
  if(traffic.status==='RUNNING')return `<div class="notice info"><span class="notice-icon">i</span><div><b>正在计算内容适配潜力…</b><p>将按所选平台的公开内容规律给出参考评分。</p></div></div>`;
  if(traffic.status==='FAILED')return `<div class="notice warn"><span class="notice-icon">!</span><div><b>潜力预测失败</b><p>${esc(traffic.error||'')}</p></div></div>`;
  const result=traffic.result||{};
  if(!Array.isArray(result.platformPredictions)||!result.platformPredictions.length)return '';
  return `<div class="studio-traffic">
    <div class="studio-traffic-head"><b>内容适配潜力</b><span>综合 ${Number(result.overallScore)||0} 分 · ${esc(result.overallLevel||'')}</span></div>
    <div class="studio-traffic-list">${result.platformPredictions.map(item=>`<div><span>${esc(item.platformName)}</span><div class="studio-traffic-track"><i style="width:${Math.max(0,Math.min(100,Number(item.score)||0))}%"></i></div><b>${Number(item.score)||0}</b></div>`).join('')}</div>
    ${result.platformPredictions[0]?.strengths?.length?`<ul class="studio-check-list">${result.platformPredictions.flatMap(item=>(item.strengths||[]).slice(0,2).map(text=>`<li><i class="is-ok"></i>${esc(item.platformName)}：${esc(text)}</li>`)).join('')}</ul>`:''}
    <p class="studio-traffic-note">${esc(result.disclaimer||'AI 推测结果，仅作参考，非平台官方结论。')}</p>
  </div>`;
}
function contentStudioLibraryView(){
  const library=contentStudio.library;
  if(library.status==='LOADING')return `<section class="panel"><div class="loading"><i></i><span>正在读取发布历史…</span></div></section>`;
  if(library.status==='FAILED')return `<section class="panel"><div class="notice warn"><span class="notice-icon">!</span><div><b>作品库读取失败</b><p>${esc(library.error||'')}</p></div></div><div class="section-actions"><button class="btn" type="button" id="studioReloadLibrary">重新加载</button></div></section>`;
  const records=library.records||[];
  return `<section class="panel">
    <div class="panel-head"><div><span class="panel-kicker">WORKS</span><h2>作品库</h2><p>直接读取系统发布历史（共 ${Number(library.total)||0} 条已发布或失败的作品）。</p></div><button class="ghost" type="button" id="studioReloadLibrary">刷新</button></div>
    ${records.length?`<div class="studio-library-grid">${records.map(record=>`<article class="studio-work-card">
      <div class="studio-work-head"><span class="${record.publish_status==='SUCCESS'?'is-ok':'is-block'}">${record.publish_status==='SUCCESS'?'已发布':'发布失败'}</span><time>${esc(fmtTaskPublishTime(record.publish_time||record.created_at))}</time></div>
      <b>${esc(record.title||'未命名内容')}</b>
      <p>${esc((record.body||'').slice(0,120))}${(record.body||'').length>120?'…':''}</p>
      <div class="studio-work-targets">${(record.targets||[]).map(target=>`<span>${esc(target.platform_name||target.platform_code)} · ${esc(target.status||'')}</span>`).join('')||'<span>无平台记录</span>'}</div>
      <small>${esc(record.material_meta?.name||record.material_path||'素材信息缺失')}</small>
    </article>`).join('')}</div>`:'<div class="empty-inline">暂无已发布或失败的作品记录。完成一次内容发布后，作品会出现在这里。</div>'}
    <div class="section-actions"><button class="btn secondary" type="button" data-go="tasks">去任务中心 →</button></div>
  </section>`;
}
async function renderContentStudio(){
  if(!['create','creativeSettings'].includes(state.page))return;
  return renderHotTopicStudio($('#content'),{view:state.page==='creativeSettings'?'settings':null,onOpenSettings:()=>{if(state.page!=='creativeSettings')openWorkspaceItem('creation-settings')},onUnauthorized:()=>showLoginScreen('登录已过期，请重新登录'),onPublish:publishContentLibraryItem,onViewChanged:({title})=>{if(state.page==='create'){state.contentWorkspaceTitle=title;$('#pageTitle').textContent=title}}});
}
function renderMaterialEditor(){
  const precheck=contentStudio.precheck;
  const meta=precheck?.meta||{};
  $('#content').innerHTML=`<div class="content-studio-page">
    <section class="panel">
      <div class="panel-head"><div><span class="panel-kicker">LOCAL MATERIAL</span><h2>素材自动剪辑</h2><p>本页只使用系统真实具备的能力：本地素材预检、AI 文案生成与内容适配潜力预测。</p></div></div>
      <div class="notice warn"><span class="notice-icon">!</span><div><b>视频剪辑与编码：待接入</b><p>当前后端没有剪辑、拼接、字幕烧录或视频编码能力，本页不会生成示例成片。设计稿中的剪辑工作台需要后续接入本地剪辑引擎。</p></div></div>
      <div class="studio-material-row">
        <button class="btn" type="button" id="studioPickMaterial">选择本地素材</button>
        <input id="studioMaterialPath" readonly value="${esc(contentStudio.materialPath)}" placeholder="尚未选择素材" />
      </div>
      ${studioPrecheckNotices()}
      ${contentStudio.materialPreviewUrl?`<div class="material-preview">${meta.type==='video'?`<video src="${esc(contentStudio.materialPreviewUrl)}" controls muted playsinline></video>`:`<img src="${esc(contentStudio.materialPreviewUrl)}" alt="素材预览" />`}</div>`:''}
      <div class="studio-pending-grid">
        ${studioPendingCard('01','素材预检','已具备：格式、分辨率、时长与平台适配检测','可用')}
        ${studioPendingCard('02','AI 文案','已具备：按素材内容生成标题、正文、话题与风险提示','可用')}
        ${studioPendingCard('03','内容适配潜力','已具备：按平台给出内容适配潜力参考评分','可用')}
        ${studioPendingCard('04','剪辑与成片导出','需要接入本地视频剪辑与编码引擎','待接入')}
      </div>
      <div class="section-actions">
        <button class="btn" type="button" id="studioGenerateCopy" ${studioPrecheckFailed()?'disabled':''}>AI 生成标题与正文</button>
        <button class="btn secondary" type="button" id="studioPredictTraffic" ${studioPrecheckFailed()?'disabled':''}>预测内容适配潜力</button>
        <button class="btn secondary" type="button" id="studioToPublish">带入内容发布 →</button>
      </div>
      <div class="gap-form">
        <label>作品标题<input id="studioTitle" maxlength="30" value="${esc(contentStudio.title||contentStudio.copy.result?.title||'')}" placeholder="选择素材并生成后在此确认"></label>
        <label>正文<textarea id="studioBodyText" rows="6" placeholder="选择素材并生成后在此确认">${esc(contentStudio.body||contentStudio.copy.result?.body||'')}</textarea></label>
      </div>
      ${studioTrafficView()}
      ${contentStudio.copy.status==='FAILED'&&contentStudio.copy.error?`<div class="notice warn"><span class="notice-icon">!</span><div><b>文案生成失败</b><p>${esc(contentStudio.copy.error)}</p></div></div>`:''}
      ${contentStudio.copy.status==='SUCCESS'&&contentStudio.copy.result?.keyPoints?.length?`<div class="studio-copy-meta"><b>核心要点</b><ul>${contentStudio.copy.result.keyPoints.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''}
    </section>
  </div>`;
  bindContentStudio();
}
function bindContentStudio(){
  const host=$('#content');
  host.onclick=async event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.studioTab){contentStudio.tab=button.dataset.studioTab;await (state.page==='editing'?renderMaterialEditor():renderContentStudio());return}
    if(button.dataset.go){navigate(button.dataset.go);return}
    if(button.id==='studioPickMaterial'){await studioPickMaterial();return}
    if(button.id==='studioGenerateCopy'){await studioGenerateCopy();return}
    if(button.id==='studioPredictTraffic'){await studioPredictTraffic();return}
    if(button.id==='studioToPublish'){studioSendToPublish();return}
    if(button.id==='studioReloadLibrary'){contentStudio.library.status='IDLE';await renderContentStudio();return}
  };
  host.oninput=event=>{
    if(event.target.id==='studioTitle')contentStudio.title=event.target.value;
    if(event.target.id==='studioBody'||event.target.id==='studioBodyText')contentStudio.body=event.target.value;
  };
}
async function rerenderStudio(){return state.page==='editing'?renderMaterialEditor():renderContentStudio()}
async function studioPickMaterial(){
  if(contentStudio.busy)return;
  contentStudio.busy='pick';
  toast('正在打开本地文件选择窗口，请在弹窗中选择素材');
  try{
    const d=await agent('/pick-file',{method:'POST',body:'{}'});
    if(d.cancelled){toast('已取消选择文件');return}
    studioResetMaterial();
    contentStudio.materialPath=d.materialPath||'';
    await rerenderStudio();
    await studioRunPrecheck();
  }catch(error){toast(error.message,true)}
  finally{contentStudio.busy=null}
}
async function studioRunPrecheck(){
  const materialPath=contentStudio.materialPath.trim();
  if(!materialPath)return false;
  const platforms=studioPlatformCodes();
  contentStudio.precheckError=null;
  try{
    const d=await agent('/precheck',{method:'POST',body:JSON.stringify({materialPath,platforms})});
    if(state.page!=='create'&&state.page!=='editing')return false;
    if(contentStudio.materialPath.trim()!==materialPath)return false;
    contentStudio.precheck=d.precheck||null;
    contentStudio.materialPreviewUrl=agentResourceUrl(d.previewUrl);
    await rerenderStudio();
    return true;
  }catch(error){
    contentStudio.precheckError=error.message;
    if(state.page==='create'||state.page==='editing')await rerenderStudio();
    toast(error.message,true);
    return false;
  }
}
async function studioGenerateCopy(){
  if(contentStudio.busy)return;
  if(state.bootstrap?.config?.audioContentGenerationEnabled===false){toast('AI 素材文案功能未启用',true);return}
  if(!contentStudio.materialPath.trim()){toast('请先选择本地素材',true);return}
  const meta=contentStudio.precheck?.meta||{};
  if(!contentStudio.precheck){toast('请先完成素材格式检测',true);return}
  if(!['image','video'].includes(meta.type)){toast('只有图片或视频素材可生成标题和文案',true);return}
  if(meta.type==='video'&&meta.hasAudio!==true){toast('视频中未检测到音轨',true);return}
  if(contentStudio.precheck.overall==='BLOCKED'){toast('素材格式不符合要求，不能生成文案',true);return}
  contentStudio.busy='copy';
  contentStudio.copy={status:'RUNNING',error:null,result:null,mock:false};
  await rerenderStudio();
  try{
    const materialPath=contentStudio.materialPath.trim();
    const materialSha256=meta.sha256;
    const platformCodes=studioPlatformCodes();
    const d=await agent('/material-content-generation',{method:'POST',body:JSON.stringify({materialPath,precheck:contentStudio.precheck,materialSha256,platformCodes,force:false,previousCopy:null,generationNonce:''})});
    if(state.page!=='create'&&state.page!=='editing')return;
    const generation=d.generation||{};
    if(generation.status!=='SUCCESS')throw Object.assign(new Error(generation.message||'AI 文案生成失败'),{code:generation.code});
    const shaUnchanged=String(generation.materialSha256||'').toLowerCase()===String(contentStudio.precheck?.meta?.sha256||'').toLowerCase();
    if(!shaUnchanged){toast('素材已变化，请重新检测后再生成',true);return}
    const result=generation.result||{};
    contentStudio.copy={status:'SUCCESS',error:null,result,mock:generation.mock===true};
    contentStudio.title=result.title||'';
    contentStudio.body=result.body||'';
    await rerenderStudio();
    toast(generation.mock===true?'当前为 Mock 演示模式，未分析素材内容，请先启用在线模型':`已生成标题与正文，请人工确认后发布`);
  }catch(error){
    contentStudio.copy={status:'FAILED',error:error.message,result:null,mock:false};
    if(state.page==='create'||state.page==='editing')await rerenderStudio();
    toast(error.message,true);
  }finally{contentStudio.busy=null}
}
async function studioPredictTraffic(){
  if(contentStudio.busy)return;
  if(!contentStudio.precheck||contentStudio.precheck.overall==='BLOCKED'){toast('请先完成素材检测',true);return}
  const platformCodes=studioPlatformCodes();
  if(!platformCodes.length){toast('至少需要启用一个平台才能预测内容适配潜力',true);return}
  contentStudio.busy='traffic';
  contentStudio.traffic={status:'RUNNING',error:null,result:null,platformCodes};
  await rerenderStudio();
  try{
    const body=contentStudio.body||contentStudio.copy.result?.body||'';
    const title=contentStudio.title||contentStudio.copy.result?.title||'';
    const result=contentStudio.copy.result||{};
    const d=await agent('/traffic-prediction',{method:'POST',body:JSON.stringify({
      title,body,
      contentOrigin:contentStudio.copy.mock?'':'AI_GENERATED',
      materialPath:contentStudio.materialPath.trim(),
      precheck:contentStudio.precheck,
      platformCodes,
      contentContext:{coreTheme:result.coreTheme,contentAngle:result.contentAngle,keyPoints:result.keyPoints,sourceSummary:result.sourceSummary||result.imageSummary||result.audioSummary},
      aiReview:null,
      force:false
    })});
    if(state.page!=='create'&&state.page!=='editing')return;
    if(d.prediction?.status==='SUCCESS'){
      contentStudio.traffic={status:'SUCCESS',error:null,result:d.prediction,platformCodes};
      await rerenderStudio();
      toast(`内容适配潜力：${d.prediction.overallScore||0} 分 · ${d.prediction.overallLevel||''}`);
      return;
    }
    throw new Error(d.prediction?.message||'内容适配潜力预测失败');
  }catch(error){
    contentStudio.traffic={status:'FAILED',error:error.message,result:null,platformCodes};
    if(state.page==='create'||state.page==='editing')await rerenderStudio();
    toast(error.message,true);
  }finally{contentStudio.busy=null}
}
async function studioLoadLibrary(){
  contentStudio.library.status='LOADING';
  try{
    const d=await api('/api/publish/history?page=1&pageSize=20');
    contentStudio.library={status:'SUCCESS',error:null,records:d.records||[],total:d.total||0};
  }catch(error){
    contentStudio.library={status:'FAILED',error:error.message,records:[],total:0};
  }
}
function studioSendToPublish(){
  const title=(contentStudio.title||contentStudio.copy.result?.title||'').trim();
  const body=(contentStudio.body||contentStudio.copy.result?.body||'').trim();
  if(!contentStudio.materialPath.trim()){toast('请先选择本地素材',true);return}
  if(!title||!body){toast('请先生成或填写标题与正文',true);return}
  state.retryDraft={origin:'studio',sourceTaskId:null,title,body,materialPath:contentStudio.materialPath.trim(),targets:studioTargets()};
  navigate('publish');
}
async function initializeApp(){try{state.auth=await api('/api/auth/session');if(state.auth.authEnabled&& !state.auth.authenticated)showLoginScreen();else startWorkspace()}catch(error){showLoginScreen('无法连接服务端：'+error.message)}}
initializeApp();



async function openPlatformAccountLogin(button){
  const original=button.textContent;
  button.disabled=true;button.textContent='处理中…';
  try{
    const result=await agent('/platforms/'+button.dataset.platform+'/'+button.dataset.action,{method:'POST',body:'{}'});
    await refreshBootstrap();
    renderPlatformRuntimePage();
    renderLoginBadge(button.dataset.platform,result.status,'platformStatus-');
    toast(result.status?.message||'请在运营电脑的 Chrome 中完成登录');
  }catch(error){toast(error.message,true)}
  finally{button.disabled=false;button.textContent=original}
}