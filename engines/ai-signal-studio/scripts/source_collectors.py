"""Source adapters. Public feeds never receive cookies; MCP only calls read tools."""
import hashlib
import json
import os
import re
import urllib.request
import urllib.error
from urllib.parse import quote, urlencode, urljoin, urlsplit
from xml.etree import ElementTree as ET

from collect import fetch, now, plain
from public_web import public_url

SOURCE_NAMES = {'github':'GitHub', 'hackernews':'Hacker News', 'reddit':'Reddit',
                'weibo':'微博', 'xiaohongshu':'小红书'}
DEFAULTS = {**{k:True for k in SOURCE_NAMES}, 'xhs_keywords':['人工智能'],
            'xhs_note_type':'不限', 'rss':[{'name':'IT之家', 'url':'https://www.ithome.com/rss/'}]}


def normalize_sources(value=None):
    if value is None:value=DEFAULTS
    if not isinstance(value,dict):raise ValueError('采集设置格式不正确')
    result={}
    for key in SOURCE_NAMES:
        enabled=value.get(key,DEFAULTS[key])
        if type(enabled) is not bool:raise ValueError('来源开关必须为布尔值')
        result[key]=enabled
    words=value.get('xhs_keywords',DEFAULTS['xhs_keywords'])
    if not isinstance(words,list) or not 1<=len(words)<=3 or any(not isinstance(w,str) or not 1<=len(w.strip())<=40 for w in words):
        raise ValueError('小红书关键词需填写1至3个，每个最多40字')
    result['xhs_keywords']=list(dict.fromkeys(w.strip() for w in words))
    kind=value.get('xhs_note_type','不限')
    if kind not in ('不限','图文','视频'):raise ValueError('小红书内容类型不正确')
    result['xhs_note_type']=kind
    feeds=value.get('rss',DEFAULTS['rss'])
    if not isinstance(feeds,list) or len(feeds)>10:raise ValueError('最多添加10个RSS订阅')
    result['rss']=[];seen=set()
    for feed in feeds:
        if not isinstance(feed,dict) or not isinstance(feed.get('name'),str) or not 1<=len(feed['name'].strip())<=40:
            raise ValueError('RSS名称需填写1至40个字')
        url=public_url(feed.get('url'))
        if url not in seen:result['rss'].append({'name':feed['name'].strip(),'url':url});seen.add(url)
    return result


def rss_key(url):return 'rss:'+hashlib.sha256(url.encode()).hexdigest()[:16]


def number(value):
    if isinstance(value,bool):return None
    try:
        text=str(value).strip().replace(',','').rstrip('+')
        multiple=10000 if text.endswith('万') else 100000000 if text.endswith('亿') else 1
        return max(0,int(float(text[:-1] if multiple!=1 else text)*multiple))
    except (ValueError,TypeError,OverflowError):return None


def item(source_key, source, external_id, title, url, stamp, **extra):
    title=plain(str(title))[:160]
    if len(title)<2:raise ValueError('标题为空或过短')
    return {'id':source_key+':'+str(external_id), 'external_id':str(external_id),
            'source_key':source_key, 'source':source, 'title':title, 'description':'',
            'url':public_url(url), 'collected_at':stamp, 'published_at':None,
            'content_type':'topic', 'metrics':[], **extra}


def parse_weibo(raw, stamp):
    data=json.loads(raw).get('data',{})
    rows=data.get('realtime') if isinstance(data,dict) else None
    if not isinstance(rows,list) or not rows:raise ValueError('微博未返回热榜，可能需要登录或验证')
    output=[]
    for index,row in enumerate(rows[:50],1):
        if not isinstance(row,dict) or row.get('is_ad'):continue
        title=row.get('word') or row.get('note')
        if not title:continue
        heat=number(row.get('num',row.get('raw_hot')))
        rank=row.get('rank',index)
        if type(rank) is not int or not 1<=rank<=50:continue
        output.append(item('weibo','微博',hashlib.sha256(title.encode()).hexdigest()[:20],title,
            'https://s.weibo.com/weibo?'+urlencode({'q':'#'+title+'#'}),stamp,
            rank=rank,discovery='微博热搜 · 官方网页榜单',metrics=[{'label':'热搜热度','value':heat}],
            evidence_url='https://weibo.com/hot/search'))
    if not output:raise ValueError('微博热榜格式已变化')
    return output


class WeiboNoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):raise ValueError('微博浏览器服务地址发生重定向，请检查本机配置')


def fetch_weibo():
    # Only the local browser service receives this narrowly scoped credential.
    base=os.environ.get('SIGNAL_WEIBO_AGENT_URL','').strip().rstrip('/')
    token=os.environ.get('SIGNAL_WEIBO_AGENT_TOKEN','').strip()
    if not base or not token:raise ValueError('微博热点尚未连接本机登录浏览器，请配置微博浏览器采集服务')
    p=urlsplit(base)
    if (p.scheme!='http' or p.hostname not in ('127.0.0.1','localhost','host.docker.internal','::1') or
        p.username or p.password or p.query or p.fragment or p.path):
        raise ValueError('微博浏览器服务只支持本机 HTTP 地址')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),WeiboNoRedirect())
    req=urllib.request.Request(base+'/platforms/weibo/hot-topics',headers={'X-Signal-Token':token,'Accept':'application/json'})
    try:
        with opener.open(req,timeout=60) as response:
            raw=response.read(1_000_001)
            if len(raw)>1_000_000:raise ValueError('微博热榜响应过大')
    except urllib.error.HTTPError as error:
        if error.code in (401,403):raise ValueError('微博浏览器采集连接鉴权失败，请更新本机采集凭据；这不是微博账号未登录') from None
        if error.code==404:raise ValueError('本机浏览器服务版本过旧，请更新并重启浏览器执行端') from None
        try:detail=json.loads(error.read(8192)).get('message','')
        except (ValueError,OSError):detail=''
        raise ValueError(str(detail)[:250] or '微博浏览器服务暂不可用，请稍后重试') from None
    except (OSError,TimeoutError):raise ValueError('无法连接本机微博浏览器服务，请确认浏览器执行端已启动') from None
    try:data=json.loads(raw)
    except ValueError:raise ValueError('微博浏览器服务返回了无效数据') from None
    if not isinstance(data,dict) or data.get('ok') is not True or data.get('transport')!='logged-in-browser':
        raise ValueError('微博浏览器服务未确认采集成功')
    return json.dumps(data,ensure_ascii=False)


def parse_rss(raw, feed, stamp):
    # Entity declarations are unnecessary for RSS and can expand untrusted input.
    if re.search(r'<!\s*(DOCTYPE|ENTITY)',raw,re.I):raise ValueError('RSS包含不支持的实体声明')
    root=ET.fromstring(raw)
    local=lambda tag:tag.rsplit('}',1)[-1].lower()
    if local(root.tag) not in ('rss','feed','rdf'):raise ValueError('网址未返回RSS/Atom订阅，请检查订阅地址')
    output=[];seen=set();key=rss_key(feed['url'])
    for entry in (n for n in root.iter() if local(n.tag) in ('item','entry')):
        fields={};link=''
        for child in entry:
            name=local(child.tag)
            fields[name]=''.join(child.itertext()).strip()
            if name=='link' and child.get('rel','alternate')=='alternate':
                link=child.get('href') or fields[name]
        try:url=public_url(urljoin(feed['url'],link)) if link else ''
        except ValueError:continue
        title=fields.get('title','')
        if not url or url in seen or len(plain(title))<2:continue
        seen.add(url)
        output.append(item(key,'RSS · '+feed['name'],hashlib.sha256(url.encode()).hexdigest()[:20],title,url,stamp,
            description=plain(fields.get('description') or fields.get('summary') or fields.get('content',''))[:800],
            published_at=fields.get('pubdate') or fields.get('published') or fields.get('updated'),
            content_type='article',discovery='新闻订阅 · 按订阅顺序',evidence_url=feed['url']))
        if len(output)>=30:break
    if not output:raise ValueError('订阅未返回可用文章')
    return output


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):raise ValueError('小红书服务重定向已拒绝，请检查本机服务配置')


