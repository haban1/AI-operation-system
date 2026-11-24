// 转人工回执话术。只描述已经发生的事（转人工请求已登记），不承诺具体回复时间。

function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 解析 "09:00-18:00"；格式无效返回 null（视为不限制工作时间）。 */
export function parseServiceHours(value) {
  const [start, end] = String(value || '').split('-').map(minutesOfDay);
  if (start == null || end == null || start === end) return null;
  return { start, end };
}

export function isWithinServiceHours(serviceHours, { at = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const range = parseServiceHours(serviceHours);
  if (!range) return true;
  let hour;
  let minute;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    hour = Number(parts.find(part => part.type === 'hour')?.value);
    minute = Number(parts.find(part => part.type === 'minute')?.value);
  } catch {
    return true;
  }
  const current = hour * 60 + minute;
  // 支持跨午夜的区间，例如 "20:00-02:00"。
  return range.start < range.end
    ? current >= range.start && current < range.end
    : current >= range.start || current < range.end;
}

/**
 * kind: REQUESTED（用户主动要求或确认转人工） / SYSTEM（系统判断需要人工，例如答案超长、服务超时）。
 */
export function handoffAckText({ kind = 'REQUESTED', script = 'auto', serviceHours = '', timeZone = 'Asia/Shanghai', at = new Date() } = {}) {
  // 回执只说“已经联系同事、接手后会在这里回复”，不说成“已有人在处理”，避免用户误以为人工已接入。
  const texts = {
    english: {
      COMPLAINT: 'I\'m really sorry about the trouble. I\'ve asked a colleague to look into it, and they\'ll reply to you right here once they pick it up.',
      SYSTEM: 'Let me get a colleague to help with this. They\'ll reply to you right here once they pick it up.',
      REQUESTED: 'Sure, I\'ve passed this on to a colleague. They\'ll reply to you right here once they pick it up.'
    },
    traditional: {
      COMPLAINT: '非常抱歉給你帶來不好的體驗，已經請同事盡快跟進處理，同事接手後會直接在這裡回覆你。',
      SYSTEM: '這個問題我請人工同事來幫你看看，同事接手後會直接在這裡回覆你，請稍等一下～',
      REQUESTED: '好的，已經幫你聯繫人工同事了，同事接手後會直接在這裡回覆你，請稍等一下～'
    },
    simplified: {
      COMPLAINT: '非常抱歉给你带来不好的体验，已经请同事尽快跟进处理，同事接手后会直接在这里回复你。',
      SYSTEM: '这个问题我请人工同事来帮你看看，同事接手后会直接在这里回复你，请稍等一下～',
      REQUESTED: '好的，已经帮你联系人工同事了，同事接手后会直接在这里回复你，请稍等一下～'
    }
  };
  const table = texts[script === 'english' ? 'english' : script === 'traditional' ? 'traditional' : 'simplified'];
  const base = table[kind] || table.REQUESTED;
  if (isWithinServiceHours(serviceHours, { at, timeZone })) return base;
  const range = String(serviceHours).trim();
  if (script === 'english') return `${base} It's currently outside our service hours (${range}), so they'll get back to you as soon as they're in.`;
  return script === 'traditional'
    ? `${base}現在是非工作時間（${range}），同事上班後會第一時間回覆你。`
    : `${base}现在是非工作时间（${range}），同事上班后会第一时间回复你。`;
}
