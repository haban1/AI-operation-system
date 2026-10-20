import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const templatePath = "D:/customer-service/spreadsheet_work/template.xlsx";
const outputDir = "D:/customer-service/outputs/wecom_qa";
const outputPath = `${outputDir}/智能客服批量导入_聊天记录归纳_20260624-101756.xlsx`;
const previewPath = `${outputDir}/智能客服批量导入_聊天记录归纳_20260624-101756.png`;
const signupUrl = "https://zhihuiqudong.feishu.cn/share/base/form/shrcnBUgthRJtssva3K0y2eusAd";

const rows = [
  {
    group: "本期信息",
    question: "本期课程信息是什么？",
    similar: [
      "这期课是什么",
      "本周课程信息",
      "这周课程安排",
      "周六上什么课",
      "上课时间地点",
      "具体时间和教室",
      "这次课几点开始",
      "课程安排发我",
      "报名后去哪里上课",
    ],
    answer:
      "本期课程：Claude Code 业务小助手搭建实战课；日期：6月27日（周六）；时间：10:00-17:00；地点：粤港澳大湾区（广东）创新创业孵化基地。",
  },
  {
    group: "公司介绍",
    question: "你们是做什么的？",
    similar: [
      "智慧驱动是什么公司",
      "你们公司介绍一下",
      "这个小助手是谁",
      "你们是哪个机构",
      "你们主要做什么",
      "智慧驱动是培训机构吗",
      "你们和基地是什么关系",
    ],
    answer:
      "这里是【智慧驱动】官方微信小助手。我们专注人工智能应用落地与AI人才能力建设，帮助个人和企业提升AI实操能力。",
  },
  {
    group: "报名咨询",
    question: "现在还可以报名吗？",
    similar: [
      "还能报名吗",
      "还可以参加吗",
      "现在报名来得及吗",
      "今天还能报名吗",
      "可以报名周六的课吗",
      "这个课还能参加吗",
      "名额还有吗",
      "报名截止了吗",
      "我想报名",
      "帮我报名",
    ],
    answer:
      `可以报名。请填写报名表：${signupUrl}。提交姓名、联系方式和报名场次即可。一般没有特殊报名条件，个人、企业学员、零基础或非基地学员都可以参加；名额以报名表提交为准。`,
  },
  {
    group: "报名咨询",
    question: "怎么报名？",
    similar: [
      "报名流程怎么弄",
      "报名入口在哪里",
      "报名表在哪里",
      "报名链接发我",
      "二维码发我",
      "麻烦发报名表",
      "在哪里填写信息",
      "怎么填报名信息",
      "我要扫码报名",
      "可以发一下报名二维码吗",
    ],
    answer:
      `可以报名。请填写报名表：${signupUrl}。提交姓名、联系方式和报名场次即可。一般没有特殊报名条件，个人、企业学员、零基础或非基地学员都可以参加；名额以报名表提交为准。`,
  },
  {
    group: "报名咨询",
    question: "报名有什么条件？",
    similar: [
      "Claude Code需要什么报名条件",
      "参加课程有什么要求",
      "不是基地的可以上课吗",
      "个人可以报名吗",
      "企业员工才能报名吗",
      "没有基础能报名吗",
      "需要审核吗",
      "外部人员可以参加吗",
    ],
    answer:
      `可以报名。请填写报名表：${signupUrl}。提交姓名、联系方式和报名场次即可。一般没有特殊报名条件，个人、企业学员、零基础或非基地学员都可以参加；名额以报名表提交为准。`,
  },
  {
    group: "报名咨询",
    question: "报名后可以直接去上课吗？",
    similar: [
      "填完报名表就可以直接去吗",
      "报名后还要做什么",
      "到现场还要签到吗",
      "报完名是不是就可以了",
      "提交报名表后怎么参加",
      "现场怎么确认",
      "到时候直接过去吗",
      "报名成功后要等确认吗",
    ],
    answer:
      `请先填写报名表：${signupUrl}。提交后按本期课程信息到场参加，到场后现场签到即可。`,
  },
  {
    group: "报名咨询",
    question: "可以带同事或朋友一起去吗？",
    similar: [
      "可以带同事吗",
      "朋友也想报名",
      "两个人一起参加可以吗",
      "能不能帮朋友报名",
      "可以带家人吗",
      "同事需要单独报名吗",
      "团队可以一起报名吗",
      "我和朋友一起去可以吗",
    ],
    answer:
      `可以一起参加。为方便统计人数，建议每位参加者都单独填写报名表：${signupUrl}。`,
  },
  {
    group: "费用说明",
    question: "课程收费吗？",
    similar: [
      "多少钱",
      "免费吗",
      "需要交费吗",
      "培训不收费吧",
      "公开课收费吗",
      "体验课多少钱",
      "这个活动要钱吗",
      "周六课收费吗",
      "报名要不要付费",
    ],
    answer:
      "公开体验课目前免费。后续进阶课程如需收费，会单独说明。",
  },
  {
    group: "费用说明",
    question: "使用模型的 token 怎么收费？",
    similar: [
      "token怎么收费",
      "Claude费用怎么算",
      "模型费用谁承担",
      "上课会产生额外费用吗",
      "需要充值吗",
      "DS要不要钱",
      "Claude账号要自己买吗",
      "模型使用费大概多少",
      "一次课token要花多少钱",
    ],
    answer:
      "课程免费；模型账号、token或充值费用由学员自行承担，实际金额取决于个人使用量。",
  },
  {
    group: "时间安排",
    question: "这周或下周有课吗？",
    similar: [
      "周末有课吗",
      "近期还有课吗",
      "这周六有课吗",
      "下周有课吗",
      "什么时候还有课",
      "最近一期是哪天",
      "本周开课吗",
      "下一场是什么时候",
      "广州最近有课吗",
      "这周活动安排",
    ],
    answer:
      "本周六有课：Claude Code 业务小助手搭建实战课，6月27日 10:00-17:00，地点在粤港澳大湾区（广东）创新创业孵化基地。",
  },
  {
    group: "时间安排",
    question: "每周六都有这个课程吗？",
    similar: [
      "是不是每周都有",
      "周周有课是固定的吗",
      "每周主题一样吗",
      "每周六都开吗",
      "下周还是同一个课吗",
      "这个课会一直开吗",
      "每周都有AI课吗",
      "每次内容一样吗",
    ],
    answer:
      "一般周六会安排活动，但每周主题可能不同，具体以当期课程为准。",
  },
  {
    group: "时间安排",
    question: "课程上多久？",
    similar: [
      "一天吗",
      "课时怎么安排",
      "几点开始",
      "几点结束",
      "需要多长时间",
      "上午还是下午",
      "要上一整天吗",
      "下午有实操吗",
      "课程时间表",
    ],
    answer:
      "本期是1天实战课，时间为10:00-17:00。课程会从业务需求出发，带大家完成一个Claude Code业务小助手Demo。",
  },
  {
    group: "时间安排",
    question: "节假日有课吗？",
    similar: [
      "端午有课吗",
      "假期有课吗",
      "这周端午上课吗",
      "节假日安排",
      "五一有课吗",
      "假期还开课吗",
      "周六如果放假还上吗",
    ],
    answer:
      "节假日可能暂停或调整，请看当期课程安排。",
  },
  {
    group: "上课地点",
    question: "上课地点在哪里？",
    similar: [
      "活动地址在哪里",
      "广州场在哪里",
      "具体地址发我",
      "在哪里上课",
      "基地在哪里",
      "外创馆在哪里",
      "导航到哪里",
      "上课地址是什么",
      "粤港澳基地地址",
      "离哪个地铁站近",
    ],
    answer:
      "地点通常在粤港澳大湾区（广东）创新创业孵化基地，地址：广州市天河区兴盛路10、12、14号。",
  },
  {
    group: "上课地点",
    question: "具体在哪个教室？",
    similar: [
      "几楼上课",
      "办公室在哪",
      "楼层房号有吗",
      "A栋几楼",
      "培训室在哪里",
      "具体教室发我",
      "到了去哪个房间",
      "教室号是多少",
      "A栋219吗",
    ],
    answer:
      "具体教室看本期信息。到场后也可以按现场指引或联系工作人员。",
  },
  {
    group: "上课地点",
    question: "午休多久？附近有吃饭的地方吗？",
    similar: [
      "中午休息多久",
      "附近吃饭方便吗",
      "附近有饭堂吗",
      "中午怎么吃饭",
      "园区有餐厅吗",
      "午餐怎么安排",
      "中午能出去吃吗",
      "附近有什么吃的",
    ],
    answer:
      "午休一般约2小时，园区附近有餐饮和饭堂，可到场后咨询工作人员。",
  },
  {
    group: "上课地点",
    question: "有停车位吗？",
    similar: [
      "停车方便吗",
      "车停在哪里",
      "车牌要不要登记",
      "停车场在哪里",
      "可以开车去吗",
      "有没有停车场",
      "停车怎么收费",
      "车牌需要提前报吗",
      "停车位置发我",
    ],
    answer:
      "部分场地可停车。如需停车，请提前告知车牌号或按现场要求登记。",
  },
  {
    group: "课时内容",
    question: "课程会讲什么内容？",
    similar: [
      "大概讲什么",
      "AI实战课内容",
      "Claude Code课讲什么",
      "小龙虾课程是什么",
      "课程内容发我",
      "适合什么方向",
      "会不会实操",
      "主要学什么",
      "能学到什么",
      "课程主题是什么",
    ],
    answer:
      "本周课程是Claude Code业务小助手搭建实战课，会讲Claude Code能做什么、如何把业务需求交给AI执行，并完成一个业务小助手Demo。",
  },
  {
    group: "课时内容",
    question: "Claude Code 零基础课讲什么？",
    similar: [
      "Claude Code怎么上",
      "会教安装Claude Code吗",
      "没有装Claude Code能来吗",
      "Claude Code适合小白吗",
      "会讲AI编程吗",
      "Claude Code是干嘛的",
      "Claude Code零基础能学吗",
      "代码不会能听懂吗",
    ],
    answer:
      "会讲Claude Code能做什么、如何理解业务需求、拆解任务、推进步骤并生成结果，最后完成一个自己的业务小助手Demo。",
  },
  {
    group: "课时内容",
    question: "AI Skill 课程讲什么？",
    similar: [
      "周日活动内容是什么",
      "AI Skill是什么课",
      "会讲哪些工具",
      "OpenClaw会讲吗",
      "Cline会讲吗",
      "国内大模型会讲吗",
      "AI工作流是什么",
      "这个课能搭建什么",
    ],
    answer:
      "AI Skill课程围绕AI工作台和工具组合实操，如OpenClaw、Claude Code、Cline和国内大模型等。",
  },
  {
    group: "课时内容",
    question: "上课会产出作品吗？",
    similar: [
      "当天能做出作品吗",
      "零基础能不能做出来",
      "实操课会有什么成果",
      "能做自己的skill吗",
      "上完能做项目吗",
      "会不会只是听课",
      "有没有现场练习",
      "能不能带着做出来",
    ],
    answer:
      "会。本期最终成果是完成一个属于自己的Claude Code业务小助手Demo，体验从提出业务需求到AI拆解任务、执行流程、生成结果的完整过程。",
  },
  {
    group: "课时内容",
    question: "本期讲师是谁？",
    similar: [
      "老师是谁",
      "谁来讲课",
      "讲师介绍",
      "本周讲师是谁",
      "Thomas Zhang是谁",
      "陈健谋是谁",
      "这次有哪些老师",
      "老师背景是什么",
    ],
    answer:
      "本期讲师为 Thomas Zhang（剑桥大学博士）和陈健谋（企业AI应用与算力部署实战讲师）。",
  },
  {
    group: "上课准备",
    question: "需要带电脑吗？",
    similar: [
      "上课要自带电脑吗",
      "带电脑过去就可以了吗",
      "电脑需要什么配置",
      "不带电脑可以吗",
      "手机可以上课吗",
      "要带充电器吗",
      "现场有电脑吗",
      "实操课要电脑吗",
    ],
    answer:
      "需要带电脑。本期是业务小助手搭建实战课，建议带好充电器，并确保电脑可以正常上网。",
  },
  {
    group: "上课准备",
    question: "需要提前安装 Claude Code 吗？",
    similar: [
      "没装Claude Code怎么办",
      "现场能帮忙安装吗",
      "安装很难吗",
      "课前要准备什么软件",
      "要提前配置环境吗",
      "不会安装怎么办",
      "到现场再装可以吗",
      "需要先注册账号吗",
    ],
    answer:
      "不用太担心，课程会讲安装和基础配置；没提前安装也可以现场跟着做。",
  },
  {
    group: "适合人群",
    question: "零基础可以参加吗？",
    similar: [
      "小白能学吗",
      "完全没基础可以吗",
      "不会AI可以报名吗",
      "不懂代码可以吗",
      "没有技术背景能听懂吗",
      "普通人可以学吗",
      "新手适合吗",
      "第一次接触AI可以吗",
    ],
    answer:
      "可以。本期课程零基础也能跟上，不需要编程经验，适合想用AI搭建业务小助手、提升工作效率的学员。",
  },
  {
    group: "适合人群",
    question: "年纪大或退休人员适合吗？",
    similar: [
      "退休人员能学吗",
      "年龄大可以上吗",
      "不懂技术适合吗",
      "中老年可以参加吗",
      "学起来会不会很难",
      "没有电脑基础可以吗",
      "只是感兴趣可以来吗",
    ],
    answer:
      "可以根据兴趣报名。课程会从基础讲起，适合愿意动手体验AI工具的学员。",
  },
  {
    group: "线上回放",
    question: "有线上课或回放吗？",
    similar: [
      "可以线上参加吗",
      "有没有回放",
      "线下去不了怎么办",
      "这节课有线上吗",
      "能不能直播",
      "有没有录播",
      "错过了还能看吗",
      "可以发资料自学吗",
      "外地可以参加吗",
    ],
    answer:
      "目前主要是线下实操课。线上课或回放要看当期是否安排。",
  },
  {
    group: "社群资料",
    question: "有学习资料或答疑群吗？",
    similar: [
      "有资料吗",
      "有课程群吗",
      "怎么进群",
      "有答疑群吗",
      "课件会给吗",
      "资料在哪里拿",
      "有没有学习群",
      "课后可以问问题吗",
      "能拉我进群吗",
    ],
    answer:
      "有课程群。报名后可加入群，群内会同步资料、地址和答疑信息。",
  },
  {
    group: "社群资料",
    question: "地址和通知在哪里看？",
    similar: [
      "群公告在哪里",
      "课程信息在哪看",
      "报名后怎么知道地址",
      "教室在哪里看",
      "课程通知在哪里",
      "报名后会提醒吗",
      "上课前会发消息吗",
      "有没有群通知",
    ],
    answer:
      "可以看报名表、本期课程信息或课程群公告。固定地点为粤港澳大湾区（广东）创新创业孵化基地。",
  },
  {
    group: "进阶课程",
    question: "后续有进阶课程吗？",
    similar: [
      "进阶课程怎么安排",
      "进阶课收费吗",
      "有没有系统课",
      "后面还有更深入的吗",
      "有长期班吗",
      "有训练营吗",
      "想继续学怎么办",
      "进阶课上几天",
      "周末班怎么安排",
    ],
    answer:
      "后续可能会有进阶课程，内容会更系统、更偏项目实操；费用和课时会单独说明。",
  },
  {
    group: "其他课程",
    question: "有腾讯 CodeX 相关课程吗？",
    similar: [
      "有Codex课吗",
      "讲不讲腾讯Codex",
      "有没有其他AI编程工具课",
      "CodeX会教吗",
      "Cursor会讲吗",
      "除了Claude Code还有什么",
      "有没有AI编程系列课",
      "会不会讲腾讯工具",
    ],
    answer:
      "目前主要是Claude Code、Cline和AI工具实战，暂时没有专门的CodeX课程。",
  },
  {
    group: "信息收集",
    question: "你是怎么了解到我们的？",
    similar: [
      "客户来源怎么问",
      "从哪里看到活动",
      "你在哪里看到课程信息",
      "通过什么渠道知道的",
      "是朋友推荐的吗",
      "公众号看到的吗",
      "是在群里看到的吗",
      "方便问下来源吗",
    ],
    answer:
      "方便问一下，你是从哪里看到课程信息的呢？例如公众号、朋友推荐、课程群、基地通知等。",
  },
];

