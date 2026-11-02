"""Extend the existing support API contract, then run frontend pnpm build-types."""
import copy
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONT = ROOT / 'wechat-assistant/wechat-robot-admin-frontend/scripts/swagger/wechat-robot.swagger.json'
BACK = ROOT / 'wechat-assistant/wechat-robot-admin-backend/docs'
spec = json.loads(FRONT.read_text(encoding='utf-8-sig'))
job = copy.deepcopy(spec['definitions']['SupportBroadcast'])
job['properties']['updated_at'] = {'type': 'integer'}
friend = {'type': 'object', 'properties': {k: {'type':'string'} for k in ['wechat_id','nickname','remark','avatar']}}
detail = {'type':'object','properties':{'job':job,'friends':{'type':'array','items':friend}}}
params = [{'name':'id','in':'query','type':'integer','required':True,'description':'机器人实例 ID'},
          {'name':'broadcast_id','in':'query','type':'string','required':True,'description':'群发任务编号'}]
operation = {'security':[{'ApiTokenAuth':[]}],'tags':['Support'],'summary':'查看群发记录详情','produces':['application/json'],
             'parameters':params,'responses':{'200':{'description':'OK','schema':{'type':'object','properties':{
                 'code':{'type':'integer'},'message':{'type':'string'},'data':{'$ref':'#/definitions/SupportBroadcastDetail'}}}}}}
image = copy.deepcopy(operation)
image.update(summary='查看群发记录原始图片',produces=['image/png','image/jpeg','image/gif','image/webp'])
image['parameters'].append({'name':'position','in':'query','type':'integer','minimum':1,'maximum':3,'required':True,'description':'图片顺序，从 1 开始'})
image['responses']={'200':{'description':'原始图片','schema':{'type':'file'}},'404':{'description':'图片不存在'}}
paths={'/support/broadcasts/detail':{'get':operation},'/support/broadcasts/image':{'get':image}}
definitions={'SupportBroadcastDetail':detail,'SupportDelivery':spec['definitions']['SupportDelivery']}
for filename in [FRONT,BACK/'swagger.json']:
    data=json.loads(filename.read_text(encoding='utf-8-sig'))
    data['paths'].update(paths);data['definitions'].update(definitions)
    filename.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
filename=BACK/'swagger.yaml'
text=filename.read_text(encoding='utf-8-sig')
for key,values in [('paths',paths),('definitions',definitions)]:
    # JSON flow mappings are valid YAML; keep the existing document intact.
    addition=''.join('  '+json.dumps(k)+': '+json.dumps(v,ensure_ascii=False)+'\n' for k,v in values.items()
                     if not re.search(r'^  [\"\']?'+re.escape(k)+r'[\"\']?:',text,re.M))
    text=text.replace(key+':\n',key+':\n'+addition,1)
filename.write_text(text,encoding='utf-8')
filename=BACK/'docs.go'
text=filename.read_text(encoding='utf-8')
for key,values in [('paths',paths),('definitions',definitions)]:
    missing={k:v for k,v in values.items() if '"'+k+'": {' not in text}
    if missing:
        marker='"'+key+'": {'
        text=text.replace(marker,marker+'\n'+json.dumps(missing,ensure_ascii=False,indent=4)[1:-1].strip()+',\n',1)
filename.write_text(text,encoding='utf-8')
print('Broadcast detail API schema updated')
