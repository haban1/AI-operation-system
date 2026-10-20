import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "D:/customer-service/outputs/wecom_qa/智能客服批量导入_聊天记录归纳.xlsx";
const outputDir = "D:/customer-service/outputs/wecom_qa";
const outputPath = `${outputDir}/智能客服批量导入_聊天记录归纳_去重分工版.xlsx`;
const previewPath = `${outputDir}/智能客服批量导入_聊天记录归纳_去重分工版.png`;

const replacements = new Map([
  [
    "本期课程信息是什么？",
    "本期课程：Claude Code 业务小助手搭建实战课；日期：6月27日（周六）；时间：10:00-17:00；地点：粤港澳大湾区（广东）创新创业孵化基地；报名链接：https://zhihuiqudong.feishu.cn/share/base/form/shrcnBUgthRJtssva3K0y2eusAd。",
  ],
  [
    "这周有课吗？",
    "本期上课时间是6月27日（周六）10:00-17:00。一般课程安排在周六，每期主题可能不同。",
  ],
  [
    "每周六都有这个课程吗？",
    "一般周六会安排课程，但每期主题可能不同，具体看本期课程信息。",
  ],
  [
    "课程上多久？",
    "本期课程时间为10:00-17:00，共1天。一般体验课也是1天，上午讲基础，下午做实操。",
  ],
  [
    "上课地点在哪里？",
    "上课地点是粤港澳大湾区（广东）创新创业孵化基地，地址：广州市天河区兴盛路10、12、14号。",
  ],
  [
    "具体在哪个教室？",
    "具体教室请看本期课程信息；到场后也可以按现场指引或联系工作人员。",
  ],
  [
    "地址和通知在哪里看？",
    "报名后可以看本期课程信息或课程群公告；具体教室、签到等现场信息以群公告为准。",
  ],
]);

await fs.mkdir(outputDir, { recursive: true });
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("快捷回复列表");
const used = sheet.getUsedRange();
const values = used.values;

const changed = [];
for (let row = 0; row < values.length; row++) {
  const question = values[row]?.[1];
  if (replacements.has(question)) {
    const nextAnswer = replacements.get(question);
    sheet.getCell(row, 3).values = [[nextAnswer]];
    changed.push({ row: row + 1, question, answer: nextAnswer });
  }
}

if (changed.length !== replacements.size) {
  const found = new Set(changed.map((item) => item.question));
  const missing = [...replacements.keys()].filter((question) => !found.has(question));
  throw new Error(`未找到这些问题行：${missing.join("；")}`);
}

const preview = await workbook.render({
  sheetName: "快捷回复列表",
  autoCrop: "all",
  scale: 1,
  format: "png",
});
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

const summary = await workbook.inspect({
  kind: "region",
  sheetId: "快捷回复列表",
  range: "A7:D40",
  maxChars: 5000,
  tableMaxRows: 12,
  tableMaxCols: 4,
  tableMaxCellChars: 100,
});
console.log(summary.ndjson);
console.log(JSON.stringify({ outputPath, previewPath, changed }, null, 2));
