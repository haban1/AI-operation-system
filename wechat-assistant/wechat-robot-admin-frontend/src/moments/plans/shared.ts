export const planLabels: Record<string, string> = { active: '执行中', paused: '已暂停', cancelled: '已取消', completed: '已生成单次任务' };
export const jobLabels: Record<string, string> = { generating: '等待生成', drafting: '生成文案中', awaiting_review: '待审核', scheduled: '等待发布', uploading: '准备附件中', publishing: '发布中', published: '已发布', failed: '执行失败', uncertain: '结果待核对', cancelled: '已取消', expired: '已过期，未发布' };
export const visibilityLabels: Record<string, string> = { public: '公开', private: '仅自己可见', share_with: '部分好友可见', donot_share: '不给指定好友看' };
export const repeatLabels: Record<string, string> = { once: '单次', daily: '每天', weekly: '每周' };
export const cancellable = ['generating', 'drafting', 'awaiting_review', 'scheduled', 'uploading'];
export const timestamp = (value: number) => value ? new Date(value * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
export const newRequestID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
export const pendingKey = (robotId: number) => `moment-plan-pending-${robotId}`;
