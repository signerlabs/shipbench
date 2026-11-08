/**
 * 餐厅品类表（单一数据源）
 *
 * 品类由后端控制，iOS 通过 GET /v1/config 动态拉取，修改品类不需要 iOS 发版。
 * config 下发、Gemini 自动分类共用此文件，保证品类口径一致。
 *
 * 存储约定：REST 实体的 categories 字段为品类 name 数组（string[]，可多选），
 * 例如 ["面馆", "烧烤"]。categories 挂在 REST（餐厅）实体上，不在 POST 上。
 */

export interface RestaurantCategory {
  /** 品类名称（存储与展示用的唯一标识） */
  name: string;
  /** 品类说明（举例，仅用于 UI 展示和 Gemini 参考） */
  description: string;
}

/** 15 项预定义品类表（定稿，顺序即展示顺序） */
export const RESTAURANT_CATEGORIES: RestaurantCategory[] = [
  { name: '面馆', description: '拉面、小面、刀削面、热干面等' },
  { name: '粉店', description: '米粉、米线、螺蛳粉、肠粉' },
  { name: '饺子馄饨', description: '饺子、馄饨、云吞、锅贴' },
  { name: '包子铺', description: '包子、生煎、馒头、烧麦' },
  { name: '炒菜小馆', description: '家常菜、地方菜小馆（川湘东北西北等）' },
  { name: '烧烤', description: '烤串、烤肉、撸串摊' },
  { name: '火锅串串', description: '火锅、串串香、涮锅' },
  { name: '麻辣烫', description: '麻辣烫、冒菜、关东煮' },
  { name: '小吃', description: '煎饼果子、肉夹馍、凉皮、臭豆腐等' },
  { name: '卤味熟食', description: '卤菜、卤鸭脖、凉拌菜' },
  { name: '早餐店', description: '豆浆油条、粥铺、早点摊' },
  { name: '快餐简餐', description: '盖浇饭、黄焖鸡、自选快餐' },
  { name: '烘焙甜品', description: '面包房、蛋糕店、甜品铺' },
  { name: '奶茶饮品', description: '奶茶、果汁、咖啡小店' },
  { name: '大排档', description: '海鲜大排档、夜市摊、露天排档' },
];

/** 合法品类名集合（用于快速校验） */
export const CATEGORY_NAME_SET = new Set(RESTAURANT_CATEGORIES.map((c) => c.name));

/**
 * 过滤并规范化品类输入
 *
 * 只保留在预定义品类表内的品类名，去重、去空白，最多保留 5 个（多选上限）。
 * 非数组或全部非法时返回空数组。用于 Gemini 分类结果的入口清洗，
 * 防止脏数据（错别字、越界品类）写入 REST 实体。
 */
export function sanitizeCategories(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!CATEGORY_NAME_SET.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
    if (result.length >= 5) break;
  }
  return result;
}
