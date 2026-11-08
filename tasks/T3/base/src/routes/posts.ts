/**
 * 帖子路由
 *
 * GET  /  — 获取帖子列表（从 shared 表读取，支持 city、restaurantId、restaurantIds 筛选）
 *
 * Phase 5: 帖子数据完全从 shared 表读取，users 表不再存 POST#
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
import { identityMiddleware, getIdentity, requireWriteAuth } from '../middleware/auth.js';
import { rejectBannedWrites } from '../middleware/ban.js';
import { ugcRemoved } from '../middleware/ugcGate.js';
import { getDocClient, SHARED_TABLE, USERS_TABLE, toStringArray } from '../lib/dynamodb.js';
import { processPostsForResponse } from '../lib/post-utils.js';

export const postsRoute = new Hono();

// 所有路由需要 Identity ID
postsRoute.use('*', identityMiddleware);

/** 帖子 SK 就是 awemeId；带 POST# 前缀传来的去掉（iOS 传的本来就不带） */
function resolvePostSK(rawPostId: string): string {
  return rawPostId.replace(/^POST#/, '');
}
// 写请求验签（默认软兼容放行，ENFORCE_WRITE_AUTH=true 时强制 JWT）
postsRoute.use('*', requireWriteAuth);
// 被封禁的身份不能发帖 / 点赞 / 举报（读不拦）
postsRoute.use('*', rejectBannedWrites);

/**
 * restaurantIds 批量查帖的数量上限（审查 MEDIUM 32，与 GET /v1/restaurants?restaurantIds= 一致）。
 *
 * 只有 ENFORCE_POSTS_IDS_LIMIT=true 时才拒绝超限请求：线上 1.2.8（以及当前 iOS 工作区）会把
 * **整座城市**的店 ID、全部收藏的店 ID 一次塞进这个参数，北京这类城市远超 50 家，立刻硬限会让
 * 这些城市的地图一个店都不显示（iOS 端 try? 吞错回落空数组）。iOS 改为每批 ≤50 分批请求并发版
 * 渗透后，再在 CDK 把开关置 true。开关关闭期间超限只打日志，便于观察存量请求规模。
 */
const MAX_RESTAURANT_IDS = 50;

function isEnforcePostsIdsLimit(): boolean {
  return (process.env.ENFORCE_POSTS_IDS_LIMIT || 'false').toLowerCase() === 'true';
}

/**
 * 从 shared 表按 restaurantId 获取 postRefs，再 BatchGet shared POST
 */
async function getPostsByRestaurantIds(restaurantIds: string[]): Promise<Record<string, unknown>[]> {
  if (restaurantIds.length === 0) return [];

  const docClient = getDocClient();

  // 1. BatchGet shared REST 读取 postRefs（每批 100 条）
  const BATCH_SIZE = 100;
  const awemeIdSet = new Set<string>();

  for (let i = 0; i < restaurantIds.length; i += BATCH_SIZE) {
    const batch = restaurantIds.slice(i, i + BATCH_SIZE);
    let keys = batch.map(rid => ({ PK: 'REST', SK: rid }));

    while (keys.length > 0) {
      const res = await docClient.send(new BatchGetCommand({
        RequestItems: { [SHARED_TABLE]: { Keys: keys, ProjectionExpression: 'postRefs' } },
      }));
      for (const item of res.Responses?.[SHARED_TABLE] ?? []) {
        for (const ref of toStringArray(item['postRefs'])) awemeIdSet.add(ref);
      }
      const unprocessed = res.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
      keys = (unprocessed && unprocessed.length > 0) ? unprocessed as typeof keys : [];
    }
  }

  if (awemeIdSet.size === 0) return [];

  // 2. BatchGet shared POST
  return batchGetSharedPosts(Array.from(awemeIdSet));
}

/**
 * BatchGet shared 表 POST 记录
 * DynamoDB BatchGetItem 每次最多 100 个 key
 */
async function batchGetSharedPosts(awemeIds: string[]): Promise<Record<string, unknown>[]> {
  if (awemeIds.length === 0) return [];

  const docClient = getDocClient();
  const BATCH_SIZE = 100;
  const allItems: Record<string, unknown>[] = [];

  for (let i = 0; i < awemeIds.length; i += BATCH_SIZE) {
    const batch = awemeIds.slice(i, i + BATCH_SIZE);
    const keys = batch.map((id) => ({ PK: 'POST', SK: id }));

    const result = await docClient.send(new BatchGetCommand({
      RequestItems: {
        [SHARED_TABLE]: { Keys: keys },
      },
    }));

    const items = result.Responses?.[SHARED_TABLE] || [];
    allItems.push(...items);

    // 处理未处理的 key（DynamoDB 可能因容量限制返回部分结果）
    let unprocessed = result.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
    while (unprocessed && unprocessed.length > 0) {
      const retryResult = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [SHARED_TABLE]: { Keys: unprocessed },
        },
      }));
      const retryItems = retryResult.Responses?.[SHARED_TABLE] || [];
      allItems.push(...retryItems);
      unprocessed = retryResult.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
    }
  }

  return allItems;
}

