export const DEFAULT_KNOWLEDGE_SUBCATEGORY = '未分类';
export const PUBLIC_KNOWLEDGE_CATEGORY = '公共知识库';
export const KNOWLEDGE_SUBCATEGORY_CACHE_LIMIT = 10;

export const PLATFORM_KNOWLEDGE_CATEGORY_MAP = Object.freeze({
  xiaohongshu: '小红书知识库',
  douyin: '抖音知识库',
  weibo: '微博知识库',
  wechat_channels: '视频号知识库',
  bilibili: 'B站知识库'
});

export const SYSTEM_KNOWLEDGE_CATEGORIES = [
  PUBLIC_KNOWLEDGE_CATEGORY,
  PLATFORM_KNOWLEDGE_CATEGORY_MAP.xiaohongshu,
  PLATFORM_KNOWLEDGE_CATEGORY_MAP.douyin,
  PLATFORM_KNOWLEDGE_CATEGORY_MAP.weibo,
  PLATFORM_KNOWLEDGE_CATEGORY_MAP.wechat_channels,
  PLATFORM_KNOWLEDGE_CATEGORY_MAP.bilibili
];

const SUBCATEGORY_RULES = [
  { subcategory: '投诉建议', pattern: /投诉|建议|意见|举报|纠纷|不满意|服务态度/, keywords: ['投诉', '建议', '意见反馈'] },
  { subcategory: '费用缴费', pattern: /收费|费用|多少钱|价格|免费|缴费|退款|发票/, keywords: ['费用', '收费', '缴费'] },
  { subcategory: '证件材料', pattern: /材料|证件|证明|身份证|申请表|提交|办理流程/, keywords: ['办理材料', '证件', '申请'] },
  { subcategory: '场地设施', pattern: /场地|会议室|活动室|设施|无障碍|借用|开放空间/, keywords: ['场地', '设施', '借用'] },
  { subcategory: '联系方式', pattern: /电话|联系|微信|邮箱|咨询热线/, keywords: ['联系方式', '咨询电话'] },
  { subcategory: '地址交通', pattern: /地址|哪里|在哪|位置|怎么去|路线|地铁|公交|乘车|停车/, keywords: ['地址', '交通', '位置'] },
  { subcategory: '开放时间', pattern: /几点|时间|上班|下班|开放|营业|工作日|节假日/, keywords: ['开放时间', '办公时间', '上班时间'] },
  { subcategory: '课程培训', pattern: /课程|培训|课堂|粤语|普通话|讲座|学习|开课/, keywords: ['课程', '培训', '开课'] },
  { subcategory: '活动报名', pattern: /活动报名|报名|名额|满员|预约|取消报名|参加活动|活动签到|如何签到/, keywords: ['活动报名', '名额', '预约'] },
  { subcategory: '政策法规', pattern: /政策|法规|法律|条例|规定|资格|补贴|居住证/, keywords: ['政策', '办理条件', '资格'] },
  { subcategory: '社区服务', pattern: /社区|服务中心|便民|长者|儿童|志愿者|社工|遗失|失物|招领|文化交流/, keywords: ['社区服务', '便民服务'] }
];

export function normalizeKnowledgeCategoryName(value = '') {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function validateLevelName(value, label) {
  const name = normalizeKnowledgeCategoryName(value);
  if (!name) return { ok: false, message: `${label}名称不能为空` };
  if (name.length > 30) return { ok: false, message: `${label}名称不能超过30个字` };
  if (!/[\p{L}\p{N}\u3400-\u9FFF]/u.test(name)) return { ok: false, message: `${label}名称需包含文字或数字` };
  if (name === '__CUSTOM__' || name === '__ALL__') return { ok: false, message: `该${label}名称不可使用` };
  return { ok: true, name };
}

export function validateKnowledgeCategoryName(value) {
  const validation = validateLevelName(value, '大类');
  if (!validation.ok) return validation;
  if (!SYSTEM_KNOWLEDGE_CATEGORIES.includes(validation.name)) {
    return { ok: false, message: `知识大类只能选择：${SYSTEM_KNOWLEDGE_CATEGORIES.join('、')}` };
  }
  return validation;
}

export function validateKnowledgeSubcategoryName(value) {
  return validateLevelName(value, '小类');
}

export function knowledgeCategoryForPlatform(platformCode = '') {
  return PLATFORM_KNOWLEDGE_CATEGORY_MAP[String(platformCode || '').trim()] || null;
}

export function allowedKnowledgeCategoriesForPlatform(platformCode = '') {
  // 知识分类只用于运营整理和来源追踪，不再作为平台检索边界。
  // 保留 platformCode 参数是为了兼容旧调用方，但所有平台共享完整知识范围。
  void platformCode;
  return [...SYSTEM_KNOWLEDGE_CATEGORIES];
}

export function classifyKnowledgeCategory(question = '', answer = '') {
  const questionText = String(question || '');
  const questionMatch = SUBCATEGORY_RULES.find(rule => rule.pattern.test(questionText));
  const matched = questionMatch || SUBCATEGORY_RULES.find(rule => rule.pattern.test(String(answer || '')));
  return matched
    ? { category: PUBLIC_KNOWLEDGE_CATEGORY, suggestedSubcategory: matched.subcategory, suggestedKeywords: [...matched.keywords] }
    : { category: PUBLIC_KNOWLEDGE_CATEGORY, suggestedSubcategory: DEFAULT_KNOWLEDGE_SUBCATEGORY, suggestedKeywords: ['社区咨询'] };
}

export function resolveKnowledgeCategory({ category } = {}) {
  const selected = normalizeKnowledgeCategoryName(category) || PUBLIC_KNOWLEDGE_CATEGORY;
  const validation = validateKnowledgeCategoryName(selected);
  if (!validation.ok) throw new Error(validation.message);
  return validation.name;
}

export function resolveKnowledgeSubcategory({ subcategory, customSubcategory } = {}) {
  const selected = normalizeKnowledgeCategoryName(subcategory);
  const candidate = selected === '__CUSTOM__' || selected === '自定义小类' ? customSubcategory : (selected || DEFAULT_KNOWLEDGE_SUBCATEGORY);
  const validation = validateKnowledgeSubcategoryName(candidate);
  if (!validation.ok) throw new Error(validation.message);
  return validation.name;
}

export function knowledgeCategorySortIndex(name) {
  const index = SYSTEM_KNOWLEDGE_CATEGORIES.indexOf(name);
  return index >= 0 ? index : SYSTEM_KNOWLEDGE_CATEGORIES.length;
}
