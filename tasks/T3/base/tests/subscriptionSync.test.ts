/**
 * POST /v1/auth/subscription 单元测试（2026-10-19）
 *
 * 覆盖：
 *   a) 永久会员（非消耗型）active：改用 Get Transaction Info 反查；行上打 lifetime、清 expiresDate；
 *      TXID 映射与原始交易号以 Apple 返回为准
 *   b) 永久会员反查失败 / 已撤销 → 403；Apple 故障 → 503 fail-closed；缺交易号 → 403
 *   c) 永久档的行不接受客户端 expired 声明降级（且不走订阅反查——订阅反查查不到非消耗型交易，
 *      会被误当成「Apple 确认已无权益」放行降级）
 *   d) 订阅档 active 同步不覆盖永久档行（条件写）
 *   e) 审查 HIGH 7：expired 写入带乐观锁（updatedAt 与防降级闸读到的一致才写），被抢先更新则放弃
 *   f) 原防降级闸行为不变（回归）
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockVerifySub = vi.fn();
const mockVerifyLifetime = vi.fn();

const hoisted = vi.hoisted(() => ({
  identity: { identityId: 'ap-southeast-1:11111111-2222-3333-4444-555555555555', cognitoSub: 'sub-1' } as {
    identityId: string; cognitoSub?: string;
  },
}));

vi.mock('../src/middleware/auth.js', () => ({
  identityMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('identity', hoisted.identity);
    await next();
  },
  requireWriteAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  getIdentity: (c: { get: (k: string) => unknown }) => c.get('identity'),
  resolveIdentityIdByToken: vi.fn(),
}));

vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return { ...actual, getDocClient: () => ({ send: mockSend }), USERS_TABLE: 'users', SHARED_TABLE: 'shared' };
});

vi.mock('../src/lib/appstore.js', () => ({
  verifySubscriptionWithApple: (...a: unknown[]) => mockVerifySub(...a),
  verifyLifetimePurchaseWithApple: (...a: unknown[]) => mockVerifyLifetime(...a),
}));
vi.mock('../src/lib/account-tombstone.js', () => ({ writeDeletionTombstone: vi.fn(), isDeletedIdentity: vi.fn() }));
vi.mock('../src/lib/s3.js', () => ({ uploadToS3: vi.fn(), deleteFromS3: vi.fn() }));
vi.mock('../src/lib/content-moderation.js', () => ({ moderateText: vi.fn(), moderateImage: vi.fn() }));
vi.mock('../src/lib/author-id.js', () => ({ ensureAuthorId: vi.fn() }));
vi.mock('../src/lib/post-utils.js', () => ({ processPostsForResponse: vi.fn() }));
vi.mock('../src/lib/apple-signin.js', () => ({ revokeAppleAuthorization: vi.fn() }));

import { Hono } from 'hono';
import { authRoute } from '../src/routes/auth.js';
import { LIFETIME_PRODUCT_ID } from '../src/lib/iap-products.js';

const UID = hoisted.identity.identityId;
const FUTURE = Date.now() + 30 * 86_400_000;

function sync(body: Record<string, unknown>) {
  const app = new Hono();
  app.route('/', authRoute);
  return app.request('/subscription', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const calls = () => mockSend.mock.calls.map(([cmd]) => cmd as Cmd);
const rowWrite = () => calls().find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key?.SK === 'SUBSCRIPTION');
const mappingPut = () => calls().find((c) => c.constructor.name === 'PutCommand' && String(c.input.Item?.PK).startsWith('TXID#'));

class ConditionalCheckFailedException extends Error {
  override name = 'ConditionalCheckFailedException';
}

/** 让 SUBSCRIPTION 行的读返回 row；其余命令成功 */
function existingRow(row: Record<string, unknown> | undefined) {
  mockSend.mockImplementation((cmd: Cmd) => {
    if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: row });
    return Promise.resolve({});
  });
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  mockVerifySub.mockReset();
  mockVerifyLifetime.mockReset();
});

// ============================================================
// a) / b) 永久会员 active
// ============================================================

