/**
 * /v1/auth/profile 单元测试（2026-10-19）
 *
 * 覆盖：
 *   a) GET：只带 x-identity-id（没有验签通过的 JWT）的请求不下发 email / Apple 实名 / 登录 sub——
 *      匿名请求信任请求头，知道别人的 identityId 就能读他的资料；验签请求照常返回
 *   b) PUT（审查 M31）：清空简介——空串与 null 都表示清空；键缺失表示不改
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

const hoisted = vi.hoisted(() => ({
  identity: { identityId: 'ap-southeast-1:11111111-2222-3333-4444-555555555555' } as {
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
vi.mock('../src/middleware/ban.js', () => ({
  rejectBannedWrites: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return { ...actual, getDocClient: () => ({ send: mockSend }), USERS_TABLE: 'users', SHARED_TABLE: 'shared' };
});
vi.mock('../src/lib/content-moderation.js', () => ({
  moderateText: vi.fn(async () => ({ pass: true, labels: [] })),
  moderateImage: vi.fn(),
}));
vi.mock('../src/lib/account-tombstone.js', () => ({ writeDeletionTombstone: vi.fn(), isDeletedIdentity: vi.fn() }));
vi.mock('../src/lib/s3.js', () => ({ uploadToS3: vi.fn(), deleteFromS3: vi.fn() }));
vi.mock('../src/lib/author-id.js', () => ({ ensureAuthorId: vi.fn() }));
vi.mock('../src/lib/post-utils.js', () => ({ processPostsForResponse: vi.fn() }));
vi.mock('../src/lib/appstore.js', () => ({ verifySubscriptionWithApple: vi.fn(), verifyLifetimePurchaseWithApple: vi.fn() }));
vi.mock('../src/lib/apple-signin.js', () => ({ revokeAppleAuthorization: vi.fn() }));

import { Hono } from 'hono';
import { authRoute } from '../src/routes/auth.js';

const UID = hoisted.identity.identityId;
const PROFILE = {
  PK: UID, SK: 'PROFILE', identityId: UID,
  cognitoSub: 'sub-secret', email: 'me@privaterelay.appleid.com', displayName: '张三',
  provider: 'apple', nickname: '吃货小王', avatarUrl: 'https://img.shopmap.example/avatars/a/1.jpg', bio: '爱吃面',
};

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);

function app() {
  const a = new Hono();
  a.route('/auth', authRoute);
  return a;
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockImplementation((cmd: Cmd) => (
    cmd.constructor.name === 'GetCommand' ? Promise.resolve({ Item: { ...PROFILE } }) : Promise.resolve({})
  ));
});

describe('GET /v1/auth/profile', () => {
  it('只带请求头身份 → 不下发 email / displayName / cognitoSub', async () => {
    hoisted.identity = { identityId: UID };
    const body = await (await app().request('/auth/profile')).json();
    expect(body.data.profile).not.toHaveProperty('email');
    expect(body.data.profile).not.toHaveProperty('displayName');
    expect(body.data.profile).not.toHaveProperty('cognitoSub');
    expect(body.data.profile.nickname).toBe('吃货小王');
  });

  it('验签通过的登录请求 → 照常返回 email', async () => {
    hoisted.identity = { identityId: UID, cognitoSub: 'sub-secret' };
    const body = await (await app().request('/auth/profile')).json();
    expect(body.data.profile.email).toBe('me@privaterelay.appleid.com');
  });

  it('没有资料 → profile=null', async () => {
    hoisted.identity = { identityId: UID };
    mockSend.mockResolvedValue({});
    const body = await (await app().request('/auth/profile')).json();
    expect(body.data.profile).toBeNull();
  });
});

describe('PUT /v1/auth/profile 清空简介（M31）', () => {
  function put(body: unknown) {
    return app().request('/auth/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }
  const profileWrite = () => cmds().find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key.SK === 'PROFILE')!;

  it.each([[''], [null]])('bio=%j → 写入空串（清空），不再同步推荐者表', async (bio) => {
    hoisted.identity = { identityId: UID, cognitoSub: 'sub' };
    const res = await put({ nickname: '吃货小王', bio });
    expect(res.status).toBe(200);
    expect(profileWrite().input.UpdateExpression).toContain('bio = :bio');
    expect(profileWrite().input.ExpressionAttributeValues[':bio']).toBe('');
    // 用户自建作者 10/22 已删，INFLUENCER 上没有用户行，改资料不再碰 shared 表
    expect(cmds().some((c) => c.input?.Key?.PK === 'INFLUENCER')).toBe(false);
  });

  it('只发 bio:"" 也可以（不必带昵称）', async () => {
    const res = await put({ bio: '' });
    expect(res.status).toBe(200);
    expect(profileWrite().input.ExpressionAttributeValues[':bio']).toBe('');
  });

  it('键缺失 → 不改简介（老客户端行为不变）', async () => {
    await put({ nickname: '吃货小王' });
    expect(profileWrite().input.UpdateExpression).not.toContain('bio');
  });

  it('bio 不是字符串也不是 null → 400', async () => {
    const res = await put({ bio: 123 });
    expect(res.status).toBe(400);
  });
});
