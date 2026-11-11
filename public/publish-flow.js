const element=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item};

export function setupPublishFlow(form){
  if(form.dataset.publishFlow)return;
  const editor=form.querySelector('.publish-main-column > .panel');
  const accounts=form.querySelector('.publish-side-column > .panel');
  const review=form.querySelector('.preview-publish-settings');
  if(!editor||!accounts||!review)return;
  form.dataset.publishFlow='steps';
  form.querySelector(':scope > .preview-page-actions')?.remove();
  const stages=[editor,accounts,review],labels=['编辑内容','选择平台','检查并发布'];
  stages.forEach((stage,index)=>{stage.dataset.publishStage=String(index+1);stage.id=`publishStage${index+1}`;stage.setAttribute('aria-labelledby',`publishStageTitle${index+1}`);const title=stage.querySelector('h2');title.textContent=labels[index];title.id=`publishStageTitle${index+1}`});

  const media=element('div','publish-flow-media'),copy=element('div','publish-flow-copy');
  const title=form.querySelector('#publishTitle'),body=form.querySelector('#publishBody');
  const titleLabel=title.previousElementSibling,bodyLabel=body.previousElementSibling;
  titleLabel.htmlFor=title.id;bodyLabel.htmlFor=body.id;
  for(const selector of ['.library-publish-actions','#materialFile','#materialPreview','.preview-local-path']){const item=editor.querySelector(selector);if(item)media.append(item)}
  copy.append(titleLabel,title,bodyLabel,body);
  for(const selector of ['.audio-copy-actions','#audioCopyBox','#contentOriginCard']){const item=form.querySelector(selector);if(item)copy.append(item)}
  const fields=element('div','publish-flow-fields');fields.append(media,copy);editor.append(fields);
  const origin=copy.querySelector('#contentOriginCard');origin.classList.add('publish-flow-origin');

  const notes=accounts.querySelector('.preview-details');
  const blocked=[...accounts.querySelectorAll('.publish-platform-card.is-blocked')];
  const available=[...accounts.querySelectorAll('.publish-platform-card.is-runnable')];
  const accountGrid=element('div','publish-flow-accounts');for(const card of available)accountGrid.append(card);
  accounts.querySelector('.panel-head').after(accountGrid);
  if(!available.length)accountGrid.append(element('p','muted','暂无可发布的账号，请先检查平台状态。'));
  if(notes){for(const card of blocked)notes.append(card);notes.querySelector('summary').textContent=blocked.length?`不可用账号与说明（${blocked.length}）`:'平台说明'}
  else if(blocked.length){const details=element('details','preview-details'),summary=element('summary','',`不可用账号（${blocked.length}）`);details.append(summary,...blocked);accounts.append(details)}

  const summary=element('div','publish-flow-summary');
  const values={};
  for(const [key,label] of [['title','发布标题'],['accounts','发布账号'],['mode','提交方式']]){const row=element('div','');row.append(element('span','',label));values[key]=element('strong','');row.append(values[key]);summary.append(row)}
  review.querySelector('.preview-page-actions').after(summary);

  const nav=element('nav','publish-flow-nav');nav.setAttribute('aria-label','发布步骤');
  const list=element('ol','');
  const buttons=labels.map((label,index)=>{const item=element('li',''),button=element('button','publish-flow-step');button.type='button';button.dataset.publishGoto=String(index+1);button.setAttribute('aria-controls',`publishStage${index+1}`);button.append(element('span','publish-flow-number',String(index+1)),element('span','',label));item.append(button);list.append(item);return button});
  nav.append(list);form.prepend(nav);
  const footer=element('div','publish-flow-footer'),navigation=element('div','publish-flow-navigation');
  const back=element('button','btn secondary','上一步'),next=element('button','btn','下一步：选择平台');back.type=next.type='button';back.dataset.publishBack='';next.dataset.publishNext='';
  const progress=element('span','publish-flow-progress');navigation.append(back,progress);
  const error=element('p','publish-flow-error');error.hidden=true;error.setAttribute('role','alert');
  const actions=form.querySelector('.preview-publish-buttons');actions.classList.add('publish-flow-final');
  footer.append(navigation,next,actions);form.querySelector('.publish-grid').after(error,footer);
  const submit=form.querySelector('#publishSubmitButton'),schedule=form.querySelector('#scheduledPublishButton span');
  let step=1;
  const contentFields=['materialPath','publishTitle','publishBody','contentOrigin'].map(id=>form.querySelector('#'+id));
  const chosen=()=>[...form.querySelectorAll('.platform-check:checked:not(:disabled)')];
  const update=()=>{
    const complete=[contentFields.every(field=>field.validity.valid),chosen().length>0,false];
    buttons.forEach((button,index)=>{button.classList.toggle('is-active',step===index+1);button.classList.toggle('is-complete',complete[index]);if(step===index+1)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current')});
    values.title.textContent=title.value.trim()||'未填写标题';
    values.accounts.textContent=chosen().map(check=>check.closest('label').querySelector('.publish-platform-title b')?.textContent.trim()).filter(Boolean).join('、')||'未选择账号';
    const automatic=form.querySelector('#autoPublish').checked;
    values.mode.textContent=automatic?'自动提交到平台':'创建草稿任务';
    submit.textContent=automatic?'确认发布':'创建草稿任务';schedule.textContent=automatic?'定时发布':'定时创建草稿';
  };
  const show=(value,focus=false)=>{
    step=value;form.dataset.publishStep=String(step);error.hidden=true;
    stages.forEach((stage,index)=>stage.hidden=step!==index+1);
    form.querySelector('.publish-main-column').hidden=step!==1;form.querySelector('.publish-side-column').hidden=step===1;
    back.disabled=step===1;next.hidden=step===3;actions.hidden=step!==3;
    next.textContent=step===1?'下一步：选择平台':'下一步：检查并发布';progress.textContent=`第 ${step} 步，共 3 步`;
    update();
    if(focus){nav.scrollIntoView({block:'start',behavior:'auto'});buttons[step-1].focus({preventScroll:true})}
  };
  const advance=()=>{
    if(step===1){
      const invalid=contentFields.find(field=>!field.validity.valid);
      if(invalid){error.textContent=invalid.id==='materialPath'?'请先选择图片或视频。':'请先填写标题、正文和内容来源。';error.hidden=false;if(invalid.id==='materialPath')form.querySelector('#materialPreview').focus();else invalid.reportValidity();return}
    }
    if(step===2&&!chosen().length){error.textContent='请至少选择一个可发布的账号。';error.hidden=false;return}
    show(Math.min(3,step+1),true);
  };
  buttons.forEach((button,index)=>button.onclick=()=>show(index+1,true));
  back.onclick=()=>show(Math.max(1,step-1),true);next.onclick=advance;
  form.addEventListener('input',()=>{error.hidden=true;update()});form.addEventListener('change',()=>{error.hidden=true;update()});
  form.addEventListener('invalid',event=>{const stage=event.target.closest('[data-publish-stage]');if(stage)show(Number(stage.dataset.publishStage));for(let parent=event.target.parentElement;parent&&parent!==form;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true},true);
  form.addEventListener('submit',event=>{if(step!==3){event.preventDefault();event.stopImmediatePropagation();advance()}},true);
  show(1);
}
