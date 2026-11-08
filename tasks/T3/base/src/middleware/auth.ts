/**
 * 认证中间件
 *
 * 支持匿名和已登录用户：
 * 1. x-identity-id header — Cognito Identity Pool 分配的唯一 ID（必需）
 * 2. Authorization Bearer token — 已登录用户的 JWT token（可选，jose 真验签）
 *
 * 安全说明（2026-06-18 Cognito 鉴权改造第一波）：
 *   - 旧实现只 base64 解 JWT、不验签 → 任何人可手搓 {"sub":"别人的id"} 冒充 → 横向越权。
 *   - 现改为 jose + createRemoteJWKSet + jwtVerify 真验签（校验签名 + issuer + audience）。
 *   - 关键软兼容：线上 25k 旧版 iOS 端「从不发 Authorization header」，全部走 x-identity-id
 *     匿名分支。因此：① 无 Bearer → 照旧匿名放行；② 带 Bearer 但验签失败 → 过渡期仍当匿名
 *     放行（打 legacy log），绝不 401，避免锁死线上用户。等新版渗透率 ≥ 90% 后再用远程开关收紧。
 */

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as jose from 'jose';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityClient, GetIdCommand } from '@aws-sdk/client-cognito-identity';
import { getDocClient, USERS_TABLE } from '../lib/dynamodb.js';

/**
 * Identity 上下文类型（支持匿名用户）
 */
export interface IdentityContext {
  identityId: string;   // Cognito Identity ID（匿名和已登录用户都有）
  cognitoSub?: string;  // Cognito sub（仅「JWT 验签通过」的已登录用户才有，绝不信任未验签 token）
  email?: string;       // 用户邮箱（仅来自验签通过的 JWT）
}

/**
 * 扩展 Hono Context 类型
 */
declare module 'hono' {
  interface ContextVariableMap {
    identity: IdentityContext;
  }
}

// ---------------------------------------------------------------------------
// Cognito JWT 验签（jose + 远程 JWKS）
// ---------------------------------------------------------------------------

// 远程 JWKS 公钥集（jose 自动缓存 + 刷新）
let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof jose.createRemoteJWKSet> {
  if (!jwks) {
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    if (!userPoolId) {
      throw new Error('COGNITO_USER_POOL_ID 环境变量未设置');
    }
    const region = process.env.AWS_REGION || 'ap-southeast-1';
    const jwksUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
    jwks = jose.createRemoteJWKSet(new URL(jwksUrl));
  }
  return jwks;
}

/**
 * 真验签 Cognito ID Token：校验签名（JWKS）+ issuer + audience。
 * 验签通过返回 { cognitoSub, email }；任何失败返回 null（绝不信任未验签 token）。
 */
async function verifyCognitoJwt(
  token: string,
): Promise<{ cognitoSub: string; email?: string } | null> {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) {
    // 服务端未配置 Cognito → 无法验签，按未验证处理（不抛错，避免影响匿名只读流量）
    console.warn('[Auth] COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID 未配置，JWT 验签跳过');
    return null;
  }

  try {
    const region = process.env.AWS_REGION || 'ap-southeast-1';
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
    const { payload } = await jose.jwtVerify(token, getJwks(), {
      issuer,
      audience: clientId, // ID Token 的 aud == App Client ID
    });
    const sub = payload.sub;
    if (!sub || typeof sub !== 'string') return null;
    return {
      cognitoSub: sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  } catch {
    // 过期 / issuer 不符 / audience 不符 / 签名无效 → 视为未认证
    return null;
  }
}

/**
 * 从请求 headers 提取 Identity 信息
 *
 * 软兼容策略（过渡期）：
 *   - 无 Bearer → 匿名放行（线上旧版 100% 走此分支）
 *   - 带 Bearer 且验签通过 → 已认证（cognitoSub 可信）
 *   - 带 Bearer 但验签失败 → 打 legacy-unauth-write log，过渡期仍当匿名放行（不拒绝）
 */
async function extractIdentity(c: Context): Promise<IdentityContext | null> {
  // 1. 必须有 x-identity-id header
  const identityId = c.req.header('x-identity-id');
  if (!identityId) {
    return null;
  }

  // 2. 尝试验签 Authorization header 中的 JWT（已登录的新版客户端）
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const verified = await verifyCognitoJwt(token);
    if (verified) {
      return {
        identityId,
        cognitoSub: verified.cognitoSub,
        email: verified.email,
      };
    }
    // 带了 Bearer 但验签失败：过渡期不拒绝，记 legacy log 后当匿名放行
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    if (writeMethods.has(c.req.method)) {
      console.warn(
        `[Auth][legacy-unauth-write] JWT 验签失败但放行 | method=${c.req.method} path=${c.req.path} | identityId=${identityId.slice(-12)}`,
      );
    }
  }

  // 3. 匿名用户（只有 identityId，或带了无效 JWT 的过渡期请求）
  return { identityId };
}

