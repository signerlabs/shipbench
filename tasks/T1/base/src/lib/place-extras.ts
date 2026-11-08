/**
 * 店铺地图详情（2026-10-22 产品负责人定：评分、照片、营业时间、推荐菜这些能存都存，App 怎么显示以后改版再定）
 *
 * 店定到高德（内地、港澳）或 Google（台湾、境外）的编号后，按编号取一次全量详情：
 *   - 高德用新版 v5 详情（show_fields 全开，比 v3 多给推荐菜 rectag、今日营业时间）；
 *     杭州转发还没放行 v5 时退回 v3（extensions=all），内容基本一样，只缺这两项
 *   - Google 用 Place Details (New) 全字段
 *   - 原始响应整份存 S3：place-details/<店>/<来源>-<编号>.json
 *   - 照片转存 S3：place-photos/<店>/<来源>-<序号>.<扩展名>（给多少存多少：高德开放接口给 3 张，Google 最多 10 张；
 *     照另一个项目的做法转存，免得外链失效）
 *   - 店上记 placeDetails：电话、营业时间、评分、人均或价位、特色和推荐菜、营业状态等整理过的字段，加照片的 S3 key
 * 调用方：解析 Lambda 新建与重刷定到店之后、后台改店写编号时、挪帖子建新店时、补存脚本 scripts/place-extras-backfill.ts。
 * 只存店上现有编号的详情（店上的编号不是这个就不存）；同一编号 30 天内存过就跳过（force 除外）。失败只记日志，不挡主流程。
 */

import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { amapFetchJson } from './amap-geocode.js';
import { SHARED_TABLE } from './dynamodb.js';
import { languageForCountry } from './google-places.js';
import { uploadToS3 } from './s3.js';

export type PlaceSource = 'amap' | 'google';

export interface PlacePhoto {
  /** S3 key（经图片 CDN 访问） */
  key: string;
  width?: number;
  height?: number;
  /** Google 照片的作者（显示时要署名） */
  author?: string;
  authorUri?: string;
}

/** 店上 placeDetails 的结构：整理过的常用字段；原始响应在 S3 的 rawKey */
export interface PlaceDetails {
  source: PlaceSource;
  id: string;
  /** 取的哪版接口：amap-v5 / amap-v3 / google */
  api: string;
  fetchedAt: string;
  name?: string;
  phone?: string;
  /** Google 的国际格式电话 */
  internationalPhone?: string;
  website?: string;
  /** Google 地图上这家店的链接 */
  mapsUrl?: string;
  /** 营业时间原文：高德一周（v5 opentime_week，v3 opentime2）；Google 按星期七行 */
  hours?: string[];
  /** 高德今日营业时间（v5 opentime_today） */
  hoursToday?: string;
  /** Google 结构化营业时间（periods），高德没有 */
  openingPeriods?: unknown[];
  /** Google 给的店所在地时区（IANA，如 Asia/Tokyo）；App 按它算「营业中」（2026-10-27 起存，高德都是北京时间） */
  timeZone?: string;
  rating?: number;
  /** Google 的评分人数 */
  ratingCount?: number;
  /** 高德人均（当地货币：内地是元，港澳看着是港币、澳门元） */
  avgPrice?: number;
  /** Google 价位（PRICE_LEVEL_*）与价格区间 */
  priceLevel?: string;
  priceRange?: unknown;
  /** 高德特色（tag，多是菜名），拆成数组 */
  tags?: string[];
  /** 高德推荐（v5 rectag），拆成数组 */
  recommended?: string[];
  /** 高德主标签（keytag，如「拉面」） */
  keyTag?: string;
  /** Google 营业状态：OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY */
  businessStatus?: string;
  /** 类别：高德 type；Google primaryType */
  type?: string;
  typeLabel?: string;
  /** Google 简介 */
  summary?: string;
  /** 高德商圈、别名 */
  businessArea?: string;
  alias?: string;
  /** Google 的服务项（堂食、外带、外送、订位、供早午晚餐、素食、户外座位等，有就记） */
  options?: Record<string, boolean>;
  photos: PlacePhoto[];
  /** 地图给了几张照片（转存失败的不在 photos 里，补存脚本据此补） */
  photoTotal: number;
  /** 原始响应的 S3 key */
  rawKey: string;
}

