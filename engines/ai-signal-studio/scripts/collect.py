"""Public-source collection. Source text is data, never executable instructions."""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import html
import json
import math
import re
import time
from public_web import read_public
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AI = re.compile(r'\b(ai|agent|agents|llm|models?|skill|skills|voice|research|rl|learning|segmentation|claude|codex|copilot)\b', re.I)

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)

def fetch(url, accept=None):
    for attempt in range(4):
        try:return read_public(url,accept=accept or 'application/json,text/html;q=0.9,*/*;q=0.8')[0]
        except (ValueError,OSError) as error:
            retryable=any(word in str(error) for word in ('连接失败','连接中断','超时','HTTP 429','HTTP 502','HTTP 503','HTTP 504'))
            if not retryable or attempt==3:
                raise ValueError('公开资料获取失败：'+str(error)+'；请检查网络或稍后重试。') from None
            time.sleep(attempt+1)

def plain(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub('<[^>]+>', ' ', value))).strip()

def parse_trending(page, collected_at):
    result = []
    for article in re.findall(r'<article\b.*?</article>', page, re.S):
        heading = re.search(r'<h2\b.*?</h2>', article, re.S)
        if not heading:
            continue
        name = re.search(r'href="/([^"?#]+/[^"?#]+)"', heading.group())
        if not name:
            continue
        repo = name.group(1)
        p = re.search(r'<p\b.*?</p>', article, re.S)
        description = plain(p.group()) if p else ''
        if not AI.search(repo + ' ' + description):
            continue
        gain = re.search(r'([\d,]+)\s+stars this week', plain(article))
        stars = re.search(r'href="/' + re.escape(repo) + r'/stargazers"[^>]*>(.*?)</a>', article, re.S)
        number = re.search(r'[\d,]+', plain(stars.group(1))) if stars else None
        weekly = int(gain.group(1).replace(',', '')) if gain else None
        total = int(number.group().replace(',', '')) if number else None
        score = round(min(100, 30 + 12 * math.log10(1 + (weekly or 0))))
        result.append({'id': repo, 'source': 'GitHub', 'title': repo.split('/')[-1], 'description': description,
                       'url': 'https://github.com/' + repo, 'total_stars': total, 'weekly_stars': weekly,
                       'growth_basis': 'GitHub Trending 页面显示的 stars this week', 'collected_at': collected_at,
                       'evidence_url': 'https://github.com/trending?since=weekly', 'editorial_score': score,
                       'score_basis': '30 + 12 × log10(1 + 本周新增)，封顶100；仅用于初筛，不代表内容质量'})
    if not result:
        raise ValueError('未解析到 AI 候选；页面格式可能改变，不能用空结果伪装成功')
    return sorted(result, key=lambda x: x['weekly_stars'] or 0, reverse=True)

