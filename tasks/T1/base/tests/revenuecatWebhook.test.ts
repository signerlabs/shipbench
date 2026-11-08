/**
 * POST /webhooks/revenuecat 单元测试
 *
 * 覆盖 2026-09-16 按 RevenueCat 官方 event types 全表订正的那组语义修复：
 *   a) 鉴权：Secret 字段缺失 → 503（让 RC 重投）；口令不符 → 401
 *   b) 退款：RC 无 REFUND 事件，退款走 CANCELLATION + cancel_reason=CUSTOMER_SUPPORT
 *   c) SUBSCRIPTION_PAUSED 不收权益（官方：只在 EXPIRATION 收）
 *   d) PRODUCT_CHANGE 落 new_product_id 而非旧档位 product_id
 *   e) 乱序/重投：条件写失败 → 200 skipped:stale，不覆盖更新的状态
 *   f) TRANSFER：不凭空授予，从 donor 行回读真实权益；缺收件方/转出方时整体跳过
 *   g) 字段自洽：补 identityId/createdAt；拿不到到期日时 REMOVE expiresDate
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock 外部依赖（必须在 import route 之前完成）
// ============================================================

const mockSend = vi.fn();
const mockGetAppSecrets = vi.fn();

vi.mock('../src/lib/dynamodb.js', () => ({
  getDocClient: () => ({ send: mockSend }),
  USERS_TABLE: 'shopmap-users-test',
  VIDEOS_TABLE: 'shopmap-videos-test',
  SHARED_TABLE: 'shopmap-shared-test',
}));

vi.mock('../src/lib/secrets.js', () => ({
  getAppSecrets: () => mockGetAppSecrets(),
}));

vi.mock('../src/lib/appstore.js', () => ({
  verifyAndDecodeNotification: vi.fn(),
}));

/** 墓碑：默认所有身份都活着，个别用例把指定 identityId 标为已注销 */
const deletedIds = new Set<string>();
vi.mock('../src/lib/account-tombstone.js', () => ({
  isDeletedIdentity: async (id: string) => deletedIds.has(id),
  writeDeletionTombstone: vi.fn(),
}));

import { webhooksRoute } from '../src/routes/webhooks.js';

// ============================================================
// 夹具
// ============================================================

const AUTH = 'test-webhook-password-0123456789';
const UID = 'ap-southeast-1:11111111-2222-3333-4444-555555555555';
const UID2 = 'ap-southeast-1:99999999-8888-7777-6666-555555555555';
const FUTURE = Date.now() + 30 * 86_400_000;
const PAST = Date.now() - 30 * 86_400_000;

/** 只发 event，其余字段按需覆盖 */
function post(event: Record<string, unknown>, auth: string | null = AUTH) {
  return webhooksRoute.request('/revenuecat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth === null ? {} : { Authorization: auth }),
    },
    body: JSON.stringify({ event }),
  });
}

/** 取出所有 UpdateCommand 的 input，按调用顺序 */
function updates() {
  return mockSend.mock.calls
    .map(([cmd]) => cmd.input)
    .filter((i: Record<string, unknown>) => 'UpdateExpression' in i);
}

class ConditionalCheckFailedException extends Error {
  override name = 'ConditionalCheckFailedException';
}

beforeEach(() => {
  deletedIds.clear();
  mockSend.mockReset();
  mockGetAppSecrets.mockReset();
  mockGetAppSecrets.mockResolvedValue({ REVENUECAT_WEBHOOK_AUTH: AUTH });
  mockSend.mockResolvedValue({});
});

// ============================================================
// a) 鉴权
// ============================================================

describe('鉴权', () => {
  it('Secret 里没有 REVENUECAT_WEBHOOK_AUTH 字段 → 503，让 RC 重投而不是永久丢事件', async () => {
    mockGetAppSecrets.mockResolvedValue({ GEMINI_API_KEY: 'x' });
    const res = await post({ type: 'RENEWAL', app_user_id: UID });
    expect(res.status).toBe(503);
    expect(updates()).toHaveLength(0);
  });

  it('口令不符 → 401', async () => {
    const res = await post({ type: 'RENEWAL', app_user_id: UID }, 'wrong-password');
    expect(res.status).toBe(401);
  });

  it('完全没带 Authorization 头 → 401', async () => {
    const res = await post({ type: 'RENEWAL', app_user_id: UID }, null);
    expect(res.status).toBe(401);
  });

  it('读 Secret 抛错 → 500', async () => {
    mockGetAppSecrets.mockRejectedValue(new Error('SecretsManager down'));
    const res = await post({ type: 'RENEWAL', app_user_id: UID });
    expect(res.status).toBe(500);
  });
});

