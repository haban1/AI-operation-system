"""Sentence-level Speech API audio; captions use measured clips, not invented word times."""
import json
import math
import re
import subprocess
import wave
from pathlib import Path
from speech_api import require_speech, speech_bytes
from narration_timing import save_timeline


def phrases(lines):
    result = []
    for line in lines:
        for sentence in re.findall(r'[^。！？!?]+[。！？!?]?', line):
            if len(sentence) <= 36: result.append(sentence)
            else:
                pieces = re.findall(r'[^，；：,;:]+[，；：,;:]?',sentence)
                current = ''
                for piece in pieces:
                    if current and len(current+piece) > 36:
                        result.append(current);current=''
                    current += piece
                if current:result.append(current)
    return result


def synthesize(run, settings):
    require_speech(settings)
    run=Path(run);spec=json.loads((run/'script.json').read_text(encoding='utf-8'))
    audio=run/'audio';audio.mkdir(exist_ok=True)
    sr=48000;chunks=[];samples=0
    def pause(seconds):
        nonlocal samples
        n=round(seconds*sr);chunks.append(b'\0'*(n*2));samples+=n
    for i,scene in enumerate(spec['scenes']):
        begin=round(samples/sr*30)
        captions=[];pause(.18)
        for j,text in enumerate(phrases(scene['narration'])):
            source=audio/f'api-{i:02d}-{j:02d}-raw.wav';out=audio/f'api-{i:02d}-{j:02d}.wav'
            source.write_bytes(speech_bytes(settings,text))
            subprocess.run(['ffmpeg','-y','-v','error','-i',str(source),'-ac','1','-ar',str(sr),'-c:a','pcm_s16le',str(out)],check=True)
            with wave.open(str(out),'rb') as w: pcm=w.readframes(w.getnframes())
            duration=len(pcm)//2
            if duration < sr*.12: raise ValueError('语音文件过短，请检查模型输出')
            origin=begin*1000/30
            captions.append({'text':text,'startMs':round(samples/sr*1000-origin),
                'endMs':round((samples+duration)/sr*1000-origin),'timestampMs':None,'confidence':None})
            chunks.append(pcm);samples+=duration
            pause(.10)
        pause(.14)
        # End on an exact video frame to keep subsequent caption offsets deterministic.
        frames=math.ceil(samples/sr*30)
        padding=round(frames/30*sr)-samples
        chunks.append(b'\0'*(padding*2));samples+=padding
        scene.update({'from':begin,'durationFrames':frames-begin,'audio':'','captions':captions,
                      'speechStartFrame':5,'cueFrames':[]})
    # Keep the final pause in the source audio as well as in the composition
    # duration, so API-generated narration has the same natural landing space.
    tail = round(float(spec.get('tailSeconds', .32)) * sr)
    chunks.append(b'\0' * (tail * 2)); samples += tail
    spec['scenes'][-1]['durationFrames'] = round(samples/sr*30) - spec['scenes'][-1]['from']
    raw=audio/'narration-raw.wav'
    with wave.open(str(raw),'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(sr);w.writeframes(b''.join(chunks))
    subprocess.run(['ffmpeg','-y','-v','error','-i',str(raw),'-af','highpass=f=70,loudnorm=I=-17:TP=-2:LRA=9','-ar',str(sr),str(audio/'narration.wav')],check=True)
    spec.update(durationFrames=round(samples/sr*30),narrationAudio=f'runs/{run.name}/audio/narration.wav',
        caption_timing='逐自然句合成，使用音频实测区间；没有逐词时间戳',
        tts={'provider':'openai','model':settings['openai_model'],'voice':settings['openai_voice']})
    if spec.get('renderer') not in ['style-lab','punchy-v2']:
        for i,scene in enumerate(spec['scenes']):
            subprocess.run(['ffmpeg','-y','-v','error','-i',str(audio/'narration.wav'),'-ss',str(scene['from']/30),'-t',str(scene['durationFrames']/30),str(audio/f'{i:02d}.wav')],check=True)
            scene['audio']=f'runs/{run.name}/audio/{i:02d}.wav'
    save_timeline(run,spec)
    print('Speech API narration ready; sentence timing measured',flush=True)
