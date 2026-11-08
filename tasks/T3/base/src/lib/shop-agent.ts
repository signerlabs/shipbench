/**
 * 认店代理（2026-10-20 起导入与重刷的唯一认店方式）
 *
 * 产品负责人定：纯代理模式，一个模型包办；旧的定位规则（同名几家怎么挑、地址点顶替、名字比对关口、城市回环、
 * 补坐标重试队列）一步到位删掉。模型直接看视频、听口播，自己用高德官方 MCP 的工具找店（amap-mcp.ts：
 * 关键字搜、周边搜、详情、地址转坐标、坐标转地址，工具定义照搬官方，不自己造）；名字搜不到就换写法，
 * 同名几家就拿视频里的位置线索挑，拿准了才交，拿不准交候选；交答案时一并整理菜品（含截图时间点）、点评、标签、品类。
 * 考卷（scripts/pipeline-exam.ts，Gemini 3.1 Pro）：核实过答案的 39 家难题定准 34、错位 1；
 * 核实后整卷 167 家定准 127、错位 1（旧规则 + 3.8 Flash 定准 89、错位 5）。
 * 2026-10-21 起换成 Gemini 4 Argon：同一份 39 家各考两遍，Argon 定准 36、35，3.1 Pro 34、33，Argon 两遍都没有错位。
 *
 * 分两层：
 *  - 本文件（管线层，各家模型共用）：提示词、交答案的工具、查询次数和时间上限、交答案后的底线检查；
 *  - 模型接入层（ShopAgentModel，Gemini 见 shop-agent-gemini.ts）：视频怎么交给模型、工具调用格式、用量统计。
 *    换模型只写一个接入层，在考卷上考过再换。
 *
 * 2026-10-21 起境外的店也收（产品负责人定）：中国大陆和港澳用高德，台湾和中国以外用 Google（google-places.ts，
 * 给模型一个按关键字搜店的工具）；境外店名、地址、城市取 Google 英文的，台湾取中文的。
 *
 * 底线写在代码里，不交给模型：
 *  - 坐标只取地图结果：模型只能交它查到过的店铺编号，坐标、地址、城市由代码按编号调高德或 Google 详情取；
 *  - 选中的店地图上不归餐饮类（高德 typecode 不是 05 开头、Google 非餐饮类）时以模型判断为准（2026-10-26 产品负责人定）：
 *    模型看视频认定确实是馆子（地图归错了类），要在 food_category_note 写依据，照收；没写依据的判 not_food、不返回店；
 *  - 查过地图之后又说「不是探店」的按拿不准处理（被叫停交答案时容易乱交，考卷「戳子肉」）；
 *  - 用错了地图（Google 上的大陆港澳店、高德上的台湾店）的，只当候选；
 *  - 店已经不开的（高德店名带「暂停营业」「装修中」，Google 标永久或暂时停业）判 closed、不返回店（2026-10-26 产品负责人定）；
 *  - 店名只来自观众评论、又没有视频里的门牌或邻店招牌互证的，只当候选（2026-10-22 产品负责人定）；
 *  - 查地图全部报错时整次失败（导入转失败、退额度，Lambda 自动重试），不把「没查成」当「拿不准」入库。
 */

import { amapFetchJson, deriveCityLayers } from './amap-geocode.js';
import { AMAP_SHOP_TOOLS, AmapMcpClient } from './amap-mcp.js';
import { emptyUsage, type GeminiUsage } from './gemini-common.js';
import { isFoodPlace, languageForCountry, placeDetails, resolveCity, searchPlaces, type GoogleCity, type GooglePlace } from './google-places.js';
import { RESTAURANT_CATEGORIES } from './restaurant-categories.js';

// ============================================================
// 类型
// ============================================================

export type ModelUsage = GeminiUsage;

/** 菜品 */
export interface DishAnalysis {
  name: string;
  /** 0–1，博主有多推荐 */
  score: number;
  quote: string | null;
  /** MM:SS，截图用 */
  timestamp: string;
  /** 菜品单价，如 "38元" */
  price?: string | null;
  /** 运行时附加：S3 截图 key */
  s3Key?: string;
}

/** 店名出处 */
export type NameEvidence = 'poi' | 'caption' | 'author_comment' | 'signboard' | 'speech' | 'comment' | 'none';

/**
 * low_quality：太短、随手一拍、看不出店；not_xiaodian：全国连锁快餐饮品、酒店早餐自助（2026-10-21 产品负责人定，这两种都拒收）。
 * not_food：吃饭的地方本身不是餐饮店（书店书屋、酒吧、超市、酒店客房、景区乐园、服务区等），或地图上选中的不是餐饮店（2026-10-26 产品负责人定，拒收）。
 * closed：店已经关门、不开了（评论说关了，或地图上标了暂停营业、装修中、停业；2026-10-26 产品负责人定，拒收）。
 * overseas 2026-10-21 起不再交（境外的店改用 Google 找），只有旧的考卷、预览记录里还有
 */
export type AgentDecision = 'located' | 'uncertain' | 'no_name' | 'not_review' | 'overseas' | 'low_quality' | 'not_xiaodian' | 'not_food' | 'closed';

