import { renderWechatAdmin, cleanupWechatAdmin } from './wechat-admin.js';
import { renderHotTopicStudio, hideHotTopicStudio } from './hot-topic-studio.js';
import { openContentLibraryPicker, closeContentLibraryPicker } from './content-library-picker.js';
const navItems = [
  ['dashboard','dashboard','运营总览','推广、内容、活动转化与 AI 运营建议'],
  ['create','create','内容工作台','三路径工作台：自动化成片、素材智剪与 AIGC 创作'],
  ['platforms','accounts','平台启停','五个平台独立启停；未开启平台绝不唤醒；账号与智能回复统一管理，设备和登录状态集中展示在运行总览'],
  ['publish','publish','内容发布','本地选材、格式预检、合规审核和一键发布'],
  ['tasks','tasks','任务中心','区分已提交、审核中、已发布和审核失败'],
  ['messages','messages','评论与私信','真实采集、自动回复、转人工和处理状态'],
  ['miniProgram','messages','小程序对话','查看小程序文字咨询、AI 回复、回调与转人工状态'],
  ['handoffs','messages','转人工记录','只展示通知人工的会话与企业微信送达状态'],
  ['knowledge','knowledge','知识库','资料上传、小智测试和正式发布'],
  ['wechat','wecom','微信客服','人工接待、好友群发与机器人管理'],
  ['aliases','knowledge','相似问法库','AI生成、冲突检查、启用停用和知识联动'],
  ['xiaozhi','messages','小智','知识库回复效果即时测试，不经过平台轮询和 Local Agent'],
  ['browser','browser','浏览器控制','Web Access、Playwright、受管会话、诊断命令与执行证据'],
  ['issues','issues','问题汇总','千问、知识库、RPA、登录、发布和发送异常'],
  ['wecom','wecom','企微及 AI','企业微信通知、AI 服务配置和调用日志']
];
// Browser Control remains available in code/API for future Web Access rollout, but is hidden from the operator navigation until it is formally enabled.
const hiddenNavPages=new Set(['browser','aliases','issues']);
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
let knowledgeImportEnrichmentPollTimer=null;
let knowledgeImportScrollState={top:0,left:0};
let publishLayoutCleanup=null;
let publishSchedulePollTimer=null;
let pageRenderGeneration=0;
let pageRenderInFlightGeneration=0;
let bootstrapRequestGeneration=0;
let publishPrecheckRequestGeneration=0;
let miniProgramRenderGeneration=0;
let ragKnowledgePollTimer=null;
const ragDocumentStatusCache=new Map();
const ragReleaseStatusCache=new Map();
const ragReleaseBadgeCache=new Map();
const state={publishSchedules:[],page:'dashboard',dashboardRange:'7d',dashboardPlatform:'all',operationsDashboard:null,auth:null,appStarted:false,bootstrap:null,precheck:null,compliance:null,trafficPrediction:{status:'IDLE',result:null,error:null,requestToken:null,platformCodes:[]},contentGeneration:{status:'IDLE',stage:null,sourceType:null,materialSha256:null,result:null,error:null,titleDirty:false,bodyDirty:false,requestToken:null,applied:false,needsManualApply:false},knowledgeView:'rag',ragUploadStage:'IDLE',ragCurrentDocumentId:null,ragCurrentDocumentVersion:null,knowledgeCategory:null,knowledgeSubcategory:null,knowledgeImportPreview:null,knowledgeImportStage:'IDLE',knowledgeImportFailedStep:null,knowledgeCategoryData:null,knowledgeImportSelected:[],knowledgeImportExpanded:[],knowledgeImportDirty:[],knowledgeImportFilter:'ALL',knowledgeCreateExpanded:false,publishHistoryPage:1,materialPreviewUrl:null,wecomCategory:'ALL',settingsConfigPanel:null,messageView:'COMMENT',messageAccountId:null,miniProgramFilter:'ALL',miniProgramConversationId:null,miniProgramPendingActions:new Set(),taskPlatform:'ALL',taskStatus:'ALL',retryDraft:null,retrySourceTaskId:null,xiaozhiOptions:null,xiaozhiSession:null,xiaozhiChat:[],xiaozhiSettings:{platformCode:'douyin',messageType:'PRIVATE_MESSAGE',script:'auto',contextEnabled:true,scope:'pre_release',importBatchId:null,selectedDocumentId:null,selectedDocumentVersion:null}};
const $=s=>document.querySelector(s); const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const cleanText=v=>String(v??'').replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,'').replace(/\s{3,}/g,' ').trim();
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'—';
function fmtTaskPublishTime(value){if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';const pad=number=>String(number).padStart(2,'0');return `${date.getFullYear()}年${pad(date.getMonth()+1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`}
const STATUS_LABELS = Object.freeze({
  // 任务、发布与审核
  QUEUED:'待执行', EXECUTING:'执行中', RUNNING:'执行中', PROCESSING:'处理中', UPLOADED:'已上传', READY_FOR_TEST:'待测试', TESTED:'已测试', BUILDING:'构建中', PROCESS_FAILED:'处理失败', ROLLED_BACK:'已回滚',
  SUBMITTED:'已提交', REVIEWING:'审核中', PUBLISHED:'已发布', PUBLISHED_ON_PLATFORM:'平台已发布',
  REJECTED:'审核失败', SUCCESS:'执行成功', FAILED:'失败', PARTIAL_SUCCESS:'部分采集完成', PARTIAL_FAILED:'部分失败',
  RECOVERED:'已恢复', AUTO_RECOVERED:'已自动恢复', RECOVERED_BY_RETRY:'已补发成功',
  NEEDS_CONFIRMATION:'待人工确认', UNKNOWN:'待复核', NOT_SUBMITTED:'未提交',
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
  RAG_ANSWERED:'知识库已回复', RAG_NEED_CLARIFICATION:'需要补充信息', RAG_CLARIFICATION_LIMIT:'引导已达上限，转人工', KNOWLEDGE_GUIDANCE_LIMIT:'引导已达上限，转人工', RAG_SERVICE_UNAVAILABLE:'知识服务不可用',
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
function xiaozhiDisableReasonDialog(){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay xiaozhi-review-overlay';
    overlay.innerHTML=`<div class="confirm-dialog xiaozhi-review-dialog" role="dialog" aria-modal="true" aria-labelledby="xiaozhiReviewTitle"><div class="confirm-icon">!</div><h3 id="xiaozhiReviewTitle">将这条测试答案设为不启用</h3><p>不启用后，这条测试答案不会应用到正式用户端；原因会同步给 RAG，作为后续优化依据。</p><form class="xiaozhi-review-form"><label>原因类型<select name="reasonCode"><option value="ANSWER_INACCURATE">答案内容不准确</option><option value="SOURCE_INCORRECT">引用来源错误</option><option value="SHOULD_HANDOFF">应该转人工</option><option value="OTHER">其他</option></select></label><label>具体说明<textarea name="reason" rows="4" maxlength="500" placeholder="请说明哪里不符合预期" required>答案内容不准确</textarea></label><div class="confirm-actions"><button class="btn secondary xiaozhi-review-cancel" type="button">取消</button><button class="btn danger xiaozhi-review-submit" type="submit">确认不启用</button></div></form></div>`;
    document.body.appendChild(overlay);
    const form=overlay.querySelector('form');const reasonInput=form.elements.reason;
    const finish=value=>{overlay.remove();resolve(value)};
    overlay.querySelector('.xiaozhi-review-cancel').onclick=()=>finish(null);
    overlay.onclick=event=>{if(event.target===overlay)finish(null)};
    form.onsubmit=event=>{event.preventDefault();const reason=String(reasonInput.value||'').trim();if(!reason){reasonInput.focus();return}finish({reasonCode:String(form.elements.reasonCode.value||'ANSWER_INACCURATE'),reason})};
    setTimeout(()=>{reasonInput.focus();reasonInput.select()},0);
  });
}
function xiaozhiPublishConfirmDialog(){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay xiaozhi-publish-overlay';
    overlay.innerHTML=`<div class="confirm-dialog xiaozhi-review-dialog" role="dialog" aria-modal="true" aria-labelledby="xiaozhiPublishTitle"><div class="confirm-icon xiaozhi-publish-icon">✓</div><h3 id="xiaozhiPublishTitle">发布为正式版本</h3><p>将发布当前已完成测试的待测文档，并带上本次逐条“启用 / 不启用”结果。提交后 RAG 会异步构建，构建成功并成为当前正式版本后，才会应用到用户端。</p><div class="confirm-actions"><button class="btn secondary xiaozhi-publish-cancel" type="button">取消</button><button class="btn xiaozhi-publish-confirm" type="button">确认提交发布</button></div></div>`;
    document.body.appendChild(overlay);
    const finish=value=>{overlay.remove();resolve(value)};
    overlay.querySelector('.xiaozhi-publish-cancel').onclick=()=>finish(false);
    overlay.querySelector('.xiaozhi-publish-confirm').onclick=()=>finish(true);
    overlay.onclick=event=>{if(event.target===overlay)finish(false)};
    setTimeout(()=>overlay.querySelector('.xiaozhi-publish-confirm')?.focus(),0);
  });
}
function editKnowledgeDialog(item,{availableCategories=[],subcategoryMap={},defaultSubcategory='未分类'}={}){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay knowledge-edit-overlay';
    const selectedCategory=availableCategories.includes(item.category)?item.category:availableCategories[0];
    const categoryOptions=availableCategories.map(name=>`<option value="${esc(name)}" ${name===selectedCategory?'selected':''}>${esc(name)}</option>`).join('');
    overlay.innerHTML=`<div class="confirm-dialog knowledge-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledgeEditTitle"><div class="knowledge-edit-heading"><div><span>编辑知识 #${item.id}</span><h3 id="knowledgeEditTitle">修改知识内容</h3></div><button class="knowledge-edit-close" type="button" aria-label="关闭">×</button></div><p>知识大类固定为六个平台范围；小类可从最近使用记录选择或自定义。保存后版本号自动增加。</p><form class="knowledge-edit-form"><label class="full-field">标准问题<input name="question" maxlength="500" value="${esc(item.question||'')}" required></label><label class="full-field">标准答案<textarea name="answer" rows="6" maxlength="5000" required>${esc(item.answer||'')}</textarea></label><label class="full-field">关键词<input name="keywords" value="${esc(item.keywords||'')}" placeholder="多个关键词用逗号分隔"></label><label>知识大类<select class="knowledge-edit-category" name="category">${categoryOptions}</select></label><label>知识小类<select class="knowledge-edit-subcategory" name="subcategory"></select></label><label class="knowledge-edit-custom-subcategory" hidden>自定义小类<input name="customSubcategory" maxlength="30" placeholder="填写新的小类名称"></label><div class="knowledge-edit-note full-field">${item.status==='PUBLISHED'?'该知识当前已发布，保存后的内容会立即用于知识问答。':'该知识当前尚未发布，保存后仍保持原状态。'}</div><div class="confirm-actions full-field"><button class="btn secondary knowledge-edit-cancel" type="button">取消</button><button class="btn knowledge-edit-submit" type="submit">保存修改</button></div></form></div>`;
    document.body.appendChild(overlay);
    const form=overlay.querySelector('.knowledge-edit-form');
    const categorySelect=overlay.querySelector('.knowledge-edit-category');
    const subcategorySelect=overlay.querySelector('.knowledge-edit-subcategory');
    const customSubcategoryField=overlay.querySelector('.knowledge-edit-custom-subcategory');
    const customSubcategoryInput=customSubcategoryField.querySelector('input');
    const close=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
    const onKey=event=>{if(event.key==='Escape')close(null)};document.addEventListener('keydown',onKey);
    const toggleCustomSubcategory=()=>{const custom=subcategorySelect.value==='__CUSTOM__';customSubcategoryField.hidden=!custom;customSubcategoryInput.required=custom;if(custom)setTimeout(()=>customSubcategoryInput.focus(),0)};
    const fillSubcategories=initial=>{const category=categorySelect.value;const current=initial&&category===item.category?(item.subcategory||defaultSubcategory):defaultSubcategory;const names=[...new Set([defaultSubcategory,...(subcategoryMap[category]||[]),...(category===item.category?[item.subcategory]:[])].filter(Boolean))];subcategorySelect.innerHTML=names.map(name=>`<option value="${esc(name)}" ${name===current?'selected':''}>${esc(name)}</option>`).join('')+'<option value="__CUSTOM__">＋ 自定义小类</option>';toggleCustomSubcategory()};
    categorySelect.onchange=()=>fillSubcategories(false);subcategorySelect.onchange=toggleCustomSubcategory;fillSubcategories(true);
    overlay.querySelector('.knowledge-edit-close').onclick=()=>close(null);overlay.querySelector('.knowledge-edit-cancel').onclick=()=>close(null);overlay.onclick=event=>{if(event.target===overlay)close(null)};
    form.onsubmit=event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form));if(values.subcategory==='__CUSTOM__'&&!String(values.customSubcategory||'').trim())return toast('请填写自定义小类名称',true);close(values)};
  });
}
async function knowledgeAliasSelectionDialog(item){
  const [aliasData,taskData]=await Promise.all([api(`/api/knowledge-aliases?knowledgeId=${item.id}&limit=1000`),api('/api/knowledge-alias-generation-tasks?limit=500')]);
  const aliases=aliasData.aliases||[];
  const task=(taskData.tasks||[]).find(entry=>Number(entry.knowledge_id)===Number(item.id));
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay knowledge-alias-overlay';
    const rows=aliases.map(alias=>`<label class="knowledge-alias-choice ${alias.validation_status==='CONFLICT'?'has-conflict':''}"><input type="checkbox" value="${alias.id}" ${alias.status==='ENABLED'?'checked':''} ${alias.validation_status==='CONFLICT'?'disabled':''}><span><b>${esc(alias.alias_text)}</b><small>${alias.validation_status==='CONFLICT'?'与其他知识冲突，不能直接启用':`来源 ${esc(alias.source||'AI')} · 置信度 ${Math.round(Number(alias.confidence||0)*100)}%`}</small></span><em>${alias.status==='ENABLED'?'已启用':'未启用'}</em></label>`).join('');
    overlay.innerHTML=`<div class="confirm-dialog knowledge-alias-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledgeAliasTitle"><div class="knowledge-edit-heading"><div><span>知识 #${item.id} · 千问生成结果</span><h3 id="knowledgeAliasTitle">选择要启用的相似问法</h3></div><button class="knowledge-edit-close" type="button" aria-label="关闭">×</button></div><div class="knowledge-alias-source"><b>标准问题</b><p>${esc(item.question)}</p><small>当前共 ${aliases.length} 条相似问法${task?` · 最近任务：${esc(task.status)} · 生成 ${task.generated_count||0} 条`:''}</small></div><div class="knowledge-alias-toolbar"><button class="btn secondary alias-select-all" type="button">全选可用问法</button><button class="btn secondary alias-clear-all" type="button">全部取消</button><button class="btn secondary alias-dialog-regenerate" type="button">让千问重新生成</button></div><div class="knowledge-alias-choice-list">${rows||'<div class="empty">尚未生成相似问法，可以点击“让千问重新生成”。</div>'}</div><div class="confirm-actions"><span class="knowledge-alias-selected-count"></span><button class="btn secondary alias-dialog-cancel" type="button">取消</button><button class="btn alias-dialog-save" type="button" ${aliases.length?'':'disabled'}>保存启用选择</button></div></div>`;
    document.body.appendChild(overlay);
    const boxes=[...overlay.querySelectorAll('.knowledge-alias-choice input')];
    const update=()=>{const count=boxes.filter(box=>box.checked&&!box.disabled).length;overlay.querySelector('.knowledge-alias-selected-count').textContent=`已选择 ${count} 条`};
    const close=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
    const onKey=event=>{if(event.key==='Escape')close(null)};document.addEventListener('keydown',onKey);
    boxes.forEach(box=>box.onchange=update);update();
    overlay.querySelector('.alias-select-all').onclick=()=>{boxes.forEach(box=>{if(!box.disabled)box.checked=true});update()};
    overlay.querySelector('.alias-clear-all').onclick=()=>{boxes.forEach(box=>box.checked=false);update()};
    overlay.querySelector('.knowledge-edit-close').onclick=()=>close(null);overlay.querySelector('.alias-dialog-cancel').onclick=()=>close(null);
    overlay.querySelector('.alias-dialog-regenerate').onclick=async()=>{const button=overlay.querySelector('.alias-dialog-regenerate');button.disabled=true;try{await api(`/api/knowledge/${item.id}/aliases/regenerate`,{method:'POST',body:'{}'});toast('已交给千问重新生成，完成后再打开查看');close({regenerating:true})}catch(error){toast(error.message,true);button.disabled=false}};
    overlay.querySelector('.alias-dialog-save').onclick=()=>close({enabledIds:boxes.filter(box=>box.checked&&!box.disabled).map(box=>Number(box.value))});
    overlay.onclick=event=>{if(event.target===overlay)close(null)};
  });
}

async function manualHandoffAliasSelectionDialog(item){
  const [aliasData,taskData]=await Promise.all([api(`/api/manual-handoff-phrases/${item.id}/aliases`),api('/api/manual-handoff-alias-generation-tasks?limit=500')]);
  const aliases=aliasData.aliases||[];
  const task=(taskData.tasks||[]).find(entry=>Number(entry.phrase_id)===Number(item.id));
  const taskLabels={QUEUED:'等待生成',RUNNING:'千问生成中',COMPLETED:'生成完成',FAILED:'生成失败',CANCELLED:'已被新任务替代',DISCARDED:'旧版本结果已丢弃'};
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='confirm-overlay knowledge-alias-overlay';
    const aliasRows=aliases.map(alias=>`<label class="knowledge-alias-choice ${alias.validation_status==='CONFLICT'?'has-conflict':''}"><input type="checkbox" value="${alias.id}" ${alias.status==='ENABLED'?'checked':''} ${alias.validation_status!=='VALID'?'disabled':''}><span><b>${esc(alias.alias_text)}</b><small>${alias.validation_status==='CONFLICT'?esc(alias.validation_message||'与其他转人工说法冲突，不能启用'):`千问生成 · 仅勾选保存后才参与真实私信识别`}</small></span><em>${alias.status==='ENABLED'?'已启用':'未启用'}</em></label>`).join('');
    const taskText=task?`${taskLabels[task.status]||task.status}${task.generated_count?` · 生成 ${task.generated_count} 条`:''}`:'尚未生成';
    overlay.innerHTML=`<div class="confirm-dialog knowledge-alias-dialog" role="dialog" aria-modal="true" aria-labelledby="handoffAliasTitle"><div class="knowledge-edit-heading"><div><span>转人工说法 #${item.id} · 千问生成结果</span><h3 id="handoffAliasTitle">选择要启用的相似说法</h3></div><button class="knowledge-edit-close" type="button" aria-label="关闭">×</button></div><div class="knowledge-alias-source"><b>标准转人工说法</b><p>${esc(item.phrase)}</p><small>当前共 ${aliases.length} 条 · ${esc(taskText)}</small></div>${task?.status==='FAILED'?`<div class="handoff-alias-error">生成失败：${esc(task.error_message||'未知错误')}</div>`:''}<div class="handoff-alias-safety-note"><b>安全规则：</b>AI 生成结果默认不启用。只有你勾选并保存的完整说法，才会在私信中触发转人工；评论区仍不会直接转人工。</div><div class="knowledge-alias-toolbar"><button class="btn secondary alias-select-all" type="button">全选可用说法</button><button class="btn secondary alias-clear-all" type="button">全部取消</button><button class="btn secondary alias-dialog-regenerate" type="button">让千问重新生成</button></div><div class="knowledge-alias-choice-list">${aliasRows||'<div class="empty">相似说法尚未生成完成，可以稍后再打开，或点击“让千问重新生成”。</div>'}</div><div class="confirm-actions"><span class="knowledge-alias-selected-count"></span><button class="btn secondary alias-dialog-cancel" type="button">取消</button><button class="btn alias-dialog-save" type="button" ${aliases.length?'':'disabled'}>保存启用选择</button></div></div>`;
    document.body.appendChild(overlay);
    const boxes=[...overlay.querySelectorAll('.knowledge-alias-choice input')];
    const update=()=>{const count=boxes.filter(box=>box.checked&&!box.disabled).length;overlay.querySelector('.knowledge-alias-selected-count').textContent=`已选择 ${count} 条`};
    const close=value=>{document.removeEventListener('keydown',onKey);overlay.remove();resolve(value)};
    const onKey=event=>{if(event.key==='Escape')close(null)};document.addEventListener('keydown',onKey);
    boxes.forEach(box=>box.onchange=update);update();
    overlay.querySelector('.alias-select-all').onclick=()=>{boxes.forEach(box=>{if(!box.disabled)box.checked=true});update()};
    overlay.querySelector('.alias-clear-all').onclick=()=>{boxes.forEach(box=>box.checked=false);update()};
    overlay.querySelector('.knowledge-edit-close').onclick=()=>close(null);overlay.querySelector('.alias-dialog-cancel').onclick=()=>close(null);
    overlay.querySelector('.alias-dialog-regenerate').onclick=async()=>{const button=overlay.querySelector('.alias-dialog-regenerate');button.disabled=true;button.textContent='正在提交…';try{await api(`/api/manual-handoff-phrases/${item.id}/aliases/regenerate`,{method:'POST',body:JSON.stringify({requestedBy:'运营人员'})});toast('已交给千问重新生成，生成结果默认不启用');close({regenerating:true})}catch(error){toast(error.message,true);button.disabled=false;button.textContent='让千问重新生成'}};
    overlay.querySelector('.alias-dialog-save').onclick=()=>close({enabledIds:boxes.filter(box=>box.checked&&!box.disabled).map(box=>Number(box.value))});
    overlay.onclick=event=>{if(event.target===overlay)close(null)};
  });
}

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
    overlay.innerHTML=`<div class="confirm-dialog reply-export-dialog" role="dialog" aria-modal="true" aria-labelledby="replyExportTitle"><div class="reply-export-heading"><div class="reply-export-icon" aria-hidden="true">导</div><div><h3 id="replyExportTitle">导出回复记录</h3><p>选择要导出的平台，文件会包含评论和私信中已经完成的 AI 回复、人工回复记录。</p></div><button class="knowledge-edit-close reply-export-close" type="button" aria-label="关闭">×</button></div><label class="reply-export-select-all"><input type="checkbox" class="reply-export-all"><span><b>一键全选</b><small>选择全部平台的回复记录</small></span></label><div class="reply-export-platforms">${platforms.map(item=>`<label class="reply-export-platform"><input type="checkbox" name="replyExportPlatform" value="${esc(item.code)}" ${item.code===initialCode?'checked':''}><span><b>${esc(item.name)}</b><small>导出该平台全部已完成回复</small></span><i>✓</i></label>`).join('')}</div><div class="reply-export-note">导出格式为 CSV，可直接使用 Excel 打开。只导出已经确认回复成功或已人工处理且未删除的记录，不会把“待回复”“回复失败”或已删除记录混在里面。</div><div class="confirm-actions"><button class="btn secondary reply-export-cancel" type="button">取消</button><button class="btn reply-export-submit" type="button">导出所选平台</button></div></div>`;
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
    if(!response.ok){const data=await response.json().catch(()=>({}));if(response.status===401)queueMicrotask(()=>showLoginScreen('Session expired'));const error=new Error(data.message||`导出失败（HTTP ${response.status}）`);error.status=response.status;throw error}
    const blob=await response.blob();const disposition=response.headers.get('Content-Disposition')||'';const encodedName=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];const filename=encodedName?decodeURIComponent(encodedName):'平台回复记录.csv';
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    const count=Number(response.headers.get('X-Export-Count')||0);toast(count?`已导出 ${count} 条回复记录`:'回复记录已导出');
  }finally{if(button){button.disabled=false;button.innerHTML=original}}
}
/* ==========================================================================
   分组工作区导航（智慧驱动版）
   - 侧边栏按运营任务分组；组内页面通过顶部子导航切换。
   - 内容创作统一使用三路径工作台；旧创作入口兼容跳转到 #studio。
   - 发布管理独立保留；hiddenNavPages 仅隐藏导航，不影响对应页面访问。
   ========================================================================== */
const workspaceGroups=[
  {id:'overview',label:'运营总览',icon:'dashboard',section:'work',description:'推广、内容、活动转化与 AI 运营建议。',items:[
    {key:'overview',label:'运营总览',page:'dashboard'}]},
  {id:'content',label:'内容工作台',icon:'create',section:'work',description:'自动化成片、素材智剪与 AIGC 创作，生成结果统一进入成片库。',items:[
    {key:'studio',label:'视频创作工作台',page:'create'}]},
  {id:'publishing',label:'发布管理',icon:'publish',section:'work',description:'素材预检、审核、发布排期与任务状态，继续使用运营系统的发布流程。',items:[
    {key:'publishing',label:'发布与排期',page:'publish'},
    {key:'publish-tasks',label:'发布任务',page:'tasks'}]},
  {id:'inbox',label:'用户互动',icon:'messages',section:'work',description:'统一处理平台评论、私信、小程序会话与需要人工接手的记录。',items:[
    {key:'comments',label:'评论',page:'messages',view:'COMMENT'},
    {key:'private-messages',label:'私信',page:'messages',view:'PRIVATE_MESSAGE'},
    {key:'mini-program',label:'小程序对话',page:'miniProgram'},
    {key:'human-handoffs',label:'转人工记录',page:'handoffs'}]},
  {id:'wechat',label:'微信客服',icon:'wecom',section:'work',description:'处理微信人工接待、好友群发与机器人管理。',items:[
    {key:'wechat-service',label:'微信客服',page:'wechat'}]},
  {id:'knowledge',label:'知识与回复',icon:'knowledge',section:'work',description:'维护知识和应答规则，通过回复测试验证效果后再发布。',items:[
    {key:'documents',label:'知识资料',page:'knowledge',view:'rag'},
    {key:'aliases',label:'相似问法',page:'aliases'},
    {key:'handoff-rules',label:'转人工说法',page:'knowledge',view:'handoff'},
    {key:'reply-test',label:'回复测试',page:'xiaozhi',hint:'小智'}]},
  {id:'channels',label:'平台与账号',icon:'accounts',section:'manage',description:'管理平台启停、账号、登录状态与浏览器执行环境。',items:[
    {key:'accounts',label:'平台启停与账号',page:'platforms'},
    {key:'browser-tools',label:'浏览器控制',page:'browser',hint:'高级'}]},
  {id:'settings',label:'系统设置',icon:'workspace-settings',section:'manage',description:'配置通知与 AI 服务，集中查看调用记录与运行问题。',items:[
    {key:'services',label:'通知与 AI 服务',page:'wecom'},
    {key:'diagnostics',label:'问题汇总',page:'issues'}]}
];
const workspaceLastRoute={};
let workspaceNavigationSequence=0;
function currentWorkspaceRoute(){
  const view=state.page==='messages'?state.messageView:state.page==='knowledge'?state.knowledgeView:null;
  for(const group of workspaceGroups){const item=group.items.find(i=>i.page===state.page&&(!i.view||i.view===view));if(item)return {group,item}}
  for(const group of workspaceGroups){const item=group.items.find(i=>i.page===state.page);if(item)return {group,item}}
  return {group:workspaceGroups[0],item:workspaceGroups[0].items[0]};
}
function openWorkspaceGroup(id){
  const group=workspaceGroups.find(g=>g.id===id);if(!group)return;
  const visible=group.items.filter(i=>!hiddenNavPages.has(i.page));
  const pool=visible.length?visible:group.items;
  const remembered=workspaceLastRoute[id];
  const item=pool.find(i=>i.key===remembered)||pool[0];
  navigate(item.page,item.view||null);
}
function openWorkspaceItem(key){
  for(const group of workspaceGroups){const item=group.items.find(i=>i.key===key);if(item){navigate(item.page,item.view||null);return}}
}
function syncWorkspaceNavigation(){
  const {group,item}=currentWorkspaceRoute();
  workspaceLastRoute[group.id]=item.key;
  document.body.dataset.workspace=group.id;
  const title=$('#pageTitle'),subtitle=$('#pageSubtitle');
  if(title)title.textContent=group.label;
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
function commitBootstrap(bootstrap){state.bootstrap=bootstrap;$('#qwenMode').textContent=`\u5343\u95ee\uff1a${state.bootstrap.config.qwenMode==='mock'?'\u6a21\u62df':'\u5728\u7ebf'}`;syncMasterSwitch();const online=isLocalAgentOnline();setStatus('#cloudDot','#cloudStatus',true,'\u6b63\u5e38');setStatus('#agentDot','#agentStatus',online,online?'\u5728\u7ebf':'\u672a\u8fde\u63a5')}
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
function navigate(p,view=null){
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
  }).finally(()=>{if(sequence===workspaceNavigationSequence)$('#content').setAttribute('aria-busy','false')});
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
  navigate(target.page,target.view||null);
  return true;
}
window.addEventListener('hashchange',()=>{if(!state.appStarted)return;applyWorkspaceHash(location.hash)});
async function render(){
  cleanupWechatAdmin();
  hideHotTopicStudio();
  $('#content').onclick=null;$('#content').oninput=null;$('#content').onchange=null;
  const page=state.page;
  const generation=++pageRenderGeneration;
  pageRenderInFlightGeneration=generation;
  const ownsRender=()=>generation===pageRenderGeneration&&state.page===page;
  try{
    const bootstrap=await refreshBootstrap({page,pageGeneration:generation});
    if(!bootstrap||!ownsRender())return;
    if(page==='wechat')return renderWechatAdmin($('#content'));
    const renderer=({dashboard:renderDashboard,create:renderContentStudio,editing:renderMaterialEditor,publish:renderPublish,tasks:renderTasks,messages:renderMessages,miniProgram:renderMiniProgramConversations,handoffs:renderManualHandoffs,knowledge:renderKnowledge,aliases:renderKnowledgeAliases,xiaozhi:renderXiaozhi,browser:renderBrowserControl,issues:renderIssues,wecom:renderWecom,platforms:renderPlatformRuntimePage}[page]||renderDashboard);
    return page==='publish'||page==='miniProgram'?await renderer({pageGeneration:generation}):await renderer();
  }catch(error){
    if(!ownsRender())return;
    throw error;
  }finally{if(pageRenderInFlightGeneration===generation)pageRenderInFlightGeneration=0}
}
function metric(l,v,h,tone,icon,target){return `<button type="button" class="metric metric-action" data-go="${target}" aria-label="查看${l}" style="--metric-tone:${tone}"><div class="metric-top"><span class="metric-icon">${iconSvg(icon)}</span><span class="metric-live">查看 →</span></div><span class="metric-label">${l}</span><div class="metric-value"><strong>${v}</strong><i></i></div><small>${h}</small></button>`}
function aiUsageMetric(summary={}){const calls=Number(summary.calls||0).toLocaleString('zh-CN');const tokens=Number(summary.total_tokens||0).toLocaleString('zh-CN');return metric('今日 AI 用量',`${calls} 次`,`Token ${tokens} · 估算费用 ${aiCostValue(summary.estimated_cost_cny)}`,'#6455d9','wecom','wecom')}
/* ==========================================================================
   运营总览看板（智慧驱动）
   数据来源：GET /api/operations-dashboard（服务端按既有业务表聚合）
   口径约定：未接入数据源的指标由服务端标记 PENDING_SOURCE，前端一律显示
   「待接入」并注明所需数据源，不编造任何数值。
   ========================================================================== */
const operationsRangeLabels={'7d':'近 7 天','30d':'近 30 天'};
/* 已加载的看板筛选键（range|platform）。为空或与当前筛选不一致时才重新请求，
   避免仪表盘每次重绘、每次定时刷新都打一次接口。 */