type Raw = Record<string, unknown>;
type Normalized = Omit<PlaceDetails, 'photos' | 'photoTotal' | 'rawKey' | 'fetchedAt'>;

/** 高德没有值时给 []，统一成字符串 */
const amapStr = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
const amapNum = (v: unknown): number | undefined => {
  const n = Number(amapStr(v));
  return amapStr(v) && Number.isFinite(n) ? n : undefined;
};
const splitTags = (v: unknown): string[] => [...new Set(amapStr(v).split(/[,，;；]/).map((s) => s.trim()).filter(Boolean))];
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

/** 去掉值为 undefined 或空串、空数组的字段（DynamoDB 写不进 undefined，空值也没必要存） */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))) as T;
}

/** 高德 v5 详情（show_fields=children,business,indoor,navi,photos）→ 整理过的字段 */
export function normalizeAmapV5(id: string, p: Raw): Normalized {
  const b = obj(p['business']);
  const week = amapStr(b['opentime_week']);
  return compact({
    source: 'amap' as const,
    id,
    api: 'amap-v5',
    name: amapStr(p['name']) || undefined,
    phone: amapStr(b['tel']) || undefined,
    hours: week ? [week] : undefined,
    hoursToday: amapStr(b['opentime_today']) || undefined,
    rating: amapNum(b['rating']),
    avgPrice: amapNum(b['cost']),
    tags: splitTags(b['tag']),
    recommended: splitTags(b['rectag']),
    keyTag: amapStr(b['keytag']) || undefined,
    type: amapStr(p['type']) || undefined,
    businessArea: amapStr(b['business_area']) || undefined,
    alias: amapStr(b['alias']) || undefined,
  });
}

/** 高德 v3 详情（extensions=all）→ 整理过的字段（转发没放行 v5 时用） */
export function normalizeAmapV3(id: string, p: Raw): Normalized {
  const biz = obj(p['biz_ext']);
  const hours = amapStr(biz['opentime2']) || amapStr(biz['open_time']);
  return compact({
    source: 'amap' as const,
    id,
    api: 'amap-v3',
    name: amapStr(p['name']) || undefined,
    phone: amapStr(p['tel']) || undefined,
    website: amapStr(p['website']) || undefined,
    hours: hours ? [hours] : undefined,
    rating: amapNum(biz['rating']),
    avgPrice: amapNum(biz['cost']),
    tags: splitTags(p['tag']),
    keyTag: amapStr(p['keytag']) || undefined,
    type: amapStr(p['type']) || undefined,
    businessArea: amapStr(p['business_area']) || undefined,
    alias: amapStr(p['alias']) || undefined,
  });
}

/** Google 服务项里是布尔值的字段，有就记 */
const GOOGLE_OPTIONS = [
  'dineIn', 'takeout', 'delivery', 'curbsidePickup', 'reservable', 'servesBreakfast', 'servesBrunch', 'servesLunch',
  'servesDinner', 'servesBeer', 'servesWine', 'servesCocktails', 'servesCoffee', 'servesDessert', 'servesVegetarianFood',
  'outdoorSeating', 'liveMusic', 'menuForChildren', 'goodForChildren', 'goodForGroups', 'goodForWatchingSports',
  'allowsDogs', 'restroom',
];

