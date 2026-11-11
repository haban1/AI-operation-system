function traditionalScript(script, question) {
  if (script !== 'auto') return script === 'traditional';
  const traditional = (question.match(/[體臺灣為與這個來時會後裡麼問學習開關閉發現應該讓從將還進過內寶綁銀錢費報資訊聯絡]/g) || []).length;
  const simplified = (question.match(/[体台湾为与这个来时会后里么问学习开关闭发现应该让从将还进过内宝绑银钱费报资讯联络]/g) || []).length;
  return traditional > simplified;
}

// These are application copy safeguards, not a complete or official platform word list.
export function isSafeCommentHandoffCopy(text, { platformCode = '' } = {}) {
  if (String(platformCode).toLowerCase() !== 'douyin') return true;
  const normalized = String(text || '').normalize('NFKC')
    .replace(/[\s\p{P}\p{S}\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+/gu, '')
    .replace(/人工智能|人工智慧/g, '智能');
  return !/(?:转人工|轉人工|人工|客服|微信|微訊|VX|加V|QQ|扣扣|电话|電話|手机号|手機號|联系方式|聯繫方式|邮箱|郵箱|公众号|公眾號|扫码|掃碼|二维码|二維碼|加群|进群|進群|入群|加我|加好友|外链|外鏈|链接|連結|网址|網址|站外|私聊|私信|私我|私发|私發|https?|www|\d{5,}|保证|保證|百分之百|100|全网第一|全網第一|全网最低|全網最低|稳赚|穩賺|赚钱|賺錢|返利|返现|返現|免费|免費|领取|領取|送资料|送資料|福利)/iu.test(normalized);
}

export function commentHandoffCopy({ platformCode = '', script = 'auto', question = '' } = {}) {
  const traditional = traditionalScript(script, String(question || ''));
  const invitation = traditional
    ? '想了解的話，回覆「詳情」，我們在站內訊息裡接著聊。'
    : '想了解的话，回复“详情”，我们在站内消息里接着聊。';
  const fallbackReply = `${traditional ? '這部分還得再確認一下。' : '这部分还得再确认一下。'}${invitation}`;
  return { traditional, invitation, fallbackReply };
}
