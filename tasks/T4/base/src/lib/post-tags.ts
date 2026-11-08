/**
 * 帖子标签入库前的清洗（2026-10-26 产品负责人定）
 *
 * 标签只该写这家店的菜系、招牌菜、口味做法（认店代理的提示词已写明）。旧模型常把视频文案里的话题当标签，
 * 新模型偶尔也会，这里兜底去掉三类，保证详情页不再出现：
 *   ① 带抖音的（含 dou 的叫法）：抖音导入对外不提；
 *   ② 创作者头衔、流量计划：「美食推荐官」「青年创作者扶持计划」之类；
 *   ③ 推荐者本人的名号：标签占了推荐者名字的一大半（如推荐者「特别乌啦啦」的「乌啦啦」）。
 *      推荐者是店家自己的号、名字里带菜名时（如「我和你重庆小火锅」的「重庆小火锅」），标签出现在店名或菜名里就留着；
 *      只占名字一小段的（如「麻辣小火郭」的「麻辣」）多半在说口味，也留着。
 * 另外去掉首尾空白、开头的 #，去重。
 */

const PLATFORM_RE = /抖音|抖in|dou\b/i;
const TITLE_RE = /推荐官|创作者|创作人|达人|博主|扶持计划|成长计划|创作计划|美食家计划/;

/** 比较用：去掉空白和常见标点 */
const core = (s: string): string => s.replace(/[\s·.。…!！]+/g, '');

/** 推荐者名字去掉括号里的补充说明（「特厨隋坡（重新出发版）」→「特厨隋坡」） */
const nameCore = (s: string): string => core(s.replace(/[（(][^）)]*[）)]/g, ''));

export interface TagContext {
  /** 推荐者（抖音作者）名字 */
  influencerName?: string;
  /** 店名：代理认出的、地图上的 */
  restaurantNames?: Array<string | undefined>;
  /** 菜名 */
  dishNames?: Array<string | undefined>;
}

export function sanitizeTags(input: unknown, ctx: TagContext = {}): string[] {
  if (!Array.isArray(input)) return [];
  const name = nameCore(ctx.influencerName ?? '');
  const shopWords = [...(ctx.restaurantNames ?? []), ...(ctx.dishNames ?? [])]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .map(core);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#+/, '').trim();
    if (!tag || seen.has(tag)) continue;
    if (PLATFORM_RE.test(tag) || TITLE_RE.test(tag)) continue;
    const t = core(tag);
    const isInfluencerName = name.length > 0 && t.length >= 2 && name.includes(t) && t.length * 2 >= name.length
      && !shopWords.some((w) => w.includes(t));
    if (isInfluencerName) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}
