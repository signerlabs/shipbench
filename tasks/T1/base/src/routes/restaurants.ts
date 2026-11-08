/**
 * 餐厅路由
 *
 * GET  /              — 获取用户餐厅列表（支持 city、influencerUid、bookmarked 筛选）
 * POST /:id/bookmark  — 收藏/取消收藏餐厅（App 2026-10-21 起叫「稍后去吃」）
 * POST /:id/taste     — 好吃 / 不好吃（2026-10-21，二选一，可取消）
 */

import { Hono } from 'hono';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { identityMiddleware, getIdentity, requireWriteAuth, requireSignedIn } from '../middleware/auth.js';
import { rejectBannedWrites } from '../middleware/ban.js';
import { ugcRemoved } from '../middleware/ugcGate.js';
import { getDocClient, USERS_TABLE, SHARED_TABLE } from '../lib/dynamodb.js';
import { eventBus } from '../lib/event-bus.js';
import type { PlaceDetails } from '../lib/place-extras.js';
import { toPlaceInfo } from '../lib/place-info.js';

/** 从 shared 表批量获取 REST 数据（每批最多 100 条，自动重试 UnprocessedKeys） */
async function batchGetSharedRests(
  docClient: ReturnType<typeof getDocClient>,
  restaurantIds: string[],
): Promise<Record<string, unknown>[]> {
  const BATCH_SIZE = 100;
  const results: Record<string, unknown>[] = [];

  for (let i = 0; i < restaurantIds.length; i += BATCH_SIZE) {
    const batch = restaurantIds.slice(i, i + BATCH_SIZE);
    let keys = batch.map(rid => ({ PK: 'REST', SK: rid }));

    while (keys.length > 0) {
      const res = await docClient.send(new BatchGetCommand({
        RequestItems: { [SHARED_TABLE]: { Keys: keys } },
      }));
      if (res.Responses?.[SHARED_TABLE]) {
        results.push(...res.Responses[SHARED_TABLE]);
      }
      const unprocessed = res.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
      if (unprocessed && unprocessed.length > 0) {
        keys = unprocessed as typeof keys;
      } else {
        break;
      }
    }
  }

  return results;
}

/** 店铺地图详情（placeDetails，2026-10-22 起存）列表不下发：几千家店都带上会把城市列表撑大好几倍；
 * 详情页进店时单独取（GET /:id/place，1.3.0 起） */
function withoutPlaceDetails(r: Record<string, unknown>): Record<string, unknown> {
  const { placeDetails: _placeDetails, ...rest } = r;
  return rest;
}

type Taste = 'tasty' | 'untasty';

/**
 * 当前用户对店的个人状态：收藏（users 表 REST# 行的 bookmarked）与好吃 / 不好吃（TASTE# 行，2026-10-21）。
 * 列表接口据此给每家店带上 bookmarked 与 myTaste。
 */
