/**
 * Webhook 路由
 *
 * POST /appstore — 接收 App Store Server Notifications V2（双轨过渡期保留，
 *   ASC 的 ASN URL 改指 RC 后由 RC Forwarding URL 回转到此，事件流不断）
 * POST /revenuecat — 接收 RevenueCat 事件（2026-08-25 RC 全接管迁移，逐步
 *   成为 SUBSCRIPTION 行的权威写者；接法沿另一个项目的 webhooks.ts）
 *
 * Apple 要求：
 * - 无论处理成功还是失败，始终返回 HTTP 200
 * - 非 200 响应会触发 Apple 重试机制（指数退避，最长 72 小时）
 * RC 相反：处理失败要回 5xx 让 RC 重投（它有自动重试机制）
 */

import { Hono } from 'hono';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, USERS_TABLE } from '../lib/dynamodb.js';
import { verifyAndDecodeNotification, type DecodedNotification } from '../lib/appstore.js';
import { getAppSecrets } from '../lib/secrets.js';
import { isDeletedIdentity } from '../lib/account-tombstone.js';
import { isLifetimeProduct } from '../lib/iap-products.js';

export const webhooksRoute = new Hono();

/** 期望的 Bundle ID */
const EXPECTED_BUNDLE_ID = 'com.example.shop-map-ios';

/**
 * /appstore 找不到 TXID 映射时的补查间隔（审查 MEDIUM 2，2026-10-19）。
 *
 * 旧实现在请求内同步等 60 秒再查一次：上游（Apple 直连或 RC 转发）的超时远小于 60 秒，必判投递
 * 失败并重投，每条重投又各占一个实例并发槽 60 秒，挤压正常 API。现在只做两次短补查（共约 3 秒，
 * 覆盖「客户端同步刚好晚到一两秒」的常见竞态），仍查不到就记日志后立即回 200。
 *
 * 取舍：查不到映射的这条 Apple 通知在本路径上被放弃（不落「待补」表——没有可靠的消费时机，
 * 等映射建好时该通知早已过时）。不丢状态的原因：RevenueCat webhook 是主链路（按 app_user_id 直写，
 * 不依赖映射），客户端 POST /v1/auth/subscription 带 Apple 反查兜底；且 RC 授予事件现在会顺手
 * 建 TXID 映射，同一笔交易之后的续订 / 退款通知都能在这里找到人。
 */
export const APPSTORE_MAPPING_RETRY_DELAYS_MS = [1_000, 2_000];

// ============================================================
// POST /appstore — 接收 Apple 通知
// ============================================================

webhooksRoute.post('/appstore', async (c) => {
  try {
    const body = await c.req.json<{ signedPayload?: string }>();

    if (!body.signedPayload) {
      console.warn('[Webhook/AppStore] 请求体缺少 signedPayload');
      return c.json({ status: 'ok' }, 200);
    }

    // 1. 验证签名并解析通知（三层 JWS 验证）
    const notification = await verifyAndDecodeNotification(body.signedPayload);
    const { payload, transactionInfo } = notification;

    console.log(
      `[Webhook/AppStore] 收到通知 | type=${payload.notificationType}` +
      `${payload.subtype ? ` subtype=${payload.subtype}` : ''}` +
      ` | env=${payload.data?.environment}` +
      ` | txId=${transactionInfo.originalTransactionId}` +
      ` | product=${transactionInfo.productId}` +
      ` | uuid=${payload.notificationUUID}`,
    );

    // 2. 验证 Bundle ID
    if (payload.data?.bundleId !== EXPECTED_BUNDLE_ID) {
      console.warn(
        `[Webhook/AppStore] Bundle ID 不匹配 | 收到=${payload.data?.bundleId} 期望=${EXPECTED_BUNDLE_ID}`,
      );
      return c.json({ status: 'ok' }, 200);
    }

    // 3. 通过 originalTransactionId 查找用户映射
    const docClient = getDocClient();
    const originalTxId = transactionInfo.originalTransactionId;

    if (!originalTxId) {
      console.warn('[Webhook/AppStore] transactionInfo 缺少 originalTransactionId');
      return c.json({ status: 'ok' }, 200);
    }

    const mappingKey = `TXID#${originalTxId}`;
    let mappingResult = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: mappingKey, SK: 'MAPPING' },
    }));

    // Apple 通知可能比客户端同步 / RC 授予更早到达：短间隔补查两次（见 APPSTORE_MAPPING_RETRY_DELAYS_MS）
    for (const delayMs of APPSTORE_MAPPING_RETRY_DELAYS_MS) {
      if (mappingResult.Item) break;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      mappingResult = await docClient.send(new GetCommand({
        TableName: USERS_TABLE,
        Key: { PK: mappingKey, SK: 'MAPPING' },
      }));
    }

    if (!mappingResult.Item) {
      console.warn(
        `[Webhook/AppStore] 补查后仍未找到交易映射，本条通知放弃（由 RC webhook / 客户端同步兜底）` +
        ` | type=${payload.notificationType} | originalTransactionId=${originalTxId}`,
      );
      return c.json({ status: 'ok' }, 200);
    }

    const identityId = mappingResult.Item['identityId'] as string;

    // 纵深防御：注销流程会条件删除 TXID 映射，正常情况走不到这里；
    // 万一映射残留仍指向已注销身份，照写会把订阅行复活
    if (await isDeletedIdentity(identityId)) {
      console.log(`[Webhook/AppStore] 账号已注销，跳过 | type=${payload.notificationType} | identityId=${identityId.slice(-12)}`);
      return c.json({ status: 'ok' }, 200);
    }

    // 4. 根据通知类型更新订阅状态
    await handleNotification(docClient, identityId, notification);

    console.log(
      `[Webhook/AppStore] 处理完成 | type=${payload.notificationType}` +
      ` | identityId=${identityId.slice(-12)}`,
    );

    return c.json({ status: 'ok' }, 200);
  } catch (err) {
    // 任何错误都返回 200，避免 Apple 重试
    console.error('[Webhook/AppStore] 处理异常:', err);
    return c.json({ status: 'ok' }, 200);
  }
});

