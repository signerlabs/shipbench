/**
 * Admin 管理后台路由
 *
 * POST /login            — 管理员登录
 * GET  /stats            — Dashboard 统计
 * GET  /users            — 用户列表（分页）
 * GET  /users/:id        — 用户详情（含封禁状态）
 * POST   /users/:identityId/ban — 封禁用户（body { reason }）
 * DELETE /users/:identityId/ban — 解封用户
 * GET  /restaurants            — 官方餐厅列表（分页 + 搜索 + 筛选）
 * PUT  /restaurants/:id        — 修改餐厅信息
 * POST /restaurants/:id/review — admin 标记处理结果（resolved/unfindable）
 * GET  /restaurants/:id/detail — REST 详情 + 关联 POSTs（违规处理 Drawer）
 * GET  /posts/:id              — 单条 POST 详情（违规处理 Drawer）
 * GET  /influencers      — 官方博主列表（分页）
 * GET  /influencers/:uid — 博主详情（含关联小店和视频）
 * GET  /videos           — 视频列表（分页 + 搜索）
 * GET  /monitor/stream   — SSE 实时监控流（定位失败事件推送）
 * GET  /monitor/location-issues — 历史定位问题查询（分页）
 * GET  /issues           — 用户反馈问题列表（分页 + 状态筛选）
 *
 * Created by guiping on 2026/03/24
 */

import { Hono } from 'hono';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  verifyAdminCredentials,
  signAdminToken,
  verifyAdminToken,
  adminAuthMiddleware,
} from '../middleware/adminAuth.js';
import { getDocClient, USERS_TABLE, VIDEOS_TABLE, SHARED_TABLE, toStringArray } from '../lib/dynamodb.js';
import { streamSSE } from 'hono/streaming';
import { eventBus, type LocationEvent, type IssueEvent } from '../lib/event-bus.js';
import { banIdentity, unbanIdentity } from '../lib/user-ban.js';
import { isIdentityId } from '../lib/author-id.js';
import { getAppSecrets } from '../lib/secrets.js';
import { savePlaceExtrasSafe } from '../lib/place-extras.js';

export const adminRoute = new Hono();

// toStringArray 从 '../lib/dynamodb.js' 导入

// ============================================================
// 内存缓存（简单方案，5 分钟过期）
// ============================================================

interface CacheEntry<T> {
  data: T;
  expireAt: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟（毫秒）
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
// POST /login — 管理员登录（不需要 JWT 认证）
// ============================================================

adminRoute.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: '用户名和密码为必填' },
    }, 400);
  }

  if (!await verifyAdminCredentials(body.username, body.password)) {
    return c.json({
      error: { code: 'UNAUTHORIZED', message: '用户名或密码错误' },
    }, 401);
  }

  const result = await signAdminToken(body.username);

  return c.json({
    data: {
      token: result.token,
      expiresIn: result.expiresIn,
    },
  });
});

// ============================================================
// SSE 短期 token 管理（避免长期 JWT 暴露在 URL 中）
// ============================================================

const sseTokenStore = new Map<string, number>(); // token → 过期时间戳
const SSE_TOKEN_TTL = 30_000; // 30 秒有效

/** 定期清理过期 SSE token */
setInterval(() => {
  const now = Date.now();
  for (const [token, expires] of sseTokenStore) {
    if (now > expires) sseTokenStore.delete(token);
  }
}, 60_000);

// POST /monitor/token — 用 JWT 换取 30 秒有效的一次性 SSE token（在 middleware 之前，自行验证 JWT）
adminRoute.post('/monitor/token', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authorization header required' } }, 401);
  }
  try {
    await verifyAdminToken(authHeader.slice(7));
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'token 无效或已过期' } }, 401);
  }

  const sseToken = crypto.randomUUID();
  sseTokenStore.set(sseToken, Date.now() + SSE_TOKEN_TTL);
  return c.json({ data: { token: sseToken, expiresIn: SSE_TOKEN_TTL / 1000 } });
});

// ============================================================
// GET /monitor/stream — SSE 实时监控流（使用短期 token 认证）
// ============================================================

adminRoute.get('/monitor/stream', async (c) => {
  // 验证短期 SSE token
  const token = c.req.query('token');
  if (!token) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'token 参数缺失' } }, 401);
  }
  const expires = sseTokenStore.get(token);
  if (!expires || Date.now() > expires) {
    sseTokenStore.delete(token);
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'token 无效或已过期' } }, 401);
  }
  // 一次性使用，验证后立即删除
  sseTokenStore.delete(token);

  return streamSSE(c, async (stream) => {
    // 发送初始连接确认
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ message: '监控连接已建立', timestamp: new Date().toISOString() }),
    });

    // 注册 location-result 事件监听（成功和失败统一推送）
    const onLocationResult = async (payload: LocationEvent) => {
      try {
        await stream.writeSSE({
          event: 'location-result',
          data: JSON.stringify(payload),
        });
      } catch {
        // 客户端已断开，忽略写入错误
      }
    };

    eventBus.addListener('location-result', onLocationResult);

    // 注册 issue-submitted 事件监听（用户反馈）
    const onIssueSubmitted = async (payload: IssueEvent) => {
      try {
        await stream.writeSSE({
          event: 'issue-submitted',
          data: JSON.stringify(payload),
        });
      } catch {
        // 客户端已断开，忽略写入错误
      }
    };

    eventBus.addListener('issue-submitted', onIssueSubmitted);

    // 定时发送心跳，保持连接活跃
    const heartbeat = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ timestamp: new Date().toISOString() }),
        });
      } catch {
        // 客户端已断开，忽略写入错误
      }
    }, 30_000);

    // 客户端断开时清理资源
    stream.onAbort(() => {
      eventBus.removeListener('location-result', onLocationResult);
      eventBus.removeListener('issue-submitted', onIssueSubmitted);
      clearInterval(heartbeat);
      console.log('[monitor] SSE 客户端已断开');
    });

    // 保持流打开，等待 abort 信号
    await new Promise(() => {});
  });
});

// ============================================================
// 以下路由需要 Admin JWT 认证
// ============================================================

adminRoute.use('/*', adminAuthMiddleware);

// ============================================================
// POST /refresh — 刷新 JWT（用当前有效 token 换取新 token）
// ============================================================

adminRoute.post('/refresh', async (c) => {
  // 从 middleware 解析的 JWT payload 中获取用户名
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.slice(7) || '';
  const payload = await verifyAdminToken(token);
  const result = await signAdminToken(payload.sub);
  return c.json({ data: { token: result.token, expiresIn: result.expiresIn } });
});

// ============================================================
// GET /stats — Dashboard 统计
// ============================================================

interface UserGrowthItem {
  date: string;         // "YYYY-MM-DD" 格式（按天）
  profileCount: number; // 累积登录用户数
  subCount: number;     // 累积订阅用户数
}

interface CityDistributionItem {
  city: string;
  count: number;
}

// GET /stats/cards — 顶部统计卡片（计数类，较快）
adminRoute.get('/stats/cards', async (c) => {
  const cached = getCached<Record<string, unknown>>('stats-cards');
  if (cached) return c.json({ data: cached });

  const docClient = getDocClient();

  const [
    usersResult,
    videoStatusCounts,
    systemRestaurants,
    systemInfluencers,
    locationResult,
  ] = await Promise.all([
    scanDistinctPKsWithGrowth(docClient),
    queryVideoStatusCounts(docClient),
    querySharedCount(docClient, 'REST'),
    querySharedCount(docClient, 'INFLUENCER'),
    countLocationAndCityStats(docClient),
  ]);

  const data = {
    totalUsers: usersResult.profileCount,
    subscribedUsers: usersResult.subscribedUsers,
    totalVideos: videoStatusCounts.total,
    videoCompleted: videoStatusCounts.completed,
    videoRejected: videoStatusCounts.rejected,
    videoFailed: videoStatusCounts.failed,
    videoProcessing: videoStatusCounts.processing,
    totalRestaurants: systemRestaurants,
    totalInfluencers: systemInfluencers,
    locatedCount: locationResult.locatedCount,
    locationFailedCount: locationResult.locationFailedCount,
    pendingLocationCount: locationResult.pendingLocationCount,
  };

  setCache('stats-cards', data);
  return c.json({ data });
});

// GET /stats/user-growth — 用户增长趋势
adminRoute.get('/stats/user-growth', async (c) => {
  const cached = getCached<UserGrowthItem[]>('stats-user-growth');
  if (cached) return c.json({ data: cached });

  const docClient = getDocClient();
  const result = await scanDistinctPKsWithGrowth(docClient);

  setCache('stats-user-growth', result.userGrowth);
  return c.json({ data: result.userGrowth });
});

// GET /stats/city-distribution — 小店城市分布
adminRoute.get('/stats/city-distribution', async (c) => {
  const cached = getCached<CityDistributionItem[]>('stats-city-dist');
  if (cached) return c.json({ data: cached });

  const docClient = getDocClient();
  const result = await countLocationAndCityStats(docClient);

  setCache('stats-city-dist', result.cityDistribution);
  return c.json({ data: result.cityDistribution });
});

// GET /stats/influencer-city-distribution — 博主活跃城市
adminRoute.get('/stats/influencer-city-distribution', async (c) => {
  const cached = getCached<CityDistributionItem[]>('stats-inf-city-dist');
  if (cached) return c.json({ data: cached });

  const docClient = getDocClient();
  const data = await countInfluencerCityDistribution(docClient);

  setCache('stats-inf-city-dist', data);
  return c.json({ data });
});

// GET /stats/top-influencers — 被关注最多的博主（从 shared 表计数器读取，替代全表 Scan）
adminRoute.get('/stats/top-influencers', async (c) => {
  const cached = getCached<{ name: string; count: number }[]>('stats-top-inf');
  if (cached) return c.json({ data: cached });

  const docClient = getDocClient();

  // 从 shared 表 Query PK="INFLUENCER"，读取预聚合的 totalFollows
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'INFLUENCER' },
      ProjectionExpression: 'SK, influencerName, totalFollows',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (result.Items) items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 按 totalFollows 降序排序，取 top 10
  items.sort((a, b) => ((b.totalFollows as number) || 0) - ((a.totalFollows as number) || 0));
  const data = items.slice(0, 10).map((item) => ({
    name: (item.influencerName as string) || (item.SK as string),
    count: (item.totalFollows as number) || 0,
  }));

  setCache('stats-top-inf', data);
  return c.json({ data });
});

// GET /stats/top-restaurants — 被收藏最多的餐厅（从 shared 表计数器读取）
adminRoute.get('/stats/top-restaurants', async (c) => {
  const cached = getCached<{ name: string; city: string; count: number }[]>('stats-top-rest');
  if (cached) return c.json({ data: cached });

  const docClient = getDocClient();

  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'REST' },
      ProjectionExpression: 'SK, restaurantName, city, totalBookmarks',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (result.Items) items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  items.sort((a, b) => ((b.totalBookmarks as number) || 0) - ((a.totalBookmarks as number) || 0));
  const data = items.slice(0, 10).map((item) => ({
    name: (item.restaurantName as string) || (item.SK as string),
    city: (item.city as string) || '',
    count: (item.totalBookmarks as number) || 0,
  }));

  setCache('stats-top-rest', data);
  return c.json({ data });
});

/**
 * 扫描 users 表统计不同 PK 数量（排除 system-batch），同时提取 createdAt 用于用户增长曲线
 * 每个 PK 只取第一条遇到的 createdAt 作为该用户的注册时间
 */
async function scanDistinctPKsWithGrowth(
  docClient: ReturnType<typeof getDocClient>,
): Promise<{ totalUsers: number; profileCount: number; subscribedUsers: number; userGrowth: UserGrowthItem[] }> {
  // 通过 entity-type-index GSI（SK→PK 反转）精确查询 PROFILE 和 SUBSCRIPTION
  const profileDayMap = new Map<string, number>();
  const subDayMap = new Map<string, number>();
  const pkSet = new Set<string>();

  // 查询所有 PROFILE 记录
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'entity-type-index',
      KeyConditionExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'PROFILE' },
      ProjectionExpression: 'PK, createdAt',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of result.Items || []) {
      const pk = item['PK'] as string;
      if (!pk || pk === 'system-batch') continue;
      pkSet.add(pk);
      const day = ((item['createdAt'] as string) || '').substring(0, 10);
      if (day.length === 10) profileDayMap.set(day, (profileDayMap.get(day) || 0) + 1);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  const profileCount = profileDayMap.size > 0
    ? Array.from(profileDayMap.values()).reduce((a, b) => a + b, 0)
    : 0;

  // 查询所有 SUBSCRIPTION 记录（只统计 status=active 的为有效订阅）
  let subLastKey: Record<string, unknown> | undefined;
  let activeSubscribedUsers = 0;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'entity-type-index',
      KeyConditionExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'SUBSCRIPTION' },
      ProjectionExpression: 'PK, createdAt, #status',
      ExpressionAttributeNames: { '#status': 'status' },
      ...(subLastKey && { ExclusiveStartKey: subLastKey }),
    }));
    for (const item of result.Items || []) {
      const pk = item['PK'] as string;
      if (!pk || pk === 'system-batch') continue;
      pkSet.add(pk);
      const day = ((item['createdAt'] as string) || '').substring(0, 10);
      if (day.length === 10) subDayMap.set(day, (subDayMap.get(day) || 0) + 1);
      // 只有 status=active 才计入有效订阅数
      if (item['status'] === 'active') {
        activeSubscribedUsers++;
      }
    }
    subLastKey = result.LastEvaluatedKey;
  } while (subLastKey);

  const subscribedUsers = activeSubscribedUsers;

  // 从上线日（2026-03-15）开始，逐日填充到今天
  const APP_LAUNCH_DATE = '2026-03-15';
  const today = new Date().toISOString().substring(0, 10);
  const userGrowth: UserGrowthItem[] = [];
  let cumProfile = 0;
  let cumSub = 0;
  const d = new Date(APP_LAUNCH_DATE);
  while (d.toISOString().substring(0, 10) <= today) {
    const date = d.toISOString().substring(0, 10);
    cumProfile += profileDayMap.get(date) || 0;
    cumSub += subDayMap.get(date) || 0;
    userGrowth.push({ date, profileCount: cumProfile, subCount: cumSub });
    d.setDate(d.getDate() + 1);
  }

  return { totalUsers: pkSet.size, profileCount, subscribedUsers, userGrowth };
}

