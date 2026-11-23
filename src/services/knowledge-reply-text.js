// Customer wording only. These messages do not assert a business fact or perform handoff.
export function knowledgeConsultationReply(question = '', { context = [], script = 'auto' } = {}) {
  const current = String(question).normalize('NFKC');
  const previous = context.filter(turn => turn?.role === 'USER').at(-1)?.text || '';
  const followup = /^(?:那|这个|這個|那个|那個|还有|還有|具体|具體|怎么|怎麼|咋|要|能)/u.test(current.trim());
  // A new explicit topic takes precedence over the previous question.
  const explicitTopic = /电话|電話|联系|聯繫|聯絡|微信号|微信號|楼层|樓層|几楼|幾樓|房间|房間|门牌|門牌|楼栋|樓棟|报名|報名|报班|報班|咋参加|怎么参加|怎麼參加|名额|名額|排期|哪天|几号|幾號|这期|這期|下期|还有位|還有位/u.test(current);
  const text = current + (followup && !explicitTopic ? ' ' + previous : '');
  const traditional = script === 'traditional';
  if (/电话|電話|联系|聯繫|联系方式|聯絡|微信号|微信號/u.test(current)) {
    return traditional ? '聯繫方式請向人工客服確認一下，你也可以先在這裡說說想諮詢的事。' : '联系方式请向人工客服确认一下，你也可以先在这里说说想咨询的事。';
  }
  if (/楼层|樓層|几楼|幾樓|房间|房間|门牌|門牌|楼栋|樓棟/u.test(text)) {
    return traditional ? '具體樓層或房間位置，請向人工客服確認一下，方便你準確到場。' : '具体楼层或房间位置，请向人工客服确认一下，方便你准确到场。';
  }
  if (/报名|報名|报班|報班|咋参加|怎么参加|怎麼參加/u.test(text)) {
    return traditional ? '報名方式可以向人工客服諮詢一下。' : '报名方式可以向人工客服咨询一下。';
  }
  if (/名额|名額|排期|哪天|几号|幾號|这期|這期|下期|还有位|還有位/u.test(text)) {
    return traditional ? '具體安排建議向人工客服確認一下。' : '具体安排建议向人工客服确认一下。';
  }
  return traditional ? '這個問題建議向人工客服諮詢一下。' : '这个问题建议向人工客服咨询一下。';
}