// ============================================================
// b) 退款：CANCELLATION + cancel_reason
// ============================================================

describe('退款语义', () => {
  it('CANCELLATION + CUSTOMER_SUPPORT（= 已退款）→ 收回权益', async () => {
    const res = await post({
      type: 'CANCELLATION', app_user_id: UID,
      cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: 1_700_000_000_000,
    });
    expect(res.status).toBe(200);
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':status']).toBe('expired');
    // status 与 expiresDate 必须自洽，残留过期戳会让客户端防降级闸被跳过
    expect(u.UpdateExpression).toContain('REMOVE expiresDate');
  });

  it('CANCELLATION + UNSUBSCRIBE（只是关自动续订）→ no-op，用到期末', async () => {
    const res = await post({
      type: 'CANCELLATION', app_user_id: UID, cancel_reason: 'UNSUBSCRIBE',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noop: 'CANCELLATION' });
    expect(updates()).toHaveLength(0);
  });

  it('不带 cancel_reason 的 CANCELLATION → no-op（保守，不误收权益）', async () => {
    await post({ type: 'CANCELLATION', app_user_id: UID });
    expect(updates()).toHaveLength(0);
  });

  it('臆造的 REFUND 事件类型不再被当作收回信号', async () => {
    const res = await post({ type: 'REFUND', app_user_id: UID });
    expect(await res.json()).toMatchObject({ noop: 'REFUND' });
    expect(updates()).toHaveLength(0);
  });

  it('REFUND_REVERSED（退款被撤销）→ 恢复权益', async () => {
    await post({
      type: 'REFUND_REVERSED', app_user_id: UID,
      product_id: 'monthly.6', expiration_at_ms: FUTURE,
    });
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
  });
});

// ============================================================
// c) SUBSCRIPTION_PAUSED
// ============================================================

describe('SUBSCRIPTION_PAUSED', () => {
  it('不收权益（官方：只在 EXPIRATION 收，暂停到期后才生效）', async () => {
    const res = await post({ type: 'SUBSCRIPTION_PAUSED', app_user_id: UID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ noop: 'SUBSCRIPTION_PAUSED' });
    expect(updates()).toHaveLength(0);
  });

  it('EXPIRATION 仍然正常收权益', async () => {
    await post({ type: 'EXPIRATION', app_user_id: UID });
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':status']).toBe('expired');
  });
});

// ============================================================
// d) PRODUCT_CHANGE
// ============================================================

describe('PRODUCT_CHANGE', () => {
  it('落 new_product_id 而不是旧档位 product_id', async () => {
    await post({
      type: 'PRODUCT_CHANGE', app_user_id: UID,
      product_id: 'monthly.6', new_product_id: 'yearly.58',
      expiration_at_ms: FUTURE,
    });
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':pid']).toBe('yearly.58');
  });

  it('没有 new_product_id 时回落到 product_id', async () => {
    await post({
      type: 'RENEWAL', app_user_id: UID,
      product_id: 'monthly.6', expiration_at_ms: FUTURE,
    });
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':pid']).toBe('monthly.6');
  });
});

// ============================================================
// e) 乱序 / 重投守卫
// ============================================================

describe('乱序与重投守卫', () => {
  it('带 event_timestamp_ms 时写入加条件表达式', async () => {
    await post({
      type: 'RENEWAL', app_user_id: UID,
      expiration_at_ms: FUTURE, event_timestamp_ms: 1_700_000_000_000,
    });
    const [u] = updates();
    // 乱序守卫 + 永久会员保护（2026-10-19：订阅档事件不覆盖永久档行）两个条件同时在
    expect(u.ConditionExpression).toBe(
      '(attribute_not_exists(lastEventAtMs) OR lastEventAtMs < :evt)'
      + ' AND (attribute_not_exists(lifetime) OR lifetime <> :lifetimeTrue)',
    );
    expect(u.ExpressionAttributeValues[':evt']).toBe(1_700_000_000_000);
  });

  it('迟到的旧事件被条件写拦下 → 200 skipped:stale（不让 RC 无谓重投）', async () => {
    mockSend.mockRejectedValue(new ConditionalCheckFailedException());
    const res = await post({
      type: 'EXPIRATION', app_user_id: UID, event_timestamp_ms: 1_600_000_000_000,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'stale' });
  });

  it('真实落库故障仍回 500 让 RC 重投', async () => {
    mockSend.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));
    const res = await post({ type: 'EXPIRATION', app_user_id: UID });
    expect(res.status).toBe(500);
  });
});