/**
 * 扫描 videos 表按状态分组统计
 */
async function queryVideoStatusCounts(
  docClient: ReturnType<typeof getDocClient>,
): Promise<{ total: number; completed: number; rejected: number; failed: number; processing: number }> {
  // 通过 status-index GSI 按状态并行 Count，避免全表 Scan
  const queryCount = async (status: string): Promise<number> => {
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: VIDEOS_TABLE,
        IndexName: 'status-index',
        KeyConditionExpression: '#s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': status },
        Select: 'COUNT',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      count += result.Count || 0;
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return count;
  };

  const [completed, rejected, failed, processing] = await Promise.all([
    queryCount('completed'),
    queryCount('rejected'),
    queryCount('failed'),
    queryCount('processing'),
  ]);

  return {
    total: completed + rejected + failed + processing,
    completed, rejected, failed, processing,
  };
}

/**
 * 查询 SHARED_TABLE 指定 PK 分区的实体数量
 * @param pk 分区键，如 'REST'、'INFLUENCER'
 */
async function querySharedCount(
  docClient: ReturnType<typeof getDocClient>,
  pk: string,
): Promise<number> {
  let count = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': pk,
      },
      Select: 'COUNT',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    count += result.Count || 0;
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

/**
 * 统计 SHARED_TABLE REST 分区的位置状态和城市分布
 * 合并为一次查询，避免重复请求
 */
async function countLocationAndCityStats(docClient: ReturnType<typeof getDocClient>): Promise<{
  locatedCount: number;
  locationFailedCount: number;
  pendingLocationCount: number;
  cityDistribution: CityDistributionItem[];
}> {
  let locatedCount = 0;
  let locationFailedCount = 0;
  let pendingLocationCount = 0;
  const cityCountMap = new Map<string, number>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'REST',
      },
      ProjectionExpression: 'needsManualReview, latitude, city',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    for (const item of result.Items || []) {
      const hasCoord = item['latitude'] !== undefined && item['latitude'] !== null;
      // 2026-05-16 四标志位统一：locationFailedCount 字段名保留（admin 前端契约不变），
      // 但语义变为"需人工补全且缺坐标的店数"。
      // - 有坐标               → 已定位
      // - 无坐标 + 需人工复审  → 计入 locationFailedCount（对应 worklist）
      // - 无坐标 + 无标志位    → 待定位（流水线已写但 iOS 尚未回传坐标）
      const needsReview = item['needsManualReview'] === true;

      if (hasCoord) locatedCount++;
      else if (needsReview) locationFailedCount++;
      else pendingLocationCount++;

      // 城市分布统计（排除 unknown 和空城市）
      const city = (item['city'] as string) || '';
      if (city && city !== 'unknown') {
        cityCountMap.set(city, (cityCountMap.get(city) || 0) + 1);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 按 count 降序排列，取 top 15
  const cityDistribution = Array.from(cityCountMap.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return { locatedCount, locationFailedCount, pendingLocationCount, cityDistribution };
}

/**
 * 统计 SHARED_TABLE POST 分区中每个城市的不同博主数
 * 按 city + influencerUid 去重后，统计每个城市有多少不同的博主
 */
async function countInfluencerCityDistribution(
  docClient: ReturnType<typeof getDocClient>,
): Promise<CityDistributionItem[]> {
  // city -> Set<influencerUid>，用于去重
  const cityInfluencerMap = new Map<string, Set<string>>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'POST',
      },
      ProjectionExpression: 'city, influencerUid',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    for (const item of result.Items || []) {
      const city = item['city'] as string | undefined;
      const influencerUid = item['influencerUid'] as string | undefined;
      if (!city || !influencerUid) continue;

      if (!cityInfluencerMap.has(city)) {
        cityInfluencerMap.set(city, new Set());
      }
      cityInfluencerMap.get(city)!.add(influencerUid);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 按不同博主数降序排列，取 top 15
  return Array.from(cityInfluencerMap.entries())
    .map(([city, uidSet]) => ({ city, count: uidSet.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
}

/**
 * 查询 Cognito Identity Pool 的身份总数 + 按天注册增长曲线
 * 限流失败时返回上次成功的结果，避免 Dashboard 显示 0
 */
// ============================================================
// GET /users — 用户列表（分页）
// ============================================================

/** 用户聚合数据类型 */
interface UserAggregated {
  identityId: string;
  email: string | null;
  displayName: string | null;
  provider: string | null;
  subscriptionStatus: string | null;
  subscriptionProductId: string | null;
  createdAt: string | null;
  restaurantCount: number;
  postCount: number;
  influencerCount: number;
  issueCount: number;
}

/**
 * 快速查询注册用户：只扫描 PROFILE/SUBSCRIPTION 记录，再按 PK 查每个用户的统计
 */
async function queryRegisteredUsers(docClient: ReturnType<typeof getDocClient>): Promise<UserAggregated[]> {
  // Step 1: 扫描 PROFILE 和 SUBSCRIPTION 记录（数量少，~50 条）
  const userMap = new Map<string, {
    email: string | null; displayName: string | null; provider: string | null;
    subscriptionStatus: string | null; subscriptionProductId: string | null;
    createdAt: string | null;
  }>();

  // 通过 entity-type-index GSI 分别查询 PROFILE 和 SUBSCRIPTION，避免全表 Scan
  // 查 PROFILE
  let profileLastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'entity-type-index',
      KeyConditionExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'PROFILE' },
      ProjectionExpression: 'PK, email, displayName, provider, createdAt',
      ...(profileLastKey && { ExclusiveStartKey: profileLastKey }),
    }));
    for (const item of result.Items || []) {
      const pk = item['PK'] as string;
      if (!pk || pk === 'system-batch') continue;
      if (!userMap.has(pk)) {
        userMap.set(pk, { email: null, displayName: null, provider: null, subscriptionStatus: null, subscriptionProductId: null, createdAt: null });
      }
      const u = userMap.get(pk)!;
      u.email = (item['email'] as string) || null;
      u.displayName = (item['displayName'] as string) || null;
      u.provider = (item['provider'] as string) || null;
      u.createdAt = (item['createdAt'] as string) || null;
    }
    profileLastKey = result.LastEvaluatedKey;
  } while (profileLastKey);

  // 查 SUBSCRIPTION
  let subLastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'entity-type-index',
      KeyConditionExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': 'SUBSCRIPTION' },
      ProjectionExpression: 'PK, #s, productId',
      ExpressionAttributeNames: { '#s': 'status' },
      ...(subLastKey && { ExclusiveStartKey: subLastKey }),
    }));
    for (const item of result.Items || []) {
      const pk = item['PK'] as string;
      if (!pk || pk === 'system-batch') continue;
      if (!userMap.has(pk)) {
        userMap.set(pk, { email: null, displayName: null, provider: null, subscriptionStatus: null, subscriptionProductId: null, createdAt: null });
      }
      const u = userMap.get(pk)!;
      u.subscriptionStatus = (item['status'] as string) || null;
      u.subscriptionProductId = (item['productId'] as string) || null;
    }
    subLastKey = result.LastEvaluatedKey;
  } while (subLastKey);

  // 注册用户列表只返回基本信息，统计数据在详情页按需加载
  return Array.from(userMap.entries()).map(([identityId, u]) => ({
    identityId, ...u,
    restaurantCount: 0, postCount: 0, influencerCount: 0, issueCount: 0,
  })) as UserAggregated[];
}

/**
 * 全量扫描所有用户（含匿名用户），较慢
 */
async function queryAllUsers(docClient: ReturnType<typeof getDocClient>): Promise<UserAggregated[]> {
  const userMap = new Map<string, {
    email: string | null; displayName: string | null; provider: string | null;
    subscriptionStatus: string | null; subscriptionProductId: string | null;
    restaurantCount: number; postCount: number; influencerCount: number; issueCount: number;
    restaurantIds: string[];
  }>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: USERS_TABLE,
      ProjectionExpression: 'PK, SK, restaurantId, email, displayName, provider, productId, #s',
      ExpressionAttributeNames: { '#s': 'status' },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of result.Items || []) {
      const pk = item['PK'] as string;
      const sk = item['SK'] as string;
      if (!pk || pk === 'system-batch') continue;
      if (!userMap.has(pk)) {
        userMap.set(pk, {
          email: null, displayName: null, provider: null,
          subscriptionStatus: null, subscriptionProductId: null,
          restaurantCount: 0, postCount: 0, influencerCount: 0, issueCount: 0, restaurantIds: [],
        });
      }
      const stats = userMap.get(pk)!;
      if (sk === 'PROFILE') {
        stats.email = (item['email'] as string) || null;
        stats.displayName = (item['displayName'] as string) || null;
        stats.provider = (item['provider'] as string) || null;
      } else if (sk === 'SUBSCRIPTION') {
        stats.subscriptionStatus = (item['status'] as string) || null;
        stats.subscriptionProductId = (item['productId'] as string) || null;
      } else if (sk?.startsWith('REST#')) {
        stats.restaurantCount++;
        const rid = item['restaurantId'] as string;
        if (rid) stats.restaurantIds.push(rid);
      } else if (sk?.startsWith('INFLUENCER#')) {
        stats.influencerCount++;
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // BatchGet REST 数据
  const allRestIds = new Set<string>();
  for (const [, stats] of userMap) { for (const rid of stats.restaurantIds) allRestIds.add(rid); }
  const restDataMap = new Map<string, Record<string, unknown>>();
  if (allRestIds.size > 0) {
    const restIdArray = Array.from(allRestIds);
    for (let i = 0; i < restIdArray.length; i += 100) {
      const batch = restIdArray.slice(i, i + 100);
      const batchResult = await docClient.send(new BatchGetCommand({
        RequestItems: { [SHARED_TABLE]: { Keys: batch.map((rid) => ({ PK: 'REST', SK: rid })), ProjectionExpression: 'SK, restaurantName, address, latitude, longitude, postRefs' } },
      }));
      for (const item of batchResult.Responses?.[SHARED_TABLE] || []) {
        const sk = item['SK'] as string;
        if (sk) restDataMap.set(sk, item);
      }
    }
  }

  // 计算 postCount 和 issueCount
  for (const [, stats] of userMap) {
    const postRefSet = new Set<string>();
    for (const rid of stats.restaurantIds) {
      const restData = restDataMap.get(rid);
      if (!restData) continue;
      if (!restData['restaurantName'] || !restData['address'] || !restData['latitude'] || !restData['longitude']) stats.issueCount++;
      for (const ref of toStringArray(restData['postRefs'])) postRefSet.add(ref);
    }
    stats.postCount = postRefSet.size;
  }

  return Array.from(userMap.entries()).map(([identityId, stats]) => ({
    identityId, email: stats.email, displayName: stats.displayName, provider: stats.provider,
    subscriptionStatus: stats.subscriptionStatus, subscriptionProductId: stats.subscriptionProductId,
    createdAt: null,
    restaurantCount: stats.restaurantCount, postCount: stats.postCount,
    influencerCount: stats.influencerCount, issueCount: stats.issueCount,
  }));
}

adminRoute.get('/users', async (c) => {
  const docClient = getDocClient();
  const pageNum = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));
  const identityIdFilter = c.req.query('identityId');
  const emailFilter = c.req.query('email');
  const subStatusFilter = c.req.query('subscriptionStatus');
  const subProductFilter = c.req.query('subscriptionProductId');
  const influencerUidFilter = c.req.query('influencerUid');
  const influencerNameFilter = c.req.query('influencerName');
  const scope = c.req.query('scope') || 'registered'; // registered（默认，快速） | all（全量扫描）

  // 根据 scope 选择查询方式，分别缓存
  const cacheKey = scope === 'all' ? 'users-all' : 'users-registered';
  let aggregated = getCached<UserAggregated[]>(cacheKey);

  if (!aggregated) {
    aggregated = scope === 'all'
      ? await queryAllUsers(docClient)
      : await queryRegisteredUsers(docClient);

    // 按注册时间倒序排列（最新注册的在前）
    aggregated.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    setCache(cacheKey, aggregated);
  }

  // 筛选
  let filtered = aggregated;
  if (identityIdFilter) {
    const keyword = identityIdFilter.toLowerCase();
    filtered = filtered.filter((u) => u.identityId.toLowerCase().includes(keyword));
  }
  if (emailFilter) {
    const keyword = emailFilter.toLowerCase();
    filtered = filtered.filter((u) => u.email?.toLowerCase().includes(keyword));
  }
  if (subStatusFilter) {
    if (subStatusFilter === 'none') {
      filtered = filtered.filter((u) => !u.subscriptionStatus);
    } else {
      filtered = filtered.filter((u) => u.subscriptionStatus === subStatusFilter);
    }
  }
  if (subProductFilter) {
    const keyword = subProductFilter.toLowerCase();
    filtered = filtered.filter((u) => u.subscriptionProductId?.toLowerCase().includes(keyword));
  }

  // 按博主筛选：支持 UID 精确匹配或名称模糊搜索
  if (influencerUidFilter) {
    const followerPKs = await findFollowerPKs(docClient, influencerUidFilter);
    filtered = aggregated.filter((u) => followerPKs.has(u.identityId));
  } else if (influencerNameFilter) {
    const matchedUids = await findInfluencerUidsByName(docClient, influencerNameFilter);
    if (matchedUids.size > 0) {
      const allFollowerPKs = new Set<string>();
      for (const uid of matchedUids) {
        const pks = await findFollowerPKs(docClient, uid);
        for (const pk of pks) allFollowerPKs.add(pk);
      }
      filtered = aggregated.filter((u) => allFollowerPKs.has(u.identityId));
    } else {
      filtered = [];
    }
  }

  // 基于 page/pageSize 分页
  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const startIndex = (pageNum - 1) * pageSize;
  const pageData = filtered.slice(startIndex, startIndex + pageSize);

  return c.json({
    data: pageData,
    total,
    page: pageNum,
    pageSize,
    totalPages,
  });
});

