import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "D:/customer-service/outputs/wecom_qa/智能客服批量导入_聊天记录归纳.xlsx";
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("快捷回复列表");
const values = sheet.getUsedRange().values;

for (let i = 0; i < values.length; i++) {
  const group = values[i]?.[0];
  const question = values[i]?.[1];
  if (question && i >= 6) {
    console.log(`${i + 1}\t${group}\t${question}`);
  }
}
