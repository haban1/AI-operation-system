import { issueAccountPresentation } from './issue-account-identity.js?v=20261117';

const labels = {
  OPEN:'待处理', DIAGNOSING:'正在排查', DIAGNOSED:'已排查', RETRYING:'正在重试', RESOLVED:'已解决', FALSE_POSITIVE:'已确认误报',
  LOGIN_MONITOR:'登录监测', ACCOUNT_LOGIN:'账号登录', PUBLISH_GUARD:'发布保护', PUBLISH_PLATFORM_ISOLATION:'发布结果核对',
  PLATFORM_REVIEW:'平台审核', PUBLISH_REVIEW:'作品审核', RPA:'浏览器自动操作', SYSTEM:'系统', QWEN:'千问', WECOM:'企业微信',
  PUBLISH:'内容发布', REPLY:'消息回复', MESSAGE_COLLECTION:'消息采集', MODEL_API:'模型调用', NOTIFICATION:'消息通知',
  MANUAL_REPLY_DETECTION:'人工回复检测', BUSINESS:'业务处理', UNCERTAIN_BUSINESS:'业务结果待确认',
  ACCOUNT:'账号', PLATFORM:'平台', PLATFORM_FEATURE:'平台功能', FEATURE:'功能', TASK:'任务', JOB:'执行任务', PUBLISH_TARGET:'发布目标', MESSAGE:'消息', GLOBAL:'全局',
  SYNCING:'同步中', UNKNOWN:'尚未确认', PUBLISHED:'已发布', REVIEWING:'审核中', REJECTED:'审核未通过', FAILED:'失败',
  VERIFY_RESULT_PROVENANCE:'核对复核结果来源', VERIFY_REQUEST_IDENTITY:'核对复核请求', PUBLISH_REQUEST_IDENTITY:'核对发布请求', PUBLISH_RESULT_PROVENANCE:'核对发布结果来源'
};
const platforms = {wechat_channels:'视频号',douyin:'抖音',bilibili:'B站',weibo:'微博',xiaohongshu:'小红书'};
const reasons = {
  REVIEW_STATUS_EVIDENCE_MISMATCH:'返回的审核状态与作品管理页的记录不一致',
  PLATFORM_CODE_MISMATCH:'请求的平台与发布目标不一致', RESULT_PLATFORM_MISMATCH:'结果来自其他平台',
  TASK_ID_MISMATCH:'请求的任务与发布目标不一致', ACCOUNT_ID_MISMATCH:'请求的账号与发布目标不一致',
  REQUEST_VERIFICATION_POLICY_MISMATCH:'请求使用的核对规则与目标平台不一致', VERIFICATION_POLICY_MISMATCH:'结果使用的核对规则与目标平台不一致',
  PLATFORM_URL_SCOPE_MISMATCH:'结果中的链接不属于目标平台', REVIEW_TAB_STATUS_MISMATCH:'作品所在栏目与返回的审核状态不一致'
};
const lookup=(map,key)=>Object.hasOwn(map,key)?map[key]:undefined;
export const issueLabel=(code,fallback)=>lookup(labels,String(code??'').toUpperCase())||lookup(platforms,code)||fallback;

export function issueCopy(issue, accounts) {
  const display=issueAccountPresentation(issue,accounts);
  // Only translate a platform prefix in a generated title; never replace an account ID.
  const loginRecord=issue.source==='LOGIN_MONITOR' && issue.category==='ACCOUNT_LOGIN' && issue.related_type==='ACCOUNT';
  let title=loginRecord?display.title:display.title.replace(/^(wechat_channels|douyin|bilibili|weibo|xiaohongshu)\s+/,(_,code)=>platforms[code]);
  let summary=display.detail, facts=[];
  if(issue.source==='SYSTEM' && issue.category==='MESSAGE_COLLECTION' && title.endsWith('采集结果持久化失败')){
    title=title.replace(/采集结果持久化失败$/, '采集结果未能保存');
    summary=summary.replace(/^采集结果持久化失败/, '采集结果未能保存').replace(/\bexternalId\b/g, '平台消息编号');
  }
  if(issue.category==='PUBLISH_PLATFORM_ISOLATION'){
    let data;try{data=JSON.parse(display.detail)}catch{/* historical payload may be truncated */}
    const v=data?.validation;
    const reason=lookup(reasons,v?.reason)||'系统未能确认这条结果与本次发布任务相符';
    summary=reason+'，系统没有用这条结果更新发布状态。';
    for(const [caption,key] of [['检查环节',data?.phase],['目标平台',v?.expectedPlatformCode],['返回的审核状态',v?.reviewStatus],['作品记录状态',v?.matchedRecordStatus]]){
      if(key)facts.push(caption+'：'+issueLabel(key,'未识别'));
    }
    return {title:(lookup(platforms,v?.expectedPlatformCode)||lookup(platforms,display.title.split(/\s/)[0])||'平台')+'发布状态未更新',summary,facts,original:display.detail};
  }
  if(/Target page, context or browser has been closed/i.test(summary))summary='执行检查时，页面或浏览器已关闭，本次检查未能完成。';
  else if(!summary.trim())summary='没有记录具体原因。';
  else if(/^[\s]*[\[{]/.test(summary)||!/[\u3400-\u9fff]/.test(summary))summary='系统记录了异常，具体信息可在技术详情中查看。';
  return {title,summary,facts,original:summary!==display.detail?display.detail:''};
}
