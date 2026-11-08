/**
 * GET /v1/issues 收紧为管理员专用（2026-10-19）
 *
 * 旧实现不校验任何身份，能读到全部用户反馈。iOS 不调用本接口（提交反馈走
 * POST /v1/restaurants/:id/issue），管理后台用 /admin/issues。
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockGetAppSecrets = vi.fn();

vi.mock('../src/lib/dynamodb.js', () => ({
  getDocClient: () => ({ send: mockSend }),
  SHARED_TABLE: 'shared',
}));
vi.mock('../src/lib/secrets.js', () => ({ getAppSecrets: () => mockGetAppSecrets() }));

import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { issuesRoute } from '../src/routes/issues.js';

const JWT_SECRET = 'test-admin-jwt-secret';

function app() {
  const a = new Hono();
  a.route('/issues', issuesRoute);
  return a;
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ Items: [{ PK: 'ISSUE', SK: 's1', status: 'pending', identityId: 'ap-southeast-1:x', restaurantId: 'r1' }] });
  mockGetAppSecrets.mockResolvedValue({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'p', ADMIN_JWT_SECRET: JWT_SECRET });
});

describe('GET /v1/issues', () => {
  it('不带凭证 → 401，不查库', async () => {
    const res = await app().request('/issues');
    expect(res.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('带 iOS 的 Cognito Bearer（不是 Admin JWT）→ 401', async () => {
    const res = await app().request('/issues', { headers: { Authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig' } });
    expect(res.status).toBe(401);
  });

  it('Admin JWT → 200，响应仍剥离举报人 identityId', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({ sub: 'admin', role: 'admin', iat: now, exp: now + 60 }, JWT_SECRET);
    const res = await app().request('/issues', { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).not.toHaveProperty('identityId');
  });
});