async function loadUserRestStates(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
): Promise<{ bookmarks: Set<string>; tastes: Map<string, Taste> }> {
  const queryAll = async (prefix: string, projection: string) => {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await docClient.send(new QueryCommand({
        TableName: USERS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': identityId, ':sk': prefix },
        ProjectionExpression: projection,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(res.Items ?? []));
      lastKey = res.LastEvaluatedKey;
    } while (lastKey);
    return items;
  };
  const [restRows, tasteRows] = await Promise.all([
    queryAll('REST#', 'restaurantId, bookmarked'),
    queryAll('TASTE#', 'restaurantId, taste'),
  ]);
  const bookmarks = new Set<string>();
  for (const item of restRows) {
    if (item['bookmarked']) bookmarks.add(item['restaurantId'] as string);
  }
  const tastes = new Map<string, Taste>();
  for (const item of tasteRows) {
    const t = item['taste'];
    if (t === 'tasty' || t === 'untasty') tastes.set(item['restaurantId'] as string, t);
  }
  return { bookmarks, tastes };
}

export const restaurantsRoute = new Hono();

// 所有路由需要 Identity ID
restaurantsRoute.use('*', identityMiddleware);
// 写请求验签（默认软兼容放行，ENFORCE_WRITE_AUTH=true 时强制 JWT）
restaurantsRoute.use('*', requireWriteAuth);
// 被封禁的身份不能建店 / 收藏 / 回写坐标 / 反馈 / 举报（读不拦）
restaurantsRoute.use('*', rejectBannedWrites);

// ============================================================
// POST / — 创建小店：用户自建 10/19 停用、10/22 数据已彻底删除
// 旧版 App（1.2.8）还有入口，只回 403 UGC_DISABLED
// ============================================================

restaurantsRoute.post('/', ugcRemoved);

// ============================================================
// GET / — 获取用户餐厅列表
// ============================================================

restaurantsRoute.get('/', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const city = c.req.query('city');
  const influencerUid = c.req.query('influencerUid'); // 支持逗号分隔多个
  const bookmarked = c.req.query('bookmarked');

  // 筛选方式一：按城市 — 从 shared 表查完整餐厅数据，合并用户 bookmarked 状态
  if (city) {
    // 1. 从 shared 表 city-index 查该城市所有餐厅
    const allItems: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: SHARED_TABLE,
        IndexName: 'city-index',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CITY#${city}`,
          ':sk': 'REST#',
        },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      if (result.Items) allItems.push(...result.Items);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    // 2. 批量查用户的收藏与好吃 / 不好吃
    const { bookmarks: userBookmarks, tastes } = await loadUserRestStates(docClient, identityId);

    // 3. 合并返回（restaurantId 优先使用实体字段，SK 兜底）
    // 2026-05-16 软关店标记：iOS 用户端默认隐藏 permanentlyClosed=true 的小店（admin 已标记闭店）
    // 2026-10-24 第三层（rescueStatus=owner，人工也没找准的店）也先藏起来；后台定下这家、清掉 rescueStatus 就自动回来
    return c.json({
      data: allItems
        .filter((r) => r['permanentlyClosed'] !== true && r['rescueStatus'] !== 'owner')
        .map(r => {
          const restaurantId = (r['restaurantId'] ?? r['SK']) as string;
          return { ...withoutPlaceDetails(r), restaurantId, bookmarked: userBookmarks.has(restaurantId), myTaste: tastes.get(restaurantId) ?? null };
        }),
    });
  }

  // 筛选方式二：按达人 — 从 shared 表查达人关联的餐厅，合并用户 bookmarked 状态
  if (influencerUid) {
    const uids = influencerUid.split(',').map((u) => u.trim()).filter(Boolean);

    // 1. 从 shared 表 influencer-filter-index 并行查询每个达人的餐厅 RI
    const riQueries = uids.map((uid) =>
      docClient.send(new QueryCommand({
        TableName: SHARED_TABLE,
        IndexName: 'influencer-filter-index',
        KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `INF#${uid}`,
          ':sk': 'REST#',
        },
      })),
    );
    const riResults = await Promise.all(riQueries);

    // 2. 收集 restaurantId 去重
    const restaurantIds = new Set<string>();
    for (const result of riResults) {
      for (const item of result.Items || []) {
        const rid = item['restaurantId'] as string;
        if (rid) restaurantIds.add(rid);
      }
    }

    if (restaurantIds.size === 0) {
      return c.json({ data: [] });
    }

    // 3. 从 shared 表批量获取完整餐厅数据
    const restaurants = await batchGetSharedRests(docClient, Array.from(restaurantIds));

    // 4. 查用户的收藏与好吃 / 不好吃
    const { bookmarks: userBookmarks, tastes } = await loadUserRestStates(docClient, identityId);

    // 2026-05-16 软关店标记：iOS 用户端默认隐藏 permanentlyClosed=true 的小店；2026-10-24 第三层的店也先藏起来
    return c.json({
      data: restaurants
        .filter((r) => r!['permanentlyClosed'] !== true && r!['rescueStatus'] !== 'owner')
        .map(r => {
          const restaurantId = (r!['restaurantId'] ?? r!['SK']) as string;
          return { ...withoutPlaceDetails(r!), restaurantId, bookmarked: userBookmarks.has(restaurantId), myTaste: tastes.get(restaurantId) ?? null };
        }),
    });
  }

  // 筛选方式三：按收藏
  // 先从 GSI3 获取收藏的 restaurantId，再从 shared 表取完整数据
  if (bookmarked === 'true') {
    const result = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'bookmark-index',
      KeyConditionExpression: 'GSI3PK = :pk AND begins_with(GSI3SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `${identityId}#BOOKMARK`,
        ':sk': 'REST#',
      },
      ProjectionExpression: 'restaurantId',
    }));

    const restaurantIds = (result.Items || [])
      .map(item => item['restaurantId'] as string)
      .filter(Boolean);

    if (restaurantIds.length === 0) {
      return c.json({ data: [] });
    }

    // 从 shared 表批量获取完整餐厅数据，标记 bookmarked=true
    const [restaurants, { tastes }] = await Promise.all([
      batchGetSharedRests(docClient, restaurantIds),
      loadUserRestStates(docClient, identityId),
    ]);

    // 2026-05-16 软关店标记：iOS 用户端默认隐藏 permanentlyClosed=true 的小店
    // 收藏分支特殊处理：即便用户收藏过的店现在闭店了，也不再展示；2026-10-24 第三层的店也先藏起来（收藏记录不动）
    return c.json({
      data: restaurants
        .filter((r) => r['permanentlyClosed'] !== true && r['rescueStatus'] !== 'owner')
        .map(r => {
          const restaurantId = (r['restaurantId'] ?? r['SK']) as string;
          return { ...withoutPlaceDetails(r), restaurantId, bookmarked: true, myTaste: tastes.get(restaurantId) ?? null };
        }),
    });
  }

  // 筛选方式四：按 restaurantIds 批量查（Feed 预加载用）
  const restaurantIdsParam = c.req.query('restaurantIds');
  if (restaurantIdsParam) {
    const ids = restaurantIdsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) return c.json({ data: [] });
    if (ids.length > 50) {
      return c.json({ error: { code: 'TOO_MANY_IDS', message: '最多 50 个' } }, 400);
    }

    const [{ bookmarks: userBookmarks, tastes }, restaurants] = await Promise.all([
      loadUserRestStates(docClient, identityId),
      batchGetSharedRests(docClient, ids),
    ]);
    return c.json({
      data: restaurants
        .filter((r) => r['permanentlyClosed'] !== true && r['rescueStatus'] !== 'owner')
        .map(r => {
          const restaurantId = (r['restaurantId'] ?? r['SK']) as string;
          return { ...withoutPlaceDetails(r), restaurantId, bookmarked: userBookmarks.has(restaurantId), myTaste: tastes.get(restaurantId) ?? null };
        }),
    });
  }

  // 无筛选：必须指定 city、influencerUid、bookmarked 或 restaurantIds 参数
  return c.json({
    error: { code: 'MISSING_FILTER', message: '请指定 city、influencerUid、bookmarked 或 restaurantIds 参数' },
  }, 400);
});