/** Google Place Details (New) 全字段 → 整理过的字段 */
export function normalizeGoogle(id: string, p: Raw): Normalized {
  const text = (v: unknown): string | undefined => (typeof obj(v)['text'] === 'string' ? (obj(v)['text'] as string) : undefined);
  const roh = obj(p['regularOpeningHours']);
  const options = Object.fromEntries(GOOGLE_OPTIONS.filter((k) => typeof p[k] === 'boolean').map((k) => [k, p[k] as boolean]));
  return compact({
    source: 'google' as const,
    id,
    api: 'google',
    name: text(p['displayName']),
    phone: (p['nationalPhoneNumber'] as string | undefined) || (p['internationalPhoneNumber'] as string | undefined),
    internationalPhone: p['internationalPhoneNumber'] as string | undefined,
    website: p['websiteUri'] as string | undefined,
    mapsUrl: p['googleMapsUri'] as string | undefined,
    hours: Array.isArray(roh['weekdayDescriptions']) ? (roh['weekdayDescriptions'] as string[]) : undefined,
    openingPeriods: Array.isArray(roh['periods']) ? (roh['periods'] as unknown[]) : undefined,
    timeZone: typeof obj(p['timeZone'])['id'] === 'string' ? (obj(p['timeZone'])['id'] as string) : undefined,
    rating: typeof p['rating'] === 'number' ? p['rating'] : undefined,
    ratingCount: typeof p['userRatingCount'] === 'number' ? p['userRatingCount'] : undefined,
    priceLevel: p['priceLevel'] as string | undefined,
    priceRange: p['priceRange'] ?? undefined,
    businessStatus: p['businessStatus'] as string | undefined,
    type: p['primaryType'] as string | undefined,
    typeLabel: text(p['primaryTypeDisplayName']),
    summary: text(p['editorialSummary']),
    options: Object.keys(options).length ? options : undefined,
  });
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' };

async function downloadImage(url: string): Promise<{ body: Buffer; contentType: string } | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0]!.trim();
  if (!contentType.startsWith('image/')) return null;
  return { body: Buffer.from(await res.arrayBuffer()), contentType };
}

/** 转发没放行 v5 时，同一进程里不再反复试 v5 */
let amapV5Blocked = false;

async function fetchAmap(amapKey: string, id: string): Promise<{ raw: Raw; details: Normalized; photoUrls: string[] } | null> {
  const pick = (raw: Raw, details: Normalized) => {
    const photos = Array.isArray(raw['photos']) ? (raw['photos'] as Raw[]) : [];
    return { raw, details, photoUrls: photos.map((ph) => amapStr(ph['url']).replace(/^http:/, 'https:')).filter(Boolean) };
  };
  if (!amapV5Blocked) {
    try {
      const params = new URLSearchParams({ key: amapKey, id, show_fields: 'children,business,indoor,navi,photos' });
      const d = await amapFetchJson<{ infocode?: string; pois?: Raw[] }>(`https://restapi.amap.com/v5/place/detail?${params}`);
      if (d.infocode !== '10000') throw new Error(`高德 v5 详情 infocode=${d.infocode}`);
      const raw = (d.pois ?? [])[0];
      return raw ? pick(raw, normalizeAmapV5(id, raw)) : null;
    } catch (err) {
      // 杭州转发只放行了 v3 时回 404：本进程改用 v3
      if (!/HTTP 404/.test(err instanceof Error ? err.message : String(err))) throw err;
      amapV5Blocked = true;
    }
  }
  const params = new URLSearchParams({ key: amapKey, id, extensions: 'all' });
  const d = await amapFetchJson<{ infocode?: string; pois?: Raw[] }>(`https://restapi.amap.com/v3/place/detail?${params}`);
  if (d.infocode !== '10000') throw new Error(`高德 v3 详情 infocode=${d.infocode}`);
  const raw = (d.pois ?? [])[0];
  return raw ? pick(raw, normalizeAmapV3(id, raw)) : null;
}

async function fetchGoogle(googleKey: string, id: string): Promise<Raw | null> {
  const get = async (language: string): Promise<Raw | null> => {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=${language}`, {
      headers: { 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': '*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Google Places details ${res.status}`);
    return (await res.json()) as Raw;
  };
  const en = await get('en');
  if (!en) return null;
  // 台湾的店名、地址用中文（与入库口径一致）
  const country = (Array.isArray(en['addressComponents']) ? (en['addressComponents'] as Raw[]) : [])
    .find((c) => Array.isArray(c['types']) && (c['types'] as string[]).includes('country'))?.['shortText'] as string | undefined;
  const language = languageForCountry(country);
  return language === 'en' ? en : (await get(language)) ?? en;
}

export interface SavePlaceExtrasOptions {
  docClient: DynamoDBDocumentClient;
  restaurantId: string;
  source: PlaceSource;
  id: string;
  amapKey?: string;
  googleKey?: string;
  /** 同一编号 30 天内存过也重取 */
  force?: boolean;
  log?: string;
}

const FRESH_MS = 30 * 24 * 3600 * 1000;

