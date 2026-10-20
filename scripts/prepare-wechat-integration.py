"""Prepare integration settings and a fresh Tianhe-owned PostgreSQL database."""
import argparse
import datetime
import json
from pathlib import Path
import re
import secrets
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-api', default='weixin_robot-api-1')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    destination = root / '.env.wechat'
    database_env = root / '.env.wechat-db'
    if destination.exists():
        if not database_env.exists():
            raise RuntimeError('Existing WeChat settings found without .env.wechat-db; configure the database explicitly before starting')
        print('.env.wechat already exists; existing configuration retained.')
        return
    tianhe_env = root / '.env.docker'
    text = tianhe_env.read_text(encoding='utf-8')
    info = json.loads(subprocess.check_output(['docker', 'inspect', args.source_api]))[0]
    env = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
    config_source = (root / 'wechat-assistant/app/core/config.py').read_text(encoding='utf-8')
    keys = {match.upper() for match in re.findall(r'^    ([a-z][a-z0-9_]*):', config_source, re.M)}
    values = {key: value for key, value in env.items() if key in keys}
    if database_env.exists():
        db_values = dict(line.split('=', 1) for line in database_env.read_text(encoding='utf-8').splitlines() if '=' in line)
        password = db_values['POSTGRES_PASSWORD']
    else:
        password = secrets.token_hex(32)
    from urllib.parse import quote
    values['DATABASE_URL'] = 'postgresql+psycopg://agent:' + quote(password, safe='') + '@wechat-db:5432/agent'
    backup = root / 'backups' / ('wechat-config-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    backup.mkdir(parents=True)
    (backup / 'original-api-inspect.json').write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
    for key, target in [('RAG_RETRIEVAL_BEARER_TOKEN', 'TIANHE_RAG_TOKEN'), ('TIANHE_ADMIN_TOKEN', 'TIANHE_ADMIN_TOKEN'), ('TIANHE_MODEL_TOKEN', 'TIANHE_MODEL_TOKEN')]:
        found = re.search(r'^' + key + r'=(.*)$', text, re.M)
        token = found.group(1).strip() if found else ''
        if not token or token.startswith('replace-with-'):
            token = secrets.token_urlsafe(40)
            text = re.sub(r'^' + key + r'=.*\n?', '', text, flags=re.M).rstrip() + '\n' + key + '=' + token + '\n'
        values[target] = token
    # dotenv double quotes, including Compose's dollar interpolation escaping.
    encoded = '\n'.join(key + '=' + json.dumps(value, ensure_ascii=False).replace('$', '$$') for key, value in sorted(values.items())) + '\n'
    tianhe_env.write_text(text, encoding='utf-8')
    if not database_env.exists():
        database_env.write_text('POSTGRES_USER=agent\nPOSTGRES_DB=agent\nPOSTGRES_PASSWORD=' + password + '\n', encoding='utf-8')
    destination.write_text(encoded, encoding='utf-8')
    print('Prepared .env.wechat, .env.wechat-db and dedicated service tokens. Configuration backup:', backup)
    print('Customer-service records are not imported; PostgreSQL is owned by the Tianhe Compose project.')
    print('No running container or WeChat session was changed.')


if __name__ == '__main__':
    main()
