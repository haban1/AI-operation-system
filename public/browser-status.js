const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const format=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'暂无检查记录';

export function browserStatusModel(bootstrap={}){
  const paused=bootstrap.config?.masterSwitch?.enabled===false;
  const fresh=device=>{const age=Date.now()-new Date(device?.last_heartbeat).getTime();return device?.status==='ONLINE'&&age>=0&&age<20000};
  const online=typeof bootstrap.localAgent?.online==='boolean'?bootstrap.localAgent.online:(bootstrap.devices||[]).some(fresh);
  const rows=(bootstrap.platforms||[]).flatMap(platform=>{
    const accounts=(bootstrap.accounts||[]).filter(account=>account.platform_code===platform.code);
    const enabled=accounts.filter(account=>account.enabled!==0);
    return (enabled.length?enabled:[accounts[0]]).map(account=>{
    const device=(bootstrap.devices||[]).find(item=>String(item.id)===String(account?.device_id));
    const boundToCurrent=!account?.device_id||String(account.device_id)===String(bootstrap.localAgent?.deviceId||bootstrap.localAgent?.expectedDeviceId);
    const connected=boundToCurrent?online:fresh(device);
    let control={};try{control=typeof device?.browser_control_json==='string'?JSON.parse(device.browser_control_json):device?.browser_control_json||{}}catch{}
    const info=(fresh(device)&&Array.isArray(control.platformRuntimes)?control.platformRuntimes:[]).find(item=>(item.platformCode||item.runtime?.platformCode)===platform.code)||{};
    const runtime=info.runtime||{};
    const age=Date.now()-new Date(account?.login_checked_at).getTime();
    const recent=age>=0&&age<15*60*1000;
    const login=account?.login_source==='LOCAL_AGENT'&&recent?account.login_status:'UNKNOWN';
    const base={code:platform.code,key:enabled.length>1?`${platform.code}:${account.id}`:platform.code,accountId:account?.id||'',name:platform.name||platform.display_name||platform.code,account:account?.display_name||'',checkedAt:account?.login_checked_at||null};
    const result=(kind,label,tone='neutral')=>({...base,kind,label,tone});
    if(platform.lifecycle_state==='PLANNED')return result('planned','未接入');
    if(paused)return result('paused','已暂停');
    if(platform.desired_state!=='RUNNING')return result('stopped','未运行');
    if(!account||account.enabled===0)return result('account','账号未启用');
    if(!connected)return result('offline','连接中断','warning');
    if(['LOGIN','EXPIRED','LOGIN_EXPIRED'].includes(login))return result('login','需要登录','warning');
    if(login==='VERIFY_REQUIRED')return result('verify','需要验证','warning');
    if(runtime.lastError)return result('browser','浏览器连接需检查','warning');
    if(login==='ERROR')return result('browser','检查失败','warning');
    if(login==='READY')return result('ready','最近检查正常','success');
    if(runtime.contextConnected||runtime.connected)return result('connected','浏览器已连接','success');
    return result('unknown','待检查');
    });
  });
  const issues=rows.filter(row=>row.tone==='warning');
  const active=rows.filter(row=>!['stopped','planned','paused','account'].includes(row.kind));
  const title=paused?'已暂停':issues.length?'需要处理':!active.length?'暂无运行中的平台':active.some(row=>row.kind==='unknown')?'部分状态待检查':'暂未发现异常';
  return {rows,title,tone:issues.length?'warning':active.length&&!active.some(row=>row.kind==='unknown')?'success':'neutral',online,paused};
}

export function browserStatusMarkup(model){
  return `<section id="browserStatusPanel" class="panel browser-status-panel"><div class="panel-head"><div><h2>${esc(model.title)}</h2></div><button class="btn secondary" id="browserRefresh" type="button">刷新状态</button></div><div class="browser-status-list">${model.rows.map(row=>`<article class="browser-status-row" data-browser-platform="${esc(row.code)}" data-browser-account="${esc(row.accountId)}"><div><b>${esc(row.name)}</b>${row.account?`<small>${esc(row.account)}</small>`:''}</div><div class="browser-status-result"><span class="browser-status-label ${row.tone}">${esc(row.label)}</span>${row.checkedAt?`<small>上次检查 ${esc(format(row.checkedAt))}</small>`:''}</div><button type="button" class="btn secondary" data-browser-help="${esc(row.key)}">${row.tone==='warning'?'怎么修复':'查看帮助'}</button></article>`).join('')||'<div class="empty">暂无平台，请先添加平台账号。</div>'}</div></section>`;
}

