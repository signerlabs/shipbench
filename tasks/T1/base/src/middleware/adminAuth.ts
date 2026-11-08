/**
 * Admin 认证中间件
 *
 * 管理后台使用独立的 JWT 认证体系：
 * - POST /admin/login：验证用户名密码，签发 JWT
 * - 其他 /admin/* 路由：Bearer Token 验证
 *
 * Created by guiping on 2026/03/24
 */

import { sign, verify } from 'hono/jwt';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getAppSecrets } from '../lib/secrets.js';

/**
 * Admin JWT payload 类型
 */
export interface AdminJwtPayload {
  [key: string]: unknown;  // 兼容 hono JWTPayload 索引签名
  sub: string;     // 用户名
  role: string;    // 角色
  exp: number;     // 过期时间
  iat: number;     // 签发时间
}

/**
 * JWT 有效期（24 小时）
 */
const JWT_EXPIRES_IN = 7 * 24 * 60 * 60; // 7 天

/**
 * 获取 Admin 凭证（优先从 Secrets Manager，回退到环境变量）
 */
async function getAdminSecrets(): Promise<{ username: string; password: string; jwtSecret: string }> {
  try {
    const secrets = await getAppSecrets();
    if (secrets.ADMIN_USERNAME && secrets.ADMIN_PASSWORD && secrets.ADMIN_JWT_SECRET) {
      return {
        username: secrets.ADMIN_USERNAME,
        password: secrets.ADMIN_PASSWORD,
        jwtSecret: secrets.ADMIN_JWT_SECRET,
      };
    }
  } catch { /* Secrets Manager 不可用，回退到环境变量 */ }

  // 回退到环境变量（兼容旧配置）
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const jwtSecret = process.env.ADMIN_JWT_SECRET;
  if (!username || !password || !jwtSecret) {
    throw new Error('Admin 凭证未配置（Secrets Manager 和环境变量均未找到）');
  }
  return { username, password, jwtSecret };
}

/**
 * 获取 JWT 密钥
 */
async function getJwtSecret(): Promise<string> {
  const { jwtSecret } = await getAdminSecrets();
  return jwtSecret;
}

/**
 * 验证管理员凭据
 */
export async function verifyAdminCredentials(username: string, password: string): Promise<boolean> {
  try {
    const admin = await getAdminSecrets();
    return username === admin.username && password === admin.password;
  } catch {
    console.error('[Admin] Admin 凭证未配置');
    return false;
  }
}

/**
 * 签发 Admin JWT
 */
export async function signAdminToken(username: string): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const payload: AdminJwtPayload = {
    sub: username,
    role: 'admin',
    iat: now,
    exp: now + JWT_EXPIRES_IN,
  };

  const token = await sign(payload, await getJwtSecret());
  return { token, expiresIn: JWT_EXPIRES_IN };
}

/**
 * Admin 认证中间件
 *
 * 验证 Bearer Token，将解析后的 payload 存入 context
 * 注意：/admin/login 不需要此中间件，应在路由层跳过
 */
/**
 * 验证 Admin JWT token 字符串，返回解析后的 payload
 * 用于无法设置 Authorization header 的场景（如 SSE EventSource）
 */
export async function verifyAdminToken(token: string): Promise<AdminJwtPayload> {
  const payload = await verify(token, await getJwtSecret(), 'HS256') as AdminJwtPayload;
  if (payload.role !== 'admin') {
    throw new Error('Insufficient permissions');
  }
  return payload;
}

/**
 * 请求是否携带有效的 Admin JWT（Authorization: Bearer <admin token>）。
 * 供 /v1 下少数「本人或管理员」可写的接口判定管理员身份；任何失败一律 false，不抛错。
 * 注意：iOS 的 Bearer 是 Cognito RS256 ID Token，在这里必然验签失败 → false。
 */
export async function isAdminRequest(c: Context): Promise<boolean> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  try {
    await verifyAdminToken(authHeader.slice(7));
    return true;
  } catch {
    return false;
  }
}

export const adminAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Authorization header required' });
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verify(token, await getJwtSecret(), 'HS256') as AdminJwtPayload;

    // 检查角色
    if (payload.role !== 'admin') {
      throw new HTTPException(403, { message: 'Insufficient permissions' });
    }

    // 存入 context
    c.set('adminUser', payload.sub);
    await next();
  } catch (err: unknown) {
    // hono/jwt verify 抛出的错误
    if (err instanceof HTTPException) {
      throw err;
    }
    console.error('[Admin] JWT 验证失败:', err);
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }
};
