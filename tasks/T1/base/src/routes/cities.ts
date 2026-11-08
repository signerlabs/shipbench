/**
 * 城市路由
 *
 * GET /  — 获取城市摘要（shared 表全局数据）
 */

import { Hono } from 'hono';
import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { identityMiddleware } from '../middleware/auth.js';
import { getDocClient, SHARED_TABLE } from '../lib/dynamodb.js';

export const citiesRoute = new Hono();

// 所有路由需要 Identity ID
citiesRoute.use('*', identityMiddleware);

/** 城市摘要类型 */
interface CitySummary {
  city: string;
  restaurantCount: number;
  postCount: number;  // 1.0.5 前端需要此字段，1.0.6 上线后移除
  centerLat: number | null;
  centerLng: number | null;
}

// ============================================================
// GET / — 获取城市摘要（只统计餐厅数量和中心坐标）
// ============================================================

citiesRoute.get('/', async (c) => {
  const docClient = getDocClient();

  // 查 shared 表所有 REST，只投影需要的字段
  const restItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result: QueryCommandOutput = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'REST' },
      ProjectionExpression: 'city, locality, latitude, longitude',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (result.Items) restItems.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 按 locality（地级）聚合：数量 + 店坐标算术平均中心（CITY_CENTERS 退休，2026-07-08）。
  // 地级优先，存量老店无 locality → 兜底 city 老字段；空串（无 city 待 admin 店）跳过、不进下拉。
  const cityAgg = new Map<string, { count: number; latSum: number; lngSum: number; coordCount: number }>();
  for (const item of restItems) {
    const city = (item['locality'] as string) || (item['city'] as string);
    if (!city || city === 'unknown') continue;
    const agg = cityAgg.get(city) ?? { count: 0, latSum: 0, lngSum: 0, coordCount: 0 };
    agg.count += 1;
    const lat = item['latitude'];
    const lng = item['longitude'];
    if (typeof lat === 'number' && typeof lng === 'number') {
      agg.latSum += lat;
      agg.lngSum += lng;
      agg.coordCount += 1;
    }
    cityAgg.set(city, agg);
  }

  // 构建返回：中心坐标 = 该城市下店坐标算术平均（聚合气泡定位够用；无坐标店的城市 → null）
  const cities: CitySummary[] = [];
  for (const [city, agg] of cityAgg) {
    cities.push({
      city,
      restaurantCount: agg.count,
      postCount: 0,
      centerLat: agg.coordCount > 0 ? agg.latSum / agg.coordCount : null,
      centerLng: agg.coordCount > 0 ? agg.lngSum / agg.coordCount : null,
    });
  }

  cities.sort((a, b) => b.restaurantCount - a.restaurantCount);
  return c.json({ data: cities });
});