// ============================================================
// POST / — 补充推荐：用户自建 10/19 停用、10/22 数据已彻底删除
// 旧版 App（1.2.8）还有入口，只回 403 UGC_DISABLED
// ============================================================

postsRoute.post('/', ugcRemoved);

// ============================================================
// POST /:id/like — 点赞帖子
// ============================================================

postsRoute.post('/:id/like', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const rawPostId = c.req.param('id');
  const docClient = getDocClient();
  const resolvedSK = resolvePostSK(rawPostId);
  const likeSK = `LIKE#${resolvedSK}`;
  const now = new Date().toISOString();

  const existing = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: likeSK },
  }));
  if (existing.Item) {
    const postResult = await docClient.send(new GetCommand({
      TableName: SHARED_TABLE,
      Key: { PK: 'POST', SK: resolvedSK },
      ProjectionExpression: 'postLikeCount',
    }));
    const postLikeCount = (postResult.Item?.['postLikeCount'] as number) || 0;
    return c.json({ data: { liked: true, postLikeCount } });
  }

  await docClient.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: { PK: identityId, SK: likeSK, postId: resolvedSK, createdAt: now },
  }));

  const postResult = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'POST', SK: resolvedSK },
    ProjectionExpression: 'postLikeCount',
  }));
  const currentCount = (postResult.Item?.['postLikeCount'] as number) || 0;

  return c.json({ data: { liked: true, postLikeCount: currentCount + 1 } });
});

// ============================================================
// DELETE /:id/like — 取消点赞帖子
// ============================================================

postsRoute.delete('/:id/like', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const rawPostId = c.req.param('id');
  const docClient = getDocClient();
  const resolvedSK = resolvePostSK(rawPostId);

  await docClient.send(new DeleteCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: `LIKE#${resolvedSK}` },
  }));

  const postResult = await docClient.send(new GetCommand({
    TableName: SHARED_TABLE,
    Key: { PK: 'POST', SK: resolvedSK },
    ProjectionExpression: 'postLikeCount',
  }));
  const currentCount = (postResult.Item?.['postLikeCount'] as number) || 0;

  return c.json({ data: { liked: false, postLikeCount: Math.max(0, currentCount - 1) } });
});

// ============================================================
// POST /:id/report — 举报帖子
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