/** 工具查到过的一家店（高德或 Google） */
export interface AgentPoi {
  /** 高德店铺编号，或 Google 的 place_id */
  id: string;
  name: string;
  address: string;
  /** 三层归属：省 / 地级市 / 区县（Google 的店：一级行政区 / 城市 / 空） */
  administrativeArea: string;
  city: string;
  district: string;
  /** 高德类别；Google 的店是 types 用 | 连起来 */
  type: string;
  /** 高德类别编码；Google 的店是空 */
  typecode: string;
  lat: number;
  lng: number;
  /** 哪家地图：中国大陆和港澳用高德，台湾和中国以外用 Google（2026-10-21） */
  source: 'amap' | 'google';
  /** Google 的国家代码（TW、JP 等） */
  countryCode?: string;
  /** Google 的营业状态（OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY） */
  status?: string;
}

/** 认店结果：是不是探店、是哪家店（或候选）、入库用的内容、过程记录 */
export interface ShopAgentResult {
  is_restaurant_review: boolean;
  rejection_reason: string | null;
  /** 认出的店名（located 时入库改用地图上的官方名 chosen.name） */
  restaurant_name?: string;
  name_evidence?: NameEvidence;
  /** 模型给的地级市（没定到位置时当城市线索 cityHint） */
  city?: string;
  location_hint?: string;
  multi_shop?: boolean;
  shop_count?: number;
  dishes: DishAnalysis[];
  blogger_summary?: string;
  price_hint?: string;
  tags?: string[];
  categories?: string[];

  decision: AgentDecision;
  /** decision=located 时选中的店（一定来自工具结果、一定是餐饮店） */
  chosen: AgentPoi | null;
  /** 拿不准时的候选（一定来自工具结果），最多 4 家 */
  candidates: AgentPoi[];
  /** 模型给的依据 */
  reason: string;
  /** 店名只来自观众评论时的互证：视频里哪个门牌、地址或邻店招牌在地图上对上这家店（2026-10-22） */
  comment_name_proof?: string;

  /** 看了视频，还是拿不到视频只看文字 */
  source: 'video' | 'text';
  model: string;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  /** 每次查地图的简记（考卷、排查用） */
  trace: string[];
  usage: ModelUsage;
  ms: number;
}

export interface ShopAgentInput {
  /** 视频；拿不到就 null，只看文字 */
  video: Buffer | null;
  /** 视频时长（秒，抖音元数据）；不到 MIN_VIDEO_SECONDS 直接判 low_quality，不调模型 */
  durationSec?: number;
  description?: string;
  /** 抖音地点标注 */
  poiName?: string;
  /** 评论段文字（douyin-comments buildCommentsExtras 拼好的） */
  commentsText?: string;
  /** 评论图片 */
  images?: Array<{ mimeType: string; data: string }>;
  /** 视频发布时间（douyinPublishedAt 从视频编号算）；写进提示词，两年以上的老视频提醒模型查关门（2026-10-26） */
  publishedAt?: Date;
}

/** 抖音视频编号的高 32 位是发布时刻（Unix 秒）；不在 2016 年到明天之间的当无效 */
export function douyinPublishedAt(awemeId: string | undefined): Date | undefined {
  if (!awemeId || !/^\d{15,20}$/.test(awemeId)) return undefined;
  const sec = Number(BigInt(awemeId) >> 32n);
  const d = new Date(sec * 1000);
  return sec > 1_451_606_400 && d.getTime() < Date.now() + 86_400_000 ? d : undefined;
}

export interface ShopAgentOptions {
  amapKey: string;
  /** 高德官方 MCP 地址（可指向国内转发），默认直连 https://mcp.amap.com/mcp */
  amapMcpUrl?: string;
  /** Google 地图 Key（台湾和中国以外的店用）；没给时 Google 搜店工具回报错，境外的店落成拿不准 */
  googleKey?: string;
  logPrefix?: string;
  /** 查地图最多几次（不含交答案），默认 8 */
  maxToolCalls?: number;
  /** 找店最多多久（毫秒，不含上传视频），到点只许交答案，默认 4 分钟 */
  timeLimitMs?: number;
}

/** 工具定义（JSON Schema，各家接入层按自己的格式转） */
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 交给模型接入层的一次任务 */
export interface AgentJob {
  video: Buffer | null;
  prompt: string;
  images: Array<{ mimeType: string; data: string }>;
  /** 高德官方工具 + submit_answer */
  tools: AgentToolSpec[];
  /** 执行一次查询工具，返回给模型的结果 */
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 查询次数或时间用完了：接入层只许模型调 submit_answer，并把 submitNudge 告诉它 */
  mustSubmit(): boolean;
  submitNudge: string;
  log: string;
}

/** 模型接入层跑完一次任务的产出：submit_answer 的参数（没交就是 null） */
export interface AgentRun {
  answer: Record<string, unknown> | null;
  turns: number;
  usage: ModelUsage;
}

/** 模型接入层：视频怎么交给模型、工具调用格式、用量统计。各家一个 */
export interface ShopAgentModel {
  readonly name: string;
  run(job: AgentJob): Promise<AgentRun>;
}

/** 查地图全部报错（高德国内转发、高德或 Google 不可用），整次导入转失败、交给 Lambda 重试 */
export class AmapUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmapUnavailableError';
  }
}

// ============================================================
// 提示词
// ============================================================

const DEFAULT_MAX_TOOL_CALLS = 8;
const DEFAULT_TIME_LIMIT_MS = 4 * 60_000;
/**
 * 不到这么多秒的视频直接判 low_quality（2026-10-21 产品负责人定「就几秒的视频没有价值，直接不录入」）。
 * 交给模型判不稳：7 秒的卷口禾记，模型从评论里认出店名就照常去找店了
 */