// ---------------------------------------------------------------------------
// Identity Pool 权威归属查询
// ---------------------------------------------------------------------------

/**
 * GetId 是**公开 API**（官方文档："You do not need any credentials to call this API"），
 * 客户端显式不签名，彻底不依赖实例角色 IAM——无需为此改 CDK。
 */
const cognitoIdentityClient = new CognitoIdentityClient({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  signer: { sign: async (request) => request },
});

/**
 * 向 Cognito Identity Pool 查询：这枚 ID Token 所属用户**真正拥有**的 identityId。
 *
 * 这是判断「这张 JWT 是否属于这个 identityId」的**唯一权威来源**：token 由 Cognito
 * 自己校验（伪造 / 过期 / 他池签发一律 NotAuthorizedException），返回值由 Cognito
 * 按 login 关联关系给出，请求方无法左右。
 *
 * @returns 该 token 对应的 identityId；token 不被身份池接受时返回 null
 * @throws 服务端故障（限流 / 内部错误 / 未配置）——调用方必须 fail-closed，绝不能当作「通过」
 */
export async function resolveIdentityIdByToken(idToken: string): Promise<string | null> {
  const identityPoolId = process.env.COGNITO_IDENTITY_POOL_ID;
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!identityPoolId || !userPoolId) {
    throw new Error('COGNITO_IDENTITY_POOL_ID / COGNITO_USER_POOL_ID 未配置，无法校验身份归属');
  }
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  try {
    const res = await cognitoIdentityClient.send(new GetIdCommand({
      IdentityPoolId: identityPoolId,
      Logins: { [`cognito-idp.${region}.amazonaws.com/${userPoolId}`]: idToken },
    }));
    return res.IdentityId ?? null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'NotAuthorizedException') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// cognitoSub ↔ identityId 绑定校验（P0-1 冒充防护）
// ---------------------------------------------------------------------------

/**
 * 校验 cognitoSub 与 identityId 的归属绑定。
 *
 * 背景：旧实现即便 JWT 验签通过，identityId 仍取 x-identity-id header 原值且不校验归属，
 * 攻击者可用自己的合法 JWT + 任意人的 identityId 冒充他人（横向越权）。
 *
 * 绑定行存 users 表：PK=COGNITO#{cognitoSub}, SK='BINDING'，属性含 identityId、createdAt。
 * 流程：
 *   1. 读绑定行（最终一致读足够：绑定一旦建立不再变更）
 *   2. 存在且 identityId 匹配 → true；不匹配 → false（调用方返回 403 IDENTITY_MISMATCH）
 *   3. 不存在 → **先向 Identity Pool 求证归属**，属实才条件写建立绑定
 *
 * 2026-09-16 修复第 3 步的越权洞：旧实现在绑定不存在时直接「先到先得」照请求头建绑定。
 * 绑定行主键是 COGNITO#<sub>，条件写 attribute_not_exists(PK) 只保证**这个 sub** 没绑过，
 * 对「这个 identityId 是否属于这个 sub」毫无校验——任何一枚从未请求过本服务的合法 sub
 * （换个 Apple ID 即可得），带上受害者的 x-identity-id，第一次请求就能把受害者身份认领走。
 * 受害者 identityId 当时还能从公开下发的兜底 authorId（anon-<uuid>）逆推，
 * 攻击链完整。配合 DELETE /v1/auth/me 即可不可逆删除任意账号。
 * 求证只发生在建绑定那一次（每个 sub 一生一次），已绑定的请求仍走 DynamoDB 快路径。
 *
 * 异常不吞：DynamoDB / Cognito 故障直接冒泡，由调用方 fail-closed。
 */
async function verifyCognitoBinding(
  identityId: string,
  cognitoSub: string,
  idToken: string,
): Promise<boolean> {
  const docClient = getDocClient();
  const bindingKey = { PK: `COGNITO#${cognitoSub}`, SK: 'BINDING' };

  const existing = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: bindingKey,
    ProjectionExpression: 'identityId',
  }));
  if (existing.Item) {
    return existing.Item['identityId'] === identityId;
  }

  // 绑定不存在 → **先求证归属**，属实才建。绝不能照请求头「先到先得」（见函数头注释）。
  const owner = await resolveIdentityIdByToken(idToken);
  if (owner !== identityId) {
    console.warn(
      `[Auth][binding] 拒绝建立绑定：token 归属与请求头不符 | cognitoSub=${cognitoSub.substring(0, 8)}...` +
      ` | 请求头 identityId=${identityId.slice(-12)} | 身份池归属=${owner ? owner.slice(-12) : 'null'}`,
    );
    return false;
  }

  try {
    await docClient.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        ...bindingKey,
        identityId,
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    console.log(`[Auth][binding] 建立绑定 | cognitoSub=${cognitoSub.substring(0, 8)}... → identityId=${identityId.slice(-12)}`);
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // 并发竞态：其他请求已抢先建立绑定 → 重读并按胜出者校验
      const reread = await docClient.send(new GetCommand({
        TableName: USERS_TABLE,
        Key: bindingKey,
        ProjectionExpression: 'identityId',
      }));
      return reread.Item?.['identityId'] === identityId;
    }
    throw err;
  }
}

