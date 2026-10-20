import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { precheckMaterial } from '../../agent/precheck.js';
import { reviewPublishContent } from '../../src/services/content-compliance.js';

const outDir = path.dirname(fileURLToPath(import.meta.url));
const materialPath = path.join(outDir, 'community-activity-guide-1080x1920.mp4');
const title = '社区活动报名指南';
const body = '社区活动报名开放中。请提前确认活动时间、地点与参与要求，按公告指引提交报名信息，并留意后续通知。欢迎收藏这份报名流程，转给有需要的邻里朋友。';
const imageText = '社区活动报名指南 四步轻松完成 报名之前先看清 活动时间与地点 参与要求与所需信息 报名截止时间 查看活动公告 准备报名信息 按指引提交 留意后续通知 提前规划 从容参与';

const precheck = precheckMaterial({
  materialPath,
  platforms: ['xiaohongshu', 'douyin', 'wechat_channels', 'bilibili', 'weibo'],
  title,
  body,
});
const compliance = reviewPublishContent({ title, body, imageText });
const report = {
  generatedAt: new Date().toISOString(),
  materialPath,
  copy: { title, body },
  precheck,
  compliance,
};
fs.writeFileSync(path.join(outDir, 'precheck-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
