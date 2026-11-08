/**
 * 首页 Feed 路由
 *
 * GET /  — 好店发现 Feed（品质排序 / 时间排序，同城全量直出 + 空城全国降级）
 *
 * 数据来源：shared 表 feed-index (GSI4)，GSI4PK = FEEDCITY#{normalizedCity}，
 *           GSI4SK = {createdAt}#{postId}（倒序即最新优先）。Projection ALL，免回表读 POST 全字段。
 *
 * 品质排序公式（2026-07-02 权重倒转，按信号含金量：复推 > 收藏 > 赞）：
 *   qualityScore = (postRefsCount-1)×5 + totalBookmarks×2 + postLikeCount×1 + tastyCount×2 − untastyCount×3
 *   - postRefsCount / totalBookmarks / tastyCount / untastyCount 来自 REST 实体（BatchGet 拿）
 *   - postLikeCount 来自 POST 实体（零成本互动且最易刷量，权重最低；App 2026-10-21 起不再有点赞入口，存量照算）
 *   - 好吃 / 不好吃（2026-10-21）：吃过的人表态，好吃与收藏同权；不好吃扣得更重，不好吃多的店往后排
 *
 * 同店打散：排序后每家店只保留最前 1 条 POST 进 Feed，其余在店详情页可见，
 *           防止高复推店的多条 POST 集体高分刷屏（复推双重放大）。
 *
 * 无图降权（2026-07-02）：quality 排序第一优先级为「有图优先」，无图帖整体沉底，治理 Feed 视觉质量。
 *           2026-10-28 起卡片图换成店铺照片（不再下发视频封面），「有图」改看店上有没有店铺照片。
 *
 * 去时间窗（2026-07-25）：同城/全国均为全量候选纯 quality 排序。原时间窗分层兜底
 *           会在「最窄窗口恰有 1 条新帖」时把整页 Feed 塌缩成 1 家店（北京线上实测：
 *           7 天窗 1 条挡住全量 390 条）；新鲜 ≠ 有价值。头部固化留待 DAU 上量后
 *           再以时间衰减因子解决。
 *
 * 安全：所有对外 POST 必须经 processPostsForResponse（map awemeId → 过滤 contentStatus →
 *       出口剥离 recommendedBy）。
 */