/**
 * Identity 中间件 — 支持匿名用户
 *
 * 所有业务路由必须携带 x-identity-id header
 */
export const identityMiddleware: MiddlewareHandler = async (c, next) => {
  const identity = await extractIdentity(c);

  if (!identity) {
    const rawHeader = c.req.header('x-identity-id');
    console.log(`[Auth] 401 | path=${c.req.path} | x-identity-id=${JSON.stringify(rawHeader)} | UA=${c.req.header('User-Agent')?.substring(0, 50)}`);
    throw new HTTPException(401, { message: 'Identity ID required' });
  }

  // system-batch 是服务端内部使用的保留身份，禁止客户端写操作
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (identity.identityId === 'system-batch' && writeMethods.has(c.req.method)) {
    console.warn(`[Auth] 403 | system-batch 写操作被拒绝 | method=${c.req.method} path=${c.req.path}`);
    throw new HTTPException(403, { message: 'Forbidden: system-batch is a reserved identity' });
  }

  // P0-1：JWT 验签通过的请求必须通过 cognitoSub ↔ identityId 绑定校验，
  // 阻断「自己的合法 JWT + 别人的 x-identity-id」冒充。匿名请求（无 cognitoSub）维持软兼容不受影响。
  if (identity.cognitoSub) {
    // cognitoSub 存在即说明 extractIdentity 已验签通过，Bearer 头必然在
    const idToken = (c.req.header('Authorization') ?? '').slice(7);
    let bound: boolean;
    try {
      bound = await verifyCognitoBinding(identity.identityId, identity.cognitoSub, idToken);
    } catch (err) {
      // 求证归属失败（Cognito 限流 / 故障）→ fail-closed：宁可让这一次请求重试，
      // 也绝不能在无法确认归属时放行（放行即越权）。只影响「首次建绑定」那一次请求。
      console.error(`[Auth][binding] 身份归属校验异常，拒绝放行 | identityId=${identity.identityId.slice(-12)}`, err);
      return c.json({
        error: { code: 'IDENTITY_VERIFICATION_UNAVAILABLE', message: '身份校验暂时不可用，请稍后重试' },
      }, 503);
    }
    if (!bound) {
      console.warn(
        `[Auth][identity-mismatch] 403 | cognitoSub=${identity.cognitoSub.substring(0, 8)}... 与 identityId=${identity.identityId.slice(-12)} 绑定不匹配 | method=${c.req.method} path=${c.req.path}`,
      );
      return c.json({
        error: { code: 'IDENTITY_MISMATCH', message: '身份凭证与 Identity ID 不匹配' },
      }, 403);
    }
  }

  c.set('identity', identity);
  await next();
  return;
};

/**
 * 获取当前 Identity 信息
 *
 * 在 identityMiddleware 之后使用，保证返回非空值
 */
export function getIdentity(c: Context): IdentityContext {
  const identity = c.get('identity');
  if (!identity) {
    throw new HTTPException(401, { message: 'Identity ID required' });
  }
  return identity;
}

// ---------------------------------------------------------------------------
// 写请求强制验签开关（Cognito 鉴权改造第二波）
// ---------------------------------------------------------------------------

/**
 * 写请求是否强制要求有效 Cognito JWT。
 *
 * 远程开关：环境变量 ENFORCE_WRITE_AUTH（App Runner 环境变量，改值无需发版）。
 *   - 默认 false：软兼容放行。带无效/缺失 JWT 的写请求照旧放行（仅打 legacy log），
 *     保护线上 25k 旧版 iOS 用户（旧版从不发 Authorization header）。
 *   - true：写请求必须携带验签通过的 JWT（identity.cognitoSub 存在），否则 401。
 *     等新版 iOS 渗透率 ≥ 90% 后由产品负责人置 true 收紧。
 *
 * 同步下发给 iOS：见 /v1/config 的 enforceWriteAuth 字段，让前端知道何时必须带 token。
 */
