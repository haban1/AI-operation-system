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
    for attempt in range(3):
        try:return read_public(url,accept=accept or 'application/json,text/html;q=0.9,*/*;q=0.8')[0]
        except (ValueError,OSError) as error:
            retryable=any(word in str(error) for word in ('连接失败','超时','HTTP 429','HTTP 502','HTTP 503','HTTP 504'))
            if not retryable or attempt==2:
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

def collect():
    stamp = now()
    batch = ROOT / 'data' / ('capture-' + dt.datetime.now().strftime('%Y%m%d-%H%M%S'))
    batch.mkdir(parents=True, exist_ok=True)
    urls = {'GitHub': 'https://github.com/trending?since=weekly',
            'Reddit': 'https://www.reddit.com/r/LocalLLaMA/top.json?t=week&limit=12',
            'Hacker News': 'https://hn.algolia.com/api/v1/search?query=AI&tags=story&numericFilters=created_at_i%3E' + str(int(dt.datetime.now().timestamp()) - 7*86400) + '&hitsPerPage=12'}
    states, candidates, discussions = [], [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        future_map = {pool.submit(fetch, url): (name, url) for name, url in urls.items()}
        for future in concurrent.futures.as_completed(future_map):
            name, url = future_map[future]
            try:
                raw = future.result()
                (batch / (name.replace(' ', '-') + '.txt')).write_text(raw, encoding='utf-8')
                if name == 'GitHub':
                    candidates = parse_trending(raw, stamp)
                    count = len(candidates)
                elif name == 'Reddit':
                    posts = json.loads(raw)['data']['children']
                    for p in posts:
                        d = p['data']; discussions.append({'source': name, 'title': d['title'], 'score': d['score'], 'url': 'https://reddit.com' + d['permalink'], 'collected_at': stamp})
                    count = len(posts)
                else:
                    posts = json.loads(raw)['hits']
                    for d in posts:
                        discussions.append({'source': name, 'title': d.get('title'), 'score': d.get('points'), 'url': 'https://news.ycombinator.com/item?id=' + d['objectID'], 'collected_at': stamp})
                    count = len(posts)
                states.append({'source': name, 'status': 'ok', 'count': count, 'url': url})
            except Exception as e:
                states.append({'source': name, 'status': 'unavailable', 'detail': str(e)[:350], 'url': url})
    states.append({'source': 'X', 'status': 'not_configured', 'detail': '尚未接入 X API；可在文稿阶段补充人工核实的公开链接'})
    result = {'collected_at': stamp, 'candidates': candidates, 'discussions': discussions, 'sources': states, 'archive': str(batch.relative_to(ROOT))}
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
