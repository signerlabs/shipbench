/**
 * POST 响应处理工具（安全管线）
 *
 * 从 routes/posts.ts 提取，供 posts.ts、feed.ts、auth.ts 共用。
 * 任何对外下发 POST 的端点都必须经过 processPostsForResponse 处理，
 * 确保：① awemeId 字段补齐 ② contentStatus 过滤
 *       ③ 出口剥离 recommendedBy（= 导入者的 identityId，鉴权凭据面，绝不下发）
 *       ④ 不下发从视频里来的图（2026-10-28 苹果 5.2.3 整改）：卡片图换成店铺照片，菜品不带截图
 */

import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, SHARED_TABLE, USERS_TABLE } from './dynamodb.js';

/**
 * 字段映射：确保每条 POST 都有 awemeId 字段（帖子唯一 ID 的历史命名，即抖音视频 ID）。
 */
function mapPostFields(posts: Record<string, unknown>[]): Record<string, unknown>[] {
  return posts.map((post) => {
    const sk = post['SK'] as string;
    if (!post['awemeId']) {
      return { ...post, awemeId: sk.replace('POST#', '') };
    }
    return post;
  });
}

/**
 * contentStatus 过滤：只返回 approved 或无 contentStatus 的帖子。
 * 导入帖被举报、后台裁定违规后是 rejected，谁都不再下发（导入者本人也不例外）。
 */
function filterByContentStatus(posts: Record<string, unknown>[]): Record<string, unknown>[] {
  return posts.filter((post) => {
    const status = post['contentStatus'] as string | undefined;
    return !status || status === 'approved';
  });
}

/**
 * 注入 liked 字段：BatchGet users 表 LIKE# 记录，标记当前用户已点赞的帖子。
 */
async function enrichLikedStatus(posts: Record<string, unknown>[], identityId: string): Promise<Record<string, unknown>[]> {
  if (posts.length === 0) return posts;

  const postSKs = posts
    .map(p => p['SK'] as string)
    .filter(Boolean);
  if (postSKs.length === 0) return posts;

  const docClient = getDocClient();
  const likedSKs = new Set<string>();
  const BATCH_SIZE = 100;

  const allKeys = postSKs.map(sk => ({ PK: identityId, SK: `LIKE#${sk}` }));

  for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
    const batch = allKeys.slice(i, i + BATCH_SIZE);
    let keys = batch;

    while (keys.length > 0) {
      const result = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [USERS_TABLE]: {
            Keys: keys,
            ProjectionExpression: 'SK',
          },
        },
      }));

      for (const item of result.Responses?.[USERS_TABLE] ?? []) {
        const sk = item['SK'] as string;
        likedSKs.add(sk.replace('LIKE#', ''));
      }

      const unprocessed = result.UnprocessedKeys?.[USERS_TABLE]?.Keys;
      keys = (unprocessed && unprocessed.length > 0) ? unprocessed as typeof keys : [];
    }
  }

  return posts.map(post => ({
    ...post,
    liked: likedSKs.has(post['SK'] as string),
  }));
}

/** 店铺照片等图片的 CDN 域名（S3 key 接在后面） */
const IMAGE_CDN = 'https://img.shopmap.example';

/**
 * 注入店上的两样东西（REST 实体）：
 *   - tastyCount：这家店的「好吃」人数（2026-10-21），App 首页卡片在原来点赞数的位置显示它；没人评过记 0
 *   - coverUrl：卡片图换成这家店的第一张店铺照片（2026-10-28，不再下发视频封面）；店没有照片就留空
 */
async function enrichRestaurantInfo(posts: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const restIds = [...new Set(posts.map((p) => p['restaurantId']).filter((id): id is string => typeof id === 'string' && id !== ''))];

  const docClient = getDocClient();
  const info = new Map<string, { tastyCount: number; coverUrl: string }>();
  const BATCH_SIZE = 100;
  for (let i = 0; i < restIds.length; i += BATCH_SIZE) {
    let keys = restIds.slice(i, i + BATCH_SIZE).map((id) => ({ PK: 'REST', SK: id }));
    while (keys.length > 0) {
      const result = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [SHARED_TABLE]: {
            Keys: keys,
            ProjectionExpression: 'SK, tastyCount, placeDetails.photos[0]',
          },
        },
      }));
      for (const item of result.Responses?.[SHARED_TABLE] ?? []) {
        const photoKey = (item['placeDetails'] as { photos?: { key?: string }[] } | undefined)?.photos?.[0]?.key;
        info.set(item['SK'] as string, {
          tastyCount: Math.max(0, Number(item['tastyCount'] ?? 0) || 0),
          coverUrl: photoKey ? `${IMAGE_CDN}/${photoKey}` : '',
        });
      }
      const unprocessed = result.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
      keys = (unprocessed && unprocessed.length > 0) ? unprocessed as typeof keys : [];
    }
  }

  return posts.map((post) => {
    const rest = info.get(post['restaurantId'] as string);
    return { ...post, tastyCount: rest?.tastyCount ?? 0, coverUrl: rest?.coverUrl ?? '' };
  });
}

/** 菜品不带视频截图（2026-10-28）：只留菜名、价格、推荐度和评价 */
function stripDishFrames(posts: Record<string, unknown>[]): Record<string, unknown>[] {
  return posts.map((post) => {
    if (!Array.isArray(post['dishes'])) return post;
    const dishes = (post['dishes'] as unknown[]).map((dish) => {
      if (!dish || typeof dish !== 'object') return dish;
      const { s3Key: _s3Key, ...rest } = dish as Record<string, unknown>;
      return rest;
    });
    return { ...post, dishes };
  });
}

/**
 * 安全脱敏：从对外响应中剥离 recommendedBy（= 导入者的 Cognito Identity ID）。
 * 必须在管线最后调用。
 */
function stripSensitiveFields(posts: Record<string, unknown>[]): Record<string, unknown>[] {
  return posts.map((post) => {
    const { recommendedBy: _recommendedBy, ...rest } = post;
    return rest;
  });
}

/**
 * 组合处理：映射字段 → 过滤 contentStatus → 菜品去截图 → 补点赞、好吃人数、店铺照片 → 出口剥离 recommendedBy。
 */
export async function processPostsForResponse(
  posts: Record<string, unknown>[],
  identityId: string,
): Promise<Record<string, unknown>[]> {
  const filtered = stripDishFrames(filterByContentStatus(mapPostFields(posts)));
  // 新版 App（2026-10-21 起）不再显示点赞，旧版仍要 liked
  const [withLikes, withRest] = await Promise.all([
    enrichLikedStatus(filtered, identityId),
    enrichRestaurantInfo(filtered),
  ]);
  return stripSensitiveFields(withLikes.map((p, i) => ({
    ...p,
    tastyCount: withRest[i]?.['tastyCount'] ?? 0,
    coverUrl: withRest[i]?.['coverUrl'] ?? '',
  })));
}
