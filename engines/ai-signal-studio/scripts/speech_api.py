"""OpenAI-compatible speech. Speech credentials are isolated from writing credentials."""
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

DEFAULTS = {
    'openai_base_url': 'https://api.openai.com/v1',
    'openai_model': 'gpt-4o-mini-tts',
    'openai_voice': 'coral',
    'openai_instructions': '用自然、克制的普通话，像向朋友讲解一个科技工具。根据语义停顿，重点词轻轻强调，不用新闻播报腔，不刻意兴奋。',
}

def normalize_speech(values, previous=None):
    previous = previous or {}
    result = {**DEFAULTS, **{k:v for k,v in previous.items() if k != 'openai_api_key'}}
    for key in DEFAULTS:
        value = values.get(key, result[key])
        if not isinstance(value, str) or not value.strip() or len(value) > 1200:
            raise ValueError('请填写有效的语音服务设置')
        result[key] = value.strip()
    parsed = urlsplit(result['openai_base_url'])
    if (parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment):
        raise ValueError('语音地址不能包含Token、账号或查询参数')
    if parsed.scheme == 'http' and parsed.hostname not in {'localhost','127.0.0.1','::1'}:
        raise ValueError('远程语音服务请使用HTTPS')
    try: parsed.port
    except ValueError: raise ValueError('语音服务端口不正确') from None
    path = parsed.path.rstrip('/')
    if path.endswith('/audio/speech'): path = path[:-len('/audio/speech')]
    result['openai_base_url'] = urlunsplit((parsed.scheme, parsed.netloc, path, '', ''))
    token = values.get('openai_api_key', '')
    if not isinstance(token, str) or '\n' in token or '\r' in token:
        raise ValueError('语音Token格式不正确')
    if token.strip(): result['openai_api_key'] = token.strip()
    elif previous.get('openai_base_url') == result['openai_base_url'] and previous.get('openai_api_key'):
        result['openai_api_key'] = previous['openai_api_key']
    return result

def token(settings):
    return settings.get('openai_api_key') or os.environ.get('VIDEO_TTS_API_KEY', '')

def public_speech(settings):
    return {**{k:v for k,v in settings.items() if k != 'openai_api_key'},
            'openai_api_key_configured': bool(token(settings))}

def stored_speech(settings):
    return {k:v for k,v in settings.items() if k not in {'openai_api_key','openai_api_key_configured'}}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def require_speech(settings):
    if settings.get('provider') == 'openai' and not token(settings):
        raise ValueError('请在模型设置中填写独立的语音Token；文稿Token不会自动用于语音服务')

def speech_bytes(settings, text):
    settings = normalize_speech(settings, settings)
    if not token(settings):
        raise ValueError('请先填写语音Token')
    body = {'model':settings['openai_model'], 'voice':settings['openai_voice'],
            'input':text, 'response_format':'wav'}
    if not settings['openai_model'].startswith('tts-1'):
        body['instructions'] = settings['openai_instructions']
    request = urllib.request.Request(settings['openai_base_url']+'/audio/speech',
        data=json.dumps(body).encode(), headers={'Content-Type':'application/json',
        'Authorization':'Bearer '+token(settings)})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
            result = response.read(20_000_001)
        if len(result) > 20_000_000 or len(result) < 44 or result[:4] != b'RIFF' or result[8:12] != b'WAVE':
            raise ValueError('语音服务没有返回WAV音频，请检查接口兼容性')
        return result
    except urllib.error.HTTPError as error:
        code = error.code
        reason = {401:'语音Token无效',403:'无语音模型权限',404:'此地址或模型不支持/audio/speech',
                  429:'语音额度不足或请求过快'}.get(code,'请检查语音接口兼容性')
        raise ValueError(f'语音服务 HTTP {code}：{reason}') from None
    except (urllib.error.URLError, TimeoutError):
        raise ValueError('语音服务连接失败或超时') from None