export const MIN_VIDEO_SECONDS = 10;

function buildPrompt(input: ShopAgentInput, maxToolCalls: number): string {
  let prompt = '';
  if (!input.video) prompt += '这次拿不到视频画面，只能根据下面的文字判断：认不出店名就交 no_name，dishes 交空数组。\n\n';
  if (input.durationSec && input.durationSec > 0) prompt += `视频时长：${Math.round(input.durationSec)} 秒。\n\n`;
  if (input.publishedAt) {
    const years = Math.floor((Date.now() - input.publishedAt.getTime()) / (365.25 * 86_400_000));
    prompt += `视频发布于 ${input.publishedAt.getUTCFullYear()} 年 ${input.publishedAt.getUTCMonth() + 1} 月${years >= 1 ? `（约 ${years} 年前）` : ''}。\n\n`;
  }
  if (input.description) prompt += `视频文案：${input.description}\n\n`;
  prompt += `你是美食探店视频的分析助手。你要完成两件事：一、认出这是哪一家店，并在地图上找到它（中国大陆和港澳的店用高德，台湾和中国以外的店用 Google）；二、整理博主吃了什么、怎么评价。

能用的信息：视频画面和声音、视频文案、抖音地点标注（如果下面给了）、评论区（「博主本人说的」最可信）。
能用的工具：高德地图官方的 maps_text_search（按关键字搜店）、maps_around_search（在某个坐标附近搜店）、maps_search_detail（按编号看一家店的详情，含坐标）、maps_geo（把地址、商场、地标、路口变成坐标）、maps_regeocode（坐标转地址）；Google 地图的 google_search_places（按关键字搜店，台湾和中国以外的店用它）。最后一定要调用 submit_answer，一次交齐全部答案。

一、先判断是不是探店、收不收
- 是：博主在店里吃、点评具体的菜。路边摊、夜市摊位、食堂、商家自己拍的店铺介绍都算。
- 不是：在家做饭或教程、只拍风景或旅行、婚礼生日等活动、零食饮料等产品测评、和吃无关的内容。不是探店就直接交 not_review，不用查地图。
- 太短、没有价值：视频只有十几秒、随手一拍，既没有像样地介绍这家店，也没有点评菜（比如只拍一眼门头、一口菜、一段排队），交 low_quality，不用查地图。短但有店名、有菜、有点评的照收。
- 不是小店：这个地图收街头巷尾的小馆子、小吃摊、老字号，也收高档餐厅；只有两类不收，交 not_xiaodian：① 麦当劳、肯德基、汉堡王、德克士、必胜客、赛百味、星巴克、瑞幸、喜茶、蜜雪冰城这类全国连锁的快餐和饮品（奶茶、咖啡）品牌；② 星级酒店的早餐、自助餐（酒店里正式点菜的餐厅不算，照收）。全国连锁的正餐（火锅、中餐等）、本地只有几家分店的小连锁照收。拿不准就照常找店，不要判 not_xiaodian。
- 不是餐饮店：这个地图只收吃饭的地方（餐馆、小吃摊、夜市摊位、食堂、咖啡甜品茶饮店、现做现卖的糕点小吃都算）。博主吃喝的地方本身不是餐饮店的——书店书屋、酒吧夜店、超市便利店、卖生鲜水果奶品特产等货品的店、商场百货、酒店客房、景区乐园、高速服务区、私人住宅或不对外营业的工作室——交 not_food，不用查地图。商场、景区里开的某一家餐厅照常找那家店。

二、认店名
- 店名必须先从视频或文字里认出来，按可靠程度：地点标注 › 文案 › 博主本人评论 › 画面里看清的招牌、门头、菜单、小票、包装 › 口播里说清的店名 › 观众评论。
- 店名只来自观众评论时要有互证：视频里的门牌号、写出来的地址或旁边店铺的招牌，在地图上和这家店的位置对得上，才能交 located，并在 comment_name_proof 里写清是哪个门牌或招牌、第几秒；没有这样的互证就交 uncertain。
- 认不出真实字号就交 no_name。不要按菜品或类型编名字（「肠粉店」「火锅店」都不行），也不要拿菜名、菜系去高德搜、再从搜到的店里挑一家当店名——那是猜，不是认。
- 不要把商场、街区、景点、路名、小区、城市当店名；商场里的店要用店自己的名字。

三、在地图上找店
- 先认出城市。店开在中国大陆或港澳用高德（国内开的日料、西餐也是）；开在台湾或中国以外用 google_search_places。
- 高德：按名字在城市里搜（maps_text_search 带上 city，citylimit 填 true）；完全不知道城市才全国搜。
- 名字可能有出入（分店后缀、繁简体、错别字、简称、英文名），搜不到就换个写法；或者先用 maps_geo 定位视频里的街道、商场、地标、路口，再用 maps_around_search 在附近找。
- maps_text_search 的结果里没有坐标；要核对地址、区县或坐标时用 maps_search_detail 看详情。
- Google：query 写店名加城市，知道街区、地址就加上；店名可以用招牌原文（日文、英文等）、英文名、罗马音，搜不到就换写法。结果里有编号 id、店名、地址、坐标、营业状态 status。
- 店还开不开：高德店名带「暂停营业」「装修中」，或 Google 的 status 是 CLOSED_PERMANENTLY（永久停业）、CLOSED_TEMPORARILY（暂停营业），说明这家已经不开了，不要选它；视频讲的就是这家时交 closed。视频发布超过两年的，店可能已经关门、搬走或换了名字：特别看评论区（尤其是最近的评论）有没有人说关门、倒闭、没了、搬走、换老板；明确说关了又找不到新址的交 closed，说搬了的按新址找。
- 搜到好几家同名的（连锁店、同名别家），用视频里的位置线索挑：区县、街道门牌、商场楼层、附近的店和地标、分店名、口音和车牌。挑不出来就不要硬选。
- 认定之前核对：名字对得上（允许分店后缀不同），位置和视频线索不矛盾，是吃饭的地方。
- 地图上的类别：高德搜店结果的 typecode 05 开头是餐饮，别的开头不是（06 购物、07 生活服务、08 休闲娱乐含酒吧、10 住宿、11 景点、12 商务住宅等），详情里的 type 也能看。选中的店不归餐饮类时，按视频判断：确实是对外营业、在店里吃饭或买现做吃食的馆子（地图归错了类），照常交 located，并在 food_category_note 写一句依据；本身不是餐饮店（酒吧、卖货品的店、酒店、景点等），交 not_food。
- 一轮可以同时发几个查询；同一家店的详情不用重复看。查地图最多 ${maxToolCalls} 次，用完就直接交答案。

四、一条视频讲了好几家店：只找、只写视频里最先正式介绍的那一家（开场一闪而过的预告不算），multi_shop 填 true，shop_count 填大概几家；菜品、点评也只写这一家的。

五、台湾和国外的店：店名照招牌或文案原样写，不用翻译；city 台湾写县市名（如「台北市」），国外写城市的英文名（如 Tokyo）；location_hint 写上国家、城市和视频里能确定的最具体的位置（街区、地址、车站、商场）。

六、交答案（submit_answer）
- decision：located（确定是地图上的某一家，poi_id 填它的编号：高德的编号或 Google 的 id）/ uncertain（认出了店名，但地图上几家拿不准、或者搜不到，candidate_ids 放最可能的几家，没有就空）/ no_name / not_review / low_quality / not_xiaodian / not_food / closed（店已经关门、不开了）。交 not_review、low_quality、not_xiaodian、not_food、closed 时在 rejection_reason 里写一句原因。
- poi_id 和 candidate_ids 只能填工具返回过的编号。宁可交 uncertain，也不要选错——选错会把用户带到别的店去。
- restaurant_name 照原样写认出的店名，不加城市；name_evidence 写店名出处（poi / caption / author_comment / signboard / speech / comment，认不出填 none）。
- city：店所在的地级市标准名，带「市」（香港填「香港特别行政区」；台湾和国外见第五条）；location_hint：视频里能确定的最具体的位置，开头带城市名。
- dishes：博主吃到并评价的菜。timestamp 必填，格式 MM:SS，是给这道菜截配图的那一秒：要这道菜的特写——菜在画面中间、占画面一大半、看得清，画面里最好没有人脸；不要选博主正在吃、正在对着镜头说话的时候。特写通常在刚端上桌、夹起来或者舀起来展示的时候，和博主说原话的时间可以不一样。score 0–1 表示博主有多推荐；quote 是博主对这道菜的原话（1–2 句）；price 是单价（如「38元」）。
- blogger_summary：博主对这家店的整体评价，1–2 句；price_hint：人均价格线索；categories 只能从下面这份品类表里选 1–3 个，原样使用品类名：${RESTAURANT_CATEGORIES.map((c) => `${c.name}（${c.description}）`).join('；')}
- tags：2–5 个，只写这家店的菜系、招牌菜和口味做法（如「川菜」「饸饹面」「麻辣」「炭烤」「皮薄馅大」）；不写城市地名，不写环境、服务、价格、排队，不写视频文案里的话题、平台和活动，不写博主的名字或头衔，也不写「探店」「美食」这类泛词。
- reason：一两句话写依据（哪一秒的画面看到了什么、文案或评论怎么说、地址怎么对上）。
- 菜名、点评、博主原话照视频里说的语言写（中文视频就写中文），不要附翻译或拼音；tags、reason 用中文。`;
  if (input.poiName) prompt += `\n\n抖音地点标注：「${input.poiName}」。标注可能挂错，和视频、文案对得上才用。`;
  if (input.commentsText) prompt += input.commentsText;
  return prompt;
}