for (const row of rows) {
  if (row.group.length > 12) throw new Error(`分组名超过12字：${row.group}`);
  if (row.question.length > 200) throw new Error(`问题超过200字：${row.question}`);
  if (row.answer.length > 500) throw new Error(`答案超过500字：${row.question}`);
}

await fs.mkdir(outputDir, { recursive: true });
const input = await FileBlob.load(templatePath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("快捷回复列表");

const startRow = 8;
const values = rows.map((row) => [
  row.group,
  row.question,
  row.similar.join("\n"),
  row.answer,
]);

const target = sheet.getRange(`A${startRow}:D${startRow + rows.length - 1}`);
target.values = values;
target.format.wrapText = true;
target.format.borders = { preset: "all", style: "thin", color: "#D9D9D9" };
target.format.font = { name: "Microsoft YaHei", size: 10 };

sheet.getRange(`A${startRow}:A${startRow + rows.length - 1}`).format.columnWidth = 14;
sheet.getRange(`B${startRow}:B${startRow + rows.length - 1}`).format.columnWidth = 30;
sheet.getRange(`C${startRow}:C${startRow + rows.length - 1}`).format.columnWidth = 42;
sheet.getRange(`D${startRow}:D${startRow + rows.length - 1}`).format.columnWidth = 58;
sheet.getRange(`A${startRow}:D${startRow + rows.length - 1}`).format.autofitRows();

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
  range: `A7:D${startRow + rows.length - 1}`,
  maxChars: 4000,
  tableMaxRows: 8,
  tableMaxCols: 4,
  tableMaxCellChars: 80,
});
console.log(summary.ndjson);
console.log(JSON.stringify({ outputPath, previewPath, rowCount: rows.length }, null, 2));