let operationsDashboardKey=null;
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
  const params=new URLSearchParams({range:state.dashboardRange,platform:state.dashboardPlatform});
  try{
    const d=await api(`/api/operations-dashboard?${params.toString()}`);
    state.operationsDashboard=d.dashboard||null;
  }catch(error){
    state.operationsDashboard={error:error.message,kpis:[],channels:[],content:[],funnel:[],trend:[],recommendations:[],updatedAt:null};
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
    channels:Array.isArray(d.channels)?d.channels:[],
    content:Array.isArray(d.content)?d.content:[],
    funnel:Array.isArray(d.funnel)?d.funnel:[],
    recommendations:Array.isArray(d.recommendations)?d.recommendations:[],
    trend:Array.isArray(d.trend)?d.trend:[]
  };
}
function operationsSectionTitle(number,title,description){return `<div class="operations-section-title"><span>${number}</span><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div></div>`}
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
async function renderDashboard(){
  const generation=pageRenderGeneration;
  const key=`${state.dashboardRange}|${state.dashboardPlatform}`;
  if(operationsDashboardKey!==key){
    operationsDashboardKey=key;
    await loadOperationsDashboard();
    if(generation!==pageRenderGeneration||state.page!=='dashboard')return;
  }
  const data=operationsDashboardData();
  const running=state.bootstrap.config.masterSwitch?.enabled!==false;
  const publishedKpi=data.published;
  const maxPublished=Math.max(...data.channels.map(item=>Number(item.published)||0),1);
  const hasPendingKpi=data.kpis.some(item=>item.status!=='READY');
  const updatedAt=data.updatedAt?new Date(data.updatedAt):null;
  const updatedText=updatedAt&&!Number.isNaN(updatedAt.getTime())?fmt(updatedAt.toISOString()):'刚刚';
  const topPublished=[...data.channels].sort((a,b)=>(Number(b.published)||0)-(Number(a.published)||0))[0];
  const funnelOf=key=>data.funnel.find(item=>item.key===key);
  const defaultPlatforms=[
    {code:'douyin',name:'抖音'},{code:'xiaohongshu',name:'小红书'},{code:'wechat_channels',name:'视频号'},
    {code:'bilibili',name:'B站'},{code:'weibo',name:'微博'}
  ];
  const channelOptions=data.channels.length?data.channels:defaultPlatforms;
  $('#content').innerHTML=`<div class="operations-dashboard">
    <div class="operations-overview-head">
      <div><span>01 · CORE OPERATIONS</span><h2>核心运营指标</h2><p>口径：${esc(operationsRangeLabels[state.dashboardRange]||'近 7 天')} · ${state.dashboardPlatform==='all'?'全部平台':'单平台'} · 数据更新时间：${esc(updatedText)}</p></div>
      <div class="operations-filters">
        <label><span>平台</span><select id="operationsPlatformFilter" aria-label="平台筛选"><option value="all">全部平台</option>${channelOptions.map(item=>`<option value="${esc(item.code)}"${state.dashboardPlatform===item.code?' selected':''}>${esc(item.name)}</option>`).join('')}</select></label>
        <label><span>周期</span><select id="operationsRangeFilter" aria-label="统计周期"><option value="7d"${state.dashboardRange==='7d'?' selected':''}>近 7 天</option><option value="30d"${state.dashboardRange==='30d'?' selected':''}>近 30 天</option></select></label>
      </div>
    </div>
    ${running?'':`<div class="operations-pause-banner"><span>II</span><div><b>全局运行与 Local Agent 已停止</b><p>运营数据仍可查看，但当前不会领取新任务。</p></div><button type="button" data-master-resume>\u542f\u52a8 Agent \u5e76\u6062\u590d\u8fd0\u884c</button></div>`}
    ${data.error?`<div class="notice warn"><span class="notice-icon">!</span><div><b>运营看板数据读取失败</b><p>${esc(data.error)}</p></div></div>`:''}
    ${hasPendingKpi?`<div class="notice info operations-source-notice"><span class="notice-icon">i</span><div><b>部分指标待接入数据源</b><p>${esc(data.pendingNote)}。当前已真实统计的指标：发布量、内容清单与 AI 运营建议；曝光、关注、引流、报名、到场、入群在接入平台与活动系统前一律显示「待接入」，系统不会用估算值填充。</p></div></div>`:''}
    <section class="operations-kpi-grid" aria-label="核心运营指标">${data.kpis.map(item=>`<article class="operations-kpi${item.status==='READY'?'':' is-pending'}"><div class="operations-kpi-head"><span class="operations-kpi-icon">${iconSvg(item.icon)}</span><span class="operations-kpi-label">${esc(item.label)}</span></div><strong>${operationsKpiValue(item)}</strong><p>${item.status==='READY'?`<b>${esc(item.scope||'本周期')}</b><span>${esc(item.note||'按发布时间统计')}</span>`:`<span>${esc(item.pendingNote||'需要接入数据源')}</span>`}</p></article>`).join('')}</section>
    <div class="operations-analysis-grid">
      <section class="operations-surface operations-trend-panel">
        <header>${operationsSectionTitle('02','推广趋势','曝光、关注与引流的每日变化')}<div class="operations-legend"><span><i class="is-exposure"></i>曝光</span><span><i class="is-followers"></i>关注</span><span><i class="is-leads"></i>引流</span></div></header>
        <div class="operations-chart">${operationsTrendChart(data.trend)}</div>
      </section>
      <section class="operations-surface operations-channel-panel">
        <header>${operationsSectionTitle('03','渠道效果','各平台发布量与曝光、引流贡献')}</header>
        <div class="operations-channel-summary">
          <div><span>发布量最高</span><strong>${topPublished&&topPublished.published?`${esc(topPublished.name)} ${operationsFormat('published',topPublished.published)} 条`:'待接入'}</strong></div>
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
        <p class="operations-funnel-note">活动转化需要对接活动报名与现场签到数据；接入前不展示推算值。</p>
      </section>
    </div>
    <section class="operations-ai-panel">
      <div class="operations-ai-intro"><span>06 · AI OPERATIONS</span><div class="operations-section-title"><i>AI</i><div><h2>AI 运营建议</h2><p>基于本系统真实任务、互动与知识数据生成的今日优先动作</p></div></div><small>${iconSvg('dashboard')}当前周期发布量 ${publishedKpi&&publishedKpi.status==='READY'?operationsFormat('published',publishedKpi.value):'待接入'} 条</small></div>
      <div class="operations-recommendations">${data.recommendations.length?data.recommendations.map(item=>`<article><div><span>${esc(item.type)}</span><em>${esc(item.priority)}</em></div><strong>${esc(item.title)}</strong><p>${esc(item.description)}</p><button type="button" data-go="${esc(item.target)}">${esc(item.actionLabel)} <span>→</span></button></article>`).join(''):'<article><div><span>数据不足</span><em>提示</em></div><strong>暂无可生成的运营建议</strong><p>当系统产生发布、互动或知识缺口记录后，这里会自动给出优先动作。</p><button type="button" data-go="publish">去创建内容 <span>→</span></button></article>'}</div>
    </section>
  </div>
  ${dashboardRuntimeMarkup()}`;
  bindOperationsDashboard();
  bindDashboardRuntime();
}
function bindOperationsDashboard(){
  document.querySelectorAll('#content [data-go]').forEach(button=>button.onclick=()=>navigate(button.dataset.go));
  const resume=$('[data-master-resume]');if(resume)resume.onclick=()=>toggleMasterSwitch();
  const platformFilter=$('#operationsPlatformFilter');
  if(platformFilter)platformFilter.onchange=()=>{state.dashboardPlatform=platformFilter.value;refreshOperationsDashboard()};
  const rangeFilter=$('#operationsRangeFilter');
  if(rangeFilter)rangeFilter.onchange=()=>{state.dashboardRange=rangeFilter.value;refreshOperationsDashboard()};
}
async function refreshOperationsDashboard(){
  if(state.page!=='dashboard')return;
  $('#content').setAttribute('aria-busy','true');
  try{operationsDashboardKey=null;await renderDashboard()}catch(error){toast(error.message,true)}
  finally{$('#content').setAttribute('aria-busy','false')}
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

  return `    <div class="section-title"><div><span>07 · EXECUTION ENVIRONMENT</span><h2>执行环境与实时指标</h2></div><p>RPA 设备、五平台登录状态与任务流转实时数据</p></div>
    <div class="grid cols-3 metric-grid">
      ${metric('转人工记录',s.handoffRecords,'已创建的人工接管通知','#ef6a71','issues','handoffs')}
      ${metric('AI 已回复',s.autoReplies,'自动处理完成','#35b68a','messages','messages')}
      ${aiUsageMetric(s.aiUsageToday)}    </div>
    <div class="panel platform-login-overview dashboard-runtime-overview${deviceHealthy?'':' has-device-alert'}">
      <div class="panel-head dashboard-runtime-head"><div><span class="panel-kicker">EXECUTION ENVIRONMENT</span><h2>执行环境与五平台登录</h2><p>RPA 设备与平台登录状态集中展示，避免在平台启停页面重复维护。<br>${esc(loginAuditText)}</p></div><div class="button-row"><button class="btn secondary" id="dashboardOpenPlatforms">一键打开已开启平台</button><button class="btn" id="dashboardCheckPlatforms">一键检查登录状态</button><button class="btn ghost" type="button" data-go="platforms">平台启停</button></div></div>
      <div class="dashboard-runtime-layout">
        <section class="dashboard-runtime-zone dashboard-device-zone">
          <div class="dashboard-runtime-zone-head"><div><span>RPA DEVICE</span><h3>RPA 执行设备</h3></div><strong class="dashboard-zone-stat ${deviceHealthy?'is-healthy':'is-alert'}" id="dashboardDeviceSummaryCount">${devices.length?`${onlineDeviceCount}/${devices.length} 在线`:'暂无设备'}</strong></div>
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
        <div class="notice warn operations-notice"><span class="notice-icon">!</span><div><b>发布状态安全口径</b><p>RPA 检测到提交成功仅记为“已提交”；平台管理页可靠确认后才记为“已发布”。结果不明确时立即停止并转人工确认。</p></div></div>
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
        <div class="panel-head"><div><h2>1. 选择本地素材与文案</h2><p>素材留在RPA电脑，选择后自动识别视频格式，并按所选平台分别预检。</p></div></div>
        <div class="section-actions library-publish-actions"><button type="button" class="btn secondary" id="pickFromContentLibrary">从成片库选择</button></div>
        <label>本地素材</label>
        <label class="field full local-material-path-field"><span>本机素材路径（文件选择器不可用时可直接粘贴）</span><input id="materialPath" name="materialPath" type="text" placeholder="例如 D:\素材\video.mp4" autocomplete="off" required></label>
        <div id="materialPreview" class="material-preview material-preview-empty material-picker" role="button" tabindex="0" aria-label="选择本地素材">
          <div class="material-picker-placeholder"><span class="material-picker-icon" aria-hidden="true">＋</span><b>点击选择本地素材</b><span>支持 JPG、PNG、WEBP、MP4、MOV</span><small>素材保留在本机，选择后自动预览并检测格式</small></div>
        </div>
        <div id="precheckBox" class="notice material-check"><b>素材状态：等待上传</b><br>上传后仅展示视频格式与所选平台适配状态。</div>
        <div class="section-actions audio-copy-actions"><button type="button" class="btn secondary" id="generateAudioCopy">AI 生成标题和文案</button><button type="button" class="btn secondary" id="applyAudioCopy" hidden>使用 AI 结果</button></div>
        <div id="audioCopyBox" class="ai-status-card is-idle is-generation" role="status" aria-live="polite">${aiStatusMarkup({variant:'generation',state:'idle',eyebrow:'AI CONTENT ENGINE',title:'AI 文案引擎待命',description:'上传图片时理解画面与可见文字；上传带音轨视频时根据音频生成标题和正文。',stages:['素材理解','主题提炼','文案润色','风险校验']})}</div>
        <label>标题</label><input id="publishTitle" name="title" maxlength="20" required placeholder="不超过20字（按当前最严格口径）">
        <label>正文</label><textarea id="publishBody" name="body" rows="7" required placeholder="填写正式运营内容，不要填写测试、RPA、发布后删除等字样"></textarea>
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
            <span class="publish-action-copy"><b class="publish-action-title">重新检测素材格式</b><small class="publish-action-detail">校验文件参数与平台适配</small></span>
            <span class="publish-action-arrow" aria-hidden="true">›</span>
          </button>
          <button type="button" class="btn secondary publish-action-card publish-compliance-action" id="runCompliance">
            <span class="publish-action-icon publish-action-ai" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.5 14 8l4.5 2-4.5 2-2 4.5-2-4.5-4.5-2L10 8l2-4.5Z"></path><path d="m18 15 .9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15Z"></path></svg></span>
            <span class="publish-action-copy"><b class="publish-action-title">AI 审核内容与图片</b><small class="publish-action-detail">检查文案、来源与代表画面</small></span>
            <span class="publish-action-live" aria-hidden="true"><i></i>AI</span>
          </button>
        </div>
        </div>
      </div>
      <div class="publish-column publish-side-column">
        <div class="panel" style="margin-top:0">
        <div class="panel-head"><div><h2>2. 选择平台账号并授权</h2><p>抖音、视频号、B站和微博分别绑定独立浏览器 Profile；小红书暂缓调试，未验收。</p></div><div class="platform-select-actions"><span id="platformSelectionSummary">已选 0/0</span><button type="button" class="btn secondary platform-select-all" id="selectAllPlatforms" aria-pressed="false">全选平台</button></div></div>
        ${accountAvailability.length?accountAvailability.map(({account:a,availability:v})=>`<label class="check-card publish-platform-card ${v.runnable?'is-runnable':'is-blocked'}"><input type="checkbox" class="platform-check" data-platform="${esc(a.platform_code)}" data-account="${a.id}" ${v.runnable?'':'disabled'}><span><span class="publish-platform-title"><b>${esc(a.platform_name)} · ${esc(a.display_name)}</b><i class="badge ${v.cls}">${esc(v.label)}</i></span><small>${esc(v.detail)}</small></span></label>`).join(''):'<div class="empty"><b>当前没有已配置的五平台账号</b><br>请先到“平台启停”检查账号和登录状态。</div>'}
        ${blockedAccounts.length?`<div class="notice warn publish-platform-blocked-notice"><b>${blockedAccounts.length} 个平台当前不可选择</b><br>请检查账号、登录、Local Agent、平台开关，或处理关联问题。<div class="section-actions"><button type="button" class="btn secondary" data-go="issues">查看问题汇总</button><button type="button" class="btn secondary" data-go="platforms">查看平台启停</button></div></div>`:''}
        <div class="notice info"><b>素材适配：</b>B站当前仅接视频投稿；微博支持图文和视频。系统不自动裁切或转码，请以平台适配状态为准。</div>
        <div id="complianceBox" class="ai-status-card is-idle is-review" role="status" aria-live="polite">${aiStatusMarkup({variant:'review',state:'idle',eyebrow:'AI SAFETY SCANNER',title:'AI 审核引擎待命',description:'填写文案并选择素材后，可联合检查标题、正文、内容来源及图片或视频代表画面。',stages:['文案校验','来源核对','代表帧抽取','画面识别','结果汇总'],bodyHtml:trafficPredictionMarkup()})}</div>
        <label class="check-card"><input id="warningConfirmed" type="checkbox"><span><b>我已人工核对 AI 审核警告</b><small>仅在 AI 返回警告时需要；阻断项和审核失败不能放行。</small></span></label>
        <label class="check-card"><input id="autoPublish" type="checkbox"><span><b>授权RPA点击最终“发布”按钮</b><small>勾选后按平台逐一提交；未勾选仅准备草稿并等待人工确认。</small></span></label>
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
        <section id="publishHistory" class="publish-queue-board publish-history-panel"><div class="loading compact-loading">正在加载曾经发布过的记录…</div></section>
      </div>
    </section>
  </form>`;

  resetAudioContentGeneration();
  const materialInput=$('#materialPath');
  const materialPicker=$('#materialPreview');
  $('#pickFromContentLibrary').onclick=()=>openContentLibraryPicker({onSelect:publishContentLibraryItem,onUnauthorized:()=>showLoginScreen('登录已过期，请重新登录')});
  let materialPickerBusy=false;
  const openMaterialPicker=async()=>{
    if(materialPickerBusy)return;
    materialPickerBusy=true;
    materialPicker.classList.add('is-picking');
    materialPicker.setAttribute('aria-busy','true');
    toast('正在打开本地文件选择窗口，请在弹窗中选择素材');
    try{
      const d=await agent('/pick-file',{method:'POST',body:'{}'});
      if(!ownsPage()||!materialInput.isConnected)return;
      if(d.cancelled){toast('已取消选择文件');return}
      materialInput.value=d.materialPath;
      state.precheck=null;state.materialPreviewUrl=null;resetAudioContentGeneration();invalidateCompliance();
      $('#precheckBox').className='notice material-check info';
      $('#precheckBox').innerHTML='<b>素材状态：正在自动检测…</b><br>正在识别视频格式并准备平台适配检测。';
      await runPrecheck(true,{pageGeneration});
    }catch(e){if(ownsPage()&&materialInput.isConnected){showMaterialCheckError(e.message);toast(e.message,true)}}
    finally{
      materialPickerBusy=false;
      materialPicker.classList.remove('is-picking');
      materialPicker.removeAttribute('aria-busy');
    }
  };
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
  const label=!hasPlatformScope?'视频格式已识别，待选择平台':overall==='PASSED'?'平台适配检测通过':overall==='WARNING'?'平台适配需人工确认':'平台适配未通过';
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
  return `<header class="queue-board-head history-board-head"><div class="queue-board-heading"><span class="queue-board-icon history-board-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7.5h14M7 4.5h10a2 2 0 0 1 2 2v13H5v-13a2 2 0 0 1 2-2Z"></path><path d="m9 13 2 2 4-4"></path></svg></span><div><span class="queue-board-eyebrow">历史结果</span><h3>曾经发布过的记录</h3><p>按最新发布时间排列，展开记录可以查看详细内容。</p></div></div><span class="queue-board-count">${data.total||0}<small>条记录</small></span></header>
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
  renderAiStatus(box,{variant:'generation',state:'idle',eyebrow:'AI CONTENT ENGINE',title:'AI 文案引擎待命',description:ui.idleDescription,stages,footer:ui.idleFooter});
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
      if(actionTitle)actionTitle.textContent='重新检测素材格式';
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
    if(button){button.disabled=false;button.classList.remove('is-ai-running');button.setAttribute('aria-busy','false');const actionTitle=button.querySelector('.publish-action-title');const actionDetail=button.querySelector('.publish-action-detail');if(actionTitle)actionTitle.textContent='AI 审核内容与图片';if(actionDetail)actionDetail.textContent='检查文案、来源、代表画面与平台潜力'}
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
  return {title,body,materialPath,contentOrigin,targets,precheck:state.precheck,materialMeta:state.precheck?.meta||{},aiReview:state.compliance,complianceConfirmed:$('#warningConfirmed').checked,publishMode:$('#autoPublish').checked?'AUTO':'DRAFT_ONLY',managementConfirmed:$('#autoPublish').checked,retryOfTaskId:state.retrySourceTaskId};
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
  return `<div class="task-platform-tabs" role="tablist" aria-label="按发布平台筛选任务">${tabs.map(item=>{const active=state.taskPlatform===item.code;const hint=item.code==='ALL'?'查看所有平台任务':item.ready?'辅助浏览器链路已接入':'当前使用模拟适配器';return `<button type="button" class="task-platform-tab ${active?'active':''} ${item.ready?'ready':'pending'}" data-task-platform="${esc(item.code)}" role="tab" aria-selected="${active}"><span class="task-platform-icon">${esc(taskPlatformIcon(item.code))}</span><span><b>${esc(item.name)}</b><small>${esc(hint)}</small></span><em>${item.task_count}</em></button>`}).join('')}</div>`;
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
  const canVerify=!terminal&&Boolean(result.verificationRequired===true||target.submission_status==='SUBMITTED'||target.submit_lock==='LOCKED'||['DRAFT_BLOCKED','SUBMITTING','SUBMIT_ATTEMPTED_UNCONFIRMED','SUBMITTED','REVIEWING','UNKNOWN'].includes(target.publish_attempt_state)||['SUBMITTED','REVIEWING','SYNCING','NEEDS_CONFIRMATION'].includes(target.status));
  const jobStatus=String(target.verification_job_status||'').toUpperCase();
  const source=String(target.verification_source||'').toUpperCase();
  let scheduleLabel='';
  if(jobStatus==='RUNNING')scheduleLabel='正在核验平台状态';
  else if(jobStatus==='QUEUED'&&source==='MANUAL')scheduleLabel='人工核验已排队，等待当前平台操作完成';
  else if(jobStatus==='QUEUED'&&target.next_verification_at)scheduleLabel=`下次自动核验：${fmt(target.next_verification_at)}`;
  else if(target.last_checked_at)scheduleLabel=`上次核验：${fmt(target.last_checked_at)}`;
  const buttonLabel=jobStatus==='RUNNING'?'正在核验…':jobStatus==='QUEUED'&&source==='MANUAL'?'人工核验已排队':'立即查询平台状态';
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
  if(bilibiliBlock){label=bilibiliBlock.label;detail=bilibiliBlock.detail;}
  else if(required&&target.publish_attempt_state==='SUBMIT_ATTEMPTED_UNCONFIRMED')label='已提交平台，但状态尚未确认；请先查询平台状态，如平台已发布可人工确认';
  else if(required&&result.draftSaved===true)label='自动发布未成功，草稿已保存，需要人工处理';
  else if(required&&(result.draftPreservedInBrowser===true||result.draftSaved===true||result.draftExists===true))label='自动发布未成功，草稿已确认保留，需要人工处理';
  else if(required&&target.publish_attempt_state==='DRAFT_BLOCKED')label='自动发布未成功，当前没有确认到草稿，需要重新准备后再发送';
  else if(required)label='自动发布未成功，需要人工处理';
  return {required,canOpen:required,canConfirm:required,label,detail,reason:bilibiliBlock?.reason||null};
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
      manual.canConfirm?`<button type="button" class="btn success task-target-action confirm-manual-published" data-target-id="${target.id}">人工已发布</button>`:'' ]
      .filter(Boolean).join('');
    const actionLabel=manual.label||draft.label;
    const executionLabel=recovered?`已补发成功（原记录：${statusName(target.status)}）`:statusName(target.status);
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
    toast(`${platformName(platformCode)}已打开；请核对本次内容，在平台侧完成发布后再点击“人工已发布”`);
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}
async function confirmManualPublished(targetId,button){
  const confirmed=window.confirm('请只在已经进入对应平台，并确认本次内容已实际发布后点击。\n\n确认后 Web 将标记为已发布，锁定该目标并永久禁止自动重投。');
  if(!confirmed)return;
  const originalText=button?.textContent||'人工已发布';
  if(button){button.disabled=true;button.textContent='正在确认…'}
  try{
    await api(`/api/publish/targets/${targetId}/manual-published`,{method:'POST',body:JSON.stringify({handledBy:'运营人员'})});
    toast('已标记为平台侧人工发布，已禁止自动重投');
    await renderTasks();
  }catch(error){toast(error.message,true)}finally{if(button&&document.body.contains(button)){button.disabled=false;button.textContent=originalText}}
}

function taskVisualState(task,platformScoped=false){
  const status=taskDisplayStatus(task,platformScoped);
  if(['PUBLISHED','SUCCESS','RECOVERED_BY_RETRY'].includes(status))return {key:'SUCCESS',tone:'success',label:status==='RECOVERED_BY_RETRY'?'补发恢复完成':'执行闭环完成',detail:status==='RECOVERED_BY_RETRY'?'异常目标已通过补发恢复':'发布链路已完成，可查看平台结果',status};
  if(['FAILED','PARTIAL_FAILED','REJECTED'].includes(status))return {key:'FAILED',tone:'failed',label:status==='PARTIAL_FAILED'?'部分目标异常':'发布链路异常',detail:'保留失败审计，可按安全策略重新发送',status};
  if(['SUBMITTED','REVIEWING','SYNCING','NEEDS_CONFIRMATION','UNKNOWN'].includes(status))return {key:'REVIEW',tone:'review',label:'等待结果确认',detail:'内容已进入平台侧，正在核验最终状态',status};
  return {key:'ACTIVE',tone:'running',label:status==='QUEUED'?'等待执行':'发布执行中',detail:status==='QUEUED'?'任务已入列，等待平台执行资源':'自动化发布链路正在实时推进',status};
}
function taskProgressModel(task,platformScoped=false){
  const visual=taskVisualState(task,platformScoped);
  const stages=['任务入列','内容校验','平台队列','自动执行','结果核验'];
  let current=1;
  if(visual.key==='SUCCESS')current=stages.length;
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
async function renderTasks(){
  const selected=state.taskPlatform&&state.taskPlatform!=='ALL'?state.taskPlatform:null;
  const data=await api('/api/tasks'+(selected?`?platformCode=${encodeURIComponent(selected)}`:''));
  const tasks=(data.tasks||[]).slice().sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
  const platforms=state.bootstrap?.platforms||[];
  const current=selected?platforms.find(item=>item.code===selected):null;
  const platformScoped=Boolean(selected);
  const counts=taskStatusCounts(tasks,platformScoped);
  const activeFilter=state.taskStatus||'ALL';
  const filtered=activeFilter==='ALL'?tasks:tasks.filter(task=>taskVisualState(task,platformScoped).key===activeFilter);
  const filterLabel=({ALL:'全部任务',ACTIVE:'执行中任务',REVIEW:'待确认任务',FAILED:'异常任务',SUCCESS:'已完成任务'}[activeFilter]||'任务');
  $('#content').innerHTML=`<div class="panel task-center-panel task-center-redesign" style="margin-top:0"><div class="panel-head task-center-head"><div><span class="panel-kicker">AUTOMATED PUBLISHING MATRIX</span><h2>发布任务中心</h2><p>统一任务流实时呈现发布、核验、异常与补发恢复，不再割裂成功和失败记录。</p></div><button class="btn secondary task-refresh-button" id="refreshTasks"><span>刷新链路</span></button></div>${taskCommandCenter(counts,current?.name||'全部平台')}${taskPlatformTabs(data.platformCounts,data.total)}<div class="task-platform-context"><b>当前查看：${esc(current?.name||"全部平台")}</b><span>执行完成不等于平台审核通过，最终状态以平台核验结果为准。</span></div>${taskStatusFilters(counts)}${taskStream(filtered,{platformScoped,emptyText:`暂无${current?.name||'当前范围'}的${filterLabel}`})}</div>`;
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
function commentMessageCard(m){return `<article class="interaction-card comment-item"><div class="interaction-head"><div><span class="user-avatar">${esc(String(m.user_name||'?').trim().slice(0,1)||'?')}</span><b>${esc(cleanText(m.user_name)||'未知用户')}</b></div><time>${fmt(m.collected_at||m.created_at)}</time></div><div class="message-content"><span class="content-label">评论内容</span><p>${esc(m.content)}</p></div><div class="reply-status-row">${replyStatusChip('ai',m.reply_status?.ai)}${replyStatusChip('manual',m.reply_status?.manual)}${badge(m.status)}${messageSourceBadge(m)}</div>${messageDecisionDetail(m)}${messageActions(m)}</article>`}
function privateMessageCard(m){return `<article class="interaction-card private-item"><div class="interaction-head"><div><span class="user-avatar private">${esc(String(m.user_name||'?').trim().slice(0,1)||'?')}</span><span><b>${esc(cleanText(m.user_name)||'未知用户')}</b><small>${esc(m.platform_name)} · ${esc(m.account_name)}</small></span></div><time>${fmt(m.collected_at||m.created_at)}</time></div><div class="message-content private-content"><span class="content-label">私信内容</span><p>${esc(m.content)}</p></div><div class="reply-status-row">${messageReplyBadges(m)}${messageSourceBadge(m)}</div>${messageDecisionDetail(m)}${messageActions(m)}</article>`}
function commentPostGroup(group){const post=group.post||{};const aiCount=group.items.filter(m=>m.reply_status?.ai?.replied).length;const manualCount=group.items.filter(m=>m.reply_status?.manual?.replied).length;const pendingCount=group.items.filter(m=>['MANUAL_REQUIRED','KNOWLEDGE_GAP'].includes(m.status)&&!m.reply_status?.manual?.replied).length;return `<section class="comment-post-group"><header class="comment-post-head"><div class="post-icon">帖</div><div class="post-info"><div class="post-title-row"><h3>${esc(post.title||'未识别关联帖子')}</h3>${post.matched?'<span class="badge success">已匹配发布记录</span>':'<span class="badge warning">待确认帖子</span>'}</div><p>${esc(group.items[0]?.platform_name||'')} · ${esc(group.items[0]?.account_name||'')} ${post.publishedAt?`· 发布于 ${fmt(post.publishedAt)}`:''}</p><div class="post-summary"><span>评论 ${group.items.length}</span><span>AI已回复 ${aiCount}</span><span>人工已回复 ${manualCount}</span>${pendingCount?`<span class="pending">待人工 ${pendingCount}</span>`:''}</div></div>${post.url?`<button class="btn secondary open-message" data-url="${esc(post.url)}">打开帖子</button>`:''}</header><div class="comment-items">${group.items.map(commentMessageCard).join('')}</div></section>`}
function groupCommentsByPost(comments){const groups=new Map();for(const message of comments){const post=message.post||{};const key=String(post.key||post.id||post.url||post.title||message.parent_external_id||'UNMATCHED_POST');if(!groups.has(key))groups.set(key,{key,post,items:[]});groups.get(key).items.push(message)}return [...groups.values()].sort((a,b)=>new Date(b.items[0]?.collected_at||b.items[0]?.created_at||0)-new Date(a.items[0]?.collected_at||a.items[0]?.created_at||0))}
function messageRefreshSignature(data){
  return JSON.stringify({
    messages:(data?.messages||[]).map(message=>[
      message.id,message.external_id,message.content,message.collected_at,message.updated_at,
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
  return `<article class="message-channel-poll-card ${stateClass}"><div class="message-channel-poll-head"><div><span class="message-channel-poll-icon">${channelType==='COMMENT'?'评':'信'}</span><b>${label}采集</b></div><span class="message-channel-poll-state"><i></i>${stateLabel}${activeJob}</span></div><div class="message-channel-poll-meta"><span>页面：<b>${pageLabel}</b></span><span>${resultText}</span></div><div class="message-channel-poll-times"><span>上次：${lastScan?fmt(lastScan):'尚未执行'}</span><span class="message-channel-poll-next"${nextAttr}>${nextText}</span></div><small>独立 Worker · 独立队列 · 页面持续复用</small></article>`;
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
  decision:Object.freeze({AUTO_REPLY:'高可信自动回复',AUTO_REPLY_PARTIAL_KNOWLEDGE:'部分问题已回复，仍有问题待确认',SMALL_TALK:'闲聊回复',GREETING_GUIDANCE:'问候引导',KNOWLEDGE_GAP_GUIDANCE:'知识库未命中，正在引导用户补充',SIMPLE_GREETING:'简单问候',ROUTER_IGNORED:'路由忽略',AUTO_REPLY_INELIGIBLE:'不满足自动回复条件',SUPERSEDED_BY_NEW_MESSAGE:'新消息已到达，旧回复已作废',RAG_ANSWERED:'知识库已回复',RAG_NEED_CLARIFICATION:'需要补充信息',RAG_CLARIFICATION_LIMIT:'引导已达上限，转人工',KNOWLEDGE_GUIDANCE_LIMIT:'引导已达上限，转人工',RAG_SERVICE_UNAVAILABLE:'知识服务不可用',HUMAN_HANDOFF:'转人工',HUMAN_FOLLOWUP_NOTIFIED:'已通知历史对接人工',HUMAN_FOLLOWUP_NOTIFICATION_PENDING:'历史人工通知中',MANUAL_HANDLED:'人工已处理',UNKNOWN:'未知状态'})
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
  if(!detail?.conversation||typeof detail.conversation!=='object'||Array.isArray(detail.conversation))return '<section class="mini-program-detail"><div class="mini-program-empty"><b>请选择一个会话</b><span>从左侧会话列表查看终止前保存的文字与送达状态。</span></div></section>';
  const conversation=detail.conversation;
  const conversationId=miniProgramRecordId(conversation.id);
  const messages=Array.isArray(detail.messages)?detail.messages.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)):[];
  const handoffKey=conversationId!==null&&conversation.handlingMode==='BOT_ACTIVE'?`handoff:${conversationId}`:null;
  return `<section class="mini-program-detail" aria-label="小程序会话详情"><header class="mini-program-detail-head"><div><span class="mini-program-kicker">CONVERSATION DETAIL</span><h3>${esc(miniProgramText(conversation.userId,'未知用户'))}</h3><p class="mini-program-id">${esc(miniProgramText(conversation.conversationId,'—'))}</p></div><div class="mini-program-detail-state">${miniProgramStateBadge(conversation.handlingMode,'conversation')}${conversation.historicalUser===true?'<span class="mini-program-history">历史人工用户</span>':''}</div></header><div class="mini-program-detail-toolbar"><span>已保存文字 ${messages.length} 条</span>${handoffKey?`<button type="button" class="btn mini-program-action mini-program-handoff" data-conversation-id="${conversationId}"${miniProgramActionAttributes(handoffKey)}>${iconSvg('accounts')}<span>转人工</span></button>`:''}</div><div class="mini-program-message-list">${miniProgramMessageRows(messages)}</div></section>`;
}
async function loadMiniProgramData({filter,preferredConversationId,preserveSelection}){
  const [statusData,listData]=await Promise.all([api('/api/mini-program/status'),api(`/api/mini-program/conversations?status=${encodeURIComponent(filter)}&limit=200`)]);
  const conversations=(Array.isArray(listData?.conversations)?listData.conversations:[]).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&miniProgramRecordId(item.id)!==null);
  const listedSelection=conversations.find(item=>item.id===preferredConversationId)||null;
  const selectedId=listedSelection?listedSelection.id:preserveSelection&&preferredConversationId!==null?preferredConversationId:conversations[0]?.id||null;
  const detail=selectedId!==null?await api(`/api/mini-program/conversations/${selectedId}/messages`):null;
  return {status:statusData?.status&&typeof statusData.status==='object'&&!Array.isArray(statusData.status)?statusData.status:{},conversations,detail,selectedId};
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
  const {status,conversations,detail,selectedId}=data;
  state.miniProgramFilter=filter;
  state.miniProgramConversationId=selectedId;
  const counts=status.counts&&typeof status.counts==='object'&&!Array.isArray(status.counts)?status.counts:{};
  const processingFailed=miniProgramCount(counts.processingFailed),callbackFailed=miniProgramCount(counts.callbackFailed),notificationFailed=miniProgramCount(counts.notificationFailed);
  $('#content').innerHTML=`<section class="mini-program-page"><section class="mini-program-summary" aria-labelledby="miniProgramTitle"><header class="mini-program-summary-head"><div><span class="mini-program-kicker">MINI PROGRAM CHANNEL</span><h2 id="miniProgramTitle">小程序对话</h2><p>查看已采集的文字咨询、AI 回复送达与企微转人工状态。</p></div><button type="button" class="btn secondary mini-program-action mini-program-refresh" aria-label="刷新小程序对话">${iconSvg('tasks')}<span>刷新</span></button></header><div class="mini-program-summary-grid">${miniProgramSummaryItem('开放接口',status.apiEnabled===true?'已开启':'已关闭',status.apiEnabled===true?'正在接收签名文字消息':'当前不接收新消息',status.apiEnabled===true?'ready':'warning')}${miniProgramSummaryItem('应用配置',status.appConfigured===true?'已就绪':'缺少配置',status.appConfigured===true?'应用身份已绑定':'请完成服务端配置',status.appConfigured===true?'ready':'warning')}${miniProgramSummaryItem('回调配置',status.callbackConfigured===true?'已就绪':'未配置',status.callbackConfigured===true?'AI 回复可送达小程序':'回复将保留在待发送队列',status.callbackConfigured===true?'ready':'warning')}${miniProgramSummaryItem('最近接收',status.lastReceivedAt==null?'暂无':miniProgramDate(status.lastReceivedAt),'最后一条已保存文字','neutral')}${miniProgramSummaryItem('待处理',String(miniProgramCount(counts.processing)),processingFailed?`${processingFailed} 条处理异常`:'处理队列正常',processingFailed?'danger':'neutral')}${miniProgramSummaryItem('待回调',String(miniProgramCount(counts.callbackPending)),callbackFailed?`${callbackFailed} 条发送失败`:'回调队列正常',callbackFailed?'danger':'neutral')}${miniProgramSummaryItem('企微失败',String(notificationFailed),notificationFailed?'需要运营重试':'通知队列正常',notificationFailed?'danger':'neutral')}</div></section><div class="mini-program-workbench"><section class="mini-program-list-pane" aria-label="小程序会话列表"><div class="mini-program-list-head"><div><span class="mini-program-kicker">CONVERSATIONS</span><h3>会话列表</h3></div><span>${conversations.length} 条</span></div><nav class="mini-program-filters" aria-label="小程序会话状态筛选">${miniProgramFilters.map(([value,label])=>`<button type="button" class="mini-program-filter ${state.miniProgramFilter===value?'active':''}" data-filter="${value}" aria-pressed="${state.miniProgramFilter===value}">${esc(label)}</button>`).join('')}</nav><div class="mini-program-conversation-list">${miniProgramConversationRows(conversations)}</div></section>${miniProgramDetail(detail)}</div></section>`;
  bindMiniProgramWorkbench();
  syncMiniProgramPendingActions();
  return true;
}
async function renderManualHandoffs(){
  const data=await api('/api/manual-handoffs?limit=500');
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

async function renderMessages(prefetchedData=null){
  const data=prefetchedData||await api('/api/messages');
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
  $('#content').innerHTML=`
    <div class="message-ops-page ${isComment?'channel-comments':'channel-private'}">
      <section class="message-command-center">
        <div class="message-command-grid" aria-hidden="true"></div>
        <div class="message-command-flow" aria-hidden="true"></div>
        <div class="message-command-copy">
          <span class="message-command-eyebrow"><i></i> INTERACTION INTELLIGENCE</span>
          <h2>多平台评论与私信</h2>
          <p>统一采集评论与私信，实时跟踪 AI 决策、人工接管和平台回执。</p>
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
          <div class="message-toolbar-title"><span>⌁</span><div><b>智能采集控制台</b><small>配置账号和采集频率后启动实时同步</small></div></div>
          <div class="message-collection-controls">
            <button class="btn secondary message-export-open" id="exportMessages" type="button"><span aria-hidden="true">⇩</span> 导出</button>
            <label class="message-poll-control"><span>平台账号</span><select id="messageAccount" aria-label="选择采集账号">${accountOptionsHtml}</select></label>
            <label class="message-poll-control"><span>自动采集随机区间</span><select id="messagePollInterval" aria-label="选择自动采集随机区间">${pollOptionsHtml}</select></label>
            <button class="btn message-collect-button" id="collectMessages" ${selectedAccount?'':'disabled'}><i></i><span>立即采集</span></button>
          </div>
        </div>
        <div class="message-poll-meta"><b>当前策略：每轮在 ${esc(collection.label||pollOptions.find(option=>option.value===selectedPoll)?.label||selectedPoll)} 内重新取随机数</b><span>${esc(nextCollectionText)}</span><small>保存新区间后会取消旧定时器并重新排程，不会中断已在执行的采集。</small></div>
        <div class="message-channel-poll-grid">${messageChannelPollCard({label:'评论',channelType:'COMMENT',runtime:messageChannelRuntime(data,selectedAccount,'COMMENT'),nextCollectionAt:collection.nextCollectionAt})}${messageChannelPollCard({label:'私信',channelType:'PRIVATE_MESSAGE',runtime:messageChannelRuntime(data,selectedAccount,'PRIVATE_MESSAGE'),nextCollectionAt:collection.nextCollectionAt})}</div>
        <div class="interaction-tabs" role="tablist">
          <button type="button" class="interaction-tab ${isComment?'active':''}" data-message-view="COMMENT"><span class="interaction-tab-icon">评</span><span><b>评论</b><small>按发布帖子分类查看</small></span><em>${comments.length}</em><i class="interaction-tab-flow" aria-hidden="true"></i></button>
          <button type="button" class="interaction-tab ${!isComment?'active':''}" data-message-view="PRIVATE_MESSAGE"><span class="interaction-tab-icon private">信</span><span><b>私信</b><small>查看内容和回复状态</small></span><em>${privateMessages.length}</em><i class="interaction-tab-flow" aria-hidden="true"></i></button>
        </div>
        <details class="simulate-box"><summary><span>◇</span> 添加模拟消息 <small>仅用于知识/千问决策测试</small></summary><form id="simulateForm" class="inline-form"><select name="messageType"><option value="COMMENT">评论</option><option value="PRIVATE_MESSAGE">私信</option></select><input name="userName" value="测试用户"><input name="content" placeholder="输入测试问题" required><button class="btn secondary" ${selectedAccount?'':'disabled'}>提交模拟消息</button></form></details>
        <div class="message-list-heading"><div><span class="message-list-live"><i></i> LIVE STREAM</span><b>${activeChannelLabel}消息流</b></div><small>AI 回复 ${aiReplyCount} · 人工回复 ${manualReplyCount}${platformReplyCount?` · 平台已有回复 ${platformReplyCount}`:''} · 待处理 ${manualPendingCount}</small></div>
        <div class="interaction-list">${listHtml}</div>
      </div>
    </div>`;
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
        return `${collectionJobChannelLabel(job,index,jobs.length)}：${statusLabel(job.status)}${resultMessage?`（${resultMessage}）`:''}`;
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
    const note=prompt('填写在原平台App中的处理说明',`已在${platform} App人工回复`);
    if(note===null)return;
    await api(`/api/messages/${b.dataset.id}/handled`,{method:'POST',body:JSON.stringify({note,handledBy:'运营人员'})});
    toast('已标记人工处理，自动回复任务已禁止补发');
    renderMessages();
  });
  document.querySelectorAll('.manual-reply').forEach(b=>b.onclick=async()=>{
    const message=messages.find(item=>Number(item.id)===Number(b.dataset.id));
    const policy=data.replyLimits?.[message?.platform_code]?.[message?.message_type];
    const limit=policy?.safeMax;
    const replyText=prompt(`请输入要发送到微博的完整人工回复${limit?`（最多 ${limit} 字符）`:''}`,'');
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
    const expectedReply=prompt(`请粘贴你在${platform} App中已经发送的完整回复内容（系统只核验，不会再次发送）`,'');
    if(expectedReply===null)return;
    try{const d=await api(`/api/messages/${b.dataset.id}/detect-manual`,{method:'POST',body:JSON.stringify({expectedReply})});toast(`人工回复检测任务 Job#${d.jobId} 已创建`)}catch(e){toast(e.message,true)}
  });
  document.querySelectorAll('.retry-message').forEach(b=>b.onclick=async()=>{try{await api(`/api/messages/${b.dataset.id}/retry`,{method:'POST',body:'{}'});toast('消息已重新进入决策');renderMessages()}catch(e){toast(e.message,true)}});
}