postsRoute.post('/:id/report', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const rawPostId = c.req.param('id');
  // REPORT# 保留 POST# 前缀（与 REPORT#<restaurantId> 区分）
  const postId = rawPostId.startsWith('POST#') ? rawPostId : `POST#${rawPostId}`;
  const docClient = getDocClient();
  const resolvedSK = resolvePostSK(rawPostId);

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

  // 1. 写入 users 表 REPORT#postId（记录举报关系）。
  // 条件写防重复举报：旧实现「先查再写」，同一用户并发举报会两次都过检查、计数 +2
  try {
    await docClient.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        PK: identityId,
        SK: `REPORT#${postId}`,
        postId,
        category: body.category,
        ...(body.description && { description: body.description }),
        createdAt: now,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    return c.json({
      error: { code: 'ALREADY_REPORTED', message: '你已经举报过了' },
    }, 400);
  }

  // 2. 原子递增 shared 表 POST 实体的 reportCount（使用真实 SK）。
  // attribute_exists 防幽灵行：帖子不存在时无条件 ADD 会凭空建出只有 reportCount 的 POST 空壳
  let updateResult;
  try {
    updateResult = await docClient.send(new UpdateCommand({
      TableName: SHARED_TABLE,
      Key: { PK: 'POST', SK: resolvedSK },
      UpdateExpression: 'ADD reportCount :inc SET updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':inc': 1, ':now': now },
      ReturnValues: 'UPDATED_NEW',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // 帖子不存在：撤回刚写的举报行，免得它挡住以后的举报
    await docClient.send(new DeleteCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: `REPORT#${postId}` },
    }));
    return c.json({
      error: { code: 'NOT_FOUND', message: '帖子不存在' },
    }, 404);
  }

  const newReportCount = (updateResult.Attributes?.['reportCount'] as number) || 0;

  // 注意（2026-05-16 起）：举报不再自动改动 contentStatus，
  // 仅累加 reportCount。是否隐藏由运营在 admin /violations 页面手工裁定，
  // 调用 POST /admin/reports/POST/:targetId/action 决定 confirm（隐藏）或 dismiss（驳回）。
  // 任何单类目（包括 pornography / violence）也不再触发自动 review。

  return c.json({
    data: {
      success: true,
      postId,
      reportCount: newReportCount,
    },
  });
});

// ============================================================
// GET / — 获取帖子列表
// ============================================================

postsRoute.get('/', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const restaurantId = c.req.query('restaurantId');
  const restaurantIds = c.req.query('restaurantIds');
  const city = c.req.query('city');

  // 筛选方式一：按多个餐厅批量查询（restaurantIds，逗号分隔）
  if (restaurantIds) {
    const ids = restaurantIds.split(',').map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) {
      return c.json({
        error: { code: 'INVALID_INPUT', message: 'restaurantIds 不能为空' },
      }, 400);
    }
    if (ids.length > MAX_RESTAURANT_IDS) {
      if (isEnforcePostsIdsLimit()) {
        return c.json({ error: { code: 'TOO_MANY_IDS', message: `最多 ${MAX_RESTAURANT_IDS} 个` } }, 400);
      }
      console.warn(`[posts] restaurantIds 超过 ${MAX_RESTAURANT_IDS} 个（${ids.length} 个），开关未打开暂放行 | identityId=${identityId.slice(-12)}`);
    }

    const posts = await getPostsByRestaurantIds(ids);
    return c.json({ data: await processPostsForResponse(posts, identityId) });
  }

  // 筛选方式二：按单个餐厅
  if (restaurantId) {
    const posts = await getPostsByRestaurantIds([restaurantId]);
    return c.json({ data: await processPostsForResponse(posts, identityId) });
  }

  // 筛选方式三：按城市 — 从 shared 表 city-index 查 REST，收集 postRefs，再 BatchGet shared POST
  if (city) {
    // 从 shared 表 city-index 查该城市所有 REST 的 postRefs
    const allRests: Record<string, unknown>[] = [];
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
        ProjectionExpression: 'postRefs, rescueStatus',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      if (result.Items) allRests.push(...result.Items);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    // 收集 awemeId 去重（2026-10-24 第三层 rescueStatus=owner 的店先不给用户看，帖子也不带）
    const awemeIdSet = new Set<string>();
    for (const rest of allRests) {
      if (rest['rescueStatus'] === 'owner') continue;
      for (const ref of toStringArray(rest['postRefs'])) awemeIdSet.add(ref);
    }

    const posts = await batchGetSharedPosts(Array.from(awemeIdSet));
    return c.json({ data: await processPostsForResponse(posts, identityId) });
  }

  // 无筛选：必须指定 restaurantId、restaurantIds 或 city 参数
  return c.json({
    error: { code: 'MISSING_FILTER', message: '请指定 restaurantId、restaurantIds 或 city 参数' },
  }, 400);
});