const SUBMIT_NUDGE = '查询次数或时间已经用完。请现在就调用 submit_answer，按已经掌握的信息交齐全部答案：'
  + '拿不准是哪一家就交 uncertain 并附上最可能的候选，不要因为没找到就改判 not_review 或 low_quality。';

// ============================================================
// 工具
// ============================================================

/** Google 搜店（台湾和中国以外的店用；高德的查询工具用官方 MCP 的，见 amap-mcp.ts） */
const GOOGLE_SEARCH_TOOL: AgentToolSpec = {
  name: 'google_search_places',
  description: '在 Google 地图上按关键字搜店（台湾和中国以外的店用；中国大陆和港澳的店用高德）。返回最多 6 家餐饮店：编号 id、店名、地址、坐标 location（纬度,经度）、营业状态 status。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '店名加城市，知道街区、地址就加上；店名可用招牌原文、英文名或罗马音' },
    },
    required: ['query'],
  },
};

/** 交答案 */
const SUBMIT_TOOL: AgentToolSpec = {
    name: 'submit_answer',
    description: '交答案（最后一步，必须调用一次，交齐全部字段）。',
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['located', 'uncertain', 'no_name', 'not_review', 'low_quality', 'not_xiaodian', 'not_food', 'closed'] },
        rejection_reason: { type: 'string', description: '不是探店、太短没价值、不是小店、不是餐饮店、店已关门时写原因' },
        food_category_note: { type: 'string', description: '选中的店在地图上不归餐饮类、但看视频确实是吃饭的馆子时，写一句依据（地图归错了类）' },
        restaurant_name: { type: 'string', description: '认出的真实店名（照原样，不加城市）；认不出留空' },
        name_evidence: { type: 'string', enum: ['poi', 'caption', 'author_comment', 'signboard', 'speech', 'comment', 'none'] },
        city: { type: 'string', description: '店所在的城市：国内写地级市，带「市」；台湾写县市名；国外写英文名' },
        location_hint: { type: 'string', description: '视频里能确定的最具体的位置，开头带城市名' },
        poi_id: { type: 'string', description: 'decision=located 时选中的店铺编号（高德的编号或 Google 的 id）' },
        candidate_ids: { type: 'array', items: { type: 'string' }, description: 'decision=uncertain 时最可能的几家' },
        multi_shop: { type: 'boolean' },
        shop_count: { type: 'integer' },
        dishes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              timestamp: { type: 'string', description: 'MM:SS，这道菜特写的那一秒（用来截配图）' },
              score: { type: 'number', description: '0–1' },
              quote: { type: 'string' },
              price: { type: 'string' },
            },
            required: ['name', 'timestamp', 'score'],
          },
        },
        blogger_summary: { type: 'string' },
        price_hint: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: '2–5 个：菜系、招牌菜、口味做法' },
        categories: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', description: '一两句话写依据' },
        comment_name_proof: { type: 'string', description: '店名只来自观众评论（name_evidence=comment）时必填：视频里哪个门牌号、地址或旁边店铺的招牌，在地图上和这家店的位置对得上（写清是什么、第几秒）；没有就留空' },
      },
      required: ['decision', 'name_evidence', 'multi_shop', 'dishes', 'reason'],
    },
  };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