const repairs={
  offline:{title:'恢复浏览器连接',steps:['确认运行系统的电脑已开机，并且能正常上网。','在那台电脑的项目文件夹中，双击 start-browser-agent.cmd 启动浏览器服务；找不到时请联系维护人员。','服务启动后，回到这里刷新状态。']},
  login:{title:'重新登录',steps:['进入“平台账号”，找到这个平台。','点击“打开 Chrome 登录 / 切换”，在弹出的浏览器中完成登录。','点击“检查登录”，再回到这里刷新状态。']},
  verify:{title:'完成账号验证',steps:['进入“平台账号”，打开这个平台的登录窗口。','按照平台提示完成扫码或安全验证。','点击“检查登录”，再回到这里刷新状态。']},
  browser:{title:'检查浏览器',steps:['确认运行系统的电脑能正常打开这个平台。','进入“平台账号”，点击“检查登录”；需要登录时先完成登录。','仍然失败时，请让维护人员检查浏览器服务。']},
  unknown:{title:'检查当前状态',steps:['进入“平台账号”，找到这个平台。','点击“检查登录”，等待检查完成。','回到这里刷新状态，查看结果。']},
  paused:{title:'恢复运行',steps:['展开左侧底部的“运行状态”。','需要继续自动任务时，开启“全局运行”。','回到这里刷新状态。']},
  stopped:{title:'开启这个平台',steps:['进入“平台账号”，找到这个平台。','需要使用时，启用账号并点击“开启平台”。','完成登录后，回到这里刷新状态。']},
  account:{title:'启用平台账号',steps:['进入“平台账号”，添加或启用这个平台的账号。','开启平台并完成登录。','回到这里刷新状态。']},
  planned:{title:'平台尚未接入',steps:['这个平台暂未接入，无需修复。','需要使用时，请联系维护人员确认接入安排。']},
  ready:{title:'最近检查正常',steps:['如采集或发布仍有问题，先进入“平台账号”重新检查登录。','登录正常后，到“问题记录”查看具体原因。']},
  connected:{title:'浏览器已连接',steps:['如采集或发布仍有问题，先进入“平台账号”检查登录。','登录正常后，到“问题记录”查看具体原因。']}
};

export function bindBrowserStatus(root,model,{onAccounts,onIssues}){
  root.querySelectorAll('[data-browser-help]').forEach(button=>button.onclick=()=>{
    const row=model.rows.find(item=>item.key===button.dataset.browserHelp);if(!row)return;
    const help=repairs[row.kind]||repairs.unknown;
    const dialog=document.createElement('dialog');dialog.className='browser-repair-dialog';
    dialog.setAttribute('aria-labelledby','browserRepairTitle');
    dialog.innerHTML=`<div class="browser-repair-head"><h2 id="browserRepairTitle">${esc(row.name)} · ${esc(help.title)}</h2><button type="button" class="ghost" data-browser-close aria-label="关闭">×</button></div><ol>${help.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ol><div class="button-row"><button type="button" class="btn" data-browser-accounts>去平台账号</button><button type="button" class="btn secondary" data-browser-issues>查看问题记录</button></div>`;
    const close=()=>dialog.close();
    dialog.querySelector('[data-browser-close]').onclick=close;
    dialog.querySelector('[data-browser-accounts]').onclick=()=>{close();onAccounts()};
    dialog.querySelector('[data-browser-issues]').onclick=()=>{close();onIssues()};
    dialog.addEventListener('close',()=>{dialog.remove();if(button.isConnected)button.focus()},{once:true});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close()}});
    document.body.append(dialog);dialog.showModal();
  });
}
