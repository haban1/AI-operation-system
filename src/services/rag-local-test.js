import crypto from 'node:crypto';

// Build a normal grounded query without writing business messages or send jobs.
export function buildLocalRagTestRequest(data, { knowledgeBaseId, operatorId = 'admin' }) {
  const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_RAG_TEST' }); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('测试请求格式无效');
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || [...text].length > 4000) invalid('请输入 1–4000 字的问题');
  const platform = data.platform || 'DOUYIN';
  const channelType = data.channelType || 'DIRECT_MESSAGE';
  if (!['DOUYIN', 'WEIBO', 'BILIBILI', 'WECHAT_CHANNELS'].includes(platform)) invalid('测试平台无效');
  if (!['DIRECT_MESSAGE', 'COMMENT'].includes(channelType)) invalid('测试场景无效');
  const sessionId = data.sessionId || crypto.randomUUID();
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) invalid('测试会话标识无效');
  if (data.context !== undefined && (!Array.isArray(data.context) || data.context.length > 6)) invalid('最多携带三轮历史问答');
  const context = (data.context || []).map(item => {
    if (!item || !['USER', 'ASSISTANT'].includes(item.role) || typeof item.text !== 'string' || !item.text.trim() || [...item.text].length > 4000) invalid('历史问答格式无效');
    return { role: item.role, text: item.text.trim() };
  });
  if (context.length % 2 || context.some((item, index) => item.role !== (index % 2 ? 'ASSISTANT' : 'USER'))) invalid('历史问答须成对提供');
  if (context.reduce((sum, item) => sum + [...item.text].length, 0) > 12000) invalid('历史问答总长度不能超过 12000 字');
  const history = channelType === 'COMMENT' ? [] : context;
  const operatorHash = crypto.createHash('sha256').update(String(operatorId)).digest('hex').slice(0, 16);
  const run = crypto.randomUUID();
  return {
    contractVersion: '1.0', requestId: `local-test-${run}`, traceId: `local-test-${run}`,
    snapshot: {
      conversationKey: `LOCAL_TEST:${operatorHash}:${sessionId}`,
      conversationVersion: history.length / 2,
      inputFingerprint: 'sha256:' + crypto.createHash('sha256').update(JSON.stringify({ text, history, platform, channelType })).digest('hex')
    },
    source: { platform, channelType, accountId: 'local-test' },
    knowledgeScope: { tenantId: 'local-default', knowledgeBaseId },
    query: { text, messageIds: [] }, context: history,
    constraints: { language: 'zh-CN', answerFormat: 'PLAIN_TEXT', maxAnswerChars: 600, requireGrounding: true }
  };
}