/** 取详情、转存照片和原始响应、写店上的 placeDetails；返回做了什么（跳过时说明原因） */
export async function savePlaceExtras(o: SavePlaceExtrasOptions): Promise<string> {
  const rest = (await o.docClient.send(new GetCommand({ TableName: SHARED_TABLE, Key: { PK: 'REST', SK: o.restaurantId } }))).Item;
  if (!rest) return '店不存在';
  const field = o.source === 'google' ? 'googlePlaceId' : 'amapPoiId';
  if (rest[field] !== o.id) return `店上的${o.source === 'google' ? ' Google ' : '高德'}编号不是 ${o.id}`;
  const prev = rest['placeDetails'] as PlaceDetails | undefined;
  if (!o.force && prev?.id === o.id && Date.now() - Date.parse(prev.fetchedAt) < FRESH_MS
    && prev.photos.length >= (prev.photoTotal ?? 0)) return '30 天内存过';

  let raw: Raw;
  let details: Normalized;
  let sources: Array<{ url: string; width?: number; height?: number; author?: string; authorUri?: string }>;
  if (o.source === 'amap') {
    if (!o.amapKey) return '没有高德 Key';
    const r = await fetchAmap(o.amapKey, o.id);
    if (!r) return '高德没有这个编号';
    raw = r.raw;
    details = r.details;
    sources = r.photoUrls.map((url) => ({ url }));
  } else {
    if (!o.googleKey) return '没有 Google Key';
    const g = await fetchGoogle(o.googleKey, o.id);
    if (!g) return 'Google 没有这个编号';
    raw = g;
    details = normalizeGoogle(o.id, g);
    const photos = Array.isArray(g['photos']) ? (g['photos'] as Raw[]) : [];
    sources = photos.map((ph) => {
      const author = (Array.isArray(ph['authorAttributions']) ? (ph['authorAttributions'] as Raw[]) : [])[0];
      return {
        url: `https://places.googleapis.com/v1/${String(ph['name'])}/media?maxWidthPx=1600&key=${o.googleKey}`,
        width: typeof ph['widthPx'] === 'number' ? ph['widthPx'] : undefined,
        height: typeof ph['heightPx'] === 'number' ? ph['heightPx'] : undefined,
        author: typeof author?.['displayName'] === 'string' ? (author['displayName'] as string) : undefined,
        authorUri: typeof author?.['uri'] === 'string' ? (author['uri'] as string) : undefined,
      };
    });
  }

  const photos: PlacePhoto[] = [];
  for (const [i, src] of sources.entries()) {
    try {
      const img = await downloadImage(src.url);
      if (!img) continue;
      const key = `place-photos/${o.restaurantId}/${o.source}-${i}.${EXT[img.contentType] ?? 'jpg'}`;
      await uploadToS3(key, img.body, img.contentType);
      photos.push(compact({ key, width: src.width, height: src.height, author: src.author, authorUri: src.authorUri }));
    } catch (err) {
      console.warn(`${o.log ?? '[place-extras]'} 照片 ${i} 转存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const rawKey = `place-details/${o.restaurantId}/${o.source}-${o.id}.json`;
  await uploadToS3(rawKey, Buffer.from(JSON.stringify(raw)), 'application/json');

  const placeDetails: PlaceDetails = { ...details, fetchedAt: new Date().toISOString(), photos, photoTotal: sources.length, rawKey };
  await o.docClient.send(new UpdateCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: o.restaurantId },
    UpdateExpression: 'SET placeDetails = :d',
    ConditionExpression: `attribute_exists(PK) AND ${field} = :id`,
    ExpressionAttributeValues: { ':d': placeDetails, ':id': o.id },
  }));
  return `已存（${details.api}）：照片 ${photos.length}/${sources.length} 张${details.rating !== undefined ? `，评分 ${details.rating}` : ''}${details.hours?.length ? '，有营业时间' : ''}${details.recommended?.length ? `，推荐 ${details.recommended.join('、')}` : ''}`;
}

/** 同上，出错只记日志（调用方不用 try/catch，不挡主流程） */
export async function savePlaceExtrasSafe(o: SavePlaceExtrasOptions): Promise<void> {
  const log = o.log ?? '[place-extras]';
  try {
    console.log(`${log} 店铺详情 ${o.restaurantId}（${o.source} ${o.id}）：${await savePlaceExtras(o)}`);
  } catch (err) {
    console.warn(`${log} 店铺详情 ${o.restaurantId}（${o.source} ${o.id}）没存上: ${err instanceof Error ? err.message : String(err)}`);
  }
}
