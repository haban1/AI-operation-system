"""Resolve runtime files relative to the checkout, independent of the old machine."""
import json
import os
import re
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def config_path(root=ROOT):
    """Keep private settings outside the media/data volumes in deployments."""
    directory=os.environ.get('SIGNAL_CONFIG_DIR','').strip()
    return (Path(directory).expanduser() if directory else Path(root))/'config.json'


def base_path():
    value=os.environ.get('SIGNAL_BASE_PATH','/').strip() or '/'
    value='/'+value.strip('/')+'/' if value.strip('/') else '/'
    if not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)*',value):
        raise ValueError('SIGNAL_BASE_PATH must contain plain URL path segments')
    return value


def public_url(path):
    """Build a browser URL from an engine-local path, leaving stored data portable."""
    return base_path()+str(path).lstrip('/')


def load_config(root=ROOT):
    root=Path(root)
    for name in ('runs','data'):
        (root/name).mkdir(parents=True,exist_ok=True)
    path=config_path(root)
    path.parent.mkdir(parents=True,exist_ok=True)
    if not path.exists():
        example=json.loads((root/'config.example.json').read_text(encoding='utf-8'))
        try:
            with path.open('x',encoding='utf-8') as file:
                json.dump(example,file,ensure_ascii=False,indent=2)
                file.write('\n')
        except FileExistsError:
            pass
    return json.loads(path.read_text(encoding='utf-8'))


def voice_python(settings, provider, root=ROOT):
    root=Path(root)
    configured=settings.get('edge_python' if provider=='edge' else 'python','')
    if configured:
        path=Path(configured).expanduser()
        if not path.is_absolute():path=root/path
    elif provider=='edge':
        path=root/'.venv-voice'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    else:
        path=Path(sys.executable)
    if not path.is_file():
        raise ValueError('配音Python环境不存在，请先运行 python setup.py 或更新本地配置')
    # Keep the venv executable path, rather than resolving its interpreter symlink.
    return str(path.absolute())