def collect(settings=None):
    from source_collectors import normalize_sources, source_jobs
    from runtime import load_config
    settings=normalize_sources(settings if settings is not None else load_config(ROOT).get('sources'))
    stamp = now()
    batch = ROOT / 'data' / ('capture-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    batch.mkdir(parents=True, exist_ok=True)
    archive=batch.relative_to(ROOT).as_posix()
    previous=json.loads((ROOT/'data/feed.json').read_text(encoding='utf-8')) if (ROOT/'data/feed.json').exists() else {}
    urls = {'github': ('GitHub','https://github.com/trending?since=weekly'),
            'reddit': ('Reddit','https://www.reddit.com/r/LocalLLaMA/top.json?t=week&limit=12'),
            'hackernews': ('Hacker News','https://hn.algolia.com/api/v1/search?query=AI&tags=story&numericFilters=created_at_i%3E' + str(int(dt.datetime.now().timestamp()) - 7*86400) + '&hitsPerPage=12')}
    states, candidates, discussions = [], [], []
    def legacy(key,name,url):
        raw=fetch(url)
        if key!='github':
            # 部分代理会在不带长度的分块响应中提前结束，JSON 不完整时重新获取
            for attempt in range(2):
                try:json.loads(raw);break
                except json.JSONDecodeError:
                    time.sleep(attempt+1);raw=fetch(url)
        (batch/(key+'.txt')).write_text(raw,encoding='utf-8')
        if key=='github':
            return [{**row,'source_key':key,'content_type':'repository','discovery':'GitHub 周榜',
                     'metrics':[{'label':'本周新增 Star','value':row['weekly_stars']},{'label':'累计 Star','value':row['total_stars']}]}
                    for row in parse_trending(raw,stamp)]
        rows=[]
        if key=='reddit':
            for post in json.loads(raw)['data']['children']:
                d=post['data'];rows.append({'source':name,'source_key':key,'title':d['title'],'score':d['score'],
                                          'url':'https://reddit.com'+d['permalink'],'collected_at':stamp})
        else:
            for d in json.loads(raw)['hits']:
                rows.append({'source':name,'source_key':key,'title':d.get('title'),'score':d.get('points'),
                             'url':'https://news.ycombinator.com/item?id='+d['objectID'],'collected_at':stamp})
        return rows
    jobs=[(key,name,lambda key=key,name=name,url=url:legacy(key,name,url))
          for key,(name,url) in urls.items() if settings[key]]+source_jobs(settings,stamp,batch)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        future_map = {pool.submit(fn):(key,name) for key,name,fn in jobs}
        for future in concurrent.futures.as_completed(future_map):
            key,name = future_map[future]
            target=discussions if key in ('reddit','hackernews') else candidates
            try:
                rows=future.result()
                target.extend({**row,'archive':archive,'stale':False} for row in rows)
                states.append({'source_key':key,'source':name,'status':'ok','count':len(rows),'last_success_at':stamp})
            except Exception as e:
                old=[row for row in previous.get('discussions' if target is discussions else 'candidates',[])
                     if row.get('source_key')==key or (not row.get('source_key') and row.get('source')==name)]
                target.extend({**row,'archive':row.get('archive',previous.get('archive')),'stale':True} for row in old)
                detail=str(e)[:250]
                states.append({'source_key':key,'source':name,'status':'unavailable','count':0,'retained_count':len(old),
                               'detail':detail,'last_success_at':old[0].get('collected_at') if old else None})
    order={key:i for i,(key,_,_) in enumerate(jobs)}
    candidates=list({row['id']:row for row in candidates}.values())
    candidates.sort(key=lambda row:order.get(row.get('source_key'),999))
    discussions.sort(key=lambda row:order.get(row.get('source_key'),999))
    states.sort(key=lambda row:order[row['source_key']])
    result = {'schema_version':2,'collected_at':stamp,'candidates':candidates,'discussions':discussions,'sources':states,'archive':archive}
    save(batch / 'feed.json', result)
    save(ROOT / 'data/feed.json', result)
    return result

def enrich(repo, target):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('请输入 owner/repo 格式的 GitHub 项目')
    target = Path(target); target.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(fetch('https://api.github.com/repos/' + repo))
    branch = metadata['default_branch']
    commit = json.loads(fetch('https://api.github.com/repos/' + repo + '/commits/' + branch))['sha']
    readme = fetch('https://api.github.com/repos/' + repo + '/readme?ref=' + commit, 'application/vnd.github.raw+json')
    (target / 'README-source.md').write_text(readme, encoding='utf-8')
    save(target / 'repository.json', metadata)
    evidence = {'repo': repo, 'commit': commit, 'collected_at': now(), 'readme_sha256': hashlib.sha256(readme.encode()).hexdigest(),
                'url': 'https://github.com/' + repo + '/tree/' + commit, 'readme': readme[:18000],
                'description': metadata.get('description'), 'license': (metadata.get('license') or {}).get('spdx_id'), 'total_stars': metadata['stargazers_count']}
    save(target / 'evidence.json', evidence)
    return evidence

if __name__ == '__main__':
    print(json.dumps(collect(), ensure_ascii=False, indent=2))
