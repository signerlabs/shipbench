/**
 * identityMiddleware · cognitoSub ↔ identityId 绑定校验单元测试
 *
 * 钉住 2026-09-16 修复的横向越权洞：旧实现在绑定不存在时「先到先得」照请求头建绑定，
 * 主键 COGNITO#<sub> + attribute_not_exists 只保证**这个 sub** 没绑过，从不校验
 * 「这个 identityId 属于这个 sub」——任何一枚从未请求过本服务的合法 sub，带上受害者的
 * x-identity-id，第一次请求就能认领受害者身份（配合 DELETE /me 即可删号）。
 *
 * 覆盖：
 *   a) 已绑定且匹配 → 放行，**不打** Identity Pool（快路径）
 *   b) 已绑定但不匹配 → 403
 *   c) 未绑定 + Identity Pool 确认归属 → 建绑定并放行
 *   d) 未绑定 + Identity Pool 说不属于你 → 403，**且不建绑定**（攻击场景）
 *   e) 未绑定 + token 不被身份池接受 → 403，不建绑定
 *   f) Identity Pool 故障 → 503 fail-closed，不建绑定
 *   g) 匿名请求（无 JWT）不受影响
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockCognitoSend = vi.fn();

vi.mock('../src/lib/dynamodb.js', () => ({
  getDocClient: () => ({ send: mockSend }),
  USERS_TABLE: 'users',
}));

// JWT 验签：带 Bearer 即视为验签通过，sub 取自 token 本身，便于构造「攻击者 sub」
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => ({ payload: { sub: token } })),
}));

vi.mock('@aws-sdk/client-cognito-identity', () => ({
  CognitoIdentityClient: class {
    send(...a: unknown[]) { return mockCognitoSend(...a); }
  },
  GetIdCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { Hono } from 'hono';
import { identityMiddleware } from '../src/middleware/auth.js';

const VICTIM = 'ap-southeast-1:11111111-2222-3333-4444-555555555555';
const ATTACKER_OWN = 'ap-southeast-1:99999999-8888-7777-6666-555555555555';

function buildApp() {
  const app = new Hono();
  app.use('*', identityMiddleware);
  app.get('/probe', (c) => c.json({ ok: true, identity: c.get('identity') }));
  return app;
}

function call(identityId: string, sub?: string) {
  return buildApp().request('/probe', {
    headers: {
      'x-identity-id': identityId,
      ...(sub ? { Authorization: `Bearer ${sub}` } : {}),
    },
  });
}

/** 是否发生过「建绑定」写入 */
const bindingPuts = () =>
  mockSend.mock.calls
    .map(([cmd]) => cmd.input)
    .filter((i) => i.Item && String(i.Item.PK).startsWith('COGNITO#'));

/** 模拟绑定表：给定 sub → identityId；未给则无绑定 */
function bindingTable(existing: Record<string, string>) {
  mockSend.mockImplementation((cmd: { input: Record<string, any> }) => {
    const i = cmd.input;
    if (i.Key && String(i.Key.PK).startsWith('COGNITO#')) {
      const sub = String(i.Key.PK).slice('COGNITO#'.length);
      return Promise.resolve(existing[sub] ? { Item: { identityId: existing[sub] } } : {});
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  mockSend.mockReset();
  mockCognitoSend.mockReset();
  process.env.COGNITO_USER_POOL_ID = 'ap-southeast-1_pool';
  process.env.COGNITO_CLIENT_ID = 'client';
  process.env.COGNITO_IDENTITY_POOL_ID = 'ap-southeast-1:idpool';
});

describe('已有绑定（快路径）', () => {
  it('匹配 → 放行，且不打 Identity Pool', async () => {
    bindingTable({ 'sub-victim': VICTIM });
    const res = await call(VICTIM, 'sub-victim');
    expect(res.status).toBe(200);
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });

  it('不匹配 → 403 IDENTITY_MISMATCH', async () => {
    bindingTable({ 'sub-attacker': ATTACKER_OWN });
    const res = await call(VICTIM, 'sub-attacker');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'IDENTITY_MISMATCH' } });
  });
});

describe('首次建绑定（越权洞所在）', () => {
  it('Identity Pool 确认 token 属于该 identityId → 建绑定并放行', async () => {
    bindingTable({});
    mockCognitoSend.mockResolvedValue({ IdentityId: VICTIM });
    const res = await call(VICTIM, 'sub-victim');
    expect(res.status).toBe(200);
    expect(bindingPuts()).toHaveLength(1);
    expect(bindingPuts()[0].Item).toMatchObject({ PK: 'COGNITO#sub-victim', identityId: VICTIM });
  });

  it('【攻击】全新 sub + 受害者 identityId：Identity Pool 返回攻击者自己的身份 → 403，且绝不建绑定', async () => {
    bindingTable({});
    mockCognitoSend.mockResolvedValue({ IdentityId: ATTACKER_OWN });
    const res = await call(VICTIM, 'sub-attacker-fresh');
    expect(res.status).toBe(403);
    // 修复前这里会「先到先得」写下 COGNITO#sub-attacker-fresh → VICTIM
    expect(bindingPuts()).toHaveLength(0);
  });

  it('向 Identity Pool 求证时带上的是请求里的 ID Token，登录键为 User Pool', async () => {
    bindingTable({});
    mockCognitoSend.mockResolvedValue({ IdentityId: VICTIM });
    await call(VICTIM, 'sub-victim');
    const input = mockCognitoSend.mock.calls[0][0].input;
    expect(input.IdentityPoolId).toBe('ap-southeast-1:idpool');
    expect(input.Logins).toEqual({
      'cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_pool': 'sub-victim',
    });
  });

  it('token 不被身份池接受（NotAuthorizedException）→ 403，不建绑定', async () => {
    bindingTable({});
    const err = new Error('Invalid login token'); err.name = 'NotAuthorizedException';
    mockCognitoSend.mockRejectedValue(err);
    const res = await call(VICTIM, 'sub-x');
    expect(res.status).toBe(403);
    expect(bindingPuts()).toHaveLength(0);
  });

  it('Identity Pool 故障 → 503 fail-closed，不建绑定（无法确认归属时放行即越权）', async () => {
    bindingTable({});
    const err = new Error('throttled'); err.name = 'TooManyRequestsException';
    mockCognitoSend.mockRejectedValue(err);
    const res = await call(VICTIM, 'sub-x');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'IDENTITY_VERIFICATION_UNAVAILABLE' } });
    expect(bindingPuts()).toHaveLength(0);
  });
});

describe('匿名请求', () => {
  it('无 JWT → 照旧匿名放行，不查绑定、不打 Identity Pool', async () => {
    const res = await call(VICTIM);
    expect(res.status).toBe(200);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockCognitoSend).not.toHaveBeenCalled();
  });
});
