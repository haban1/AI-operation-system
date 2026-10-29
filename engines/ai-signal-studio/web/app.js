const appURL=path=>new URL(path.replace(/^\/+/,''),document.baseURI).pathname;
const integratedWorkbench=window.parent!==window&&location.pathname.startsWith('/integrations/ai-signal/');
document.documentElement.classList.toggle('system-embedded',integratedWorkbench);
let state=null,selected=null,currentRun=null,spec=null,seenJob='',modelTesting=false,activeBatch=null,connected=false;
const pendingSelections={},feedbackDrafts={};
let feedbackSubmitting=false;
let topicMode=new URLSearchParams(location.search).get('topic')==='custom'?'custom':'trending';
const sampleVersions={};
const $=id=>document.getElementById(id);
const escapeHTML=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v==null?'—':Number(v).toLocaleString('zh-CN');
const titles={topics:'从一个好话题开始。',editor:'回看成片，按需微调。',studio:'三路创作，反馈后定稿。',library:'把好内容，留下来。',settings:'用你熟悉的模型创作。'};
function tab(name){if(!titles[name])return;if(integratedWorkbench&&name==='library'){window.parent.postMessage({type:'content-workbench:open-library',source:'automatic'},location.origin);return}const u=new URL(location);u.searchParams.set('view',name);if(name==='editor'&&currentRun)u.searchParams.set('run',currentRun);else u.searchParams.delete('run');if(name==='studio'&&activeBatch)u.searchParams.set('comparison',activeBatch);else u.searchParams.delete('comparison');history.replaceState(null,'',u);document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.id===name));document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x.dataset.tab===name));$('page-title').textContent=titles[name];window.scrollTo(0,0)}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>tab(b.dataset.tab));
function toast(message){$('toast').textContent=message;$('toast').style.display='block';setTimeout(()=>$('toast').style.display='none',4200)}
async function api(path,body){const response=await fetch(appURL('api/'+path),body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result}
function pick(id){selected=state.feed.candidates.find(x=>x.id===id);if(!selected)return;document.querySelectorAll('.topic-card').forEach(x=>x.classList.toggle('selected',x.dataset.id===id));$('pick-title').textContent=selected.title;$('pick-description').textContent=selected.description;$('pick-metrics').innerHTML=`<div class="metrics"><div><strong>+${fmt(selected.weekly_stars)}</strong><span>本周新增 Star</span></div><div><strong>${fmt(selected.total_stars)}</strong><span>累计 Star</span></div></div>`;$('pick-source').href=selected.url;if(topicMode==='custom')updateTopicPanel();setBusy()}
function generationIssue(){
 if(!connected)return '工作台连接中断，请确认服务已启动后重试。';
 if(state?.config.llm.provider!=='ollama'&&!state?.config.llm.api_key_configured)return '文稿 Token 尚未配置（重启后需重新填写）。请先到模型设置保存。';
 if(state?.config.tts.provider==='openai'&&!state?.config.tts.openai_api_key_configured)return '语音 Token 尚未配置。请填写独立的语音 Token，或改用无需 Token 的 Edge。';
 return '';
}
function setBusy(){
 const busy=state?.job.status==='running',issue=generationIssue();
 const hasTopic=topicMode==='custom'?$('custom-title').value.trim().length>=2:!!selected;
 ['collect','compare','build','render'].forEach(id=>{$(id).disabled=!connected||busy||modelTesting||(id==='render'?!spec:(['compare','build'].includes(id)&&!hasTopic));});
 ['test-model','save-settings','test-voice'].forEach(id=>$(id).disabled=busy||modelTesting);
 $('generation-status').textContent=issue||(busy?'已有任务运行中，研究和创作进度会显示在上方。':hasTopic?'已就绪：可以生成三风格对比，或只生成所选风格。':topicMode==='custom'?'输入至少两个字的选题即可开始。':'先选择一个热点题材。');
 $('configure-model').hidden=!issue||!connected;
 $('configure-model').disabled=busy||modelTesting;
 document.querySelectorAll('[data-retry-comparison],[data-new-exploration],[data-supervise-feedback],[data-reject-all]').forEach(b=>b.disabled=busy||modelTesting||feedbackSubmitting||!connected);
 document.querySelectorAll('[data-select-agent]').forEach(b=>b.disabled=busy||feedbackSubmitting||!connected);
 const save=document.querySelector('[data-save-selection]');if(save)save.disabled=busy||feedbackSubmitting||!connected||save.dataset.changed!=='true';
}
$('configure-model').onclick=()=>tab('settings');
function modelHints(){const p=$('provider').value;$('protocol-help').textContent=p==='responses'?'Responses 接口：服务地址填到 /v1；工作台会调用 /responses。':p==='compatible'?'Chat Completions 接口：服务地址填到 /v1；工作台会调用 /chat/completions。':'连接本机 Ollama 服务，不需要 Token。';const c=state?.config.llm;$('token-status').textContent=p==='ollama'?'本地服务不需要 Token。':(c?.api_key_configured?'已填写 Token。保存同一服务的其他设置时可以留空。':'尚未填写 Token；填写并保存后即可生成文稿。')+' Token仅保存在当前工作台进程内，重启后需重新填写。'}
$('provider').onchange=modelHints;
function drawFeed(){const f=state.feed;$('capture-time').textContent=f.collected_at?'采集于 '+new Date(f.collected_at).toLocaleString('zh-CN')+' · 周新增以 GitHub Trending 页面为准':'暂无采集记录';const labels={ok:'已采集',unavailable:'暂不可用',not_configured:'待接入'};$('source-status').innerHTML=(f.sources||[]).map(s=>`<span title="${escapeHTML(s.detail||'')}" class="source-chip ${s.status}">${escapeHTML(s.source)} · ${labels[s.status]||s.status}</span>`).join('');$('candidates').innerHTML=f.candidates.length?f.candidates.map((c,i)=>`<button class="topic-card" data-id="${escapeHTML(c.id)}"><div class="rank">${String(i+1).padStart(2,'0')}</div><div><div class="topic-title">${escapeHTML(c.title)}</div><div class="topic-owner">${escapeHTML(c.id)}</div><div class="topic-desc">${escapeHTML(c.description)}</div></div><div class="gain">+${fmt(c.weekly_stars)}<small>STARS THIS WEEK</small></div></button>`).join(''):'<div class="empty">还没有候选话题。点击刷新公开热点。</div>';document.querySelectorAll('.topic-card').forEach(b=>b.onclick=()=>pick(b.dataset.id));if(f.candidates.length)pick(f.candidates.some(c=>c.id===selected?.id)?selected.id:f.candidates[0].id);$('discussions').innerHTML=(f.discussions||[]).slice(0,8).map(d=>`<a class="discussion" href="${escapeHTML(d.url)}" target="_blank" rel="noreferrer">${escapeHTML(d.title)} ↗<small>${escapeHTML(d.source)} · ${fmt(d.score)} 分 · 仅作线索</small></a>`).join('')||'<div class="empty">点击刷新后读取可用的社区讨论。</div>'}
function drawRuns(){const libraryRuns=state.runs.filter(r=>$('library-history').checked||!r.comparison_id||r.comparison_selected);$('runs').innerHTML=libraryRuns.length?libraryRuns.map(r=>`<article class="run-card"><div class="run-cover">${r.video?`<img src="${appURL('runs/'+encodeURIComponent(r.id)+'/frames/00.png')}" alt="${escapeHTML(r.title)}">`:'DRAFT / 文稿'}</div><small>${r.comparison_selected?'<b class="library-badge">已选入成片库</b> · ':''}${r.video?'已生成预览':'文稿已生成'} · ${r.duration?Math.round(r.duration)+' 秒':'待配音'}</small><h3>${escapeHTML(r.title)}</h3><p>${escapeHTML(r.status)}</p><button class="primary" data-open="${escapeHTML(r.id)}">${r.video?'播放与详情':'查看未完成内容'} →</button></article>`).join(''):'<div class="empty">还没有入库成片。到对比任务勾选满意的版本，或打开历史版本查看。</div>';document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openRun(b.dataset.open))}
async function openRun(id){try{currentRun=id;const response=await fetch(appURL('runs/'+encodeURIComponent(id)+'/script.json'));if(!response.ok)throw Error('文稿读取失败');spec=await response.json();$('script-title').textContent=spec.title;$('script-meta').textContent=spec.repo+' · '+(state.runs.find(r=>r.id===id)?.status||spec.editorial_status||'待复核')+(spec.review_flags?.length?' · 待检查表述：'+spec.review_flags.join('、'):'');$('scene-editor').innerHTML=spec.scenes.map((s,i)=>`<div class="scene-card"><div class="scene-top"><span>SCENE ${String(i+1).padStart(2,'0')} · ${escapeHTML(s.eyebrow||s.type)}</span><small>${escapeHTML(s.type)} / ${escapeHTML(s.sourceIds?.join(', '))}</small></div><div class="fields"><label>画面标题<input data-i="${i}" data-field="title" value="${escapeHTML(s.title)}"></label><label>重点文字<input data-i="${i}" data-field="highlight" value="${escapeHTML(s.highlight)}" ${s.type==='stats'?'readonly title="数字绑定已采集的来源"':''}></label><label class="full">辅助说明<input data-i="${i}" data-field="body" value="${escapeHTML(s.body)}"></label><label>画面要点（每行一项）<textarea data-i="${i}" data-field="items">${escapeHTML(s.items?.join('\n'))}</textarea></label><label>中文旁白（每行一个短句）<textarea data-i="${i}" data-field="narration">${escapeHTML(s.narration?.join('\n'))}</textarea></label></div></div>`).join('');document.querySelectorAll('[data-field]').forEach(el=>el.oninput=()=>{const k=el.dataset.field;spec.scenes[Number(el.dataset.i)][k]=['items','narration'].includes(k)?el.value.split('\n').filter(x=>x.trim()):el.value});const run=state.runs.find(x=>x.id===id);$('preview').pause();if(run?.video){$('preview').src=run.video;$('preview').classList.remove('hidden');$('preview-empty').classList.add('hidden');$('preview-meta').textContent=`${run.duration?.toFixed(1)||'—'} 秒 · 1080 × 1920 · 中文配音`; }else{$('preview').removeAttribute('src');$('preview').load();$('preview').classList.add('hidden');$('preview-empty').classList.remove('hidden');$('preview-meta').textContent='文稿准备好后，生成视频预览。'}$('source-links').innerHTML=(spec.sources||[]).map(s=>`<a href="${escapeHTML(s.url)}" target="_blank" rel="noreferrer">${escapeHTML(s.title||(s.id==='readme'?'官方资料':s.id==='trending'?'热点证据':s.id))} ↗</a>`).join('');$('optional-editor').open=false;$('research-detail').hidden=true;$('research-detail').innerHTML='';if(spec.research_available){const r=await fetch(appURL('runs/'+encodeURIComponent(id)+'/research.json'));if(r.ok){const report=await r.json();$('research-detail').innerHTML=researchHTML({summary:report.brief?.summary,sources:report.sources,limitations:report.limitations,queries:report.queries});$('research-detail').hidden=false}}tab('editor');setBusy()}catch(e){toast(e.message)}}
async function refresh(initial=false){try{const next=await api('state');connected=true;const comparisonsChanged=!state||JSON.stringify(next.comparisons)!==JSON.stringify(state.comparisons);const feedChanged=!state||next.feed.collected_at!==state.feed.collected_at;const runsChanged=!state||JSON.stringify(next.runs)!==JSON.stringify(state.runs);state=next;if(feedChanged)drawFeed();if(runsChanged)drawRuns();if(comparisonsChanged)drawComparisons();const j=state.job;const job=$('job');job.classList.toggle('hidden',j.status==='idle');job.classList.toggle('failed',j.status==='failed');const jobTime=j.finished_at||j.started_at;const detail=j.diagnosis?.summary||(j.error||j.step).replace(/^[A-Za-z]+Error:\s*/,'');$('job-summary').textContent=j.status==='failed'?'上次任务未完成'+(jobTime?'（'+new Date(jobTime).toLocaleString('zh-CN')+'）':'')+' · '+detail:(j.status==='running'?'◌ ':'')+j.step;const logLabels={'error.log':'查看错误日志','llm-response.txt':'模型原始输出','llm-response-repair.txt':'自动修复输出','generation.json':'调用与校验记录','research.json':'查看研究记录'};$('job-links').innerHTML=(j.status==='failed'?Object.entries(j.logs||{}).map(([name,url])=>`<a href="${escapeHTML(url)}" target="_blank" rel="noreferrer">${logLabels[name]||escapeHTML(name)} ↗</a>`).join(''):'')+(j.comparison_url?`<a href="${escapeHTML(j.comparison_url)}">查看该任务与重试 ↗</a>`:'')+(j.model?`<span>当次模型：${escapeHTML(j.model)}</span>`:'');const key=(j.started_at||'')+j.status;if(j.status==='done'&&key!==seenJob&&j.run&&!initial){await openRun(j.run)}seenJob=key;setBusy();if(initial){setTopicMode(topicMode);drawStyleSelect();drawStyles();const c=state.config.llm;$('provider').value=c.provider;$('base-url').value=c.base_url;$('model').value=c.model;const t=state.config.tts;$('tts-provider').value=t.provider||'qwen';$('tts-voice').value=t.edge_voice||'zh-CN-YunjianNeural';$('tts-rate').value=t.rate||'+15%';$('tts-style-presets').checked=t.use_style_presets!==false;$('tts-pitch').value=t.pitch||'+0Hz';$('speech-url').value=t.openai_base_url||'https://api.openai.com/v1';$('speech-model').value=t.openai_model||'gpt-4o-mini-tts';$('speech-voice').value=t.openai_voice||'coral';$('speech-instructions').value=t.openai_instructions||'';$('tts-info').textContent=t.provider==='edge'?'Edge 在线语音 · '+t.edge_voice+' · '+t.rate:'本地 Qwen · '+t.voice;}modelHints();voiceHints();}catch(e){connected=false;setBusy();if(initial)toast('工作台连接失败：'+e.message)}}
async function start(action,payload={}){try{await api(action,payload);await refresh()}catch(e){toast(e.message)}}
async function startGeneration(action){
 if(topicMode!=='custom'&&!selected){toast('请先选一个题材');return}
 let payload={repo:selected?.id,style_id:$('style-select').value};
 if(topicMode==='custom'){
  if(!$('custom-topic').reportValidity())return;
  const urls=$('custom-urls').value.split('\n').map(x=>x.trim()).filter(Boolean);
  if(urls.length>5){toast('最多补充5个参考链接');return}
  if(urls.some(u=>!/^https?:\/\//i.test(u))){toast('参考链接需以 http:// 或 https:// 开头');return}
  payload={style_id:$('style-select').value,topic:{title:$('custom-title').value.trim(),angle:$('custom-angle').value.trim(),urls,search_mode:$('research-mode').value}};
 }
 if(generationIssue()){toast(generationIssue());if(connected)tab('settings');return}
 try{
  const result=await api(action,payload);
  if(result.job?.comparison_id)activeBatch=result.job.comparison_id;
  await refresh();if(action==='compare'){drawComparisons();tab('studio')}
 }catch(e){toast(e.message)}
}
$('collect').onclick=()=>start('collect');
$('compare').onclick=()=>startGeneration('compare');
$('build').onclick=()=>startGeneration('build');
$('render').onclick=()=>{if(generationIssue()){toast(generationIssue());tab('settings');return}start('render',{run:currentRun,script:spec})};
async function saveSettings(){await api('config',{llm:{provider:$('provider').value,base_url:$('base-url').value.trim(),model:$('model').value.trim(),api_key:$('api-key').value},tts:{provider:$('tts-provider').value,edge_voice:$('tts-voice').value,rate:$('tts-rate').value,pitch:$('tts-pitch').value,openai_base_url:$('speech-url').value,openai_model:$('speech-model').value,openai_voice:$('speech-voice').value,openai_instructions:$('speech-instructions').value,openai_api_key:$('speech-key').value,use_style_presets:$('tts-style-presets').checked}});$('api-key').value='';$('speech-key').value='';await refresh();$('base-url').value=state.config.llm.base_url}
$('settings-form').onsubmit=async e=>{e.preventDefault();try{await saveSettings();$('model-test-status').textContent='';toast('创作设置已保存')}catch(err){toast(err.message)}};
$('test-model').onclick=async()=>{modelTesting=true;setBusy();$('model-test-status').textContent='正在保存并测试连接…';try{await saveSettings();const result=await api('test-model',{});$('model-test-status').textContent='连接成功 · '+result.model+' · 已返回有效 JSON';}catch(err){$('model-test-status').textContent='测试未通过：'+err.message;}finally{modelTesting=false;setBusy()}};
const initialParams=new URLSearchParams(location.search);activeBatch=initialParams.get('comparison');refresh(true).then(()=>{const view=initialParams.get('view'),run=initialParams.get('run');if(run&&state?.runs.some(r=>r.id===run))openRun(run);else if(view&&titles[view])tab(view)});setInterval(()=>refresh(),3000);

function drawStyleSelect(){
 const choice=state.style_preference?.style_id||'baseline-v2';
 $('style-select').innerHTML=(state.styles||[]).map(s=>`<option value="${escapeHTML(s.id)}">${escapeHTML(s.name)}</option>`).join('');
 $('style-select').value=choice;
 $('style-select').onchange=()=>{$('style-hint').textContent=state.styles.find(s=>s.id===$('style-select').value)?.tagline||''};
 $('style-select').onchange();
}
function drawStyles(){
 if(!state.styles||!$('style-comparison'))return;
 const styles=state.styles.filter(s=>s.id!=='baseline-v2');
 $('style-comparison').innerHTML=styles.map(s=>{
  const variants=state.runs.filter(r=>r.style_id===s.id&&r.experiment==='20261015');
  const revised=variants.find(r=>r.revision==='narrative-v2')||variants.find(r=>r.revision==='natural-v1');
  const r=variants.find(r=>r.id===sampleVersions[s.id])||revised||variants[0];
  return `<article class="style-sample ${escapeHTML(s.id)}"><div class="sample-kicker">${escapeHTML(s.name)}</div><h3>${escapeHTML(r?.title||'样片准备中')}</h3><p class="sample-ref">参考方向：<a href="${escapeHTML(s.reference_url)}" target="_blank" rel="noreferrer">${escapeHTML(s.reference)} ↗</a></p>${variants.length>1?`<label class="version-label">播放版本<select data-version="${escapeHTML(s.id)}" aria-label="${escapeHTML(s.name)}播放版本">${variants.map(v=>`<option value="${escapeHTML(v.id)}" ${v.id===r.id?'selected':''}>${v.revision==='narrative-v2'?'新版 · 完整叙事':v.revision==='natural-v1'?'口播改版':'原版 · 风格试映'}</option>`).join('')}</select></label>`:''}${r?.video?`<video controls playsinline preload="metadata" aria-label="${escapeHTML(s.name)}样片" poster="${appURL('runs/'+encodeURIComponent(r.id)+'/frames/00.png')}" src="${escapeHTML(r.video)}"></video>`:'<div class="sample-wait">正在准备样片</div>'}<p>${escapeHTML(r?.voice_note||s.tagline)}</p>${r?.video?`<details class="voice-only"><summary>只听这一版旁白</summary><audio controls preload="none" aria-label="${escapeHTML(s.name)}纯旁白" src="${appURL('runs/'+encodeURIComponent(r.id)+'/audio/narration.wav')}"></audio></details>`:''}<small>${escapeHTML(r?.repo||'')} ${r?.duration?'· '+r.duration.toFixed(1)+' 秒':''}</small><div class="sample-actions"><button class="primary" data-prefer="${escapeHTML(s.id)}">设为默认风格</button>${r?`<button class="secondary" data-edit-style="${escapeHTML(r.id)}">播放与详情</button>`:''}</div>${r?.video?`<a class="download-video" href="${escapeHTML(r.video)}" download="${escapeHTML(s.id)}.mp4">下载 MP4 ↓</a>`:''}</article>`;
 }).join('');
 document.querySelectorAll('[data-version]').forEach(x=>x.onchange=()=>{sampleVersions[x.dataset.version]=x.value;drawStyles()});
 document.querySelectorAll('#style-comparison video, #style-comparison audio').forEach(v=>v.onplay=()=>document.querySelectorAll('video,audio').forEach(other=>{if(other!==v)other.pause()}));
 document.querySelectorAll('[data-prefer]').forEach(b=>b.onclick=async()=>{try{await api('style-preference',{style_id:b.dataset.prefer});state.style_preference={style_id:b.dataset.prefer};drawStyleSelect();updateStyleChoice();toast('已保存为后续生成的默认风格')}catch(e){toast(e.message)}});
 document.querySelectorAll('[data-edit-style]').forEach(b=>b.onclick=()=>openRun(b.dataset.editStyle));
 updateStyleChoice();
}
function updateStyleChoice(){
 if(!$('style-choice'))return;
 const id=state.style_preference?.style_id||'baseline-v2';
 if($('restore-baseline'))$('restore-baseline').disabled=id==='baseline-v2';
 $('style-choice').textContent='当前默认：'+(state.styles.find(s=>s.id===id)?.name||id)+'。可在热点选题中为单条视频改选。';
 document.querySelectorAll('[data-prefer]').forEach(b=>{b.textContent=b.dataset.prefer===id?'✓ 当前默认':'设为默认风格';b.setAttribute('aria-pressed',b.dataset.prefer===id?'true':'false')});
}

if($('restore-baseline'))$('restore-baseline').onclick=async()=>{try{await api('style-preference',{style_id:'baseline-v2'});state.style_preference={style_id:'baseline-v2'};drawStyleSelect();updateStyleChoice();toast('已恢复 V2 默认风格')}catch(e){toast(e.message)}};

function voiceHints(){
 const t=state?.config.tts||{},provider=$('tts-provider').value;
 $('edge-settings').hidden=provider!=='edge';$('speech-settings').hidden=provider!=='openai';
 $('speech-token-status').textContent=(t.openai_api_key_configured?'语音 Token 已填写。':'语音 Token 尚未填写。')+' 仅保存在当前进程内；重启后重新填写。';
 $('tts-info').textContent=provider==='openai'?'Speech API · '+($('speech-model').value||'待填写')+' · 音色 '+($('speech-voice').value||'待填写'):provider==='edge'?'Edge 合成语音 · 字幕使用实际词时间戳':'本地 Qwen · 离线配音';
}
$('tts-provider').onchange=voiceHints;

function safeList(values){return '<ul>'+(values||[]).map(x=>`<li>${escapeHTML(x)}</li>`).join('')+'</ul>'}
function agentKey(a){return a.agent_id||a.style_id}
function creativeDetails(a){
 if(!a.assignment)return '';
 const labels={opening:'开场',structure:'叙事',visual:'画面',tone:'口吻',rhythm:'节奏'};
 return `<div class="creative-tags">${Object.entries(a.assignment).map(([k,v])=>`<span>${escapeHTML(labels[k])} · ${escapeHTML(v)}</span>`).join('')}</div>${a.brief?`<details class="creator-pitch"><summary>本轮创作方案与提示词</summary><p>${escapeHTML(a.brief.opening)}</p><p>${escapeHTML(a.brief.story_arc)}</p><p>画面：${escapeHTML(a.brief.visual_plan)}</p><p>结尾：${escapeHTML(a.brief.ending)}</p><pre class="creative-prompt">${escapeHTML(a.brief.creative_prompt)}</pre></details>`:''}`;
}
$('library-history').onchange=()=>drawRuns();
function feedbackPayload(){
 const globalFeedback=$('global-feedback')?.value.trim()||'';
 const agentFeedback={};
 document.querySelectorAll('[data-feedback-agent]').forEach(el=>{if(el.value.trim())agentFeedback[el.dataset.feedbackAgent]=el.value.trim()});
 return {global_feedback:globalFeedback,agent_feedback:agentFeedback};
}
async function submitSupervisorFeedback(batch,allRejected=false){
 const payload=feedbackPayload();
 if(generationIssue()){toast(generationIssue());if(connected)tab('settings');return}
 if(!allRejected&&!payload.global_feedback&&!Object.keys(payload.agent_feedback).length){toast('请先填写统一反馈或某一路反馈');return}
 feedbackSubmitting=true;setBusy();
 try{
  await api('comparison-feedback',{comparison_id:batch.id,...payload,all_rejected:allRejected});
  delete pendingSelections[batch.id];
  delete feedbackDrafts[batch.id];
  await refresh();
  tab('studio');
  toast(allRejected?'已交给 Supervisor 重做三路视频':'已交给 Supervisor 按反馈重做指定路线');
 }catch(e){toast(e.message)}finally{feedbackSubmitting=false;setBusy()}
}
function drawComparisons(){
 const batches=state?.comparisons||[];
 const batch=batches.find(b=>b.id===activeBatch)||batches[0];
 activeBatch=batch?.id||null;
 $('batch-select').innerHTML=batches.length?batches.map(b=>`<option value="${escapeHTML(b.id)}" ${b.id===activeBatch?'selected':''}>${escapeHTML(b.repo)} · ${escapeHTML(new Date(b.created_at).toLocaleString('zh-CN'))}</option>`).join(''):'<option>还没有对比任务</option>';
 $('batch-select').disabled=!batches.length;
 $('batch-select').onchange=()=>{activeBatch=$('batch-select').value;drawComparisons();tab('studio')};
 if(!batch){
  $('comparison-summary').textContent='从热点中选择项目，或输入自主选题，点击“三位 Agent 随机探索”。完成后在这里多选成片、逐路反馈，或让 Supervisor 重做三路。';
  $('agent-comparison').innerHTML='';$('review-panel').innerHTML='';$('comparison-feedback').innerHTML='';$('comparison-actions').innerHTML='';return;
 }
 const draft=feedbackDrafts[batch.id]||{global_feedback:'',agent_feedback:{}};
 const savedSelected=new Set(batch.selected_styles|| (batch.selected_style?[batch.selected_style]:[]));
 const pending=pendingSelections[batch.id]||Array.from(savedSelected);
 pendingSelections[batch.id]=pending;
 $('comparison-summary').innerHTML=`<strong>${escapeHTML(batch.repo)}</strong> · 第 ${batch.round||1} 轮 · ${escapeHTML(batch.stage)}${batch.source_url?`<p><a href="${escapeHTML(batch.source_url)}" target="_blank" rel="noreferrer">三路共用的资料来源 ↗</a></p>`:''}${batch.error?`<p class="error-text">${escapeHTML(batch.error)}</p>`:''}${batch.round>1?`<p>这是 Supervisor 按上一轮反馈调整后的第 ${batch.round} 轮。原始成片仍保留在历史记录中。</p>`:batch.experiment?'<p>本轮重新抽取开场、叙事、画面、口吻与节奏；三个 Agent 各自设计提示词并制作。</p>':'<p>历史任务 · 固定风格模式。</p>'}${batch.research?researchHTML(batch.research):''}`;
 const oldVideos=new Map([...$('agent-comparison').querySelectorAll('video')].map(v=>[v.getAttribute('src'),v]));
 const states={queued:'待开始',running:'进行中',done:'已完成',failed:'未完成'};
 $('agent-comparison').innerHTML=batch.agents.map(a=>{
  const id=agentKey(a),checked=pending.includes(id),saved=savedSelected.has(id);
  return `<article class="style-sample ${escapeHTML(a.render_style_id||a.style_id)} ${checked?'selected-version':''}">
  <div class="sample-kicker">${escapeHTML(a.name)}</div><h3>${escapeHTML(a.title||a.brief?.name||'准备独立创作')}</h3>${creativeDetails(a)}
  <p class="agent-status ${escapeHTML(a.status)}">${states[a.status]||escapeHTML(a.status)} · ${escapeHTML(a.stage)}${saved?' · 已在成片库':''}</p>
  ${a.status==='done'&&a.video?`<video controls playsinline preload="metadata" aria-label="${escapeHTML(a.name)}对比成片" src="${escapeHTML(a.video)}" poster="${appURL('runs/'+encodeURIComponent(a.run)+'/frames/00.png')}"></video><small>${Number(a.duration).toFixed(1)} 秒</small>`:'<div class="agent-placeholder">'+escapeHTML(a.error||a.stage)+'</div>'}
  ${a.pitch?`<details class="creator-pitch"><summary>创作 Agent 的说明 · 自评</summary><p>${escapeHTML(a.pitch.approach)}</p>${safeList(a.pitch.strengths)}<p>取舍：${escapeHTML(a.pitch.tradeoff)}</p></details>`:''}
  ${a.status==='done'?`<div class="sample-actions"><label class="selection-control"><input type="checkbox" data-select-agent="${escapeHTML(id)}" ${checked?'checked':''} ${batch.status==='running'?'disabled':''}><span>${checked?'已勾选入库':'选入成片库'}</span></label><button class="secondary" data-open="${escapeHTML(a.run)}">播放与详情</button></div><label class="route-feedback">给这一路的反馈<textarea data-feedback-agent="${escapeHTML(id)}" rows="2" maxlength="2000" placeholder="例如：稍微太长，结尾再收紧一些">${escapeHTML(draft.agent_feedback[id]||'')}</textarea></label><a class="download-video" href="${escapeHTML(a.video)}" download>下载 MP4 ↓</a>`:''}
 ${a.history?.length?`<details class="creator-pitch"><summary>此前版本 · ${a.history.length} 条</summary>${a.history.map(h=>`<p>第 ${h.round} 轮 · ${escapeHTML(h.title||'未完成')}${h.video?` <a href="${escapeHTML(h.video)}" target="_blank" rel="noreferrer">播放旧版 ↗</a>`:''}</p>`).join('')}</details>`:''}
 </article>`;
 }).join('');
 $('agent-comparison').querySelectorAll('video').forEach(v=>{const old=oldVideos.get(v.getAttribute('src'));if(old)v.replaceWith(old)});
 $('agent-comparison').querySelectorAll('video').forEach(v=>v.onplay=()=>document.querySelectorAll('video,audio').forEach(other=>{if(other!==v)other.pause()}));
 $('agent-comparison').querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openRun(b.dataset.open));
 document.querySelectorAll('[data-select-agent]').forEach(input=>input.onchange=()=>{
  const ids=[...document.querySelectorAll('[data-select-agent]:checked')].map(x=>x.dataset.selectAgent);
  pendingSelections[batch.id]=ids;
  input.closest('article').classList.toggle('selected-version',input.checked);
  input.nextElementSibling.textContent=input.checked?'已勾选入库':'选入成片库';
  $('selection-count').textContent=`已勾选 ${ids.length} 条 · 已保存 ${savedSelected.size} 条`;
  const save=document.querySelector('[data-save-selection]');
  if(save){save.dataset.changed=String(ids.length!==savedSelected.size||ids.some(id=>!savedSelected.has(id)));save.textContent=ids.length?'保存勾选并进入成片库':'清空已选成片'}
  setBusy();
 });
 const feedbackEnabled=batch.status!=='running';
 $('comparison-feedback').innerHTML=`<section class="feedback-panel"><div class="eyebrow">SUPERVISOR FEEDBACK</div><h2>看完之后，告诉 Supervisor 怎么改</h2><p>可以只填写某一路，也可以填写统一反馈。比如“整体太长”“开头不够抓人”“结尾没有落点”。</p><label>统一反馈<textarea id="global-feedback" rows="3" maxlength="2000" placeholder="对全部路线的要求，例如：三条都太长，压到一分钟左右，并补一个更明确的结尾" ${feedbackEnabled?'':'disabled'}>${escapeHTML(draft.global_feedback)}</textarea></label><div class="feedback-actions"><button class="primary" data-supervise-feedback ${feedbackEnabled?'':'disabled'}>按反馈重做指定路线</button><button class="secondary" data-reject-all ${feedbackEnabled?'':'disabled'}>三版全部否决，重做三版</button></div><p class="note">“重做指定路线”会根据统一反馈和各路反馈决定范围；“三版全部否决”会让三位 Agent 全部重新生成。</p></section>`;
 document.querySelectorAll('[data-feedback-agent],#global-feedback').forEach(el=>el.oninput=()=>{feedbackDrafts[batch.id]=feedbackPayload()});
 if(batch.supervisor)$('comparison-feedback').insertAdjacentHTML('beforeend',`<p class="supervisor-summary"><strong>第 ${batch.supervisor.round} 轮调整：</strong>${escapeHTML(batch.supervisor.summary)}</p>`);
 const review=batch.review||{};
 if(review.status==='done'){
  const r=review.result||{},styleName=id=>{const a=batch.agents.find(a=>agentKey(a)===id);return a?(a.name+(a.brief?' · '+a.brief.name:'')):id};
  $('review-panel').innerHTML=`<div class="eyebrow">INDEPENDENT REVIEW</div><h2>${review.blind?'独立盲评的建议':'独立评审的建议'}</h2>${review.blind?'<p>版本随机排序后匿名评审；评审未看到 Agent 身份、随机约束、提示词或自评。所有版本使用同一组标准。</p>':''}<p class="review-scope">评审依据：${escapeHTML(review.scope)}</p>${review.fallback?`<p class="error-text">${escapeHTML(review.fallback)}</p>`:''}<p>${escapeHTML(r.summary||'')}</p>${r.recommended_style?`<p><strong>优先推荐：${escapeHTML(styleName(r.recommended_style))}</strong> · ${escapeHTML(r.reason||'')}</p>`:''}<div class="review-grid">${(r.verdicts||[]).map(v=>`<article><h3>${escapeHTML(styleName(v.style_id))}</h3><h4>优点</h4>${safeList(v.strengths)}<h4>不足与取舍</h4>${safeList(v.weaknesses)}<p>适合：${escapeHTML(v.best_for)}</p>${(v.observations||[]).map(o=>{const sample=review.samples?.[v.style_id]?.find(s=>s.scene===o.scene);return `<p class="observation">第 ${o.scene} 场${sample?' · '+sample.seconds.toFixed(1)+'s':''}：${escapeHTML(o.note)}${sample?` <a href="${escapeHTML(sample.url)}" target="_blank" rel="noreferrer">查看依据帧 ↗</a>`:''}</p>`}).join('')}</article>`).join('')}</div><p class="note">评审只提供建议，最终可以多选；选择后到成片库继续管理。</p>`;
 }else{
  const message=review.status==='running'?'评审 Agent 正在比较已完成成片的关键帧、文稿和时序…':review.status==='failed'?'评审未完成：'+review.error:review.status==='skipped'?'暂无可评审成片；完成创作后再评审。':'等待创作完成后自动评审。';
  $('review-panel').innerHTML=`<h2>独立评审</h2><p>${escapeHTML(message)}</p>`;
 }
 const selectedCount=pending.length;
 const selectionChanged=pending.length!==savedSelected.size||pending.some(id=>!savedSelected.has(id));
 $('comparison-actions').innerHTML=`<span id="selection-count" class="selection-note">已勾选 ${selectedCount} 条${savedSelected.size?' · 已保存 '+savedSelected.size+' 条':''}</span>${batch.status!=='running'?`<button class="primary" data-save-selection data-changed="${selectionChanged}" ${selectionChanged?'':'disabled'}>${selectedCount?'保存选择并进入成片库':'清空已选成片'}</button>`:''}${savedSelected.size?'<button class="secondary" data-open-library>打开成片库</button>':''}${batch.status!=='running'&&batch.status!=='done'?`<button class="secondary" data-retry-comparison="${escapeHTML(batch.id)}">${batch.agents.every(a=>a.status==='done')?'重试独立评审':'重试未完成分支并评审'}</button><span class="note">已完成的视频会保留。</span>`:''}${batch.status!=='running'?`<button class="secondary" data-new-exploration="${escapeHTML(batch.id)}">同题再探索 · 换一组随机方案</button>`:''}`;
 document.querySelector('[data-save-selection]')?.addEventListener('click',async()=>{try{const ids=pendingSelections[batch.id]||[],runIds=batch.agents.filter(a=>ids.includes(agentKey(a))&&a.run).map(a=>a.run);await api('comparison-choice',{comparison_id:batch.id,agent_ids:ids});delete pendingSelections[batch.id];await refresh();if(ids.length&&integratedWorkbench){window.parent.postMessage({type:'content-workbench:outputs-changed'},location.origin);tab('library');toast('已保存选择；成片自动同步到素材库')}else{if(ids.length)tab('library');toast(ids.length?'已将 '+ids.length+' 条成片加入成片库':'已清空选择，原视频保留在历史版本中')}}catch(e){toast(e.message)}});
 document.querySelector('[data-open-library]')?.addEventListener('click',()=>tab('library'));
 document.querySelector('[data-supervise-feedback]')?.addEventListener('click',()=>submitSupervisorFeedback(batch,false));
 document.querySelector('[data-reject-all]')?.addEventListener('click',()=>submitSupervisorFeedback(batch,true));
 document.querySelectorAll('[data-new-exploration]').forEach(b=>b.onclick=async()=>{if(generationIssue()){toast(generationIssue());if(connected)tab('settings');return}try{const result=await api('compare',batch.topic?{topic:batch.topic}:{repo:batch.repo});activeBatch=result.job.comparison_id;await refresh();tab('studio')}catch(e){toast(e.message)}});
 document.querySelectorAll('[data-retry-comparison]').forEach(b=>b.onclick=async()=>{if(generationIssue()){toast(generationIssue());if(connected)tab('settings');return}try{await api('compare-retry',{comparison_id:batch.id});await refresh()}catch(e){toast(e.message)}});
 setBusy();
}

$('test-voice').onclick=async()=>{
 modelTesting=true;setBusy();$('voice-test-status').textContent='正在生成一句试听…';$('voice-preview').hidden=true;
 try{await saveSettings();const result=await api('test-voice',{});$('voice-preview').src=result.audio;$('voice-preview').hidden=false;$('voice-test-status').textContent='已生成；点击播放比较语气、停顿和发音。'}
 catch(e){$('voice-test-status').textContent='试听未完成：'+e.message}
 finally{modelTesting=false;setBusy()}
};

function updateTopicPanel(){
 const custom=topicMode==='custom';
 if(custom){
  $('pick-title').textContent=$('custom-title').value.trim()||'从你的问题开始';
  $('pick-description').textContent='研究 Agent 先找资料并整理证据，创作 Agent 再完成文稿、配音与成片。';
  $('pick-metrics').innerHTML='';
 }
 $('pick-source').hidden=custom;
 $('creation-route').textContent=custom?'拆分问题 → 搜索与核实 → 创作 → 配音与成片':'核实资料 → 完整叙事 → 配音与动效 → 成片';
 $('compare').textContent=custom?'研究并让三位 Agent 随机探索 →':'三位 Agent 随机探索 →';
 $('build').textContent=custom?'研究并生成一条视频':'仅按所选风格生成一条';
}
function setTopicMode(mode){
 topicMode=mode;
 const custom=mode==='custom';
 $('custom-topic').hidden=!custom;$('candidates').hidden=custom;$('feed-heading').hidden=custom;$('source-status').hidden=custom;
 $('discussions').hidden=custom;document.querySelector('.discussion-heading').hidden=custom;
 for(const [id,active] of [['mode-custom',custom],['mode-trending',!custom]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active))}
 const u=new URL(location);if(custom)u.searchParams.set('topic','custom');else u.searchParams.delete('topic');history.replaceState(null,'',u);
 if(!custom&&selected)pick(selected.id);updateTopicPanel();setBusy();
}
function researchHTML(report){
 const sources=report.sources||[];
 return `<details class="research-report"><summary>研究资料 · ${sources.length} 个已读取来源</summary><p>${escapeHTML(report.summary||'资料整理中')}</p><ul>${sources.map(s=>`<li><a href="${escapeHTML(s.url)}" target="_blank" rel="noreferrer">[${escapeHTML(s.id)}] ${escapeHTML(s.title)} ↗</a><small>读取于 ${escapeHTML(s.retrieved_at?new Date(s.retrieved_at).toLocaleString('zh-CN'):'本次研究')}</small></li>`).join('')}</ul>${report.limitations?.length?'<h4>资料局限</h4>'+safeList(report.limitations):''}<p class="note">检索问题：${escapeHTML((report.queries||[]).join('；'))}</p></details>`;
}
$('mode-custom').onclick=()=>setTopicMode('custom');
$('mode-trending').onclick=()=>setTopicMode('trending');
$('custom-title').oninput=()=>{updateTopicPanel();setBusy()};
$('custom-topic').onsubmit=e=>{e.preventDefault();startGeneration('build')};