// ============================================================
// f) TRANSFER
// ============================================================

describe('TRANSFER', () => {
  /** donor 行的 Get 返回值 */
  function donorRow(item: Record<string, unknown> | undefined) {
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      return Promise.resolve({ Item: item });
    });
  }

  it('donor 仍有效 → 携带真实 expiresDate/productId 授予收件方', async () => {
    donorRow({ status: 'active', expiresDate: FUTURE, productId: 'yearly.58' });
    const res = await post({
      type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2],
    });
    expect(res.status).toBe(200);
    const us = updates();
    // 先授予后收回：中途失败宁可短暂多授予，不要两头都无权益
    expect(us[0].Key.PK).toBe(UID2);
    expect(us[0].ExpressionAttributeValues[':status']).toBe('active');
    expect(us[0].ExpressionAttributeValues[':exp']).toBe(FUTURE);
    expect(us[0].ExpressionAttributeValues[':pid']).toBe('yearly.58');
    expect(us[1].Key.PK).toBe(UID);
    expect(us[1].ExpressionAttributeValues[':status']).toBe('expired');
  });

  it('donor 早已过期 → 收件方写 expired，不白送会员', async () => {
    donorRow({ status: 'active', expiresDate: PAST, productId: 'monthly.6' });
    await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    const us = updates();
    expect(us[0].Key.PK).toBe(UID2);
    expect(us[0].ExpressionAttributeValues[':status']).toBe('expired');
    expect(us[0].UpdateExpression).toContain('REMOVE expiresDate');
  });

  it('donor 行不存在 → 无证据，什么都不写（既不凭空授予，也不误写 expired）', async () => {
    // donor 行缺失最常见的原因是账号已注销被删光，而用户多半没去 Apple 取消订阅：
    // 他用同一 Apple ID 重新注册、restore 触发 TRANSFER 时仍在付费，写 expired 就是误杀
    donorRow(undefined);
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(await res.json()).toMatchObject({ skipped: 'transfer-donor-row-missing' });
    expect(updates()).toHaveLength(0);
  });

  it('收件方已注销 → 剔除，不对其写入（否则 upsert 把订阅行复活）', async () => {
    deletedIds.add(UID2);
    donorRow({ PK: UID, status: 'active', expiresDate: FUTURE });
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(await res.json()).toMatchObject({ skipped: 'transfer-no-recipient' });
    expect(updates()).toHaveLength(0);
  });

  it('转出方已注销 → 剔除，不给已删身份写 expired 复活行', async () => {
    deletedIds.add(UID);
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(await res.json()).toMatchObject({ skipped: 'transfer-no-donor' });
    expect(updates()).toHaveLength(0);
  });

  it('donor active 但没有 expiresDate → 仍视为有效（与 auth.ts 防降级闸同口径），且不留旧到期戳', async () => {
    donorRow({ status: 'active', productId: 'monthly.6' });
    await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    const [u] = updates();
    expect(u.Key.PK).toBe(UID2);
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
    expect(u.UpdateExpression).toContain('REMOVE expiresDate');
  });

  it('donor 是 expired → 收件方写 expired', async () => {
    donorRow({ status: 'expired', expiresDate: PAST });
    await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(updates()[0].ExpressionAttributeValues[':status']).toBe('expired');
  });

  it('收件方全是匿名 id → 整体跳过，绝不「只收不发」', async () => {
    const res = await post({
      type: 'TRANSFER',
      transferred_from: [UID],
      transferred_to: ['$RCAnonymousID:abc123'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'transfer-no-recipient' });
    // donor 的权益一条都不能动
    expect(updates()).toHaveLength(0);
  });

  it('转出方全是匿名 id → 不凭空授予收件方', async () => {
    const res = await post({
      type: 'TRANSFER',
      transferred_from: ['$RCAnonymousID:abc123'],
      transferred_to: [UID2],
    });
    expect(await res.json()).toMatchObject({ skipped: 'transfer-no-donor' });
    expect(updates()).toHaveLength(0);
  });

  it('把 donor 的 TXID 映射改指收件方（否则双轨就「这笔交易属于谁」长期分叉）', async () => {
    donorRow({ PK: UID, status: 'active', expiresDate: FUTURE, originalTransactionId: '370002646667986' });
    await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    const mapping = updates().find((u) => String(u.Key.PK).startsWith('TXID#'));
    expect(mapping).toBeDefined();
    expect(mapping.Key).toEqual({ PK: 'TXID#370002646667986', SK: 'MAPPING' });
    expect(mapping.ExpressionAttributeValues[':to']).toBe(UID2);
  });

  it('映射改写必须条件写：只改「当前确实属于本次转出方」的映射（防 otx 认领越权）', async () => {
    donorRow({ PK: UID, status: 'active', expiresDate: FUTURE, originalTransactionId: 'otx-victim' });
    await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    const mapping = updates().find((u) => String(u.Key.PK).startsWith('TXID#'));
    expect(mapping.ConditionExpression).toBe('identityId = :donor');
    expect(mapping.ExpressionAttributeValues[':donor']).toBe(UID);
  });

  it('收件方继承 donor 的交易号（否则 A→B→C 第二次转移时映射改写找不到 otx）', async () => {
    donorRow({ PK: UID, status: 'active', expiresDate: FUTURE, originalTransactionId: 'otx-chain' });
    await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    const recipientWrite = updates().find((u) => u.Key.PK === UID2 && u.Key.SK === 'SUBSCRIPTION');
    expect(recipientWrite.ExpressionAttributeValues[':otx']).toBe('otx-chain');
  });

  it('映射改写遇真故障 → 500 让 RC 重投自愈（整个 TRANSFER 幂等，重投安全）', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, any> }) => {
      if (String(cmd.input.Key?.PK).startsWith('TXID#')) {
        return Promise.reject(new Error('ProvisionedThroughputExceededException'));
      }
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      return Promise.resolve({
        Item: { PK: UID, status: 'active', expiresDate: FUTURE, originalTransactionId: 'otx-1' },
      });
    });
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(res.status).toBe(500);
  });

  it('映射不属于本次转出方（条件失败）→ 跳过且不影响 TRANSFER 成功', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, any> }) => {
      if (String(cmd.input.Key?.PK).startsWith('TXID#')) {
        const err = new Error('conditional');
        err.name = 'ConditionalCheckFailedException';
        return Promise.reject(err);
      }
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      return Promise.resolve({
        Item: { PK: UID, status: 'active', expiresDate: FUTURE, originalTransactionId: 'otx-claimed' },
      });
    });
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(res.status).toBe(200);
  });

  it('donor 行没有 originalTransactionId → 不写映射，也不报错', async () => {
    donorRow({ status: 'active', expiresDate: FUTURE });
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(res.status).toBe(200);
    expect(updates().some((u) => String(u.Key.PK).startsWith('TXID#'))).toBe(false);
  });

  it('落库抛错 → 500 让 RC 重投', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.reject(new Error('boom'));
      return Promise.resolve({ Item: { status: 'active', expiresDate: FUTURE } });
    });
    const res = await post({
      type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2],
    });
    expect(res.status).toBe(500);
  });
});

