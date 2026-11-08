/**
 * 逆地理编码路由（2026-07-08 城市分层方案 B）
 *
 * GET /reverse?lat={lat}&lng={lng} — 坐标 → 城市三层 { administrativeArea?, locality, subLocality? }
 *
 * identity-only（匿名 x-identity-id 即可，不套写鉴权 requireWriteAuth）：
 *   未登录用户也要定位后看同城 feed，若套写操作 JWT 会把匿名用户挡死。
 * 底层 regeoAmap + ~110m 网格缓存（同/邻近坐标不重复调高德）。
 * 非中国 / regeo 无果 → 非 200（404，locality 空），前端据此走坐标兜底。
 */

import { Hono } from 'hono';
import { identityMiddleware, getIdentity } from '../middleware/auth.js';
import { getAppSecrets } from '../lib/secrets.js';
import { regeoAmap } from '../lib/amap-geocode.js';

// 每 identity regeo 限流（内存滑动窗口，App Runner 长驻进程）：定位刷新够用，
// 防匿名刷高德 regeo 配额（110m 网格缓存只挡同坐标重复、挡不住换坐标连刷）。
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
const RATE_MAP_MAX = 10000; // Map FIFO 封顶防内存爬升
const rateMap = new Map<string, { count: number; windowStart: number }>();
function allowRegeo(identityId: string): boolean {
  const now = Date.now();
  const e = rateMap.get(identityId);
  if (!e || now - e.windowStart > RATE_WINDOW_MS) {
    if (rateMap.size >= RATE_MAP_MAX) {
      const oldest = rateMap.keys().next().value;
      if (oldest !== undefined) rateMap.delete(oldest);
    }
    rateMap.set(identityId, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= RATE_MAX) return false;
  e.count += 1;
  return true;
}

export const geocodeRoute = new Hono();

// identity-only：匿名（仅 x-identity-id）即可调用，不加 requireWriteAuth
geocodeRoute.use('*', identityMiddleware);

geocodeRoute.get('/reverse', async (c) => {
  // 每 identity 限流（匿名可调 → 防刷高德配额）
  const { identityId } = getIdentity(c);
  if (!allowRegeo(identityId)) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'regeo 请求过于频繁，请稍后再试' } }, 429);
  }

  const lat = parseFloat(c.req.query('lat') || '');
  const lng = parseFloat(c.req.query('lng') || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'lat/lng 为必填数值' } }, 400);
  }
  // 中国大致经纬度范围外（如日本/东南亚）直接判无果，省一次高德调用；边缘由 regeo 兜底
  if (lat < 3 || lat > 54 || lng < 73 || lng > 136) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'regeo 无结果（境外坐标）' } }, 404);
  }

  let amapKey: string | undefined;
  try {
    const secrets = await getAppSecrets();
    amapKey = secrets['AMAP_WEB_KEY'];
  } catch (err) {
    console.warn('[geocode] 读取密钥失败:', err);
  }
  if (!amapKey) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'regeo 服务未配置' } }, 503);
  }

  try {
    const layers = await regeoAmap(amapKey, lng, lat);
    // 非中国 / 无匹配 → locality 空 → 404，前端据此走坐标兜底
    if (!layers || !layers.locality) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'regeo 无结果' } }, 404);
    }
    return c.json({
      data: {
        ...(layers.administrativeArea ? { administrativeArea: layers.administrativeArea } : {}),
        locality: layers.locality,
        ...(layers.subLocality ? { subLocality: layers.subLocality } : {}),
      },
    });
  } catch (err) {
    // 高德异常（配额/超时/网络）→ 503，前端走坐标兜底
    console.warn('[geocode] regeo 失败:', err);
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'regeo 暂不可用' } }, 503);
  }
});