// ============================================================
// GET /users/:id — 用户详情
// ============================================================

adminRoute.get('/users/:id', async (c) => {
  const identityId = c.req.param('id');
  const docClient = getDocClient();

  // Step 1: 查询该用户在 USERS_TABLE 下的所有实体（薄引用：REST#、INFLUENCER#、JOB#）
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': identityId,
      },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    if (result.Items) {
      allItems.push(...result.Items);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  if (allItems.length === 0) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '用户不存在' },
    }, 404);
  }

  // 按类型分组（users 表现在只有 REST#、INFLUENCER#、JOB# 薄引用）
  const userRestRefs: Record<string, unknown>[] = [];
  const userInfluencerRefs: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];
  const others: Record<string, unknown>[] = [];
  // 封禁记录（SK=BAN）随同一次 Query 读出，不额外查
  let banItem: Record<string, unknown> | undefined;

  for (const item of allItems) {
    const sk = item['SK'] as string;
    if (sk?.startsWith('REST#')) userRestRefs.push(item);
    else if (sk?.startsWith('INFLUENCER#')) userInfluencerRefs.push(item);
    else if (sk?.startsWith('JOB#')) jobs.push(item);
    else if (sk === 'BAN') banItem = item;
    else others.push(item);
  }

  // Step 2: 从 SHARED_TABLE 批量获取 REST 完整数据
  const restaurantIds = userRestRefs
    .map((r) => r['restaurantId'] as string)
    .filter(Boolean);

  const restaurants: Record<string, unknown>[] = [];
  if (restaurantIds.length > 0) {
    const restDataMap = await batchGetFromShared(docClient, 'REST', restaurantIds);
    // 合并用户的 bookmarked 状态到 SHARED_TABLE 的完整数据
    for (const ref of userRestRefs) {
      const rid = ref['restaurantId'] as string;
      const sharedData = restDataMap.get(rid);
      if (sharedData) {
        restaurants.push({
          ...sharedData,
          bookmarked: ref['bookmarked'],
          // 保留 PK/SK 指向用户的薄引用（前端可能用到）
          PK: identityId,
          SK: `REST#${rid}`,
        });
      } else {
        // SHARED_TABLE 中未找到，返回薄引用数据
        restaurants.push(ref);
      }
    }
  }

  // Step 3: 从所有 REST 的 postRefs 收集帖子 ID，批量获取 POST 完整数据
  const postRefSet = new Set<string>();
  for (const rest of restaurants) {
    for (const ref of toStringArray(rest['postRefs'])) postRefSet.add(ref);
  }

  const posts: Record<string, unknown>[] = [];
  if (postRefSet.size > 0) {
    const postDataMap = await batchGetFromShared(docClient, 'POST', Array.from(postRefSet));
    // 按 createdAt 降序排列
    posts.push(...Array.from(postDataMap.values()));
    posts.sort((a, b) => {
      const aTime = (a['createdAt'] as string) || '';
      const bTime = (b['createdAt'] as string) || '';
      return bTime.localeCompare(aTime);
    });
  }

  // Step 4: 从 SHARED_TABLE 批量获取 INFLUENCER 完整数据
  const influencerUids = userInfluencerRefs
    .map((inf) => inf['influencerUid'] as string)
    .filter(Boolean);

  const influencers: Record<string, unknown>[] = [];
  if (influencerUids.length > 0) {
    const infDataMap = await batchGetFromShared(docClient, 'INFLUENCER', influencerUids);
    for (const ref of userInfluencerRefs) {
      const uid = ref['influencerUid'] as string;
      const sharedData = infDataMap.get(uid);
      if (sharedData) {
        influencers.push({
          ...sharedData,
          bookmarked: ref['bookmarked'],
          PK: identityId,
          SK: `INFLUENCER#${uid}`,
        });
      } else {
        influencers.push(ref);
      }
    }
  }

  // Step 5: 从 posts 数据中提取 influencerUid + restaurantId，精确 BatchGet RI 记录
  // RI 的 SK 格式是 {influencerUid}#{restaurantId}，从 posts 可以拿到这两个值
  const riSkSet = new Set<string>();
  for (const post of posts) {
    const uid = post['influencerUid'] as string;
    const rid = post['restaurantId'] as string;
    if (uid && rid) riSkSet.add(`${uid}#${rid}`);
  }

  const restaurantInfluencers: Record<string, unknown>[] = [];
  if (riSkSet.size > 0) {
    const riDataMap = await batchGetFromShared(docClient, 'RI', Array.from(riSkSet));
    restaurantInfluencers.push(...riDataMap.values());
  }

  return c.json({
    data: {
      identityId,
      // 封禁状态（2026-10-19）：banned 布尔 + 封禁记录（未封禁为 null）
      banned: !!banItem,
      ban: banItem
        ? {
          reason: (banItem['reason'] as string) ?? '',
          createdAt: (banItem['createdAt'] as string) ?? '',
          createdBy: (banItem['createdBy'] as string) ?? 'admin',
        }
        : null,
      summary: {
        restaurantCount: restaurants.length,
        postCount: posts.length,
        influencerCount: influencers.length,
        riCount: restaurantInfluencers.length,
        jobCount: jobs.length,
      },
      restaurants,
      posts,
      influencers,
      restaurantInfluencers,
      jobs,
      others,
    },
  });
});

// ============================================================
// POST /users/:identityId/ban — 封禁用户 · DELETE — 解封（2026-10-19）
// ------------------------------------------------------------
// 记录 = users 表 PK=<identityId>, SK="BAN"，{ reason, createdAt, createdBy: "admin" }。
// 被封禁身份的写接口与 /v1/parse 返回 403 USER_BANNED（读接口不拦；注销账号与订阅记账不拦）。
// 生效延迟：处理本请求的实例立即生效，其它实例最迟 60 秒（封禁查询的内存缓存 TTL）。
// ============================================================

/** 封禁原因长度上限 */
const BAN_REASON_MAX_LENGTH = 500;

adminRoute.post('/users/:identityId/ban', async (c) => {
  const identityId = c.req.param('identityId');
  if (!isIdentityId(identityId)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'identityId 格式不正确（应为 <region>:<uuid>）' },
    }, 400);
  }

  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'reason 为必填字符串' } }, 400);
  }
  if (reason.length > BAN_REASON_MAX_LENGTH) {
    return c.json({ error: { code: 'INVALID_INPUT', message: `reason 不能超过 ${BAN_REASON_MAX_LENGTH} 字` } }, 400);
  }

  const ban = await banIdentity(identityId, reason, 'admin');
  console.log(`[Admin] 封禁用户 | identityId=${identityId.slice(-12)} | reason 长度=${reason.length}`);

  return c.json({ data: { identityId, banned: true, ban } });
});

adminRoute.delete('/users/:identityId/ban', async (c) => {
  const identityId = c.req.param('identityId');
  if (!isIdentityId(identityId)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'identityId 格式不正确（应为 <region>:<uuid>）' },
    }, 400);
  }

  await unbanIdentity(identityId);
  console.log(`[Admin] 解封用户 | identityId=${identityId.slice(-12)}`);

  return c.json({ data: { identityId, banned: false } });
});

// ============================================================
// GET /restaurants — 官方餐厅列表（分页 + 搜索 + 筛选）
// ============================================================

adminRoute.get('/restaurants', async (c) => {
  const docClient = getDocClient();
  const pageNum = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));
  const search = c.req.query('search');
  const cityFilter = c.req.query('city');
  const locationStatus = c.req.query('locationStatus'); // located | failed | pending
  // 2026-05-15 backfill 配合：过滤出 C-2 类待人工补全的小店（后端 backfill 脚本写入 needsManualReview=true）
  const needsManualReview = c.req.query('needsManualReview') === 'true';

  // Step 1: 查询 REST 数据（有 city 筛选时走 city-index GSI，否则全量查 REST 分区 + 缓存）
  let allItems: Record<string, unknown>[];

  if (cityFilter) {
    // 按城市精确查询，走 city-index GSI
    allItems = [];
    let lk: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: SHARED_TABLE,
        IndexName: 'city-index',
        KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: { ':gsi1pk': `CITY#${cityFilter}`, ':prefix': 'REST#' },
        ...(lk && { ExclusiveStartKey: lk }),
      }));
      if (result.Items) allItems.push(...result.Items);
      lk = result.LastEvaluatedKey;
    } while (lk);
  } else {
    // 无城市筛选，全量查 REST 分区 + 缓存
    const restCacheKey = 'restaurants-all';
    const cached = getCached<Record<string, unknown>[]>(restCacheKey);
    if (cached) {
      allItems = cached;
    } else {
      allItems = [];
      let lk: Record<string, unknown> | undefined;
      do {
        const result = await docClient.send(new QueryCommand({
          TableName: SHARED_TABLE,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': 'REST' },
          ...(lk && { ExclusiveStartKey: lk }),
        }));
        if (result.Items) allItems.push(...result.Items);
        lk = result.LastEvaluatedKey;
      } while (lk);
      setCache(restCacheKey, allItems);
    }
  }

  // Step 2: 内存过滤（搜索、位置状态）
  let filtered = allItems;

  if (search) {
    const searchLower = search.toLowerCase();
    filtered = filtered.filter((item) => {
      const name = (item['restaurantName'] as string || '').toLowerCase();
      return name.includes(searchLower);
    });
  }

  // 2026-05-16 四标志位统一为 needsManualReview，locationStatus 过滤同步收敛：
  // - failed   → 需人工复审且缺坐标（与 needsManualReview worklist 同源）
  // - located  → 有坐标
  // - pending  → 缺坐标且未被流水线标 needsManualReview（iOS 尚未回传）
  if (locationStatus === 'failed') {
    filtered = filtered.filter((item) => item['needsManualReview'] === true && !item['latitude']);
  } else if (locationStatus === 'located') {
    filtered = filtered.filter((item) => item['latitude'] && item['longitude']);
  } else if (locationStatus === 'pending') {
    filtered = filtered.filter((item) => !item['latitude']);
  }

  // 2026-05-15 backfill 配合：worklist 视图过滤出 needsManualReview=true 的小店
  // 注意：true 严格匹配，避免 undefined / false / 0 / "" 等误命中
  // 2026-05-16 软关店标记：worklist 同步 filter 掉 permanentlyClosed=true（admin 不再展示死店）
  if (needsManualReview) {
    filtered = filtered.filter(
      (item) => item['needsManualReview'] === true && item['permanentlyClosed'] !== true,
    );
  }

  // Step 3: 分页
  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const startIndex = (pageNum - 1) * pageSize;
  const pageData = filtered.slice(startIndex, startIndex + pageSize);

  // Step 4: 只对当页数据查关联博主（不全量加载 RI + INFLUENCER）
  const pageRestIds = pageData.map((item) => (item['SK'] as string) || (item['restaurantId'] as string)).filter(Boolean);

  if (pageRestIds.length > 0) {
    // 从当页餐厅的 postRefs 提取 influencerUid，精确查 RI
    const postIds = new Set<string>();
    for (const item of pageData) { for (const ref of toStringArray(item['postRefs'])) postIds.add(ref); }

    if (postIds.size > 0) {
      const postDataMap = await batchGetFromShared(docClient, 'POST', Array.from(postIds));
      // 收集 influencerUid → restaurantId 的映射
      const restInfluencerMap = new Map<string, Set<string>>();
      for (const post of postDataMap.values()) {
        const uid = post['influencerUid'] as string;
        const rid = post['restaurantId'] as string;
        if (uid && rid) {
          if (!restInfluencerMap.has(rid)) restInfluencerMap.set(rid, new Set());
          restInfluencerMap.get(rid)!.add(uid);
        }
      }
      // 收集所有 uid，批量获取 INFLUENCER 信息
      const allUids = new Set<string>();
      for (const uids of restInfluencerMap.values()) for (const uid of uids) allUids.add(uid);

      if (allUids.size > 0) {
        const infDataMap = await batchGetFromShared(docClient, 'INFLUENCER', Array.from(allUids));
        // 挂到当页数据上
        for (const item of pageData) {
          const rid = (item['SK'] as string) || (item['restaurantId'] as string);
          const uids = restInfluencerMap.get(rid);
          if (uids) {
            item['influencers'] = Array.from(uids).map((uid) => {
              const inf = infDataMap.get(uid);
              return {
                influencerUid: uid,
                influencerName: inf?.['influencerName'] as string | undefined,
                influencerAvatar: inf?.['influencerAvatar'] as string | undefined,
              };
            });
          }
        }
      }
    }
  }

  return c.json({
    data: pageData,
    total,
    page: pageNum,
    pageSize,
    totalPages,
  });
});

