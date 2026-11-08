/**
 * 封禁拦截中间件
 *
 * 挂在各写路由的 identityMiddleware 之后：被封禁的身份发起写请求（POST/PUT/PATCH/DELETE，
 * 含 POST /v1/parse 导入）一律 403 USER_BANNED；读请求（GET）不拦。
 *
 * 刻意不挂的两个写接口（在 routes/auth.ts 按路径挂载时排除）：
 *   - DELETE /v1/auth/me：注销账号是用户的法定权利（个保法第 47 条、App Store 审核指南
 *     5.1.1(v)），被封禁也必须能删
 *   - POST /v1/auth/subscription：只是购买记账（会员判定在客户端 StoreKit），拦了只会让
 *     订阅行与真实购买脱节、影响退款与客服核对，起不到限制作用
 *
 * 封禁查询异常时放行（fail-open）：封禁是内容治理手段而非安全边界，DynamoDB 抖动不能
 * 把全站写入一起打挂；异常会打日志。
 */

import type { MiddlewareHandler } from 'hono';
import { isIdentityBanned } from '../lib/user-ban.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const USER_BANNED_BODY = {
  error: { code: 'USER_BANNED', message: '账号已被封禁，暂时无法进行此操作' },
} as const;

export const rejectBannedWrites: MiddlewareHandler = async (c, next) => {
  if (!WRITE_METHODS.has(c.req.method)) return next();

  const identityId = c.get('identity')?.identityId;
  if (!identityId) return next();

  let banned = false;
  try {
    banned = await isIdentityBanned(identityId);
  } catch (err) {
    console.warn(`[ban] 封禁状态查询失败，放行 | identityId=${identityId.slice(-12)}`, err);
  }

  if (banned) {
    console.warn(`[ban] 403 封禁身份的写请求被拒 | method=${c.req.method} path=${c.req.path} | identityId=${identityId.slice(-12)}`);
    return c.json(USER_BANNED_BODY, 403);
  }
  return next();
};
