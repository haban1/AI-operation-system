"""Reusable editorial directions; creator references are research, not identities."""
STYLES = [
    {'id':'baseline-v2','name':'V2 · 动态讲解','reference':'AI咖啡馆 / 技术爬爬虾','tagline':'已认可的原有方向','renderer':'punchy-v2',
     'guidance':'结果开场，短句口播，穿插项目素材和自制示意，保留明确局限。'},
    {'id':'rapid','name':'A · 快切技术快报','reference':'Fireship','reference_url':'https://www.youtube.com/@Fireship/videos','tagline':'强开场 · 大字重拍 · 紧凑信息量','renderer':'style-lab',
     'guidance':'痛点开场，用一句反转解释本质。8场，约300到340字，短句，节奏快。用可核实的周新增解释为什么值得关注，再讲机制、具体例子和局限。结尾回答开头并给试用判断。不要虚构实测或用夸张排名。',
     'voice':'zh-CN-YunxiNeural','rate':'+5%','pitch':'-1Hz','bpm':112},
    {'id':'walkthrough','name':'B · 工具实用拆解','reference':'Matt Wolfe','reference_url':'https://www.youtube.com/@mreflow/videos','tagline':'先看用途 · 步骤聚焦 · 温和口播','renderer':'style-lab',
     'guidance':'围绕一个具体工作场景，先展示痛点与目标，再按输入、处理、输出三个步骤解释。8场，约320到380字。只讲来源证实的操作；没有亲测就明确自制示意。说明适合人群和局限，最后回到开头的工作场景，给一个可执行的试用建议。',
     'voice':'zh-CN-XiaoxiaoNeural','rate':'-2%','pitch':'-1Hz','bpm':92},
    {'id':'discovery','name':'C · 视觉科普故事','reference':'Two Minute Papers','reference_url':'https://www.youtube.com/@TwoMinutePapers/videos','tagline':'问题引入 · 渐进图解 · 留白和悬念','renderer':'style-lab',
     'guidance':'从一个让人好奇的实际问题开场，用简单类比逐步揭示原理，再回到真实用途。8场，约320到380字，语气有好奇心但不夸大。结尾必须回答开头的问题并给判断，不能只留下悬念。明确哪些是自制概念示意，不能把演示当成实际产品效果。',
     'voice':'zh-CN-YunjianNeural','rate':'-3%','pitch':'-1Hz','bpm':80},
]

def get_style(style_id):
    for style in STYLES:
        if style['id'] == style_id:
            return style
    raise ValueError('请选择可用的视频风格')

def public_styles():
    return [{k:v for k,v in s.items() if k not in ('guidance','voice','rate','pitch','bpm')} for s in STYLES]