function renderKnowledgeTabs(){
  return `<div class="knowledge-section-tabs" role="tablist" aria-label="知识库内容切换"><button class="knowledge-section-tab ${state.knowledgeView==='rag'?'active':''}" type="button" data-knowledge-view="rag" role="tab" aria-selected="${state.knowledgeView==='rag'}"><span class="knowledge-tab-icon">▤</span><span><b>知识库内容</b><small>资料上传、测试与发布</small></span></button><button class="knowledge-section-tab ${state.knowledgeView==='handoff'?'active':''}" type="button" data-knowledge-view="handoff" role="tab" aria-selected="${state.knowledgeView==='handoff'}"><span class="knowledge-tab-icon">↗</span><span><b>转人工说法</b><small>自定义私信触发语句</small></span></button></div>`;
}function bindKnowledgeTabs(){
  document.querySelectorAll('[data-knowledge-view]').forEach(button=>button.onclick=()=>{const next=button.dataset.knowledgeView;if(next===state.knowledgeView)return;state.knowledgeView=next;renderKnowledge().then(()=>window.scrollTo({top:0,left:0,behavior:'smooth'})).catch(error=>toast(error.message,true))});
}

function knowledgeMetadataSourceLabel(source){return ({FILE:'文件填写',AI:'AI推荐',RULE:'规则兜底',DEFAULT:'安全默认',MANUAL:'运营修改',OPERATOR:'运营修改',RULE_FALLBACK:'规则兜底'}[source]||source||'待确认')}
function knowledgeMetadataStatusLabel(status){return ({QUEUED:'等待千问分析',RUNNING:'千问分析中',COMPLETED:'AI推荐完成',FALLBACK:'AI失败，已规则兜底',FAILED:'AI推荐失败',DISCARDED:'旧推荐已丢弃',NOT_NEEDED:'文件字段完整'}[status]||status||'待分析')}
function keywordOptionsFromValue(value='',source='OPERATOR'){return [...new Set(String(value||'').split(/[,，;；、|\n]+/).map(item=>item.trim()).filter(Boolean))].map(text=>({text,source,confidence:source==='AI'?0.8:1,selectable:true,conflict:false,selected:true,reason:source==='FILE'?'上传文件填写':'运营人员填写'}))}
function renderKnowledgeKeywordPicker(options=[],value='',id='knowledge-keywords'){
  const normalized=Array.isArray(options)&&options.length?options:keywordOptionsFromValue(value);
  const selected=new Set(String(value||'').split(/[,，;；、|\n]+/).map(item=>item.trim()).filter(Boolean));
  const items=normalized.map((item,index)=>{const text=String(item.text||'').trim();if(!text)return '';const checked=item.selected===true||selected.has(text);const disabled=item.selectable===false;const warning=item.conflict?'冲突':disabled?'不可启用':'';return `<label class="knowledge-keyword-option${item.conflict?' conflict':''}${disabled?' disabled':''}"><input type="checkbox" data-keyword-option value="${esc(text)}" ${checked&&!disabled?'checked':''} ${disabled?'disabled':''}><span><b>${esc(text)}</b><small>${esc(knowledgeMetadataSourceLabel(item.source))}${Number(item.confidence)>0?` · ${Math.round(Number(item.confidence)*100)}%`:''}${item.reason?` · ${esc(item.reason)}`:''}</small></span>${warning?`<em>${warning}</em>`:''}</label>`}).join('');
  const selectedValues=normalized.filter(item=>(item.selected===true||selected.has(String(item.text||'').trim()))&&item.selectable!==false).map(item=>String(item.text||'').trim()).filter(Boolean);
  const finalValues=selectedValues.length?selectedValues:[...selected];
  return `<div class="knowledge-keyword-picker" data-keyword-picker="${esc(id)}"><input class="knowledge-keyword-value" type="hidden" name="keywords" value="${esc(finalValues.join(','))}"><details><summary><span data-keyword-summary>${finalValues.length?`已选择 ${finalValues.length} 个关键词`:'请选择关键词'}</span><small>点击展开勾选</small><i>⌄</i></summary><div class="knowledge-keyword-options">${items||'<p class="muted">暂无推荐，可在下方手工添加。</p>'}</div></details><div class="knowledge-keyword-manual"><input type="text" autocomplete="off" maxlength="30" placeholder="手工补充完整意图词"><button class="ghost" type="button" data-keyword-add>添加</button></div></div>`
}
function bindKnowledgeKeywordPickers(root=document){
  root.querySelectorAll?.('[data-keyword-picker]').forEach(picker=>{
    if(picker.dataset.bound==='1')return;picker.dataset.bound='1';
    const hidden=picker.querySelector('.knowledge-keyword-value');const summary=picker.querySelector('[data-keyword-summary]');const optionsBox=picker.querySelector('.knowledge-keyword-options');
    const sync=()=>{const values=[...picker.querySelectorAll('[data-keyword-option]:checked')].map(input=>input.value.trim()).filter(Boolean);hidden.value=[...new Set(values)].join(',');summary.textContent=values.length?`已选择 ${values.length} 个关键词`:'请选择关键词';hidden.dispatchEvent(new Event('change',{bubbles:true}))};
    picker.querySelectorAll('[data-keyword-option]').forEach(input=>input.onchange=sync);
    const addButton=picker.querySelector('[data-keyword-add]');const manualInput=picker.querySelector('.knowledge-keyword-manual input');
    if(addButton)addButton.onclick=()=>{const text=manualInput.value.trim();if(!text)return toast('请输入要补充的关键词',true);if([...picker.querySelectorAll('[data-keyword-option]')].some(input=>input.value===text)){manualInput.value='';return toast('这个关键词已经存在')};const label=document.createElement('label');label.className='knowledge-keyword-option operator';label.innerHTML=`<input type="checkbox" data-keyword-option value="${esc(text)}" checked><span><b>${esc(text)}</b><small>运营修改 · 手工补充</small></span>`;const empty=optionsBox.querySelector('p');if(empty)empty.remove();optionsBox.appendChild(label);label.querySelector('input').onchange=sync;manualInput.value='';sync()};
  })
}
function mergeKnowledgeImportPreview(incoming){
  const current=state.knowledgeImportPreview;const dirty=new Set((state.knowledgeImportDirty||[]).map(Number));if(!current)return incoming;const currentMap=new Map((current.items||[]).map(item=>[Number(item.rowNo),item]));return {...incoming,items:(incoming.items||[]).map(item=>dirty.has(Number(item.rowNo))?(currentMap.get(Number(item.rowNo))||item):item)}
}
function scheduleKnowledgeImportEnrichmentPoll(batchId){
  if(knowledgeImportEnrichmentPollTimer)clearTimeout(knowledgeImportEnrichmentPollTimer);if(!batchId)return;
  const poll=async()=>{try{const active=document.activeElement;if(active?.closest?.('.knowledge-preview-editor')){knowledgeImportEnrichmentPollTimer=setTimeout(poll,800);return}const incoming=await api(`/api/knowledge/import/${batchId}`);state.knowledgeImportPreview=mergeKnowledgeImportPreview(incoming);setKnowledgeImportStage(knowledgeImportStageForPreview(incoming));renderKnowledgeImportPreview(state.knowledgeImportPreview);const running=['QUEUED','RUNNING'].includes(incoming.enrichment?.status);if(running)knowledgeImportEnrichmentPollTimer=setTimeout(poll,1500);else{knowledgeImportEnrichmentPollTimer=null;if(incoming.enrichment?.status==='COMPLETED')toast('千问已完成关键词和分类推荐，请逐条确认')}}catch(error){knowledgeImportEnrichmentPollTimer=setTimeout(poll,3000)}};knowledgeImportEnrichmentPollTimer=setTimeout(poll,1000)
}