function toPoi(p: Record<string, unknown>): AgentPoi | null {
  const id = str(p['id']);
  const [lng, lat] = str(p['location']).split(',').map(Number);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const layers = deriveCityLayers(p['pname'], p['cityname'], p['adname']);
  return {
    id, name: str(p['name']), address: str(p['address']),
    administrativeArea: layers.administrativeArea, city: layers.locality, district: layers.subLocality,
    type: str(p['type']), typecode: str(p['typecode']), lat, lng, source: 'amap',
  };
}

/** Google 的一家店；city 给了才有城市（搜索结果当候选时不另查城市） */
function googlePoi(p: GooglePlace, city?: GoogleCity | null): AgentPoi {
  return {
    id: p.placeId, name: p.name, address: p.address ?? '',
    administrativeArea: city?.administrativeArea ?? '', city: city?.city ?? '', district: '',
    type: p.types.join('|'), typecode: '', lat: p.lat, lng: p.lng, source: 'google',
    ...(p.countryCode ? { countryCode: p.countryCode } : {}),
    ...(p.status ? { status: p.status } : {}),
  };
}

/** 餐饮服务大类（高德 typecode 05 开头，可能多值用 | 分隔） */
export function isFoodPoi(typecode: string): boolean {
  return typecode.split('|').some((c) => /^05/.test(c.trim()));
}

function isFoodAgentPoi(p: AgentPoi): boolean {
  return p.source === 'google' ? isFoodPlace(p.type.split('|')) : isFoodPoi(p.typecode);
}

/** 店已经不开了：高德店名带「暂停营业」「装修中」，Google 标永久或暂时停业（2026-10-26） */
function isClosedPoi(p: AgentPoi): boolean {
  return p.source === 'google' ? p.status === 'CLOSED_PERMANENTLY' || p.status === 'CLOSED_TEMPORARILY' : /暂停营业|装修中/.test(p.name);
}

/** 用错了地图：Google 上的大陆港澳店、高德上的台湾店（中国大陆和港澳用高德，台湾和中国以外用 Google，产品负责人 10/21 定） */
function wrongMap(p: AgentPoi): boolean {
  return p.source === 'google' ? ['CN', 'HK', 'MO'].includes(p.countryCode ?? '') : p.administrativeArea.startsWith('台湾');
}

/** 高德店铺编号（如 B0FFF9WDRN） */
const POI_ID_RE = /^B[0-9A-Z]{9}$/;

/** 从官方工具的结果里收集出现过的店铺编号（交答案时核对：只能交查到过的） */
function collectPoiIds(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    v.forEach((x) => collectPoiIds(x, out));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'id' && typeof x === 'string' && POI_ID_RE.test(x)) out.add(x);
      else collectPoiIds(x, out);
    }
  }
}

/** 按编号调高德详情（Web 服务 v3，经 amapFetchJson，可走国内转发）：坐标、地址、三层城市、类别都从这里取，不信模型 */
export async function fetchPoi(amapKey: string, id: string): Promise<AgentPoi | null> {
  const params = new URLSearchParams({ key: amapKey, id });
  const d = await amapFetchJson<{ infocode?: string; pois?: Array<Record<string, unknown>> }>(`https://restapi.amap.com/v3/place/detail?${params}`);
  if (d.infocode !== '10000') throw new Error(`高德详情 infocode=${d.infocode}`);
  const raw = (d.pois ?? [])[0];
  return raw ? toPoi(raw) : null;
}