// ============================================================
// PUT /restaurants/:id — 修改餐厅信息
// ============================================================

// 2026-10-21 谁拍板定的店：pipeline 管线自己定 / rerun 重跑后按五条规则写入 / cloud 云端挽回 / owner 产品负责人确认 / admin 手改
const CONFIRMED_BY = new Set(['pipeline', 'rerun', 'cloud', 'owner', 'admin']);
// 挽回状态：pending 等云端找 / owner 等产品负责人定
const RESCUE_STATUS = new Set(['pending', 'owner']);
// 改动记录里留原值的字段（改回时照这些写回去）
const AUDIT_FIELDS = ['restaurantName', 'city', 'address', 'latitude', 'longitude', 'needsManualReview', 'permanentlyClosed',
  'amapPoiId', 'googlePlaceId', 'locatedBy', 'locateReason', 'confirmedBy', 'locatedAt', 'rescueStatus', 'rescueNote', 'coordinateSource'];
// 只记出处、挽回状态的字段：请求里只有这些时不改店，也不结这家店的用户反馈
const META_ONLY_FIELDS = new Set(['amapPoiId', 'googlePlaceId', 'locatedBy', 'locateReason', 'confirmedBy', 'rescueStatus', 'rescueNote']);

/** 写了地图编号的店，把它在高德或 Google 上的详情、照片存下来（2026-10-22）：不等它，失败只记日志，漏的由补存脚本补 */
function savePlaceExtrasInBackground(docClient: ReturnType<typeof getDocClient>, restaurantId: string, amapPoiId?: string, googlePlaceId?: string): void {
  const id = (googlePlaceId?.trim() || amapPoiId?.trim()) ?? '';
  if (!id) return;
  const source = googlePlaceId?.trim() ? 'google' : 'amap';
  void getAppSecrets()
    .then((sec) => savePlaceExtrasSafe({
      docClient, restaurantId, source, id, amapKey: sec['AMAP_WEB_KEY'], googleKey: sec['GOOGLE_MAPS_API_KEY'], log: '[Admin]',
    }))
    .catch((err) => console.warn(`[Admin] 店铺详情 ${restaurantId} 没存上: ${err instanceof Error ? err.message : String(err)}`));
}

adminRoute.put('/restaurants/:id', async (c) => {
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  const body = await c.req.json<{
    restaurantName?: string;
    latitude?: number;
    longitude?: number;
    address?: string;
    city?: string;
    // 2026-05-16 四标志位统一为 needsManualReview：worklist "标记完成/跳过" 显式传 boolean。
    //   - true  → SET needsManualReview = true
    //   - false → REMOVE needsManualReview
    // 顺带：city + lat + lng 都补全时自动 REMOVE needsManualReview。
    needsManualReview?: boolean;
    // 2026-05-16 软关店标记：admin worklist / iOS GET 自动 filter 掉，但小店数据保留。
    //   - true  → SET permanentlyClosed = true
    //   - false → REMOVE permanentlyClosed
    permanentlyClosed?: boolean;
    // 2026-10-21 认店出处：重跑、云端挽回、产品负责人确认写入时一并记下，新旧数据靠 locatedAt 区分
    amapPoiId?: string;
    // 2026-10-21 境外和台湾的店走 Google 地图，记 Google 店铺编号（与 amapPoiId 并列）
    googlePlaceId?: string;
    locatedBy?: string;
    locateReason?: string;
    // 谁拍板：传了就记 locatedAt = now，并清掉 rescueStatus（除非同次显式传 rescueStatus）
    confirmedBy?: string;
    // 挽回状态：pending = 管线没认出、等云端找；owner = 云端也没找到、等产品负责人定；null = 清掉
    rescueStatus?: string | null;
    rescueNote?: string | null;
  }>();

  // 至少需要一个字段（needsManualReview / permanentlyClosed 单独传也算有效，用于纯"标记完成/跳过"或"关店"）
  if (
    !body.restaurantName &&
    body.latitude === undefined &&
    body.longitude === undefined &&
    !body.address &&
    !body.city &&
    body.needsManualReview === undefined &&
    body.permanentlyClosed === undefined &&
    !body.amapPoiId &&
    !body.googlePlaceId &&
    !body.locatedBy &&
    !body.locateReason &&
    !body.confirmedBy &&
    body.rescueStatus === undefined &&
    body.rescueNote === undefined
  ) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: '至少需要一个更新字段' },
    }, 400);
  }
  if (body.confirmedBy && !CONFIRMED_BY.has(body.confirmedBy)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: `confirmedBy 只能是 ${[...CONFIRMED_BY].join(' / ')}` },
    }, 400);
  }
  if (body.rescueStatus !== undefined && body.rescueStatus !== null && !RESCUE_STATUS.has(body.rescueStatus)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: `rescueStatus 只能是 ${[...RESCUE_STATUS].join(' / ')} 或 null` },
    }, 400);
  }

  const now = new Date().toISOString();

  // 1. 先读取 SHARED_TABLE 中的原始餐厅数据
  const originalResult = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
  }));

  if (!originalResult.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '餐厅不存在' },
    }, 404);
  }

  const originalItem = originalResult.Item;
  const oldCity = originalItem['city'] as string | undefined;
  const cityChanged = body.city && body.city !== oldCity;

  // 2. 更新 SHARED_TABLE 中的 REST 实体
  const updateParts: string[] = [
    'updatedAt = :now',
  ];
  const expressionValues: Record<string, unknown> = {
    ':now': now,
  };

  // 仅当填写了经纬度时才自动标记为 admin resolved（真正解决了定位问题）
  if (body.latitude !== undefined && body.longitude !== undefined) {
    updateParts.push('adminReviewedAt = :now', 'adminReviewedBy = :adminBy', 'adminStatus = :adminResolved');
    expressionValues[':adminBy'] = 'admin';
    expressionValues[':adminResolved'] = 'resolved';
  }
  // removeparts 已在下方 backfill 配合分支中重新声明（避免重复 const，统一在该处管理）

  if (body.restaurantName) {
    updateParts.push('restaurantName = :name');
    expressionValues[':name'] = body.restaurantName;
  }

  if (body.latitude !== undefined) {
    updateParts.push('latitude = :lat');
    expressionValues[':lat'] = body.latitude;
    updateParts.push('coordinateSource = :cs');
    expressionValues[':cs'] = 'admin';
  }

  if (body.longitude !== undefined) {
    updateParts.push('longitude = :lng');
    expressionValues[':lng'] = body.longitude;
  }

  if (body.address) {
    updateParts.push('address = :addr');
    expressionValues[':addr'] = body.address;
  }

  if (body.city) {
    // 2026-10-19：city 与 locality 同值（方案 B 后两者都是地级权威城市，iOS / Feed 读 locality）；
    // 补 GSI1SK——原来没有 city 的店建店时省略了 city-index 两个键，只补 GSI1PK 进不了索引
    updateParts.push('city = :city', 'locality = :city', 'GSI1PK = :gsi1pk', 'GSI1SK = :gsi1sk');
    expressionValues[':city'] = body.city;
    expressionValues[':gsi1pk'] = `CITY#${body.city}`;
    expressionValues[':gsi1sk'] = `REST#${restaurantId}`;
  }

  // ============================================================
  // 2026-05-16 四标志位统一为 needsManualReview
  //
  // 三条触发路径：
  //   1. 显式 SET=true   → worklist 标记"需要复审"
  //   2. 显式 SET=false  → worklist 标记"已处理/跳过"，REMOVE 字段
  //   3. 被动清（自动） → admin 同次 PUT 顺带补全了 city + lat + lng，
  //      说明数据已齐，REMOVE needsManualReview
  //
  // 后端为权威源，标志位只通过后端 SET/REMOVE。
  // ============================================================
  const removeparts: string[] = [];
  // city 已由 admin 补上，cityHint（流水线留给 admin 的参考线索）不再需要
  if (body.city) removeparts.push('cityHint');
  // 坐标已由 admin 定了，流水线留的定位候选与待确认原因（2026-10-20）不再需要
  if (body.latitude !== undefined) removeparts.push('geoCandidates', 'geoCandidatesAt', 'geoReviewReason');

  // 判断"被动清"是否触发：city + lat + lng 三件套都齐
  // city：本次传了非空 city，或 DB 现存 city 不是 unknown
  // lat/lng：本次同时传了 latitude 和 longitude，或 DB 已有坐标
  const newCityValid = !!body.city && body.city !== 'unknown';
  const dbCityValid = !!originalItem['city'] && originalItem['city'] !== 'unknown';
  const cityComplete = newCityValid || dbCityValid;

  const coordSupplied = body.latitude !== undefined && body.longitude !== undefined;
  const dbCoordExists = originalItem['latitude'] !== undefined && originalItem['longitude'] !== undefined;
  const coordComplete = coordSupplied || dbCoordExists;

  const autoClearManualReview = cityComplete && coordComplete;

  if (body.needsManualReview === true) {
    updateParts.push('needsManualReview = :nmr');
    expressionValues[':nmr'] = true;
  } else if (body.needsManualReview === false || autoClearManualReview) {
    removeparts.push('needsManualReview');
  }

  // 2026-05-16 软关店标记 permanentlyClosed
  // 语义：admin 在信息调整页点"标记小店闭店"后写入 true。该字段为真时：
  //   - admin worklist（GET /admin/restaurants?needsManualReview=true）自动 filter 掉
  //   - admin issues 列表（GET /admin/issues）对应 issue 自动 filter 掉（关联 REST 已闭店）
  //   - iOS GET /v1/restaurants 默认 filter 掉（用户端不再展示死店）
  // 数据本身保留（软标记，不删 REST/POST/ISSUE），便于后续审计或恢复。
  if (body.permanentlyClosed === true) {
    updateParts.push('permanentlyClosed = :pc');
    expressionValues[':pc'] = true;
  } else if (body.permanentlyClosed === false) {
    removeparts.push('permanentlyClosed');
  }

  // 2026-10-21 认店出处与挽回状态
  if (body.amapPoiId) {
    updateParts.push('amapPoiId = :poi');
    expressionValues[':poi'] = body.amapPoiId.trim();
  }
  if (body.googlePlaceId) {
    updateParts.push('googlePlaceId = :gp');
    expressionValues[':gp'] = body.googlePlaceId.trim();
  }
  if (body.locatedBy) {
    updateParts.push('locatedBy = :lb');
    expressionValues[':lb'] = body.locatedBy.trim();
  }
  if (body.locateReason) {
    updateParts.push('locateReason = :lr');
    expressionValues[':lr'] = body.locateReason.trim().slice(0, 300);
  }
  if (body.confirmedBy) {
    updateParts.push('confirmedBy = :cb', 'locatedAt = :now');
    expressionValues[':cb'] = body.confirmedBy;
  }
  if (typeof body.rescueStatus === 'string') {
    updateParts.push('rescueStatus = :rs');
    expressionValues[':rs'] = body.rescueStatus;
  } else if (body.rescueStatus === null || (body.rescueStatus === undefined && (body.confirmedBy || body.permanentlyClosed === true))) {
    // 定了店或下架了，就不再等人去找
    removeparts.push('rescueStatus');
  }
  if (typeof body.rescueNote === 'string' && body.rescueNote.trim()) {
    updateParts.push('rescueNote = :rn');
    expressionValues[':rn'] = body.rescueNote.trim().slice(0, 1000);
  } else if (body.rescueNote === null) {
    removeparts.push('rescueNote');
  }

  let updateExpression = `SET ${updateParts.join(', ')}`;
  if (removeparts.length > 0) {
    updateExpression += ` REMOVE ${removeparts.join(', ')}`;
  }

  await docClient.send(new UpdateCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionValues,
  }));

  console.log(`[Admin] 更新 SHARED REST ${restaurantId}: ${JSON.stringify(body)}`);

  // 改动记录（2026-10-21）：本机和云端经后台改的店都留一行原值，后台「改动记录」据此列出、可改回
  const actorHeader = (c.req.header('x-admin-actor') || '').toLowerCase();
  await docClient.send(new PutCommand({
    TableName: SHARED_TABLE,
    Item: {
      PK: 'ADMINLOG',
      SK: `${now}#${restaurantId}`,
      restaurantId,
      actor: /^[a-z][a-z-]{0,19}$/.test(actorHeader) ? actorHeader : 'admin',
      before: Object.fromEntries(AUDIT_FIELDS.filter((k) => originalItem[k] !== undefined).map((k) => [k, originalItem[k]])),
      changes: body,
      at: now,
    },
  }));

  savePlaceExtrasInBackground(docClient, restaurantId, body.amapPoiId, body.googlePlaceId);

  // 3. 同步更新关联 POST 实体（餐厅名、城市变了都需要同步）
  let postsSynced = 0;
  if (body.restaurantName || cityChanged) {
    const postRefs = toStringArray(originalItem['postRefs']);
    // 城市变更要用到每条 POST 的 createdAt（补 GSI4SK）与作者（同步 RI.city），先批量读出
    const postDataMap = cityChanged
      ? await batchGetFromShared(docClient, 'POST', postRefs)
      : new Map<string, Record<string, unknown>>();

    for (const awemeId of postRefs) {
      const postUpdateParts: string[] = ['updatedAt = :now'];
      const postRemoveParts: string[] = [];
      const postExprValues: Record<string, unknown> = { ':now': now };
      if (body.restaurantName) {
        postUpdateParts.push('restaurantName = :name');
        postExprValues[':name'] = body.restaurantName;
      }
      if (cityChanged) {
        // 2026-10-19 修 Feed 分区不同步：旧实现给 POST 写的是残留的 GSI1PK（POST 不在 city-index 里），
        // feed-index 的 GSI4PK 与 locality 都没改——改了城市的帖子仍留在旧城市的 Feed、进不了新城市的。
        // GSI4SK 只在缺失时补（原来没有 city 的帖子建帖时省略了 feed-index 键），沿用 POST 原始
        // createdAt 保序，与重刷流水线同口径；顺手清掉残留 GSI1PK 与 cityHint
        const createdAt = (postDataMap.get(awemeId)?.['createdAt'] as string | undefined) || now;
        postUpdateParts.push('city = :city', 'locality = :city', 'GSI4PK = :gsi4pk', 'GSI4SK = if_not_exists(GSI4SK, :gsi4sk)');
        postExprValues[':city'] = body.city!;
        postExprValues[':gsi4pk'] = `FEEDCITY#${body.city}`;
        postExprValues[':gsi4sk'] = `${createdAt}#${awemeId}`;
        postRemoveParts.push('GSI1PK', 'cityHint');
      }
      try {
        await docClient.send(new UpdateCommand({
          TableName: SHARED_TABLE,
          Key: { PK: 'POST', SK: awemeId },
          UpdateExpression: `SET ${postUpdateParts.join(', ')}`
            + (postRemoveParts.length ? ` REMOVE ${postRemoveParts.join(', ')}` : ''),
          ExpressionAttributeValues: postExprValues,
          ConditionExpression: 'attribute_exists(PK)',
        }));
        postsSynced++;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
          throw err;
        }
      }
    }

    // 城市变更同步两处派生态（与重刷流水线 R6c 同口径）：
    //  · videos.city —— parse.ts 去重命中 / 轮询的兜底读源（没有 videos 行的条件失败跳过）
    //  · RI.city —— 推荐者-店映射（admin 展示、推荐者城市维度）
    // INFLUENCER.cities / cityPostCounts 聚合不做增量迁移（需全局视角），必要时跑 backfill-feed-index 全量重算
    if (cityChanged) {
      const riUids = new Set<string>();
      for (const awemeId of postRefs) {
        const post = postDataMap.get(awemeId);
        const uid = post?.['influencerUid'] as string | undefined;
        if (uid) riUids.add(uid);
        try {
          await docClient.send(new UpdateCommand({
            TableName: VIDEOS_TABLE,
            Key: { awemeId },
            UpdateExpression: 'SET city = :c, updatedAt = :now',
            ConditionExpression: 'attribute_exists(awemeId)',
            ExpressionAttributeValues: { ':c': body.city!, ':now': now },
          }));
        } catch (err: unknown) {
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        }
      }
      for (const uid of riUids) {
        try {
          await docClient.send(new UpdateCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'RI', SK: `${uid}#${restaurantId}` },
            UpdateExpression: 'SET city = :c',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':c': body.city! },
          }));
        } catch (err: unknown) {
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        }
      }
    }
  }

  // 4. 将该餐厅的 pending ISSUE 标记为 resolved
  //    只记出处或挽回状态的请求（没改店）不结反馈：标「等云端找」「补记出处」不能把用户反馈悄悄结掉（2026-10-21）
  let issuesResolved = 0;
  const issueItems: Record<string, unknown>[] = [];
  let issueLk: Record<string, unknown> | undefined;
  const metaOnly = Object.keys(body).every((k) => META_ONLY_FIELDS.has(k));
  if (!metaOnly) do {
    const issueResult = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'restaurantId = :rid AND #s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':pk': 'ISSUE', ':rid': restaurantId, ':pending': 'pending' },
      ...(issueLk && { ExclusiveStartKey: issueLk }),
    }));
    if (issueResult.Items) issueItems.push(...issueResult.Items);
    issueLk = issueResult.LastEvaluatedKey;
  } while (issueLk);

  for (const issue of issueItems) {
    const issueSK = issue['SK'] as string;
    if (!issueSK) continue;
    try {
      await docClient.send(new UpdateCommand({
        TableName: SHARED_TABLE,
        Key: { PK: 'ISSUE', SK: issueSK },
        UpdateExpression: 'SET #s = :resolved, resolvedAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':resolved': 'resolved', ':now': now },
      }));
      issuesResolved++;
    } catch { /* 忽略单条失败 */ }
  }

  // 清除相关缓存
  cache.delete('stats-cards');
  cache.delete('stats-city-dist');
  cache.delete('stats-inf-city-dist');
  cache.delete('stats-top-inf');
  cache.delete('users-aggregated');
  cache.delete('users-registered');
  cache.delete('users-all');
  cache.delete('influencers-all');
  cache.delete('restaurants-all');

  console.log(`[Admin] REST ${restaurantId} 更新完成, ${postsSynced} 条 POST 同步, ${issuesResolved} 条 ISSUE 已解决`);

  return c.json({
    data: {
      restaurantId,
      updated: body,
      syncedUsers: 0, // 用户表为薄引用，无需同步
      syncedPosts: postsSynced,
    },
  });
});

