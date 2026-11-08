/**
 * requirePaidMiddleware 单元测试
 *
 * 覆盖 v2.2 D3.1 抖音导入会员化的中间件契约：
 *   a) 会员（status='active'） → 进入业务逻辑
 *   b) 无 SUBSCRIPTION 记录 → 403 SUBSCRIPTION_REQUIRED
 *   c) status='expired' → 403
 *   d) status='canceled'（webhooks 暂未产生此值，预防性覆盖） → 403
 *   e) DynamoDB 异常 → 503 SUBSCRIPTION_CHECK_UNAVAILABLE（绝不降级为 403）
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mock dynamodb 模块（必须在 import middleware/route 之前完成）
// ============================================================

const mockSend = vi.fn();

vi.mock('../src/lib/dynamodb.js', () => ({
  getDocClient: () => ({ send: mockSend }),
  USERS_TABLE: 'shopmap-users-test',
  VIDEOS_TABLE: 'shopmap-videos-test',
  SHARED_TABLE: 'shopmap-shared-test',
}));

// ============================================================
// 测试夹具：mini Hono app + identity 注入
// ============================================================

import { Hono } from 'hono';
import { requirePaidMiddleware } from '../src/middleware/requirePaid.js';
import type { IdentityContext } from '../src/middleware/auth.js';

const TEST_IDENTITY: IdentityContext = {
  identityId: 'ap-southeast-1:test-user-uuid-0000-0000-0000',
};

function buildApp() {
  const app = new Hono();

  // 模拟 identityMiddleware：直接注入测试 identity，避免依赖 header 解析
  app.use('*', async (c, next) => {
    c.set('identity', TEST_IDENTITY);
    await next();
  });

  app.use('*', requirePaidMiddleware);

  app.post('/', (c) => c.json({ data: { ok: true } }));

  return app;
}

// ============================================================
// 测试用例
// ============================================================

describe('requirePaidMiddleware', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('a) 会员（status=active）→ 放行进入业务逻辑', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { status: 'active' },
    });

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { ok: true } });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('b) 无 SUBSCRIPTION 记录（Item undefined）→ 403 SUBSCRIPTION_REQUIRED', async () => {
    mockSend.mockResolvedValueOnce({}); // DynamoDB GetCommand 命中不到返回 {}, 无 Item

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'SUBSCRIPTION_REQUIRED',
        message: '抖音导入是会员功能，请先开通小店会员',
        paywallTrigger: 'import',
      },
    });
  });

  it('c) 过期会员（status=expired）→ 403 SUBSCRIPTION_REQUIRED', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { status: 'expired' },
    });

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('d) 取消的会员（status=canceled）→ 403 SUBSCRIPTION_REQUIRED', async () => {
    // 注：webhooks 当前只产生 active|expired，canceled 是未来兼容的预防性覆盖。
    // 中间件采用白名单判定（仅 active 通过），任何其它值都应被拒。
    mockSend.mockResolvedValueOnce({
      Item: { status: 'canceled' },
    });

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('e) DynamoDB 读取抛错 → 503 SUBSCRIPTION_CHECK_UNAVAILABLE（绝不降级为 403）', async () => {
    // 关键契约：DB 故障必须 503，不能让会员被误判为非会员而失去已付费功能
    mockSend.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SUBSCRIPTION_CHECK_UNAVAILABLE');
    expect(body.error.code).not.toBe('SUBSCRIPTION_REQUIRED');
  });

  it('e2) DynamoDB 抛 ThrottlingException → 503（覆盖另一种常见故障）', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('Request rate exceeded'), { name: 'ThrottlingException' }),
    );

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(503);
  });

  it('回归 1) status 字段为空字符串 → 403（防 webhooks 写入异常值意外通过）', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { status: '' },
    });

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(403);
  });

  it('回归 2) Item 存在但缺 status 字段 → 403', async () => {
    mockSend.mockResolvedValueOnce({
      Item: { productId: 'com.example.shopmap.lifetime' }, // 历史脏数据：有 productId 无 status
    });

    const app = buildApp();
    const res = await app.request('/', { method: 'POST' });

    expect(res.status).toBe(403);
  });
});