describe('永久会员 active 同步', () => {
  it('按 transactionId 走 Get Transaction Info 反查；行上 lifetime=true、清 expiresDate、以 Apple 交易号为准', async () => {
    mockVerifyLifetime.mockResolvedValue({
      verified: true, environment: 'Production',
      productId: LIFETIME_PRODUCT_ID, originalTransactionId: 'otx-apple', transactionId: 'tx-apple',
    });
    const res = await sync({
      productId: LIFETIME_PRODUCT_ID, status: 'active',
      transactionId: 'tx-client', originalTransactionId: 'otx-client', expiresDate: FUTURE,
    });
    expect(res.status).toBe(200);
    expect(mockVerifyLifetime).toHaveBeenCalledWith('tx-client');
    expect(mockVerifySub).not.toHaveBeenCalled();

    const w = rowWrite()!;
    expect(w.input.UpdateExpression).toContain('lifetime = :lifetime');
    expect(w.input.UpdateExpression).toContain('REMOVE expiresDate');
    expect(w.input.ExpressionAttributeValues[':lifetime']).toBe(true);
    expect(w.input.ExpressionAttributeValues[':pid']).toBe(LIFETIME_PRODUCT_ID);
    expect(w.input.ExpressionAttributeValues[':otxid']).toBe('otx-apple');
    expect(w.input.ExpressionAttributeValues[':txid']).toBe('tx-apple');
    // 客户端传的 expiresDate 不落库
    expect(w.input.ExpressionAttributeValues[':exp']).toBeUndefined();
    // 永久档授予覆盖任何订阅档状态，不加条件
    expect(w.input.ConditionExpression).toBeUndefined();

    // 一单多绑防护照旧，映射键用 Apple 返回的原始交易号
    expect(mappingPut()!.input.Item.PK).toBe('TXID#otx-apple');
  });

  it('只带 originalTransactionId 也能反查', async () => {
    mockVerifyLifetime.mockResolvedValue({ verified: true, environment: 'Sandbox', productId: LIFETIME_PRODUCT_ID, originalTransactionId: 'otx-1' });
    const res = await sync({ productId: LIFETIME_PRODUCT_ID, status: 'active', originalTransactionId: 'otx-1' });
    expect(res.status).toBe(200);
    expect(mockVerifyLifetime).toHaveBeenCalledWith('otx-1');
  });

  it('一个交易号都没带 → 403，不调 Apple', async () => {
    const res = await sync({ productId: LIFETIME_PRODUCT_ID, status: 'active' });
    expect(res.status).toBe(403);
    expect(mockVerifyLifetime).not.toHaveBeenCalled();
    expect(rowWrite()).toBeUndefined();
  });

  it('Apple 说已撤销 / 商品不符 → 403 不落库', async () => {
    mockVerifyLifetime.mockResolvedValue({ verified: false, environment: 'Production', reason: 'REVOKED(reason=1)' });
    const res = await sync({ productId: LIFETIME_PRODUCT_ID, status: 'active', transactionId: 'tx' });
    expect(res.status).toBe(403);
    expect(rowWrite()).toBeUndefined();
  });

  it('Apple 故障 → 503 fail-closed', async () => {
    mockVerifyLifetime.mockRejectedValue(new Error('Apple 5xx'));
    const res = await sync({ productId: LIFETIME_PRODUCT_ID, status: 'active', transactionId: 'tx' });
    expect(res.status).toBe(503);
    expect(rowWrite()).toBeUndefined();
  });
});

// ============================================================
// c) 永久档不接受 expired 声明
// ============================================================

describe('永久档防降级', () => {
  it('行是 active 永久档 → 客户端 expired 声明一律忽略，也不走订阅反查', async () => {
    existingRow({ status: 'active', lifetime: true, originalTransactionId: 'otx-life', updatedAt: '2026-10-01T00:00:00Z' });
    const res = await sync({ productId: LIFETIME_PRODUCT_ID, status: 'expired' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { ignored: 'DOWNGRADE_REJECTED_LIFETIME' } });
    expect(mockVerifySub).not.toHaveBeenCalled();
    expect(rowWrite()).toBeUndefined();
  });

  it('订阅档的 expired 声明撞上永久档行也不降级', async () => {
    existingRow({ status: 'active', lifetime: true });
    const res = await sync({ productId: 'com.example.shopmap.monthly', status: 'expired' });
    expect(await res.json()).toMatchObject({ data: { ignored: 'DOWNGRADE_REJECTED_LIFETIME' } });
    expect(rowWrite()).toBeUndefined();
  });
});

// ============================================================
// d) 订阅 active 不覆盖永久档
// ============================================================