// ============================================================
// POST /restaurants/:id/review — admin 标记处理结果
// ============================================================

adminRoute.post('/restaurants/:id/review', async (c) => {
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  const body = await c.req.json<{
    status: 'resolved' | 'unfindable';
    note?: string;
  }>();

  // 参数校验
  if (!body.status || !['resolved', 'unfindable'].includes(body.status)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'status 必须为 resolved 或 unfindable' },
    }, 400);
  }

  // 检查餐厅是否存在
  const existing = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
  }));

  if (!existing.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '餐厅不存在' },
    }, 404);
  }

  const now = new Date().toISOString();

  // 构建更新表达式
  const updateParts: string[] = [
    'updatedAt = :now',
    'adminReviewedAt = :reviewedAt',
    'adminReviewedBy = :reviewedBy',
    'adminStatus = :adminStatus',
  ];
  const expressionValues: Record<string, unknown> = {
    ':now': now,
    ':reviewedAt': now,
    ':reviewedBy': 'admin',
    ':adminStatus': body.status,
  };

  // 备注（可选）
  if (body.note) {
    updateParts.push('adminNote = :adminNote');
    expressionValues[':adminNote'] = body.note;
  }

  // 2026-05-16 locationFailed 字段已废弃，adminStatus='unfindable' 即"找不到该店"业务态，
  // 不再额外写 locationFailed 字段。需要 worklist 介入时由 admin 显式 PUT
  // needsManualReview=true（如真需要重做），或直接 unfindable 收尾。

  await docClient.send(new UpdateCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
  }));

  console.log(`[Admin] REST ${restaurantId} review: status=${body.status}, note=${body.note || ''}`);

  // 清除相关缓存
  cache.delete('restaurants-all');

  // 返回更新后的记录
  const updatedResult = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
  }));

  const item = updatedResult.Item!;
  return c.json({
    data: {
      restaurantId: item.SK,
      restaurantName: item.restaurantName || '',
      locationHint: item.locationHint || '',
      address: item.address || '',
      city: item.city || '',
      latitude: item.latitude ?? null,
      longitude: item.longitude ?? null,
      coordinateSource: item.coordinateSource || '',
      locationFailed: item.locationFailed || false,
      adminReviewedAt: item.adminReviewedAt || null,
      adminReviewedBy: item.adminReviewedBy || null,
      adminNote: item.adminNote || null,
      adminStatus: item.adminStatus || null,
      postRefs: toStringArray(item.postRefs),
      createdAt: item.createdAt || '',
      updatedAt: item.updatedAt || '',
    },
  });
});

// ============================================================
// GET /posts/:id — 单条 POST 详情（违规处理 Drawer 用）
// ------------------------------------------------------------
// 调用方：admin /violations Drawer 点 POST 类举报后查全字段。
//
// 帖子 SK 就是裸 awemeId；带 POST# 前缀传来的（举报行的 targetId）去掉前缀再查。
// ============================================================

adminRoute.get('/posts/:id', async (c) => {
  const sk = c.req.param('id').replace(/^POST#/, '');
  const docClient = getDocClient();

  const result = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'POST', SK: sk },
  }));
  const item = result.Item;

  if (!item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: 'POST 不存在' },
    }, 404);
  }

  // DynamoDB Set 转 Array（与 /influencers/:uid 同处理）
  if (item['tags'] instanceof Set) {
    item['tags'] = Array.from(item['tags']);
  }

  return c.json({ data: item });
});

// ============================================================
// POST /posts/:id/move — 把一条帖子挪到新店或已有的店（2026-10-21）
// ------------------------------------------------------------
// 旧管线把不同的店并成了一家（比如东京的 MAZ 和北京五道口的墨西哥餐厅挂在一起），要能拆开、也能并过去。
// body: { to: 'new' | <restaurantId>,
//         restaurant?: { restaurantName, latitude, longitude, city, address, amapPoiId, locatedBy,
//                        locateReason, confirmedBy, rescueStatus, rescueNote }（to=new 时用，店名必填），
//         note? }
// 一次改齐：
//   1. 新店建 REST（编号用帖子 SK，被占用就加 -2、-3…），帖子是它唯一的 postRef；已有店在 postRefs 末尾追加
//   2. 原店 postRefs 去掉这条（按下标删，条件确认下标上还是它）；挪空了就下架，数据保留
//   3. POST 的 restaurantId、店名、城市与 feed-index（GSI4）跟着目标店
//   4. 派生态：videos.restaurantId / city；RI（推荐者-店映射）补目标店那条，原店没这位推荐者的帖子了就删旧的，
//      INFLUENCER.restaurantCount 跟着增减（cities / cityPostCounts 同改店接口，不做增量迁移）
//   5. 导入者的「稍后去吃」：帖子的 recommendedBy 收藏了原店，就给他收藏目标店；原店剩下的帖子都不是他导入的，
//      原店那条收藏一并删掉（users 表 REST# 行，Stream 计数 Lambda 据此把两家店的 totalBookmarks 一减一加）
//   6. 两家店各留一行 ADMINLOG（move-post / move-post-in），后台「改动记录」可改回（再挪回去）
// 用户反馈、好吃不好吃说的是店，留在原店不跟帖子走。
// ============================================================

