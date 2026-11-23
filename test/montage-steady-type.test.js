import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { createProject, editProject } from '../engines/montage15/src/domain.mjs';
import { Store } from '../engines/montage15/src/store.mjs';
import { applyAiPlan } from '../engines/montage15/src/ai-editing.mjs';
import { templateAudio } from '../engines/montage15/src/audio.mjs';
import { buildMontageHtml, montageTemplates } from '../engines/montage15/src/montage15.mjs';

const template = montageTemplates.find(t => t.id === 'steady-type');
const keys = ['title', 'beat1', 'beat2', 'beat3', 'beat4', 'beat5'];
const edits = ['开场见面', '跟着讲师', '现场试一试', '写下步骤', '一起 <观察>', '今天再见'];
const textFields = Object.fromEntries(keys.map((key, i) => [key, edits[i]]));
const locked = { fields: ['beat4', 'beat5'], slots: ['shot-6'], settings: [], audio: false };
const fontIndependentColors = ['#2d7055', '#685e46', '#a76751', '#773b60', '#51486f', '#345e72'];
const changeWithAi = (p, key) => applyAiPlan(p, [], {scope: {kind:'all'}, mode:'edit', instruction:'替换文案'}, {
  message:'测试文案', warnings:[], operations:[{type:'field', target:key, text:'替换后的字幕'}],
});

test('六个镜头、六段替换字幕和锁在保存修订后可重新打开', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'montage-steady-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const store = new Store(root);
  await store.init();
  const original = createProject(template, {format:'portrait'});
  await store.saveProject(original);
  const modified = editProject(original, {expectedRevision:original.revision,
    fields:{...original.fields, ...textFields}, locks:locked,
  }, template, []);
  await store.saveProject(modified);
  const reopened = await new Store(root).get('projects',modified.id);
  assert.deepEqual(reopened.templateSnapshot.slots.map(s => s.startFrame), [0,70,141,225,309,380]);
  assert.deepEqual(reopened.slots.map(s => s.id), keys.map((_,i) => 'shot-'+(i+1)));
  assert.deepEqual(reopened.templateSnapshot.cards.map(c => c.key), keys);
  assert.deepEqual(keys.map(k => reopened.fields[k]), edits);
  assert.deepEqual(reopened.locks, locked);
  for (const key of ['beat4','beat5']) assert.throws(() => changeWithAi(reopened,key), {code:'AI_LOCKED'});
  assert.deepEqual((await store.revision(modified.id,original.revision)).fields,original.fields);
});

test('旧模板不保存额外字幕，不能对未声明的字段上锁或通过 AI 修改', () => {
  const legacy = montageTemplates.find(t => t.id === 'perspective-flow');
  const project = createProject(legacy);
  const changed = editProject(project, {expectedRevision:project.revision,
    fields:{...project.fields, beat4:'额外字幕', beat5:'额外收尾'},
  }, legacy, []);
  for(const key of ['beat4','beat5']){
    assert.equal(Object.hasOwn(changed.fields,key),false);
    assert.throws(() => changeWithAi(project,key),{code:'AI_INVALID_FIELD'});
    assert.throws(() => editProject(project, {expectedRevision:project.revision,locks:{...locked,fields:[key]}},legacy,[]),{code:'INVALID_SELECTION'});
  }
});

test('模板配乐和转场音效来自不同音轨，可分别调节与关闭', async () => {
  const original = createProject(template);
  const stems = (musicEnabled,sfxEnabled) => templateAudio(template,{...original,
    audio:{...original.audio,volume:.32,sfxVolume:.61,musicEnabled,sfxEnabled},
  });
  const [music,sfx] = stems(true,true);
  assert.deepEqual([music.role,music.volume,sfx.role,sfx.volume],['music',.32,'sfx',.61]);
  assert.notEqual(music.file,sfx.file);
  assert.deepEqual(stems(true,false),[music]);
  assert.deepEqual(stems(false,true),[sfx]);
  assert.deepEqual(stems(false,false),[]);
  for(const stem of [music,sfx]){
    const file = new URL('../engines/montage15/templates/montage15/audio/'+stem.file,import.meta.url);
    assert.equal((await readFile(file)).toString('ascii',0,4), 'RIFF');
  }
});