import { Hono } from 'hono';
import { QueryCommand, BatchGetCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { identityMiddleware, getIdentity } from '../middleware/auth.js';
import { getDocClient, SHARED_TABLE, toStringArray } from '../lib/dynamodb.js';
import { processPostsForResponse } from '../lib/post-utils.js';

export const feedRoute = new Hono();

feedRoute.use('*', identityMiddleware);

// ============================================================
// Feed 内存缓存（5 分钟）：全国 + 同城 per-city 共用
// 缓存内容为排序打散后的完整序列，翻页请求直接内存 slice，不重复拉库
// ============================================================

interface CacheEntry<T> {
  data: T;
  expireAt: number;
}
const FEED_CACHE_TTL = 5 * 60 * 1000;
const feedCache = new Map<string, CacheEntry<Record<string, unknown>[]>>();

function getFeedCache(key: string): Record<string, unknown>[] | null {
  const entry = feedCache.get(key);
  if (entry && Date.now() < entry.expireAt) return entry.data;
  feedCache.delete(key);
  return null;
}
function setFeedCache(key: string, data: Record<string, unknown>[]): void {
  feedCache.set(key, { data, expireAt: Date.now() + FEED_CACHE_TTL });
}

// ============================================================
// REST 维度数据（品质分 + 闭店过滤用）
// ============================================================

interface RestMeta {
  totalBookmarks: number;
  tastyCount: number;
  untastyCount: number;
  postRefsCount: number;
  permanentlyClosed: boolean;
  /** 第三层（rescueStatus=owner）：人工也没找准，2026-10-24 起先不给用户看 */
  rescueOwner: boolean;
  hasCoordinates: boolean;
  latitude?: number;
  longitude?: number;
  /** 店上有店铺照片（卡片图用它） */
  hasPhoto: boolean;
  exists: boolean;
}

async function batchGetRestMeta(
  docClient: ReturnType<typeof getDocClient>,
  restIds: string[],
): Promise<Map<string, RestMeta>> {
  const map = new Map<string, RestMeta>();
  const BATCH_SIZE = 100;

  for (let i = 0; i < restIds.length; i += BATCH_SIZE) {
    const batch = restIds.slice(i, i + BATCH_SIZE);
    let keys = batch.map((id) => ({ PK: 'REST', SK: id }));

    while (keys.length > 0) {
      const res = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [SHARED_TABLE]: {
            Keys: keys,
            ProjectionExpression: 'SK, totalBookmarks, tastyCount, untastyCount, postRefs, permanentlyClosed, rescueStatus, latitude, longitude, placeDetails.photos[0]',
          },
        },
      }));
      for (const item of res.Responses?.[SHARED_TABLE] ?? []) {
        map.set(item['SK'] as string, {
          totalBookmarks: (item['totalBookmarks'] as number) || 0,
          tastyCount: Math.max(0, (item['tastyCount'] as number) || 0),
          untastyCount: Math.max(0, (item['untastyCount'] as number) || 0),
          postRefsCount: toStringArray(item['postRefs']).length,
          permanentlyClosed: item['permanentlyClosed'] === true,
          rescueOwner: item['rescueStatus'] === 'owner',
          hasCoordinates: item['latitude'] != null,
          latitude: item['latitude'] as number | undefined,
          longitude: item['longitude'] as number | undefined,
          hasPhoto: Boolean((item['placeDetails'] as { photos?: { key?: string }[] } | undefined)?.photos?.[0]?.key),
          exists: true,
        });
      }
      const unprocessed = res.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
      keys = (unprocessed && unprocessed.length > 0) ? unprocessed as typeof keys : [];
    }
  }
  return map;
}

/** 帖子对外可见：approved 或无 contentStatus（兼容存量运营导入） */
function isPubliclyVisible(post: Record<string, unknown>): boolean {
  const status = post['contentStatus'] as string | undefined;
  return !status || status === 'approved';
}

function qualityScore(post: Record<string, unknown>, rest: RestMeta | undefined): number {
  const likes = (post['postLikeCount'] as number) || 0;
  const bookmarks = rest?.totalBookmarks || 0;
  const refs = rest?.postRefsCount || 0;
  const tasty = rest?.tastyCount || 0;
  const untasty = rest?.untastyCount || 0;
  // 复推（多个同城真人独立背书）最贵最难伪造 ×5；收藏（会去的意图）×2；赞（零成本）×1；
  // 好吃（吃过的人说好）×2；不好吃 ×3 扣分，让差评多的店沉下去
  return Math.max(0, refs - 1) * 5 + bookmarks * 2 + likes * 1 + tasty * 2 - untasty * 3;
}

function getCreatedAt(post: Record<string, unknown>): string {
  return (post['createdAt'] as string)
    || (post['publishedAt'] as string)
    || '';
}

/** 帖子的卡片有没有图（= 店上有店铺照片；无图帖对 Feed 浏览者几乎零信息量） */
function hasImage(post: Record<string, unknown>, restMap: Map<string, RestMeta>): boolean {
  return restMap.get(post['restaurantId'] as string)?.hasPhoto === true;
}

/**
 * 对候选 POST 集合做 REST 元数据补充 + 闭店/缺失过滤，返回 [可见候选, restMetaMap]。
 */