// ============================================================
// 根据通知类型更新订阅状态
// ============================================================

async function handleNotification(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
  notification: DecodedNotification,
): Promise<void> {
  const { payload, transactionInfo, renewalInfo } = notification;
  const notificationType = payload.notificationType;
  const subtype = payload.subtype;
  const now = new Date().toISOString();
  const uid = identityId.slice(-12);

  try {
    switch (notificationType) {
      // ---- 订阅激活 ----
      case 'SUBSCRIBED': {
        // subtype: INITIAL_BUY | RESUBSCRIBE
        // 订阅档事件不覆盖永久会员行（protectLifetime），下同
        await updateSubscriptionStatus(docClient, identityId, {
          status: 'active',
          productId: transactionInfo.productId,
          expiresDate: transactionInfo.expiresDate,
          protectLifetime: true,
          updatedAt: now,
        });
        console.log(`[Webhook/AppStore] 订阅激活 | subtype=${subtype} | identityId=${uid}`);
        break;
      }

      // ---- 续订成功 ----
      case 'DID_RENEW': {
        await updateSubscriptionStatus(docClient, identityId, {
          status: 'active',
          productId: transactionInfo.productId,
          expiresDate: transactionInfo.expiresDate,
          protectLifetime: true,
          updatedAt: now,
        });
        console.log(`[Webhook/AppStore] 续订成功 | identityId=${uid}`);
        break;
      }

      // ---- 订阅过期（永久会员没有过期，不受影响）----
      case 'EXPIRED':
      case 'GRACE_PERIOD_EXPIRED': {
        await updateSubscriptionStatus(docClient, identityId, {
          status: 'expired',
          protectLifetime: true,
          updatedAt: now,
        });
        console.log(`[Webhook/AppStore] 订阅过期 | type=${notificationType} | identityId=${uid}`);
        break;
      }

      // ---- 退款 / 撤销 ----
      // 退的是永久会员 → 收回永久档；退的是订阅 → 只降订阅，不动永久档行
      case 'REFUND':
      case 'REVOKE': {
        const lifetimeRefund = isLifetimeProduct(transactionInfo.productId);
        await updateSubscriptionStatus(docClient, identityId, {
          status: 'expired',
          ...(lifetimeRefund ? { lifetime: false } : { protectLifetime: true }),
          updatedAt: now,
        });
        console.log(`[Webhook/AppStore] ${lifetimeRefund ? '永久会员' : '订阅'}撤销 | type=${notificationType} | identityId=${uid}`);
        break;
      }

      // ---- 自动续订状态变更 ----
      case 'DID_CHANGE_RENEWAL_STATUS': {
        if (renewalInfo) {
          await updateRenewalStatus(docClient, identityId, {
            autoRenewStatus: renewalInfo.autoRenewStatus,
            autoRenewProductId: renewalInfo.autoRenewProductId,
            updatedAt: now,
          });
          console.log(
            `[Webhook/AppStore] 续订状态变更 | autoRenew=${renewalInfo.autoRenewStatus}` +
            ` | subtype=${subtype} | identityId=${uid}`,
          );
        }
        break;
      }

      default: {
        console.log(
          `[Webhook/AppStore] 未处理的通知类型 | type=${notificationType}` +
          ` subtype=${subtype} | identityId=${uid}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof LifetimeProtectedError) {
      console.log(`[Webhook/AppStore] 永久会员行不受订阅事件影响，跳过 | type=${notificationType} | identityId=${uid}`);
      return;
    }
    throw err;
  }
}

// ============================================================
// DynamoDB 更新辅助函数
// ============================================================

/** 事件比行上记录的 lastEventAtMs 旧时抛出，调用方据此按「迟到事件」丢弃 */
class StaleEventError extends Error {}

/** 订阅档事件撞上永久会员行时抛出（protectLifetime），调用方按「跳过」处理 */
class LifetimeProtectedError extends Error {}

/**
 * 更新订阅状态（status, productId, expiresDate）
 *
 * 字段补齐（2026-09-16）：补写 identityId 与 createdAt=if_not_exists，与 auth.ts:694
 * 的客户端同步路径对齐。此前 webhook 路径 upsert 出的新行缺这两个字段，而
 * admin.ts:438 的订阅日增统计用 createdAt.substring(0,10) 分桶，缺字段即静默漏计。
 *
 * 可选 eventAtMs：传入时加条件写（仅 RC 路径用），拦截 RC 重投的迟到事件——
 * 无条件覆写会让「EXPIRATION 落库失败→重投」与其间的新 INITIAL_PURCHASE 竞态，
 * 把已付费用户打回 expired。Apple 路径不传，行为与改动前完全一致。
 *
 * 永久会员（2026-10-19）：
 *   - lifetime=true  → SET lifetime（永久档授予，调用方同时清 expiresDate）
 *   - lifetime=false → REMOVE lifetime（永久档退款收回）
 *   - protectLifetime → 加条件「行不是永久档」：订阅档的续订 / 过期 / 退款事件不能覆盖、降级永久会员。
 *     条件失败时回读一次区分原因：是永久档 → LifetimeProtectedError；否则 → StaleEventError
 */
async function updateSubscriptionStatus(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
  fields: {
    status: string;
    productId?: string;
    expiresDate?: number;
    /** true 时 REMOVE expiresDate（而非保留旧值），见下方 grant 分支注释 */
    clearExpiresDate?: boolean;
    /** TRANSFER 收件方继承 donor 的交易号；RC 授予事件写入事件自带的原始交易号 */
    originalTransactionId?: string;
    /** true=打永久会员标记；false=清掉永久会员标记；不传=不动 */
    lifetime?: boolean;
    /** true=行已是永久会员时不写（订阅档事件用） */
    protectLifetime?: boolean;
    environment?: string;
    eventAtMs?: number;
    updatedAt: string;
  },
): Promise<void> {
  const expressionParts = [
    '#status = :status',
    'updatedAt = :now',
    'identityId = :id',
    'createdAt = if_not_exists(createdAt, :now)',
  ];
  const removeParts: string[] = [];
  const attrNames: Record<string, string> = { '#status': 'status' };
  const attrValues: Record<string, unknown> = {
    ':status': fields.status,
    ':now': fields.updatedAt,
    ':id': identityId,
  };

  if (fields.productId) {
    expressionParts.push('productId = :pid');
    attrValues[':pid'] = fields.productId;
  }

  if (fields.expiresDate !== undefined) {
    expressionParts.push('expiresDate = :exp');
    attrValues[':exp'] = fields.expiresDate;
  } else if (fields.clearExpiresDate) {
    removeParts.push('expiresDate');
  }

  if (fields.environment) {
    expressionParts.push('environment = :env');
    attrValues[':env'] = fields.environment;
  }

  if (fields.originalTransactionId) {
    expressionParts.push('originalTransactionId = :otx');
    attrValues[':otx'] = fields.originalTransactionId;
  }

  if (fields.lifetime === true) {
    expressionParts.push('lifetime = :lifetime');
    attrValues[':lifetime'] = true;
  } else if (fields.lifetime === false) {
    removeParts.push('lifetime');
  }

  const conditions: string[] = [];
  if (fields.eventAtMs !== undefined) {
    expressionParts.push('lastEventAtMs = :evt');
    attrValues[':evt'] = fields.eventAtMs;
    conditions.push('attribute_not_exists(lastEventAtMs) OR lastEventAtMs < :evt');
  }
  if (fields.protectLifetime) {
    attrValues[':lifetimeTrue'] = true;
    conditions.push('attribute_not_exists(lifetime) OR lifetime <> :lifetimeTrue');
  }
  // 单个条件原样使用（与改动前的乱序守卫表达式一致）；多个条件各自加括号再 AND
  const conditionExpression = conditions.length === 0
    ? undefined
    : conditions.length === 1 ? conditions[0] : conditions.map((cond) => `(${cond})`).join(' AND ');

  const updateExpression =
    `SET ${expressionParts.join(', ')}` +
    (removeParts.length ? ` REMOVE ${removeParts.join(', ')}` : '');

  try {
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: 'SUBSCRIPTION' },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrValues,
      ...(conditionExpression && { ConditionExpression: conditionExpression }),
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      if (fields.protectLifetime) {
        // 回读只为区分原因（日志 / 响应用）；读失败按迟到事件处理——两种情况都是「不写、回 200」
        const row = await docClient.send(new GetCommand({
          TableName: USERS_TABLE,
          Key: { PK: identityId, SK: 'SUBSCRIPTION' },
          ProjectionExpression: 'lifetime',
          ConsistentRead: true,
        })).catch(() => null);
        if (row?.Item?.['lifetime'] === true) throw new LifetimeProtectedError();
      }
      throw new StaleEventError();
    }
    throw err;
  }
}

/**
 * RC 授予事件顺手建 TXID 映射（只建不改，2026-10-19）。
 *
 * /webhooks/appstore 只能经 TXID#<otx> 映射找到人，旧实现映射只由客户端同步建立——用户若从没
 * 同步成功（弱网、老版本），这笔交易之后的续订 / 退款通知在 Apple 链路上永远找不到人。RC 事件的
 * app_user_id 与 original_transaction_id 都是 RC 校验过收据的，可信。只在映射不存在时创建：
 * 已存在（无论属于谁）一律不动——归属变更只走 TRANSFER 的条件改写。失败只打日志，不影响事件处理。
 */
async function ensureTxidMapping(
  docClient: ReturnType<typeof getDocClient>,
  originalTransactionId: string,
  identityId: string,
  productId: string | undefined,
  now: string,
): Promise<void> {
  try {
    await docClient.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        PK: `TXID#${originalTransactionId}`,
        SK: 'MAPPING',
        identityId,
        ...(productId ? { productId } : {}),
        createdAt: now,
        source: 'revenuecat',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
    console.warn(`[Webhook/RC] 建 TXID 映射失败（不影响事件处理）| identityId=${identityId.slice(-12)}`, err);
  }
}

// ============================================================
// POST /revenuecat — 接收 RevenueCat 事件
// ============================================================

/** 授予权益的事件（含续订、恢复、试用转正、跨档变更） */
const RC_GRANT_EVENTS = new Set([
  'INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION',
  'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT',
  // 退款被撤销 → 权益恢复。在退款本身不收权益的旧实现里这条无从谈起，
  // 现在 CANCELLATION/CUSTOMER_SUPPORT 会收权益了，必须配上反向事件。
  'REFUND_REVERSED',
]);
/**
 * 收回权益的事件。
 *
 * 2026-09-16 按 RC 官方 event types 全表订正（此前两处与官方相悖）：
 * - 删 'REFUND'：RC **没有**这个事件类型，是臆造的死字符串。退款实际以
 *   CANCELLATION + cancel_reason='CUSTOMER_SUPPORT' 下发（见下方 isRefundCancellation），
 *   旧实现把它当 no-op，等于退款用户的会员一直留到自然到期。
 * - 删 'SUBSCRIPTION_PAUSED'：官方文档原文 "Don't revoke access on this event.
 *   Revoke access only on EXPIRATION with expiration reason SUBSCRIPTION_PAUSED."
 *   暂停在 Apple 侧是到期后才生效，提前收回会让付了钱的人当场失去权益。
 */
const RC_REVOKE_EVENTS = new Set(['EXPIRATION']);

/**
 * CANCELLATION 语义按 cancel_reason 分流：
 * - CUSTOMER_SUPPORT = 已退款 → 立即收回权益
 * - UNSUBSCRIBE / BILLING_ERROR / PRICE_INCREASE 等 = 只是关了自动续订，
 *   用户仍可用到期末 → no-op，等 EXPIRATION
 */
const isRefundCancellation = (e: RCEvent): boolean =>
  e.type === 'CANCELLATION' && e.cancel_reason === 'CUSTOMER_SUPPORT';

interface RCEvent {
  type?: string;
  id?: string;
  app_user_id?: string;
  product_id?: string;
  /** 原始交易号（Apple 的 originalTransactionId；非消耗型等于交易号本身） */
  original_transaction_id?: string | null;
  /** PRODUCT_CHANGE 专属：换到的新档位。product_id 在该事件里是**旧**档位 */
  new_product_id?: string | null;
  /** CANCELLATION 专属：取消原因，区分退款与单纯关闭自动续订 */
  cancel_reason?: string;
  expiration_at_ms?: number | null;
  /** 事件生成时刻，用作乱序/重投守卫的版本号 */
  event_timestamp_ms?: number;
  /** TRANSFER 事件专属：权益从哪些 app_user_id 移出 / 移入 */
  transferred_from?: string[] | null;
  transferred_to?: string[] | null;
  environment?: string;
}

/**
 * 形如 Cognito Identity ID（"ap-southeast-1:uuid"）的 app_user_id 才落库。
 * iOS 侧 Purchases.logIn 传的就是 identityId；$RCAnonymousID:… 等匿名 id
 * 说明购买发生在 logIn 之前（理论上被 ensureIdentity 挡住），无从落库。
 */
const isIdentityId = (s: string): boolean =>
  /^[a-z]{2}(-[a-z]+)+-\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

webhooksRoute.post('/revenuecat', async (c) => {
  // 鉴权：RC 后台 Webhooks 配置里的 Authorization 头原样比对（唯一身份校验，
  // 口令须够长；存 APP_SECRET_ARN 对应 Secret 的 REVENUECAT_WEBHOOK_AUTH 字段）
  let expected: string | undefined;
  try {
    expected = (await getAppSecrets())['REVENUECAT_WEBHOOK_AUTH'];
  } catch (err) {
    console.error('[Webhook/RC] 读取密钥失败', err);
    return c.json({ error: 'Secret unavailable' }, 500);
  }
  // 配置缺失与口令不符要分开：前者是我方故障，必须回 5xx 让 RC 重投、补配后自愈；
  // 混在 401 里会被 RC 当明确拒绝，重试耗尽即永久丢事件，且旧实现这条分支一行日志都不打。
  if (!expected) {
    console.error('[Webhook/RC] REVENUECAT_WEBHOOK_AUTH 未配置，拒绝处理（回 503 让 RC 重投）');
    return c.json({ error: 'Webhook auth not configured' }, 503);
  }
  const auth = c.req.header('authorization');
  if (auth !== expected) {
    // 只打长度不打值，便于排查「多带换行/误加 Bearer 前缀」这类配错
    console.warn(`[Webhook/RC] 鉴权失败 | hasHeader=${!!auth} | len=${auth?.length ?? 0}`);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = (await c.req.json().catch(() => null)) as { event?: RCEvent } | null;
  const event = body?.event;
  if (!event?.type) {
    return c.json({ error: 'Malformed event' }, 400);
  }

  const docClient = getDocClient();
  const now = new Date().toISOString();

  // TRANSFER：购买在两个 app_user_id 间转移（换机 restore / 登录切换身份等）。
  // 不处理会让 RC 侧与 SUBSCRIPTION 行脱节：新身份 iOS 显示会员、服务端行却是 expired。
  if (event.type === 'TRANSFER') {
    // 已注销身份一律剔除：对它们写任何东西（哪怕只是 expired）都会经 upsert 把
    // SUBSCRIPTION 行凭空复活（见 lib/account-tombstone.ts）
    const [donors, recipients] = await Promise.all([
      filterLiveIdentities((event.transferred_from ?? []).filter(isIdentityId)),
      filterLiveIdentities((event.transferred_to ?? []).filter(isIdentityId)),
    ]);

    // to 侧过滤后为空（典型：登出后原地 restore，RC 此刻仍是匿名身份）。旧实现照样
    // 执行 from 的收回，等于「只收不发」——该用户永久停在 expired 且无自愈路径
    // （后续事件的 app_user_id 都是那个匿名 id，会一路命中下方跳过分支）。
    if (recipients.length === 0) {
      console.warn(`[Webhook/RC] TRANSFER 无合法收件身份，整体跳过（不收回 donor 权益）| from=${donors.length} 个 | to=${(event.transferred_to ?? []).length} 个`);
      return c.json({ ok: true, skipped: 'transfer-no-recipient' });
    }
    // from 侧全是匿名 → 无从回读真实权益。此时授予即凭空发会员，交给客户端
    // POST /subscription（带 Apple 反查）去建立权益更安全。
    if (donors.length === 0) {
      console.warn(`[Webhook/RC] TRANSFER 无合法转出身份，不凭空授予 | to=${recipients.length} 个`);
      return c.json({ ok: true, skipped: 'transfer-no-donor' });
    }

    try {
      // TRANSFER 的 payload 官方只有 transferred_from/to/store/environment，**不带**
      // 到期时间与商品。旧实现据此无条件写 active：一笔早已过期的订阅换个身份就白拿
      // 会员，而且此后 RC 不会再发 EXPIRATION 来纠正。改为从 donor 行回读真实权益。
      const donorItems = await Promise.all(donors.map(async (uid) => (
        (await docClient.send(new GetCommand({
          TableName: USERS_TABLE,
          Key: { PK: uid, SK: 'SUBSCRIPTION' },
        }))).Item
      )));

      // donor 一行 SUBSCRIPTION 都没有 → **无证据**，什么都不写。
      // 不能落到下方的 carryActive=false 分支把收件方写成 expired：donor 行缺失最常见的原因
      // 恰恰是账号被注销删光了，而用户多半没去 Apple 取消订阅——他用同一 Apple ID 重新注册、
      // restore 触发这次 TRANSFER 时仍在付费。交给客户端 POST /subscription（带 Apple 反查）建立权益。
      if (!donorItems.some(Boolean)) {
        console.warn(`[Webhook/RC] TRANSFER 转出方无订阅行，无证据不写收件方 | from=${donors.length} 个 → to=${recipients.length} 个`);
        return c.json({ ok: true, skipped: 'transfer-donor-row-missing' });
      }

      // 永久会员行优先（没有到期日，按到期日排序会被排到最后）
      const rankOf = (it: Record<string, unknown>): number =>
        it['lifetime'] === true ? Number.POSITIVE_INFINITY : Number(it['expiresDate'] ?? 0);
      const best = donorItems
        .filter((it): it is Record<string, unknown> => !!it && it['status'] === 'active')
        .sort((a, b) => rankOf(b) - rankOf(a))[0];
      const bestIsLifetime = best?.['lifetime'] === true;
      const bestExpires = !bestIsLifetime && typeof best?.['expiresDate'] === 'number'
        ? (best['expiresDate'] as number)
        : undefined;
      // 到期日缺失**不**等于已过期：与 auth.ts:632 防降级闸的既有口径一致
      //（线上 625 行 SUBSCRIPTION 里有 83 行没有 expiresDate，多为历史数据）。
      // 判无效只认「有到期日且确已过期」，其余交由后续 RENEWAL/EXPIRATION 修正。
      const carryActive = !!best && (bestExpires === undefined || bestExpires > Date.now());

      // 先授予后收回：中途失败时宁可短暂多授予，也不要让用户两头都无权益
      for (const uid of recipients) {
        await applyIgnoringStale(docClient, uid, carryActive
          ? {
            status: 'active',
            productId: best?.['productId'] as string | undefined,
            expiresDate: bestExpires,
            // donor 本就没有到期日时别给收件方留旧值，保持「缺字段=进闸保护」
            clearExpiresDate: bestExpires === undefined,
            // 继承交易号：不带的话连续两次转移（A→B→C）时，B 行上没有 otx，
            // 第二次的映射改写找不到交易号而静默失效，双轨再次分叉
            originalTransactionId: best?.['originalTransactionId'] as string | undefined,
            // 转过来的是永久会员 → 收件方也是永久档；转过来的是订阅 → 不覆盖收件方自己的永久档
            ...(bestIsLifetime ? { lifetime: true } : { protectLifetime: true }),
            environment: event.environment,
            eventAtMs: event.event_timestamp_ms,
            updatedAt: now,
          }
          : {
            status: 'expired',
            clearExpiresDate: true,
            protectLifetime: true,
            environment: event.environment,
            eventAtMs: event.event_timestamp_ms,
            updatedAt: now,
          });
      }
      for (const uid of donors) {
        // 购买整体转走：转出方连永久档一起收回
        await applyIgnoringStale(docClient, uid, {
          status: 'expired',
          clearExpiresDate: true,
          lifetime: false,
          environment: event.environment,
          eventAtMs: event.event_timestamp_ms,
          updatedAt: now,
        });
      }

      // 把 TXID 映射改指新身份，否则双轨会就「这笔交易属于谁」长期分叉：
      //   /appstore 只认 TXID#<otx> 的 MAPPING（webhooks.ts:69），而该映射由
      //   auth.ts:660 以**第一个**同步过的 identityId 永久绑定，转移后仍指向旧身份。
      // 不改的话每次续订 Apple 的 DID_RENEW 经 RC Forwarding 回转，都会把旧身份
      // 重新写成 active（一笔订阅点亮两个账号）；同时新身份走 POST /subscription 会
      // 命中 auth.ts:671 的一单多绑条件写返回 403 TRANSACTION_ALREADY_BOUND，
      // 客户端兜底轨也跟着废掉。TRANSFER 的 payload 不带 original_transaction_id，
      // 但 donor 行上有，正好用它。
      // **必须条件写**：otx 来自 donor 行的 originalTransactionId，而那个字段是
      // 客户端经 POST /v1/auth/subscription 上报的——expired 分支不做 Apple 反查、
      // 映射条件写失败还会被吞掉（auth.ts:674-690），所以任何人都能把**别人的** otx
      // 写进自己的 SUBSCRIPTION 行。无条件改写等于：攻击者先认领受害者的 otx，
      // 再触发一次 TRANSFER，就能把受害者的交易映射改到自己名下（不可逆越权）。
      // 加 `identityId = :donor` 后，只有「这条映射当前确实属于本次转出方」才改，
      // 认领来的脏 otx 一律条件失败跳过。
      const recipient = recipients[0];
      let remapped = 0;
      for (const donorItem of donorItems) {
        const otx = donorItem?.['originalTransactionId'];
        const donorUid = donorItem?.['PK'];
        if (typeof otx !== 'string' || !otx || typeof donorUid !== 'string') continue;
        try {
          await docClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { PK: `TXID#${otx}`, SK: 'MAPPING' },
            UpdateExpression: 'SET identityId = :to, updatedAt = :now',
            ConditionExpression: 'identityId = :donor',
            ExpressionAttributeValues: { ':to': recipient, ':donor': donorUid, ':now': now },
          }));
          remapped++;
        } catch (err: unknown) {
          if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
            // 映射不属于本次 donor（不存在，或 otx 是认领来的）→ 跳过，不是错误
            console.warn(`[Webhook/RC] TRANSFER 跳过映射改写：TXID#${otx} 不属于本次转出方`);
            continue;
          }
          // 真故障（限流 / 5xx）→ 抛给外层回 500 让 RC 重投。只记日志的话这笔订阅会永久
          // 停在分叉态（无自愈、无告警）。重投是安全的：整个 TRANSFER 幂等——收件方 / 转出方
          // 写入有 lastEventAtMs 守卫（同一事件重放即 stale 跳过），映射改写本身是条件写
          //（已改过的那次条件不再成立即跳过），重投只会补完上次没做完的部分。
          throw err;
        }
      }

      console.log(`[Webhook/RC] TRANSFER | ${donors.length} → ${recipients.length} | carryActive=${carryActive} | 映射改指=${remapped} 条 | env=${event.environment}`);
      return c.json({ ok: true });
    } catch (err) {
      console.error(`[Webhook/RC] TRANSFER 落库失败 | from=${donors.length} 个 → to=${recipients.length} 个`, err);
      return c.json({ error: 'Failed to transfer entitlement' }, 500);
    }
  }

  if (!event.app_user_id) {
    return c.json({ error: 'Malformed event' }, 400);
  }

  // 匿名/非法 id：返回 200 避免 RC 重投（这类事件对我们无意义）
  if (!isIdentityId(event.app_user_id)) {
    console.log(`[Webhook/RC] 非 identityId 的 app_user_id，跳过 | type=${event.type} | id=${event.app_user_id.slice(0, 24)}`);
    return c.json({ ok: true, skipped: 'anonymous' });
  }

  const identityId = event.app_user_id;
  const grant = RC_GRANT_EVENTS.has(event.type);
  const revoke = RC_REVOKE_EVENTS.has(event.type) || isRefundCancellation(event);
  if (!grant && !revoke) {
    // BILLING_ISSUE / 非退款的 CANCELLATION / SUBSCRIPTION_PAUSED 等：记录不改权益
    console.log(`[Webhook/RC] no-op 事件 | type=${event.type}${event.cancel_reason ? ` | reason=${event.cancel_reason}` : ''} | identityId=${identityId.slice(-12)}`);
    return c.json({ ok: true, noop: event.type });
  }

  try {
    // 账号已注销：RC 不知道，仍会按旧 identityId 发续订事件。照写的话 upsert 会凭空
    // 重建一条 active 的 SUBSCRIPTION 行——已删数据复活。放在 no-op 分支之后：不写库的事件不必多读一次
    if (await isDeletedIdentity(identityId)) {
      console.log(`[Webhook/RC] 账号已注销，跳过 | type=${event.type} | identityId=${identityId.slice(-12)}`);
      return c.json({ ok: true, skipped: 'deleted' });
    }

    // 原始交易号（审查 MEDIUM 4）：旧实现普通授予路径不写，RC 建出的行没有 otx——
    // 客户端 expired 声明进防降级闸时无凭证可反查、注销时也删不到 TXID 映射
    const originalTransactionId = event.original_transaction_id || undefined;

    if (revoke) {
      // 永久会员（2026-10-19）：只有「退的就是永久会员」才收回永久档；
      // EXPIRATION（永久档不会过期）与订阅档的退款都不能动永久档行 → protectLifetime
      const lifetimeRefund = isRefundCancellation(event) && isLifetimeProduct(event.product_id);
      // 一并清 expiresDate：status 与 expiresDate 必须自洽。残留一个过去的到期戳，
      // 会让 auth.ts:632 的防降级闸（curExpires 已过期即不进闸）直接被跳过。
      await updateSubscriptionStatus(docClient, identityId, {
        status: 'expired',
        clearExpiresDate: true,
        ...(lifetimeRefund ? { lifetime: false } : { protectLifetime: true }),
        environment: event.environment,
        eventAtMs: event.event_timestamp_ms,
        updatedAt: now,
      });
    } else {
      // PRODUCT_CHANGE 的 product_id 是**旧**档位，新档位在 new_product_id
      const productId = event.new_product_id ?? event.product_id;
      // TEMPORARY_ENTITLEMENT_GRANT 是 RC 连不上商店时发的**临时**权益（带短到期日），哪怕商品是
      // 永久会员也只能按普通授予记：打成永久档后，临时权益到期的 EXPIRATION 会被永久档保护挡掉，
      // 一笔没验证过的购买就成了永久会员
      if (isLifetimeProduct(productId) && event.type !== 'TEMPORARY_ENTITLEMENT_GRANT') {
        // 永久会员授予（NON_RENEWING_PURCHASE / 退款撤销 REFUND_REVERSED 等）：
        // 打 lifetime 标记、不写到期日（非消耗型 expiration_at_ms 为 null），覆盖任何订阅档状态
        await updateSubscriptionStatus(docClient, identityId, {
          status: 'active',
          productId,
          clearExpiresDate: true,
          lifetime: true,
          originalTransactionId,
          environment: event.environment,
          eventAtMs: event.event_timestamp_ms,
          updatedAt: now,
        });
      } else {
        const expiresDate = event.expiration_at_ms ?? undefined;
        await updateSubscriptionStatus(docClient, identityId, {
          status: 'active',
          productId,
          expiresDate,
          // 拿不到到期日时显式清掉旧值，而不是原样保留。保留一个过去的时间戳比没有
          // 这个字段更危险：缺字段时防降级闸会保护，残留过期值则闸被跳过。
          clearExpiresDate: expiresDate === undefined,
          originalTransactionId,
          // 用户先订阅后买断时，订阅档的续订事件不能把永久档行改回订阅
          protectLifetime: true,
          environment: event.environment,
          eventAtMs: event.event_timestamp_ms,
          updatedAt: now,
        });
      }
      if (originalTransactionId) {
        await ensureTxidMapping(docClient, originalTransactionId, identityId, productId ?? undefined, now);
      }
    }
  } catch (err) {
    if (err instanceof StaleEventError) {
      // 迟到/重投的旧事件，行上已有更新的状态——丢弃即正确语义，回 200 免得 RC 再投
      console.log(`[Webhook/RC] 迟到事件已丢弃 | type=${event.type} | eventAt=${event.event_timestamp_ms} | identityId=${identityId.slice(-12)}`);
      return c.json({ ok: true, skipped: 'stale' });
    }
    if (err instanceof LifetimeProtectedError) {
      // 订阅档事件撞上永久会员行：永久档优先，跳过即正确语义
      console.log(`[Webhook/RC] 永久会员行不受订阅事件影响，跳过 | type=${event.type} | identityId=${identityId.slice(-12)}`);
      return c.json({ ok: true, skipped: 'lifetime' });
    }
    // 5xx 让 RC 重投（它有重试机制，别把可恢复故障吞掉——与 Apple webhook 语义相反）
    console.error(`[Webhook/RC] 落库失败 | type=${event.type} | identityId=${identityId.slice(-12)}`, err);
    return c.json({ error: 'Failed to record entitlement' }, 500);
  }

  console.log(`[Webhook/RC] 处理完成 | type=${event.type} | env=${event.environment} | identityId=${identityId.slice(-12)} | ${grant ? 'granted' : 'revoked'}`);
  return c.json({ ok: true });
});