export function isEnforceWriteAuth(): boolean {
  return (process.env.ENFORCE_WRITE_AUTH || 'false').toLowerCase() === 'true';
}

/**
 * 写请求验签中间件 — 挂在所有写路由（POST/PUT/PATCH/DELETE）之后、业务处理之前。
 *
 * 必须在 identityMiddleware 之后挂载（依赖其已设置的 identity.cognitoSub）。
 *
 * 行为：
 *   - 非写方法（GET/HEAD/OPTIONS）→ 直接放行（读请求不受影响）。
 *   - 写方法：
 *       · identity.cognitoSub 存在（JWT 验签通过）→ 放行。
 *       · cognitoSub 缺失：
 *           - ENFORCE_WRITE_AUTH=false（默认）→ 放行（identityMiddleware 已打过 legacy log）。
 *           - ENFORCE_WRITE_AUTH=true → 401，拒绝无凭据写入。
 */
export const requireWriteAuth: MiddlewareHandler = async (c, next) => {
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (!writeMethods.has(c.req.method)) {
    return next();
  }

  const identity = c.get('identity');
  const hasValidJwt = !!identity?.cognitoSub;

  if (!hasValidJwt && isEnforceWriteAuth()) {
    console.warn(
      `[Auth][enforce-write-auth] 拒绝无有效 JWT 的写请求 | method=${c.req.method} path=${c.req.path} | identityId=${identity?.identityId?.slice(-12) ?? 'none'}`,
    );
    throw new HTTPException(401, {
      message: 'Valid authentication required for write operations',
    });
  }

  return next();
};

/**
 * 必须真登录的写接口（2026-10-27）：不看 ENFORCE_WRITE_AUTH 开关，没有验签通过的 JWT 一律 401。
 * 只挂在「只有新版 App 调用、且新版已带登录凭证」的接口上（好吃 / 不好吃），收紧不影响旧版；
 * 防的是拿别人的身份 ID 冒名连点「不好吃」把店压下去。必须在 identityMiddleware 之后挂载。
 */
export const requireSignedIn: MiddlewareHandler = async (c, next) => {
  const identity = c.get('identity');
  if (!identity?.cognitoSub) {
    console.warn(
      `[Auth][signed-in-only] 拒绝没有登录凭证的写请求 | method=${c.req.method} path=${c.req.path} | identityId=${identity?.identityId?.slice(-12) ?? 'none'}`,
    );
    throw new HTTPException(401, { message: 'Sign in required' });
  }
  return next();
};

// ---------------------------------------------------------------------------
// /v1/parse 写端点强制验签开关（P0-1 配套收紧手段）
// ---------------------------------------------------------------------------

/**
 * parse 写端点是否强制要求有效 Cognito JWT。
 *
 * 远程开关：环境变量 ENFORCE_PARSE_AUTH（App Runner 环境变量，改值无需发版），默认 false。
 * 抖音导入是会员功能，但可能存在「有导入功能但尚不发 JWT」的旧版本客户端，
 * 故独立于 ENFORCE_WRITE_AUTH 单开一挡：待新版渗透后由产品负责人置 true 收紧，无需发版。
 *
 * 同步下发给 iOS：见 /v1/config 的 enforceParseAuth 字段（模式同 enforceWriteAuth）。
 */
export function isEnforceParseAuth(): boolean {
  return (process.env.ENFORCE_PARSE_AUTH || 'false').toLowerCase() === 'true';
}

/**
 * parse 写请求验签中间件 — 挂在 parseRoute 的 identityMiddleware 之后。
 *
 * 行为：
 *   - 非写方法（GET /jobs/:jobId 轮询等）→ 直接放行。
 *   - 写方法（POST /v1/parse）：
 *       · identity.cognitoSub 存在（JWT 验签通过且绑定匹配，由 identityMiddleware 保证）→ 放行。
 *       · cognitoSub 缺失：
 *           - ENFORCE_PARSE_AUTH=false（默认）→ 放行（软兼容）。
 *           - ENFORCE_PARSE_AUTH=true → 401，拒绝无凭据的导入请求。
 */
export const requireParseAuth: MiddlewareHandler = async (c, next) => {
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  if (!writeMethods.has(c.req.method)) {
    return next();
  }

  const identity = c.get('identity');
  const hasValidJwt = !!identity?.cognitoSub;

  if (!hasValidJwt && isEnforceParseAuth()) {
    console.warn(
      `[Auth][enforce-parse-auth] 拒绝无有效 JWT 的 parse 写请求 | method=${c.req.method} path=${c.req.path} | identityId=${identity?.identityId?.slice(-12) ?? 'none'}`,
    );
    throw new HTTPException(401, {
      message: 'Valid authentication required for parse operations',
    });
  }

  return next();
};