function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(file)})}
const KNOWLEDGE_IMPORT_FLOW_STEPS=[
  {id:'upload',label:'上传'},
  {id:'clean',label:'清洗'},
  {id:'dedupe',label:'去重'},
  {id:'classify',label:'归类'},
  {id:'review',label:'审核'}
];
function knowledgeImportStageForPreview(preview){
  if(!preview)return 'IDLE';
  return ['QUEUED','RUNNING'].includes(preview.enrichment?.status)?'CLASSIFYING':'REVIEWING';
}
function knowledgeImportFlowState(stage=state.knowledgeImportStage||'IDLE'){
  const enrichment=state.knowledgeImportPreview?.enrichment||{};
  const progressTotal=Number(enrichment.total||0);
  const progressDone=Number(enrichment.completed||0);
  const reviewCount=Number(state.knowledgeImportPreview?.summary?.total||state.knowledgeImportPreview?.items?.length||0);
  const activeByStage={IDLE:[0],READY:[0],UPLOADING:[0],PROCESSING:[1,2],CLASSIFYING:[3],REVIEWING:[4],COMMITTING:[4]};
  const completedBefore={IDLE:0,READY:0,UPLOADING:0,PROCESSING:1,CLASSIFYING:3,REVIEWING:4,COMMITTING:4};
  const failedIndex=Math.max(0,KNOWLEDGE_IMPORT_FLOW_STEPS.findIndex(item=>item.id===(state.knowledgeImportFailedStep||'upload')));
  const active=stage==='FAILED'?[failedIndex]:(activeByStage[stage]||activeByStage.IDLE);
  const completed=stage==='FAILED'?failedIndex:(completedBefore[stage]||0);
  const activeText={
    IDLE:['等待文件'],READY:['文件已选择'],UPLOADING:['正在读取'],PROCESSING:['正在清洗','同步去重'],
    CLASSIFYING:[progressTotal?`AI 处理中 ${progressDone}/${progressTotal}`:'AI 处理中'],
    REVIEWING:[reviewCount?`待确认 ${reviewCount} 条`:'等待确认'],COMMITTING:['正在入库'],FAILED:['处理失败']
  };
  return KNOWLEDGE_IMPORT_FLOW_STEPS.map((step,index)=>{
    const isError=stage==='FAILED'&&index===failedIndex;
    const isActive=active.includes(index);
    const isComplete=!isError&&index<completed;
    const activePosition=active.indexOf(index);
    const detail=isError?'处理失败':isComplete?'已完成':isActive?(activeText[stage]?.[activePosition]||'处理中'):'待处理';
    const classes=['flow-step',isComplete?'is-complete':'',isActive?'is-active':'',isError?'is-error':'',stage==='IDLE'&&index===0?'is-idle':''].filter(Boolean).join(' ');
    return {step,index,detail,classes,isComplete,isActive,isError};
  });
}
function renderKnowledgeImportFlow(){
  const stage=state.knowledgeImportStage||'IDLE';
  const steps=knowledgeImportFlowState(stage);
  return `<div id="knowledgeImportFlow" class="flow mini-flow knowledge-mini-flow" data-stage="${esc(stage)}" aria-label="知识文档处理进度" aria-live="polite">${steps.map(({step,index,detail,classes,isComplete,isActive,isError})=>`<div class="${classes}" data-import-step="${step.id}" ${isActive?'aria-current="step"':''}><b>${isComplete?'✓':isError?'!':index+1}</b><span>${step.label}</span><small>${esc(detail)}</small></div>`).join('')}</div>`;
}
function setKnowledgeImportStage(stage,{failedStep=null}={}){
  state.knowledgeImportStage=stage;
  state.knowledgeImportFailedStep=stage==='FAILED'?(failedStep||state.knowledgeImportFailedStep||'upload'):null;
  const current=$('#knowledgeImportFlow');
  if(current)current.outerHTML=renderKnowledgeImportFlow();
}
function knowledgeMatchName(value){return ({NEW:'新增知识',SIMILAR_REVIEW:'相似待审核',EXACT_DUPLICATE:'完全重复'}[value]||value)}
function isKnowledgeImportCategoryError(message){return String(message||'').startsWith('知识大类只能选择：')}
function summarizeKnowledgeImportRows(rows=[]){return {total:rows.length,importable:rows.filter(item=>item.importable).length,exactDuplicates:rows.filter(item=>item.matchStatus==='EXACT_DUPLICATE').length,similar:rows.filter(item=>item.matchStatus==='SIMILAR_REVIEW').length,invalid:rows.filter(item=>(item.errors||[]).length>0).length}}
function countKnowledgeImportCharacters(value='',countingMode='CODE_POINTS'){const text=String(value??'').normalize('NFC');return countingMode==='UTF16'?text.length:Array.from(text).length}
function isKnowledgeImportAnswerLimitError(message){return /^标准答案共 \d+ 个字符，超过可入库上限 \d+ 个字符/.test(String(message||''))}
function knowledgeImportAnswerPolicy(category,replyLimits={}){
  const categoryPlatformMap={'小红书知识库':'xiaohongshu','抖音知识库':'douyin','微博知识库':'weibo','视频号知识库':'wechat_channels','B站知识库':'bilibili'};
  const normalizedCategory=String(category||'').trim()||'公共知识库';
  const platformCodes=normalizedCategory==='公共知识库'?Object.keys(replyLimits||{}):[categoryPlatformMap[normalizedCategory]].filter(Boolean);
  const constraints=platformCodes.flatMap(platformCode=>{
    const platform=replyLimits?.[platformCode];
    if(!platform)return [];
    return ['COMMENT','PRIVATE_MESSAGE'].map(messageType=>({platformCode,platformLabel:platform.label||platformCode,messageType,messageLabel:messageType==='PRIVATE_MESSAGE'?'私信':'评论/评论回复',safeMax:Number(platform?.[messageType]?.safeMax),publishedMax:Number(platform?.[messageType]?.publishedMax),countingMode:platform?.[messageType]?.countingMode||'CODE_POINTS',sourceType:platform?.[messageType]?.sourceType||'PROJECT_FALLBACK'})).filter(item=>Number.isFinite(item.safeMax));
  });
  if(!constraints.length)return null;
  const safeMax=Math.min(...constraints.map(item=>item.safeMax));
  const strictest=constraints.filter(item=>item.safeMax===safeMax);
  const publishedMax=Math.min(...strictest.map(item=>item.publishedMax).filter(Number.isFinite));
  const countingMode=strictest.some(item=>item.countingMode==='UTF16')?'UTF16':'CODE_POINTS';
  const verified=strictest.every(item=>['OFFICIAL_WEB','OFFICIAL_DOC'].includes(item.sourceType));
  const strictestNames=[...new Set(strictest.map(item=>`${item.platformLabel}${item.messageLabel}`))].join('、');
  const label=normalizedCategory==='公共知识库'
    ? `公共知识库需同时适配五个平台，当前最严格为${strictestNames}，安全上限 ${safeMax} 字符`
    : `${normalizedCategory}需同时适配评论回复和私信，安全上限 ${safeMax} 字符${verified&&Number.isFinite(publishedMax)?`（已核实上限 ${publishedMax}，预留 20 字符）`:'（项目保守值，官方上限待核实）'}`;
  return {category:normalizedCategory,safeMax,publishedMax,strictest,label,countingMode};
}
function refreshKnowledgeImportAnswerState(item,replyLimits={}){
  item.errors=(item.errors||[]).filter(error=>!isKnowledgeImportAnswerLimitError(error));
  const policy=knowledgeImportAnswerPolicy(item.category,replyLimits);
  const count=countKnowledgeImportCharacters(item.answer||'',policy?.countingMode);
  const limit=policy?.safeMax??(Number.isFinite(Number(item.answerCharacterLimit))?Number(item.answerCharacterLimit):null);
  const label=policy?.label||item.answerLimitLabel||'';
  item.answerCharacterCount=count;
  item.answerCharacterLimit=limit;
  item.answerLimitLabel=label;
  if(String(item.answer||'').trim()&&Number.isFinite(limit)&&count>limit)item.errors.push(`标准答案共 ${count} 个字符，超过可入库上限 ${limit} 个字符（${label}），请修改后再入库`);
  item.importable=(item.errors||[]).length===0&&item.matchStatus!=='EXACT_DUPLICATE';
  return {count,limit,label,overLimit:Number.isFinite(limit)&&count>limit};
}
function applyKnowledgeImportReview(item,field,value,systemCategories=[],replyLimits={}){
  const previousValue=item[field];item[field]=value;
  if(field==='category'&&systemCategories.includes(value)){
    item.errors=(item.errors||[]).filter(error=>!isKnowledgeImportCategoryError(error));
    item.categorySource='MANUAL';
    if(previousValue!==value){item.matchStatus='NEW';item.matchScore=0;item.matchedKnowledgeId=null;item.matchedQuestion=null}
  }
  if(field==='subcategory')item.subcategorySource='MANUAL';
  if(field==='keywords')item.keywordsSource='MANUAL';
  if(field==='question'||field==='answer'){
    item.aiStatus='DISCARDED';item.aiError='问题或答案已由运营修改，旧推荐已清除，请重新生成';item.aiRecommendation=null;
    if(item.keywordsSource==='AI'){item.keywords='';item.keywordOptions=[];item.keywordsSource='DEFAULT'}
    if(item.categorySource==='AI'){item.category=systemCategories[0]||'公共知识库';item.categorySource='DEFAULT'}
    if(item.subcategorySource==='AI'){item.subcategory='未分类';item.subcategorySource='DEFAULT'}
  }
  if(field==='question'){
    item.errors=(item.errors||[]).filter(error=>error!=='缺少标准问题');
    if(!String(value||'').trim())item.errors.unshift('缺少标准问题');
  }
  if(field==='answer'){
    item.errors=(item.errors||[]).filter(error=>error!=='缺少标准答案');
    if(!String(value||'').trim())item.errors.unshift('缺少标准答案');
  }
  if(field==='answer'||field==='category')refreshKnowledgeImportAnswerState(item,replyLimits);
  else item.importable=(item.errors||[]).length===0&&item.matchStatus!=='EXACT_DUPLICATE';
}
function captureKnowledgeImportScrollState(box){
  const list=box?.querySelector?.('.knowledge-preview-list');
  if(!list)return knowledgeImportScrollState;
  knowledgeImportScrollState={top:Number(list.scrollTop)||0,left:Number(list.scrollLeft)||0};
  return knowledgeImportScrollState;
}
function restoreKnowledgeImportScrollState(box,snapshot){
  if(!box||!snapshot)return;
  const apply=()=>{
    const list=box.querySelector('.knowledge-preview-list');
    if(!list)return;
    const maxTop=Math.max(0,list.scrollHeight-list.clientHeight);
    list.scrollTop=Math.min(Math.max(0,Number(snapshot.top)||0),maxTop);
    list.scrollLeft=Math.max(0,Number(snapshot.left)||0);
    knowledgeImportScrollState={top:list.scrollTop,left:list.scrollLeft};
  };
  // 立即恢复，避免 innerHTML 替换后出现一帧回到顶部；下一帧再校正一次，兼容内容高度刚完成布局的情况。
  apply();
  requestAnimationFrame(apply);
}
function bindKnowledgeImportScrollPersistence(box){
  const list=box?.querySelector?.('.knowledge-preview-list');
  if(!list)return;
  list.addEventListener('scroll',()=>{
    knowledgeImportScrollState={top:Number(list.scrollTop)||0,left:Number(list.scrollLeft)||0};
  },{passive:true});
}
function renderKnowledgeImportPreview(data){
  const box=$('#knowledgeImportPreview');
  if(!box)return;
  const previousScroll=captureKnowledgeImportScrollState(box);
  const clearButton=$('#clearKnowledgeImportPreview');
  if(clearButton)clearButton.disabled=!data;
  if(!data){
    if(knowledgeImportEnrichmentPollTimer){clearTimeout(knowledgeImportEnrichmentPollTimer);knowledgeImportEnrichmentPollTimer=null}
    knowledgeImportScrollState={top:0,left:0};
    box.innerHTML=`<div class="knowledge-preview-empty"><span class="knowledge-preview-empty-icon">⇩</span><h3>等待上传预处理数据</h3><p>上传 CSV、TSV、TXT、MD 或 DOCX 后，系统会在这里逐条展示清洗、去重和分类结果。</p><div><span>逐条折叠查看</span><span>支持全选</span><span>可人工修改</span></div></div>`;
    return;
  }
  const categoryData=state.knowledgeCategoryData||{};
  const systemCategories=categoryData.systemCategories||[];
  const replyLimits=categoryData.replyLimits||{};
  const publicCategory=systemCategories[0]||'公共知识库';
  const cacheMap=Object.fromEntries((categoryData.categories||[]).map(item=>[item.name,item.recentSubcategories||[]]));
  const subcategorySuggestions=category=>[...new Set((cacheMap[category]||[]).filter(Boolean))].slice(0,10);
  const rows=data.items||[];
  rows.forEach(item=>{if(!systemCategories.includes(item.category))item.category=publicCategory;refreshKnowledgeImportAnswerState(item,replyLimits)});
  const selected=new Set((state.knowledgeImportSelected||[]).map(Number));
  rows.filter(item=>!item.importable).forEach(item=>selected.delete(Number(item.rowNo)));
  const expanded=new Set((state.knowledgeImportExpanded||[]).map(Number));
  const dirty=new Set((state.knowledgeImportDirty||[]).map(Number));
  const filter=state.knowledgeImportFilter||'ALL';
  const visibleRows=rows.filter(item=>filter==='ALL'||(filter==='READY'&&item.importable&&item.matchStatus==='NEW')||(filter==='SIMILAR'&&item.matchStatus==='SIMILAR_REVIEW')||(filter==='DUPLICATE'&&item.matchStatus==='EXACT_DUPLICATE')||(filter==='INVALID'&&(item.errors||[]).length));
  const selectableVisibleRows=visibleRows.filter(item=>item.importable);
  const statusInfo=item=>{
    if((item.errors||[]).length)return {label:'需修改',tone:'invalid'};
    if(item.matchStatus==='EXACT_DUPLICATE')return {label:'重复项',tone:'duplicate'};
    if(item.matchStatus==='SIMILAR_REVIEW')return {label:'相似待核对',tone:'similar'};
    return {label:'可入库',tone:'ready'};
  };
  const selectedVisible=selectableVisibleRows.filter(item=>selected.has(Number(item.rowNo))).length;
  const allVisibleSelected=selectableVisibleRows.length>0&&selectedVisible===selectableVisibleRows.length;
  const categoryNeedsReview=item=>(item.errors||[]).some(isKnowledgeImportCategoryError);
  const categoryOptions=item=>`${categoryNeedsReview(item)?'<option value="" selected disabled>请选择知识大类</option>':''}${systemCategories.map(name=>`<option value="${esc(name)}" ${!categoryNeedsReview(item)&&name===item.category?'selected':''}>${esc(name)}</option>`).join('')}`;
  const datalistOptions=category=>subcategorySuggestions(category).map(name=>`<option value="${esc(name)}"></option>`).join('');
  const answerCounter=item=>{
    const count=Number(item.answerCharacterCount)||0;
    const limit=Number(item.answerCharacterLimit);
    const hasLimit=Number.isFinite(limit);
    const overLimit=hasLimit&&count>limit;
    return `<small class="knowledge-answer-counter${overLimit?' over-limit':''}" data-import-answer-counter="${Number(item.rowNo)}">当前 ${count}${hasLimit?` / ${limit}`:''} 字符${item.answerLimitLabel?` · ${esc(item.answerLimitLabel)}`:''}${overLimit?' · 超过平台字数，不能入库':''}</small>`;
  };
  const summary={...(data.summary||{}),...summarizeKnowledgeImportRows(rows)};
  data.summary=summary;
  const enrichment=data.enrichment||{};const enrichmentRunning=['QUEUED','RUNNING'].includes(enrichment.status);if(state.knowledgeImportStage!=='COMMITTING')setKnowledgeImportStage(knowledgeImportStageForPreview(data));const enrichmentText=enrichmentRunning?`千问正在分析 ${Number(enrichment.completed||0)} / ${Number(enrichment.total||0)} 条`:enrichment.status?`${knowledgeMetadataStatusLabel(enrichment.status)} · 已处理 ${Number(enrichment.completed||0)} 条${Number(enrichment.failed||0)?` · 失败 ${Number(enrichment.failed)} 条`:''}`:'等待千问分析';
  box.innerHTML=`<div class="import-summary compact"><div><b data-import-summary="total">${summary.total||0}</b><span>识别总数</span></div><div><b data-import-summary="importable">${summary.importable||0}</b><span>建议入库</span></div><div><b data-import-summary="similar">${summary.similar||0}</b><span>相似待核对</span></div><div><b data-import-summary="exactDuplicates">${summary.exactDuplicates||0}</b><span>重复项</span></div><div><b data-import-summary="invalid">${summary.invalid||0}</b><span>需修改</span></div></div>
    <div class="knowledge-preview-file"><span class="knowledge-preview-file-icon">CSV</span><span><b>${esc(data.fileName||'已上传文档')}</b><small>批次 #${esc(data.batchId)} · 大类只能选择固定六类，小类可直接输入</small></span></div><div class="knowledge-ai-progress ${enrichmentRunning?'running':''}"><span class="knowledge-ai-progress-dot"></span><div><b>${esc(enrichmentText)}</b><small>文件原值优先；缺失字段由 AI 推荐，运营确认后才入库。</small></div><button class="ghost" type="button" id="retryKnowledgeImportAi" ${enrichmentRunning?'disabled':''}>重新生成缺失字段</button></div>
    <div class="knowledge-preview-toolbar"><label class="knowledge-select-all"><input id="knowledgeImportSelectAll" type="checkbox" ${allVisibleSelected?'checked':''} ${selectableVisibleRows.length?'':'disabled'}><span>全选当前可入库 ${selectableVisibleRows.length} 项</span></label><label class="knowledge-preview-filter"><span>显示范围</span><select id="knowledgeImportFilter"><option value="ALL" ${filter==='ALL'?'selected':''}>全部数据</option><option value="READY" ${filter==='READY'?'selected':''}>可入库</option><option value="SIMILAR" ${filter==='SIMILAR'?'selected':''}>相似待核对</option><option value="DUPLICATE" ${filter==='DUPLICATE'?'selected':''}>重复项</option><option value="INVALID" ${filter==='INVALID'?'selected':''}>需修改</option></select></label></div>
    <div class="knowledge-preview-list">${visibleRows.length?visibleRows.map(item=>{
      const info=statusInfo(item);const rowNo=Number(item.rowNo);const listId=`knowledge-import-subcategories-${rowNo}`;
      return `<details class="knowledge-preview-item ${info.tone}${dirty.has(rowNo)?' edited':''}" data-row="${rowNo}" ${expanded.has(rowNo)?'open':''}><summary><span class="import-check-wrap"><input class="knowledge-import-check" type="checkbox" data-row="${rowNo}" ${selected.has(rowNo)?'checked':''} ${item.importable?'':'disabled'} aria-label="选择第 ${item.sourceRow} 行"></span><span class="knowledge-preview-index">${item.sourceRow}</span><span class="knowledge-preview-title"><b data-import-title="${rowNo}">${esc(item.question||'未填写标准问题')}</b><small data-import-meta="${rowNo}">${esc(categoryNeedsReview(item)?'待选择大类':(item.category||publicCategory))} / ${esc(item.subcategory||'未分类')}${dirty.has(rowNo)?' · 已人工修改':''}</small></span><span class="import-review-status ${info.tone}" data-import-status="${rowNo}">${info.label}</span><span class="details-chevron">⌄</span></summary><div class="knowledge-preview-editor"><label class="full"><span>标准问题</span><input class="knowledge-import-edit" data-row="${rowNo}" data-field="question" maxlength="500" value="${esc(item.question||'')}" placeholder="请输入标准问题"></label><label class="full"><span>标准答案</span><textarea class="knowledge-import-edit" data-row="${rowNo}" data-field="answer" rows="3" maxlength="5000" placeholder="请输入标准答案">${esc(item.answer||'')}</textarea>${answerCounter(item)}</label><label class="full"><span>触发关键词 <em class="metadata-source ${String(item.keywordsSource||'').toLowerCase()}">${esc(knowledgeMetadataSourceLabel(item.keywordsSource))}</em></span>${renderKnowledgeKeywordPicker(item.keywordOptions,item.keywords,`import-${rowNo}`)}<small>勾选可准确触发答案的完整意图词；冲突词默认不选，仍可由运营人工确认。</small></label><label><span>知识大类 <em class="metadata-source ${String(item.categorySource||'').toLowerCase()}">${esc(knowledgeMetadataSourceLabel(item.categorySource))}</em></span><select class="knowledge-import-edit knowledge-import-category" data-row="${rowNo}" data-field="category">${categoryOptions(item)}</select><small>${item.aiRecommendation?.category?.reason?esc(item.aiRecommendation.category.reason):'固定六类，不支持自定义。'}</small></label><label><span>知识小类 <em class="metadata-source ${String(item.subcategorySource||'').toLowerCase()}">${esc(knowledgeMetadataSourceLabel(item.subcategorySource))}</em></span><input class="knowledge-import-edit knowledge-import-subcategory" data-row="${rowNo}" data-field="subcategory" maxlength="30" autocomplete="off" list="${listId}" value="${esc(item.subcategory||'未分类')}" placeholder="选择最近使用记录或输入自定义小类"><datalist id="${listId}" data-import-subcategory-list="${rowNo}">${datalistOptions(item.category)}</datalist><small>${item.aiRecommendation?.subcategory?.reason?esc(item.aiRecommendation.subcategory.reason):'候选随大类变化，最多显示最近 10 条。'}</small></label><div class="knowledge-import-diagnostics full"><span><b>匹配结果：</b>${esc(knowledgeMatchName(item.matchStatus))}${item.matchedKnowledgeId?`，匹配知识 #${item.matchedKnowledgeId}（${Math.round((item.matchScore||0)*100)}%）`:''}</span><span><b>AI推荐状态：</b>${esc(knowledgeMetadataStatusLabel(item.aiStatus))}${item.aiError?` · ${esc(item.aiError)}`:''}</span><span><b>预处理说明：</b>${esc((item.cleanNotes||[]).join('；')||'无需处理')}</span><span class="error-text" data-import-errors="${rowNo}" ${item.errors?.length?'':'hidden'}><b>待修正：</b>${esc((item.errors||[]).join('；'))}</span><small>修改后会在一键入库时由服务端重新校验平台字数、去重和字段有效性。</small></div></div></details>`;
    }).join(''):'<div class="knowledge-preview-no-result">当前筛选条件下没有数据。</div>'}</div>
    <div class="knowledge-preview-footer"><div><b>已选择 <span id="knowledgeImportSelectedCount">${selected.size}</span> 条</b><small>超平台字数的数据不可勾选，也不能提交入库。</small></div><button class="btn" id="commitKnowledgeImport" ${selected.size?'':'disabled'}>审核所选并一键入库</button></div>`;
  bindKnowledgeImportScrollPersistence(box);
  restoreKnowledgeImportScrollState(box,previousScroll);
  const syncSummary=()=>{const next={...(data.summary||{}),...summarizeKnowledgeImportRows(rows)};data.summary=next;Object.entries(next).forEach(([key,value])=>{const target=document.querySelector(`[data-import-summary="${key}"]`);if(target)target.textContent=value||0})};
  const syncSelection=()=>{rows.filter(item=>!item.importable).forEach(item=>selected.delete(Number(item.rowNo)));state.knowledgeImportSelected=[...selected];const count=$('#knowledgeImportSelectedCount');if(count)count.textContent=selected.size;const commit=$('#commitKnowledgeImport');if(commit)commit.disabled=!selected.size;const selectAll=$('#knowledgeImportSelectAll');if(selectAll){const selectedCount=selectableVisibleRows.filter(item=>item.importable&&selected.has(Number(item.rowNo))).length;const selectableCount=selectableVisibleRows.filter(item=>item.importable).length;selectAll.disabled=!selectableCount;selectAll.checked=selectableCount>0&&selectedCount===selectableCount;selectAll.indeterminate=selectedCount>0&&selectedCount<selectableCount}};
  const markDirty=(rowNo,item)=>{const values=new Set((state.knowledgeImportDirty||[]).map(Number));values.add(rowNo);state.knowledgeImportDirty=[...values];document.querySelector(`.knowledge-preview-item[data-row="${rowNo}"]`)?.classList.add('edited');const meta=document.querySelector(`[data-import-meta="${rowNo}"]`);if(meta)meta.textContent=`${item.category||publicCategory} / ${item.subcategory||'未分类'} · 已人工修改`};
  const updateRowUi=(rowNo,item)=>{
    const info=statusInfo(item);const details=document.querySelector(`.knowledge-preview-item[data-row="${rowNo}"]`);
    if(details){details.classList.remove('ready','invalid','duplicate','similar');details.classList.add(info.tone)}
    const status=document.querySelector(`[data-import-status="${rowNo}"]`);if(status){status.className=`import-review-status ${info.tone}`;status.textContent=info.label}
    const checkbox=document.querySelector(`.knowledge-import-check[data-row="${rowNo}"]`);if(checkbox){checkbox.disabled=!item.importable;checkbox.checked=item.importable&&selected.has(rowNo)}
    const errors=document.querySelector(`[data-import-errors="${rowNo}"]`);if(errors){errors.hidden=!(item.errors||[]).length;errors.innerHTML=`<b>待修正：</b>${esc((item.errors||[]).join('；'))}`}
    const counter=document.querySelector(`[data-import-answer-counter="${rowNo}"]`);if(counter){const count=Number(item.answerCharacterCount)||0;const limit=Number(item.answerCharacterLimit);const hasLimit=Number.isFinite(limit);const overLimit=hasLimit&&count>limit;counter.classList.toggle('over-limit',overLimit);counter.textContent=`当前 ${count}${hasLimit?` / ${limit}`:''} 字符${item.answerLimitLabel?` · ${item.answerLimitLabel}`:''}${overLimit?' · 超过平台字数，不能入库':''}`}
    syncSummary();syncSelection();
  };
  $('#knowledgeImportFilter').onchange=event=>{state.knowledgeImportFilter=event.target.value;renderKnowledgeImportPreview(data)};
  $('#knowledgeImportSelectAll').onchange=event=>{selectableVisibleRows.forEach(item=>event.target.checked?selected.add(Number(item.rowNo)):selected.delete(Number(item.rowNo)));syncSelection();document.querySelectorAll('.knowledge-import-check').forEach(input=>input.checked=!input.disabled&&selected.has(Number(input.dataset.row)))};
  document.querySelectorAll('.import-check-wrap').forEach(wrapper=>wrapper.onclick=event=>event.stopPropagation());
  document.querySelectorAll('.knowledge-import-check').forEach(input=>input.onchange=()=>{const rowNo=Number(input.dataset.row);const item=rows.find(entry=>Number(entry.rowNo)===rowNo);if(!item?.importable){input.checked=false;selected.delete(rowNo)}else input.checked?selected.add(rowNo):selected.delete(rowNo);syncSelection()});
  document.querySelectorAll('.knowledge-preview-item').forEach(details=>details.ontoggle=()=>{const rowNo=Number(details.dataset.row);const values=new Set((state.knowledgeImportExpanded||[]).map(Number));details.open?values.add(rowNo):values.delete(rowNo);state.knowledgeImportExpanded=[...values]});
  const handleImportEdit=input=>{const rowNo=Number(input.dataset.row);const item=rows.find(entry=>Number(entry.rowNo)===rowNo);if(!item)return;const field=input.dataset.field;const wasImportable=item.importable;applyKnowledgeImportReview(item,field,input.value,systemCategories,replyLimits);if(!item.importable)selected.delete(rowNo);else if(!wasImportable)selected.add(rowNo);if(field==='category'){const list=document.querySelector(`[data-import-subcategory-list="${rowNo}"]`);if(list)list.innerHTML=datalistOptions(item.category)}markDirty(rowNo,item);if(field==='question'){const title=document.querySelector(`[data-import-title="${rowNo}"]`);if(title)title.textContent=input.value.trim()||'未填写标准问题'}if((field==='question'||field==='answer')&&item.aiStatus==='DISCARDED'){const categoryInput=document.querySelector(`.knowledge-import-category[data-row="${rowNo}"]`);const subcategoryInput=document.querySelector(`.knowledge-import-subcategory[data-row="${rowNo}"]`);if(categoryInput)categoryInput.value=item.category;if(subcategoryInput)subcategoryInput.value=item.subcategory;const picker=document.querySelector(`[data-keyword-picker="import-${rowNo}"]`);if(picker&&item.keywordsSource==='DEFAULT'){picker.querySelector('.knowledge-keyword-value').value='';picker.querySelector('[data-keyword-summary]').textContent='请重新生成关键词';picker.querySelector('.knowledge-keyword-options').innerHTML='<p class="muted">问题或答案已修改，请点击上方“重新生成缺失字段”。</p>'}}if(field==='category')renderKnowledgeImportPreview(data);else updateRowUi(rowNo,item)};
  document.querySelectorAll('.knowledge-import-edit').forEach(input=>{input.autocomplete='off';if(input.matches('select'))input.onchange=()=>handleImportEdit(input);else input.oninput=()=>handleImportEdit(input)});
  bindKnowledgeKeywordPickers(box);
  box.querySelectorAll('.knowledge-keyword-value').forEach(hidden=>hidden.onchange=()=>{const picker=hidden.closest('[data-keyword-picker]');const rowNo=Number(String(picker?.dataset.keywordPicker||'').replace('import-',''));const item=rows.find(entry=>Number(entry.rowNo)===rowNo);if(!item)return;applyKnowledgeImportReview(item,'keywords',hidden.value,systemCategories,replyLimits);const previousOptions=new Map((item.keywordOptions||[]).map(option=>[String(option.text||''),option]));item.keywordOptions=[...picker.querySelectorAll('[data-keyword-option]')].map(input=>{const text=input.value;const previous=previousOptions.get(text)||{};const operator=input.closest('label')?.classList.contains('operator');return {...previous,text,source:operator?'OPERATOR':(previous.source||item.keywordsSource||'AI'),selectable:!input.disabled,conflict:input.closest('label')?.classList.contains('conflict'),selected:input.checked}});markDirty(rowNo,item);updateRowUi(rowNo,item)});
  const retryAi=$('#retryKnowledgeImportAi');if(retryAi)retryAi.onclick=async()=>{retryAi.disabled=true;retryAi.textContent='正在重新排队…';setKnowledgeImportStage('CLASSIFYING');try{const result=await api(`/api/knowledge/import/${data.batchId}/enrich`,{method:'POST',body:JSON.stringify({force:true})});data.enrichment=result.enrichment;renderKnowledgeImportPreview(data);scheduleKnowledgeImportEnrichmentPoll(data.batchId);toast('缺失字段已重新交给千问分析')}catch(error){setKnowledgeImportStage('REVIEWING');toast(error.message,true);retryAi.disabled=false;retryAi.textContent='重新生成缺失字段'}};
  const commit=$('#commitKnowledgeImport');
  if(commit)commit.onclick=async()=>{const selectedRows=rows.filter(item=>item.importable&&selected.has(Number(item.rowNo)));if(!selectedRows.length)return toast('请至少选择一条符合平台字数限制的数据',true);commit.disabled=true;commit.textContent='正在校验并入库…';setKnowledgeImportStage('COMMITTING');try{const result=await api('/api/knowledge/import/commit',{method:'POST',body:JSON.stringify({batchId:data.batchId,importedBy:'业务人员人工审核',selectedRowNos:selectedRows.map(item=>item.rowNo),reviewedItems:selectedRows.map(item=>({rowNo:item.rowNo,question:item.question,answer:item.answer,keywords:item.keywords,category:item.category,subcategory:item.subcategory}))})});const skipped=result.skipped?`，${result.skipped} 条因重复、字段或平台字数问题未入库`:'';toast(`已加入知识库草稿 ${result.imported} 条${skipped}`,Boolean(!result.imported&&result.skipped));if(knowledgeImportEnrichmentPollTimer){clearTimeout(knowledgeImportEnrichmentPollTimer);knowledgeImportEnrichmentPollTimer=null}state.knowledgeImportPreview=null;state.knowledgeImportSelected=[];state.knowledgeImportExpanded=[];state.knowledgeImportDirty=[];state.knowledgeImportFilter='ALL';setKnowledgeImportStage('IDLE');renderKnowledge()}catch(error){setKnowledgeImportStage('REVIEWING');toast(error.message,true);commit.disabled=false;commit.textContent='审核所选并一键入库'}};
  syncSelection();
}

async function renderManualHandoffPhrases(){
  const data=await api('/api/manual-handoff-phrases');
  const phrases=data.phrases||[];
  const builtins=data.builtinExamples||[];
  const enabledCount=phrases.filter(item=>item.status==='ENABLED').length;
  const taskLabels={QUEUED:'等待千问生成',RUNNING:'千问生成中',COMPLETED:'生成完成',FAILED:'生成失败',CANCELLED:'已重新生成',DISCARDED:'旧结果已丢弃'};
  const phraseRows=phrases.length?phrases.map(item=>{
    const enabled=item.status==='ENABLED';
    const taskStatus=item.alias_task_status||'';
    const taskLabel=taskLabels[taskStatus]||'尚未生成';
    const aliasClass=taskStatus==='FAILED'?'has-error':'';
    const aliasSummary=taskStatus==='QUEUED'||taskStatus==='RUNNING'?taskLabel:`AI相似说法 ${Number(item.alias_count||0)} 条 · 已启用 ${Number(item.enabled_alias_count||0)} 条`;
    return `<div class="handoff-phrase-row ${enabled?'':'is-disabled'}"><div class="handoff-phrase-main"><div><strong>${esc(item.phrase)}</strong><span class="badge ${enabled?'success':'disabled'}">${enabled?'已启用':'已停用'}</span></div><small>创建于 ${fmt(item.created_at)}${item.updated_at&&item.updated_at!==item.created_at?` · 更新于 ${fmt(item.updated_at)}`:''} · 版本 ${item.version||1}</small></div><button class="knowledge-alias-manage manage-handoff-aliases ${aliasClass}" type="button" data-id="${item.id}"><span>${esc(aliasSummary)}</span><small>${taskStatus==='FAILED'?esc(item.alias_task_error||'点击查看并重新生成'):'点击查看、勾选或重新生成'}</small></button><div class="handoff-phrase-actions"><button class="ghost edit-handoff-phrase" type="button" data-id="${item.id}" data-phrase="${esc(item.phrase)}">修改</button><button class="ghost toggle-handoff-phrase" type="button" data-id="${item.id}" data-next="${enabled?'disable':'enable'}">${enabled?'停用':'启用'}</button><button class="ghost danger delete-handoff-phrase" type="button" data-id="${item.id}" data-phrase="${esc(item.phrase)}" data-alias-count="${Number(item.alias_count||0)}">删除</button></div></div>`;
  }).join(''):`<div class="handoff-phrase-empty"><b>还没有自定义转人工说法</b><span>添加后千问会自动生成相似说法，再由运营人员勾选启用。</span></div>`;
  $('#content').innerHTML=`<div class="knowledge-head"><div><h2>知识库</h2><p>维护标准问答、RAG 文档、相似问法和私信转人工识别规则。</p></div><div class="knowledge-stats"><span>自定义转人工说法 <b>${phrases.length}</b></span><span>当前启用 <b>${enabledCount}</b></span></div></div>${renderKnowledgeTabs()}<div class="card handoff-phrase-panel"><div class="handoff-rule-note"><b>适用范围</b><span>本页标准说法、系统内置说法及 AI 相似说法不应用于微信客服。微信客服由自己的 Agent 判断是否需要人工接待。</span></div><div class="handoff-rule-note"><b>怎么触发</b><span>${esc(data.matchRule||'完整句匹配，仅私信生效')}。标准说法添加后，千问会自动生成相似说法；生成结果必须人工勾选保存后才启用。</span></div><form id="handoffPhraseForm" class="handoff-phrase-form"><label>新增标准转人工说法<div><input name="phrase" maxlength="80" placeholder="例如：麻烦让业务专员联系我" autocomplete="off" required><button class="btn" type="submit">添加并让千问生成</button></div><small>标准说法会立即启用；AI 相似说法默认关闭，避免把普通咨询误判成转人工。</small></label></form><section class="handoff-builtins"><div class="handoff-section-title"><div><h3>系统内置说法</h3><p>这些常见明确指令无需重复添加。</p></div><span>${builtins.length} 条示例</span></div><div class="handoff-chip-list">${builtins.map(item=>`<span>${esc(item)}</span>`).join('')}</div></section><section class="handoff-custom-list"><div class="handoff-section-title"><div><h3>自定义说法与 AI 相似说法</h3><p>每条标准说法旁都可以查看千问生成结果，并选择真正要启用的表达。</p></div></div><div class="handoff-phrase-list">${phraseRows}</div></section></div>`;
  bindKnowledgeTabs();
  $('#handoffPhraseForm').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');const phrase=String(new FormData(form).get('phrase')||'').trim();if(!phrase)return toast('请填写转人工说法',true);button.disabled=true;button.textContent='正在添加…';try{await api('/api/manual-handoff-phrases',{method:'POST',body:JSON.stringify({phrase,createdBy:'运营人员'})});toast('标准说法已添加，千问正在生成相似说法');renderManualHandoffPhrases()}catch(error){toast(error.message,true);button.disabled=false;button.textContent='添加并让千问生成'}};
  document.querySelectorAll('.manage-handoff-aliases').forEach(button=>button.onclick=async()=>{const item=phrases.find(entry=>Number(entry.id)===Number(button.dataset.id));if(!item)return;button.disabled=true;try{const result=await manualHandoffAliasSelectionDialog(item);if(result?.enabledIds){const saved=await api(`/api/manual-handoff-phrases/${item.id}/aliases/selections`,{method:'POST',body:JSON.stringify({enabledIds:result.enabledIds})});toast(`已启用 ${saved.selection.enabled} 条转人工相似说法${saved.selection.skippedConflicts?`，${saved.selection.skippedConflicts} 条冲突说法未启用`:''}`);renderManualHandoffPhrases()}else if(result?.regenerating)setTimeout(()=>{if(state.page==='knowledge'&&state.knowledgeView==='handoff')renderManualHandoffPhrases()},900)}catch(error){toast(error.message,true);button.disabled=false}});
  document.querySelectorAll('.toggle-handoff-phrase').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api(`/api/manual-handoff-phrases/${button.dataset.id}/${button.dataset.next}`,{method:'POST',body:JSON.stringify({updatedBy:'运营人员'})});toast(button.dataset.next==='enable'?'该说法及已勾选的相似说法已启用':'该标准说法及其相似说法已整体停用');renderManualHandoffPhrases()}catch(error){toast(error.message,true);button.disabled=false}});
  document.querySelectorAll('.edit-handoff-phrase').forEach(button=>button.onclick=async()=>{const phrase=window.prompt('修改转人工说法；保存后千问会按新版本重新生成相似说法',button.dataset.phrase||'');if(phrase===null)return;const next=String(phrase).trim();if(!next)return toast('转人工说法不能为空',true);button.disabled=true;try{await api(`/api/manual-handoff-phrases/${button.dataset.id}`,{method:'PUT',body:JSON.stringify({phrase:next,updatedBy:'运营人员'})});toast('标准说法已修改，旧相似说法已失效，千问正在重新生成');renderManualHandoffPhrases()}catch(error){toast(error.message,true);button.disabled=false}});
  document.querySelectorAll('.delete-handoff-phrase').forEach(button=>button.onclick=async()=>{const aliasCount=Number(button.dataset.aliasCount||0);const confirmed=await confirmDelete({title:'删除这条转人工说法？',message:`说法：${button.dataset.phrase}`,details:[`删除后将同时永久删除 ${aliasCount} 条 AI 相似说法和相关生成任务。`,'系统内置说法不会受到影响；如误删，可重新添加并让千问再次生成。'],confirmLabel:'删除说法'});if(!confirmed)return;try{await api(`/api/manual-handoff-phrases/${button.dataset.id}`,{method:'DELETE',body:'{}'});toast('标准说法及其 AI 相似说法已删除');renderManualHandoffPhrases()}catch(error){toast(error.message,true)}});
  if(phrases.some(item=>['QUEUED','RUNNING'].includes(item.alias_task_status)))setTimeout(()=>{if(state.page==='knowledge'&&state.knowledgeView==='handoff')renderManualHandoffPhrases()},2500);
}