/** 按 Google 编号取详情：店名、地址按国家换语言（台湾中文，其余英文），城市按坐标反查，都不信模型 */
async function fetchGooglePoi(googleKey: string, id: string): Promise<AgentPoi | null> {
  let p = await placeDetails(googleKey, id, 'en');
  if (!p) return null;
  const language = languageForCountry(p.countryCode);
  if (language !== 'en') p = (await placeDetails(googleKey, id, language)) ?? p;
  return googlePoi(p, await resolveCity(googleKey, p.lat, p.lng, language));
}

// ============================================================
// 交答案后的底线检查
// ============================================================

const DECISIONS: AgentDecision[] = ['located', 'uncertain', 'no_name', 'not_review', 'low_quality', 'not_xiaodian', 'not_food', 'closed'];

/** 拒收类判定的默认原因（模型没写 rejection_reason 时用） */
const REJECT_DEFAULTS: Partial<Record<AgentDecision, string>> = {
  not_review: '非探店视频',
  low_quality: '太短，看不出是哪家店',
  not_xiaodian: '不是小店',
  not_food: '不是餐饮店',
  closed: '店已关门',
};
const EVIDENCES: NameEvidence[] = ['poi', 'caption', 'author_comment', 'signboard', 'speech', 'comment', 'none'];

function normalizeDishes(v: unknown): DishAnalysis[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d): DishAnalysis[] => {
    if (!d || typeof d !== 'object') return [];
    const o = d as Record<string, unknown>;
    const name = str(o['name']);
    if (!name) return [];
    let score = typeof o['score'] === 'number' ? o['score'] : Number(o['score']);
    if (!Number.isFinite(score)) score = 0.5;
    // 推荐分应在 0–1，模型偶尔按 10 分制给（8.9）→ 换算回来
    if (score > 1) score = Math.min(1, score <= 10 ? score / 10 : 1);
    const quote = str(o['quote']);
    const price = str(o['price']);
    return [{ name, score, quote: quote || null, timestamp: str(o['timestamp']), ...(price ? { price } : {}) }];
  });
}

interface RunState {
  /** 高德官方工具结果里出现过的店铺编号 */
  seenIds: Set<string>;
  /** Google 搜店结果里出现过的店（编号 → 搜索结果，当候选时直接用，不另查） */
  googlePlaces: Map<string, GooglePlace>;
  toolCalls: number;
  toolErrors: number;
  trace: string[];
}