const executablePath = [process.env.CHROME_EXECUTABLE_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
const gsapFile = new URL('../engines/montage15/vendor/gsap.min.js',import.meta.url);
for(const [format, interactive] of [['portrait',true],['landscape',false]]) {
  test('稳镜字幕 '+(interactive?'竖屏预览':'横屏渲染')+'按 GSAP 时钟定位，画面与焦点在镜内保持不动', {skip:!executablePath}, async t => {
    const browser = await chromium.launch({headless:true,executablePath});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const gsap = await readFile(gsapFile);
    const errors = [];
    page.on('pageerror',e => errors.push(e.message));
    const draft = createProject(template,{format});
    const assets = template.slots.map((_,i) => ({id:'fixture-'+i,type:'image',url:'/frame-'+i+'.svg'}));
    const project = editProject(draft,{
      expectedRevision:draft.revision, fields:{...draft.fields,...textFields},
      slots:draft.slots.map((s,i) => ({...s,assetId:assets[i].id,focusX:.35,focusY:.57})),
      audio:{...draft.audio,musicEnabled:false,sfxEnabled:false},
    },template,assets);
    const renderPage = async titles => {
      const p={...project,settings:{...project.settings,titles}};
      await page.route('http://fixture.test/**',r=>{
        const pathname = new URL(r.request().url()).pathname;
        if(pathname==='/')return r.fulfill({contentType:'text/html; charset=utf-8',body:buildMontageHtml(template,p,assets,{interactive})});
        if(pathname==='/vendor/gsap.min.js')return r.fulfill({contentType:'application/javascript',body:gsap});
        const image=/^\/frame-(\d)\.svg$/.exec(pathname);
        if(image)return r.fulfill({contentType:'image/svg+xml',
          body:'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="'+fontIndependentColors[+image[1]]+'"/><path d="M200 0v200" stroke="white" stroke-width="3"/></svg>',
        });
        return r.fulfill({status:404,body:''});
      });
      await page.goto('http://fixture.test/');
    };
    const seek=async (time)=>page.evaluate(({time,interactive})=>{
      if(interactive)window.__workbench.seek(Math.round(time*30));
      else window.__timelines.main.seek(time,false);
      const cards=[...document.querySelectorAll('.title-card')].filter(c=>{
        const style=getComputedStyle(c);
        return style.visibility!=='hidden' && Number(style.opacity)>.5;
      });
      const visible=[...document.querySelectorAll('.scene')].filter(e=>{
        const s=getComputedStyle(e);
        return s.visibility!=='hidden' && Number(s.opacity)>.98;
      });
      return {labels:cards.map(c=>c.querySelector('h1').getAttribute('aria-label')),visible:visible.map(e=>e.id),
        geometry:visible.map(e=>{
          const v=e.querySelector('.view'),a=e.querySelector('.visual'),c=getComputedStyle(a);
          return [getComputedStyle(v).transform,c.objectFit,c.objectPosition,v.offsetWidth-e.offsetWidth,v.offsetHeight-e.offsetHeight];
        })};
    },{time,interactive});
    await renderPage(true);
    // Revisit earlier frames after all later cuts. Paused timelines must not depend on playback history.
    for (const i of [0,1,2,3,4,5,0,4,1]){
      const card=template.cards[i], mid=(card.start+card.end)/2;
      const expected={labels:[edits[i]],visible:['shot-'+(i+1)],geometry:[['none','cover','35% 57%',0,0]]};
      assert.deepEqual(await seek(mid),expected);
      assert.deepEqual(await seek(mid+.10),expected);
    }
    await page.unroute('http://fixture.test/**');
    await renderPage(false);
    assert.deepEqual((await seek(5.9)).labels,[]);
    assert.deepEqual(errors,[]);
  });
}