function browserFileBase64(file){
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('读取上传文件失败'));reader.onload=()=>resolve(String(reader.result||'').split(',').pop()||'');reader.readAsDataURL(file)});
}
function ragDocumentStatusText(status){return ({UPLOADED:'已上传',PROCESSING:'处理中',READY_FOR_TEST:'待测试',FAILED:'处理失败',PROCESS_FAILED:'处理失败'}[String(status||'').toUpperCase()]||statusName(status)||status||'未知状态')}
function unifiedRagDocumentLabel(value='',item={}){
  const raw=String(value||'').trim();
  if(/旧知识迁移\s*[-—]\s*(小红书|抖音|微博|视频号|B站|公共)知识库/.test(raw)){
    const id=String(item.documentId||'').replace(/^document-/,'').slice(-6);
    return `历史知识文档${id?` · ${id}`:''}`;
  }
  return raw.replace(/(小红书|抖音|微博|视频号|B站)知识库/g,'$1来源').replace(/公共知识库/g,'公共来源');
}
function isLegacyPlatformMigrationDocument(item={}){
  const value=`${item.title||''} ${item.filename||''}`;
  return /旧知识迁移/i.test(value)&&!/(公共来源|公共知识库)/i.test(value);
}
function sameRagDocument(left={},right={}){
  return String(left.documentId||left.document_id||'')===String(right.documentId||right.document_id||'')&&Number(left.documentVersion||left.document_version||1)===Number(right.documentVersion||right.document_version||1);
}
function ragDocumentLifecycle(item,releases=[],activeMembers=[]){
  if(!item)return {step:0,status:'',detail:'点击右侧文档，查看该文件的处理进度。'};
  const status=String(item.status||'').toUpperCase();
  if(['UPLOADED','PROCESSING'].includes(status))return {step:1,status,detail:'正在解析文档',busy:true};
  if(['FAILED','PROCESS_FAILED'].includes(status))return {step:1,status,detail:'文档处理失败',error:true};
  // Parse readiness remains the service contract; tested state comes from persisted release snapshots.
  const release=releases.filter(entry=>['BUILDING','PUBLISHED','FAILED','ROLLED_BACK'].includes(String(entry.status||'').toUpperCase())&&(entry.candidateDocuments||[]).some(candidate=>sameRagDocument(candidate,item)))
    .sort((a,b)=>(Date.parse(b.createdAt||'')||0)-(Date.parse(a.createdAt||'')||0))[0];
  const releaseStatus=String(release?.status||'').toUpperCase();
  if(releaseStatus==='BUILDING')return {step:4,status:'TESTED',detail:'已测试 · 正在发布',busy:true};
  if(releaseStatus==='FAILED')return {step:4,status:'TESTED',detail:'已测试 · 发布失败，请查看发布版本的错误信息',error:true};
  if(activeMembers.some(member=>sameRagDocument(member,item)))return {step:5,status:'TESTED',detail:'已测试 · 已正式发布，当前用户端生效'};
  if(['PUBLISHED','ROLLED_BACK'].includes(releaseStatus))return {step:4,status:'TESTED',detail:'已测试 · 当前正式版本未包含此文档'};
  if(status==='READY_FOR_TEST')return {step:2,status,detail:'待测试 · 请到小智验证回答效果'};
  return {step:0,status,detail:ragDocumentStatusText(status)};
}
function renderRagDocumentProgress(item,releases=[],activeMembers=[]){
  const lifecycle=ragDocumentLifecycle(item,releases,activeMembers);
  const filename=item?unifiedRagDocumentLabel(item.filename||item.title||item.documentId,item):'尚未选择文档';
  const steps=[['上传资料','选择知识文档'],['解析处理','自动读取内容'],['小智测试','验证回答效果'],['运营确认','启用或不启用'],['正式发布','应用到用户端']];
  return `<div class="rag-progress-document"><span>当前文档</span><b>${esc(filename)}</b>${item?`<small>v${Number(item.documentVersion)||1}</small>`:''}</div><div class="rag-progress-status ${lifecycle.error?'error-text':''}">${esc(lifecycle.detail)}</div><div class="flow mini-flow knowledge-mini-flow" aria-label="知识文档处理流程">${steps.map(([title,description],index)=>`<div class="flow-step ${index<lifecycle.step?'is-complete':index===lifecycle.step?`is-active ${lifecycle.busy?'':'is-idle'} ${lifecycle.error?'is-error':''}`:''}" ${index===lifecycle.step?'aria-current="step"':''}><b>${index<lifecycle.step?'✓':index+1}</b><span>${title}</span><small>${description}</small></div>`).join('')}</div>`;
}
function selectRagProgressDocument(item,releases=[],activeMembers=[]){
  if(!item)return;
  state.ragCurrentDocumentId=item.documentId;
  state.ragCurrentDocumentVersion=Number(item.documentVersion)||1;
  state.ragUploadStage=String(item.status||'').toUpperCase();
  const progress=$('#ragDocumentProgress');
  if(progress)progress.innerHTML=renderRagDocumentProgress(item,releases,activeMembers);
  document.querySelectorAll('.rag-document-selectable').forEach(card=>{
    const selected=sameRagDocument({documentId:card.dataset.documentId,documentVersion:card.dataset.version},item);
    card.classList.toggle('is-selected',selected);
    card.setAttribute('aria-current',String(selected));
  });
}
function ragChunkLocationLabel(chunk={}){
  const location=chunk.location&&typeof chunk.location==='object'?chunk.location:{};
  const parts=[];
  if(location.page!==undefined&&location.page!==null)parts.push(`第 ${location.page} 页`);
  if(location.sheet)parts.push(`工作表：${location.sheet}`);
  const rowStart=location.rowStart??location.row;
  const rowEnd=location.rowEnd;
  if(rowStart!==undefined&&rowStart!==null)parts.push(rowEnd&&rowEnd!==rowStart?`第 ${rowStart}-${rowEnd} 行`:`第 ${rowStart} 行`);
  if(location.lineStart!==undefined&&location.lineStart!==null)parts.push(location.lineEnd&&location.lineEnd!==location.lineStart?`第 ${location.lineStart}-${location.lineEnd} 行文本`:`第 ${location.lineStart} 行文本`);
  if(location.splitPart)parts.push(`分片 ${location.splitPart}`);
  return parts.join(' · ')||'原文片段';
}
async function showRagDocumentContent(item={}){
  const version=Number(item.documentVersion)||1;
  try{
    const data=await api(`/api/rag/documents/${encodeURIComponent(item.documentId)}/chunks?version=${encodeURIComponent(version)}`);
    const chunks=Array.isArray(data.chunks)?data.chunks:[];
    const overlay=document.createElement('div');
    overlay.className='confirm-overlay rag-content-overlay';
    overlay.innerHTML=`<div class="confirm-dialog rag-content-dialog" role="dialog" aria-modal="true" aria-labelledby="ragContentTitle"><div class="knowledge-edit-heading"><div><span>文件解析内容</span><h3 id="ragContentTitle">${esc(unifiedRagDocumentLabel(item.filename||item.title||'知识文档',item))}</h3></div><button class="knowledge-edit-close rag-content-close" type="button" aria-label="关闭">×</button></div><p>共解析为 ${chunks.length} 个内容片段，以下内容已写入 RAG 待测试区。</p><div class="rag-content-list">${chunks.map((chunk,index)=>`<article class="rag-content-item"><div class="meta"><b>内容片段 ${index+1}</b><span>${esc(ragChunkLocationLabel(chunk))}</span></div>${Array.isArray(chunk.section_path)&&chunk.section_path.length?`<div class="rag-content-section">${esc(chunk.section_path.join(' / '))}</div>`:''}<pre>${esc(chunk.text||chunk.excerpt||'')}</pre></article>`).join('')||'<div class="empty">当前文件还没有可查看的解析内容。</div>'}</div></div>`;
    const close=()=>{window.removeEventListener('keydown',onKeyDown);overlay.remove()};
    const onKeyDown=event=>{if(event.key==='Escape')close()};
    overlay.addEventListener('click',event=>{if(event.target===overlay||event.target.closest('.rag-content-close'))close()});
    document.body.appendChild(overlay);
    window.addEventListener('keydown',onKeyDown);
  }catch(error){toast(error.message||'读取文件内容失败',true)}
}
async function showRagReleaseDetails(item={},activeId=null){
  const releaseId=String(item.releaseId||item.release_id||'').trim();
  if(!releaseId)return;
  const data=await api(`/api/rag/releases/${encodeURIComponent(releaseId)}/documents`);
  const documents=Array.isArray(data.documents)?data.documents:[];
  const overlay=document.createElement('div');
  overlay.className='confirm-overlay rag-release-detail-overlay';
  overlay.dataset.releaseId=releaseId;
  overlay.innerHTML=`<div class="confirm-dialog rag-release-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="ragReleaseDetailTitle"><div class="knowledge-edit-heading"><div><span>知识库正式版本</span><h3 id="ragReleaseDetailTitle">发布版本详情</h3></div><button class="knowledge-edit-close rag-release-detail-close" type="button" aria-label="关闭">×</button></div><dl class="rag-release-summary"><div><dt>知识版本</dt><dd>${esc(item.knowledgeVersion||'构建中')}</dd></div><div><dt>状态</dt><dd class="rag-release-detail-status">${ragReleaseBadgeCache.get(releaseId)||ragReleaseView(item,activeId).badge}</dd></div><div><dt>发布日期</dt><dd>${fmt(item.publishedAt||item.createdAt)}</dd></div><div><dt>发布人</dt><dd>${esc(item.publishedBy||'—')}</dd></div></dl><div class="rag-release-document-heading"><h4>该版本包含的文档</h4><span>${documents.length} 个文档</span></div><div class="rag-release-document-list" role="list">${documents.map(document=>`<div class="rag-release-document-row" role="listitem"><span class="rag-release-document-icon" aria-hidden="true">▤</span><div class="rag-release-document-copy"><b>${esc(document.filename||'知识文档')}</b><small>文档版本 v${Number(document.documentVersion)||1}</small></div><div class="rag-release-document-date"><span>上传日期</span><b>${fmt(document.uploadedAt)}</b></div></div>`).join('')||'<div class="empty">该发布版本暂未包含文档。</div>'}</div><div class="confirm-actions"><button class="btn secondary rag-release-detail-close" type="button">关闭</button></div></div>`;
  const close=()=>{window.removeEventListener('keydown',onKeyDown);overlay.remove()};
  const onKeyDown=event=>{if(event.key==='Escape')close()};
  overlay.addEventListener('click',event=>{if(event.target===overlay||event.target.closest('.rag-release-detail-close'))close()});
  document.body.appendChild(overlay);
  window.addEventListener('keydown',onKeyDown);
  overlay.querySelector('.rag-release-detail-close')?.focus();
}
function materialKnowledgeDraftStatusText(status){return ({PENDING_CONFIRMATION:'待确认',IMPORTING:'正在加入知识库',IMPORTED:'已加入知识库',FAILED:'处理失败',IGNORED:'已忽略'}[String(status||'').toUpperCase()]||statusName(status)||'未知状态')}
function showMaterialKnowledgeDraft(draft={},editable=false){
  const overlay=document.createElement('div');
  overlay.className='confirm-overlay rag-content-overlay';
  const uncertain=Array.isArray(draft.uncertainFacts)?draft.uncertainFacts:[];
  overlay.innerHTML=`<div class="confirm-dialog rag-content-dialog material-knowledge-draft-dialog" role="dialog" aria-modal="true" aria-labelledby="materialKnowledgeDraftTitle"><div class="knowledge-edit-heading"><div><span>AI 生成草稿</span><h3 id="materialKnowledgeDraftTitle">${editable?'编辑知识草稿':'查看知识草稿'}</h3></div><button class="knowledge-edit-close material-draft-close" type="button" aria-label="关闭">×</button></div><form class="material-draft-form"><label>知识标题<input name="title" maxlength="100" value="${esc(draft.title||'')}" ${editable?'':'readonly'}></label><label>知识内容<textarea name="contentMarkdown" rows="18" ${editable?'':'readonly'}>${esc(draft.contentMarkdown||'')}</textarea></label>${uncertain.length?`<div class="notice warn"><b>需要人工确认（不会自动加入正文）</b><ul>${uncertain.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:''}<div class="muted">来源素材：${esc(draft.materialFilename||'—')} · 生成时间：${fmt(draft.createdAt)}</div><div class="confirm-actions"><button class="btn secondary material-draft-close" type="button">关闭</button>${editable?'<button class="btn" type="submit">保存修改</button>':''}</div></form></div>`;
  const close=()=>{window.removeEventListener('keydown',onKeyDown);overlay.remove()};
  const onKeyDown=event=>{if(event.key==='Escape')close()};
  overlay.addEventListener('click',event=>{if(event.target===overlay||event.target.closest('.material-draft-close'))close()});
  const form=overlay.querySelector('form');
  if(editable)form.onsubmit=async event=>{event.preventDefault();const submit=form.querySelector('button[type=submit]');submit.disabled=true;submit.textContent='正在保存…';try{const values=new FormData(form);await api(`/api/material-knowledge-drafts/${draft.id}`,{method:'PUT',body:JSON.stringify({title:String(values.get('title')||'').trim(),contentMarkdown:String(values.get('contentMarkdown')||'').trim()})});close();toast('知识草稿已保存');renderRagKnowledge()}catch(error){toast(error.message||'保存知识草稿失败',true);submit.disabled=false;submit.textContent='保存修改'}};
  document.body.appendChild(overlay);
  window.addEventListener('keydown',onKeyDown);
}
function ragReleaseStatusText(status){return ({BUILDING:'构建中',PUBLISHED:'已发布',FAILED:'发布失败',ROLLED_BACK:'已回滚'}[String(status||'').toUpperCase()]||statusName(status)||status||'未知状态')}
function ragReleaseView(item={},activeId=null){
  const releaseId=String(item.releaseId||item.release_id||'').trim();
  const status=String(item.status||'').toUpperCase();
  const published=['PUBLISHED','ROLLED_BACK'].includes(status);
  const active=Boolean(releaseId)&&releaseId===activeId;
  const label=active?'当前正式版本':published?'历史版本':ragReleaseStatusText(status);
  const badgeClass=active?'success':published?'disabled':status.toLowerCase();
  return {releaseId,canRollback:Boolean(releaseId)&&published&&!active,badge:`<span class="badge ${esc(badgeClass)}">${esc(label)}</span>`};
}
function clearRagKnowledgePoll(){if(ragKnowledgePollTimer){clearTimeout(ragKnowledgePollTimer);ragKnowledgePollTimer=null}}
function ragUploadFormHasDraft(){const form=$('#ragDocumentUpload');if(!form)return false;const active=document.activeElement;if(active&&form.contains(active))return true;return Boolean(form.elements.file?.files?.length)}
function trackRagLifecycleChanges(documents=[],releases=[]){
  documents.forEach(item=>{const key=`${item.documentId}:${Number(item.documentVersion)||1}`;const status=String(item.status||'').toUpperCase();const previous=ragDocumentStatusCache.get(key);ragDocumentStatusCache.set(key,status);if(String(item.documentId)===String(state.ragCurrentDocumentId)&&Number(item.documentVersion||1)===Number(state.ragCurrentDocumentVersion||1)){if(['UPLOADED','PROCESSING'].includes(status))state.ragUploadStage=status;else if(status==='READY_FOR_TEST')state.ragUploadStage='READY_FOR_TEST';else if(status==='FAILED'||status==='PROCESS_FAILED')state.ragUploadStage='FAILED'}if(previous&&previous!==status){if(status==='READY_FOR_TEST'){state.xiaozhiOptions=null;toast(`文档“${unifiedRagDocumentLabel(item.title||item.filename||item.documentId,item)}”已经处理完成，可以进入小智测试`)}else if(status==='FAILED'||status==='PROCESS_FAILED')toast(`文档“${unifiedRagDocumentLabel(item.title||item.filename||item.documentId,item)}”处理失败，请查看错误信息`,true)}});
  if(state.ragCurrentDocumentId&&!documents.some(item=>String(item.documentId)===String(state.ragCurrentDocumentId)&&Number(item.documentVersion||1)===Number(state.ragCurrentDocumentVersion||1))){state.ragCurrentDocumentId=null;state.ragCurrentDocumentVersion=null;state.ragUploadStage='IDLE'}
  releases.forEach(item=>{const releaseId=item.releaseId||item.release_id;if(!releaseId)return;const status=String(item.status||'').toUpperCase();const previous=ragReleaseStatusCache.get(releaseId);ragReleaseStatusCache.set(releaseId,status);if(previous&&previous!==status){if(status==='PUBLISHED'){state.xiaozhiOptions=null;toast(`发布版本 ${releaseId} 已成功启用到正式用户端`)}else if(status==='FAILED')toast(`发布版本 ${releaseId} 构建失败，未启用到正式用户端`,true)}})
}
function scheduleRagKnowledgePoll(documents=[],releases=[]){
  clearRagKnowledgePoll();
  const pending=documents.some(item=>['UPLOADED','PROCESSING'].includes(String(item.status||'').toUpperCase()))||releases.some(item=>String(item.status||'').toUpperCase()==='BUILDING');
  if(!pending)return;
  ragKnowledgePollTimer=setTimeout(async()=>{ragKnowledgePollTimer=null;if(state.page!=='knowledge'||state.knowledgeView!=='rag')return;if(document.hidden||ragUploadFormHasDraft()){scheduleRagKnowledgePoll(documents,releases);return}try{await renderRagKnowledge()}catch{scheduleRagKnowledgePoll(documents,releases)}},2500)
}
async function renderRagKnowledge(){
  clearRagKnowledgePoll();
  const statusData=await api('/api/rag/status');
  const rag=statusData.rag||{};
  if(!rag.enabled||!rag.configured){
    $('#content').innerHTML=`${renderKnowledgeTabs()}<div class="panel"><div class="panel-head"><div><h2>知识文档与发布</h2><p>知识库服务尚未启用。</p></div></div><div class="notice warn">请先完成本地知识库服务配置，配置完成后运营人员即可在这里上传资料。</div></div>`;
    bindKnowledgeTabs();return;
  }
  const [documentData,releaseData,draftData]=await Promise.all([api('/api/rag/documents'),api('/api/rag/releases'),api('/api/material-knowledge-drafts')]);
  const allDocuments=documentData.documents||[];
  const drafts=(draftData.drafts||[]).sort((a,b)=>(Date.parse(b.createdAt||b.updatedAt||'')||0)-(Date.parse(a.createdAt||a.updatedAt||'')||0));
  const documentSortTime=item=>Date.parse(item.versionCreatedAt||item.version_created_at||item.createdAt||item.created_at||item.updatedAt||item.updated_at||'')||0;
  const documents=allDocuments.filter(item=>!isLegacyPlatformMigrationDocument(item)).sort((a,b)=>documentSortTime(b)-documentSortTime(a));
  const releases=releaseData.releases||[];
  const activeId=releaseData.active?.release_id||releaseData.active?.releaseId||null;
  const activeMembersData=activeId?await api(`/api/rag/releases/${encodeURIComponent(activeId)}/members`):{members:[]};
  const activeMembers=Array.isArray(activeMembersData.members)?activeMembersData.members:[];
  trackRagLifecycleChanges(allDocuments,releases);
  const documentByKey=new Map(allDocuments.map(item=>[`${item.documentId}:${Number(item.documentVersion)||1}`,item]));
  const appliedFiles=[...new Map(activeMembers.map(member=>{
    const documentId=member.documentId||member.document_id;
    const documentVersion=Number(member.documentVersion||member.document_version||1);
    const key=`${documentId}:${documentVersion}`;
    const source=documentByKey.get(key);
    return [key,{documentId,documentVersion,filename:source?.filename||source?.title||member.filename||member.title||documentId,chunkCount:0}];
  })).values()];
  activeMembers.forEach(member=>{
    const key=`${member.documentId||member.document_id}:${Number(member.documentVersion||member.document_version||1)}`;
    const file=appliedFiles.find(item=>`${item.documentId}:${item.documentVersion}`===key);
    if(file)file.chunkCount+=1;
  });
  appliedFiles.sort((a,b)=>String(a.filename).localeCompare(String(b.filename),'zh-CN'));
  const draftCards=drafts.map(item=>{const status=String(item.status||'').toUpperCase();const failed=status==='FAILED';return `<article class="rag-document-card material-knowledge-draft-card ${failed?'is-failed':''}"><div class="meta"><span>${badge(item.status)} <b>${esc(item.title||'视频知识内容')}</b></span><span>AI生成草稿</span></div><p>来源素材：${esc(item.materialFilename||'—')}</p><div class="muted">${Number(item.keyFacts?.length||0)} 个关键知识点 · ${Number(item.faqs?.length||0)} 组常见问题 · ${Number(item.uncertainFacts?.length||0)} 项需要人工确认 · ${materialKnowledgeDraftStatusText(item.status)} · ${fmt(item.createdAt)}</div>${item.errorMessage?`<div class="notice error">${esc(item.errorMessage)}</div>`:''}<div class="button-row compact"><button class="btn secondary material-draft-view" type="button" data-draft-id="${item.id}">查看内容</button><button class="btn secondary material-draft-edit" type="button" data-draft-id="${item.id}">编辑</button><button class="btn secondary material-draft-regenerate" type="button" data-draft-id="${item.id}">重新生成</button><button class="btn material-draft-import" type="button" data-draft-id="${item.id}">加入知识库</button><button class="btn danger material-draft-delete" type="button" data-draft-id="${item.id}">删除</button></div></article>`}).join('');
  const documentCards=documents.map(item=>{const status=String(item.status||'').toUpperCase();const version=Number(item.documentVersion)||1;const lifecycle=ragDocumentLifecycle(item,releases,activeMembers);return `<article class="rag-document-card rag-document-selectable" tabindex="0" data-document-id="${esc(item.documentId)}" data-version="${version}" aria-label="查看${esc(unifiedRagDocumentLabel(item.filename||item.title||item.documentId,item))}的处理进度"><div class="meta"><span>${badge(lifecycle.status)} <b>${esc(unifiedRagDocumentLabel(item.title||item.filename||item.documentId,item))}</b></span><span>v${version}</span></div><p>${esc(unifiedRagDocumentLabel(item.filename||'—',item))}</p><div class="muted">统一知识库 · 文档 ID：${esc(item.documentId)} · ${esc(lifecycle.status==='TESTED'?'已测试':ragDocumentStatusText(item.status))} · 更新于 ${fmt(item.updatedAt||item.createdAt)}</div>${item.error?`<div class="notice error">${esc(item.error.message||item.error.code||'文档处理失败')}</div>`:''}<div class="button-row compact"><button class="btn secondary rag-document-refresh" type="button" data-document-id="${esc(item.documentId)}" data-version="${version}">刷新状态</button><button class="btn secondary rag-document-content" type="button" data-document-id="${esc(item.documentId)}" data-version="${version}">查看内容</button>${status==='READY_FOR_TEST'?`<button class="btn rag-document-test" type="button" data-document-id="${esc(item.documentId)}" data-version="${version}">到小智测试</button>`:''}<button class="btn danger rag-document-delete" type="button" data-document-id="${esc(item.documentId)}" data-version="${version}" data-filename="${esc(item.filename||item.title||'知识文档')}" ${['UPLOADED','PROCESSING'].includes(status)?'disabled':''}>删除</button></div></article>`}).join('');
  ragReleaseBadgeCache.clear();
  const releaseCards=releases.map(item=>{const {releaseId,canRollback,badge:statusBadge}=ragReleaseView(item,activeId);ragReleaseBadgeCache.set(releaseId,statusBadge);return `<article class="rag-release-card"><div class="meta"><span>${statusBadge} <b>${esc(releaseId)}</b></span><span>${fmt(item.publishedAt||item.createdAt)}</span></div><p>知识版本：${esc(item.knowledgeVersion||'构建中')}</p><div class="muted">启用测试 ${Number(item.enabledTestCaseCount||0)} 条 · 不启用 ${Number(item.disabledTestCaseCount||0)} 条 · 发布人 ${esc(item.publishedBy||'—')}</div>${item.error?`<div class="notice error">${esc(item.error.message||item.error.code||'发布失败')}</div>`:''}<div class="button-row compact rag-release-actions"><button class="btn secondary rag-release-details" type="button" data-release-id="${esc(releaseId)}">详情</button>${canRollback?`<button class="btn secondary rag-release-rollback" type="button" data-release-id="${esc(releaseId)}">回滚到此版本</button>`:''}</div></article>`}).join('');
  document.querySelectorAll('.rag-release-detail-overlay').forEach(overlay=>{const status=overlay.querySelector('.rag-release-detail-status');const statusBadge=ragReleaseBadgeCache.get(overlay.dataset.releaseId);if(status&&statusBadge)status.innerHTML=statusBadge});
  const appliedFileCards=appliedFiles.map(item=>`<article class="rag-applied-file-card"><div class="rag-applied-file-icon">▤</div><div class="rag-applied-file-copy"><b>${esc(unifiedRagDocumentLabel(item.filename,item))}</b><small>文档 ID：${esc(item.documentId)} · v${item.documentVersion} · 已应用 ${item.chunkCount} 个内容片段</small></div><span class="badge success">用户端生效</span></article>`).join('');
  const selectedDocument=documents.find(item=>sameRagDocument(item,{documentId:state.ragCurrentDocumentId,documentVersion:state.ragCurrentDocumentVersion}))||documents[0];
  $('#content').innerHTML=`${renderKnowledgeTabs()}<section class="rag-knowledge-page"><div class="knowledge-import-workspace rag-upload-workspace"><div class="panel knowledge-import-panel"><div class="panel-head knowledge-import-head"><div><h2>文档批量导入</h2><p>选择资料后直接上传，系统会自动解析并放入待测试区。</p></div><span class="badge success">服务正常</span></div><div id="ragDocumentProgress" aria-live="polite">${renderRagDocumentProgress(selectedDocument,releases,activeMembers)}</div><div class="knowledge-template-tip"><span class="knowledge-template-tip-icon">i</span><span><b>所有资料进入同一个知识库</b><small>无需填写额外信息，系统直接使用原文件名识别资料。</small></span></div><form id="ragDocumentUpload" class="knowledge-upload-form"><input id="ragDocumentFile" name="file" class="knowledge-file-input" type="file" accept=".pdf,.docx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl" required><label id="ragUploadZone" class="knowledge-file-picker" for="ragDocumentFile"><span class="knowledge-upload-icon">⇧</span><span class="knowledge-upload-copy"><b id="ragDocumentFileName">点击选择或拖拽知识文档</b><small>PDF、DOCX、XLSX、TXT、MD、CSV、TSV、JSON · 最大 50MB</small></span><span class="knowledge-choose-file">选择文件</span></label><button class="btn knowledge-upload-submit" type="submit">上传并开始处理</button></form><div class="clean-note">上传后不会直接应用到用户端。文档处理完成后，请先进入“小智”测试，确认满意后再发布。</div></div><div class="panel knowledge-preview-panel"><div class="panel-head"><div><h2>文档处理与测试</h2><p>查看资料处理状态；达到“可测试”后可直接进入小智验证。</p></div><span class="muted">${drafts.length} 个AI草稿 · ${documents.length} 个文档</span></div><div class="rag-card-grid rag-document-list">${draftCards?`<div class="rag-list-section-label"><b>AI生成草稿</b><span>确认后才会加入统一知识库</span></div>${draftCards}`:''}${documentCards?`<div class="rag-list-section-label"><b>已上传文档</b><span>按最新时间排序</span></div>${documentCards}`:''}${!draftCards&&!documentCards?'<div class="empty">还没有知识草稿或上传文档。</div>':''}</div></div></div><div class="panel"><div class="panel-head"><div><h2>知识库发布版本</h2><p>测试并确认后的资料发布后，供所有平台共同使用。</p></div><button class="btn secondary" id="ragReleaseRefresh">刷新版本</button></div><div class="notice">当前正式版本：<b>${esc(activeId||'暂无')}</b></div><div class="rag-card-grid">${releaseCards||'<div class="empty">暂无发布版本。</div>'}</div></div><div class="panel rag-applied-panel"><div class="panel-head"><div><h2>已应用到用户端的文件</h2><p>${activeId?`以下文件属于当前正式版本 ${esc(activeId)}，已供所有平台共同使用。`:'当前还没有正式发布版本，文件发布后会显示在这里。'}</p></div><span class="badge ${activeId?'success':'disabled'}">${activeId?'正式生效':'尚未生效'}</span></div><div class="rag-applied-file-list">${appliedFileCards||'<div class="empty">暂无已应用到用户端的文件。</div>'}</div></div></section>`;
  bindKnowledgeTabs();
  if(selectedDocument)selectRagProgressDocument(selectedDocument,releases,activeMembers);
  document.querySelectorAll('.rag-document-selectable').forEach(card=>{
    const select=()=>{const item=documents.find(entry=>sameRagDocument(entry,{documentId:card.dataset.documentId,documentVersion:card.dataset.version}));selectRagProgressDocument(item,releases,activeMembers)};
    card.onclick=event=>{if(!event.target.closest('button,a,input,select,textarea'))select()};
    card.onkeydown=event=>{if(event.target===card&&['Enter',' '].includes(event.key)){event.preventDefault();select()}};
  });
  const uploadForm=$('#ragDocumentUpload');
  const uploadInput=$('#ragDocumentFile');
  const uploadZone=$('#ragUploadZone');
  const updateUploadFile=file=>{const name=$('#ragDocumentFileName');if(name)name.textContent=file?file.name:'点击选择或拖拽知识文档';uploadZone?.classList.toggle('has-file',Boolean(file))};
  uploadInput.onchange=()=>updateUploadFile(uploadInput.files?.[0]||null);
  ['dragenter','dragover'].forEach(type=>uploadZone.addEventListener(type,event=>{event.preventDefault();uploadZone.classList.add('is-dragging')}));
  ['dragleave','drop'].forEach(type=>uploadZone.addEventListener(type,event=>{event.preventDefault();uploadZone.classList.remove('is-dragging')}));
  uploadZone.addEventListener('drop',event=>{const file=event.dataTransfer?.files?.[0];if(!file)return;const transfer=new DataTransfer();transfer.items.add(file);uploadInput.files=transfer.files;updateUploadFile(file)});
  uploadForm.onsubmit=async event=>{event.preventDefault();const submit=uploadForm.querySelector('button[type=submit]');const file=uploadInput.files?.[0];if(!(file instanceof File)||!file.size)return toast('请选择要上传的知识文档',true);if(file.size>50*1024*1024)return toast('文件不能超过 50MB',true);submit.disabled=true;submit.textContent='正在上传…';try{const contentBase64=await browserFileBase64(file);const result=await api('/api/rag/documents',{method:'POST',body:JSON.stringify({filename:file.name,mimeType:file.type||'application/octet-stream',contentBase64})});const uploaded=result.document||{};state.ragCurrentDocumentId=uploaded.documentId||null;state.ragCurrentDocumentVersion=Number(uploaded.documentVersion)||1;state.ragUploadStage=String(uploaded.status||'PROCESSING').toUpperCase();state.xiaozhiOptions=null;toast('文档已上传，正在处理；完成后即可进入小智测试');renderRagKnowledge()}catch(error){toast(error.message||'上传失败',true);submit.disabled=false;submit.textContent='上传并开始处理'}};
  document.querySelectorAll('.material-draft-view').forEach(button=>button.onclick=()=>{const draft=drafts.find(item=>Number(item.id)===Number(button.dataset.draftId));if(draft)showMaterialKnowledgeDraft(draft,false)});
  document.querySelectorAll('.material-draft-edit').forEach(button=>button.onclick=()=>{const draft=drafts.find(item=>Number(item.id)===Number(button.dataset.draftId));if(draft)showMaterialKnowledgeDraft(draft,true)});
  document.querySelectorAll('.material-draft-regenerate').forEach(button=>button.onclick=async()=>{button.disabled=true;button.textContent='正在重新生成…';try{await api(`/api/material-knowledge-drafts/${button.dataset.draftId}/regenerate`,{method:'POST',body:'{}'});toast('知识草稿已重新生成');renderRagKnowledge()}catch(error){toast(error.message||'重新生成失败',true);button.disabled=false;button.textContent='重新生成'}});
  document.querySelectorAll('.material-draft-import').forEach(button=>button.onclick=async()=>{const draft=drafts.find(item=>Number(item.id)===Number(button.dataset.draftId));if(!draft||!window.confirm('确认将这份草稿加入统一知识库？\n加入后仍需经过小智测试和正式发布，才会应用到用户端。'))return;button.disabled=true;button.textContent='正在加入…';try{const result=await api(`/api/material-knowledge-drafts/${draft.id}/import`,{method:'POST',body:'{}'});const document=result.document||{};state.ragCurrentDocumentId=document.documentId||null;state.ragCurrentDocumentVersion=Number(document.documentVersion)||1;state.ragUploadStage=String(document.status||'PROCESSING').toUpperCase();state.xiaozhiOptions=null;toast('草稿已加入知识库，正在解析处理');renderRagKnowledge()}catch(error){toast(error.message||'加入知识库失败',true);renderRagKnowledge()}});
  document.querySelectorAll('.material-draft-delete').forEach(button=>button.onclick=async()=>{const draft=drafts.find(item=>Number(item.id)===Number(button.dataset.draftId));if(!draft)return;const confirmed=await confirmDelete({title:'删除这份 AI 知识草稿？',message:draft.title||'视频知识内容',details:['只删除尚未加入知识库的本地草稿。','不会删除原视频和发布文案。'],confirmLabel:'删除草稿'});if(!confirmed)return;button.disabled=true;try{await api(`/api/material-knowledge-drafts/${draft.id}`,{method:'DELETE',body:'{}'});toast('知识草稿已删除');renderRagKnowledge()}catch(error){toast(error.message||'删除知识草稿失败',true);button.disabled=false}});
  document.querySelectorAll('.rag-document-refresh').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const data=await api(`/api/rag/documents/${encodeURIComponent(button.dataset.documentId)}?version=${encodeURIComponent(button.dataset.version)}`);if(data.document){const item=allDocuments.find(entry=>sameRagDocument(entry,data.document));if(item)Object.assign(item,data.document);selectRagProgressDocument(data.document,releases,activeMembers)}toast(`当前状态：${ragDocumentLifecycle(data.document,releases,activeMembers).detail}`);renderRagKnowledge()}catch(error){toast(error.message,true);button.disabled=false}});
  document.querySelectorAll('.rag-document-content').forEach(button=>button.onclick=async()=>{button.disabled=true;try{const item=allDocuments.find(entry=>String(entry.documentId)===String(button.dataset.documentId)&&Number(entry.documentVersion||1)===Number(button.dataset.version||1));if(item){selectRagProgressDocument(item,releases,activeMembers);await showRagDocumentContent(item)}}finally{button.disabled=false}});
  document.querySelectorAll('.rag-document-delete').forEach(button=>button.onclick=async()=>{const item=allDocuments.find(entry=>String(entry.documentId)===String(button.dataset.documentId)&&Number(entry.documentVersion||1)===Number(button.dataset.version||1));if(!item)return;const confirmed=await confirmDelete({title:'删除这份知识文件？',message:unifiedRagDocumentLabel(item.filename||item.title||'知识文档',item),details:['将同时删除该文件生成的解析内容和知识片段。','已经进入正式发布版本的文档不能直接删除。'],confirmLabel:'删除文件'});if(!confirmed)return;button.disabled=true;try{await api(`/api/rag/documents/${encodeURIComponent(item.documentId)}`,{method:'DELETE',body:'{}'});ragDocumentStatusCache.delete(`${item.documentId}:${Number(item.documentVersion)||1}`);if(String(state.ragCurrentDocumentId)===String(item.documentId)){state.ragCurrentDocumentId=null;state.ragCurrentDocumentVersion=null;state.ragUploadStage='IDLE'}if(String(state.xiaozhiSettings.selectedDocumentId)===String(item.documentId)){state.xiaozhiSettings={...state.xiaozhiSettings,selectedDocumentId:null,selectedDocumentVersion:null}}state.xiaozhiOptions=null;toast('知识文件已删除');renderRagKnowledge()}catch(error){toast(error.message||'删除文件失败',true);button.disabled=false}});
  document.querySelectorAll('.rag-document-test').forEach(button=>button.onclick=()=>{const item=documents.find(entry=>sameRagDocument(entry,{documentId:button.dataset.documentId,documentVersion:button.dataset.version}));selectRagProgressDocument(item,releases,activeMembers);state.xiaozhiSettings={...state.xiaozhiSettings,scope:'pre_release',selectedDocumentId:button.dataset.documentId,selectedDocumentVersion:Number(button.dataset.version)||1};state.xiaozhiOptions=null;state.xiaozhiSession=null;state.xiaozhiChat=[];navigate('xiaozhi')});
  document.querySelectorAll('.rag-release-details').forEach(button=>button.onclick=async()=>{const item=releases.find(entry=>String(entry.releaseId||entry.release_id)===String(button.dataset.releaseId));if(!item)return;button.disabled=true;try{await showRagReleaseDetails(item,activeId)}catch(error){toast(error.message||'读取发布版本详情失败',true)}finally{button.disabled=false}});
  document.querySelectorAll('.rag-release-rollback').forEach(button=>button.onclick=async()=>{if(!window.confirm(`确认回滚到版本 ${button.dataset.releaseId}？`))return;button.disabled=true;try{await api(`/api/rag/releases/${encodeURIComponent(button.dataset.releaseId)}/rollback`,{method:'POST',body:JSON.stringify({note:'运营人员从 Web 管理端执行回滚'})});state.xiaozhiOptions=null;toast('回滚请求已提交');renderRagKnowledge()}catch(error){toast(error.message,true);button.disabled=false}});
  $('#ragReleaseRefresh').onclick=()=>renderRagKnowledge();
  scheduleRagKnowledgePoll(allDocuments,releases);
}

async function renderKnowledge(){
  if(state.knowledgeView==='handoff')return renderManualHandoffPhrases();
  if(state.knowledgeView!=='rag')state.knowledgeView='rag';
  return renderRagKnowledge();
}
async function renderLegacyKnowledge(){
  const selectedCategory=state.knowledgeCategory;
  const selectedSubcategory=state.knowledgeSubcategory;
  const requests=[api('/api/knowledge/categories'),api('/api/knowledge/imports')];
  if(selectedCategory){
    let endpoint=selectedCategory==='__ALL__'?'/api/knowledge':`/api/knowledge?category=${encodeURIComponent(selectedCategory)}`;
    if(selectedCategory!=='__ALL__'&&selectedSubcategory&&selectedSubcategory!=='__ALL__')endpoint+=`&subcategory=${encodeURIComponent(selectedSubcategory)}`;
    requests.push(api(endpoint),api('/api/knowledge-aliases?limit=1000'),api('/api/knowledge-alias-generation-tasks?limit=500'));
  }
  const [categoryData,importsData,knowledgeData={knowledge:[]},aliasData={aliases:[]},aliasTaskData={tasks:[]}]=await Promise.all(requests);
  state.knowledgeCategoryData=categoryData;
  const categories=categoryData.categories||[];
  const items=knowledgeData.knowledge||[];
  const aliasesByKnowledge=new Map();for(const alias of aliasData.aliases||[]){const key=Number(alias.knowledge_id);if(!aliasesByKnowledge.has(key))aliasesByKnowledge.set(key,[]);aliasesByKnowledge.get(key).push(alias)}
  const latestAliasTaskByKnowledge=new Map();for(const task of aliasTaskData.tasks||[]){const key=Number(task.knowledge_id);if(!latestAliasTaskByKnowledge.has(key))latestAliasTaskByKnowledge.set(key,task)}
  const imports=importsData.imports||[];
  const defaultSubcategory=categoryData.defaultSubcategory||'未分类';
  const selectedCategoryInfo=categories.find(item=>item.name===selectedCategory);
  const availableCategories=categoryData.systemCategories||[];
  const publicCategory=availableCategories[0]||'公共知识库';
  const categoryOptions=availableCategories.map(name=>`<option value="${esc(name)}" ${name===publicCategory?'selected':''}>${esc(name)}</option>`).join('');
  const subcategoryMap=Object.fromEntries(categories.map(item=>[item.name,item.recentSubcategories||[]]));
  const totalPublished=categories.reduce((sum,item)=>sum+item.published,0);
  const totalDraft=categories.reduce((sum,item)=>sum+item.draft,0);
  const totalDisabled=categories.reduce((sum,item)=>sum+item.disabled,0);
  const knowledgeCards=items.length?items.map(k=>{const knowledgeAliases=aliasesByKnowledge.get(Number(k.id))||[];const enabledAliasCount=knowledgeAliases.filter(alias=>alias.status==='ENABLED').length;const aliasTask=latestAliasTaskByKnowledge.get(Number(k.id));const aliasState=['QUEUED','RUNNING'].includes(aliasTask?.status)?'生成中':aliasTask?.status==='FAILED'?'生成失败':knowledgeAliases.length?'已生成':'未生成';return `<div class="knowledge-card"><div class="meta"><span>知识 #${k.id} ${badge(k.status)} ${badge(k.review_status)} <span class="category-pill">${esc(k.category||publicCategory)}</span><span class="subcategory-pill">${esc(k.subcategory||defaultSubcategory)}</span></span><span>v${k.version}</span></div><div class="knowledge-question-row"><p><b>${esc(k.question)}</b></p><button class="knowledge-alias-manage ${aliasTask?.status==='FAILED'?'has-error':''}" type="button" data-id="${k.id}"><span>相似问法 ${enabledAliasCount}/${knowledgeAliases.length}</span><small>${aliasState}</small></button></div><p class="answer-text">${esc(k.answer)}</p><div class="muted">关键词：${esc(k.keywords||'—')} · 来源：${esc(k.source||'—')}${k.source_file?` · 文件：${esc(k.source_file)}`:''} · 审核人：${esc(k.reviewed_by||'—')}</div>${k.clean_notes?`<div class="clean-note">清洗记录：${esc(k.clean_notes)}</div>`:''}${k.match_status==='SIMILAR_REVIEW'&&k.matched_knowledge_id?`<div class="notice warn">与知识 #${k.matched_knowledge_id} 相似，发布前请核对是否需要合并。</div>`:''}<div class="section-actions"><button class="btn secondary edit-knowledge" type="button" data-id="${k.id}">编辑</button>${k.status==='DRAFT'?`<button class="btn publish-knowledge" data-id="${k.id}">审核发布</button>`:''}${k.status==='PUBLISHED'?`<button class="btn secondary disable-knowledge" data-id="${k.id}">停用</button>`:''}<button class="btn danger delete-knowledge" type="button" data-id="${k.id}" data-question="${esc(k.question)}">删除</button></div></div>`}).join(''):'<div class="empty">当前层级下暂无知识。</div>';
  let categoryBrowser='';
  if(!selectedCategory){
    categoryBrowser=`<div class="panel knowledge-list-panel knowledge-category-overview"><div class="panel-head"><div><h2>知识大类</h2><p>历史分类仅用于运营整理和来源追踪；所有分类内容共享同一检索范围，不按平台隔离。六个大类固定不可新增或删除。</p></div><span class="muted">共 ${categoryData.total||0} 条</span></div><div class="knowledge-category-grid"><div class="knowledge-category-tile all-category-tile"><button class="knowledge-category-card all-category" type="button" data-category="__ALL__"><span class="category-card-icon">全</span><span class="category-card-main"><b>全部知识</b><small>已发布 ${totalPublished} · 草稿 ${totalDraft} · 停用 ${totalDisabled}</small></span><strong>${categoryData.total||0}</strong></button></div>${categories.map(item=>`<div class="knowledge-category-tile"><button class="knowledge-category-card" type="button" data-category="${esc(item.name)}"><span class="category-card-icon">${esc(item.name).slice(0,1)}</span><span class="category-card-main"><b>${esc(item.name)}</b><small>${(item.subcategories||[]).length} 个小类 · 已发布 ${item.published} · 草稿 ${item.draft}</small></span><strong>${item.total}</strong></button></div>`).join('')}</div>${categories.length?'':'<div class="empty">暂无知识分类，请先新增或导入知识。</div>'}</div>`;
  }else if(selectedCategory==='__ALL__'){
    categoryBrowser=`<div class="panel knowledge-list-panel"><div class="panel-head"><div><button class="ghost knowledge-back" type="button">← 返回大类列表</button><h2>全部知识</h2><p>当前知识库的全部内容。只有已审核发布的 PUBLISHED 知识可被千问检索使用。</p></div><span class="muted">共 ${items.length} 条</span></div><div class="card-list">${knowledgeCards}</div></div>`;
  }else if(!selectedSubcategory){
    const subcategories=selectedCategoryInfo?.subcategories||[];
    categoryBrowser=`<div class="panel knowledge-list-panel"><div class="panel-head"><div><button class="ghost knowledge-back" type="button">← 返回大类列表</button><h2>${esc(selectedCategory)} · 小类</h2><p>选择小类后查看对应知识；该知识大类为系统固定范围，不可删除。</p></div><span class="muted">共 ${selectedCategoryInfo?.total||0} 条</span></div><div class="knowledge-category-grid subcategory-grid">${subcategories.map(item=>`<div class="knowledge-category-tile"><button class="knowledge-subcategory-card knowledge-category-card" type="button" data-subcategory="${esc(item.name)}"><span class="category-card-icon">${esc(item.name).slice(0,1)}</span><span class="category-card-main"><b>${esc(item.name)}</b><small>已发布 ${item.published} · 草稿 ${item.draft} · 停用 ${item.disabled}</small></span><strong>${item.total}</strong></button><button class="category-delete-button delete-subcategory" type="button" data-category="${esc(selectedCategory)}" data-subcategory="${esc(item.name)}" data-count="${item.total}" aria-label="删除小类 ${esc(item.name)}" title="删除该小类">删除</button></div>`).join('')}</div>${subcategories.length?'':'<div class="empty">该大类下暂无小类。</div>'}</div>`;
  }else{
    const displaySubcategory=selectedSubcategory==='__ALL__'?'全部小类':selectedSubcategory;
    categoryBrowser=`<div class="panel knowledge-list-panel"><div class="panel-head"><div><button class="ghost knowledge-back-subcategory" type="button">← 返回“${esc(selectedCategory)}”小类列表</button><h2>${esc(selectedCategory)} / ${esc(displaySubcategory)}</h2><p>${selectedSubcategory==='__ALL__'?'当前显示该大类下全部知识。':'当前只显示该小类下的知识内容。'}只有已审核发布的 PUBLISHED 知识可被千问检索使用。</p></div><div class="panel-danger-actions"><span class="muted">共 ${items.length} 条</span>${selectedSubcategory==='__ALL__'?'':`<button class="btn danger delete-subcategory" type="button" data-category="${esc(selectedCategory)}" data-subcategory="${esc(selectedSubcategory)}" data-count="${items.length}">删除该小类</button>`}</div></div><div class="card-list">${knowledgeCards}</div></div>`;
  }
  $('#content').innerHTML=`${renderKnowledgeTabs()}<div class="knowledge-import-workspace">
    <div class="panel knowledge-import-panel">
      <div class="panel-head knowledge-import-head"><div><h2>文档批量导入</h2><p>上传文档后自动完成清洗、匹配去重和固定大类归档。</p></div>${badge('FILE_IMPORT')}</div>
      ${renderKnowledgeImportFlow()}
      <div class="knowledge-template-tip"><span class="knowledge-template-tip-icon">i</span><span><b>推荐使用 CSV 模板</b><small>大类仅可选择固定六类；小类可自定义并显示各大类最近 10 条。</small></span><a href="/api/knowledge/import/template">下载模板</a></div>
      <form id="knowledgeImportForm" class="knowledge-upload-form"><input id="knowledgeImportFile" class="knowledge-file-input" type="file" accept=".csv,.tsv,.txt,.md,.docx,.xlsx" required><label id="knowledgeUploadZone" class="knowledge-file-picker" for="knowledgeImportFile"><span class="knowledge-upload-icon">⇧</span><span class="knowledge-upload-copy"><b id="knowledgeImportFileName">点击选择或拖拽知识文档</b><small>CSV、TSV、TXT、MD、DOCX、XLSX · 最大 8MB</small></span><span class="knowledge-choose-file">选择文件</span></label><button class="btn knowledge-upload-submit" type="submit">上传并智能预处理</button></form>
      ${imports.length?`<details class="knowledge-import-history"><summary>最近导入记录 <span>${imports.length} 个批次</span></summary><div class="card-list compact">${imports.slice(0,5).map(item=>`<div class="mini-record"><span>${badge(item.status)} ${esc(item.file_name)}</span><small>${fmt(item.created_at)} · 识别${item.total_rows}条 · 导入${item.imported_rows||0}条</small></div>`).join('')}</div></details>`:''}
      <details id="knowledgeCreateDetails" class="knowledge-create-accordion" ${state.knowledgeCreateExpanded?'open':''}><summary><span class="knowledge-create-plus">＋</span><span><b>单条新增知识</b><small>临时补充一条问答时使用，点击展开填写</small></span><span class="details-chevron">⌄</span></summary><div class="knowledge-create-body"><form id="knowledgeForm" class="knowledge-create-form"><label class="full"><span>标准问题</span><input name="question" maxlength="500" required placeholder="请输入用户可能提出的问题"></label><label class="full"><span>标准答案</span><textarea name="answer" rows="3" maxlength="5000" required placeholder="请输入统一回复内容"></textarea></label><label><span>关键词</span><input name="keywords" placeholder="多个关键词用逗号分隔"></label><label><span>知识大类</span><select id="knowledgeCategorySelect" name="category">${categoryOptions}</select></label><label><span>知识小类</span><select id="knowledgeSubcategorySelect" name="subcategory"></select></label><label id="customSubcategoryField" class="custom-category-field full" hidden><span>自定义小类名称</span><input id="customKnowledgeSubcategory" name="customSubcategory" maxlength="30" placeholder="例如：报名方式"><small>小类只归属于当前所选大类；候选最多显示该大类最近使用的 10 条。</small></label><div class="knowledge-create-actions full"><button class="btn" type="submit">保存草稿</button><button class="btn secondary" id="collapseKnowledgeCreate" type="button">收起</button></div></form></div></details>
    </div>
    <div class="panel knowledge-preview-panel"><div class="panel-head"><div><h2>预处理数据审核</h2><p>逐条展开查看，可勾选、修改，并将人工确认后的内容一键加入知识库。</p></div><div class="knowledge-review-actions"><button class="ghost knowledge-clear-preview" id="clearKnowledgeImportPreview" type="button" ${state.knowledgeImportPreview?'':'disabled'}>清空</button><span class="knowledge-review-tag">人工审核</span></div></div><div id="knowledgeImportPreview"></div></div>
  </div>${categoryBrowser}`;
  const categorySelect=$('#knowledgeCategorySelect');
  const subcategorySelect=$('#knowledgeSubcategorySelect');const customSubcategoryField=$('#customSubcategoryField');const customSubcategoryInput=$('#customKnowledgeSubcategory');
  const toggleCustomSubcategory=()=>{const custom=subcategorySelect.value==='__CUSTOM__';customSubcategoryField.hidden=!custom;customSubcategoryInput.required=custom;if(custom)setTimeout(()=>customSubcategoryInput.focus(),0)};
  const fillSubcategories=()=>{const values=[...new Set([defaultSubcategory,...(subcategoryMap[categorySelect.value]||[])])];subcategorySelect.innerHTML=values.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join('')+'<option value="__CUSTOM__">＋ 自定义小类</option>';toggleCustomSubcategory()};
  categorySelect.onchange=fillSubcategories;subcategorySelect.onchange=toggleCustomSubcategory;fillSubcategories();
  const knowledgeCreateDetails=$('#knowledgeCreateDetails');
  knowledgeCreateDetails.ontoggle=()=>{state.knowledgeCreateExpanded=knowledgeCreateDetails.open};
  $('#collapseKnowledgeCreate').onclick=()=>{knowledgeCreateDetails.open=false;state.knowledgeCreateExpanded=false};
  $('#knowledgeForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.target));if(values.subcategory==='__CUSTOM__'&&!String(values.customSubcategory||'').trim())return toast('请填写自定义小类名称',true);const button=event.target.querySelector('button[type="submit"]');button.disabled=true;button.textContent='正在保存…';try{const created=await api('/api/knowledge',{method:'POST',body:JSON.stringify(values)});state.knowledgeCategory=created.knowledge.category;state.knowledgeSubcategory=created.knowledge.subcategory;state.knowledgeCreateExpanded=false;toast(`知识草稿已保存到“${created.knowledge.category} / ${created.knowledge.subcategory}”`);renderKnowledge()}catch(error){toast(error.message,true);button.disabled=false;button.textContent='保存草稿'}};
  const importInput=$('#knowledgeImportFile');
  const uploadZone=$('#knowledgeUploadZone');
  const updateImportFileName=file=>{const name=$('#knowledgeImportFileName');if(name)name.textContent=file?file.name:'点击选择或拖拽知识文档';uploadZone.classList.toggle('has-file',Boolean(file))};
  const clearImportPreview=$('#clearKnowledgeImportPreview');
  if(clearImportPreview)clearImportPreview.onclick=async()=>{if(!state.knowledgeImportPreview)return;const confirmed=await confirmDelete({title:'清空当前预处理数据？',message:'当前勾选和人工修改将被清除。',details:['已生成的导入批次记录不会删除。','如需继续审核，请重新上传文件。'],confirmLabel:'确认清空'});if(!confirmed)return;state.knowledgeImportPreview=null;state.knowledgeImportSelected=[];state.knowledgeImportExpanded=[];state.knowledgeImportDirty=[];state.knowledgeImportFilter='ALL';importInput.value='';updateImportFileName(null);setKnowledgeImportStage('IDLE');renderKnowledgeImportPreview(null);clearImportPreview.disabled=true;toast('已清空当前预处理数据')};
  importInput.onchange=()=>{const file=importInput.files?.[0];updateImportFileName(file);setKnowledgeImportStage(file?'READY':'IDLE')};
  ['dragenter','dragover'].forEach(type=>uploadZone.addEventListener(type,event=>{event.preventDefault();uploadZone.classList.add('is-dragging')}));
  ['dragleave','drop'].forEach(type=>uploadZone.addEventListener(type,event=>{event.preventDefault();uploadZone.classList.remove('is-dragging')}));
  uploadZone.addEventListener('drop',event=>{const file=event.dataTransfer?.files?.[0];if(!file)return;const transfer=new DataTransfer();transfer.items.add(file);importInput.files=transfer.files;updateImportFileName(file);setKnowledgeImportStage('READY')});
  $('#knowledgeImportForm').onsubmit=async event=>{event.preventDefault();const file=importInput.files?.[0];if(!file)return toast('请选择知识文档',true);if(file.size>8*1024*1024)return toast('文件不能超过8MB',true);const button=event.target.querySelector('button[type=submit]');button.disabled=true;button.textContent='正在上传文件…';let failedStep='upload';setKnowledgeImportStage('UPLOADING');try{const base64=await fileToBase64(file);failedStep='clean';button.textContent='正在清洗和去重…';setKnowledgeImportStage('PROCESSING');const preview=await api('/api/knowledge/import/preview',{method:'POST',body:JSON.stringify({fileName:file.name,base64})});state.knowledgeImportPreview=preview;state.knowledgeImportSelected=(preview.items||[]).filter(item=>item.importable).map(item=>Number(item.rowNo));state.knowledgeImportExpanded=[];state.knowledgeImportDirty=[];state.knowledgeImportFilter='ALL';setKnowledgeImportStage(knowledgeImportStageForPreview(preview));renderKnowledgeImportPreview(preview);if(['QUEUED','RUNNING'].includes(preview.enrichment?.status))scheduleKnowledgeImportEnrichmentPoll(preview.batchId);toast(`已识别 ${preview.summary.total} 条知识${['QUEUED','RUNNING'].includes(preview.enrichment?.status)?'，千问正在补充缺失的关键词和分类':'，请逐条审核确认'}`)}catch(error){setKnowledgeImportStage('FAILED',{failedStep});toast(error.message,true)}finally{button.disabled=false;button.textContent='上传并智能预处理'}};
  document.querySelectorAll('.knowledge-category-card:not(.knowledge-subcategory-card)').forEach(button=>button.onclick=()=>{state.knowledgeCategory=button.dataset.category;state.knowledgeSubcategory=null;renderKnowledge().then(()=>window.scrollTo({top:document.querySelector('.knowledge-list-panel')?.offsetTop||0,behavior:'smooth'})).catch(error=>toast(error.message,true))});
  document.querySelectorAll('.knowledge-subcategory-card').forEach(button=>button.onclick=()=>{state.knowledgeSubcategory=button.dataset.subcategory;renderKnowledge().then(()=>window.scrollTo({top:document.querySelector('.knowledge-list-panel')?.offsetTop||0,behavior:'smooth'})).catch(error=>toast(error.message,true))});
  document.querySelectorAll('.knowledge-back').forEach(button=>button.onclick=()=>{state.knowledgeCategory=null;state.knowledgeSubcategory=null;renderKnowledge()});
  document.querySelectorAll('.knowledge-back-subcategory').forEach(button=>button.onclick=()=>{state.knowledgeSubcategory=null;renderKnowledge()});
  document.querySelectorAll('.knowledge-alias-manage').forEach(button=>button.onclick=async()=>{
    const item=items.find(entry=>entry.id===Number(button.dataset.id));if(!item)return;
    try{const result=await knowledgeAliasSelectionDialog(item);if(!result)return;if(result.enabledIds){const saved=await api(`/api/knowledge/${item.id}/aliases/selections`,{method:'POST',body:JSON.stringify({enabledIds:result.enabledIds})});toast(`已启用 ${saved.selection.enabled} 条相似问法${saved.selection.skippedConflicts?`，${saved.selection.skippedConflicts} 条冲突问法未启用`:''}`)}renderKnowledge()}catch(error){toast(error.message,true)}
  });
  document.querySelectorAll('.edit-knowledge').forEach(button=>button.onclick=async()=>{
    const item=items.find(entry=>entry.id===Number(button.dataset.id));if(!item)return toast('知识记录不存在，请刷新后重试',true);
    const values=await editKnowledgeDialog(item,{availableCategories,subcategoryMap,defaultSubcategory});if(!values)return;
    try{const result=await api(`/api/knowledge/${item.id}`,{method:'PUT',body:JSON.stringify({...values,editedBy:'业务人员编辑'})});if(selectedCategory!=='__ALL__'){state.knowledgeCategory=result.knowledge.category;state.knowledgeSubcategory=result.knowledge.subcategory}toast(`知识 #${item.id} 已更新为 v${result.knowledge.version}`);renderKnowledge()}catch(error){toast(error.message,true)}
  });  document.querySelectorAll('.publish-knowledge').forEach(button=>button.onclick=async()=>{await api(`/api/knowledge/${button.dataset.id}/publish`,{method:'POST',body:JSON.stringify({reviewedBy:'技术部审核'})});toast('知识已发布');renderKnowledge()});
  document.querySelectorAll('.disable-knowledge').forEach(button=>button.onclick=async()=>{await api(`/api/knowledge/${button.dataset.id}/disable`,{method:'POST',body:'{}'});toast('知识已停用');renderKnowledge()});
  document.querySelectorAll('.delete-knowledge').forEach(button=>button.onclick=async()=>{const confirmed=await confirmDelete({title:'删除这条知识？',message:`问题：${button.dataset.question}`,details:['删除后无法恢复。'],confirmLabel:'删除知识'});if(!confirmed)return;try{await api(`/api/knowledge/${button.dataset.id}`,{method:'DELETE',body:'{}'});toast('该条知识已删除');renderKnowledge()}catch(error){toast(error.message,true)}});
  document.querySelectorAll('.delete-subcategory').forEach(button=>button.onclick=async()=>{const category=button.dataset.category;const subcategory=button.dataset.subcategory;const count=Number(button.dataset.count||0);const confirmed=await confirmDelete({title:`删除小类“${subcategory}”？`,message:`将删除“${category}”大类下的这个小类。`,details:[`共 ${count} 条知识会被永久删除。`,'此操作不可恢复。'],requiredText:'删除',inputLabel:'请输入“删除”确认',confirmLabel:'删除小类'});if(!confirmed)return;try{const result=await api(`/api/knowledge/subcategories?category=${encodeURIComponent(category)}&subcategory=${encodeURIComponent(subcategory)}`,{method:'DELETE',body:JSON.stringify({confirmText:'删除'})});state.knowledgeSubcategory=null;toast(`已删除小类及 ${result.deleted} 条知识`);renderKnowledge()}catch(error){toast(error.message,true)}});
  bindKnowledgeTabs();
  renderKnowledgeImportPreview(state.knowledgeImportPreview);
}

function browserJson(value,fallback={}){if(value&&typeof value==='object')return value;try{return JSON.parse(value||'')||fallback}catch{return fallback}}
function browserActionName(action){return ({HEALTH_CHECK:'连接自检',OPEN_PAGE:'打开页面',NAVIGATE:'页面导航',READ_PAGE_STATE:'读取页面状态',READ_TEXT:'读取文字',SCROLL:'滚动页面',SCREENSHOT:'保存截图',CLOSE_TAB:'关闭受管标签页',CLICK:'辅助点击',CLICK_AT:'坐标点击',SET_FILES:'准备本地文件'}[action]||action||'—')}
function browserProviderName(provider){return ({web_access_cdp:'Web Access CDP',playwright:'Playwright'}[provider]||provider||'—')}
async function renderKnowledgeAliases(){
  const [aliasData,taskData,knowledgeData]=await Promise.all([api('/api/knowledge-aliases?limit=1000'),api('/api/knowledge-alias-generation-tasks?limit=500'),api('/api/knowledge')]);
  const aliases=aliasData.aliases||[];const tasks=taskData.tasks||[];const allKnowledge=knowledgeData.knowledge||[];
  const enabled=aliases.filter(item=>item.status==='ENABLED').length;const conflicts=aliases.filter(item=>item.validation_status==='CONFLICT').length;const running=tasks.filter(item=>['QUEUED','RUNNING'].includes(item.status)).length;
  const aliasesByKnowledge=new Map();for(const alias of aliases){const key=Number(alias.knowledge_id);if(!aliasesByKnowledge.has(key))aliasesByKnowledge.set(key,[]);aliasesByKnowledge.get(key).push(alias)}
  const latestTaskByKnowledge=new Map();for(const task of tasks){const key=Number(task.knowledge_id);if(!latestTaskByKnowledge.has(key))latestTaskByKnowledge.set(key,task)}
  const knowledgeItems=allKnowledge.filter(item=>['DRAFT','PUBLISHED'].includes(item.status)||aliasesByKnowledge.has(Number(item.id))||latestTaskByKnowledge.has(Number(item.id))).sort((a,b)=>{const timeDiff=(new Date(b.created_at).getTime()||0)-(new Date(a.created_at).getTime()||0);return timeDiff||Number(b.id)-Number(a.id)});
  const pad=value=>String(value).padStart(2,'0');
  const dateInfo=value=>{const date=new Date(value);if(Number.isNaN(date.getTime()))return {key:'UNKNOWN',label:'日期未知',sort:0};return {key:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`,label:`${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日`,sort:new Date(date.getFullYear(),date.getMonth(),date.getDate()).getTime()}};
  const sourceLabel=item=>item.source_file?`上传文件：${item.source_file}`:item.source==='FILE_IMPORT'?'批量导入':item.source==='MANUAL'?'单条新增':item.source==='SYSTEM_TEST'?'系统初始化/测试':item.source||'来源未记录';
  const dateGroups=new Map();for(const item of knowledgeItems){const info=dateInfo(item.created_at);if(!dateGroups.has(info.key))dateGroups.set(info.key,{...info,items:[]});dateGroups.get(info.key).items.push(item)}
  const sortedDateGroups=[...dateGroups.values()].sort((a,b)=>b.sort-a.sort);
  const renderAliasDetail=alias=>`<div class="alias-detail-row ${alias.validation_status==='CONFLICT'?'has-conflict':''}"><div class="alias-detail-copy"><b>${esc(alias.alias_text)}</b><small>${alias.validation_status==='CONFLICT'?`跨知识冲突${alias.conflict?.question?` · 可能冲突：${esc(alias.conflict.question)}`:''}`:`来源 ${esc(alias.source||'AI')} · 置信度 ${Math.round(Number(alias.confidence||0)*100)}%`}</small></div><div class="alias-detail-actions">${badge(alias.status)}<button class="btn secondary alias-toggle" type="button" data-id="${alias.id}" data-action="${alias.status==='ENABLED'?'disable':'enable'}" ${alias.validation_status==='CONFLICT'?'disabled':''}>${alias.status==='ENABLED'?'停用':'启用'}</button><button class="btn danger alias-delete" type="button" data-id="${alias.id}">删除</button></div></div>`;
  const renderKnowledgeRow=item=>{const itemAliases=aliasesByKnowledge.get(Number(item.id))||[];const itemEnabled=itemAliases.filter(alias=>alias.status==='ENABLED').length;const itemConflicts=itemAliases.filter(alias=>alias.validation_status==='CONFLICT').length;const task=latestTaskByKnowledge.get(Number(item.id));const taskState=['QUEUED','RUNNING'].includes(task?.status)?'生成中':task?.status==='FAILED'?'生成失败':itemAliases.length?'已生成':'未生成';return `<article class="alias-knowledge-card"><div class="alias-knowledge-row"><button class="alias-knowledge-main alias-manage" type="button" data-id="${item.id}"><span class="alias-knowledge-title"><b>${esc(item.question)}</b><small>知识 #${item.id} · ${esc(item.subcategory||'未分类')} · ${esc(sourceLabel(item))} · ${fmt(item.created_at)}</small></span><span class="alias-knowledge-count"><strong>${itemEnabled}/${itemAliases.length}</strong><small>已启用 / 总问法</small></span></button><div class="alias-knowledge-actions"><span class="alias-generation-state ${task?.status==='FAILED'?'is-error':['QUEUED','RUNNING'].includes(task?.status)?'is-running':''}">${esc(taskState)}${itemConflicts?` · ${itemConflicts} 条冲突`:''}</span><button class="btn secondary alias-manage" type="button" data-id="${item.id}">管理相似问法</button><button class="btn secondary alias-regenerate" type="button" data-id="${item.id}">重新生成</button></div></div>${itemAliases.length?`<details class="alias-detail-list"><summary>展开查看 ${itemAliases.length} 条问法明细</summary><div class="alias-detail-body">${itemAliases.map(renderAliasDetail).join('')}</div></details>`:`<div class="alias-no-detail">当前还没有相似问法，可点击“重新生成”。</div>`}</article>`};
  const categoryOrder=['公共知识库','抖音知识库','视频号知识库','小红书知识库','微博知识库','B站知识库'];const categoryRank=new Map(categoryOrder.map((name,index)=>[name,index]));
  const archives=sortedDateGroups.map((group,dateIndex)=>{const categoryGroups=new Map();for(const item of group.items){const category=item.category||'公共知识库';if(!categoryGroups.has(category))categoryGroups.set(category,[]);categoryGroups.get(category).push(item)}const groupAliases=group.items.reduce((sum,item)=>sum+(aliasesByKnowledge.get(Number(item.id))||[]).length,0);const files=[...new Set(group.items.map(item=>item.source_file).filter(Boolean))];const categories=[...categoryGroups.entries()].sort(([a],[b])=>(categoryRank.get(a)??999)-(categoryRank.get(b)??999)||a.localeCompare(b,'zh-CN')).map(([category,items],categoryIndex)=>{const categoryAliases=items.reduce((sum,item)=>sum+(aliasesByKnowledge.get(Number(item.id))||[]).length,0);const categoryFiles=[...new Set(items.map(item=>item.source_file).filter(Boolean))];return `<details class="alias-category-group" ${dateIndex===0&&categoryIndex===0?'open':''}><summary class="alias-category-summary"><span><b>${esc(category)}</b><small>${items.length} 条知识${categoryFiles.length?` · 上传 ${categoryFiles.length} 个文件`:''}</small></span><em>${categoryAliases} 条相似问法</em></summary><div class="alias-category-body">${items.map(renderKnowledgeRow).join('')}</div></details>`}).join('');return `<details class="alias-date-group" ${dateIndex===0?'open':''}><summary class="alias-date-summary"><span class="alias-date-mark">${group.key==='UNKNOWN'?'—':group.key.slice(8)}</span><span class="alias-date-copy"><b>${esc(group.label)}</b><small>${files.length?`上传文件：${files.map(esc).join('、')}`:'包含单条新增或系统初始化内容'}</small></span><span class="alias-date-count"><strong>${group.items.length}</strong><small>条知识 · ${groupAliases} 条问法</small></span></summary><div class="alias-date-body">${categories}</div></details>`}).join('');
  const taskRows=tasks.slice(0,30).map(item=>`<div class="mini-record"><span>${badge(item.status)} <b>知识 #${item.knowledge_id}</b> ${esc(item.knowledge_question||'原知识已删除')}</span><small>生成 ${item.generated_count||0} 条 · ${fmt(item.updated_at)}${item.error_message?` · ${esc(item.error_message)}`:''}</small></div>`).join('');
  $('#content').innerHTML=`<section class="settings-page-head"><div><span class="panel-kicker">SEMANTIC ALIAS LIBRARY</span><h2>相似问法库</h2><p>先按知识新增或上传日期归档，再按知识大类划分；默认只展开最新日期，不再把全部相似问法平铺出来。</p></div><div class="button-row"><button class="btn secondary" id="aliasRefresh">刷新</button><button class="btn" id="aliasGenerateAll">全部生成</button></div></section><div class="metric-grid alias-metric-grid"><div class="metric"><span>问法总数</span><strong>${aliases.length}</strong></div><div class="metric"><span>已启用</span><strong>${enabled}</strong></div><div class="metric"><span>冲突停用</span><strong>${conflicts}</strong></div><div class="metric"><span>生成中</span><strong>${running}</strong></div></div><section class="panel alias-archive-panel"><div class="panel-head"><div><h2>按新增日期归档</h2><p>点击日期展开当日内容，再按大类查看；点击知识问题或“管理相似问法”进行勾选。</p></div><span class="muted">${knowledgeItems.length} 条知识</span></div><div class="alias-archive">${archives||'<div class="empty">暂无可管理的知识或相似问法。</div>'}</div></section><details class="panel alias-task-history"><summary><span><b>最近生成任务</b><small>任务串行执行；知识删除或版本变化后，过期结果会自动丢弃。</small></span><em>${tasks.length} 条记录</em></summary><div class="card-list compact">${taskRows||'<div class="empty">暂无生成任务。</div>'}</div></details>`;
  $('#aliasRefresh').onclick=()=>renderKnowledgeAliases();
  $('#aliasGenerateAll').onclick=async()=>{const button=$('#aliasGenerateAll');button.disabled=true;try{const data=await api('/api/knowledge-aliases/generate-all',{method:'POST',body:'{}'});toast(`已排队 ${data.queued} 个生成任务`);setTimeout(()=>renderKnowledgeAliases(),800)}catch(error){toast(error.message,true);button.disabled=false}};
  document.querySelectorAll('.alias-manage').forEach(button=>button.onclick=async()=>{const item=knowledgeItems.find(entry=>Number(entry.id)===Number(button.dataset.id));if(!item)return;try{const result=await knowledgeAliasSelectionDialog(item);if(result?.enabledIds){await api(`/api/knowledge/${item.id}/aliases/selections`,{method:'POST',body:JSON.stringify({enabledIds:result.enabledIds})});toast('相似问法启用选择已保存');renderKnowledgeAliases()}else if(result?.regenerating)setTimeout(()=>renderKnowledgeAliases(),800)}catch(error){toast(error.message,true)}});
  document.querySelectorAll('.alias-toggle').forEach(button=>button.onclick=async event=>{event.stopPropagation();try{await api(`/api/knowledge-aliases/${button.dataset.id}/${button.dataset.action}`,{method:'POST',body:'{}'});renderKnowledgeAliases()}catch(error){toast(error.message,true)}});
  document.querySelectorAll('.alias-regenerate').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api(`/api/knowledge/${button.dataset.id}/aliases/regenerate`,{method:'POST',body:'{}'});toast('已重新排队生成');setTimeout(()=>renderKnowledgeAliases(),500)}catch(error){toast(error.message,true);button.disabled=false}});
  document.querySelectorAll('.alias-delete').forEach(button=>button.onclick=async()=>{if(!confirm('确认删除这条相似问法？不会删除标准知识。'))return;try{await api(`/api/knowledge-aliases/${button.dataset.id}`,{method:'DELETE'});renderKnowledgeAliases()}catch(error){toast(error.message,true)}});
}
async function renderBrowserControl(){
  const [{browserControl:summary},{commands=[]}]=await Promise.all([api('/api/browser-control/summary'),api('/api/browser-control/commands?limit=100')]);
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
  $('#content').innerHTML=`
    <section class="browser-console-hero ${summary.enabled?'is-enabled':'is-disabled'}">
      <div><span class="hero-kicker"><i></i>WEB ACCESS PRIMARY CONTROL</span><h2>Web Access 浏览器主控中心</h2><p>最新版正式业务统一由 Web Access 管理平台隔离浏览器与 CDP Proxy；发布、回复、登录检查、消息采集等业务仍保留原有审核、发布锁和回显确认，Playwright 只作为 connectOverCDP 兼容执行层及受控故障回退。</p></div>
      <div class="browser-master-state"><span>${summary.enabled?'正式主控已启用':'主控未启用'}</span><b>${esc(browserProviderName(primaryProvider))}</b><small>${esc(mode)} · ${summary.interactiveEnabled?'交互动作受控开放':'诊断命令保持只读'}</small></div>
    </section>
    <section class="browser-summary-grid">
      <article><span>正式业务路由</span><b class="${String(mode).includes('WEB_ACCESS')?'success':'warning'}">${esc(String(mode).includes('WEB_ACCESS')?'Web Access 主控':'未生效')}</b><small>${esc(businessRouting)}</small></article>
      <article><span>主 Provider</span><b>${esc(browserProviderName(primaryProvider))}</b><small>平台浏览器和 CDP Proxy 管理</small></article>
      <article><span>兼容 / 回退</span><b>${esc(fallbackProvider?browserProviderName(fallbackProvider):'关闭')}</b><small>connectOverCDP；非幂等失败不自动重试</small></article>
      <article><span>排队 / 执行</span><b>${summary.queued} / ${summary.running}</b><small>结构化命令队列</small></article>
      <article><span>待人工确认</span><b class="${summary.needsConfirmation?'warning':''}">${summary.needsConfirmation}</b><small>结果不确定时停止并等待人工复核</small></article>
    </section>
    ${summary.enabled?'':`<div class="notice warn browser-disabled-notice"><span class="notice-icon">!</span><div><b>Web Access 主控尚未启用</b><p>请在最新版服务和 Local Agent 同时启用 BROWSER_CONTROL_ENABLED、web_access_primary、平台白名单与风险确认后重启。</p></div></div>`}
    <section class="panel">
      <div class="panel-head"><div><span class="panel-kicker">PLATFORM RUNTIMES</span><h2>五平台隔离运行时</h2><p>每个平台使用独立 Profile、CDP Proxy 和浏览器调试端口；浏览器按需启动，不会在页面加载时一次性拉起五个实例。</p></div><button class="btn secondary" id="browserRefresh" type="button">刷新状态</button></div>
      <div class="browser-device-grid">${runtimeCards}</div>
    </section>
    <div class="grid cols-2 browser-console-grid">
      <section class="panel browser-command-panel">
        <div class="panel-head"><div><span class="panel-kicker">SAFE COMMAND</span><h2>Web Access 诊断命令</h2><p>命令会强制请求 Web Access；即使历史调用指定 Playwright，主控模式也会重定向到 Web Access。</p></div></div>
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
            <div class="browser-command-submit"><small>命令绑定设备、平台和账号并写入审计；非幂等动作失败后禁止自动切换 Provider 重试。</small><button class="btn" type="submit">提交 Web Access 命令</button></div>
          </fieldset>
        </form>
      </section>
      <section class="panel browser-boundary-panel">
        <div class="panel-head"><div><span class="panel-kicker">CONTROL ARCHITECTURE</span><h2>正式控制体系</h2><p>Web Access 已替换原浏览器启动与会话管理主路径，原业务安全机制继续保留。</p></div></div>
        <div class="browser-boundary-list">
          <article class="allow"><b>Web Access 主控</b><p>接管发布、回复、登录检查、消息采集及诊断命令所需的平台浏览器、Profile 和 CDP 会话。</p></article>
          <article><b>Playwright CDP 兼容层</b><p>平台已有定位器与回显验证代码通过 connectOverCDP 连接 Web Access 托管浏览器，不再默认自行启动浏览器。</p></article>
          <article class="guard"><b>受控故障回退</b><p>仅在 Web Access 启动类故障且策略允许时回退；点击、上传、发布等非幂等动作失败后绝不自动换引擎重试。</p></article>
          <article class="deny"><b>安全逻辑不替换</b><p>发布锁、人工审核、结果回显、验证码/密码/Cookie 禁读以及账号风控提示继续生效。</p></article>
        </div>
      </section>
    </div>
    <section class="panel">
      <div class="panel-head"><div><span class="panel-kicker">LOCAL AGENT</span><h2>设备与主控能力</h2><p>以下为 Local Agent 心跳实际上报的控制模式、正式业务路由和 Provider 状态。</p></div></div>
      <div class="browser-device-grid">${deviceCards}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><div><span class="panel-kicker">AUDIT TRAIL</span><h2>浏览器命令与证据</h2><p>显示请求 Provider、实际 Provider、故障回退、Session、证据引用和失败原因。</p></div><span class="browser-command-count">最近 ${commands.length} 条</span></div>
      <div class="table-wrap browser-command-table"><table><thead><tr><th>命令</th><th>平台 / 账号</th><th>动作 / Provider</th><th>Session</th><th>状态</th><th>证据 / 说明</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    </section>`;
  const form=$('#browserCommandForm');
  const actionSelect=form?.elements.action;
  const platformSelect=form?.elements.platformCode;
  const accountSelect=form?.elements.accountId;
  const syncBrowserFields=()=>{if(!form)return;const action=actionSelect.value;$('.browser-url-field').hidden=!['OPEN_PAGE','NAVIGATE'].includes(action);$('.browser-selector-field').hidden=action!=='READ_TEXT';$('.browser-scroll-field').hidden=action!=='SCROLL';form.elements.url.required=['OPEN_PAGE','NAVIGATE'].includes(action)};
  const syncBrowserAccounts=()=>{if(!form)return;const code=platformSelect.value;const options=[...accountSelect.options];let selected=false;for(const option of options){const visible=!option.dataset.platform||option.dataset.platform===code;option.hidden=!visible;option.disabled=!visible;if(visible&&!selected){option.selected=true;selected=true}}};
  if(actionSelect){actionSelect.onchange=syncBrowserFields;syncBrowserFields()}
  if(platformSelect){platformSelect.onchange=syncBrowserAccounts;syncBrowserAccounts()}
  if(form)form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;try{const values=Object.fromEntries(new FormData(form));const params={};if(['OPEN_PAGE','NAVIGATE'].includes(values.action))params.url=values.url;if(values.action==='READ_TEXT'){params.selector=values.selector||'';params.maxChars=8000}if(values.action==='SCROLL'){params.direction=values.direction||'down';params.y=1200}const payload={platformCode:values.platformCode,accountId:Number(values.accountId),provider:'web_access_cdp',action:values.action,purpose:'DIAGNOSTIC',params,idempotencyKey:`web-console-${Date.now()}-${Math.random().toString(16).slice(2)}`};if(values.sessionId?.trim())payload.sessionId=values.sessionId.trim();const created=await api('/api/browser-control/commands',{method:'POST',body:JSON.stringify(payload)});toast(created.reused?'已复用相同 Web Access 命令':'Web Access 命令已进入安全队列');await renderBrowserControl()}catch(error){toast(error.message,true)}finally{button.disabled=false}};
  const refresh=$('#browserRefresh');if(refresh)refresh.onclick=()=>renderBrowserControl().catch(error=>toast(error.message,true));
  document.querySelectorAll('.browser-copy-session').forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(button.dataset.session);toast('Session ID 已复制')}catch{toast('无法复制，请手动选择 Session ID',true)}});
}

