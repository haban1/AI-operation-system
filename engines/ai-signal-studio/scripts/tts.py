"""One model load, fixed voice, individual phrases with measured timing."""
import argparse
import json
import math
import subprocess
from pathlib import Path
import mlx.core as mx
import numpy as np
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model

def run(spec_path, config_path):
    spec_path = Path(spec_path)
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    config = json.loads(Path(config_path).read_text(encoding='utf-8'))['tts']
    folder = spec_path.parent
    audio_dir = folder / 'audio'; audio_dir.mkdir(exist_ok=True)
    model = load_model(config['model'])
    timeline = 0
    all_captions = []
    fps = 30
    for i, scene in enumerate(spec['scenes']):
        pieces, captions = [], []
        offset = 0.16
        sr = 24000
        pieces.append(np.zeros(int(sr * offset), dtype=np.float32))
        for j, text in enumerate(scene['narration']):
            mx.random.seed(20260908)
            results = list(model.generate(text=text, voice=config['voice'], instruct=config['instruction'], lang_code='zh', max_tokens=1000, temperature=0.35, top_k=24, top_p=0.86, repetition_penalty=1.08, stream=False))
            if not results:
                raise RuntimeError('TTS 未产生音频')
            sr = results[0].sample_rate
            if sr != 24000:
                raise ValueError('此流水线预期 Qwen 24kHz 输出')
            audio = np.concatenate([np.asarray(r.audio, dtype=np.float32) for r in results])
            duration = len(audio) / sr
            captions.append({'text': text, 'startMs': round(offset * 1000), 'endMs': round((offset + duration) * 1000), 'timestampMs': None, 'confidence': None})
            pieces.extend([audio, np.zeros(int(sr * 0.08), dtype=np.float32)])
            offset += duration + 0.08
            print(f'voice {i+1}/{len(spec["scenes"])} phrase {j+1}: {duration:.2f}s', flush=True)
        pieces.append(np.zeros(int(sr * 0.20), dtype=np.float32))
        raw = audio_dir / f'{i:02d}-raw.wav'
        out = audio_dir / f'{i:02d}.wav'
        audio_write(str(raw), np.concatenate(pieces), sr, format='wav')
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(raw), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9', '-ar', '48000', str(out)], check=True)
        probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_format', '-of', 'json', str(out)]))
        scene['durationFrames'] = math.ceil(float(probe['format']['duration']) * fps)
        scene['from'] = timeline
        scene['audio'] = f'runs/{folder.name}/audio/{i:02d}.wav'
        scene['captions'] = captions
        all_captions += [{**c, 'startMs': c['startMs'] + round(timeline / fps * 1000), 'endMs': c['endMs'] + round(timeline / fps * 1000)} for c in captions]
        timeline += scene['durationFrames']
    spec['durationFrames'] = timeline
    spec['caption_timing'] = '逐短句合成，使用各音频文件实测时长；非逐字 ASR 对齐'
    spec['tts'] = {k: config[k] for k in ('model', 'voice', 'instruction')}
    (folder / 'render-props.json').write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding='utf-8')
    (folder / 'captions.json').write_text(json.dumps(all_captions, ensure_ascii=False, indent=2), encoding='utf-8')
    def clock(ms):
        return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d},{ms%1000:03d}'
    (folder / 'captions.srt').write_text('\n\n'.join(f'{i+1}\n{clock(c["startMs"])} --> {clock(c["endMs"])}\n{c["text"]}' for i,c in enumerate(all_captions)) + '\n', encoding='utf-8')
    print(f'Finished: {timeline/fps:.2f}s', flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('spec'); parser.add_argument('config')
    args = parser.parse_args(); run(args.spec, args.config)
