/**
 * 会员校验中间件 — requirePaid
 *
 * v2.2 D3.1：抖音导入入口对 iOS 会员重新开放，非会员仅能手动创建小店。
 *
 * 调用前置条件：
 *   - 必须在 identityMiddleware 之后挂载（依赖 c.get('identity') 注入的 identityId）
 *
 * 通过条件：
 *   - users 表中 PK=identityId AND SK="SUBSCRIPTION" 的记录存在
 *   - 且 status 字段精确等于字符串 "active"
 *
 * 不通过响应：
 *   - 无订阅记录 / status !== "active"（如 expired / canceled / refunded 等任何非 active 值）
 *     → HTTP 403, body = { error: { code: "SUBSCRIPTION_REQUIRED", message, paywallTrigger: "import" } }
 *   - DynamoDB 调用异常（限流 / 网络 / 权限）
 *     → HTTP 503, body = { error: { code: "SUBSCRIPTION_CHECK_UNAVAILABLE", message } }
 *     设计要点：DB 故障**绝不**降级为"非会员"，否则会把会员错误识别成非会员（断他付费过的功能），
 *     远比让 iOS 重试一次更糟糕。
 *
 * 订阅判定口径：单值判定 status === "active"。
 * 本中间件**不吞异常**——异常路径必须把责任原样暴露给调用方，由 iOS 端按 503 重试。
 *
 * 与现有 SUBSCRIPTION 实体的字段定义对齐（webhooks.ts / auth.ts 同步路径）：
 *   - status: 'active' | 'expired'（webhooks 当前只写这两值，未来扩展也仅认 'active' 通过）
 *   - productId / expiresDate / autoRenewStatus 等其它字段本中间件不读取
 */

import type { MiddlewareHandler } from 'hono';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { getIdentity } from './auth.js';
import { getDocClient, USERS_TABLE } from '../lib/dynamodb.js';

/**
 * 标准化的非会员错误响应体
 *
 * iOS 端约定：收到 403 + errorCode === "SUBSCRIPTION_REQUIRED" 时，
 * 应自动弹 PaywallView（文案维持"启动阶段：会员 = 一键直达小店"，
 * 不展示任何抖音/导入字眼）。paywallTrigger 字段供端侧区分付费墙来源、做埋点。
 */
const SUBSCRIPTION_REQUIRED_BODY = {
  error: {
    code: 'SUBSCRIPTION_REQUIRED',
    message: '抖音导入是会员功能，请先开通小店会员',
    paywallTrigger: 'import' as const,
  },
} as const;

const SUBSCRIPTION_CHECK_UNAVAILABLE_BODY = {
  error: {
    code: 'SUBSCRIPTION_CHECK_UNAVAILABLE',
    message: '会员状态校验暂时不可用，请稍后重试',
  },
} as const;

export const requirePaidMiddleware: MiddlewareHandler = async (c, next) => {
  const { identityId } = getIdentity(c);
  const docClient = getDocClient();

  let status: string | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: 'SUBSCRIPTION' },
        ProjectionExpression: '#s',
        ExpressionAttributeNames: { '#s': 'status' },
      }),
    );
    // result.Item 可能为 undefined（无订阅记录），此时 status 为 undefined → 走 403 分支
    status = result.Item?.['status'] as string | undefined;
  } catch (err) {
    // DB 读取失败：不可降级为"非会员"，必须返回 503 把故障明确暴露给 iOS
    console.error(`[requirePaid] DynamoDB 读取失败 | identityId=${identityId.slice(-12)}`, err);
    return c.json(SUBSCRIPTION_CHECK_UNAVAILABLE_BODY, 503);
  }

  if (status !== 'active') {
    // 静默日志：非会员调用是预期行为，不写 warn/error
    console.log(
      `[requirePaid] 403 | identityId=${identityId.slice(-12)} | subscriptionStatus=${status ?? 'none'} | path=${c.req.path}`,
    );
    return c.json(SUBSCRIPTION_REQUIRED_BODY, 403);
  }

  await next();
  return;
};