async function finalize(
  answer: Record<string, unknown> | null, state: RunState, opts: ShopAgentOptions, log: string,
): Promise<Omit<ShopAgentResult, 'source' | 'model' | 'turns' | 'toolCalls' | 'toolErrors' | 'trace' | 'usage' | 'ms'>> {
  const a = answer ?? {};
  let decision = (DECISIONS as string[]).includes(str(a['decision'])) ? (str(a['decision']) as AgentDecision) : 'uncertain';
  let reason = str(a['reason']) || (answer ? '' : '没交答案');
  const city = str(a['city']);
  const locationHint = str(a['location_hint']);

  // 只认查到过的编号；坐标、地址、城市、类别由代码按编号取高德或 Google 详情
  const poiId = str(a['poi_id']);
  let chosen: AgentPoi | null = null;
  if (decision === 'located') {
    if (state.seenIds.has(poiId)) chosen = await fetchPoi(opts.amapKey, poiId);
    else if (state.googlePlaces.has(poiId) && opts.googleKey) chosen = await fetchGooglePoi(opts.googleKey, poiId);
    if (!chosen) {
      console.warn(`${log} 交的编号 ${poiId || '（空）'} 不在查到的结果里或查不到详情，按拿不准处理`);
      decision = 'uncertain';
      reason = `交的编号不在查到的结果里。${reason}`;
    }
  }
  const candidateIds = [...new Set((Array.isArray(a['candidate_ids']) ? a['candidate_ids'] : []).map(str))]
    .filter((id) => (state.seenIds.has(id) || state.googlePlaces.has(id)) && id !== chosen?.id).slice(0, 4);
  const candidates = (await Promise.all(candidateIds.map((id) => {
    const g = state.googlePlaces.get(id);
    return g ? googlePoi(g) : fetchPoi(opts.amapKey, id).catch(() => null);
  }))).filter((p): p is AgentPoi => !!p);
  // 店已经不开了（高德标暂停营业、装修中，Google 标停业）：判关门，不返回店、也不留作候选（2026-10-26 产品负责人定）
  let closedRejection = '';
  if (chosen && isClosedPoi(chosen)) {
    console.warn(`${log} 选中的「${chosen.name}」已经不开了（${chosen.status ?? '店名标了暂停营业或装修中'}），判关门`);
    closedRejection = chosen.source === 'google' ? `Google 上「${chosen.name}」标了停业（${chosen.status}）` : `高德上「${chosen.name}」标了暂停营业或装修中`;
    reason = `店已经不开了。${reason}`;
    chosen = null;
    decision = 'closed';
  }
  // 选中的店地图上不归餐饮类：以模型判断为准（2026-10-26 产品负责人定）。模型写了依据（确实是馆子、地图归错了类）照收；
  // 没写的判不是餐饮店，不返回店、也不留作候选（非餐饮的不上地图）
  let foodRejection = '';
  const foodNote = str(a['food_category_note']);
  if (chosen && !isFoodAgentPoi(chosen)) {
    if (foodNote) {
      console.warn(`${log} 选中的「${chosen.name}」地图上不归餐饮类（${chosen.type}），模型认定是馆子，照收：${foodNote}`);
      reason = `地图上归在非餐饮类（${chosen.type}），按模型判断照收：${foodNote}。${reason}`;
    } else {
      console.warn(`${log} 选中的「${chosen.name}」不是餐饮店（${chosen.type}），模型没写依据，判不是餐饮店`);
      foodRejection = `地图上的「${chosen.name}」不是餐饮店（${chosen.type}）`;
      reason = `选中的不是餐饮店。${reason}`;
      chosen = null;
      decision = 'not_food';
    }
  }
  if (chosen && wrongMap(chosen)) {
    console.warn(`${log} 选中的「${chosen.name}」用错了地图（${chosen.source} ${chosen.countryCode ?? chosen.administrativeArea}），只当候选`);
    candidates.unshift(chosen);
    chosen = null;
    decision = 'uncertain';
    reason = `用错了地图（中国大陆和港澳用高德，台湾和中国以外用 Google）。${reason}`;
  }
  // 观众评论说的店名要有互证（2026-10-22 产品负责人定）：视频里的门牌、地址或邻店招牌在地图上对上这家店的位置；没有就按拿不准处理
  const commentProof = str(a['comment_name_proof']);
  if (chosen && str(a['name_evidence']) === 'comment' && !commentProof) {
    console.warn(`${log} 店名只有观众评论说、视频里没有门牌或邻店招牌互证，只当候选`);
    candidates.unshift(chosen);
    chosen = null;
    decision = 'uncertain';
    reason = `店名只有观众评论说，视频里没有门牌或邻店招牌在地图上对上位置。${reason}`;
  }
  if (decision === 'not_review' && state.toolCalls > 0) {
    console.warn(`${log} 查过地图后又判不是探店，按拿不准处理`);
    decision = 'uncertain';
  }
  // 太短没价值应当一看就知道：查过地图又这么判，多半是没找到店拿它兜底（同 not_review）
  if (decision === 'low_quality' && state.toolCalls > 0) {
    console.warn(`${log} 查过地图后又判太短没价值，按拿不准处理`);
    decision = 'uncertain';
  }
  // 不是小店可以查过地图再判（先认出是连锁品牌），不设这条限制

  const name = str(a['restaurant_name']);
  const evidence = (EVIDENCES as string[]).includes(str(a['name_evidence'])) ? (str(a['name_evidence']) as NameEvidence) : 'none';
  const shopCount = Number(a['shop_count']);
  const rejectDefault = REJECT_DEFAULTS[decision];
  return {
    is_restaurant_review: decision !== 'not_review',
    rejection_reason: rejectDefault ? (closedRejection || foodRejection || str(a['rejection_reason']) || rejectDefault) : null,
    ...(name ? { restaurant_name: name } : {}),
    name_evidence: name ? evidence : 'none',
    ...(city ? { city } : {}),
    ...(locationHint ? { location_hint: locationHint } : {}),
    multi_shop: a['multi_shop'] === true,
    ...(Number.isFinite(shopCount) && shopCount > 0 ? { shop_count: shopCount } : {}),
    dishes: rejectDefault ? [] : normalizeDishes(a['dishes']),
    ...(str(a['blogger_summary']) ? { blogger_summary: str(a['blogger_summary']) } : {}),
    ...(str(a['price_hint']) ? { price_hint: str(a['price_hint']) } : {}),
    tags: Array.isArray(a['tags']) ? a['tags'].map(str).filter(Boolean) : [],
    categories: Array.isArray(a['categories']) ? a['categories'].map(str).filter(Boolean) : [],
    decision,
    chosen,
    candidates: decision === 'not_food' || decision === 'closed' ? [] : candidates.filter((p) => p.id !== chosen?.id).slice(0, 4),
    reason,
    ...(commentProof ? { comment_name_proof: commentProof } : {}),
  };
}

// ============================================================
// 入口
// ============================================================

const mcpClients = new Map<string, AmapMcpClient>();
function mcpClientFor(key: string, url?: string): AmapMcpClient {
  const k = `${url ?? ''}|${key}`;
  let c = mcpClients.get(k);
  if (!c) {
    c = url ? new AmapMcpClient(key, url) : new AmapMcpClient(key);
    mcpClients.set(k, c);
  }
  return c;
}

/**
 * 认店：交给模型接入层跑一次「看视频 + 查地图 + 交答案」，再做底线检查。
 * 拿到视频但这一趟失败（文件处理失败等）→ 退回只看文字再认一次；查地图全部报错 → 直接抛 AmapUnavailableError。
 */
