import { setupPublishFlow } from './publish-flow.js?v=20261110-publish-steps';
const node=(tag,className,text)=>{const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element};
function fold(title,items){const details=node('details','preview-details');details.append(node('summary','',title));for(const item of items.filter(Boolean))details.append(item);return details}
function heading(title){const header=node('div','preview-page-actions');header.append(node('h2','',title));return header}
function panel(title){const element=node('section','panel');element.append(heading(title));return element}
function move(root,selector,parent){const element=root.querySelector(selector);if(element)parent.append(element);return element}
function routeButton(label,key,onNavigate){const button=node('button','btn secondary',label);button.type='button';button.onclick=()=>onNavigate(key);return button}
function dashboard(root,{data,stats,onNavigate}){
  const area=root.querySelector('.operations-dashboard');if(!area||area.dataset.previewLayout)return;
  area.dataset.previewLayout='dashboard';
  area.querySelector('.operations-overview-head h2').textContent='运营数据';
  const counts=node('div','preview-stats');
  const published=data.published;
  const values=[['已发布',published?.status==='READY'?published.value:null,'当前统计周期','publish-tasks'],['AI 已回复',stats.autoReplies,'已完成回复','comments'],['待人工处理',stats.manualRequired,'需要人工处理的消息','comments']];
  for(const [label,value,note,key] of values){if(value===null||value===undefined)continue;const card=node('button','preview-stat');card.type='button';card.append(node('span','',label),node('strong','',Number(value).toLocaleString('zh-CN')),node('small','',note));card.onclick=()=>onNavigate(key);counts.append(card)}
  area.querySelector('.operations-overview-head').after(counts);
  const row=node('div','preview-dashboard-columns');
  const channels=area.querySelector('.operations-channel-panel');
  const channelTitle=channels?.querySelector('h2');if(channelTitle)channelTitle.textContent='发布分布';
  if(channels)row.append(channels);
  const suggestions=area.querySelector('.operations-ai-panel');if(suggestions){suggestions.classList.add('preview-todo');const title=suggestions.querySelector('h2');if(title)title.textContent='待办';row.append(suggestions)}
  area.querySelector('.operations-analytics-panel')?.after(row);
  const content=area.querySelector('.operations-content-panel');if(content){content.querySelector('h2').textContent='最近发布';area.append(content)}
  const extra=fold('更多分析',[area.querySelector('.operations-trend-panel'),area.querySelector('.operations-funnel-panel')]);
  area.querySelector('.operations-analysis-grid')?.remove();area.querySelector('.operations-detail-grid')?.remove();area.append(extra);
  const runtime=root.querySelector('.dashboard-runtime-overview');if(runtime){const holder=fold('设备与登录状态',[runtime]);area.after(holder)}
  const runtimeMetrics=root.querySelector('.metric-grid');if(runtimeMetrics){area.append(fold('回复与调用统计',[runtimeMetrics]));}
  const runtimePanels=[...root.querySelectorAll('.dashboard-layout,.dashboard-bottom')].filter(element=>!element.closest('.preview-details'));
  if(runtimePanels.length)area.after(fold('运行详情',runtimePanels));
  root.querySelectorAll(':scope > .section-title').forEach(element=>element.remove());
  area.querySelectorAll('.operations-channel-row').forEach(row=>{const text=row.querySelector(':scope > span');if(text)text.textContent=text.textContent.split(' / ')[0]});
  area.querySelector('.operations-channel-summary > div:last-child')?.remove();
  const table=area.querySelector('.operations-content-table');if(table){for(const row of table.rows){if(row.cells.length===4){row.cells[2].remove();row.cells[1].remove()}else if(row.cells[0]?.colSpan===4)row.cells[0].colSpan=2}}
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
