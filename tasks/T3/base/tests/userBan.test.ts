/**
 * 用户封禁单元测试（2026-10-19）
 *
 * 约定：封禁记录 = users 表 PK=<identityId>, SK="BAN"，{ reason, createdAt, createdBy: "admin" }
 * 覆盖：
 *   a) 中间件：封禁身份的写请求 403 USER_BANNED，读请求不拦；未封禁照常放行
 *   b) 短时缓存：同一身份连续写只查一次 DynamoDB；封禁查询异常时放行（fail-open）
 *   c) 路由接线：POST /v1/parse、帖子点赞、改资料被拦；注销账号与订阅记账不拦
 *   d) 管理后台：POST / DELETE /admin/users/:identityId/ban；GET /admin/users/:id 返回封禁状态
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

vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return {
    ...actual,
    getDocClient: () => ({ send: mockSend }),
    USERS_TABLE: 'users', SHARED_TABLE: 'shared', VIDEOS_TABLE: 'videos',
  };
});

vi.mock('../src/middleware/auth.js', () => ({
  identityMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('identity', hoisted.identity);
    await next();
  },
  requireWriteAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  requireParseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  getIdentity: (c: { get: (k: string) => unknown }) => c.get('identity'),
  resolveIdentityIdByToken: vi.fn(),
  isEnforceWriteAuth: () => false,
  isEnforceParseAuth: () => false,
}));

vi.mock('../src/middleware/adminAuth.js', () => ({
  adminAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  verifyAdminCredentials: vi.fn(),
  signAdminToken: vi.fn(),
  verifyAdminToken: vi.fn(),
  isAdminRequest: vi.fn(async () => false),
}));

vi.mock('../src/lib/secrets.js', () => ({ getAppSecrets: vi.fn(async () => ({})), getSecretString: vi.fn() }));
vi.mock('../src/lib/account-tombstone.js', () => ({ writeDeletionTombstone: vi.fn(), isDeletedIdentity: vi.fn() }));
vi.mock('../src/lib/s3.js', () => ({ uploadToS3: vi.fn(), deleteFromS3: vi.fn(), existsInS3: vi.fn() }));
vi.mock('../src/lib/content-moderation.js', () => ({ moderateText: vi.fn(), moderateImage: vi.fn() }));
vi.mock('../src/lib/appstore.js', () => ({ verifySubscriptionWithApple: vi.fn(), verifyLifetimePurchaseWithApple: vi.fn() }));
vi.mock('../src/lib/apple-signin.js', () => ({ revokeAppleAuthorization: vi.fn() }));

import { Hono } from 'hono';
import { rejectBannedWrites } from '../src/middleware/ban.js';
import { __resetBanCacheForTests } from '../src/lib/user-ban.js';
import { parseRoute } from '../src/routes/parse.js';
import { postsRoute } from '../src/routes/posts.js';
import { authRoute } from '../src/routes/auth.js';
import { adminRoute } from '../src/routes/admin.js';

const UID = hoisted.identity.identityId;

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);
const banReads = () => cmds().filter((c) => c.constructor.name === 'GetCommand' && c.input.Key?.SK === 'BAN');

/** banned=true 时 BAN 行存在；其余命令一律成功、无数据 */
function setBanned(banned: boolean) {
  mockSend.mockImplementation((cmd: Cmd) => {
    if (cmd.constructor.name === 'GetCommand' && cmd.input.Key?.SK === 'BAN') {
      return Promise.resolve({ Item: banned ? { PK: UID, SK: 'BAN' } : undefined });
    }
    return Promise.resolve({});
  });
}

function miniApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('identity', hoisted.identity); await next(); });
  app.use('*', rejectBannedWrites);
  app.get('/x', (c) => c.json({ ok: true }));
  app.post('/x', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  __resetBanCacheForTests();
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  hoisted.identity = { identityId: UID };
});

// ============================================================
// a) / b) 中间件
// ============================================================

