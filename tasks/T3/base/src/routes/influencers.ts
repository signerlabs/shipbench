/**
 * 达人路由
 *
 * GET  /              — 获取用户的达人列表
 * POST /:id/bookmark  — 收藏/取消收藏达人
 */

import { Hono } from 'hono';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { identityMiddleware, getIdentity, requireWriteAuth } from '../middleware/auth.js';
import { rejectBannedWrites } from '../middleware/ban.js';
import { getDocClient, USERS_TABLE, SHARED_TABLE } from '../lib/dynamodb.js';

export const influencersRoute = new Hono();

// 所有路由需要 Identity ID
influencersRoute.use('*', identityMiddleware);
// 写请求验签（默认软兼容放行，ENFORCE_WRITE_AUTH=true 时强制 JWT）
influencersRoute.use('*', requireWriteAuth);
// 被封禁的身份不能关注（读不拦）
influencersRoute.use('*', rejectBannedWrites);

// ============================================================
// GET / — 获取用户的达人列表
// ============================================================

influencersRoute.get('/', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  // 并行查询用户自己的达人列表和 shared 表的全局统计
  const queryUserInfluencers = async () => {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: USERS_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': identityId, ':sk': 'INFLUENCER#' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
  };

  const querySharedInfluencers = async () => {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await docClient.send(new QueryCommand({
        TableName: SHARED_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': 'INFLUENCER' },
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
  };

  const [userItems, sharedItems] = await Promise.all([
    queryUserInfluencers(),
    querySharedInfluencers(),
  ]);

  // 构建 shared 表索引: influencerUid → 全局数据（基本信息 + 统计）
  const sharedMap = new Map<string, Record<string, unknown>>();
  for (const item of sharedItems) {
    const uid = item['influencerUid'] as string;
    sharedMap.set(uid, item);
  }

  const influencers = userItems.map((item) => {
    // 关注关系存的就是推荐者的抖音 uid（公开信息）
    const uid = item['influencerUid'] as string;
    const shared = sharedMap.get(uid);
    return {
      influencerUid: uid,
      influencerName: shared?.['influencerName'] || null,
      influencerAvatar: shared?.['influencerAvatar'] || null,
      // 抖音签名不再下发（2026-10-28 苹果 5.2.3 整改；App 没有签名就不显示）
      postCount: (shared?.['postCount'] as number) || 0,
      restaurantCount: (shared?.['restaurantCount'] as number) || 0,
      cityCount: shared?.['cities'] ? (shared['cities'] as Set<string>).size : 0,
      bookmarked: item['bookmarked'] || false,
    };
  });

  return c.json({
    data: influencers,
  });
});

// ============================================================
// POST /:id/bookmark — 收藏/取消收藏达人
// ============================================================

influencersRoute.post('/:id/bookmark', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  // 推荐者都是导入的抖音博主，id 就是抖音 uid（用户自建作者 10/22 已随自建内容彻底删除）
  const influencerUid = c.req.param('id');
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
      // 关注：薄引用，只写 influencerUid + bookmarked + GSI3
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: `INFLUENCER#${influencerUid}` },
        UpdateExpression: 'SET influencerUid = :uid, bookmarked = :bookmarked, GSI3PK = :gsi3pk, GSI3SK = :gsi3sk, updatedAt = :now',
        ExpressionAttributeValues: {
          ':uid': influencerUid,
          ':bookmarked': true,
          ':gsi3pk': `${identityId}#BOOKMARK`,
          ':gsi3sk': `INFLUENCER#${influencerUid}`,
          ':now': now,
        },
      }));
    } else {
      // 取消关注：upsert — 设置 bookmarked=false，移除 GSI3PK/GSI3SK
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: `INFLUENCER#${influencerUid}` },
        UpdateExpression: 'SET influencerUid = :uid, bookmarked = :bookmarked, updatedAt = :now REMOVE GSI3PK, GSI3SK',
        ExpressionAttributeValues: {
          ':uid': influencerUid,
          ':bookmarked': false,
          ':now': now,
        },
      }));
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return c.json({
        error: { code: 'NOT_FOUND', message: '达人不存在' },
      }, 404);
    }
    throw err;
  }

  return c.json({
    data: { influencerUid, bookmarked: body.bookmarked },
  });
});
