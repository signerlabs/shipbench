/**
 * 餐厅去重与合并共享库
 *
 * 2026-07-07 阶段 1（坐标 server 化）从 routes/restaurants.ts 提取：
 * - normalizeRestName / distanceMeters / MERGE_DISTANCE_THRESHOLD — 判重基础件
 * - findDuplicateRestaurant — 纯查重（同城同一个高德或 Google 编号；2026-10-22 起不再按店名合并），
 *   供 parse-processor 补到坐标后在落库前判重（命中则直接挂到已有店，不产生重复 REST）
 * 2026-10-21：tryMergeRestaurant（iOS 回写坐标后合并重复店）随 POST /:id/location 一起删除。
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, SHARED_TABLE } from './dynamodb.js';

/**
 * 餐厅名称规范化（用于去重比较）
 *
 * 规则：去除空格、标点、括号内容，统一全角/半角，转小写
 * 例如 "老王面馆（总店）" 和 "老王面馆" 视为同名
 */
export function normalizeRestName(name: string): string {
  return name
    // 去除括号内容（中英文括号）
    .replace(/[（(][^）)]*[）)]/g, '')
    // 全角字符转半角
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    // 去除标点符号和空格
    .replace(/[\s\p{P}]/gu, '')
    // 转小写
    .toLowerCase()
    .trim();
}

/** Haversine 公式计算两点距离（米） */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 合并阈值：200 米 */
export const MERGE_DISTANCE_THRESHOLD = 200;

/**
 * 查找同城重复餐厅（纯查询，不做任何写入）
 *
 * 判定口径（2026-10-22 产品负责人定）：同城里高德或 Google 编号相同的才算同一家，不再按店名、距离合并
 * （按名字并过的店里查出过并错：同名的两家在不同区、同一个校门口的两个摊位）。
 * excludeRestaurantId 用于排除自身（已落库场景）；落库前判重传 undefined 即可。
 *
 * 返回匹配到的已有 REST Item（含 SK 即 restaurantId），无重复返回 null。
 */
export async function findDuplicateRestaurant(
  docClient: ReturnType<typeof getDocClient>,
  city: string,
  /** 地图编号（2026-10-20 高德，10-21 起境外的店是 Google place_id） */
  placeId: string,
  excludeRestaurantId?: string,
): Promise<Record<string, unknown> | null> {
  // 1. 通过 city-index 查询同城市下所有 REST
  const allCityRests: Record<string, unknown>[] = [];
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
    if (result.Items) allCityRests.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 2. 同城里高德或 Google 编号相同的，就是同一家（分店名写法不同、坐标差几十米都不影响）
  const byPoi = allCityRests.find((r) => (r['amapPoiId'] === placeId || r['googlePlaceId'] === placeId)
    && !(excludeRestaurantId && r['SK'] === excludeRestaurantId));
  return byPoi ?? null;
}