async function renderIssues(){
  const items=(await api('/api/issues')).issues||[];
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
  document.querySelectorAll('.manual-resolve-issue').forEach(button=>button.onclick=async()=>{const pageOwner=capturePageOwner();const resolution=prompt('填写人工处理结果','已人工核对并处理，软件恢复正常运行逻辑');if(resolution===null)return;try{await api(`/api/issues/${button.dataset.id}/manual-resolve`,{method:'POST',body:JSON.stringify({resolution,resolvedBy:state.auth?.username||'管理员'})});if(!await refreshBootstrap(pageOwner))return;toast('已标记人工处理并释放本问题阻断');renderIssues()}catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true)}});
  document.querySelectorAll('.false-positive-issue').forEach(button=>button.onclick=async()=>{const pageOwner=capturePageOwner();const resolution=prompt('填写误判说明','已人工核对，确认属于误判');if(resolution===null)return;let actualOutcome='UNKNOWN',platformUrl=null,platformPostId=null;if(button.dataset.type==='PUBLISH_TARGET'&&confirm('平台侧是否已经实际发布成功？\n选择“确定”会锁定投稿，防止重复发布。')){actualOutcome='PUBLISHED';platformUrl=prompt('可选：填写平台内容链接','')||null;platformPostId=prompt('可选：填写平台内容 ID','')||null}else if(button.dataset.type==='MESSAGE'&&confirm('平台侧是否已经实际发送成功？\n选择“确定”会标记人工已处理，防止重复发送。'))actualOutcome='SENT';try{await api(`/api/issues/${button.dataset.id}/false-positive`,{method:'POST',body:JSON.stringify({resolution,resolvedBy:state.auth?.username||'管理员',actualOutcome,platformUrl,platformPostId})});if(!await refreshBootstrap(pageOwner))return;toast('已标记误判并恢复本问题关联运行逻辑');renderIssues()}catch(error){if(ownsPageOwner(pageOwner))toast(error.message,true)}});
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
async function renderWecom(){
  const [wecomData,aiData]=await Promise.all([api('/api/settings/wecom'),api('/api/settings/ai?limit=100')]);
  const settings=wecomData.settings||{};
  const notifications=wecomData.notifications||[];
  const ai=aiData.settings||{};
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
      <div><span class="panel-kicker">WECOM & AI CONTROL</span><h2>企微及 AI</h2><p>集中管理企业微信通知通道与 AI 服务参数，配置状态、连接测试和调用消耗一目了然。</p></div>
    </div>
    <div class="settings-hero-status ${ai.mode==='online'&&ai.configured?'is-online':'is-standby'}"><span>AI 服务状态</span><b><i></i>${esc(aiModeName(ai.mode))}</b><small>${ai.mode==='online'&&ai.configured?'配置已就绪，可进行真实调用':'当前按配置模式运行'}</small></div>
  </section>
  <section class="settings-config-flow-frame ${state.settingsConfigPanel?'is-expanded':''}" data-settings-config-frame>
    <div class="settings-config-strip" role="group" aria-label="通知与 AI 服务配置">
      <button class="settings-config-toggle wecom ${state.settingsConfigPanel==='wecom'?'active':''}" type="button" data-settings-config-toggle="wecom" aria-label="${state.settingsConfigPanel==='wecom'?'收起':'展开'}企业微信群机器人配置" title="企业微信群机器人配置" aria-expanded="${state.settingsConfigPanel==='wecom'}" aria-controls="wecomSettingsDrawer">
        <span class="settings-card-icon wecom">${iconSvg('wecom')}</span>
        <span class="settings-toggle-copy"><small>NOTIFICATION CHANNEL</small><b>企业微信群机器人</b><em>${settings.configured?'通知通道已连接':'等待配置通知通道'}</em></span>
        <span class="settings-toggle-status ${settings.configured?'is-ready':'is-pending'}"><i></i>${settings.configured?'正常':'待配置'}</span>
        <span class="settings-toggle-action">${state.settingsConfigPanel==='wecom'?'收起':'展开'}</span><span class="settings-toggle-chevron" aria-hidden="true">⌄</span>
      </button>
      <button class="settings-config-toggle ai ${state.settingsConfigPanel==='ai'?'active':''}" type="button" data-settings-config-toggle="ai" aria-label="${state.settingsConfigPanel==='ai'?'收起':'展开'}AI 服务配置" title="AI 服务配置" aria-expanded="${state.settingsConfigPanel==='ai'}" aria-controls="aiSettingsDrawer">
        <span class="settings-card-icon ai">AI</span>
        <span class="settings-toggle-copy"><small>AI SERVICE</small><b>AI 服务配置</b><em>${ai.mode==='online'&&ai.configured?'在线服务已就绪':ai.mode==='mock'?'当前使用模拟模式':'在线服务等待配置'}</em></span>
        <span class="settings-toggle-status ${ai.mode==='online'&&ai.configured?'is-ready':ai.mode==='mock'?'is-info':'is-pending'}"><i></i>${ai.mode==='online'&&ai.configured?'正常':ai.mode==='mock'?'模拟':'待配置'}</span>
        <span class="settings-toggle-action">${state.settingsConfigPanel==='ai'?'收起':'展开'}</span><span class="settings-toggle-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>
    <div id="wecomSettingsDrawer" class="settings-config-drawer wecom-settings-drawer" ${state.settingsConfigPanel==='wecom'?'':'hidden'}>
      <div class="settings-drawer-heading"><div><span class="settings-card-eyebrow">NOTIFICATION CHANNEL</span><h2>企业微信群机器人</h2><p>用于风险转人工、账号异常和系统运行告警的群通知通道。</p></div>${settings.configured?badge('READY'):badge('PENDING')}</div>
      <div class="settings-status-card ${settings.configured?'is-ready':'is-warning'}">
        <span class="settings-status-dot"></span>
        <div><b>${settings.configured?'通知通道已连接':'等待配置通知通道'}</b><p>${settings.configured?`Webhook：<code>${esc(settings.maskedUrl)}</code>`:'尚未填写机器人 Webhook，通知只会在系统内生成记录。'}</p><small>${settings.configured?`来源：${esc(sourceName)}${settings.updatedAt?` · 更新于 ${fmt(settings.updatedAt)}`:''}`:'未配置时会生成 SIMULATED 记录，不会实际发送到企业微信群。'}</small></div>
      </div>
      <form id="wecomForm" class="form-grid settings-form wecom-config-form">
        <label class="full settings-field"><span class="settings-field-label">机器人 Webhook 地址</span><div class="settings-input-wrap"><span class="settings-input-prefix">URL</span><input type="password" name="webhookUrl" autocomplete="new-password" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." ${settings.configured?'':'required'}></div><small>完整地址不会回显；数据库采用 AES-256-GCM 加密保存。</small></label>
        <label class="settings-field"><span class="settings-field-label">更新人</span><input name="updatedBy" value="技术部" maxlength="100" placeholder="填写配置维护人"></label>
        <div class="settings-mini-card" aria-label="Webhook 安全说明"><span>安全存储</span><b>AES-256-GCM</b><small>敏感地址加密保存，不写入普通日志</small></div>
        <div class="full button-row settings-form-actions"><button class="btn" type="submit">保存企微配置</button><button class="btn secondary" type="button" id="wecomTest" ${settings.configured?'':'disabled'}>发送测试消息</button><button class="btn danger" type="button" id="wecomClear" ${settings.source==='DATABASE'?'':'disabled'}>清除页面配置</button></div>
      </form>
    </div>
    <div id="aiSettingsDrawer" class="settings-config-drawer ai-settings-drawer" ${state.settingsConfigPanel==='ai'?'':'hidden'}>
      <div class="settings-drawer-heading"><div><span class="settings-card-eyebrow">AI SERVICE</span><h2>AI 服务配置</h2><p>统一管理天河、知识库答案生成、微信客服和机器人聊天的模型。保存后，后续调用使用新配置。</p></div>${ai.mode==='online'&&ai.configured?badge('READY'):ai.mode==='mock'?badge('SIMULATED'):badge('PENDING')}</div>
      <div class="settings-status-card ${ai.mode==='online'&&ai.configured?'is-ready':ai.mode==='mock'?'is-info':'is-warning'}">
        <span class="settings-status-dot"></span>
        <div><b>${ai.mode==='online'&&ai.configured?'在线服务已就绪':ai.mode==='mock'?'当前使用模拟模式':'在线服务等待配置'}</b><p>AI Key：<code>${ai.configured?esc(ai.maskedApiKey):'未配置'}</code></p><small>来源：${esc(aiSourceName)}${ai.updatedAt?` · 更新于 ${fmt(ai.updatedAt)}`:''}</small></div>
      </div>
      <form id="aiSettingsForm" class="form-grid ai-settings-grid settings-form">
        <label class="settings-field settings-select-field"><span class="settings-field-label">AI 调用模式</span><select name="mode"><option value="mock" ${ai.mode==='mock'?'selected':''}>模拟模式（不调用在线 AI）</option><option value="online" ${ai.mode==='online'?'selected':''}>在线调用</option></select></label>
        <label class="settings-field"><span class="settings-field-label">更新人</span><input name="updatedBy" value="技术部" maxlength="100" placeholder="填写配置维护人"></label>
        <div class="full ai-mode-card ${ai.mode==='online'?'is-online':'is-standby'}"><span class="ai-mode-card-icon">${ai.mode==='online'?'✓':'↗'}</span><div><b>${ai.mode==='online'?'Online 在线模式已启用':'需要使用真实 AI 能力？'}</b><p>${ai.mode==='online'?'当前会按下方模型配置进行真实调用。':'切换到 Online 模式后，确认 AI Key 与模型参数并保存。'}</p></div><button class="btn secondary" type="button" id="selectAiOnlineMode" ${ai.mode==='online'?'disabled':''}>${ai.mode==='online'?'已启用 Online 模式':'切换为 Online'}</button></div>
        <label class="full settings-field"><span class="settings-field-label">AI Key</span><div class="settings-input-wrap"><span class="settings-input-prefix">KEY</span><input type="password" name="apiKey" autocomplete="new-password" placeholder="${ai.configured?'留空表示保留当前 Key':'输入 AI Key'}"></div><small class="ai-key-status">完整 Key 不会回传页面或写入普通日志；${ai.configured?`当前仅显示 ${esc(ai.maskedApiKey)}`:'当前未配置'}。</small></label>
        <label class="full settings-field"><span class="settings-field-label">Base URL</span><div class="settings-input-wrap"><span class="settings-input-prefix">API</span><input name="baseUrl" value="${esc(ai.baseUrl||'')}" required placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"></div></label>
        <label class="settings-field"><span class="settings-field-label">对话模型</span><input name="model" value="${esc(ai.model||'')}" required placeholder="例如 qwen3.7-plus"></label>
        <label class="settings-field"><span class="settings-field-label">视觉 / OCR 模型</span><input name="visionModel" value="${esc(ai.visionModel||'')}" required placeholder="例如 qwen3.5-ocr"></label>
        <details class="full"><summary>专用模型（按需配置）</summary><div class="form-grid settings-form">
          <label class="settings-field"><span class="settings-field-label">音视频转文字模型</span><input name="asrModel" value="${esc(ai.modelOverrides?.asrModel||'')}" placeholder="例如 qwen3-asr-flash"></label>
          <label class="settings-field"><span class="settings-field-label">音视频文案模型</span><input name="contentModel" value="${esc(ai.modelOverrides?.contentModel||'')}" placeholder="留空跟随对话模型"></label>
          <label class="settings-field"><span class="settings-field-label">图片文案模型</span><input name="imageContentModel" value="${esc(ai.modelOverrides?.imageContentModel||'')}" placeholder="留空跟随对话模型"></label>
          <label class="settings-field"><span class="settings-field-label">素材潜力预测模型</span><input name="trafficPredictionModel" value="${esc(ai.modelOverrides?.trafficPredictionModel||'')}" placeholder="留空跟随对话模型"></label>
          <label class="settings-field"><span class="settings-field-label">微信知识库向量模型</span><input name="embeddingModel" value="${esc(ai.embeddingModel||'')}" placeholder="local:BAAI/bge-small-zh-v1.5"></label>
          <p class="full muted">微信原生知识库默认使用 local:BAAI/bge-small-zh-v1.5（本地 512 维向量）。改用其他向量模型时需同步机器人向量维度并重建索引。其他专用模型共用上方接口和密钥，请填写服务商实际支持的模型。</p>
        </div></details>
        <div class="full button-row settings-form-actions"><button class="btn" type="submit">保存 AI 配置</button><button class="btn secondary" type="button" id="aiConnectionTest" ${ai.mode==='online'&&!ai.configured?'disabled':''}>测试 AI 连接</button><button class="btn danger" type="button" id="aiKeyClear" ${ai.source==='DATABASE'?'':'disabled'}>清除 AI Key</button></div>
      </form>
    </div>
  </section>
  <div class="panel ai-usage-panel">
    <div class="panel-head"><div><h2>AI 今日调用与 Token 成本</h2><p>用柱状图查看近 7 日每日调用量，并按官方 Token 单价估算今日输入、输出消费；模拟调用 Token 为 0。</p></div><span class="muted">今日 ${Number(summary.calls||0)} 次</span></div>
    <div class="ai-summary-grid"><article><span>今日调用</span><b>${Number(summary.calls||0)}</b></article><article><span>总 Token</span><b>${tokenValue(summary.total_tokens)}</b><small>输入 ${tokenValue(summary.input_tokens)} · 输出 ${tokenValue(summary.output_tokens)}</small></article><article class="cost"><span>今日 Token 估算费用</span><b>${aiCostValue(summary.estimated_cost_cny)}</b><small>${Number(summary.unpriced_tokens||0)>0?`${tokenValue(summary.unpriced_tokens)} Token 未计价`:Number(summary.non_token_billed_calls||0)>0?`${Number(summary.priced_calls||0)} 次按 Token · ${Number(summary.non_token_billed_calls||0)} 次按时长`:'已计价 Token 调用 '+Number(summary.priced_calls||0)+' 次'}</small></article><article><span>平均耗时</span><b>${Number(summary.average_duration_ms||0).toLocaleString('zh-CN')}<em> ms</em></b></article></div>
    <div class="ai-usage-visual-grid">
      <article class="ai-visual-card ai-daily-card"><div class="ai-visual-head"><div><span>DAILY CALLS</span><h3>近 7 日每日调用量</h3></div><b>${daily.reduce((sum,item)=>sum+Number(item.calls||0),0)}<small> 次</small></b></div>${aiDailyCallChart(daily)}</article>
      <article class="ai-visual-card ai-cost-card"><div class="ai-visual-head"><div><span>TODAY TOKEN COST</span><h3>今日 Token 构成与费用</h3></div><b>${aiCostValue(summary.estimated_cost_cny)}</b></div><div class="ai-cost-overview"><div class="ai-token-chart">${aiTokenDonut(summary)}</div><div class="ai-model-cost-list">${modelCostRows}</div></div>${Number(summary.unpriced_tokens||0)>0?`<div class="ai-pricing-warning">另有 ${tokenValue(summary.unpriced_tokens)} Token 因模型未匹配计价表，未计入今日费用。</div>`:''}<div class="ai-pricing-note">${esc(pricing.note||'费用为估算值，以服务商账单为准。')} <a href="${esc(pricing.source_url||'https://help.aliyun.com/zh/model-studio/model-pricing')}" target="_blank" rel="noopener noreferrer">查看官方价格</a>${pricing.checked_at?` · 本地计价表核对于 ${esc(pricing.checked_at)}`:''}</div></article>
    </div>
    <div class="table-wrap ai-log-table"><table><thead><tr><th>时间</th><th>任务类型</th><th>模式</th><th>模型</th><th>状态</th><th>Token 输入/输出</th><th>耗时</th><th>错误摘要</th></tr></thead><tbody>${aiLogRows}</tbody></table></div>
  </div>
  <section class="panel wecom-history-panel wecom-history-wide">
    <div class="panel-head"><div><span class="settings-card-eyebrow">NOTIFICATION HISTORY</span><h2>最近企微通知记录</h2><p>按通知类型快速筛选，点击任一记录可展开查看完整内容与发送结果。</p></div><span class="records-count-pill">共 ${notifications.length} 条</span></div>
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
    syncSettingsConfigPanel();
  });
  syncSettingsConfigPanel();
  $('#wecomForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));if(!String(values.webhookUrl||'').trim())return toast('\u8bf7\u8f93\u5165\u65b0\u7684\u673a\u5668\u4eba Webhook \u5730\u5740',true);try{await api('/api/settings/wecom',{method:'POST',body:JSON.stringify(values)});toast('\u4f01\u5fae Webhook \u5df2\u5b89\u5168\u4fdd\u5b58');renderWecom()}catch(error){toast(error.message,true)}};
  $('#wecomTest').onclick=async()=>{const button=$('#wecomTest');button.disabled=true;button.textContent='\u53d1\u9001\u4e2d\u2026';try{await api('/api/settings/wecom/test',{method:'POST',body:'{}'});toast('\u6d4b\u8bd5\u6d88\u606f\u53d1\u9001\u6210\u529f');renderWecom()}catch(error){toast(`${error.message}${error.detail?'\uff1a'+error.detail:''}`,true);button.disabled=false;button.textContent='\u53d1\u9001\u6d4b\u8bd5\u6d88\u606f'}};
  $('#wecomClear').onclick=async()=>{if(!confirm('\u786e\u5b9a\u6e05\u9664\u7ba1\u7406\u9875\u9762\u4fdd\u5b58\u7684\u4f01\u5fae Webhook \u5417\uff1f'))return;try{await api('/api/settings/wecom/clear',{method:'POST',body:'{}'});toast('\u4f01\u5fae\u9875\u9762\u914d\u7f6e\u5df2\u6e05\u9664');renderWecom()}catch(error){toast(error.message,true)}};
  $('#selectAiOnlineMode').onclick=()=>{const form=$('#aiSettingsForm'),mode=form?.querySelector('[name="mode"]'),key=form?.querySelector('[name="apiKey"]');if(mode)mode.value='online';if(key&&!key.value&&ai.configured!==true)key.focus();toast(ai.configured?'已选择 Online 在线模式，请点击“保存 AI 配置”使其生效':'已选择 Online 在线模式，请填写 AI Key 后点击“保存 AI 配置”');};
  $('#aiSettingsForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await api('/api/settings/ai',{method:'POST',body:JSON.stringify(values)});toast('AI 配置已保存，天河、知识库与微信服务的后续调用将使用新配置');renderWecom()}catch(error){toast(error.message,true)}};
  $('#aiConnectionTest').onclick=async()=>{const button=$('#aiConnectionTest');button.disabled=true;button.textContent='\u6d4b\u8bd5\u4e2d\u2026';try{const result=await api('/api/settings/ai/test',{method:'POST',body:'{}'});toast(result.result?.message||'AI \u8fde\u63a5\u6d4b\u8bd5\u6210\u529f');renderWecom()}catch(error){toast(`${error.message}${error.detail?'\uff1a'+error.detail:''}`,true);button.disabled=false;button.textContent='\u6d4b\u8bd5 AI \u8fde\u63a5'}};
  $('#aiKeyClear').onclick=async()=>{if(!confirm('\u786e\u5b9a\u6e05\u9664\u7ba1\u7406\u9875\u9762\u4fdd\u5b58\u7684 AI Key \u5417\uff1f\u5728\u7ebf\u6a21\u5f0f\u5c06\u65e0\u6cd5\u8c03\u7528 AI\u3002'))return;try{await api('/api/settings/ai/clear-key',{method:'POST',body:'{}'});toast('AI Key \u5df2\u6e05\u9664');renderWecom()}catch(error){toast(error.message,true)}};
}
function renderLoginBadge(code,status,prefix='platformStatus-'){const el=document.getElementById(`${prefix}${code}`);if(!el)return;const m=loginStatusMeta(status);el.textContent=m.text;el.className=`badge ${m.cls}`;el.title=[status?.message,status?.checkedAt?`\u68c0\u67e5\u65f6\u95f4\uff1a${fmt(status.checkedAt)}`:''].filter(Boolean).join('\n')}
function dashboardPlatformLoginView(platform){const account=(state.bootstrap?.accounts||[]).find(item=>item.platform_code===platform.code);const runtime=(state.bootstrap?.platforms||[]).find(item=>item.code===platform.code);const planned=runtime?.lifecycle_state==='PLANNED';return {account,runtime,planned,meta:planned?{text:'RPA\u65b9\u6848\u89c4\u5212\u4e2d',cls:'planned'}:loginStatusMeta(accountLoginState(account)),detail:planned?'\u5e73\u53f0\u5c1a\u672a\u6b63\u5f0f\u63a5\u5165':accountLoginDetail(account)}}
function refreshDashboardLoginStatus(){if(state.page!=='dashboard'||!state.bootstrap)return;for(const platform of loginPlatforms){const view=dashboardPlatformLoginView(platform);const card=document.getElementById(`dashboardPlatformCard-${platform.code}`);const badgeEl=document.getElementById(`dashboardPlatformStatus-${platform.code}`);const detailEl=document.getElementById(`dashboardPlatformDetail-${platform.code}`);if(card)card.className=`platform-login-item${view.planned?' planned':''}`;if(badgeEl){badgeEl.textContent=view.meta.text;badgeEl.className=`badge ${view.meta.cls}`;badgeEl.title=[view.account?.login_message,view.account?.login_checked_at?`\u68c0\u67e5\u65f6\u95f4\uff1a${fmt(view.account.login_checked_at)}`:''].filter(Boolean).join('\n')}if(detailEl)detailEl.textContent=view.detail}}
function refreshPlatformLoginStatus(){if(state.page!=='platforms'||!state.bootstrap)return;renderPlatformRuntimePage()}
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
function renderPlatformRuntimePage(){
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
    const stateText=taskRunning?'可执行':platformRunning&&issueBlocked?'已开启 · 问题阻断':!accountEnabled?'账号已停用':'已停止';
    const detail=taskRunning?'平台开关和运行条件均已通过，可执行发布、采集和回复。':platformRunning&&issueBlocked?'平台已开启，但关联问题正在阻断对应范围；请到问题汇总进行人工处置。':!accountEnabled?'账号未启用，平台保持 STOPPED；不会启动浏览器、Profile 或登录检查。':'平台已停止；不领取任务，不打开浏览器/Profile，不执行登录检查或采集。';
    const smartReplyEnabled=runtime.smart_reply_enabled===true;
    const smartReplyRunning=runtime.smart_reply_effective_state==='RUNNING';
    const smartReplyText=smartReplyRunning?'\u8fd0\u884c\u4e2d':smartReplyEnabled?'\u5df2\u5f00\u542f \u00b7 \u5f85\u5e73\u53f0\u53ef\u6267\u884c':'\u5df2\u5173\u95ed';
    const smartReplyDetail=smartReplyRunning?'评论和私信将采集后按知识库自动回复。':smartReplyEnabled?'配置已保存；平台停止或存在关联问题阻断时不会领取回复任务。':'消息保留等待，不生成或领取自动回复任务。';
    return `<article class="platform-runtime-card ${platformRunning?'is-running':'is-stopped'}"><div class="platform-runtime-heading"><div><b>${esc(platform.name)}</b>${platform.acceptanceNote?`<span class="badge warning">${esc(platform.acceptanceNote)}</span>`:''}<span class="badge ${taskRunning?'running':platformRunning?(issueBlocked?'warning':'running'):'stopped'}">${stateText}</span></div><button type="button" class="platform-runtime-toggle ${desiredRunning?'is-on':'is-off'}" data-platform="${platform.code}" data-enable="${desiredRunning?'false':'true'}" aria-pressed="${desiredRunning?'true':'false'}" ${!desiredRunning&&!accountEnabled?'disabled title="\u8bf7\u5148\u542f\u7528\u8d26\u53f7\uff1b\u542f\u7528\u8d26\u53f7\u672c\u8eab\u4e0d\u4f1a\u5524\u9192 Local Agent"':''}><span class="runtime-switch-track"><i></i></span><strong>${desiredRunning?'\u505c\u6b62\u5e73\u53f0':'\u5f00\u542f\u5e73\u53f0'}</strong></button></div><p>${detail}</p><div class="button-row"><button type="button" class="btn ${accountEnabled?'danger':'secondary'} platform-account-toggle" data-account="${account?.id||''}" data-enable="${accountEnabled?'false':'true'}" ${account?'':'disabled'}>${accountEnabled?'\u505c\u7528\u8d26\u53f7':'\u542f\u7528\u8d26\u53f7\uff08\u4e0d\u5524\u9192\uff09'}</button>${accountEnabled&&!desiredRunning?'<small class="muted">\u4e0b\u4e00\u6b65\uff1a\u663e\u5f0f\u5f00\u542f\u5e73\u53f0</small>':''}</div><div class="smart-reply-control ${smartReplyRunning?'is-running':smartReplyEnabled?'is-waiting':'is-stopped'}"><div><b>\u667a\u80fd\u56de\u590d \u00b7 ${smartReplyText}</b><small>${smartReplyDetail}</small></div><button type="button" class="btn ${smartReplyEnabled?'danger':'secondary'} platform-smart-reply-toggle" data-platform="${platform.code}" data-enable="${smartReplyEnabled?'false':'true'}">${smartReplyEnabled?'\u5173\u95ed\u667a\u80fd\u56de\u590d':'\u5f00\u542f\u667a\u80fd\u56de\u590d'}</button></div><div class="platform-runtime-metrics"><span>\u542f\u7528\u8d26\u53f7 <b>${Number(runtime.enabled_account_count||0)}</b></span><span>\u5f85\u6267\u884c <b>${Number(runtime.queued_job_count||0)}</b></span><span>\u8fd0\u884c\u4e2d <b>${Number(runtime.running_job_count||0)}</b></span></div>${issueBlocked?'<div class="section-actions"><button type="button" class="btn secondary" data-go="issues">处理关联问题</button></div>':''}<div class="muted">\u8d26\u53f7\uff1a${esc(account?.display_name||'\u672a\u914d\u7f6e')} \u00b7 Profile\uff1a${esc(account?.profile_name||'\u672a\u914d\u7f6e')}</div>${runtime.runtime_updated_at?`<small>\u6700\u540e\u8c03\u6574\uff1a${fmt(runtime.runtime_updated_at)}${runtime.runtime_updated_by?' \u00b7 '+esc(runtime.runtime_updated_by):''}</small>`:''}</article>`;
  }).join('');
  $('#content').innerHTML=`<section class="platform-runtime-page-head"><div><span class="panel-kicker">PLATFORM RUNTIME CONTROL</span><h2>\u4e94\u5e73\u53f0\u8fd0\u884c\u63a7\u5236 \u00b7 \u8d26\u53f7\u4e0e\u667a\u80fd\u56de\u590d\u7ba1\u7406</h2><p>\u5c0f\u7ea2\u4e66\u3001\u6296\u97f3\u3001\u89c6\u9891\u53f7\u3001B\u7ad9\u3001\u5fae\u535a\u5747\u53ef\u72ec\u7acb\u542f\u505c\u3002\u8d26\u53f7\u542f\u7528\u4e0d\u4f1a\u5524\u9192 Local Agent\uff1b\u53ea\u6709\u663e\u5f0f\u5f00\u542f\u5e73\u53f0\u540e\u624d\u5141\u8bb8\u767b\u5f55\u548c\u4efb\u52a1\u6267\u884c\u3002</p></div><span class="runtime-summary">${runnableCount}/${activeCodes.length} \u53ef\u6267\u884c \u00b7 ${openedCount}/${activeCodes.length} \u5df2\u5f00\u542f</span></section><div class="notice warn"><b>\u5b89\u5168\u5173\u95ed\u8bed\u4e49\uff1a</b>STOPPED \u5e73\u53f0\u4e0d\u9886\u53d6\u4efb\u52a1\u3001\u4e0d\u767b\u5f55\u68c0\u67e5\u3001\u4e0d\u91c7\u96c6\u3001\u4e0d\u521b\u5efa\u6216\u6253\u5f00 Chrome/Profile\uff1b\u505c\u6b62\u65f6\u901a\u77e5 Local Agent \u5173\u95ed\u5df2\u6709 Browser Context\u3002</div><div class="panel platform-runtime-panel"><div class="panel-head"><div><h2>\u5e73\u53f0\u8fd0\u884c\u5f00\u5173</h2><p>\u4e94\u4e2a\u5df2\u63a5\u5165\u5e73\u53f0\u5747\u652f\u6301\u8d26\u53f7\u542f\u505c\u3001\u5e73\u53f0\u542f\u505c\u548c\u667a\u80fd\u56de\u590d\u72ec\u7acb\u63a7\u5236\u3002</p></div><div class="button-row"><button type="button" class="btn" id="enableAllPlatforms" title="\u5c06\u4e0b\u65b9\u4e94\u4e2a\u5e73\u53f0\u7684\u8d26\u53f7\u4e0e\u5e73\u53f0\u8fd0\u884c\u5f00\u5173\u7edf\u4e00\u5207\u6362\u4e3a\u5f00\u542f" ${allPlatformsEnabled?'disabled':''}>\u4e00\u952e\u5f00\u542f\u5168\u90e8\u5e73\u53f0</button><button type="button" class="btn success" id="openSelectedPlatforms" title="\u53ea\u6253\u5f00\u4e0b\u65b9\u5df2\u542f\u7528\u8d26\u53f7\u4e14\u8fd0\u884c\u5f00\u5173\u4e3a RUNNING \u7684\u5e73\u53f0\uff1b\u672a\u542f\u7528\u5e73\u53f0\u4e0d\u4f1a\u88ab\u5524\u9192" ${openedCount?'':'disabled'}>\u4e00\u952e\u6253\u5f00\u6240\u9009\u5e73\u53f0</button><button type="button" class="btn danger" id="stopAllPlatforms" ${desiredRunningCount?'':'disabled'}>\u505c\u6b62\u5168\u90e8\u5e73\u53f0</button><button type="button" class="btn secondary" data-go="issues">\u95ee\u9898\u6c47\u603b</button></div></div><div class="platform-runtime-grid">${runtimeCards}</div></div>`;
  document.querySelectorAll('.platform-runtime-toggle').forEach(button=>button.onclick=()=>togglePlatformRuntime(button.dataset.platform,button.dataset.enable==='true',button));
  document.querySelectorAll('.platform-account-toggle').forEach(button=>button.onclick=()=>togglePlatformAccount(Number(button.dataset.account),button.dataset.enable==='true',button));
  document.querySelectorAll('.platform-smart-reply-toggle').forEach(button=>button.onclick=()=>togglePlatformSmartReply(button.dataset.platform,button.dataset.enable==='true',button));
  const enableAll=$('#enableAllPlatforms');if(enableAll)enableAll.onclick=()=>startAllPlatforms(enableAll);
  const openSelected=$('#openSelectedPlatforms');if(openSelected)openSelected.onclick=()=>batchPlatformAction('open',openSelected);
  const stopAll=$('#stopAllPlatforms');if(stopAll)stopAll.onclick=()=>stopAllPlatforms(stopAll);
  document.querySelectorAll('[data-go]').forEach(button=>button.onclick=()=>navigate(button.dataset.go));
}