// ============================================================
// GET /:id/place — 店铺地图详情（1.3.0 小店详情页改版，2026-10-27）
// ============================================================

/**
 * 详情页进店时取：照片、评分、人均、营业时间、电话、特色菜、服务项，整理成 App 直接显示的样子（lib/place-info.ts）。
 * 没有地图详情的店 data 为 null；店不存在 404。
 */
restaurantsRoute.get('/:id/place', async (c) => {
  const restaurantId = c.req.param('id');
  const res = await getDocClient().send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
    ProjectionExpression: 'placeDetails, city',
  }));
  if (!res.Item) {
    return c.json({ error: { code: 'NOT_FOUND', message: '小店不存在' } }, 404);
  }
  const pd = res.Item['placeDetails'] as PlaceDetails | undefined;
  const city = typeof res.Item['city'] === 'string' ? (res.Item['city'] as string) : undefined;
  return c.json({ data: pd ? toPlaceInfo(pd, { city }) : null });
});

// ============================================================
// POST /:id/bookmark — 收藏/取消收藏餐厅
// ============================================================

restaurantsRoute.post('/:id/bookmark', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  const body = await c.req.json<{ bookmarked: boolean }>();

  if (typeof body.bookmarked !== 'boolean') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'bookmarked 字段为必填布尔值' },
    }, 400);
  }

  const now = new Date().toISOString();

  try {
    if (body.bookmarked) {
      // 收藏：upsert — 只建立关联，不复制数据
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: `REST#${restaurantId}` },
        UpdateExpression: 'SET restaurantId = :rid, bookmarked = :bookmarked, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, updatedAt = :now',
        ExpressionAttributeValues: {
          ':rid': restaurantId,
          ':bookmarked': true,
          ':gsi3pk': `${identityId}#BOOKMARK`,
          ':gsi3sk': `REST#${restaurantId}`,
          ':now': now,
        },
      }));
    } else {
      // 取消收藏：upsert — 设置 bookmarked=false，移除 GSI3PK/GSI3SK
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: `REST#${restaurantId}` },
        UpdateExpression: 'SET restaurantId = :rid, bookmarked = :bookmarked, updatedAt = :now REMOVE GSI3PK, GSI3SK',
        ExpressionAttributeValues: {
          ':rid': restaurantId,
          ':bookmarked': false,
          ':now': now,
        },
      }));
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return c.json({
        error: { code: 'NOT_FOUND', message: '餐厅不存在' },
      }, 404);
    }
    throw err;
  }

  return c.json({
    data: { restaurantId, bookmarked: body.bookmarked },
  });
});