async function enrichAndFilterCandidates(
  docClient: ReturnType<typeof getDocClient>,
  posts: Record<string, unknown>[],
): Promise<{ posts: Record<string, unknown>[]; restMap: Map<string, RestMeta> }> {
  const visible = posts.filter(isPubliclyVisible);
  const restIds = [...new Set(visible.map((p) => p['restaurantId'] as string).filter(Boolean))];
  const restMap = await batchGetRestMeta(docClient, restIds);
  // 过滤：餐厅存在 + 未闭店 + 不在第三层 + 城市有效（排除 city=unknown/空的脏数据）+ 有坐标
  const filtered = visible.filter((p) => {
    const city = p['city'] as string | undefined;
    if (!city || city === 'unknown') return false;
    const meta = restMap.get(p['restaurantId'] as string);
    return meta?.exists && !meta.permanentlyClosed && !meta.rescueOwner && meta.hasCoordinates;
  });
  return { posts: filtered, restMap };
}

function sortCandidates(
  posts: Record<string, unknown>[],
  restMap: Map<string, RestMeta>,
  sort: string,
): Record<string, unknown>[] {
  const arr = [...posts];
  if (sort === 'latest') {
    arr.sort((a, b) => getCreatedAt(b).localeCompare(getCreatedAt(a)));
  } else {
    // quality（默认）：有图优先 → 品质分降序 → 同分按时间倒序
    // （2026-07-02 无图降权：无图帖整体沉底，治理 Feed 视觉质量）
    arr.sort((a, b) => {
      const ib = hasImage(b, restMap) ? 1 : 0;
      const ia = hasImage(a, restMap) ? 1 : 0;
      if (ib !== ia) return ib - ia;
      const sb = qualityScore(b, restMap.get(b['restaurantId'] as string));
      const sa = qualityScore(a, restMap.get(a['restaurantId'] as string));
      if (sb !== sa) return sb - sa;
      return getCreatedAt(b).localeCompare(getCreatedAt(a));
    });
  }
  return arr;
}

/** 同店打散：每家店只保留排序最前的 1 条 POST（quality 下即该店最高分那条） */
function dedupeByRestaurant(posts: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return posts.filter((p) => {
    const rid = p['restaurantId'] as string;
    if (seen.has(rid)) return false;
    seen.add(rid);
    return true;
  });
}

// ============================================================
// 游标（base64 JSON）：{ level, offset }
// level 仅区分 national / 同城；旧版 App 在飞的时间窗层游标（7d/30d/90d/city-all）
// 一律按 offset 在同城全量序列续页（层已废除，最多一页轻微跳变）
// ============================================================