export async function runShopAgent(model: ShopAgentModel, input: ShopAgentInput, opts: ShopAgentOptions): Promise<ShopAgentResult> {
  const log = opts.logPrefix ?? '[shop-agent]';

  // 太短的视频不调模型（也不连高德），直接判 low_quality。source 记 video：这是按视频本身判的，
  // 不能落到解析 Lambda「只看文字没认出店」的失败分支（视频下载失败时也照样拒收）
  const sec = input.durationSec;
  if (typeof sec === 'number' && sec > 0 && sec < MIN_VIDEO_SECONDS) {
    console.log(`${log} 视频只有 ${sec} 秒（不到 ${MIN_VIDEO_SECONDS} 秒），判太短没价值，不调模型`);
    return {
      is_restaurant_review: true,
      rejection_reason: `视频只有 ${sec} 秒`,
      name_evidence: 'none',
      multi_shop: false,
      dishes: [],
      tags: [],
      categories: [],
      decision: 'low_quality',
      chosen: null,
      candidates: [],
      reason: `视频只有 ${sec} 秒，不到 ${MIN_VIDEO_SECONDS} 秒`,
      source: 'video',
      model: model.name,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      trace: [],
      usage: emptyUsage(),
      ms: 0,
    };
  }

  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const timeLimitMs = opts.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS;
  const mcp = mcpClientFor(opts.amapKey, opts.amapMcpUrl);
  const amapTools: AgentToolSpec[] = (await mcp.listTools())
    .map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));

  const attempt = async (video: Buffer | null): Promise<ShopAgentResult> => {
    const t0 = Date.now();
    const state: RunState = { seenIds: new Set(), googlePlaces: new Map(), toolCalls: 0, toolErrors: 0, trace: [] };
    let deadline = 0; // 上传视频不算时间：第一次查询或第一次问模型时才开始计
    const job: AgentJob = {
      video,
      prompt: buildPrompt({ ...input, video }, maxToolCalls),
      images: input.images ?? [],
      tools: [...amapTools, GOOGLE_SEARCH_TOOL, SUBMIT_TOOL],
      async callTool(name, args) {
        if (!deadline) deadline = Date.now() + timeLimitMs;
        // 硬上限：模型一轮可以同时发好几个查询，超出的不真查（考卷上查满 8 次的店没有一家最后定到）
        if (state.toolCalls >= maxToolCalls) {
          state.trace.push(`${name}(${JSON.stringify(args)}) → 超过查询上限，没查`);
          return { error: '查询次数已用完，请直接调用 submit_answer 交答案' };
        }
        state.toolCalls++;
        let result: Record<string, unknown>;
        // 没配 Google Key 不算查地图报错：境外的店落成拿不准，不整次失败重试（重试也还是没有 Key）
        let isMapError = true;
        if (name === GOOGLE_SEARCH_TOOL.name) {
          const query = str(args['query']);
          if (!opts.googleKey) {
            result = { error: 'Google 地图暂时用不了' };
            isMapError = false;
          } else if (!query) {
            result = { error: '缺少 query' };
          } else {
            try {
              // 结果用中文给模型看（日文招牌的汉字、台湾的店名好对）；入库的店名地址交答案后按编号另取
              const places = (await searchPlaces(opts.googleKey, query, { language: 'zh-CN', max: 10 })).slice(0, 6);
              places.forEach((p) => state.googlePlaces.set(p.placeId, p));
              result = { places: places.map((p) => ({ id: p.placeId, name: p.name, address: p.address, location: `${p.lat},${p.lng}`, status: p.status ?? 'OPERATIONAL' })) };
            } catch (err) {
              result = { error: `Google 请求失败：${err instanceof Error ? err.message : String(err)}` };
            }
          }
        } else if (!(AMAP_SHOP_TOOLS as readonly string[]).includes(name)) {
          result = { error: `没有这个工具：${name}` };
        } else {
          try {
            const text = await mcp.callTool(name, args);
            let parsed: unknown;
            try { parsed = JSON.parse(text); } catch { parsed = text; }
            collectPoiIds(parsed, state.seenIds);
            result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { result: parsed };
          } catch (err) {
            result = { error: `高德请求失败：${err instanceof Error ? err.message : String(err)}` };
          }
        }
        if ('error' in result && isMapError) state.toolErrors++;
        const list = result['pois'] ?? result['places'];
        const pois = Array.isArray(list) ? list.length : null;
        state.trace.push(`${name}(${JSON.stringify(args)}) → ${pois !== null ? `${pois} 家` : 'error' in result ? String(result['error']) : '有结果'}`);
        return result;
      },
      mustSubmit() {
        if (!deadline) deadline = Date.now() + timeLimitMs;
        return state.toolCalls >= maxToolCalls || Date.now() >= deadline;
      },
      submitNudge: SUBMIT_NUDGE,
      log,
    };
    const run = await model.run(job);
    if (state.toolCalls > 0 && state.toolErrors === state.toolCalls) {
      throw new AmapUnavailableError(`查地图 ${state.toolCalls} 次全部失败：${state.trace[state.trace.length - 1] ?? ''}`);
    }
    const out = await finalize(run.answer, state, opts, log);
    state.trace.push(`交答案：${out.decision}${out.chosen ? ` ${out.chosen.name}` : ''}`);
    console.log(`${log} 认店 ${out.decision}${out.chosen ? `「${out.chosen.name}」` : out.restaurant_name ? `「${out.restaurant_name}」` : ''}，查地图 ${state.toolCalls} 次、${run.turns} 轮、${Math.round((Date.now() - t0) / 1000)}s`);
    // 查询过程与依据写进日志（线上排查用：为什么定到这家、为什么拿不准）
    console.log(`${log} 查询记录：\n${state.trace.join('\n')}\n依据：${out.reason}`);
    return {
      ...out,
      source: video ? 'video' : 'text',
      model: model.name, turns: run.turns, toolCalls: state.toolCalls, toolErrors: state.toolErrors,
      trace: state.trace, usage: run.usage ?? emptyUsage(), ms: Date.now() - t0,
    };
  };

  if (input.video) {
    try {
      return await attempt(input.video);
    } catch (err) {
      if (err instanceof AmapUnavailableError) throw err;
      console.warn(`${log} 看视频这一趟失败，退回只看文字再认一次:`, err);
    }
  }
  return attempt(null);
}