// ============================================================
// POST /:id/taste — 好吃 / 不好吃（2026-10-21）
// ============================================================

/**
 * 给店打「好吃」或「不好吃」，二选一；taste 为 null 或不传 = 取消。
 * 每人每店一行 users 表 TASTE#<restaurantId>（taste 字段）；REST 实体上的 tastyCount / untastyCount
 * 由 Stream 计数 Lambda 按这行的前后值异步加减（与收藏、点赞同一套，接口里不直接改计数）。
 * 响应里的两个计数是读到的当前值加上这次的改动推算出来的，供 App 立即显示。
 * 必须真登录（2026-10-27）：只有 1.3.0 调用、且已带登录凭证，不看 ENFORCE_WRITE_AUTH 开关。
 */
restaurantsRoute.post('/:id/taste', requireSignedIn, async (c) => {
  const { identityId } = getIdentity(c);
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  const body = await c.req.json<{ taste?: unknown }>().catch(() => ({} as { taste?: unknown }));
  const raw = body.taste ?? null;
  if (raw !== null && raw !== 'tasty' && raw !== 'untasty') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'taste 只能是 tasty、untasty 或 null' },
    }, 400);
  }
  const taste = raw as Taste | null;

  const rest = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'REST', SK: restaurantId },
    ProjectionExpression: 'PK, tastyCount, untastyCount',
  }));
  if (!rest.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '餐厅不存在' },
    }, 404);
  }

  const key = { PK: identityId, SK: `TASTE#${restaurantId}` };
  const now = new Date().toISOString();
  const res = taste
    ? await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: key,
      UpdateExpression: 'SET restaurantId = :rid, taste = :t, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':rid': restaurantId, ':t': taste, ':now': now },
      ReturnValues: 'ALL_OLD',
    }))
    : await docClient.send(new DeleteCommand({
      TableName: USERS_TABLE,
      Key: key,
      ReturnValues: 'ALL_OLD',
    }));
  const old = res.Attributes?.['taste'];
  const previous: Taste | null = old === 'tasty' || old === 'untasty' ? old : null;

  let tastyCount = Number(rest.Item['tastyCount'] ?? 0);
  let untastyCount = Number(rest.Item['untastyCount'] ?? 0);
  if (previous !== taste) {
    if (previous === 'tasty') tastyCount -= 1;
    if (previous === 'untasty') untastyCount -= 1;
    if (taste === 'tasty') tastyCount += 1;
    if (taste === 'untasty') untastyCount += 1;
  }

  return c.json({
    data: { restaurantId, taste, tastyCount: Math.max(0, tastyCount), untastyCount: Math.max(0, untastyCount) },
  });
});

// ============================================================
// POST /:id/issue — 报告餐厅问题
// ============================================================

/** 待处理的「已关门」反馈来自至少几个不同的人，就先下架（2026-10-20 产品负责人定） */
const AUTO_CLOSE_MIN_REPORTERS = 2;

/**
 * 两位用户都报「已关门」→ 先下架（permanentlyClosed + closedByReportsAt），反馈保持 pending，
 * 由后台在「反馈与待补全」里确认关门（结掉反馈）或恢复上架。店不存在或已下架就什么都不做。
 */
