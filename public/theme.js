/* 日间 / 夜间主题与界面光效。只处理外观，不读写业务数据、不调用接口。
   - 主题：localStorage 'ui-theme' = day | night，默认 day（晨雾）。
   - 动效：localStorage 'ui-fx' = on | off；未设置时，减少动态效果或低配设备默认 off。
   - 卡片光晕/反光：鼠标移动时更新 --mx/--my/--gx；指标卡随鼠标轻微倾斜。 */
(function(){
  'use strict';
  var root=document.documentElement;
  function read(key){try{return localStorage.getItem(key)}catch(e){return null}}
  function write(key,value){try{localStorage.setItem(key,value)}catch(e){}}
  var reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lowEnd=(navigator.hardwareConcurrency||8)<=2;

  function applyTheme(theme){
    root.setAttribute('data-theme',theme==='night'?'night':'day');
    var meta=document.querySelector('meta[name="theme-color"]');
    if(meta)meta.setAttribute('content',theme==='night'?'#08090c':'#e8edf5');
  }
  function applyFx(fx){root.setAttribute('data-fx',fx==='off'?'off':'on')}
  applyTheme(read('ui-theme')||'day');
  applyFx(read('ui-fx')||(reduce||lowEnd?'off':'on'));

  var ICON={
    sun:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    spark:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>'
  };

  function renderTools(box){
    var night=root.getAttribute('data-theme')==='night';
    var fxOn=root.getAttribute('data-fx')!=='off';
    box.innerHTML=
      '<button type="button" class="tk-theme-toggle" data-tk="theme" title="切换'+(night?'日间':'夜间')+'模式">'+(night?ICON.sun:ICON.moon)+'<span>'+(night?'日间':'夜间')+'</span></button>'+
      '<button type="button" class="tk-fx-toggle" data-tk="fx" aria-pressed="'+fxOn+'" title="'+(fxOn?'关闭':'开启')+'光效与毛玻璃（配置较低的电脑建议关闭）">'+ICON.spark+'</button>';
  }

  function mountTools(){
    var host=document.querySelector('.side-actions');
    if(!host||host.querySelector('.tk-theme-tools'))return;
    var box=document.createElement('div');
    box.className='tk-theme-tools';
    renderTools(box);
    host.insertBefore(box,host.firstChild);
    box.addEventListener('click',function(e){
      var b=e.target.closest('[data-tk]');if(!b)return;
      if(b.getAttribute('data-tk')==='theme'){
        var next=root.getAttribute('data-theme')==='night'?'day':'night';
        applyTheme(next);write('ui-theme',next);
      }else{
        var fx=root.getAttribute('data-fx')==='off'?'on':'off';
        applyFx(fx);write('ui-fx',fx);
      }
      renderTools(box);
    });
  }

  /* 卡片光效：进入卡片时测量一次位置，移动时只更新变量 */
  var CARD='.panel,.operations-surface,.operations-ai-panel,.preview-stat,.metric,.dashboard-device-card,.platform-login-item,.publish-queue-board,.task-command-center,.task-stream,.message-command-center,.message-channel-poll-card,.mini-link-card,.mini-program-summary,.mini-program-workbench,.platform-runtime-card,.settings-status-card,.settings-mini-card,.ai-visual-card,.browser-device-card,.task-card,.interaction-card,.publish-action-card,.ai-status-card,.knowledge-category-card,.account-card,.message-card,.check-card';
  var TILT={'preview-stat':10,'metric':6,'platform-runtime-card':5,'settings-mini-card':5,'dashboard-device-card':5,'publish-action-card':6,'ai-status-card':6};
  var hot=null,rect=null,frame=0,last=null;
  function tiltOf(el){for(var k in TILT){if(el.classList.contains(k))return TILT[k]}return 0}
  function release(el){if(!el)return;el.classList.remove('tk-live');if(el.classList.contains('tk-tilt'))el.style.transform=''}
  function onOver(e){
    if(root.getAttribute('data-fx')==='off')return;
    var el=e.target.closest&&e.target.closest(CARD);
    if(el!==hot){release(hot);hot=el;rect=el?el.getBoundingClientRect():null;if(el&&tiltOf(el))el.classList.add('tk-tilt')}
  }
  function onMove(e){
    if(!hot||e.pointerType!=='mouse'||root.getAttribute('data-fx')==='off')return;
    last=e;if(frame)return;
    frame=requestAnimationFrame(function(){
      frame=0;if(!hot||!rect)return;
      var x=last.clientX-rect.left,y=last.clientY-rect.top,px=x/rect.width-.5,py=y/rect.height-.5;
      hot.style.setProperty('--mx',x+'px');hot.style.setProperty('--my',y+'px');hot.style.setProperty('--gx',(50-px*120)+'%');
      var a=tiltOf(hot);
      if(a&&!reduce){hot.classList.add('tk-live');hot.style.transform='perspective(800px) rotateY('+(px*a).toFixed(2)+'deg) rotateX('+(-py*a).toFixed(2)+'deg) translateZ(4px)'}
    });
  }
  function refreshRect(){if(hot)rect=hot.getBoundingClientRect()}

  function init(){
    mountTools();
    document.addEventListener('pointerover',onOver,true);
    document.addEventListener('pointermove',onMove,{passive:true});
    root.addEventListener('mouseleave',function(){release(hot);hot=null});
    window.addEventListener('scroll',refreshRect,{passive:true,capture:true});
    window.addEventListener('resize',refreshRect,{passive:true});
    // 侧栏可能被重绘，保持切换按钮在位
    new MutationObserver(mountTools).observe(document.body,{childList:true,subtree:false});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();
