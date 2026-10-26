"""Bounded public HTTP reads with redirect checks and local proxy support."""
import ipaddress
import socket
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit, urlunsplit

MAX_BYTES = 2_000_000


def public_url(url, resolve=False, allow_proxy_dns=False):
    if not isinstance(url,str) or len(url)>2048 or any(ord(c)<32 for c in url):
        raise ValueError('参考链接格式不正确')
    p=urlsplit(url.strip())
    if p.scheme not in ('http','https') or not p.hostname or p.username or p.password:
        raise ValueError('只支持不含登录凭据的公开 HTTP/HTTPS 网页')
    if p.port not in (None,80,443):raise ValueError('参考链接只支持标准网页端口')
    host=p.hostname.lower().rstrip('.')
    if host=='localhost' or host.endswith(('.localhost','.local','.internal')) or '.' not in host and ':' not in host:
        raise ValueError('不能将本机或内网地址作为公开资料')
    if any(k.lower() in {'token','api_key','apikey','access_token','authorization','password'} for k in parse_qs(p.query)):
        raise ValueError('参考链接不能包含 Token 或密码')
    literal=True
    try:addresses=[ipaddress.ip_address(host)]
    except ValueError:
        literal=False
        addresses=[ipaddress.ip_address(x[4][0]) for x in socket.getaddrinfo(host,p.port or 443,type=socket.SOCK_STREAM)] if resolve else []
    # Local HTTP proxies such as Clash use this benchmark range for fake DNS.
    # Only a configured loopback proxy can resolve it; literal reserved targets
    # and every other private/reserved range remain forbidden.
    fake_dns=ipaddress.ip_network('198.18.0.0/15')
    if any(not a.is_global and not (allow_proxy_dns and not literal and a in fake_dns) for a in addresses):
        raise ValueError('不能读取本机、内网或保留地址')
    return urlunsplit((p.scheme,p.netloc,p.path or '/',p.query,''))


def proxy_dns_allowed(url,proxies):
    proxy=proxies.get(urlsplit(url).scheme,'')
    p=urlsplit(proxy)
    if p.scheme!='http' or p.username or p.password:return False
    try:return ipaddress.ip_address(p.hostname or '').is_loopback
    except ValueError:return p.hostname=='localhost'


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self,proxies=None):
        self.proxies=proxies or {}
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        public_url(newurl,resolve=True,allow_proxy_dns=proxy_dns_allowed(newurl,self.proxies))
        return super().redirect_request(req,fp,code,msg,headers,newurl)


class PublicProxy(urllib.request.ProxyHandler):
    def proxy_open(self,req,proxy,scheme):
        if proxy_dns_allowed(req.full_url,self.proxies):
            # macOS bypass lists may classify fake-DNS public destinations as
            # private. Route these validated public requests through the proxy.
            public_url(req.full_url,resolve=True,allow_proxy_dns=True)
            req.set_proxy(urlsplit(proxy).netloc,'http')
            return None
        return super().proxy_open(req,proxy,scheme)


def read_public(url, accept=None):
    proxies=urllib.request.getproxies()
    url=public_url(url,resolve=True,allow_proxy_dns=proxy_dns_allowed(url,proxies))
    # This opener has no model credentials or cookies. Honor the machine's
    # configured HTTP proxy so public reads also work with local fake-IP DNS.
    opener=urllib.request.build_opener(PublicProxy(proxies),PublicRedirect(proxies))
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; AISignalResearch/1.0)',
                                          'Accept':accept or 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.9'})
    try:
        with opener.open(req,timeout=20) as response:
            final=public_url(response.geturl(),resolve=True,allow_proxy_dns=proxy_dns_allowed(response.geturl(),proxies))
            mime=response.headers.get_content_type()
            if not any(x in mime for x in ('text/','html','xml','json')):
                raise ValueError('该链接不是可读取的网页或文本，请提供网页版本')
            raw=response.read(MAX_BYTES+1)
            if len(raw)>MAX_BYTES:raise ValueError('网页过大，已跳过')
            return raw.decode(response.headers.get_content_charset() or 'utf-8',errors='replace'),final,mime
    except urllib.error.HTTPError as error:
        raise ValueError(f'网页返回 HTTP {error.code}') from None
    except (urllib.error.URLError,TimeoutError,OSError):
        raise ValueError('网页连接失败或超时') from None