async function autoCloseIfReportedClosed(
  docClient: ReturnType<typeof getDocClient>,
  restaurantId: string,
  now: string,
): Promise<boolean> {
  const reporters = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: 'restaurantId = :rid AND #st = :pending AND contains(issueTypes, :closed)',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':pk': 'ISSUE', ':rid': restaurantId, ':pending': 'pending', ':closed': 'closed' },
      ProjectionExpression: 'identityId',
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));
    for (const it of res.Items ?? []) {
      if (typeof it['identityId'] === 'string') reporters.add(it['identityId'] as string);
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  if (reporters.size < AUTO_CLOSE_MIN_REPORTERS) return false;
  try {
    await docClient.send(new UpdateCommand({
      TableName: SHARED_TABLE,
      Key: { PK: 'REST', SK: restaurantId },
      UpdateExpression: 'SET permanentlyClosed = :t, closedByReportsAt = :now, closedByReports = :n, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(permanentlyClosed) OR permanentlyClosed = :f)',
      ExpressionAttributeValues: { ':t': true, ':f': false, ':now': now, ':n': reporters.size },
    }));
    console.log(`[issue] ${restaurantId} 已有 ${reporters.size} 位用户报关门，先下架，等后台确认`);
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** 合法的问题类型 */
const VALID_ISSUE_TYPES = new Set([
  'location_incorrect',
  'name_incorrect',
  'price_incorrect',  // 2026-10-21 起新版 App 不再给这一项，旧版仍可能提交
  'closed',
  'not_xiaodian',     // 不是小店（2026-10-21 举报并进反馈）
  'inappropriate',    // 内容违规：色情、广告、人身攻击等（同上，原举报分类合成这一项）
  'other',
]);

restaurantsRoute.post('/:id/issue', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  const body = await c.req.json<{
    issueTypes: string[];
    description?: string;
    suggestedLocation?: { latitude: number; longitude: number };
    restaurantName: string;
    city?: string;
  }>();

  // 验证 issueTypes
  if (!Array.isArray(body.issueTypes) || body.issueTypes.length === 0) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'issueTypes 不能为空' },
    }, 400);
  }
  for (const t of body.issueTypes) {
    if (!VALID_ISSUE_TYPES.has(t)) {
      return c.json({
        error: { code: 'INVALID_INPUT', message: `无效的问题类型: ${t}` },
      }, 400);
    }
  }

  // 验证 restaurantName
  if (!body.restaurantName || typeof body.restaurantName !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'restaurantName 为必填' },
    }, 400);
  }

  // 验证 suggestedLocation（如果提供）
  if (body.suggestedLocation) {
    if (
      typeof body.suggestedLocation.latitude !== 'number' ||
      typeof body.suggestedLocation.longitude !== 'number'
    ) {
      return c.json({
        error: { code: 'INVALID_INPUT', message: 'suggestedLocation 的 latitude 和 longitude 必须为数值' },
      }, 400);
    }
  }

  const now = new Date().toISOString();
  const reportId = crypto.randomUUID();

  await docClient.send(new PutCommand({
    TableName: SHARED_TABLE,
    Item: {
      PK: 'ISSUE',
      SK: `${now}#${reportId}`,
      id: reportId,
      restaurantId,
      restaurantName: body.restaurantName,
      ...(body.city && { city: body.city }),
      identityId,
      issueTypes: body.issueTypes,
      ...(body.description && { description: body.description }),
      ...(body.suggestedLocation && { suggestedLocation: body.suggestedLocation }),
      status: 'pending',
      createdAt: now,
    },
  }));

  // 报「已关门」的：两位不同的用户都报了就先下架（失败不影响反馈提交）
  if (body.issueTypes.includes('closed')) {
    try {
      await autoCloseIfReportedClosed(docClient, restaurantId, now);
    } catch (err) {
      console.warn('[issue] 关门自动下架检查失败（不影响反馈提交）:', err);
    }
  }

  // 广播用户反馈事件（不阻塞响应）
  eventBus.emit('issue-submitted', {
    restaurantId,
    restaurantName: body.restaurantName,
    city: body.city || '',
    issueTypes: body.issueTypes,
    description: body.description || '',
    identityId,
    timestamp: now,
  });

  return c.json({ data: { success: true, reportId } });
});

