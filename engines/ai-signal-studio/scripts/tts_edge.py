"""Continuous narration; provider word timestamps drive captions and scene boundaries."""
import asyncio
import json
import subprocess
import sys
from pathlib import Path
import edge_tts
from styles import get_style
from narration_timing import plain, attach_word_timing, save_timeline



async def synthesize(spec_path, config_path, reuse=''):
    spec_path = Path(spec_path)
    folder = spec_path.parent
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    cfg = json.loads(Path(config_path).read_text(encoding='utf-8'))['tts']
    style = get_style(spec.get('style_id','baseline-v2'))
    if 'voice' in style and cfg.get('use_style_presets',True):
        cfg = {**cfg, 'edge_voice':style['voice'], 'rate':style['rate'], 'pitch':style.get('pitch','+0Hz')}
    audio = folder/'audio'
    audio.mkdir(exist_ok=True)
    paragraphs = [''.join(s['narration']) for s in spec['scenes']]
    text = ''.join(paragraphs)
    records = []
    target = audio/'narration.mp3'
    for attempt in range(3):
        if reuse == '--reuse' and target.exists() and (audio/'word-boundaries.json').exists():
            records = json.loads((audio/'word-boundaries.json').read_text(encoding='utf-8'))
            break
        records = []
        try:
            client = edge_tts.Communicate(text, cfg.get('edge_voice', 'zh-CN-YunjianNeural'),
                                          rate=cfg.get('rate', '+15%'), pitch=cfg.get('pitch','+0Hz'), boundary='WordBoundary')
            with target.open('wb') as f:
                async for item in client.stream():
                    if item['type'] == 'audio':
                        f.write(item['data'])
                    elif item['type'] == 'WordBoundary':
                        records.append(item)
            if target.stat().st_size < 1000 or not records:
                raise ValueError('语音或词时间戳为空')
            break
        except Exception:
            if attempt == 2:
                target.unlink(missing_ok=True)
                raise
            await asyncio.sleep(1 + attempt)
    (audio/'word-boundaries.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
    expected = plain(text)
    actual = plain(''.join(r['text'] for r in records))
    if actual != expected:
        raise ValueError('词时间戳与文稿不一致，停止生成以免字幕错位')
    subprocess.run(['ffmpeg','-y','-v','error','-i',str(target),'-af',
                    'highpass=f=70,loudnorm=I=-16:TP=-2:LRA=7','-ar','48000',
                    str(audio/'narration.wav')], check=True)
    duration = float(subprocess.check_output(['ffprobe','-v','error','-show_entries',
                     'format=duration','-of','default=nw=1:nk=1',str(audio/'narration.wav')]))
    words = []
    pos = 0
    for r in records:
        words.append({'text':r['text'],'startMs':r['offset']/10000,
                      'endMs':(r['offset']+r['duration'])/10000,'charFrom':pos})
        pos += len(plain(r['text']))
    attach_word_timing(spec, words, duration)
    spec.update(narrationAudio=f'runs/{folder.name}/audio/narration.wav',
                caption_timing='整篇连续合成 + TTS WordBoundary 实际时间戳',
                tts={'provider':'edge','voice':cfg.get('edge_voice','zh-CN-YunjianNeural'),
                     'rate':cfg.get('rate','+15%'),'pitch':cfg.get('pitch','+0Hz')})
    # V1 renderer remains usable with a continuous voice: cut scene audio at measured boundaries.
    if spec.get('renderer') not in ['punchy-v2','style-lab']:
        for i, scene in enumerate(spec['scenes']):
            subprocess.run(['ffmpeg','-y','-v','error','-i',str(audio/'narration.wav'),
                            '-ss',str(scene['from']/30),'-t',str(scene['durationFrames']/30),
                            str(audio/f'{i:02d}.wav')],check=True)
            scene['audio'] = f'runs/{folder.name}/audio/{i:02d}.wav'
    save_timeline(folder, spec)
    print(f'Continuous voice ready: {duration:.2f}s / {len(words)} words',flush=True)


if __name__ == '__main__':
    asyncio.run(synthesize(*sys.argv[1:]))