// ============================================================
// g) 字段自洽与身份过滤
// ============================================================

describe('字段自洽', () => {
  it('补写 identityId 与 createdAt（避免 upsert 出裸行漏掉 admin 统计）', async () => {
    await post({ type: 'RENEWAL', app_user_id: UID, expiration_at_ms: FUTURE });
    const [u] = updates();
    expect(u.UpdateExpression).toContain('identityId = :id');
    expect(u.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
    expect(u.ExpressionAttributeValues[':id']).toBe(UID);
  });

  it('grant 但拿不到到期日 → REMOVE expiresDate，而不是保留旧的过期值', async () => {
    await post({ type: 'NON_RENEWING_PURCHASE', app_user_id: UID, product_id: 'monthly.6' });
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
    expect(u.UpdateExpression).toContain('REMOVE expiresDate');
  });

  it('落 environment 便于把沙盒事件从运营统计里摘出来', async () => {
    await post({
      type: 'RENEWAL', app_user_id: UID,
      expiration_at_ms: FUTURE, environment: 'SANDBOX',
    });
    const [u] = updates();
    expect(u.ExpressionAttributeValues[':env']).toBe('SANDBOX');
  });

  it('已注销账号的续订事件 → 跳过，不把订阅行复活', async () => {
    // RC 不知道账号已注销，仍按旧 identityId 发 RENEWAL；upsert 会凭空重建 active 行
    deletedIds.add(UID);
    const res = await post({ type: 'RENEWAL', app_user_id: UID, expiration_at_ms: FUTURE });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'deleted' });
    expect(updates()).toHaveLength(0);
  });

  it('已注销账号的 no-op 事件不必查墓碑（不写库就不会复活）', async () => {
    deletedIds.add(UID);
    const res = await post({ type: 'CANCELLATION', app_user_id: UID, cancel_reason: 'UNSUBSCRIBE' });
    expect(await res.json()).toMatchObject({ noop: 'CANCELLATION' });
  });

  it('匿名 app_user_id → 200 跳过，不落库', async () => {
    const res = await post({ type: 'RENEWAL', app_user_id: '$RCAnonymousID:abc' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'anonymous' });
    expect(updates()).toHaveLength(0);
  });

  it('缺 type → 400', async () => {
    const res = await post({ app_user_id: UID });
    expect(res.status).toBe(400);
  });

  it('非 TRANSFER 且缺 app_user_id → 400', async () => {
    const res = await post({ type: 'RENEWAL' });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// h) 永久会员（2026-10-19，com.example.shopmap.lifetime.68，非消耗型）
// ============================================================

const LIFETIME = 'com.example.shopmap.lifetime.68';

describe('永久会员', () => {
  it('NON_RENEWING_PURCHASE 永久档 → active + lifetime，清到期日，不加「非永久档」条件', async () => {
    const res = await post({
      type: 'NON_RENEWING_PURCHASE', app_user_id: UID, product_id: LIFETIME,
      expiration_at_ms: null, original_transaction_id: 'otx-life', event_timestamp_ms: 1_700_000_000_000,
    });
    expect(res.status).toBe(200);
    const u = updates().find((x) => x.Key.SK === 'SUBSCRIPTION');
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
    expect(u.ExpressionAttributeValues[':pid']).toBe(LIFETIME);
    expect(u.ExpressionAttributeValues[':lifetime']).toBe(true);
    expect(u.ExpressionAttributeValues[':otx']).toBe('otx-life');
    expect(u.UpdateExpression).toContain('REMOVE expiresDate');
    expect(u.ConditionExpression).toBe('attribute_not_exists(lastEventAtMs) OR lastEventAtMs < :evt');
  });

  it('EXPIRATION 带「非永久档」条件；撞上永久档行 → 200 skipped:lifetime', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, any> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.reject(new ConditionalCheckFailedException());
      return Promise.resolve({ Item: { lifetime: true } });
    });
    const res = await post({ type: 'EXPIRATION', app_user_id: UID, product_id: 'monthly.6', event_timestamp_ms: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'lifetime' });
    const u = updates()[0];
    expect(u.ConditionExpression).toContain('attribute_not_exists(lifetime) OR lifetime <> :lifetimeTrue');
  });

  it('退款退的是永久档（CANCELLATION + CUSTOMER_SUPPORT）→ 收回：expired + REMOVE lifetime，不加保护条件', async () => {
    await post({
      type: 'CANCELLATION', app_user_id: UID, product_id: LIFETIME,
      cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: 2,
    });
    const u = updates()[0];
    expect(u.ExpressionAttributeValues[':status']).toBe('expired');
    expect(u.UpdateExpression).toMatch(/REMOVE .*lifetime/);
    expect(u.ConditionExpression).not.toContain('lifetime');
  });

  it('退款退的是订阅档 → 只降订阅，带「非永久档」条件（不误收用户另买的永久档）', async () => {
    await post({
      type: 'CANCELLATION', app_user_id: UID, product_id: 'monthly.6',
      cancel_reason: 'CUSTOMER_SUPPORT', event_timestamp_ms: 3,
    });
    const u = updates()[0];
    expect(u.ExpressionAttributeValues[':status']).toBe('expired');
    expect(u.ConditionExpression).toContain('lifetime <> :lifetimeTrue');
    expect(u.UpdateExpression).not.toMatch(/REMOVE .*lifetime/);
  });

  it('TEMPORARY_ENTITLEMENT_GRANT 即使是永久档商品也只按临时权益记（不打 lifetime，带到期日）', async () => {
    await post({
      type: 'TEMPORARY_ENTITLEMENT_GRANT', app_user_id: UID, product_id: LIFETIME,
      expiration_at_ms: FUTURE,
    });
    const u = updates()[0];
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
    expect(u.ExpressionAttributeValues[':lifetime']).toBeUndefined();
    expect(u.ExpressionAttributeValues[':exp']).toBe(FUTURE);
  });

  it('REFUND_REVERSED 永久档 → 恢复永久档', async () => {
    await post({ type: 'REFUND_REVERSED', app_user_id: UID, product_id: LIFETIME });
    const u = updates()[0];
    expect(u.ExpressionAttributeValues[':status']).toBe('active');
    expect(u.ExpressionAttributeValues[':lifetime']).toBe(true);
  });

  it('TRANSFER：donor 是永久档 → 收件方继承永久档，转出方清掉永久档', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      return Promise.resolve({ Item: { PK: UID, status: 'active', lifetime: true, productId: LIFETIME, originalTransactionId: 'otx-life' } });
    });
    const res = await post({ type: 'TRANSFER', transferred_from: [UID], transferred_to: [UID2] });
    expect(res.status).toBe(200);
    const us = updates();
    const recipient = us.find((u) => u.Key.PK === UID2 && u.Key.SK === 'SUBSCRIPTION');
    expect(recipient.ExpressionAttributeValues[':status']).toBe('active');
    expect(recipient.ExpressionAttributeValues[':lifetime']).toBe(true);
    expect(recipient.UpdateExpression).toContain('REMOVE expiresDate');
    const donor = us.find((u) => u.Key.PK === UID && u.Key.SK === 'SUBSCRIPTION');
    expect(donor.ExpressionAttributeValues[':status']).toBe('expired');
    expect(donor.UpdateExpression).toMatch(/REMOVE .*lifetime/);
  });

  it('TRANSFER：永久档行排在有到期日的订阅行前面（被选为 best）', async () => {
    let n = 0;
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      n += 1;
      return Promise.resolve({
        Item: n === 1
          ? { PK: UID, status: 'active', productId: 'monthly.6', expiresDate: FUTURE }
          : { PK: UID2, status: 'active', productId: LIFETIME, lifetime: true },
      });
    });
    const UID3 = 'ap-southeast-1:33333333-3333-3333-3333-333333333333';
    await post({ type: 'TRANSFER', transferred_from: [UID, UID2], transferred_to: [UID3] });
    const recipient = updates().find((u) => u.Key.PK === UID3);
    expect(recipient.ExpressionAttributeValues[':pid']).toBe(LIFETIME);
    expect(recipient.ExpressionAttributeValues[':lifetime']).toBe(true);
  });
});