adminRoute.post('/posts/:id/move', async (c) => {
  const rawId = c.req.param('id');
  const docClient = getDocClient();
  const body = await c.req.json<{
    to?: string;
    restaurant?: {
      restaurantName?: string;
      latitude?: number;
      longitude?: number;
      city?: string;
      address?: string;
      amapPoiId?: string;
      googlePlaceId?: string;
      locatedBy?: string;
      locateReason?: string;
      confirmedBy?: string;
      rescueStatus?: string;
      rescueNote?: string;
    };
    note?: string;
  }>();
  const bad = (message: string, status: 400 | 404 | 409 = 400) =>
    c.json({ error: { code: status === 400 ? 'INVALID_INPUT' : status === 404 ? 'NOT_FOUND' : 'CONFLICT', message } }, status);

  const to = (body.to || '').trim();
  const r = body.restaurant || {};
  if (!to) return bad('to 必填：new 或目标店的 restaurantId');
  if (to === 'new' && !r.restaurantName?.trim()) return bad('挪到新店要给 restaurant.restaurantName');
  if ((r.latitude === undefined) !== (r.longitude === undefined)) return bad('坐标要经纬度一起给');
  if (r.confirmedBy && !CONFIRMED_BY.has(r.confirmedBy)) return bad(`confirmedBy 只能是 ${[...CONFIRMED_BY].join(' / ')}`);
  if (r.rescueStatus && !RESCUE_STATUS.has(r.rescueStatus)) return bad(`rescueStatus 只能是 ${[...RESCUE_STATUS].join(' / ')}`);

  // 1. 帖子：SK 是裸 awemeId（带 POST# 前缀传来的去掉）
  const post = (await docClient.send(new GetCommand({ TableName: SHARED_TABLE, Key: { PK: 'POST', SK: rawId.replace(/^POST#/, '') } }))).Item;
  if (!post) return bad('POST 不存在', 404);
  const postSk = post['SK'] as string;
  const fromId = post['restaurantId'] as string;
  if (to === fromId) return bad('目标店就是帖子现在挂的店');
  const fromGot = await docClient.send(new GetCommand({ TableName: SHARED_TABLE, Key: { PK: 'REST', SK: fromId } }));
  const from = fromGot.Item;
  if (!from) return bad('帖子挂的店不存在', 409);
  const fromRefs = toStringArray(from['postRefs']);
  const idx = fromRefs.indexOf(postSk);
  if (idx < 0) return bad('原店的帖子列表里没有这条', 409);

  const now = new Date().toISOString();

  // 2. 目标店
  let toId = to;
  let target: Record<string, unknown>;
  let createdNew = false;
  if (to === 'new') {
    const base = postSk;
    let n = 1;
    toId = base;
    for (;;) {
      const exists = await docClient.send(new GetCommand({ TableName: SHARED_TABLE, Key: { PK: 'REST', SK: toId } }));
      if (!exists.Item) break;
      n += 1;
      if (n > 9) return bad('新店编号都被占用了', 409);
      toId = `${base}-${n}`;
    }
    const city = r.city?.trim() || '';
    const hasCoord = r.latitude !== undefined && r.longitude !== undefined;
    target = {
      PK: 'REST',
      SK: toId,
      restaurantId: toId,
      restaurantName: r.restaurantName!.trim(),
      city,
      locality: city,
      ...(city ? { GSI1PK: `CITY#${city}`, GSI1SK: `REST#${toId}` } : {}),
      ...(hasCoord ? {
        latitude: r.latitude, longitude: r.longitude, coordinateSource: 'admin',
        adminStatus: 'resolved', adminReviewedAt: now, adminReviewedBy: 'admin',
      } : {}),
      ...(r.address?.trim() ? { address: r.address.trim() } : {}),
      ...(r.amapPoiId?.trim() ? { amapPoiId: r.amapPoiId.trim() } : {}),
      ...(r.googlePlaceId?.trim() ? { googlePlaceId: r.googlePlaceId.trim() } : {}),
      ...(r.locatedBy?.trim() ? { locatedBy: r.locatedBy.trim() } : {}),
      ...(r.locateReason?.trim() ? { locateReason: r.locateReason.trim().slice(0, 300) } : {}),
      ...(r.confirmedBy ? { confirmedBy: r.confirmedBy, locatedAt: now } : {}),
      ...(r.rescueStatus ? { rescueStatus: r.rescueStatus } : {}),
      ...(r.rescueNote?.trim() ? { rescueNote: r.rescueNote.trim().slice(0, 1000) } : {}),
      postRefs: [postSk],
      source: (from['source'] as string | undefined) || 'import',
      splitFrom: fromId,
      // 沿用帖子的建帖时间：新旧数据按 createdAt 分，拆出来的店不该被当成新管线建的
      createdAt: (post['createdAt'] as string | undefined) || now,
      updatedAt: now,
      ...(!city || !hasCoord ? { needsManualReview: true } : {}),
    };
    await docClient.send(new PutCommand({
      TableName: SHARED_TABLE,
      Item: target,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    createdNew = true;
  } else {
    const got = await docClient.send(new GetCommand({ TableName: SHARED_TABLE, Key: { PK: 'REST', SK: to } }));
    if (!got.Item) return bad('目标店不存在', 404);
    if (got.Item['permanentlyClosed'] === true) return bad('目标店已下架，先恢复上架再挪', 409);
    target = got.Item;
    try {
      await docClient.send(new UpdateCommand({
        TableName: SHARED_TABLE,
        Key: { PK: 'REST', SK: to },
        UpdateExpression: 'SET updatedAt = :now, postRefs = list_append(if_not_exists(postRefs, :empty), :ref)',
        ConditionExpression: 'NOT contains(postRefs, :sk)',
        ExpressionAttributeValues: { ':now': now, ':empty': [] as string[], ':ref': [postSk], ':sk': postSk },
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
  }

  // 3. 原店：按下标删掉这条；挪空了就下架（不再等人去找）
  const fromLeft = fromRefs.filter((x) => x !== postSk);
  const fromClosed = fromLeft.length === 0 && from['permanentlyClosed'] !== true;
  await docClient.send(new UpdateCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: fromId },
    UpdateExpression: `SET updatedAt = :now${fromClosed ? ', permanentlyClosed = :t' : ''} REMOVE postRefs[${idx}]${fromClosed ? ', rescueStatus' : ''}`,
    ConditionExpression: `postRefs[${idx}] = :sk`,
    ExpressionAttributeValues: { ':now': now, ':sk': postSk, ...(fromClosed ? { ':t': true } : {}) },
  }));

  // 4. POST 跟着目标店；目标店没有城市就退出 feed-index
  const toCity = (target['city'] as string | undefined) || '';
  const postSet = ['restaurantId = :rid', 'restaurantName = :name', 'updatedAt = :now', 'city = :city', 'locality = :city'];
  const postRemove = ['GSI1PK', 'cityHint'];
  const postValues: Record<string, unknown> = {
    ':rid': toId, ':name': target['restaurantName'] as string, ':now': now, ':city': toCity,
  };
  if (toCity) {
    postSet.push('GSI4PK = :g4pk', 'GSI4SK = if_not_exists(GSI4SK, :g4sk)');
    postValues[':g4pk'] = `FEEDCITY#${toCity}`;
    postValues[':g4sk'] = `${(post['createdAt'] as string | undefined) || now}#${postSk}`;
  } else {
    postRemove.push('GSI4PK', 'GSI4SK');
  }
  await docClient.send(new UpdateCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'POST', SK: postSk },
    UpdateExpression: `SET ${postSet.join(', ')} REMOVE ${postRemove.join(', ')}`,
    ExpressionAttributeValues: postValues,
  }));

  // 5a. videos 表（轮询导入结果、去重命中都从这里拿店；没有这一行的条件失败跳过）
  try {
    await docClient.send(new UpdateCommand({
      TableName: VIDEOS_TABLE,
      Key: { awemeId: postSk },
      UpdateExpression: 'SET restaurantId = :rid, city = :c, updatedAt = :now',
      ConditionExpression: 'attribute_exists(awemeId)',
      ExpressionAttributeValues: { ':rid': toId, ':c': toCity, ':now': now },
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }

  // 原店剩下的帖子：判断推荐者、导入者还在不在原店
  const leftPosts = fromLeft.length ? await batchGetFromShared(docClient, 'POST', fromLeft) : new Map<string, Record<string, unknown>>();
  const uidOf = (p: Record<string, unknown> | undefined) => p?.['influencerUid'] as string | undefined;

  // 5b. RI 推荐者-店映射
  const uid = uidOf(post);
  let riAdded = false;
  let riRemoved = false;
  if (uid) {
    try {
      await docClient.send(new PutCommand({
        TableName: SHARED_TABLE,
        Item: {
          PK: 'RI', SK: `${uid}#${toId}`, influencerUid: uid, restaurantId: toId, city: toCity,
          GSI2PK: `INF#${uid}`, GSI2SK: `REST#${toId}`, createdAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      riAdded = true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    }
    if (![...leftPosts.values()].some((p) => uidOf(p) === uid)) {
      try {
        await docClient.send(new DeleteCommand({
          TableName: SHARED_TABLE,
          Key: { PK: 'RI', SK: `${uid}#${fromId}` },
          ConditionExpression: 'attribute_exists(PK)',
        }));
        riRemoved = true;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
    const delta = (riAdded ? 1 : 0) - (riRemoved ? 1 : 0);
    if (delta !== 0 || (riAdded && toCity)) {
      try {
        await docClient.send(new UpdateCommand({
          TableName: SHARED_TABLE,
          Key: { PK: 'INFLUENCER', SK: uid },
          UpdateExpression: `ADD ${[delta !== 0 ? 'restaurantCount :d' : '', riAdded && toCity ? 'cities :cs' : ''].filter(Boolean).join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ...(delta !== 0 ? { ':d': delta } : {}),
            ...(riAdded && toCity ? { ':cs': new Set([toCity]) } : {}),
          },
        }));
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
  }

  // 5c. 导入者的「稍后去吃」跟着走
  let bookmarkAdded = false;
  let bookmarkMoved = false;
  const importer = post['recommendedBy'] as string | undefined;
  if (importer && importer !== 'system-batch') {
    const bm = await docClient.send(new GetCommand({ TableName: USERS_TABLE, Key: { PK: importer, SK: `REST#${fromId}` } }));
    if (bm.Item && bm.Item['bookmarked'] === true) {
      const { PK: _pk, SK: _sk, restaurantId: _rid, GSI3SK: _g3, ...rest } = bm.Item;
      try {
        await docClient.send(new PutCommand({
          TableName: USERS_TABLE,
          Item: {
            ...rest, PK: importer, SK: `REST#${toId}`, restaurantId: toId,
            GSI3PK: `${importer}#BOOKMARK`, GSI3SK: `REST#${toId}`, updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
        bookmarkAdded = true;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
      if (![...leftPosts.values()].some((p) => p['recommendedBy'] === importer)) {
        await docClient.send(new DeleteCommand({ TableName: USERS_TABLE, Key: { PK: importer, SK: `REST#${fromId}` } }));
        bookmarkMoved = true;
      }
    }
  }

  // 6. 改动记录：两家店各一行
  const actorHeader = (c.req.header('x-admin-actor') || '').toLowerCase();
  const actor = /^[a-z][a-z-]{0,19}$/.test(actorHeader) ? actorHeader : 'admin';
  const note = body.note?.trim() ? { note: body.note.trim().slice(0, 300) } : {};
  await docClient.send(new PutCommand({
    TableName: SHARED_TABLE,
    Item: {
      PK: 'ADMINLOG', SK: `${now}#${fromId}`, restaurantId: fromId, actor, at: now,
      before: { postRefs: fromRefs, ...(from['permanentlyClosed'] !== undefined ? { permanentlyClosed: from['permanentlyClosed'] } : {}) },
      changes: { action: 'move-post', postId: postSk, to: toId, createdNew, ...(fromClosed ? { permanentlyClosed: true } : {}), ...note },
    },
  }));
  await docClient.send(new PutCommand({
    TableName: SHARED_TABLE,
    Item: {
      PK: 'ADMINLOG', SK: `${now}#${toId}`, restaurantId: toId, actor, at: now,
      before: createdNew ? {} : { postRefs: toStringArray(target['postRefs']) },
      changes: {
        action: 'move-post-in', postId: postSk, from: fromId, createdNew,
        ...(createdNew ? { restaurantName: target['restaurantName'], city: toCity } : {}), ...note,
      },
    },
  }));

  cache.delete('stats-cards');
  cache.delete('stats-city-dist');
  cache.delete('stats-inf-city-dist');
  cache.delete('stats-top-inf');
  cache.delete('influencers-all');
  cache.delete('restaurants-all');

  if (createdNew) savePlaceExtrasInBackground(docClient, toId, r.amapPoiId, r.googlePlaceId);
  console.log(`[Admin] 帖子 ${postSk} 从 ${fromId} 挪到 ${toId}（新店 ${createdNew}，原店下架 ${fromClosed}）`);
  return c.json({
    data: { postId: postSk, from: fromId, to: toId, createdNew, fromClosed, riAdded, riRemoved, bookmarkAdded, bookmarkMoved },
  });
});

// ============================================================
// GET /restaurants/:id/detail — REST 详情 + 关联 POSTs（违规处理 Drawer 用）
// ------------------------------------------------------------
// 调用方：admin /violations Drawer 点 REST 类举报后查全字段 + 关联 POST 内容。
//
// 实现：
//   1. GetItem REST 全字段
//   2. 取 postRefs（最多前 50 条，避免响应过大）
//   3. BatchGetItem 拉这批 POST 全字段（容错：missing 静默跳过）
// 错误：REST 不存在返 404；postRefs 为空时 posts=[]
// ============================================================

const ADMIN_REST_DETAIL_POST_LIMIT = 50;

adminRoute.get('/restaurants/:id/detail', async (c) => {
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  // 1. 取 REST 全字段
  const restResult = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
  }));

  if (!restResult.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '餐厅不存在' },
    }, 404);
  }

  const restaurant = restResult.Item;

  // DynamoDB Set 转 Array
  if (restaurant['cuisines'] instanceof Set) {
    restaurant['cuisines'] = Array.from(restaurant['cuisines']);
  }

  // 2. 从 postRefs 取关联 POST id（最多前 50 条）
  const allPostRefs = toStringArray(restaurant['postRefs']);
  const limitedRefs = allPostRefs.slice(0, ADMIN_REST_DETAIL_POST_LIMIT);

  // 3. BatchGet 关联 POST
  let posts: Record<string, unknown>[] = [];
  if (limitedRefs.length > 0) {
    const postDataMap = await batchGetFromShared(docClient, 'POST', limitedRefs);
    posts = limitedRefs
      .map((ref) => postDataMap.get(ref))
      .filter((p): p is Record<string, unknown> => Boolean(p));

    // tags Set→Array 转换
    for (const post of posts) {
      if (post['tags'] instanceof Set) {
        post['tags'] = Array.from(post['tags']);
      }
    }
  }

  return c.json({
    data: {
      restaurant,
      posts,
      postRefsTotal: allPostRefs.length,
      postsReturned: posts.length,
    },
  });
});

/**
 * 查找关注了指定博主的所有用户 PK 集合
 * 扫描 SK = INFLUENCER#${influencerUid} 的记录，提取对应 PK
 */
/**
 * 按博主名模糊搜索，返回匹配的 influencerUid 集合
 * 从 SHARED_TABLE INFLUENCER 分区搜索 influencerName 包含关键词的记录
 */
async function findInfluencerUidsByName(
  docClient: ReturnType<typeof getDocClient>,
  nameKeyword: string,
): Promise<Set<string>> {
  const uids = new Set<string>();
  const keyword = nameKeyword.toLowerCase();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'INFLUENCER',
      },
      ProjectionExpression: 'SK, influencerName',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    for (const item of result.Items || []) {
      const name = (item['influencerName'] as string) || '';
      if (name.toLowerCase().includes(keyword)) {
        const uid = item['SK'] as string;
        if (uid) uids.add(uid);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return uids;
}

async function findFollowerPKs(
  docClient: ReturnType<typeof getDocClient>,
  influencerUid: string,
): Promise<Set<string>> {
  // 通过 entity-type-index GSI（SK→PK 反转）精确查询，避免全表 Scan
  const pks = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'entity-type-index',
      KeyConditionExpression: 'SK = :sk',
      ExpressionAttributeValues: {
        ':sk': `INFLUENCER#${influencerUid}`,
      },
      ProjectionExpression: 'PK',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));

    for (const item of result.Items || []) {
      const pk = item['PK'] as string;
      if (pk && pk !== 'system-batch') {
        pks.add(pk);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return pks;
}

/**
 * 从 SHARED_TABLE 批量获取指定分区的实体
 * @param pk 分区键（如 'REST'、'POST'、'INFLUENCER'）
 * @param skValues SK 值列表
 * @returns SK -> 完整实体数据的 Map
 */
async function batchGetFromShared(
  docClient: ReturnType<typeof getDocClient>,
  pk: string,
  skValues: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  if (skValues.length === 0) return result;

  // DynamoDB BatchGet 每批最多 100 个 key
  for (let i = 0; i < skValues.length; i += 100) {
    const batch = skValues.slice(i, i + 100);
    const keys = batch.map((sk) => ({ PK: pk, SK: sk }));

    const batchResult = await docClient.send(new BatchGetCommand({
      RequestItems: {
        [SHARED_TABLE]: { Keys: keys },
      },
    }));

    for (const item of batchResult.Responses?.[SHARED_TABLE] || []) {
      const sk = item['SK'] as string;
      if (sk) result.set(sk, item);
    }
  }

  return result;
}

// ============================================================
// GET /influencers — 官方博主列表（分页）
// ============================================================

adminRoute.get('/influencers', async (c) => {
  const docClient = getDocClient();
  const pageNum = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));
  const search = c.req.query('search');

  // 全量查询 + 缓存
  const cacheKey = 'influencers-all';
  let allItems = getCached<Record<string, unknown>[]>(cacheKey);

  if (!allItems) {
    allItems = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: SHARED_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'INFLUENCER',
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      if (result.Items) allItems.push(...result.Items);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    // DynamoDB Set 转 Array（cities 字段是 DynamoDB Set 类型）
    for (const item of allItems) {
      const cities = item['cities'];
      if (cities instanceof Set) {
        item['cities'] = Array.from(cities);
      }
    }
    setCache(cacheKey, allItems);
  }

  // 按名称或 UID 模糊搜索
  let filtered = allItems;
  if (search) {
    const keyword = search.toLowerCase();
    filtered = allItems.filter((item) => {
      const name = ((item['influencerName'] as string) || '').toLowerCase();
      const uid = ((item['SK'] as string) || '').toLowerCase();
      return name.includes(keyword) || uid.includes(keyword);
    });
  }

  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const startIndex = (pageNum - 1) * pageSize;
  const pageData = filtered.slice(startIndex, startIndex + pageSize);

  return c.json({
    data: pageData,
    total,
    page: pageNum,
    pageSize,
    totalPages,
  });
});

// ============================================================
// GET /influencers/:uid — 博主详情（含关联小店和视频）
// ============================================================

adminRoute.get('/influencers/:uid', async (c) => {
  const uid = c.req.param('uid');
  const docClient = getDocClient();

  // 1. 获取博主基本信息
  const infResult = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'INFLUENCER', SK: uid },
  }));

  if (!infResult.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '博主不存在' },
    }, 404);
  }

  const influencer = infResult.Item;

  // DynamoDB Set 转 Array
  if (influencer['cities'] instanceof Set) {
    influencer['cities'] = Array.from(influencer['cities']);
  }

  // 2. 通过 GSI2 查询该博主关联的小店
  const restaurantIds: string[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const queryResult = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      IndexName: 'influencer-filter-index',
      KeyConditionExpression: 'GSI2PK = :gsi2pk AND begins_with(GSI2SK, :prefix)',
      ExpressionAttributeValues: {
        ':gsi2pk': `INF#${uid}`,
        ':prefix': 'REST#',
      },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (queryResult.Items) {
      for (const item of queryResult.Items) {
        // GSI2SK 格式为 REST#{restaurantId}，提取 restaurantId
        const gsi2sk = item['GSI2SK'] as string;
        if (gsi2sk) {
          const restaurantId = gsi2sk.replace('REST#', '');
          restaurantIds.push(restaurantId);
        }
      }
    }
    lastKey = queryResult.LastEvaluatedKey;
  } while (lastKey);

  // 3. 批量获取小店完整数据
  const restDataMap = await batchGetFromShared(docClient, 'REST', restaurantIds);
  const restaurants = restaurantIds
    .map((id) => restDataMap.get(id))
    .filter(Boolean) as Record<string, unknown>[];

  // 4. 从小店的 postRefs 收集视频 ID（去重）
  const postIdSet = new Set<string>();
  for (const rest of restaurants) {
    for (const ref of toStringArray(rest['postRefs'])) postIdSet.add(ref);
  }

  // 5. 批量获取视频完整数据
  const postDataMap = await batchGetFromShared(docClient, 'POST', Array.from(postIdSet));
  const posts = Array.from(postIdSet)
    .map((id) => postDataMap.get(id))
    .filter(Boolean) as Record<string, unknown>[];

  return c.json({
    data: {
      influencer,
      restaurants,
      posts,
    },
  });
});

// ============================================================
// GET /videos — 视频列表（分页 + 搜索）
// ============================================================

adminRoute.get('/videos', async (c) => {
  const docClient = getDocClient();
  const pageNum = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));
  const search = c.req.query('search');

  if (search) {
    // 搜索模式：按 awemeId 精确查找
    const result = await docClient.send(new GetCommand({
      TableName: VIDEOS_TABLE,
      Key: { awemeId: search },
    }));
    return c.json({
      data: result.Item ? [result.Item] : [],
      total: result.Item ? 1 : 0,
      page: 1,
      pageSize,
      totalPages: result.Item ? 1 : 0,
    });
  }

  // 通过 status-index GSI 按状态并行查询 + 缓存
  const cacheKey = 'videos-all';
  let allItems = getCached<Record<string, unknown>[]>(cacheKey);

  if (!allItems) {
    const statuses = ['completed', 'rejected', 'failed', 'processing'];
    const queryByStatus = async (status: string) => {
      const items: Record<string, unknown>[] = [];
      let lk: Record<string, unknown> | undefined;
      do {
        const result = await docClient.send(new QueryCommand({
          TableName: VIDEOS_TABLE,
          IndexName: 'status-index',
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status },
          ScanIndexForward: false, // 最新的在前
          ...(lk && { ExclusiveStartKey: lk }),
        }));
        if (result.Items) items.push(...result.Items);
        lk = result.LastEvaluatedKey;
      } while (lk);
      return items;
    };
    const results = await Promise.all(statuses.map(queryByStatus));
    allItems = results.flat();
    // 按 createdAt 倒序排列
    allItems.sort((a, b) => ((b['createdAt'] as string) || '').localeCompare((a['createdAt'] as string) || ''));
    setCache(cacheKey, allItems);
  }

  const total = allItems.length;
  const totalPages = Math.ceil(total / pageSize);
  const startIndex = (pageNum - 1) * pageSize;
  const pageData = allItems.slice(startIndex, startIndex + pageSize);

  return c.json({
    data: pageData,
    total,
    page: pageNum,
    pageSize,
    totalPages,
  });
});

// ============================================================
// GET /monitor/location-issues — 2026-05-16 已删除
// ============================================================
// 路由及 handler 整体下线。原因：
// - 霍去病前端已删 /monitoring 路由 + getLocationIssues 调用，端点成孤儿
// - 四标志位统一为 needsManualReview 后，定位问题视图与 worklist 视图重叠语义
//   （admin 通过 GET /restaurants?needsManualReview=true 已能覆盖该场景）
// - 同时清掉 'location-issues-imported-by' 缓存键，无人引用


// ============================================================
// GET /issues — 用户反馈问题列表（分页 + 状态筛选）
// ============================================================

adminRoute.get('/issues', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '20', 10)));
  const statusFilter = c.req.query('status') || 'all';

  const docClient = getDocClient();

  // 从 shared 表查询 PK='ISSUE' 的所有记录，SK 按时间倒序
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ISSUE' },
      ScanIndexForward: false, // SK 是时间戳格式，倒序即最新在前
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (result.Items) allItems.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 应用层按 status 过滤
  let filtered: Record<string, unknown>[];
  if (statusFilter === 'all') {
    filtered = allItems;
  } else if (statusFilter === 'unfindable') {
    // unfindable 需要关联 REST 记录的 adminStatus，先查全部 restaurantId 的 REST 数据
    const allRestIds = new Set<string>();
    for (const item of allItems) {
      if (item['restaurantId']) allRestIds.add(item['restaurantId'] as string);
    }
    const unfindableRestMap = await batchGetFromShared(docClient, 'REST', Array.from(allRestIds));
    filtered = allItems.filter(item => {
      const rid = item['restaurantId'] as string | undefined;
      if (!rid) return false;
      const restData = unfindableRestMap.get(rid);
      return restData?.['adminStatus'] === 'unfindable';
    });
  } else {
    filtered = allItems.filter(item => item['status'] === statusFilter);
  }

  // 2026-05-16 软关店标记：关联 REST 已 permanentlyClosed=true 的 issue 不在 admin 展示。
  // 实现：对当前 filtered 的全部 restaurantId 做一次 BatchGet（PK='REST'），
  // filter 掉关联 REST.permanentlyClosed === true 的 issue。
  // 性能：BatchGetItem 单批最多 100，函数内部已分批；filtered 量级一般 < 数百，1-2 次 BatchGet 即可。
  // 复用：得到的 allRestMap 同时作为下游 currentRestaurant / priceHint 的数据源，避免重复查 REST。
  const allRestIdSet = new Set<string>();
  for (const item of filtered) {
    if (item['restaurantId']) allRestIdSet.add(item['restaurantId'] as string);
  }
  const allRestMap = await batchGetFromShared(docClient, 'REST', Array.from(allRestIdSet));
  filtered = filtered.filter((item) => {
    const rid = item['restaurantId'] as string | undefined;
    if (!rid) return true; // 无关联餐厅的 issue 保留（数据异常但不在本次 filter 范围）
    const restData = allRestMap.get(rid);
    return restData?.['permanentlyClosed'] !== true;
  });

  // 先分页，再只对当页数据补充关联信息（减少 BatchGet 开销）
  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const startIndex = (page - 1) * pageSize;
  const pageItems = filtered.slice(startIndex, startIndex + pageSize);

  // 收集当页 issue 的去重 identityId 和 restaurantId
  const identityIdSet = new Set<string>();
  const restaurantIdSet = new Set<string>();
  for (const item of pageItems) {
    if (item['identityId']) identityIdSet.add(item['identityId'] as string);
    if (item['restaurantId']) restaurantIdSet.add(item['restaurantId'] as string);
  }

  // 批量获取用户 PROFILE（从 USERS_TABLE）
  const profileMap = new Map<string, Record<string, unknown>>();
  const identityIds = Array.from(identityIdSet);
  for (let i = 0; i < identityIds.length; i += 100) {
    const batch = identityIds.slice(i, i + 100);
    const keys = batch.map((id) => ({ PK: id, SK: 'PROFILE' }));
    const batchResult = await docClient.send(new BatchGetCommand({
      RequestItems: {
        [USERS_TABLE]: { Keys: keys },
      },
    }));
    for (const item of batchResult.Responses?.[USERS_TABLE] || []) {
      profileMap.set(item['PK'] as string, item);
    }
  }

  // 批量获取餐厅数据：复用上游 allRestMap（permanentlyClosed filter 时已查），避免重复 BatchGet
  const restDataMap = new Map<string, Record<string, unknown>>();
  for (const rid of restaurantIdSet) {
    const data = allRestMap.get(rid);
    if (data) restDataMap.set(rid, data);
  }

  // 批量获取 POST 数据（取 priceHint）
  const allPostIds = new Set<string>();
  for (const restData of restDataMap.values()) {
    for (const ref of toStringArray(restData['postRefs'])) allPostIds.add(ref);
  }
  const postDataMap = allPostIds.size > 0
    ? await batchGetFromShared(docClient, 'POST', Array.from(allPostIds))
    : new Map<string, Record<string, unknown>>();

  // 按 restaurantId 取第一个有 priceHint 的 POST
  const priceHintMap = new Map<string, string>();
  for (const [rid, restData] of restDataMap) {
    const refs = toStringArray(restData['postRefs']);
    for (const ref of refs) {
      const post = postDataMap.get(ref);
      const hint = post?.['priceHint'] as string | undefined;
      if (hint) { priceHintMap.set(rid, hint); break; }
    }
  }

  // 映射返回字段，补充用户信息和关联视频
  const pageData = pageItems.map(item => {
    const identityId = item['identityId'] as string | undefined;
    const restaurantId = item['restaurantId'] as string | undefined;
    const profile = identityId ? profileMap.get(identityId) : undefined;
    const restData = restaurantId ? restDataMap.get(restaurantId) : undefined;

    return {
      id: item['id'],
      restaurantId,
      restaurantName: item['restaurantName'],
      city: item['city'] || null,
      issueTypes: item['issueTypes'] || [],
      description: item['description'] || null,
      suggestedLocation: item['suggestedLocation'] || null,
      identityId,
      status: item['status'],
      createdAt: item['createdAt'],
      resolvedAt: item['resolvedAt'] || null,
      // 补充：用户基本信息
      userEmail: profile?.['email'] ?? null,
      userDisplayName: profile?.['displayName'] ?? null,
      // 补充：关联视频 ID 数组
      postRefs: toStringArray(restData?.['postRefs']),
      // 补充：人均价格（从 POST 记录取）
      priceHint: restaurantId ? (priceHintMap.get(restaurantId) ?? null) : null,
      // 补充：处理留痕（来自 REST 记录）
      adminStatus: restData?.['adminStatus'] || null,
      adminReviewedAt: restData?.['adminReviewedAt'] || null,
      adminNote: restData?.['adminNote'] || null,
      // 补充：餐厅当前信息（编辑后的值）
      currentRestaurant: restData ? {
        restaurantName: restData['restaurantName'] || null,
        city: restData['city'] || null,
        address: restData['address'] || null,
        latitude: restData['latitude'] ?? null,
        longitude: restData['longitude'] ?? null,
        coordinateSource: restData['coordinateSource'] || null,
        priceHint: restaurantId ? (priceHintMap.get(restaurantId) ?? null) : null,
      } : null,
    };
  });

  return c.json({
    data: pageData,
    total,
    page,
    pageSize,
    totalPages,
  });
});

// ============================================================
// GET /reports — 违规举报聚合列表（POST + REST 合并）
// ------------------------------------------------------------
// 数据源：SHARED_TABLE 中 reportCount > 0 的 POST / REST，
//        关联读 USERS_TABLE 的 entity-type-index GSI 拉举报详情。
// 用途：运营在 admin /violations 页面手工裁定 confirm / dismiss。
// 排序：latestReportAt 降序（最新举报在前）。
// ============================================================

interface AdminReportDetail {
  identityId: string;
  category: string;
  description: string;
  createdAt: string;
}

interface AdminReportTarget {
  targetType: 'POST' | 'REST';
  targetId: string;
  targetName: string;
  reportCount: number;
  contentStatus: string | undefined;
  reports: AdminReportDetail[];
  latestReportAt: string;
}

/**
 * 举报目标 → 用户 REPORT 行的 SK（2026-10-19 修导入帖对不上）。
 *
 * 举报端（posts.ts / restaurants.ts）的写法：
 *   - POST：一律 REPORT#POST#<裸 id>——iOS 传来的帖子 id 不带前缀，posts.ts 统一补上 POST#。
 *     帖子 SK 是裸 awemeId，旧实现按 REPORT#<SK> 查 = REPORT#<awemeId>，永远查不到举报详情；更糟的是导入店的
 *     restaurantId 默认就等于 awemeId，REPORT#<awemeId> 恰好是**这家店**的举报行——
 *     驳回一条帖子举报会把店的举报行误删。
 *   - REST：REPORT#<restaurantId>（无前缀）
 */
export function reportSkForTarget(targetType: 'POST' | 'REST', targetSk: string): string {
  if (targetType === 'POST') {
    return `REPORT#${targetSk.startsWith('POST#') ? targetSk : `POST#${targetSk}`}`;
  }
  return `REPORT#${targetSk}`;
}

/**
 * 扫描 SHARED 表中 PK=pkValue 且 reportCount>0 的所有项。
 * 使用 ScanCommand + FilterExpression，因 reportCount 没有专门索引；
 * 当前 POST/REST 总量不大（22-23 条 REPORT 对应不超过 20 条 target），
 * 扫描代价可接受。后续增长后可考虑维护 GSI。
 */
async function scanTargetsWithReports(
  docClient: ReturnType<typeof getDocClient>,
  pkValue: 'POST' | 'REST',
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new ScanCommand({
      TableName: SHARED_TABLE,
      FilterExpression: 'PK = :pk AND attribute_exists(reportCount) AND reportCount > :zero',
      ExpressionAttributeValues: { ':pk': pkValue, ':zero': 0 },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (result.Items) items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/**
 * 通过 entity-type-index 反查所有举报某 target 的用户记录。
 * GSI hash key = SK = "REPORT#${targetId}"，精确匹配，O(举报次数)。
 */
async function queryReportDetails(
  docClient: ReturnType<typeof getDocClient>,
  reportSk: string,
): Promise<AdminReportDetail[]> {
  const details: AdminReportDetail[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'entity-type-index',
      KeyConditionExpression: 'SK = :sk',
      ExpressionAttributeValues: { ':sk': reportSk },
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of result.Items || []) {
      details.push({
        identityId: (item['PK'] as string) || '',
        category: (item['category'] as string) || 'other',
        description: (item['description'] as string) || '',
        createdAt: (item['createdAt'] as string) || '',
      });
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return details;
}

adminRoute.get('/reports', async (c) => {
  const docClient = getDocClient();

  const limit = Math.min(200, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
  const categoryFilter = c.req.query('category'); // 可选过滤

  // 1. 拉所有 reportCount > 0 的 POST + REST
  const [postTargets, restTargets] = await Promise.all([
    scanTargetsWithReports(docClient, 'POST'),
    scanTargetsWithReports(docClient, 'REST'),
  ]);

  // 2. 并发拉每个 target 的举报详情
  const allTargets: AdminReportTarget[] = [];

  // POST：帖子 SK=裸 awemeId，举报行一律 REPORT#POST#<裸 id>（见 reportSkForTarget）
  // 顺便拿 restaurantName 作为 targetName，没有就 fallback 到 SK
  const postReportPromises = postTargets.map(async (post) => {
    const sk = post['SK'] as string;
    const reportSk = reportSkForTarget('POST', sk);
    const reports = await queryReportDetails(docClient, reportSk);
    const latestReportAt = reports.length > 0
      ? reports.map((r) => r.createdAt).sort().reverse()[0] || ''
      : ((post['updatedAt'] as string) || '');
    return {
      targetType: 'POST' as const,
      targetId: sk,
      targetName: (post['restaurantName'] as string) || (post['title'] as string) || sk,
      reportCount: (post['reportCount'] as number) || reports.length,
      contentStatus: post['contentStatus'] as string | undefined,
      reports,
      latestReportAt,
    };
  });

  const restReportPromises = restTargets.map(async (rest) => {
    const sk = rest['SK'] as string; // restaurantId（无前缀）
    const reportSk = reportSkForTarget('REST', sk);
    const reports = await queryReportDetails(docClient, reportSk);
    const latestReportAt = reports.length > 0
      ? reports.map((r) => r.createdAt).sort().reverse()[0] || ''
      : ((rest['updatedAt'] as string) || '');
    return {
      targetType: 'REST' as const,
      targetId: sk,
      targetName: (rest['restaurantName'] as string) || sk,
      reportCount: (rest['reportCount'] as number) || reports.length,
      contentStatus: rest['contentStatus'] as string | undefined,
      reports,
      latestReportAt,
    };
  });

  const allResults = await Promise.all([...postReportPromises, ...restReportPromises]);
  allTargets.push(...allResults);

  // 3. category 过滤（任一举报命中即保留 target）
  let filtered = allTargets;
  if (categoryFilter) {
    filtered = allTargets.filter((t) => t.reports.some((r) => r.category === categoryFilter));
  }

  // 4. 按 latestReportAt 降序
  filtered.sort((a, b) => (b.latestReportAt || '').localeCompare(a.latestReportAt || ''));

  const total = filtered.length;
  const pageItems = filtered.slice(offset, offset + limit);
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  // 响应形状与 GET /admin/restaurants 等保持一致（PaginatedResponse<T>），
  // 前端 lib/api.ts 不解包 data，直接拿到的就是数组，可 [...res.data].sort(...)。
  return c.json({
    data: pageItems,
    total,
    page,
    pageSize: limit,
    totalPages,
  });
});

// ============================================================
// POST /reports/:targetType/:targetId/action — 运营手工裁定举报
// ------------------------------------------------------------
// Body: { action: 'confirm' | 'dismiss' }
//   confirm → SET contentStatus='rejected'（POST 直接隐藏；REST 隐藏所有 postRefs）
//   dismiss → reportCount 清零（不动 contentStatus），允许该 target 重新被举报
// ============================================================

adminRoute.post('/reports/:targetType/:targetId/action', async (c) => {
  const docClient = getDocClient();
  const targetTypeParam = c.req.param('targetType');
  const targetId = c.req.param('targetId');

  if (targetTypeParam !== 'POST' && targetTypeParam !== 'REST') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'targetType 必须是 POST 或 REST' },
    }, 400);
  }
  const targetType = targetTypeParam as 'POST' | 'REST';

  const body = await c.req.json<{ action: string }>();
  const action = body.action;
  if (action !== 'confirm' && action !== 'dismiss') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'action 必须是 confirm 或 dismiss' },
    }, 400);
  }

  // 校验 target 存在
  const targetItem = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: targetType, SK: targetId },
  }));
  if (!targetItem.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: `${targetType} ${targetId} 不存在` },
    }, 404);
  }

  const now = new Date().toISOString();
  const affectedPostIds: string[] = [];

  if (action === 'confirm') {
    // 主动确认违规 → 隐藏
    if (targetType === 'POST') {
      await docClient.send(new UpdateCommand({
        TableName: SHARED_TABLE,
        Key: { PK: 'POST', SK: targetId },
        UpdateExpression: 'SET contentStatus = :status, updatedAt = :now',
        ExpressionAttributeValues: { ':status': 'rejected', ':now': now },
      }));
      affectedPostIds.push(targetId);
    } else {
      // REST：批量隐藏所有 postRefs
      const postRefs = toStringArray(targetItem.Item['postRefs']);
      for (const postRef of postRefs) {
        try {
          await docClient.send(new UpdateCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'POST', SK: postRef },
            UpdateExpression: 'SET contentStatus = :status, updatedAt = :now',
            ExpressionAttributeValues: { ':status': 'rejected', ':now': now },
            ConditionExpression: 'attribute_exists(PK)',
          }));
          affectedPostIds.push(postRef);
        } catch (err: unknown) {
          if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        }
      }
      // REST 自身也打一个 contentStatus（便于后续筛选）
      await docClient.send(new UpdateCommand({
        TableName: SHARED_TABLE,
        Key: { PK: 'REST', SK: targetId },
        UpdateExpression: 'SET contentStatus = :status, updatedAt = :now',
        ExpressionAttributeValues: { ':status': 'rejected', ':now': now },
      }));
    }

    console.log(`[admin/reports] confirm ${targetType} ${targetId} → rejected, postCount=${affectedPostIds.length}`);

    return c.json({
      data: {
        success: true,
        action: 'confirm',
        targetType,
        targetId,
        affectedPostIds,
      },
    });
  }

  // action === 'dismiss' → reportCount 清零，不改 contentStatus
  await docClient.send(new UpdateCommand({
    TableName: SHARED_TABLE,
    Key: { PK: targetType, SK: targetId },
    UpdateExpression: 'SET reportCount = :zero, updatedAt = :now',
    ExpressionAttributeValues: { ':zero': 0, ':now': now },
  }));

  // 同步清理 USERS_TABLE 中所有对应 REPORT 行（防止 posts.ts:427-434 / restaurants.ts 的
  // 防重检查永远拦截该用户对同一 target 的二次举报）。
  // dismiss 语义 = 运营判定无效 → 重置举报状态 → 允许用户重新举报。
  //
  // REPORT 行 SK 格式（见 reportSkForTarget）：
  //   POST → REPORT#POST#<裸 id>（导入帖 targetId 是裸 awemeId，也要补 POST# 前缀）
  //   REST → REPORT#${restaurantId}（无前缀）
  const reportSk = reportSkForTarget(targetType, targetId);
  let deletedCount = 0;
  try {
    // 通过 entity-type-index 反查所有举报这条 target 的 PK（identityId）
    const reporterIds: string[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const queryResult = await docClient.send(new QueryCommand({
        TableName: USERS_TABLE,
        IndexName: 'entity-type-index',
        KeyConditionExpression: 'SK = :sk',
        ExpressionAttributeValues: { ':sk': reportSk },
        ProjectionExpression: 'PK',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      for (const item of queryResult.Items || []) {
        const pk = item['PK'] as string;
        if (pk) reporterIds.push(pk);
      }
      lastKey = queryResult.LastEvaluatedKey;
    } while (lastKey);

    // BatchWrite 每批最多 25 个，超过分批
    for (let i = 0; i < reporterIds.length; i += 25) {
      const batch = reporterIds.slice(i, i + 25);
      const deleteRequests = batch.map((pk) => ({
        DeleteRequest: { Key: { PK: pk, SK: reportSk } },
      }));
      await docClient.send(new BatchWriteCommand({
        RequestItems: {
          [USERS_TABLE]: deleteRequests,
        },
      }));
      deletedCount += batch.length;
    }
  } catch (err) {
    // 防御性：清理失败不阻塞主流程（reportCount 已清零，dismiss 主语义已生效）。
    // 仅记录告警，留待后续巡检兜底。
    console.error(`[admin/reports] dismiss cleanup failed for ${targetType} ${targetId}:`, err);
  }

  console.log(`[admin/reports] dismiss ${targetType} ${targetId} → reportCount=0, deletedReports=${deletedCount}`);

  return c.json({
    data: {
      success: true,
      action: 'dismiss',
      targetType,
      targetId,
      deletedReports: deletedCount,
    },
  });
});