function xiaozhiSelectedValue(id,fallback){const element=$(id);return element?element.value:fallback}
async function ensureXiaozhiSession(force=false){
  if(!state.xiaozhiOptions)state.xiaozhiOptions=(await api('/api/xiaozhi/options')).options;
  const backend=state.xiaozhiOptions?.backend||'LEGACY';
  if(backend==='RAG'&&!['published','pre_release','single_document'].includes(state.xiaozhiSettings.scope))state.xiaozhiSettings.scope='pre_release';
  if(backend!=='RAG'&&!['published','import_batch'].includes(state.xiaozhiSettings.scope))state.xiaozhiSettings.scope='published';
  if(state.xiaozhiSession&&!force)return state.xiaozhiSession;
  const result=await api('/api/xiaozhi/sessions',{method:'POST',body:JSON.stringify(state.xiaozhiSettings)});
  state.xiaozhiSession=result.session;
  return result.session;
}function xiaozhiSourceReferences(result){
  const candidates=[result?.sourceReferences,result?.grounding?.sourceReferences,result?.source_references,result?.grounding?.source_references];
  return candidates.find(item=>Array.isArray(item)&&item.length)||[];
}
function xiaozhiSourceContent(source={}){
  const candidates=[source.excerpt,source.text,source.content,source.snippet];
  return candidates.map(value=>String(value??'').replace(/\r\n/g,'\n').trim()).find(Boolean)||'';
}
function xiaozhiSourceLocation(source={}){
  const page=source.page??source.location?.page;
  const sheet=source.sheet??source.location?.sheet;
  const row=source.rowStart??source.location?.row;
  const location=[];
  if(page!==undefined&&page!==null&&String(page)!=='')location.push(`第 ${esc(page)} 页`);
  if(sheet)location.push(`工作表：${esc(sheet)}`);
  if(row!==undefined&&row!==null&&String(row)!=='')location.push(`第 ${esc(row)} 行`);
  return location.join(' · ');
}
function xiaozhiDiagnostic(result){
  const matches=(result.matches||[]).map(item=>`<div class="xiaozhi-match"><b>#${item.knowledgeId} ${esc(item.question)}</b><span>置信度 ${Math.round(Number(item.confidence||0)*100)}% · ${esc(matchMethodName(item.matchMethod))}${item.contextUsed?' · 已使用上下文':''}</span><p>${esc(item.answer)}</p></div>`).join('');
  const hasRetrievalScore=typeof result.retrievalConfidence==='number'&&Number.isFinite(result.retrievalConfidence);
  const scoreLabel=hasRetrievalScore?`知识匹配参考分 ${Math.round(result.retrievalConfidence*100)}%`:result.ragStatus==='NOT_QUERIED'?'尚未查询知识库':`回复置信度 ${Math.round(Number(result.confidence||0)*100)}%`;
  const answerLabel=result.ragStatus==='NO_ANSWER'?'暂无可靠答案 · ':'';
  const analysis=result.queryAnalysis;
  const queryDetails=analysis?`${analysis.keywords?.length?`<div><b>提取关键词：</b>${esc(analysis.keywords.join('、'))}</div>`:''}<div><b>实际检索问题：</b>${esc(analysis.resolvedQuestion||'—')}</div>`:'';
  const scoreSource=hasRetrievalScore?'<div><b>分数来源：</b>RAG 知识检索与重排序，表示知识匹配程度；是否能回答还需检查答案依据。</div>':'';
  const guidance=Number(result.guidanceAttempt||0)>0?`<div><b>业务引导：</b>第 ${Number(result.guidanceAttempt)}/${Number(result.maxGuidanceAttempts||3)} 轮${result.handoffRequested?'，已判定转人工':result.handoffOffered?'，已提供“转人工”入口':'，继续确认具体业务'}</div>`:'';
  const references=xiaozhiSourceReferences(result);
  const sources=references.map(item=>{
    const content=xiaozhiSourceContent(item);
    const title=String(item.title||item.filename||item.fileName||'知识库引用').trim();
    const location=xiaozhiSourceLocation(item);
    return `<div class="xiaozhi-match xiaozhi-source"><b>引用内容</b>${content?`<p class="xiaozhi-source-excerpt">${esc(content)}</p>`:'<p class="xiaozhi-source-empty">引用内容暂未返回</p>'}${title?`<span>来源文件：${esc(title)}${location?` · ${location}`:''}</span>`:''}</div>`;
  }).join('');
  return `<details class="xiaozhi-diagnostic"><summary>查看判断依据 · ${answerLabel}${scoreLabel} · ${Number(result.elapsedMs||0)}ms</summary><div class="xiaozhi-diagnostic-body"><div><b>处理结果：</b>${esc(statusName(result.decision)||result.decision)}</div><div><b>判断原因：</b>${esc(result.reason||'—')}</div><div><b>匹配方式：</b>${esc(matchMethodName(result.matchMethod))}</div><div><b>上下文：</b>${result.contextUsed?'已用于补全省略问题':'未使用'}${result.topicSwitched?'，已识别话题切换':''}</div>${queryDetails}${scoreSource}${guidance}${sources}${matches||(!sources?'<div class="muted">未命中可用知识</div>':'')}</div></details>`;
}
function xiaozhiAssistantMessageHtml(item,index){
  const status=item.status||'done';
  const result=item.result||{};
  const id=esc(item.id||`xiaozhi-assistant-${index}`);
  if(status==='thinking')return `<div class="xiaozhi-row assistant is-entering"><div class="xiaozhi-avatar">智</div><div class="xiaozhi-bubble is-thinking"><span>小智 <i>正在处理</i></span><div class="xiaozhi-thinking" aria-live="polite"><span class="xiaozhi-thinking-label">正在理解问题并组织回复</span><span class="xiaozhi-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="xiaozhi-thinking-shimmer" aria-hidden="true"></span></div></div></div>`;
  const text=status==='typing'?(item.displayText||''):(result.replyText||item.displayText||'');
  const done=status==='done';
  const approvalDecision=result.approvalDecision||'ENABLED';
  const approvalLabel=approvalDecision==='DISABLED'?'已停用':'已启用';
  const approvalClass=approvalDecision==='DISABLED'?'is-disabled':'is-enabled';
  const answerControls=done&&result.answerId?`<div class="xiaozhi-approval ${approvalClass}"><span>应用状态：<b>${approvalLabel}</b></span><div class="button-row compact"><button class="btn ${approvalDecision==='ENABLED'?'primary':'secondary'} xiaozhi-enable" data-index="${index}" data-answer-id="${esc(result.answerId)}" ${approvalDecision==='ENABLED'?'disabled':''}>启用</button><button class="btn ${approvalDecision==='DISABLED'?'primary danger':'secondary'} xiaozhi-disable" data-index="${index}" data-answer-id="${esc(result.answerId)}" ${approvalDecision==='DISABLED'?'disabled':''}>不启用</button></div></div>`:'';
  return `<div class="xiaozhi-row assistant ${status==='typing'?'is-typing-row':''}"><div class="xiaozhi-avatar">智</div><div class="xiaozhi-bubble"><span>小智 ${done?`<i>${Number(result.elapsedMs||0)}ms</i>`:'<i>正在回复</i>'}</span><p id="xiaozhiText-${id}" class="xiaozhi-reply-text ${status==='typing'?'is-typing':''}">${esc(text)}</p>${done?`${answerControls}<div class="button-row compact"><button class="btn secondary xiaozhi-copy" data-index="${index}">复制回复</button></div>${xiaozhiDiagnostic(result)}`:''}</div></div>`;
}
function xiaozhiMessageHtml(item,index){
  if(item.role==='user')return `<div class="xiaozhi-row user is-entering"><div class="xiaozhi-bubble"><span>运营测试</span><p>${esc(item.text)}</p></div></div>`;
  return xiaozhiAssistantMessageHtml(item,index);
}
async function typeXiaozhiReply(messageId,text){
  const item=state.xiaozhiChat.find(entry=>entry.id===messageId);
  if(!item)return;
  const characters=Array.from(String(text||''));
  const interval=characters.length<=80?22:characters.length<=220?14:8;
  item.status='typing';item.displayText='';
  for(let index=0;index<characters.length;index+=1){
    if(!state.xiaozhiChat.includes(item))return;
    item.displayText+=characters[index];
    const element=document.getElementById(`xiaozhiText-${messageId}`);
    if(!element){item.displayText=String(text||'');break}
    element.textContent=item.displayText;
    const box=$('#xiaozhiMessages');if(box)box.scrollTop=box.scrollHeight;
    const pause=/[。！？!?；;\n]/.test(characters[index])?Math.min(55,interval*3):interval;
    await new Promise(resolve=>setTimeout(resolve,pause));
  }
  item.displayText=String(text||'');item.status='done';
  await renderXiaozhi();
}
async function updateXiaozhiDecision(button){
  const sessionId=state.xiaozhiSession?.id;
  const answerId=button?.dataset?.answerId;
  const index=Number(button?.dataset?.index);
  const item=Number.isInteger(index)?state.xiaozhiChat[index]:null;
  if(!sessionId||!answerId||!item?.result)return toast('测试答案信息不完整，无法更新状态',true);
  const disable=button.classList.contains('xiaozhi-disable');
  let reason=null;
  let reasonCode=null;
  if(disable){
    const review=await xiaozhiDisableReasonDialog();
    if(!review)return;
    reason=review.reason;
    reasonCode=review.reasonCode;
  }
  const controls=document.querySelectorAll('.xiaozhi-enable,.xiaozhi-disable');
  controls.forEach(element=>{element.disabled=true});
  try{
    const response=await api(`/api/xiaozhi/sessions/${encodeURIComponent(sessionId)}/answers/${encodeURIComponent(answerId)}/decision`,{method:'PUT',body:JSON.stringify({decision:disable?'DISABLED':'ENABLED',reasonCode,reason})});
    const answer=response.answer||{};
    item.result={...item.result,approvalDecision:answer.decision,decisionVersion:answer.decisionVersion,decisionReasonCode:answer.reasonCode,decisionReason:answer.reason};
    await renderXiaozhi();
    toast(disable?'已停用，正式用户端不会应用该测试答案':'已启用，正式用户端可以继续应用该测试答案');
  }catch(error){
    controls.forEach(element=>{element.disabled=false});
    toast(error.message||'更新测试答案状态失败',true);
  }
}
async function renderXiaozhi(){
  await ensureXiaozhiSession();
  const options=state.xiaozhiOptions||{};
  const settings=state.xiaozhiSettings;
  const backend=options.backend||'LEGACY';
  const isRag=backend==='RAG';
  const platformOptions=(options.platforms||[]).map(item=>`<option value="${esc(item.code)}" ${settings.platformCode===item.code?'selected':''}>${esc(item.name)}</option>`).join('');
  const batchOptions=(options.importBatches||[]).map(item=>`<option value="${item.id}" ${Number(settings.importBatchId)===Number(item.id)?'selected':''}>#${item.id} ${esc(item.file_name)} · ${esc(statusName(item.status))}</option>`).join('');
  const documentOptions=(options.ragDocuments||[]).map(item=>{const key=`${encodeURIComponent(item.documentId)}:${Number(item.documentVersion)||1}`;const selected=settings.selectedDocumentId===item.documentId&&Number(settings.selectedDocumentVersion||0)===Number(item.documentVersion||1);return `<option value="${esc(key)}" ${selected?'selected':''}>${esc(unifiedRagDocumentLabel(item.title||item.filename||item.documentId,item))} · v${Number(item.documentVersion)||1}</option>`}).join('');
  const scopeOptions=isRag
    ? `<option value="published" ${settings.scope==='published'?'selected':''}>当前正式发布版本</option><option value="pre_release" ${settings.scope==='pre_release'?'selected':''}>正式版本 + 待测文档</option><option value="single_document" ${settings.scope==='single_document'?'selected':''}>仅测试所选文档</option>`
    : `<option value="published" ${settings.scope==='published'?'selected':''}>正式知识库</option><option value="import_batch" ${settings.scope==='import_batch'?'selected':''}>上传批次草稿预览</option>`;
  const documentField=isRag?`<label class="xiaozhi-batch xiaozhi-document ${settings.scope==='published'?'is-hidden':''}">选择测试文档<select id="xiaozhiDocument"><option value="">请选择测试文档</option>${documentOptions}</select></label>`:'';
  const batchField=!isRag?`<label class="xiaozhi-batch ${settings.scope==='import_batch'?'':'is-hidden'}">上传批次<select id="xiaozhiBatch"><option value="">请选择</option>${batchOptions}</select></label>`:'';
  const activeRelease=options.activeRelease;
  const backendNote=isRag?`统一 RAG 测试模式（不区分平台，所有平台共用同一知识库）${activeRelease?.release_id||activeRelease?.releaseId?` · 当前正式版本 ${esc(activeRelease.release_id||activeRelease.releaseId)}`:' · 当前暂无正式发布版本'}`:'兼容模式：仍使用业务本地知识库';
  const publishCandidates=state.xiaozhiSession?.candidateDocuments||[];
  const selectedCandidateWasTested=settings.scope!=='published'&&Boolean(settings.selectedDocumentId)&&publishCandidates.some(item=>item.documentId===settings.selectedDocumentId&&Number(item.documentVersion||1)===Number(settings.selectedDocumentVersion||1));
  const canPublish=isRag&&Boolean(state.xiaozhiSession?.ragTestSessionId)&&state.xiaozhiSession?.scope===settings.scope&&selectedCandidateWasTested;
  const isBusy=state.xiaozhiChat.some(item=>item.role==='assistant'&&['thinking','typing'].includes(item.status));
  const messages=state.xiaozhiChat.length?state.xiaozhiChat.map(xiaozhiMessageHtml).join(''):`<div class="xiaozhi-empty"><div class="xiaozhi-avatar large">智</div><h3>先在这里测试知识库回复效果</h3><p>${isRag?'选择待测文档后，可测试“正式版本 + 待测文档”或仅测试单个文档；所有平台共用同一知识库，测试答案默认启用，可逐条改为不启用。':'直接输入用户可能会问的问题。小智会即时复用正式回复核心，但不会打开平台、不会创建真实消息，也不会通知企微。'}</p></div>`;
  $('#content').innerHTML=`<section class="xiaozhi-page"><div class="panel xiaozhi-toolbar"><div class="panel-head"><div><h2>小智 · 知识库即时测试</h2><p>上传文档先测试、逐条启用或不启用，满意后再发布到正式用户端。</p></div><div class="button-row"><button class="btn" id="xiaozhiPublish" ${canPublish?'':'disabled title="请先完成至少一轮待测文档问答"'}>发布为正式版本</button><button class="btn secondary" id="xiaozhiNew">新建测试</button></div></div><div class="xiaozhi-settings"><label>消息场景<select id="xiaozhiType"><option value="PRIVATE_MESSAGE" ${settings.messageType==='PRIVATE_MESSAGE'?'selected':''}>私信</option><option value="COMMENT" ${settings.messageType==='COMMENT'?'selected':''}>评论</option></select></label><label>文字<select id="xiaozhiScript"><option value="auto" ${settings.script==='auto'?'selected':''}>自动跟随</option><option value="simplified" ${settings.script==='simplified'?'selected':''}>简体中文</option><option value="traditional" ${settings.script==='traditional'?'selected':''}>繁体中文</option></select></label><label>知识范围<select id="xiaozhiScope">${scopeOptions}</select></label>${documentField}${batchField}<label class="switch-label"><input type="checkbox" id="xiaozhiContext" ${settings.contextEnabled?'checked':''}><span>连续上下文</span></label></div><div class="muted xiaozhi-scope-note">${backendNote}</div></div><div class="panel xiaozhi-chat"><div class="xiaozhi-messages" id="xiaozhiMessages">${messages}</div><div class="xiaozhi-composer"><textarea id="xiaozhiInput" rows="3" placeholder="例如：参加志愿者活动要收费吗？&#10;Enter 发送，Shift + Enter 换行"></textarea><button class="btn" id="xiaozhiSend" ${isBusy?'disabled':''}>${isBusy?'小智处理中…':'发送测试'}</button></div><div class="muted xiaozhi-footnote">测试会话编号：${esc(state.xiaozhiSession?.id||'—')} · ${esc(backendNote)} · 测试内容不会写入真实消息列表或创建 Agent 任务</div></div></section>`;
  const syncSettings=()=>{
    const documentValue=xiaozhiSelectedValue('#xiaozhiDocument','');
    const separator=documentValue.lastIndexOf(':');
    const selectedDocumentId=separator>0?decodeURIComponent(documentValue.slice(0,separator)):null;
    const selectedDocumentVersion=separator>0?(Number(documentValue.slice(separator+1))||1):null;
    state.xiaozhiSettings={platformCode:state.xiaozhiSettings.platformCode||'douyin',messageType:xiaozhiSelectedValue('#xiaozhiType','PRIVATE_MESSAGE'),script:xiaozhiSelectedValue('#xiaozhiScript','auto'),scope:xiaozhiSelectedValue('#xiaozhiScope',isRag?'pre_release':'published'),importBatchId:Number(xiaozhiSelectedValue('#xiaozhiBatch',''))||null,selectedDocumentId,selectedDocumentVersion,contextEnabled:Boolean($('#xiaozhiContext')?.checked)};
  };
  $('#xiaozhiScope').onchange=event=>{const scope=event.target.value;if(scope==='published'){const document=$('#xiaozhiDocument');if(document)document.value=''}syncSettings();renderXiaozhi().catch(error=>toast(error.message,true))};
  ['#xiaozhiType','#xiaozhiScript','#xiaozhiBatch','#xiaozhiContext'].forEach(selector=>{const element=$(selector);if(element)element.onchange=syncSettings});
  const documentSelect=$('#xiaozhiDocument');if(documentSelect)documentSelect.onchange=()=>{syncSettings();renderXiaozhi().catch(error=>toast(error.message,true))};
  const send=async()=>{const input=$('#xiaozhiInput');const content=input.value.trim();if(!content)return toast('请输入要测试的问题',true);if(state.xiaozhiChat.some(item=>item.role==='assistant'&&['thinking','typing'].includes(item.status)))return toast('小智正在处理上一条消息，请稍候',true);syncSettings();if(isRag&&state.xiaozhiSettings.scope!=='published'&&!state.xiaozhiSettings.selectedDocumentId)return toast('请先选择一个待测试文档',true);const requestSettings={...state.xiaozhiSettings};const messageId=`xiaozhi-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;const assistantId=`${messageId}-assistant`;state.xiaozhiChat.push({id:`${messageId}-user`,role:'user',text:content},{id:assistantId,role:'assistant',status:'thinking',displayText:'',result:null});input.value='';await renderXiaozhi();try{const result=await api('/api/xiaozhi/chat',{method:'POST',body:JSON.stringify({sessionId:state.xiaozhiSession?.id,content,...requestSettings})});state.xiaozhiSession=result.session;const item=state.xiaozhiChat.find(entry=>entry.id===assistantId);if(!item)return;item.result=result;item.status='typing';item.displayText='';await renderXiaozhi();await typeXiaozhiReply(assistantId,result.replyText)}catch(error){const item=state.xiaozhiChat.find(entry=>entry.id===assistantId);if(!item)return;item.result={replyText:`测试失败：${error.message}`,decision:'TECHNICAL_ERROR',confidence:0,reason:error.detail||error.message,elapsedMs:0,matches:[]};item.status='typing';item.displayText='';await renderXiaozhi();await typeXiaozhiReply(assistantId,item.result.replyText);toast(error.message,true)}};
  $('#xiaozhiSend').onclick=send;$('#xiaozhiInput').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}};
  const publishButton=$('#xiaozhiPublish');if(publishButton)publishButton.onclick=async()=>{if(!canPublish)return toast('请先选择待测文档并完成至少一轮小智测试',true);if(!(await xiaozhiPublishConfirmDialog()))return;publishButton.disabled=true;publishButton.textContent='正在提交发布…';try{const response=await api('/api/rag/releases',{method:'POST',body:JSON.stringify({testSessionId:state.xiaozhiSession.ragTestSessionId,candidateDocuments:publishCandidates,publishNote:`运营人员于 ${new Date().toLocaleString()} 从小智测试页发布`})});const release=response.release||{};state.ragCurrentDocumentId=settings.selectedDocumentId;state.ragCurrentDocumentVersion=Number(settings.selectedDocumentVersion)||1;state.xiaozhiOptions=null;toast(`发布版本 ${release.releaseId||'已创建'} 正在构建，构建完成后自动成为正式版本`);navigate('knowledge','rag')}catch(error){toast(error.message||'发布失败',true);publishButton.disabled=false;publishButton.textContent='发布为正式版本'}};  $('#xiaozhiNew').onclick=async()=>{syncSettings();if(state.xiaozhiSession)try{await api(`/api/xiaozhi/sessions/${state.xiaozhiSession.id}`,{method:'DELETE'})}catch{}state.xiaozhiSession=null;state.xiaozhiChat=[];await ensureXiaozhiSession(true);renderXiaozhi()};
  document.querySelectorAll('.xiaozhi-copy').forEach(button=>button.onclick=async()=>{const item=state.xiaozhiChat[Number(button.dataset.index)];try{await navigator.clipboard.writeText(item?.result?.replyText||'');toast('回复已复制')}catch{toast('复制失败，请手动选择文本',true)}});
  document.querySelectorAll('.xiaozhi-enable,.xiaozhi-disable').forEach(button=>button.onclick=()=>updateXiaozhiDecision(button));
  const messageBox=$('#xiaozhiMessages');if(messageBox)messageBox.scrollTop=messageBox.scrollHeight;
}let refreshTimer=null;
let taskRefreshTimer=null;
let messageRefreshTimer=null;
let messageCountdownTimer=null;
let taskRefreshInFlight=false;
let messageRefreshInFlight=false;
let messageRefreshSignatureValue='';
async function refreshTasksFromTimer(){
  if(state.page!=='tasks'||document.hidden||taskRefreshInFlight||document.querySelector('.confirm-overlay'))return;
  taskRefreshInFlight=true;
  try{await renderTasks()}catch{}finally{taskRefreshInFlight=false}
}
async function refreshMessagesFromTimer(){
  const active=document.activeElement;
  const editing=active&&['INPUT','TEXTAREA','SELECT'].includes(active.tagName)&&$('#content')?.contains(active);
  if(state.page!=='messages'||document.hidden||messageRefreshInFlight||editing||document.querySelector('.confirm-overlay'))return;
  messageRefreshInFlight=true;
  try{
    const data=await api(`/api/messages?t=${Date.now()}`);
    const signature=messageRefreshSignature(data);
    if(signature!==messageRefreshSignatureValue)await renderMessages(data);
  }catch{}finally{messageRefreshInFlight=false}
}
function clearWorkspaceSession(){
  if(state.materialPreviewUrl){try{URL.revokeObjectURL(state.materialPreviewUrl)}catch{}}
  Object.assign(state,{
    page:'dashboard',
    bootstrap:null,
    precheck:null,
    compliance:null,
    knowledgeView:'rag',
    knowledgeCategory:null,
    knowledgeSubcategory:null,
    knowledgeImportPreview:null,
    knowledgeImportStage:'IDLE',
    knowledgeImportFailedStep:null,
    knowledgeCategoryData:null,
    knowledgeImportSelected:[],
    knowledgeImportExpanded:[],
    knowledgeImportDirty:[],
    knowledgeImportFilter:'ALL',
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
  navigate(initialRoute?initialRoute.page:(state.page||'dashboard'),initialRoute?initialRoute.view||null:null);
  if(!refreshTimer)refreshTimer=setInterval(()=>{const page=state.page,pageGeneration=pageRenderGeneration;if(['dashboard','tasks','messages','browser','issues','wecom','platforms'].includes(page)&&pageRenderInFlightGeneration!==pageGeneration)refreshBootstrap({page,pageGeneration}).then(bootstrap=>{if(!bootstrap||state.page!==page||pageRenderGeneration!==pageGeneration)return;if(state.page==='dashboard')refreshDashboardLoginStatus();else if(state.page==='platforms')refreshPlatformLoginStatus();else if(state.page==='issues')renderIssues()}).catch(()=>{})},5000);
  if(!taskRefreshTimer)taskRefreshTimer=setInterval(refreshTasksFromTimer,2000);
  if(!messageRefreshTimer)messageRefreshTimer=setInterval(refreshMessagesFromTimer,3000);
  if(!messageCountdownTimer)messageCountdownTimer=setInterval(updateMessageChannelCountdowns,1000);
  updateMessageChannelCountdowns();
}
async function logoutAdmin(){
  try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch{}
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
    ${copy.mock?`<div class="notice warn"><span class="notice-icon">!</span><div><b>当前为 Mock 演示模式</b><p>未真实分析素材内容，请在「企微及 AI」中启用在线模型后重新生成。</p></div></div>`:''}
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
  if(state.page!=='create')return;
  return renderHotTopicStudio($('#content'),{onUnauthorized:()=>showLoginScreen('登录已过期，请重新登录'),onPublish:publishContentLibraryItem});
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




