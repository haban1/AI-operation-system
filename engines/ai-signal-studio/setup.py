"""Install reproducible dependencies; preserve any existing local configuration."""
import argparse
import os
import re
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'scripts'))
from runtime import load_config,voice_python


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--check',action='store_true',help='Only check system prerequisites')
    args=parser.parse_args()
    if sys.version_info<(3,9):raise SystemExit('Python 3.9 or newer is required')
    commands={name:shutil.which(name) for name in ('node','npm','ffmpeg','ffprobe','curl')}
    missing=[name for name,path in commands.items() if not path]
    if missing:raise SystemExit('Install these commands first: '+', '.join(missing))
    node_version=subprocess.check_output([commands['node'],'--version'],text=True).strip()
    if int(re.search(r'\d+',node_version).group())<20:raise SystemExit('Node.js 20 or newer is required')
    print('Prerequisites OK:',sys.version.split()[0],node_version,flush=True)
    if args.check:return
    venv_dir=ROOT/'.venv-voice'
    if not venv_dir.exists():venv.EnvBuilder(with_pip=True).create(venv_dir)
    python=voice_python({},'edge')
    subprocess.run([python,'-m','pip','install','-r',str(ROOT/'requirements-voice.txt')],check=True)
    subprocess.run([commands['npm'],'ci'],cwd=ROOT/'video',check=True,shell=os.name=='nt')
    load_config()
    print('Ready. Run: python app.py',flush=True)


if __name__=='__main__':main()