class XhsClient:
    """Endpoint is administrator environment only, never a webpage/user URL."""
    def __init__(self):
        self.url=os.environ.get('SIGNAL_XHS_MCP_URL','http://127.0.0.1:9200/mcp').strip()
        p=urlsplit(self.url)
        if p.scheme not in ('http','https') or not p.hostname or p.username or p.password or p.query or p.fragment:
            raise ValueError('小红书服务地址配置不正确')
        self.headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        self.sequence=0

    def request(self,method,params=None,notify=False):
        self.sequence+=1
        body={'jsonrpc':'2.0','method':method,'params':params or {}}
        if not notify:body['id']=self.sequence
        req=urllib.request.Request(self.url,data=json.dumps(body).encode(),headers=self.headers)
        try:
            with self.opener.open(req,timeout=75) as response:
                session=response.headers.get('Mcp-Session-Id')
                if session:self.headers['Mcp-Session-Id']=session
                raw=response.read(8_000_001)
                if len(raw)>8_000_000:raise ValueError('小红书响应过大，请缩小采集范围')
        except (OSError,TimeoutError):raise ValueError('小红书服务不可用或超时，请检查本机服务及登录状态') from None
        if notify:return None
        text=raw.decode('utf-8')
        if text.lstrip().startswith('{'):result=json.loads(text)
        else:
            events=[]
            for block in text.replace('\r\n','\n').split('\n\n'):
                data='\n'.join(line[5:].lstrip() for line in block.splitlines() if line.startswith('data:'))
                if data:events.append(json.loads(data))
            result=next((e for e in events if e.get('id')==self.sequence),{})
        if result.get('error') or 'result' not in result:raise ValueError('小红书服务返回错误，请检查服务版本及登录状态')
        return result['result']

    def __enter__(self):
        self.request('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'signal-hot-topics','version':'1.0'}})
        self.request('notifications/initialized',notify=True)
        return self

    def __exit__(self,*args):
        if 'Mcp-Session-Id' in self.headers:
            try:
                with self.opener.open(urllib.request.Request(self.url,headers=self.headers,method='DELETE'),timeout=5):pass
            except (OSError,ValueError):pass

    def tool(self,name,arguments):
        if name not in ('search_feeds','get_feed_detail','check_login_status','get_login_qrcode'):raise ValueError('只允许读取小红书选题资料及登录状态')
        result=self.request('tools/call',{'name':name,'arguments':arguments})
        if result.get('isError'):
            message=' '.join(p.get('text','') for p in result.get('content',[]) if p.get('type')=='text')
            if 'no such file' in message and ('chrome' in message or 'chromium' in message):
                raise ValueError('小红书服务缺少浏览器，请安装配套Chrome后重启服务')
            raise ValueError('小红书读取失败，请检查本机服务并完成登录')
        return result

    def call(self,name,arguments):
        result=self.tool(name,arguments)
        if isinstance(result.get('structuredContent'),dict):return result['structuredContent']
        for part in result.get('content',[]):
            if part.get('type')=='text':
                try:return json.loads(part['text'])
                except (ValueError,KeyError):continue
        raise ValueError('小红书未返回可解析内容，请检查登录状态')


def xhs_login(qrcode=False):
    with XhsClient() as client:
        result=client.tool('get_login_qrcode' if qrcode else 'check_login_status',{})
    output={'message':'\n'.join(p.get('text','') for p in result.get('content',[]) if p.get('type')=='text')[:600]}
    if not qrcode and '未登录' in output['message']:
        output['message']='小红书尚未登录。点击“显示登录二维码”，使用小红书手机App扫码后，再检查登录状态。'
    for part in result.get('content',[]):
        if qrcode and part.get('type')=='image' and part.get('mimeType') in ('image/png','image/jpeg'):
            data=part.get('data','')
            if isinstance(data,str) and len(data)<=2_000_000 and re.fullmatch(r'[A-Za-z0-9+/=\s]+',data):
                output['image']='data:'+part['mimeType']+';base64,'+data
                output['message']='请使用小红书手机App扫码登录。二维码短时有效，过期后点击“显示登录二维码”重新获取；扫码完成后点击“检查小红书登录”。'
                break
    return output


def parse_xhs(data, stamp, keyword):
    rows=data.get('feeds') if isinstance(data,dict) else None
    if not isinstance(rows,list):raise ValueError('小红书搜索结果格式不正确，请检查登录状态')
    output=[]
    for row in rows:
        card=row.get('noteCard') or {};title=card.get('displayTitle') or card.get('title');fid=row.get('id')
        if not title or not fid or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',str(fid)):continue
        token=str(row.get('xsecToken') or '')[:2048]
        user=card.get('user') or {};counts=card.get('interactInfo') or {}
        output.append(item('xiaohongshu','小红书',fid,title,'https://www.xiaohongshu.com/explore/'+str(fid)+
            ('?'+urlencode({'xsec_token':token,'xsec_source':'pc_search'}) if token else ''),stamp,
            author=user.get('nickname') or user.get('nickName') or '',xsec_token=token,
            content_type='video' if card.get('type')=='video' else 'image_text',
            discovery='关键词搜索 · '+keyword+' · 一周内 · 最多点赞',
            metrics=[{'label':label,'value':number(counts.get(field)),'display':str(counts.get(field) or '')[:20]}
                     for label,field in [('点赞','likedCount'),('收藏','collectedCount'),('评论','commentCount')]]))
        if len(output)>=20:break
    return output


def collect_xhs(settings, stamp, archive):
    output=[]
    with XhsClient() as client:
        status=client.tool('check_login_status',{})
        message=' '.join(p.get('text','') for p in status.get('content',[]) if p.get('type')=='text')
        if '未登录' in message or not any(word in message for word in ('已登录','登录成功')):
            raise ValueError('小红书尚未登录，请在“管理采集来源与关键词”中扫码登录')
        for index,keyword in enumerate(settings['xhs_keywords']):
            data=client.call('search_feeds',{'keyword':keyword,'filters':{'sort_by':'最多点赞','publish_time':'一周内','note_type':settings['xhs_note_type']}})
            (archive/f'xiaohongshu-{index}.json').write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            output.extend(parse_xhs(data,stamp,keyword))
    return list({row['id']:row for row in output}.values())


def source_jobs(settings, stamp, archive):
    jobs=[]
    if settings['weibo']:
        def weibo():
            raw=fetch_weibo()
            (archive/'weibo.json').write_text(raw,encoding='utf-8')
            return parse_weibo(raw,stamp)
        jobs.append(('weibo','微博',weibo))
    if settings['xiaohongshu']:jobs.append(('xiaohongshu','小红书',lambda:collect_xhs(settings,stamp,archive)))
    for feed in settings['rss']:
        def rss(feed=feed):
            raw=fetch(feed['url'])
            (archive/(rss_key(feed['url']).replace(':','-')+'.xml')).write_text(raw,encoding='utf-8')
            return parse_rss(raw,feed,stamp)
        jobs.append((rss_key(feed['url']),'RSS · '+feed['name'],rss))
    return jobs


def resolve_candidate(root, candidate_id):
    feed=json.loads((root/'data/feed.json').read_text(encoding='utf-8'))
    row=next((x for x in feed.get('candidates',[]) if x['id']==candidate_id),None)
    if not row:raise ValueError('该热点已更新，请刷新列表后重新选择')
    if row['source']=='GitHub':return {'repo':row['id']}
    return {'topic':{'title':row['title'],'angle':'根据原始资料核实并讲清这个话题。热榜排名和互动数仅说明关注度，不代表事实已核实。',
                     'urls':[row['url']],'search_mode':'auto',
                     'collected_ref':{'archive':row.get('archive',feed['archive']),'id':row['id']}}}


def collected_document(root, ref):
    """Read immutable server archive, never trust client-supplied source text."""
    path=root/ref['archive']/'feed.json'
    data=json.loads(path.read_text(encoding='utf-8'))
    row=next((x for x in data.get('candidates',[]) if x['id']==ref['id']),None)
    if not row:raise ValueError('原始热点记录不存在，请重新采集')
    if row.get('source_key')!='xiaohongshu':return None
    with XhsClient() as client:
        data=client.call('get_feed_detail',{'feed_id':row['external_id'],'xsec_token':row.get('xsec_token',''),'load_all_comments':False})
    payload=data.get('data') or data
    note=payload.get('note') or {}
    if str(note.get('noteId') or note.get('id') or '')!=row['external_id']:
        raise ValueError('小红书详情与选中笔记不匹配，请重新采集')
    description=note.get('desc') or ''
    if not isinstance(description,str) or len(description.strip())<40:
        raise ValueError('该笔记正文不足以核实内容；纯视频需先取得字幕或补充参考网页')
    text=plain(str(note.get('title') or row['title']))+'\n'+description[:18000]
    return {'url':row['url'],'title':row['title'],'text':text,'via':'小红书笔记正文（作者陈述，需核实）',
            'retrieved_at':now(),'sha256':hashlib.sha256(text.encode()).hexdigest()}
