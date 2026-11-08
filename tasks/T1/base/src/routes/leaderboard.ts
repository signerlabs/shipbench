/**
 * 排行榜路由
 *
 * GET /influencers — 推荐者排行榜（scope=national 按 totalFollows 降序 /
 *                    scope=city 按 cityPostCount×10 + totalFollows 降序），
 *                    供 iOS 首页「本城推荐者 / 热门推荐者」区块消费。
 *
 * GET /restaurants（餐厅排行榜）已删除（2026-07-02）：iOS 排行榜页面下线后无任何调用方。
 * 响应中的 paidFollows 字段值实为 totalFollows（iOS Influencer 模型按非可选解码，字段名保留）。
 *
 * 实现方式：Query shared 表 + 应用层排序（当前实体 < 2000，无需 GSI）
 * 内存缓存 TTL 5 分钟
 */

import { Hono } from 'hono';
import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { identityMiddleware } from '../middleware/auth.js';
import { getDocClient, SHARED_TABLE, toStringArray } from '../lib/dynamodb.js';
import { cityLoopbackPass } from '../lib/amap-geocode.js';

export const leaderboardRoute = new Hono();

// 所有排行榜路由需要 Identity ID
leaderboardRoute.use('*', identityMiddleware);

// ============================================================
// 内存缓存（与 admin.ts 同模式）
// ============================================================

interface CacheEntry<T> {
  data: T;
  expireAt: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expireAt) {
    return entry.data as T;
  }
  cache.delete(key);
  return null;
}

function setCache<T>(key: string, data: T, ttl = CACHE_TTL): void {
  cache.set(key, { data, expireAt: Date.now() + ttl });
}

// ============================================================
// 返回类型
// ============================================================

// 返回完整的 Influencer 数据 + 排行榜扩展字段（rank 等）
// 前端可直接用 Influencer 模型解析，排行榜字段作为额外属性
type InfluencerRankItem = Record<string, unknown>;

// ============================================================
// GET /influencers — 博主排行榜
// ============================================================

leaderboardRoute.get('/influencers', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const scope = c.req.query('scope') || 'national';
  const rawCity = c.req.query('city') || '';

  // 城市维度必须带 city 参数
  if (scope === 'city' && !rawCity) {
    return c.json({ error: '本城推荐者排行需要 city 参数' }, 400);
  }
  // 入参 city 为「用户地级」串（方案 B）：新版=regeo 后 cityname，老版本=CLGeocoder 串。
  // 不再 normalizeCity（会错转自治州）；下方用 cityLoopbackPass 宽松匹配 cities/cityPostCounts。
  const cityInput = scope === 'city' ? rawCity.trim() : '';
  if (scope === 'city' && (!cityInput || cityInput === 'unknown')) {
    return c.json({ error: 'city 参数无效' }, 400);
  }

  const cacheKey = scope === 'city' ? `lb-inf-city-${cityInput}` : 'lb-inf';

  const cached = getCached<InfluencerRankItem[]>(cacheKey);
  if (cached) return c.json({ data: cached.slice(0, limit) });

  const docClient = getDocClient();
  // 推荐者都是导入的抖音博主（用户自建作者 10/22 已随自建内容彻底删除）
  const items = await queryAllByPK(docClient, 'INFLUENCER');

  /** 读取该推荐者在指定城市的推荐数（cityPostCounts Map，宽松匹配所有命中 cityInput 的 key 求和） */
  const cityCountOf = (item: Record<string, unknown>): number => {
    const cpc = item.cityPostCounts as Record<string, number> | undefined;
    if (!cpc) return 0;
    let sum = 0;
    for (const [k, v] of Object.entries(cpc)) {
      if (typeof v === 'number' && cityLoopbackPass(cityInput, k)) sum += v;
    }
    return sum;
  };

  if (scope === 'city') {
    // 同城：用 cities 集合过滤，按 cityPostCount×10 + totalFollows 降序
    const cityItems = items.filter((item) => toStringArray(item.cities).some((c) => cityLoopbackPass(cityInput, c)));
    cityItems.sort((a, b) => {
      const sb = cityCountOf(b) * 10 + ((b.totalFollows as number) || 0);
      const sa = cityCountOf(a) * 10 + ((a.totalFollows as number) || 0);
      return sb - sa;
    });

    const data: InfluencerRankItem[] = cityItems
      .filter((item) => cityCountOf(item) > 0)
      .map((item, i) => {
        // 剥离 SK + cityPostCounts + cities（Set 不可 JSON 序列化）+ 抖音签名（2026-10-28 不再下发）；influencerUid 就是抖音 uid
        const { SK: sk, cityPostCounts: _cpc, cities: _cities, influencerSignature: _sig, ...rest } = item;
        return {
          ...rest,
          influencerUid: sk,
          rank: i + 1,
          paidFollows: (item.totalFollows as number) || 0,
          cityRestaurantCount: cityCountOf(item),
          cityCount: toStringArray(item.cities).length,
        };
      });

    setCache(cacheKey, data);
    return c.json({ data: data.slice(0, limit) });
  }

  // 全国：按 totalFollows 降序（暂时使用全部用户数据，后续切回 paidFollows）
  items.sort((a, b) =>
    ((b.totalFollows as number) || 0) - ((a.totalFollows as number) || 0),
  );

  // 返回完整的 Influencer 数据 + 排行榜扩展字段（influencerUid 就是抖音 uid）
  const data: InfluencerRankItem[] = items
    .filter((item) => ((item.totalFollows as number) || 0) > 0)
    .map((item, i) => {
      // 剥离 SK + cityPostCounts + cities（Set 不可 JSON 序列化）+ 抖音签名（2026-10-28 不再下发）
      const { SK: sk, cityPostCounts: _cpc, cities: _cities, influencerSignature: _sig, ...rest } = item;
      return {
        ...rest,
        influencerUid: sk,
        rank: i + 1,
        paidFollows: (item.totalFollows as number) || 0,
        cityCount: toStringArray(item.cities).length,
      };
    });

  setCache(cacheKey, data);
  return c.json({ data: data.slice(0, limit) });
});

// ============================================================
// 辅助函数
// ============================================================

/**
 * 查询 shared 表某 PK 下所有条目
 */
async function queryAllByPK(
  docClient: ReturnType<typeof getDocClient>,
  pk: string,
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result: QueryCommandOutput = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    if (result.Items) {
      results.push(...result.Items);
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return results;
}