// ============================================================
// i) 审查 MEDIUM 4：普通授予路径写原始交易号 + 顺手建 TXID 映射
// ============================================================

describe('授予路径的原始交易号', () => {
  /** 取出所有 PutCommand 的 input */
  function puts() {
    return mockSend.mock.calls
      .map(([cmd]) => cmd.input)
      .filter((i: Record<string, unknown>) => 'Item' in i);
  }

  it('RENEWAL 写入 original_transaction_id，并只建不改地写 TXID 映射', async () => {
    await post({
      type: 'RENEWAL', app_user_id: UID, product_id: 'monthly.6',
      expiration_at_ms: FUTURE, original_transaction_id: '370001',
    });
    const u = updates()[0];
    expect(u.ExpressionAttributeValues[':otx']).toBe('370001');
    const [m] = puts();
    expect(m.Item).toMatchObject({ PK: 'TXID#370001', SK: 'MAPPING', identityId: UID });
    expect(m.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('映射已存在（条件失败）→ 不改归属，事件照常 200', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('Item' in cmd.input) return Promise.reject(new ConditionalCheckFailedException());
      return Promise.resolve({});
    });
    const res = await post({
      type: 'RENEWAL', app_user_id: UID, expiration_at_ms: FUTURE, original_transaction_id: '370002',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('映射写入真故障也不影响事件处理（行已写成功，重投会被乱序守卫跳过，映射靠下一次事件补）', async () => {
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('Item' in cmd.input) return Promise.reject(new Error('Throttling'));
      return Promise.resolve({});
    });
    const res = await post({
      type: 'RENEWAL', app_user_id: UID, expiration_at_ms: FUTURE, original_transaction_id: '370003',
    });
    expect(res.status).toBe(200);
  });

  it('事件没带 original_transaction_id → 不写 :otx、不建映射', async () => {
    await post({ type: 'RENEWAL', app_user_id: UID, expiration_at_ms: FUTURE });
    expect(updates()[0].ExpressionAttributeValues[':otx']).toBeUndefined();
    expect(puts()).toHaveLength(0);
  });
});

// ============================================================
// j) /appstore：去掉请求内 60 秒长睡眠（审查 MEDIUM 2）+ 永久会员
// ============================================================

import { verifyAndDecodeNotification } from '../src/lib/appstore.js';
import { APPSTORE_MAPPING_RETRY_DELAYS_MS } from '../src/routes/webhooks.js';

describe('/webhooks/appstore', () => {
  function appleNotification(type: string, productId = 'monthly.6') {
    vi.mocked(verifyAndDecodeNotification).mockResolvedValue({
      payload: { notificationType: type, data: { bundleId: 'com.example.shop-map-ios', environment: 'Production' } },
      transactionInfo: { originalTransactionId: 'otx-apple', productId, expiresDate: FUTURE },
    } as never);
  }
  function postApple() {
    return webhooksRoute.request('/appstore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedPayload: 'jws' }),
    });
  }

  it('找不到映射：短补查后立即 200（总等待约 3 秒，不再挂 60 秒）', async () => {
    appleNotification('DID_RENEW');
    mockSend.mockResolvedValue({}); // 映射一直不存在
    vi.useFakeTimers();
    try {
      const pending = postApple();
      const totalWait = APPSTORE_MAPPING_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
      expect(totalWait).toBeLessThanOrEqual(5_000);
      await vi.advanceTimersByTimeAsync(totalWait);
      const res = await pending;
      expect(res.status).toBe(200);
      // 首查 + 每个补查间隔各一次
      expect(mockSend).toHaveBeenCalledTimes(1 + APPSTORE_MAPPING_RETRY_DELAYS_MS.length);
      expect(updates()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('补查期间映射出现 → 正常落库', async () => {
    appleNotification('DID_RENEW');
    let gets = 0;
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      gets += 1;
      return Promise.resolve(gets >= 2 ? { Item: { identityId: UID } } : {});
    });
    vi.useFakeTimers();
    try {
      const pending = postApple();
      await vi.advanceTimersByTimeAsync(APPSTORE_MAPPING_RETRY_DELAYS_MS[0]);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(updates()[0].ExpressionAttributeValues[':status']).toBe('active');
    } finally {
      vi.useRealTimers();
    }
  });

  function withMapping() {
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.resolve({});
      return Promise.resolve({ Item: { identityId: UID } });
    });
  }

  it('REFUND 退的是永久档 → 收回永久档（REMOVE lifetime，不加保护条件）', async () => {
    appleNotification('REFUND', LIFETIME);
    withMapping();
    const res = await postApple();
    expect(res.status).toBe(200);
    const u = updates()[0];
    expect(u.ExpressionAttributeValues[':status']).toBe('expired');
    expect(u.UpdateExpression).toMatch(/REMOVE .*lifetime/);
    expect(u.ConditionExpression).toBeUndefined();
  });

  it('EXPIRED / 订阅档 REFUND → 带「非永久档」条件，不动永久档行', async () => {
    for (const type of ['EXPIRED', 'REFUND']) {
      mockSend.mockReset();
      appleNotification(type, 'monthly.6');
      withMapping();
      await postApple();
      expect(updates()[0].ConditionExpression).toBe('attribute_not_exists(lifetime) OR lifetime <> :lifetimeTrue');
    }
  });

  it('DID_RENEW 撞上永久档行（条件失败）→ 仍回 200（Apple 语义恒 200）', async () => {
    appleNotification('DID_RENEW');
    mockSend.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if ('UpdateExpression' in cmd.input) return Promise.reject(new ConditionalCheckFailedException());
      return Promise.resolve({ Item: { identityId: UID, lifetime: true } });
    });
    const res = await postApple();
    expect(res.status).toBe(200);
  });
});