interface FeedCursor {
  level: string;
  offset: number;
}
function encodeCursor(cur: FeedCursor): string {
  return Buffer.from(JSON.stringify(cur)).toString('base64');
}
function decodeCursor(raw: string): FeedCursor | null {
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    if (typeof obj?.level === 'string' && typeof obj?.offset === 'number') return obj as FeedCursor;
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// GSI4 查询：拿某城市全部候选 POST（倒序）
// ============================================================

/**
 * feed 入参宽松匹配变体（方案 B 红线①：新老版本兼容）
 * - 新版 App：传 regeo 后标准 cityname（如「成都市」「延边朝鲜族自治州」）→ 精确命中 FEEDCITY#{locality}
 * - 老版本 App：传 CLGeocoder 串 → 去/加「市」后缀变体覆盖后缀差异（「成都」↔「成都市」）
 * GSI 分区键等值查询限制下，跨名（老版本「延吉市」→ DB「延边朝鲜族自治州」）仍 miss
 * （产品负责人定案：拿空、忽略、靠用户更新）。
 */
function feedCityVariants(input: string): string[] {
  const t = input.trim();
  if (!t) return [];
  const stripped = t.replace(/(市|自治州|盟|地区)$/, '');
  return [...new Set([t, stripped, `${stripped}市`])].filter(Boolean);
}

async function queryCityCandidates(
  docClient: ReturnType<typeof getDocClient>,
  cityInput: string,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  // 多变体等值 query 合并去重（后续 sortCandidates 会统一重排，合并顺序不影响最终排序）
  for (const variant of feedCityVariants(cityInput)) {
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res: QueryCommandOutput = await docClient.send(new QueryCommand({
        TableName: SHARED_TABLE,
        IndexName: 'feed-index',
        KeyConditionExpression: 'GSI4PK = :pk',
        ExpressionAttributeValues: { ':pk': `FEEDCITY#${variant}` },
        ScanIndexForward: false, // createdAt 倒序
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const it of res.Items ?? []) {
        const sk = it['SK'] as string;
        if (!seen.has(sk)) { seen.add(sk); results.push(it); }
      }
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
  }
  return results;
}

async function queryNationalCandidates(
  docClient: ReturnType<typeof getDocClient>,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res: QueryCommandOutput = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'POST' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (res.Items) results.push(...res.Items);
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return results;
}

// ============================================================
// GET / — Feed
// ============================================================

feedRoute.get('/', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const scope = c.req.query('scope') || 'city';
  const rawCity = c.req.query('city') || '';
  const sort = c.req.query('sort') === 'latest' ? 'latest' : 'quality';
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 50);
  const cursor = c.req.query('cursor') ? decodeCursor(c.req.query('cursor')!) : null;

  // ---- 全国 Feed（直接请求 scope=national，或同城为空降级到这里） ----
  const serveNational = async (offset: number) => {
    const cacheKey = `national-${sort}`;
    let sorted = getFeedCache(cacheKey);
    if (!sorted) {
      const raw = await queryNationalCandidates(docClient);
      const { posts, restMap } = await enrichAndFilterCandidates(docClient, raw);
      sorted = dedupeByRestaurant(sortCandidates(posts, restMap, sort));
      setFeedCache(cacheKey, sorted);
    }
    const slice = sorted.slice(offset, offset + limit);
    const processed = await processPostsForResponse(slice, identityId);
    const hasMore = offset + limit < sorted.length;
    return c.json({
      data: processed,
      meta: {
        scope: 'national',
        city: '',
        sort,
        fallbackLevel: 'national',
        nextCursor: hasMore ? encodeCursor({ level: 'national', offset: offset + limit }) : null,
      },
    });
  };

  // 直接全国
  if (scope === 'national') {
    const offset = cursor?.level === 'national' ? cursor.offset : 0;
    return serveNational(offset);
  }

  // ---- 同城 Feed ----
  // 入参 city 为「用户地级」串（方案 B）：新版=regeo 后标准 cityname，老版本=CLGeocoder 串。
  // 不再 normalizeCity（会把「延边朝鲜族自治州」错转成「延边市」）；宽松匹配在 queryCityCandidates 内做。
  const cityInput = rawCity.trim();
  if (!cityInput || cityInput === 'unknown') {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'scope=city 需要有效的 city 参数' } }, 400);
  }

  // 旧版全国游标续走全国；其余 level（含旧版时间窗层 7d/30d/90d/city-all）按 offset 在同城序列续页
  if (cursor?.level === 'national') {
    return serveNational(cursor.offset);
  }
  const offset = cursor?.offset ?? 0;

  // 同城全量候选纯 quality 排序（无时间窗），per-city 缓存兜住翻页重复拉库
  const cacheKey = `city-${cityInput}-${sort}`;
  let sorted = getFeedCache(cacheKey);
  if (!sorted) {
    const allCity = await queryCityCandidates(docClient, cityInput);
    const { posts: cityCandidates, restMap } = await enrichAndFilterCandidates(docClient, allCity);
    sorted = dedupeByRestaurant(sortCandidates(cityCandidates, restMap, sort));
    setFeedCache(cacheKey, sorted);
  }

  // 同城无任何可见帖 → 降级全国
  if (sorted.length === 0) {
    return serveNational(0);
  }

  const slice = sorted.slice(offset, offset + limit);
  const processed = await processPostsForResponse(slice, identityId);
  const hasMore = offset + limit < sorted.length;

  return c.json({
    data: processed,
    meta: {
      scope: 'city',
      city: cityInput,
      sort,
      // 层已废除；老 App 的 FeedMeta.fallbackLevel 为必填字段，保留恒值防 decode 失败
      fallbackLevel: 'city-all',
      nextCursor: hasMore ? encodeCursor({ level: 'city-all', offset: offset + limit }) : null,
    },
  });
});
