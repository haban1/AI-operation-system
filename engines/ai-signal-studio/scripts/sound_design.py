import json,wave,sys
from pathlib import Path
import numpy as np
from styles import get_style
run=Path(sys.argv[1]);p=json.loads((run/'render-props.json').read_text(encoding='utf-8'));sr=48000;duration=p['durationFrames']/30
N=int((duration+.5)*sr);music=np.zeros(N);fx=np.zeros(N);rng=np.random.default_rng(36)
def add(dest,a,t):
 i=int(t*sr);j=min(N,i+len(a));dest[i:j]+=a[:j-i]
def tone(freq,d,vol=.1):
 t=np.arange(int(d*sr))/sr;return vol*np.sin(2*np.pi*freq*t)*(1-np.exp(-t*100))*np.exp(-t*5)
style=get_style(p.get('style_id','baseline-v2'))
if p.get('pacing') == 'conversational':
 # A quiet harmonic bed without a metronomic beat or a thump on every scene.
 t=np.arange(N)/sr
 envelope=np.sin(np.pi*np.clip(t/duration,0,1))**2
 for freq in [130.81,196,261.63]:
  music += .012*np.sin(2*np.pi*freq*t)*(.8+.2*np.sin(t*.4))*envelope
 # Duck under spoken groups, with smooth 0.2 s attacks and releases.
 frames=np.arange(int(duration*30)+20)/30
 duck=np.ones(len(frames))
 for scene in p['scenes']:
  for c in scene['captions']:
   begin=scene['from']/30+c['startMs']/1000
   end=scene['from']/30+c['endMs']/1000
   strength=np.minimum(np.clip((frames-begin+.12)/.2,0,1),np.clip((end+.22-frames)/.22,0,1))
   duck=np.minimum(duck,1-.65*strength)
 music *= np.interp(t,frames,duck)
 for scene in p['scenes']:
  if scene['type']=='stats':add(fx,tone(660,.18,.022),scene['from']/30+.06)
 p['audioMix']={'music':.55,'effects':.35}
 p['soundDesign']='低音量和声底乐 + 旁白自动压低 + 仅数字场景轻提示'
else:
 beat=60/style.get('bpm',112)
 for i in range(int(duration/beat)+1):
  t=np.arange(int(.25*sr))/sr
  if i%2==0:add(music,.16*np.sin(2*np.pi*(47*t+25*(1-np.exp(-t*28))/28))*np.exp(-t*18),i*beat)
  if i%2==1:add(music,rng.normal(0,1,len(t))*.035*np.exp(-t*32),i*beat)
  for q in [0,.5]:
   t2=np.arange(int(.065*sr))/sr;noise=rng.normal(0,1,len(t2));noise=np.diff(noise,prepend=0)
   add(music,noise*.012*np.exp(-t2*80),(i+q)*beat)
  notes=[164.81,196,246.94,293.66,220,246.94,196,146.83]
  add(music,tone(notes[i%8],.7,.075),i*beat)
  if i%2==0:add(music,tone(notes[(i+2)%8]*2,.45,.04),i*beat+beat*.75)
 for i,s in enumerate(p['scenes']):
  start=s['from']/30
  t=np.arange(int(.22*sr))/sr
  noise=rng.normal(0,1,len(t));env=np.sin(np.pi*t/.22)**2
  add(fx,.018*noise*env,start)
  add(fx,.11*np.sin(2*np.pi*(150*t-180*t*t))*np.exp(-t*22),start)
  if s.get('shot') in ['focus','export']:
   add(fx,tone(1400,.065,.07),start+.55)
fade=np.minimum(1,np.arange(N)/sr/.25)*np.clip((duration-np.arange(N)/sr)/.7,0,1)
for name,a in [('music',music*fade),('effects',fx)]:
 with wave.open(str(run/'audio'/f'{name}.wav'),'w') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr);w.writeframes((np.clip(a,-.9,.9)*32767).astype('<i2').tobytes())
p.update(musicAudio=f'runs/{run.name}/audio/music.wav',effectsAudio=f'runs/{run.name}/audio/effects.wav',assetBase=f'runs/{run.name}')
(run/'render-props.json').write_text(json.dumps(p,ensure_ascii=False,indent=2), encoding='utf-8')
print(p.get('soundDesign') or f"Original sound bed: {style.get('bpm',112)} BPM")