describe('订阅档 active 同步', () => {
  beforeEach(() => {
    mockVerifySub.mockResolvedValue({ verified: true, environment: 'Production', productId: 'monthly', expiresDate: FUTURE });
  });

  it('写入带「不是永久档」条件', async () => {
    await sync({ productId: 'monthly', status: 'active', originalTransactionId: 'otx-m' });
    const w = rowWrite()!;
    expect(w.input.ConditionExpression).toBe('attribute_not_exists(lifetime) OR lifetime <> :lifetimeTrue');
    expect(w.input.ExpressionAttributeValues[':lifetimeTrue']).toBe(true);
    expect(w.input.ExpressionAttributeValues[':exp']).toBe(FUTURE);
  });

  it('行已是永久档（条件失败）→ 200 ignored，不覆盖', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'UpdateCommand') return Promise.reject(new ConditionalCheckFailedException());
      return Promise.resolve({});
    });
    const res = await sync({ productId: 'monthly', status: 'active', originalTransactionId: 'otx-m' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { success: true, ignored: 'LIFETIME_ROW_PROTECTED' } });
  });
});

// ============================================================
// e) expired 乐观锁（HIGH 7）
// ============================================================

describe('expired 写入的乐观锁', () => {
  it('闸放行后按读到的 updatedAt 条件写；读用强一致', async () => {
    existingRow({ status: 'expired', expiresDate: 1, updatedAt: '2026-10-18T00:00:00.000Z' });
    const res = await sync({ productId: 'monthly', status: 'expired' });
    expect(res.status).toBe(200);
    const get = calls().find((c) => c.constructor.name === 'GetCommand')!;
    expect(get.input.ConsistentRead).toBe(true);
    const w = rowWrite()!;
    expect(w.input.ConditionExpression).toBe('updatedAt = :observedAt');
    expect(w.input.ExpressionAttributeValues[':observedAt']).toBe('2026-10-18T00:00:00.000Z');
  });

  it('读与写之间被 webhook 抢先更新（条件失败）→ 放弃降级，200 ignored', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'GetCommand') {
        return Promise.resolve({ Item: { status: 'expired', updatedAt: '2026-10-18T00:00:00.000Z' } });
      }
      if (cmd.constructor.name === 'UpdateCommand') return Promise.reject(new ConditionalCheckFailedException());
      return Promise.resolve({});
    });
    const res = await sync({ productId: 'monthly', status: 'expired' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { success: true, ignored: 'CONCURRENT_UPDATE' } });
  });

  it('读时还没有行 → 条件 attribute_not_exists(PK)（期间 webhook 建了行就不写）', async () => {
    existingRow(undefined);
    await sync({ productId: 'monthly', status: 'expired' });
    expect(rowWrite()!.input.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('真实落库故障仍然抛出（不被当成冲突吞掉）', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: undefined });
      if (cmd.constructor.name === 'UpdateCommand') return Promise.reject(new Error('ProvisionedThroughputExceeded'));
      return Promise.resolve({});
    });
    const res = await sync({ productId: 'monthly', status: 'expired' });
    expect(res.status).toBe(500);
  });
});

// ============================================================
// f) 原防降级闸回归
// ============================================================

describe('原防降级闸（回归）', () => {
  it('现有 active 未到期 + Apple 确认仍有效 → 忽略降级', async () => {
    existingRow({ status: 'active', expiresDate: FUTURE, originalTransactionId: 'otx-m', updatedAt: 'x' });
    mockVerifySub.mockResolvedValue({ verified: true, environment: 'Production' });
    const res = await sync({ productId: 'monthly', status: 'expired' });
    expect(await res.json()).toMatchObject({ data: { ignored: 'DOWNGRADE_REJECTED_STILL_ACTIVE' } });
    expect(rowWrite()).toBeUndefined();
  });

  it('现有 active 未到期 + Apple 确认已无权益 → 放行降级（带乐观锁）', async () => {
    existingRow({ status: 'active', expiresDate: FUTURE, originalTransactionId: 'otx-m', updatedAt: 'u1' });
    mockVerifySub.mockResolvedValue({ verified: false, environment: 'Production', reason: 'SUBSCRIPTION_NOT_ACTIVE(status=2)' });
    const res = await sync({ productId: 'monthly', status: 'expired' });
    expect(res.status).toBe(200);
    const w = rowWrite()!;
    expect(w.input.ExpressionAttributeValues[':status']).toBe('expired');
    expect(w.input.ConditionExpression).toBe('updatedAt = :observedAt');
  });
});
