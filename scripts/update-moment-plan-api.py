"""Refresh the native Moments plan OpenAPI contract and generated-doc inputs."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACK = ROOT / 'wechat-assistant/wechat-robot-admin-backend/docs'
FRONT = ROOT / 'wechat-assistant/wechat-robot-admin-frontend/scripts/swagger/wechat-robot.swagger.json'


def obj(properties):
    return {'type': 'object', 'required': list(properties), 'properties': properties}


def ref(name):
    return {'$ref': '#/definitions/' + name}


def arr(item):
    return {'type': 'array', 'items': item}


string = {'type': 'string'}
integer = {'type': 'integer', 'format': 'int64'}
strings = arr(string)
content = obj(dict(content=string, asset_ids=strings, share_type=string, share_with=strings, donot_share=strings, with_user_list=strings))
create = obj(dict(id=string, name=string, kind=string, topic=string, instructions=string, knowledge_codes=strings, publish_mode=string, repeat=string, timezone=string, first_run_at=integer, payload=ref('MomentPlanContent')))
plan = obj(dict(create['properties'], status=string, next_run_at=integer, created_at=integer, updated_at=integer))
job = obj(dict(id=string, plan_id=string, plan_name=string, occurrence_at=integer, scheduled_at=integer, status=string, payload=ref('MomentPlanContent'), sources=string, error=string, moment_id=string, created_at=integer, updated_at=integer))
asset = obj(dict(id=string, name=string, media_type=string, size=integer, created_at=integer))
snapshot = obj(dict(plans=arr(ref('MomentPlan')), jobs=arr(ref('MomentPlanJob')), categories=arr(obj(dict(code=string, name=string))), assets=arr(ref('MomentPlanAsset'))))
definitions = dict(MomentPlanContent=content, MomentPlanCreate=create, MomentPlan=plan, MomentPlanJob=job, MomentPlanAsset=asset, MomentPlanSnapshot=snapshot,
                   MomentPlanAction=obj(dict(plan_id=string, action=string)), MomentPlanJobAction=obj(dict(job_id=string, action=string, content=string, scheduled_at=integer)))


def operation(summary, response=None, body=None, upload=False):
    parameters = [{'name': 'id', 'in': 'query', 'required': True, 'type': 'integer', 'description': '机器人实例ID'}]
    if body:
        parameters.append({'name': 'request', 'in': 'body', 'required': True, 'schema': ref(body)})
    if upload:
        parameters.append({'name': 'media', 'in': 'formData', 'required': True, 'type': 'file'})
    envelope = obj(dict(code=integer, message=string, data=ref(response) if response else {'type': 'object'}))
    return dict(tags=['Moments'], summary=summary, consumes=['multipart/form-data' if upload else 'application/json'], produces=['application/json'], parameters=parameters, responses={'200': {'description': 'OK', 'schema': envelope}})


paths = {
    '/moments/plans': {'get': operation('计划与执行记录', 'MomentPlanSnapshot'), 'post': operation('创建定时发布或AI内容计划', 'MomentPlan', 'MomentPlanCreate')},
    '/moments/plans/action': {'post': operation('暂停、恢复或取消计划', body='MomentPlanAction')},
    '/moments/plan-jobs/action': {'post': operation('审核文案或取消任务', body='MomentPlanJobAction')},
    '/moments/plan-assets': {'post': operation('保存计划原始附件', 'MomentPlanAsset', upload=True)},
}

for path in [BACK / 'swagger.json', FRONT]:
    spec = json.loads(path.read_text(encoding='utf-8-sig'))
    spec['paths'].update(paths)
    spec['definitions'].update(definitions)
    path.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

# Keep the embedded Swagger template synchronized without interpreting its Go template expressions.
path = BACK / 'docs.go'
text = path.read_text(encoding='utf-8')
start = '// BEGIN MOMENT PLAN API'
if start not in text:
    for key, values in [('paths', paths), ('definitions', definitions)]:
        marker = '"' + key + '": {'
        addition = json.dumps(values, ensure_ascii=False, indent=4)[1:-1].strip()
        text = text.replace(marker, marker + '\n' + addition + ',\n', 1)
    text += '\n' + start + ' (regenerate through scripts/update-moment-plan-api.py)\n'
    path.write_text(text, encoding='utf-8')

print('Moments plan API contract updated; run pnpm build-types next.')