// ============================================================
// POST /:id/location-failed — iOS 端标记位置解析失败（已废弃，no-op）
// ============================================================
//
// 2026-05-16 起 locationFailed 字段已废弃，所有"需要人工处理"语义统一收敛到
// needsManualReview。端点本身保留接收，仅为兼容老 iOS 客户端不出现 404，
// 写库行为已清空、SSE 广播已移除。
//
// 历史背景：老 iOS 在 MKLocalSearch 解析失败时会调本端点，将 REST 标记为
// locationFailed=true。新方案不再依赖该字段 —— 流水线在写入时已决定
// needsManualReview，由后台处理，本端点已无业务意义。
// 2026-10-21：iOS 用苹果地图补坐标后回写的 POST /:id/location 已删除（7/6 以后没再写过一条；
// 纯代理模式拿不准的店不上地图、交后台，不再收客户端猜的坐标）。老版本调它得到 404，客户端本就忽略失败。

restaurantsRoute.post('/:id/location-failed', async (c) => {
  const restaurantId = c.req.param('id');
  // no-op：不写库、不广播。返回 200 维持老 iOS 调用契约。
  return c.json({
    data: { restaurantId, ok: true },
  });
});

// ============================================================
// POST /:id/report — 举报餐厅
// ============================================================

/** 合法的举报分类（与前端 ReportCategory 枚举一致） */
const VALID_REPORT_CATEGORIES = new Set([
  'pornography',        // 色情低俗
  'violence',           // 暴力血腥
  'false_info',         // 虚假信息
  'spam',               // 恶意广告/垃圾信息
  'personal_attack',    // 人身攻击
  'other',              // 其他
]);

restaurantsRoute.post('/:id/report', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const restaurantId = c.req.param('id');
  const docClient = getDocClient();

  const body = await c.req.json<{
    category: string;
    description?: string;
  }>();

  // 验证举报分类
  if (!body.category || !VALID_REPORT_CATEGORIES.has(body.category)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: '无效的举报分类' },
    }, 400);
  }

  const now = new Date().toISOString();

  // 1. 写入 users 表 REPORT#restId（记录举报关系）。
  // 条件写防重复举报：旧实现「先查再写」，同一用户并发举报会两次都过检查、计数 +2
  try {
    await docClient.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        PK: identityId,
        SK: `REPORT#${restaurantId}`,
        restaurantId,
        category: body.category,
        ...(body.description && { description: body.description }),
        createdAt: now,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    return c.json({
      error: { code: 'ALREADY_REPORTED', message: '你已经举报过这家店了' },
    }, 400);
  }

  // 2. 原子递增 shared 表 REST 实体的 reportCount。
  // attribute_exists 防幽灵行：店不存在（已合并 / 删除）时无条件 ADD 会凭空建出只有 reportCount 的 REST 空壳
  let updateResult;
  try {
    updateResult = await docClient.send(new UpdateCommand({
      TableName: SHARED_TABLE,
      Key: { PK: 'REST', SK: restaurantId },
      UpdateExpression: 'ADD reportCount :inc SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':inc': 1, ':now': now },
      ReturnValues: 'UPDATED_NEW',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // 店不存在：撤回刚写的举报行，免得它挡住以后的举报
    await docClient.send(new DeleteCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: `REPORT#${restaurantId}` },
    }));
    return c.json({
      error: { code: 'NOT_FOUND', message: '餐厅不存在' },
    }, 404);
  }

  const newReportCount = (updateResult.Attributes?.['reportCount'] as number) || 0;

  // 注意（2026-05-16 起）：餐厅举报不再自动改动其 postRefs 的 contentStatus，
  // 仅累加 REST.reportCount。是否隐藏由运营在 admin /violations 页面手工裁定，
  // 调用 POST /admin/reports/REST/:targetId/action 决定 confirm（隐藏整组 POST）或 dismiss（驳回）。

  return c.json({
    data: {
      success: true,
      restaurantId,
      reportCount: newReportCount,
    },
  });
});
