/**
 * 远程配置路由
 *
 * GET /  — 返回 app 运行时配置（公开访问，无需认证）
 *
 * 配置值从环境变量读取，有默认值兜底，
 * 修改 App Runner 环境变量即可热更新，无需发版。
 */

import { Hono } from 'hono';
import { isEnforceWriteAuth, isEnforceParseAuth } from '../middleware/auth.js';
import { RESTAURANT_CATEGORIES } from '../lib/restaurant-categories.js';
import { DAILY_PARSE_LIMIT } from '../lib/parse-quota.js';

export const configRoute = new Hono();

// ============================================================
// GET / — 获取远程配置
// ============================================================

configRoute.get('/', (c) => {
  // ANNOUNCEMENT: 公告文案，空字符串视为无公告
  const announcementRaw = process.env.ANNOUNCEMENT || '';
  const announcement = announcementRaw.trim() || null;

  // ENFORCE_WRITE_AUTH: 写请求是否强制要求有效 Cognito JWT（默认 false=软兼容）。
  // 下发给 iOS：true 时前端所有写请求必须带 Authorization: Bearer <idToken>，
  // 否则后端会返回 401。前端可据此在登录态缺失时提前引导登录，而非等 401。
  const enforceWriteAuth = isEnforceWriteAuth();

  // ENFORCE_PARSE_AUTH: /v1/parse 写端点是否强制要求有效 Cognito JWT（默认 false=软兼容）。
  // 独立于 enforceWriteAuth 的收紧开关，供抖音导入功能单独提前收口。
  const enforceParseAuth = isEnforceParseAuth();

  return c.json({
    data: {
      // 每个身份每天可导入的视频数（= 服务端真实限额 DAILY_PARSE_LIMIT，导入已对登录用户免费开放）。
      // 2026-10-19 去掉空转的 FREE_IMPORT_LIMIT 环境变量（两端都没用，默认 3 与真实限额 20 对不上）；
      // 字段名保持不变，iOS RemoteConfigManager 按此解码
      freeImportLimit: DAILY_PARSE_LIMIT,
      announcement,
      enforceWriteAuth,
      enforceParseAuth,
      // 餐厅品类表（后端控制，iOS 动态拉取，改品类不需 iOS 发版）
      categories: RESTAURANT_CATEGORIES,
    },
  });
});
