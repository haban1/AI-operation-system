"""Exercise the container renderer without calling any model or speech service."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from factory import ROOT, render


def main():
    (ROOT / 'runs').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='deploy-smoke-', dir=ROOT / 'runs') as directory:
        run = Path(directory)
        public = ROOT / 'video/public/runs' / run.name
        try:
            (run / 'audio').mkdir()
            subprocess.run([
                'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                'sine=frequency=440:sample_rate=48000', '-t', '1',
                str(run / 'audio/00.wav'),
            ], check=True)
            props = json.loads((ROOT / 'video/src/demo-props.json').read_text(encoding='utf-8'))
            props['durationFrames'] = 30
            props['scenes'] = [{**props['scenes'][0], 'from': 0, 'durationFrames': 30,
                                'audio': f'runs/{run.name}/audio/00.wav'}]
            (run / 'render-props.json').write_text(json.dumps(props, ensure_ascii=False), encoding='utf-8')
            render(run, stills=False)
            validation = json.loads((run / 'validation.json').read_text(encoding='utf-8'))
            assert validation['full_decode'] == 'passed'
            print(json.dumps({'ok': True, 'width': validation['width'],
                              'height': validation['height'], 'duration': validation['duration']}))
        finally:
            shutil.rmtree(public, ignore_errors=True)


if __name__ == '__main__':
    main()
