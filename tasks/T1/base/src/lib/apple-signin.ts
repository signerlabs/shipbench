/**
 * Sign in with Apple 删号撤销（App Store 审核指南 5.1.1(v)：支持 Apple 登录的 App，删号时须调
 * Apple REST API 撤销用户授权，2022-06-30 起强制）。参照另一个项目的 apple.ts。
 *
 * 流程：iOS 删号前用原生 Sign in with Apple 重新授权一次，拿到一次性 authorizationCode（5 分钟
 * 有效）随 DELETE /v1/auth/me 的请求体上送 → 服务端用 client_secret（团队 Sign in with Apple 私钥
 * 签的 ES256 JWT）向 Apple 换 token → POST /auth/revoke 撤销。
 *
 * - client_id：原生 Sign in with Apple 拿到的 code 属于 App 的 Bundle ID（不是 Cognito 用的
 *   Services ID com.example.shopmap.auth）
 * - 私钥：Secrets Manager shopmap/apple-private-key（纯文本 .p8，Cognito Apple 登录同一把，
 *   Key ID KWWK36TQ4W，Team 5GS4D3667R）。App Runner 实例角色需有该 Secret 的读权限（CDK 已加）
 * - 全程尽力而为：任何失败只返回 'failed' 并打日志，绝不抛出、绝不挡删号本身
 * - 日志只打结果和 HTTP 状态，不打 code / token / 私钥
 */

import * as jose from 'jose';
import { getSecretString } from './secrets.js';

const APPLE_AUTH_ORIGIN = 'https://appleid.apple.com';

/** 原生 Sign in with Apple 的 client_id = App Bundle ID */
export const SIWA_CLIENT_ID = 'com.example.shop-map-ios';
/** Apple Developer Team ID */
export const APPLE_TEAM_ID = '5GS4D3667R';
/** Sign in with Apple 私钥 Key ID（团队通用一把） */
export const SIWA_KEY_ID = 'KWWK36TQ4W';
/** 私钥所在 Secret（纯文本 PEM） */
const SIWA_PRIVATE_KEY_SECRET = 'shopmap/apple-private-key';

/** 单次 Apple 请求超时：两次请求最坏 16 秒，iOS 删号请求超时 30 秒 */
const APPLE_REQUEST_TIMEOUT_MS = 8_000;

export type AppleRevokeOutcome = 'revoked' | 'skipped' | 'failed';

/**
 * 签 client_secret（ES256 JWT，5 分钟有效）
 * 规范：header { alg: ES256, kid }，claims { iss: Team ID, iat, exp, aud: https://appleid.apple.com, sub: client_id }
 */
export async function buildAppleClientSecret(privateKeyPem: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<string> {
  // 容错：控制台粘贴 .p8 时换行可能被存成字面 "\n"
  const pem = privateKeyPem.replace(/\\n/g, '\n').trim();
  const key = await jose.importPKCS8(pem, 'ES256');
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: SIWA_KEY_ID })
    .setIssuer(APPLE_TEAM_ID)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .setAudience(APPLE_AUTH_ORIGIN)
    .setSubject(SIWA_CLIENT_ID)
    .sign(key);
}

async function postForm(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${APPLE_AUTH_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(APPLE_REQUEST_TIMEOUT_MS),
  });
}

/**
 * 用一次性 authorizationCode 换 token 并撤销该用户对本 App 的 Apple 登录授权。
 * 返回 revoked / failed（skipped 留给调用方表示「没带 code」）。
 */
export async function revokeAppleAuthorization(authorizationCode: string): Promise<AppleRevokeOutcome> {
  try {
    const privateKey = await getSecretString(SIWA_PRIVATE_KEY_SECRET);
    const clientSecret = await buildAppleClientSecret(privateKey);

    const tokenRes = await postForm('/auth/token', {
      client_id: SIWA_CLIENT_ID,
      client_secret: clientSecret,
      code: authorizationCode,
      grant_type: 'authorization_code',
    });
    if (!tokenRes.ok) {
      // Apple 错误体形如 {"error":"invalid_grant"}，不含敏感信息
      console.warn(`[siwa] 换 token 失败 | status=${tokenRes.status} | body=${(await tokenRes.text().catch(() => '')).slice(0, 200)}`);
      return 'failed';
    }
    const tokens = (await tokenRes.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string };
    const token = tokens.refresh_token ?? tokens.access_token;
    if (!token) {
      console.warn('[siwa] 换 token 响应里没有 refresh_token / access_token');
      return 'failed';
    }

    const revokeRes = await postForm('/auth/revoke', {
      client_id: SIWA_CLIENT_ID,
      client_secret: clientSecret,
      token,
      token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token',
    });
    if (!revokeRes.ok) {
      console.warn(`[siwa] 撤销失败 | status=${revokeRes.status} | body=${(await revokeRes.text().catch(() => '')).slice(0, 200)}`);
      return 'failed';
    }
    return 'revoked';
  } catch (err) {
    console.warn(`[siwa] 撤销异常 | ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 'failed';
  }
}
