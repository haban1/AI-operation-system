import { detectRisk } from './decision.js';

export const COMPLIANCE_RULE_VERSION = 'local-safety-2026.08.10.1';

const rules = [
  { code: 'TEST_PLACEHOLDER', level: 'BLOCK', fields: ['title', 'body'], pattern: /发布链路测试|管理端一键发布测试|系统测试|MVP\s*测试|测试内容|发布后可删除|占位内容/i, message: '内容包含测试或占位表述，不允许发布到正式运营账号' },
  { code: 'AUTOMATION_DISCLOSURE', level: 'BLOCK', fields: ['title', 'body'], pattern: /RPA\s*自动|Local\s*Agent\s*自动|自动点击发布|自动上传填充|一键发布测试/i, message: '内容暴露自动化发布链路，容易被判定为低质或异常测试内容' },
  { code: 'EXTERNAL_LINK', level: 'WARN', fields: ['title', 'body'], pattern: /https?:\/\/|www\.|[a-z0-9-]+\.(com|cn|net|org)(?:\/|\s|$)/i, message: '内容包含外部链接，请确认平台允许且确有必要' },
  { code: 'CONTACT_DIVERSION', level: 'WARN', fields: ['title', 'body'], pattern: /(加|联系|私聊).{0,5}(微信|vx|v信|QQ)|微信号|手机号[:：]?\s*1[3-9]\d{9}/i, message: '内容疑似包含联系方式或站外引流信息' },
  { code: 'ABSOLUTE_CLAIM', level: 'WARN', fields: ['title', 'body'], pattern: /百分百|100%|绝对有效|保证成功|全网第一|最好|唯一/i, message: '内容包含绝对化或保证性表达' }
];

function pushFinding(findings, finding) {
  if (!findings.some(item => item.code === finding.code && item.field === finding.field)) findings.push(finding);
}

export function reviewPublishContent({ title = '', body = '' } = {}) {
  const values = { title: String(title), body: String(body) };
  const findings = [];
  for (const rule of rules) {
    for (const field of rule.fields) {
      if (values[field] && rule.pattern.test(values[field])) pushFinding(findings, { code: rule.code, level: rule.level, field, message: rule.message });
      rule.pattern.lastIndex = 0;
    }
  }
  const combined = [values.title, values.body].filter(Boolean).join('\n');
  const risk = detectRisk(combined);
  if (risk.risk) pushFinding(findings, { code: `BUSINESS_RISK_${risk.code}`, level: 'BLOCK', field: 'content', message: `内容命中人工审核风险规则：${risk.reason}` });
  if (!values.title.trim()) pushFinding(findings, { code: 'TITLE_EMPTY', level: 'BLOCK', field: 'title', message: '标题不能为空' });
  if (!values.body.trim()) pushFinding(findings, { code: 'BODY_EMPTY', level: 'BLOCK', field: 'body', message: '正文不能为空' });
  if (values.title.trim().length < 4) pushFinding(findings, { code: 'TITLE_TOO_SHORT', level: 'WARN', field: 'title', message: '标题过短，可能缺少有效信息' });
  if (values.body.trim().length < 20) pushFinding(findings, { code: 'BODY_TOO_SHORT', level: 'WARN', field: 'body', message: '正文信息量较少，请确认内容对用户有实际价值' });
  const overall = findings.some(item => item.level === 'BLOCK') ? 'BLOCKED' : findings.some(item => item.level === 'WARN') ? 'WARNING' : 'PASSED';
  return { overall, findings, ruleVersion: COMPLIANCE_RULE_VERSION, checkedAt: new Date().toISOString() };
}

export function validateComplianceApproval(review, confirmed = false) {
  if (!review || typeof review !== 'object') return { ok: false, message: '缺少发布内容合规审核结果' };
  if (review.ruleVersion !== COMPLIANCE_RULE_VERSION) return { ok: false, message: '合规规则版本已变化，请重新审核' };
  if (review.overall === 'BLOCKED') return { ok: false, message: '内容合规审核存在阻断项，不能发布' };
  if (review.overall === 'WARNING' && confirmed !== true) return { ok: false, message: '内容合规审核存在警告，请人工确认后继续' };
  return { ok: true };
}
