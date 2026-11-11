// Shared with app.js. Source metrics retain their own units and discovery method.
const sourceNames={github:'GitHub',weibo:'微博',xiaohongshu:'小红书',hackernews:'Hacker News',reddit:'Reddit'};
let sourceSettingsLoaded=false;
let xhsLoginBusy=false;
function sourceKey(row){return row.source_key||Object.keys(sourceNames).find(k=>sourceNames[k]===row.source)||row.source}
function sourceMetrics(row){return row.metrics||[{label:'本周新增 Star',value:row.weekly_stars},{label:'累计 Star',value:row.total_stars}]}
function metricText(metric){return metric?.display||fmt(metric?.value)}
function safeSourceURL(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:'#'}catch{return '#'}}
function drawPickedMetrics(row){
 $('pick-metrics').innerHTML='<div class="metrics">'+sourceMetrics(row).map(m=>`<div><strong>${escapeHTML(metricText(m))}</strong><span>${escapeHTML(m.label)}</span></div>`).join('')+'</div>'+
  `<p class="note">${escapeHTML(row.discovery||row.source)}${row.author?' · '+escapeHTML(row.author):''}<br>${row.published_at?'发布：'+escapeHTML(row.published_at)+'<br>':''}采集：${escapeHTML(row.collected_at?new Date(row.collected_at).toLocaleString('zh-CN'):'未知')}${row.stale?'<br><b>本次更新失败，当前为上次采集结果</b>':''}</p>`;
 $('pick-source').textContent='查看原始来源 ↗';
}
function renderHotFeed(){
 if(!state)return;
 const f=state.feed,filter=$('source-filter'),current=filter.value;
 const keys=new Map((f.candidates||[]).map(c=>[sourceKey(c),c.source]));
 filter.innerHTML='<option value="">全部来源</option>'+[...keys].map(([k,v])=>`<option value="${escapeHTML(k)}">${escapeHTML(v)}</option>`).join('');
 filter.value=keys.has(current)?current:'';
 const query=$('topic-search').value.trim().toLocaleLowerCase();
 const rows=(f.candidates||[]).filter(c=>(!filter.value||sourceKey(c)===filter.value)&&(!query||(c.title+' '+(c.description||'')).toLocaleLowerCase().includes(query)));
 $('capture-time').textContent=f.collected_at?'最近采集尝试：'+new Date(f.collected_at).toLocaleString('zh-CN')+' · '+rows.length+' 条选题 · 各平台热度独立展示':'暂无采集记录，请刷新热点';
 const labels={ok:'已采集',unavailable:'暂不可用',not_configured:'待接入'};
 $('source-status').innerHTML=(f.sources||[]).map(s=>`<div class="source-result ${escapeHTML(s.status)}"><strong>${escapeHTML(s.source)} · ${labels[s.status]||escapeHTML(s.status)}${s.status==='ok'?' · '+fmt(s.count)+' 条':''}</strong>${s.detail?'<span>'+escapeHTML(s.detail)+'</span>':''}${s.retained_count?'<span>保留 '+fmt(s.retained_count)+' 条历史结果</span>':''}</div>`).join('');
 $('candidates').innerHTML=rows.length?rows.map(c=>{
  const m=sourceMetrics(c)[0];
  return `<button class="topic-card" data-id="${escapeHTML(c.id)}"><div class="rank">${c.rank||'·'}</div><div><div class="topic-title">${escapeHTML(c.title)}</div><div class="topic-owner">${escapeHTML(c.source)} · ${escapeHTML({repository:'开源项目',article:'文章',video:'视频',image_text:'图文',topic:'话题'}[c.content_type]||'开源项目')}${c.stale?' · 历史结果':''}</div><div class="topic-desc">${escapeHTML(c.description||c.discovery||'选择后核实原始资料')}</div></div><div class="gain">${m?escapeHTML(metricText(m)):'文章'}<small>${m?escapeHTML(m.label):'订阅更新'}</small></div></button>`;
 }).join(''):'<div class="empty">没有符合条件的选题。可调整筛选、配置来源，或刷新热点。</div>';
 document.querySelectorAll('.topic-card').forEach(b=>b.onclick=()=>pick(b.dataset.id));
 if(rows.length)pick(rows.some(c=>c.id===selected?.id)?selected.id:rows[0].id);
 else{selected=null;$('pick-title').textContent='选一个话题，开始创作';$('pick-description').textContent='调整筛选或刷新热点后选择题材';$('pick-metrics').innerHTML='';$('pick-source').removeAttribute('href');if(topicMode==='custom')updateTopicPanel();setBusy()}
 $('discussions').innerHTML=(f.discussions||[]).slice(0,12).map(d=>`<a class="discussion" href="${escapeHTML(safeSourceURL(d.url))}" target="_blank" rel="noreferrer">${escapeHTML(d.title)} ↗<small>${escapeHTML(d.source)} · ${fmt(d.score)} 分 · 仅作线索${d.stale?' · 历史结果':''}</small></a>`).join('')||'<div class="empty">暂无可用的社区讨论线索。</div>';
 if(!sourceSettingsLoaded&&state.config.sources)fillSourceSettings(state.config.sources);
}
function fillSourceSettings(s){
 for(const key of Object.keys(sourceNames))$('source-'+key).checked=!!s[key];
 $('xhs-keywords').value=(s.xhs_keywords||[]).join('\n');$('xhs-note-type').value=s.xhs_note_type||'不限';
 $('rss-feeds').value=(s.rss||[]).map(f=>f.name+' | '+f.url).join('\n');sourceSettingsLoaded=true;
}
function bindSourceControls(){
 $('source-filter').onchange=renderHotFeed;$('topic-search').oninput=renderHotFeed;
 for(const [button,action] of [['xhs-status','xhs-status'],['xhs-login','xhs-login-qr']])$(button).onclick=async()=>{
  xhsLoginBusy=true;setBusy();$('xhs-login-message').textContent='正在连接小红书服务…';$('xhs-login-image').hidden=true;
  try{const result=await api(action,{});$('xhs-login-message').textContent=result.message||'已完成检查';
   if(result.image&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(result.image)){$('xhs-login-image').src=result.image;$('xhs-login-image').hidden=false}
  }catch(error){$('xhs-login-message').textContent=error.message}finally{xhsLoginBusy=false;setBusy()}
 };
 $('sources-form').onsubmit=async event=>{
  event.preventDefault();
  try{
   const sources=Object.fromEntries(Object.keys(sourceNames).map(k=>[k,$('source-'+k).checked]));
   sources.xhs_keywords=$('xhs-keywords').value.split('\n').map(x=>x.trim()).filter(Boolean);
   sources.xhs_note_type=$('xhs-note-type').value;
   sources.rss=$('rss-feeds').value.split('\n').map(x=>x.trim()).filter(Boolean).map(line=>{
    const split=line.indexOf('|');if(split<1)throw Error('RSS每行填写：名称 | https://订阅地址');
    return {name:line.slice(0,split).trim(),url:line.slice(split+1).trim()};
   });
   $('save-sources').disabled=true;
   const result=await api('sources-config',{sources});fillSourceSettings(result.sources);
   $('source-save-status').textContent='来源已保存。点击“刷新热点”按新设置采集。';await refresh();
  }catch(error){$('source-save-status').textContent=error.message}finally{setBusy()}
 };
}