describe('rejectBannedWrites', () => {
  it('封禁身份的写请求 → 403 USER_BANNED', async () => {
    setBanned(true);
    const res = await miniApp().request('/x', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'USER_BANNED' } });
  });

  it('读请求不拦，也不查封禁', async () => {
    setBanned(true);
    const res = await miniApp().request('/x');
    expect(res.status).toBe(200);
    expect(banReads()).toHaveLength(0);
  });

  it('未封禁照常放行', async () => {
    setBanned(false);
    const res = await miniApp().request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('短时缓存：连续写只查一次 DynamoDB', async () => {
    setBanned(false);
    const app = miniApp();
    await app.request('/x', { method: 'POST' });
    await app.request('/x', { method: 'POST' });
    await app.request('/x', { method: 'POST' });
    expect(banReads()).toHaveLength(1);
  });

  it('封禁查询异常 → 放行（封禁是内容治理，不能把全站写入一起打挂）', async () => {
    mockSend.mockRejectedValue(new Error('DynamoDB down'));
    const res = await miniApp().request('/x', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});

// ============================================================
// c) 路由接线
// ============================================================

describe('路由接线', () => {
  beforeEach(() => setBanned(true));

  it('POST /v1/parse 导入被拦（轮询 GET 不拦）', async () => {
    const app = new Hono();
    app.route('/parse', parseRoute);
    const res = await app.request('/parse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://v.douyin.com/abc/' }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'USER_BANNED' } });

    const poll = await app.request('/parse/jobs/job-1');
    expect(poll.status).toBe(404); // JOB 不存在，但没被封禁拦
  });

  it('点赞被拦', async () => {
    const app = new Hono();
    app.route('/posts', postsRoute);
    const res = await app.request('/posts/123/like', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('改资料被拦', async () => {
    const app = new Hono();
    app.route('/auth', authRoute);
    const res = await app.request('/auth/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: '新名字' }),
    });
    expect(res.status).toBe(403);
  });

  it('注销账号不拦（法定权利）：未登录时照常回 401 AUTH_REQUIRED 而不是 USER_BANNED', async () => {
    const app = new Hono();
    app.route('/auth', authRoute);
    const res = await app.request('/auth/me', { method: 'DELETE' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('订阅记账不拦：缺参照常回 400 而不是 USER_BANNED', async () => {
    const app = new Hono();
    app.route('/auth', authRoute);
    const res = await app.request('/auth/subscription', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ============================================================
// d) 管理后台
// ============================================================

describe('管理后台封禁接口', () => {
  const app = () => {
    const a = new Hono();
    a.route('/admin', adminRoute);
    return a;
  };

  it('POST ban：写 users 表 SK=BAN 行 { reason, createdAt, createdBy: admin }', async () => {
    const res = await app().request(`/admin/users/${encodeURIComponent(UID)}/ban`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '  发布违规内容  ' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ identityId: UID, banned: true, ban: { reason: '发布违规内容', createdBy: 'admin' } });
    const put = cmds().find((c) => c.constructor.name === 'PutCommand')!;
    expect(put.input.TableName).toBe('users');
    expect(put.input.Item).toMatchObject({ PK: UID, SK: 'BAN', reason: '发布违规内容', createdBy: 'admin' });
    expect(typeof put.input.Item.createdAt).toBe('string');
  });

  it('POST ban 后本实例立即生效（缓存同步写入，不等 TTL）', async () => {
    setBanned(false);
    const mini = miniApp();
    expect((await mini.request('/x', { method: 'POST' })).status).toBe(200); // 先缓存成「未封禁」
    await app().request(`/admin/users/${encodeURIComponent(UID)}/ban`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'spam' }),
    });
    expect((await mini.request('/x', { method: 'POST' })).status).toBe(403);
  });

  it('POST ban 缺 reason → 400；identityId 格式不对 → 400', async () => {
    const r1 = await app().request(`/admin/users/${encodeURIComponent(UID)}/ban`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);
    const r2 = await app().request('/admin/users/COGNITO%23abc/ban', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
    });
    expect(r2.status).toBe(400);
    expect(cmds().filter((c) => c.constructor.name === 'PutCommand')).toHaveLength(0);
  });

  it('DELETE ban：删 SK=BAN 行，本实例立即解封', async () => {
    setBanned(true);
    const mini = miniApp();
    expect((await mini.request('/x', { method: 'POST' })).status).toBe(403);
    const res = await app().request(`/admin/users/${encodeURIComponent(UID)}/ban`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { identityId: UID, banned: false } });
    const del = cmds().find((c) => c.constructor.name === 'DeleteCommand')!;
    expect(del.input.Key).toEqual({ PK: UID, SK: 'BAN' });
    expect((await mini.request('/x', { method: 'POST' })).status).toBe(200);
  });

  it('GET /admin/users/:id 返回 banned 与封禁记录', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: [
            { PK: UID, SK: 'PROFILE', email: 'a@b.c' },
            { PK: UID, SK: 'BAN', reason: '刷屏', createdAt: '2026-10-19T00:00:00Z', createdBy: 'admin' },
          ],
        });
      }
      return Promise.resolve({});
    });
    const res = await app().request(`/admin/users/${encodeURIComponent(UID)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.banned).toBe(true);
    expect(body.data.ban).toEqual({ reason: '刷屏', createdAt: '2026-10-19T00:00:00Z', createdBy: 'admin' });
  });

  it('GET /admin/users/:id 未封禁 → banned=false, ban=null', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'QueryCommand') return Promise.resolve({ Items: [{ PK: UID, SK: 'PROFILE' }] });
      return Promise.resolve({});
    });
    const body = await (await app().request(`/admin/users/${encodeURIComponent(UID)}`)).json();
    expect(body.data.banned).toBe(false);
    expect(body.data.ban).toBeNull();
  });
});