/** 剔除已注销的身份（并发查墓碑） */
async function filterLiveIdentities(ids: string[]): Promise<string[]> {
  const deleted = await Promise.all(ids.map((id) => isDeletedIdentity(id)));
  return ids.filter((_, i) => !deleted[i]);
}

/**
 * TRANSFER 的批量写入用：迟到事件跳过该条、不中断整批（整批回滚反而会留下
 * donor 已收回、recipient 未授予的半截状态）。
 */
async function applyIgnoringStale(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
  fields: Parameters<typeof updateSubscriptionStatus>[2],
): Promise<void> {
  try {
    await updateSubscriptionStatus(docClient, identityId, fields);
  } catch (err) {
    if (err instanceof StaleEventError) {
      console.log(`[Webhook/RC] TRANSFER 迟到事件跳过该身份 | identityId=${identityId.slice(-12)}`);
      return;
    }
    if (err instanceof LifetimeProtectedError) {
      console.log(`[Webhook/RC] TRANSFER 收件方已是永久会员，跳过 | identityId=${identityId.slice(-12)}`);
      return;
    }
    throw err;
  }
}

/** 更新自动续订状态 */
async function updateRenewalStatus(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
  fields: {
    autoRenewStatus?: number;
    autoRenewProductId?: string;
    updatedAt: string;
  },
): Promise<void> {
  const expressionParts = ['updatedAt = :now'];
  const attrValues: Record<string, unknown> = { ':now': fields.updatedAt };

  if (fields.autoRenewStatus !== undefined) {
    expressionParts.push('autoRenewStatus = :ars');
    attrValues[':ars'] = fields.autoRenewStatus;
  }
  if (fields.autoRenewProductId) {
    expressionParts.push('autoRenewProductId = :arp');
    attrValues[':arp'] = fields.autoRenewProductId;
  }

  await docClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'SUBSCRIPTION' },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeValues: attrValues,
  }));
}
