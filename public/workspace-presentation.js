import { setupPublishFlow } from './publish-flow.js?v=20261110-publish-steps';
import { PLATFORM_BRANDS, platformLogo } from './platform-icons.js?v=20261111-v2';
import { mountAiOrb } from './ai-orb.js?v=20261112-refresh';
const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element};
function fold(title,items){const details=node('details','preview-details');details.append(node('summary','',title));for(const item of items.filter(Boolean))details.append(item);return details}
function heading(title){const header=node('div','preview-page-actions');header.append(node('h2','',title));return header}
function panel(title){const element=node('section','panel');element.append(heading(title));return element}
function move(root,selector,parent){const element=root.querySelector(selector);if(element)parent.append(element);return element}
function routeButton(label,key,onNavigate){const button=node('button','btn secondary',label);button.type='button';button.onclick=()=>onNavigate(key);return button}
const fmtNumber=value=>Number(value||0).toLocaleString('zh-CN');
function greeting(){const h=new Date().getHours();return h<6?'夜深了':h<12?'上午好':h<14?'中午好':h<18?'下午好':'晚上好'}
function shortTime(value){const d=new Date(value);if(Number.isNaN(d.getTime()))return '';const p=n=>String(n).padStart(2,'0');return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`}
function accountState(account){
  if(!account)return {ok:false,label:'未配置',tone:'muted'};
  if(!Number(account.enabled))return {ok:false,label:'已停用',tone:'muted'};
  if(String(account.platform_effective_state||'').toUpperCase()==='STOPPED')return {ok:false,label:'已暂停',tone:'muted'};
  if(String(account.login_status||'').toUpperCase()==='READY')return {ok:true,label:'在线',tone:'ok'};
  return {ok:false,label:'需要登录',tone:'warn'};
}
function sparkline(values){
  if(!values.length||values.every(v=>!v))return '';
  const w=300,h=34,max=Math.max(...values)*1.15||1;
  const pts=values.map((v,i)=>[i/(values.length-1||1)*w,h-v/max*h]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');const last=pts.at(-1);
  return `<svg class="v2-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="v2-spark-area" d="${d} L${w} ${h} L0 ${h}Z"/><path class="v2-spark-line" d="${d}"/><circle class="v2-spark-dot" cx="${last[0]}" cy="${last[1]}" r="3"/></svg>`;
}
function dailyCounts(items,days){
  const counts=Array(days).fill(0);const start=new Date();start.setHours(0,0,0,0);
  for(const item of items){const t=new Date(item.publishedAt);if(Number.isNaN(t.getTime()))continue;const diff=Math.floor((start-new Date(t.getFullYear(),t.getMonth(),t.getDate()))/864e5);if(diff>=0&&diff<days)counts[days-1-diff]+=1}
  return counts;
}
const ACTION_ICONS={
  message:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  issue:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/></svg>',
  publish:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>'
};
export function refreshDashboardOrb(root,{stats={},accounts=[]}){
  const canvas=root.querySelector('.v2-orb');
  const platforms=['douyin','wechat_channels','bilibili','weibo','xiaohongshu'].map(code=>({code,ok:accountState(accounts.find(account=>account.platform_code===code)).ok}));
  mountAiOrb(canvas,{platforms,centerValue:fmtNumber(stats.autoReplies),centerLabel:'AI 已回复'});
}
function dashboard(root,{data,stats={},accounts=[],localAgent={},onNavigate}){
  const area=root.querySelector('.operations-dashboard');if(!area||area.dataset.previewLayout)return;
  area.dataset.previewLayout='dashboard';
  area.classList.add('v2-dashboard');
  const head=area.querySelector('.operations-overview-head');
  const manual=Number(stats.manualRequired||0),issues=Number(stats.openIssues||0),queued=Number(stats.queuedTasks||0),autoReplies=Number(stats.autoReplies||0);
  const todo=manual+issues+queued;
  /* 1. 问候与今天要处理的事 */
  const title=head.querySelector('h2');title.textContent=todo?`${greeting()}，今天有 ${todo} 件事等你处理`:`${greeting()}，今天没有待处理的事`;
  const scope=head.querySelector('p');if(scope){scope.classList.add('v2-scope');scope.insertAdjacentText('afterbegin',`AI 已自动回复 ${fmtNumber(autoReplies)} 条。`)}
  const actions=node('div','v2-actions');
  for(const [count,label,key,icon,tone,cta] of [[manual,'条消息需人工回复','comments','message','warn','去处理'],[issues,'个运行问题待处理','diagnostics','issue','danger','查看'],[queued,'个发布任务排队中','publish-tasks','publish','acc','查看']]){
    const card=node('button',`v2-action v2-tone-${count?tone:'idle'}`);card.type='button';card.dataset.v2Action=key;card.dataset.refreshKey=key;
    const ic=node('span','v2-action-icon');ic.innerHTML=ACTION_ICONS[icon];
    const copy=node('span','v2-action-copy');copy.append(node('b','v2-num',fmtNumber(count)),node('span','',label));
    card.append(ic,copy,node('span',`v2-chip ${count?'v2-chip-primary':''}`,count?cta:'已清空'));
    card.onclick=()=>onNavigate(key);actions.append(card);
  }
  head.after(actions);
  /* 2. AI 员工 + 指标 */
  const mid=node('div','v2-mid');
  const ai=node('section','v2-card v2-ai-card');
  const canvas=node('canvas','v2-orb');canvas.width=400;canvas.height=400;canvas.setAttribute('aria-label','AI 员工运行示意');
  const list=node('div','v2-ai-body');
  const order=['douyin','wechat_channels','bilibili','weibo','xiaohongshu'];
  const rows=order.map(code=>({code,account:accounts.find(a=>a.platform_code===code)})).map(item=>({...item,state:accountState(item.account)}));
  const online=rows.filter(item=>item.state.ok).length;
  const agentOnline=localAgent.online===true;
  const header=node('h3','v2-card-title','AI 数字员工');
  header.append(node('span',`v2-pill v2-pill-${agentOnline?'ok':'warn'}`,agentOnline?'采集服务在线':'采集服务未连接'));
  list.append(header);
  const agents=node('div','v2-agents');
  for(const item of rows){
    const row=node('button','v2-agent');row.dataset.refreshKey=item.code;row.type='button';row.onclick=()=>onNavigate('accounts');
    row.innerHTML=`${platformLogo(item.code,26)}<span class="v2-agent-name"></span><span class="v2-pill v2-pill-${item.state.tone}"></span>`;
    row.querySelector('.v2-agent-name').textContent=item.account?.display_name||PLATFORM_BRANDS[item.code].name;
    row.querySelector('.v2-pill').textContent=item.state.label;
    agents.append(row);
  }
  list.append(agents,node('p','v2-note',`${online} 个平台账号已登录；登录与启停在“平台账号”中管理。`));
  ai.append(canvas,list);
  const kpis=node('div','v2-kpis');
  const published=data.published?.status==='READY'?Number(data.published.value):null;
  const aiCalls=stats.aiUsageToday?.calls;
  for(const [label,value,note,key,spark] of [
    ['已发布',published,data.published?.scope||'本周期','publish-tasks',sparkline(dailyCounts(data.content,7))],
    ['AI 已回复',autoReplies,'自动回复完成','comments',''],
    ['待人工处理',manual,'需要人工接手','comments',''],
    ['今日 AI 调用',aiCalls,`成功 ${fmtNumber(stats.aiUsageToday?.successes)} 次`,'usage','']
  ]){
    if(value===null||value===undefined)continue;
    const card=node('button','v2-kpi preview-stat');card.dataset.refreshKey=label;card.type='button';card.onclick=()=>onNavigate(key);
    card.append(node('span','v2-kpi-label',label));
    const v=node('strong','v2-num',fmtNumber(value));card.append(v,node('small','',note));
    if(spark)card.insertAdjacentHTML('beforeend',spark);
    kpis.append(card);
  }
  mid.append(ai,kpis);
  actions.after(mid);
  refreshDashboardOrb(root,{stats,accounts});
  /* 3. 发布分布 + 最近发布 */
  const bottom=node('div','v2-bottom');
  const dist=node('section','v2-card v2-dist');dist.append(node('h3','v2-card-title','发布分布'));
  const channels=data.channels.length?data.channels:order.map(code=>({code,name:PLATFORM_BRANDS[code].name,published:0}));
  const max=Math.max(...channels.map(c=>Number(c.published)||0),1);
  for(const c of channels){
    const row=node('div','v2-bar');row.dataset.refreshKey=c.code;const n=Number(c.published)||0;
    row.innerHTML=`${platformLogo(c.code,22)}<span class="v2-bar-name"></span><i><b style="width:${(n/max*100).toFixed(1)}%"></b></i><em class="v2-num">${n?n+' 条':'—'}</em>`;
    row.querySelector('.v2-bar-name').textContent=c.name;dist.append(row);
  }
  const recent=node('section','v2-card v2-recent');
  const rt=node('h3','v2-card-title','最近发布');const all=node('button','v2-link','全部记录');all.type='button';all.onclick=()=>onNavigate('publish-tasks');rt.append(all);recent.append(rt);
  if(data.content.length){
    for(const item of data.content.slice(0,5)){
      const row=node('div','v2-recent-row');row.dataset.refreshKey=String(item.id||item.platformCode+'|'+item.publishedAt+'|'+item.title);
      row.innerHTML=`${platformLogo(item.platformCode,30)}<span class="v2-recent-copy"><b></b><small><span></span><span class="v2-num"></span></small></span><span class="v2-pill v2-pill-ok"></span>`;
      row.querySelector('b').textContent=item.title||'未命名内容';
      const meta=row.querySelectorAll('small span');meta[0].textContent=item.platformName||'';meta[1].textContent=shortTime(item.publishedAt);
      row.querySelector('.v2-pill').textContent=item.statusLabel||'已发布';
      recent.append(row);
    }
  }else recent.append(node('p','v2-empty','当前筛选条件下暂无已发布内容。去“发布管理”创建第一条内容。'));
  bottom.append(dist,recent);
  /* 4. 平台运营数据保持原样；其余原分析面板收进“更多分析” */
  const analytics=area.querySelector('.operations-analytics-panel');
  mid.after(bottom);
  if(analytics)bottom.after(analytics);
  const extra=fold('更多分析',[area.querySelector('.operations-trend-panel'),area.querySelector('.operations-channel-panel'),area.querySelector('.operations-content-panel'),area.querySelector('.operations-funnel-panel'),area.querySelector('.operations-ai-panel')]);
  area.querySelector('.operations-analysis-grid')?.remove();area.querySelector('.operations-detail-grid')?.remove();area.append(extra);
  const runtime=root.querySelector('.dashboard-runtime-overview');if(runtime){const holder=fold('设备与登录状态',[runtime]);area.after(holder)}
  const runtimeMetrics=root.querySelector('.metric-grid');if(runtimeMetrics){area.append(fold('回复与调用统计',[runtimeMetrics]));}
  const runtimePanels=[...root.querySelectorAll('.dashboard-layout,.dashboard-bottom')].filter(element=>!element.closest('.preview-details'));
  if(runtimePanels.length)area.after(fold('运行详情',runtimePanels));
  root.querySelectorAll(':scope > .section-title').forEach(element=>element.remove());
}
function publishing(root,{view,onNavigate}){
  const form=root.querySelector('#publishForm');if(!form)return;
  if(!form.dataset.previewLayout){
    form.dataset.previewLayout='publish';
    form.prepend(heading('新建发布'));
    const main=form.querySelector('.publish-main-column > .panel');
    const side=form.querySelector('.publish-side-column');
    const settings=panel('发布设置');settings.classList.add('preview-publish-settings');
    for(const selector of ['#contentOriginCard','#precheckBox','.publish-review-actions','#complianceBox','#warningConfirmed','#autoPublish','#scheduledPublishButton','#publishSubmitButton']){
      const element=form.querySelector(selector);if(!element)continue;
      settings.append(['warningConfirmed','autoPublish'].includes(element.id)?element.closest('label'):element);
    }
    side.append(settings);
    const preview=main.querySelector('#materialPreview');if(preview){const placeholder=preview.querySelector('b');if(placeholder)placeholder.textContent='选择图片或视频';const path=main.querySelector('.local-material-path-field');if(path){const details=fold('填写本机路径',[path]);details.classList.add('preview-local-path');preview.after(details)}}
    const body=main.querySelector('#publishBody');const copy=main.querySelector('.audio-copy-actions');if(body&&copy)body.after(copy);
    const ai=main.querySelector('#audioCopyBox');if(ai)main.append(ai);
    const platform=side.querySelector('.panel');const notes=[...platform.querySelectorAll(':scope > .notice')];if(notes.length)platform.append(fold('平台要求与不可用原因',notes));
    const actions=node('div','preview-publish-buttons');move(settings,'#scheduledPublishButton',actions);move(settings,'#publishSubmitButton',actions);settings.append(actions);
    const submit=settings.querySelector('#publishSubmitButton');if(submit)submit.textContent='发布';
    const scheduled=settings.querySelector('#scheduledPublishButton span');if(scheduled)scheduled.textContent='定时发布';
    const records=form.querySelector('.publish-records-zone');
    if(records){const title=records.querySelector('h2');if(title)title.textContent='发布排期与记录';const create=routeButton('新建发布','publishing',onNavigate);records.querySelector('.publish-records-overview')?.append(create)}
  }
  form.dataset.presentation=view||'content';
  setupPublishFlow(form);
  enhancePublishPreview(form);
}
/* 发布页：平台卡片换官方图标；右侧手机预览实时跟随标题、正文、素材和所选平台。只读表单，不改提交逻辑。 */
function enhancePublishPreview(form){
  if(form.dataset.v2Preview)return;
  const grid=form.querySelector('.publish-grid');if(!grid)return;
  form.dataset.v2Preview='phone';
  for(const card of form.querySelectorAll('.publish-platform-card')){
    const code=card.querySelector('.platform-check')?.dataset.platform;
    if(code&&!card.querySelector('.v2-logo'))card.querySelector('.publish-platform-title')?.insertAdjacentHTML('afterbegin',platformLogo(code,28));
  }
  const phone=node('aside','v2-phone');phone.setAttribute('aria-label','发布效果预览');
  const tabs=node('div','v2-phone-tabs');
  const screen=node('div','v2-phone-screen');
  const media=node('div','v2-phone-media');
  const cap=node('div','v2-phone-caption');const handle=node('b','', '@'+(form.querySelector('.publish-platform-card .publish-platform-title b')?.textContent.split('·').pop().trim()||'运营账号'));
  const text=node('p','');const empty=node('p','v2-phone-hint','填写标题和正文后，这里显示发布效果。');
  cap.append(handle,text);screen.append(media,cap);
  phone.append(node('div','v2-phone-label','发布预览'),tabs,screen,empty);
  grid.append(phone);
  const title=form.querySelector('#publishTitle'),body=form.querySelector('#publishBody'),preview=form.querySelector('#materialPreview');
  let current=null;
  const update=()=>{
    const chosen=[...form.querySelectorAll('.platform-check:checked:not(:disabled)')].map(c=>c.dataset.platform);
    const codes=[...new Set(chosen)];
    if(!codes.includes(current))current=codes[0]||null;
    tabs.replaceChildren();
    for(const code of codes){const b=node('button',`v2-phone-tab ${code===current?'active':''}`);b.type='button';b.innerHTML=platformLogo(code,18);b.append(node('span','',PLATFORM_BRANDS[code]?.name||code));b.onclick=()=>{current=code;update()};tabs.append(b)}
    if(!codes.length)tabs.append(node('span','v2-phone-tabs-empty','未选择平台'));
    const t=title?.value.trim()||'',d=body?.value.trim()||'';
    text.replaceChildren();if(t)text.append(node('strong','',t));if(d)text.append(node('span','',d));
    empty.hidden=Boolean(t||d);cap.hidden=!(t||d);
    const source=preview?.querySelector('img,video');
    media.replaceChildren();
    if(source){const copy=node(source.tagName.toLowerCase(),'');copy.src=source.currentSrc||source.src;if(copy.tagName==='VIDEO'){copy.muted=true;copy.playsInline=true;copy.loop=true;copy.autoplay=true}media.append(copy);media.classList.remove('is-empty')}
    else{media.classList.add('is-empty');media.append(node('span','','素材预览'))}
  };
  form.addEventListener('input',update);form.addEventListener('change',update);
  if(preview)new MutationObserver(update).observe(preview,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  update();
}
function knowledge(root,{view,onNavigate}){
  // The file manager owns its complete upload/list layout.
}
function settings(root,{view,onNavigate}){
  const frame=root.querySelector('[data-settings-config-frame]');if(!frame)return;
  if(!frame.dataset.previewLayout){
    frame.dataset.previewLayout='settings';
    root.querySelector('.settings-page-head')?.remove();
    const strip=frame.querySelector('.settings-config-strip');if(strip)frame.append(fold('其他配置入口',[strip]));
    for(const id of ['aiSettingsDrawer','wecomSettingsDrawer']){
      const drawer=root.querySelector('#'+id);if(!drawer)continue;
      const status=drawer.querySelector('.settings-status-card');if(status){status.classList.add('preview-config-status');}
      const form=drawer.querySelector('form');if(form){
        const advanced=[];
        for(const label of form.querySelectorAll(':scope > label'))if(['updatedBy','visionModel'].some(name=>label.querySelector(`[name="${name}"]`)))advanced.push(label);
        for(const element of form.querySelectorAll(':scope > .settings-mini-card,:scope > .ai-mode-card'))advanced.push(element);
        if(advanced.length){const details=fold('高级配置',advanced);details.classList.add('full');form.append(details)}
      }
    }
    const aiDrawer=root.querySelector('#aiSettingsDrawer');
    const aiForm=aiDrawer?.querySelector('form');
    if(aiForm){
      aiForm.classList.add('preview-ai-config');
      const main=panel('模型配置'),side=panel('服务状态');
      main.classList.add('preview-ai-main');side.classList.add('preview-ai-side');
      const actions=aiForm.querySelector('.settings-form-actions');
      const status=aiDrawer.querySelector('.settings-status-card');if(status)side.append(status);
      for(const child of [...aiForm.children]){if(child===actions)continue;(child.tagName==='DETAILS'?side:main).append(child)}
      side.append(routeButton('调用记录','usage',onNavigate));
      aiForm.append(main,side);if(actions)aiForm.append(actions);
      aiDrawer.querySelector('.settings-drawer-heading')?.remove();
    }
    const usage=root.querySelector('.ai-usage-panel');if(usage){const visuals=usage.querySelector('.ai-usage-visual-grid');if(visuals)usage.append(fold('费用与调用趋势',[visuals]));}
  }
  root.dataset.presentation=view||'ai';
  const ai=root.querySelector('#aiSettingsDrawer'),wecom=root.querySelector('#wecomSettingsDrawer');
  if(ai)ai.hidden=view==='notifications'||view==='usage';if(wecom)wecom.hidden=view!=='notifications';
  frame.classList.add('is-expanded');
}
export function applyWorkspacePresentation(root,context){
  const {page}=context;
  if(page==='dashboard')dashboard(root,context);
  if(page==='publish')publishing(root,context);
  if(page==='knowledge')knowledge(root,context);
  if(page==='wecom')settings(root,context);
}
