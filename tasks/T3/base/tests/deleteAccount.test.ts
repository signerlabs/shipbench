/**
 * DELETE /me（账号注销）单元测试
 *
 * 口径：删除个人信息（用户自建内容 10/22 已彻底删除，不再有要匿名化的公开内容）。
 * 覆盖：
 *   a) 鉴权：无验签 JWT → 401；**token 归属与请求身份不符 → 403**（越权删号的核心防线）；
 *      Identity Pool 故障 → 503 fail-closed
 *   b) users 表该用户全部行删除；COGNITO# / AUTHOR# / TXID# 三条反查映射一并清理（且条件删）
 *   c) 不碰公开内容：本人导入的抖音帖署名是原视频博主，绝不能动
 *   d) 墓碑先于删除写入
 *   e) 头像 S3 对象删除，且只删本服务头像目录
 *   f) 出错回 500，绝不谎报成功
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockDeleteFromS3 = vi.fn();
const mockWriteTombstone = vi.fn();

/**
 * authRoute 自带 identityMiddleware（会从 header 反推身份并覆盖外层预置值），整体替换。
 * resolveIdentityIdByToken 模拟 Cognito Identity Pool 的权威归属应答。
 */
const hoisted = vi.hoisted(() => ({
  identity: { identityId: '' } as { identityId: string; cognitoSub?: string },
  tokenOwner: '' as string | null | Error,
}));

vi.mock('../src/middleware/auth.js', () => ({
  identityMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('identity', hoisted.identity);
    await next();
  },
  requireWriteAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  getIdentity: (c: { get: (k: string) => unknown }) => c.get('identity'),
  resolveIdentityIdByToken: async () => {
    if (hoisted.tokenOwner instanceof Error) throw hoisted.tokenOwner;
    return hoisted.tokenOwner;
  },
}));

vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return {
    ...actual,
    getDocClient: () => ({ send: mockSend }),
    USERS_TABLE: 'users',
    SHARED_TABLE: 'shared',
  };
});

vi.mock('../src/lib/account-tombstone.js', () => ({
  writeDeletionTombstone: (...a: unknown[]) => mockWriteTombstone(...a),
  isDeletedIdentity: vi.fn(async () => false),
}));
vi.mock('../src/lib/s3.js', () => ({
  uploadToS3: vi.fn(),
  deleteFromS3: (...a: unknown[]) => mockDeleteFromS3(...a),
}));
vi.mock('../src/lib/content-moderation.js', () => ({ moderateText: vi.fn(), moderateImage: vi.fn() }));
vi.mock('../src/lib/author-id.js', () => ({ ensureAuthorId: vi.fn() }));
vi.mock('../src/lib/post-utils.js', () => ({ processPostsForResponse: vi.fn() }));
vi.mock('../src/lib/appstore.js', () => ({ verifySubscriptionWithApple: vi.fn() }));
// 2026-10-19 删号撤销 Apple 登录授权（审核指南 5.1.1(v)）
const mockRevoke = vi.fn();
vi.mock('../src/lib/apple-signin.js', () => ({
  revokeAppleAuthorization: (...a: unknown[]) => mockRevoke(...a),
}));

import { Hono } from 'hono';
import { authRoute } from '../src/routes/auth.js';

const UID = 'ap-southeast-1:11111111-2222-3333-4444-555555555555';
const OTHER = 'ap-southeast-1:99999999-8888-7777-6666-555555555555';
const SUB = 'sub-abc-123';

/** 已登录：有 cognitoSub，且 Identity Pool 确认 token 属于本人 */
function asOwner() {
  hoisted.identity = { identityId: UID, cognitoSub: SUB };
  hoisted.tokenOwner = UID;
}

function del() {
  const app = new Hono();
  app.route('/', authRoute);
  return app.request('/me', { method: 'DELETE', headers: { Authorization: 'Bearer tok' } });
}

/** 按调用顺序记录每条 DynamoDB 命令的类型与 input */
const log: { op: string; input: Record<string, any> }[] = [];
const inputs = () => log.map((l) => l.input);
const deletesOn = (prefix: string) =>
  log.filter((l) => l.op === 'DeleteCommand' && String(l.input.Key?.PK).startsWith(prefix)).map((l) => l.input);
const batchDeletedSKs = () =>
  inputs()
    .filter((i) => i.RequestItems?.users?.[0]?.DeleteRequest)
    .flatMap((i) => i.RequestItems.users.map((r: any) => r.DeleteRequest.Key.SK));

/**
 * 默认场景：users 表 3 行；PROFILE 带 authorId + 本服务头像；SUBSCRIPTION 带 otx
 */
function setupDefault(overrides: { avatarUrl?: string } = {}) {
  log.length = 0;
  mockSend.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, any> }) => {
    const i = cmd.input;
    log.push({ op: cmd.constructor.name, input: i });

    if (cmd.constructor.name === 'GetCommand') {
      if (i.Key.SK === 'PROFILE') {
        return Promise.resolve({
          Item: {
            authorId: 'author-xyz',
            avatarUrl: overrides.avatarUrl ?? 'https://img.shopmap.example/avatars/author-xyz/avatar-1.jpg',
          },
        });
      }
      if (i.Key.SK === 'SUBSCRIPTION') return Promise.resolve({ Item: { originalTransactionId: 'otx-1' } });
      return Promise.resolve({});
    }
    if (i.TableName === 'users' && i.KeyConditionExpression === 'PK = :pk') {
      return Promise.resolve({
        Items: [{ PK: UID, SK: 'PROFILE' }, { PK: UID, SK: 'SUBSCRIPTION' }, { PK: UID, SK: 'LIKE#post-x' }],
      });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  mockSend.mockReset();
  mockDeleteFromS3.mockReset();
  mockWriteTombstone.mockReset();
  asOwner();
  setupDefault();
});

// ------------------------------------------------------------
describe('鉴权（越权删号防线）', () => {
  it('无验签 JWT（无 cognitoSub）→ 401，一行数据都不动', async () => {
    hoisted.identity = { identityId: UID };
    const res = await del();
    expect(res.status).toBe(401);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('合法 JWT 但 Identity Pool 说它不属于这个 identityId → 403，一行数据都不动', async () => {
    // 攻击者：自己的合法 JWT + 受害者的 x-identity-id
    hoisted.tokenOwner = OTHER;
    const res = await del();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'IDENTITY_MISMATCH' } });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockWriteTombstone).not.toHaveBeenCalled();
  });

  it('token 不被身份池接受（GetId 返回 null）→ 403', async () => {
    hoisted.tokenOwner = null;
    const res = await del();
    expect(res.status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('Identity Pool 故障 → 503 fail-closed，绝不在无法确认归属时执行', async () => {
    hoisted.tokenOwner = new Error('TooManyRequestsException');
    const res = await del();
    expect(res.status).toBe(503);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
describe('个人信息删除', () => {
  it('删除 users 表该用户的全部行', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(batchDeletedSKs().sort()).toEqual(['LIKE#post-x', 'PROFILE', 'SUBSCRIPTION']);
    expect(await res.json()).toMatchObject({ data: { success: true, deletedRows: 3 } });
  });

  it('「我导入的」导入记录（IMPORT#<awemeId>）随本人分区一并删除（2026-10-19）', async () => {
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: any) => {
      const i = cmd.input;
      if (i.TableName === 'users' && i.KeyConditionExpression === 'PK = :pk') {
        log.push({ op: cmd.constructor.name, input: i });
        return Promise.resolve({ Items: [{ PK: UID, SK: 'PROFILE' }, { PK: UID, SK: 'IMPORT#7400000000000000001' }] });
      }
      return base(cmd);
    });
    const res = await del();
    expect(res.status).toBe(200);
    expect(batchDeletedSKs().sort()).toEqual(['IMPORT#7400000000000000001', 'PROFILE']);
  });

  it('清理三条反查映射：COGNITO# 绑定、AUTHOR# 与 TXID#（后两者条件删，只删属于本人的）', async () => {
    await del();
    expect(deletesOn('COGNITO#')[0].Key).toEqual({ PK: `COGNITO#${SUB}`, SK: 'BINDING' });

    const author = deletesOn('AUTHOR#')[0];
    expect(author.Key).toEqual({ PK: 'AUTHOR#author-xyz', SK: 'MAPPING' });
    expect(author.ConditionExpression).toBe('identityId = :me');

    const txid = deletesOn('TXID#')[0];
    expect(txid.Key).toEqual({ PK: 'TXID#otx-1', SK: 'MAPPING' });
    // otx 是客户端上报的，可能是认领来的他人 otx——不属于本人的映射绝不能删
    expect(txid.ConditionExpression).toBe('identityId = :me');
  });

  it('映射已不属于本人（条件删失败）→ 视为正常，注销照常成功', async () => {
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: any) => {
      if (cmd.constructor.name === 'DeleteCommand' && String(cmd.input.Key.PK).startsWith('TXID#')) {
        const e = new Error('cond'); e.name = 'ConditionalCheckFailedException';
        log.push({ op: 'DeleteCommand', input: cmd.input });
        return Promise.reject(e);
      }
      return base(cmd);
    });
    const res = await del();
    expect(res.status).toBe(200);
  });

  it('写墓碑（挡住 RC 续订事件复活订阅行）', async () => {
    await del();
    expect(mockWriteTombstone).toHaveBeenCalledWith(UID, expect.any(String));
  });

  it('删除本服务头像目录下的 S3 对象', async () => {
    await del();
    expect(mockDeleteFromS3).toHaveBeenCalledWith('avatars/author-xyz/avatar-1.jpg');
  });

  it('外部头像 URL（非本服务 CDN / 非头像目录）绝不去删', async () => {
    setupDefault({ avatarUrl: 'https://p3.douyinpic.com/avatars/x.jpg' });
    await del();
    expect(mockDeleteFromS3).not.toHaveBeenCalled();
  });

  it('头像删除失败不阻断注销（个人信息主体已删）', async () => {
    mockDeleteFromS3.mockRejectedValue(new Error('S3 down'));
    const res = await del();
    expect(res.status).toBe(200);
  });
});

// ------------------------------------------------------------
describe('不碰公开内容', () => {
  it('注销不读也不改 shared 表：导入帖署名是原视频博主，推荐者都是抖音博主', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(log.some((l) => l.input.TableName === 'shared' || l.input.RequestItems?.shared)).toBe(false);
  });
});

// ------------------------------------------------------------
describe('执行顺序', () => {
  it('先写墓碑、再删个人信息', async () => {
    const order: string[] = [];
    mockWriteTombstone.mockImplementation(async () => { order.push('tombstone'); });
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: any) => {
      if (cmd.input.RequestItems?.users) order.push('delete-rows');
      return base(cmd);
    });
    await del();
    expect(order.indexOf('tombstone')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('tombstone')).toBeLessThan(order.indexOf('delete-rows'));
  });

  it('删除个人信息失败 → 500（全流程幂等，客户端重试安全）', async () => {
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation((cmd: any) => {
      if (cmd.input.RequestItems?.users) return Promise.reject(new Error('DynamoDB 5xx'));
      return base(cmd);
    });
    const res = await del();
    expect(res.status).toBe(500);
  });
});

// ------------------------------------------------------------
describe('边界与失败', () => {
  it('无订阅、无头像的用户也能正常注销', async () => {
    log.length = 0;
    mockSend.mockImplementation((cmd: any) => {
      const i = cmd.input;
      log.push({ op: cmd.constructor.name, input: i });
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({});
      if (i.TableName === 'users' && i.KeyConditionExpression === 'PK = :pk') {
        return Promise.resolve({ Items: [{ PK: UID, SK: 'PROFILE' }] });
      }
      return Promise.resolve({});
    });
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { success: true } });
    // 没有 authorId / otx 就不该去删那两条映射
    expect(deletesOn('AUTHOR#')).toHaveLength(0);
    expect(deletesOn('TXID#')).toHaveLength(0);
  });

  it('中途出错 → 500，绝不谎报成功', async () => {
    mockSend.mockImplementation(() => Promise.reject(new Error('DynamoDB down')));
    const res = await del();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'DELETE_ACCOUNT_FAILED' } });
  });
});

// ------------------------------------------------------------
// 2026-10-19：删号撤销 Sign in with Apple 授权（审核指南 5.1.1(v)）
// ------------------------------------------------------------
describe('撤销 Apple 登录授权', () => {
  function delWithBody(body: unknown) {
    const app = new Hono();
    app.route('/', authRoute);
    return app.request('/me', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    mockRevoke.mockReset();
    mockRevoke.mockResolvedValue('revoked');
  });

  it('带 appleAuthorizationCode → 用它撤销授权，且在删除个人信息（写墓碑）之前', async () => {
    const res = await delWithBody({ appleAuthorizationCode: 'c-123' });
    expect(res.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledWith('c-123');
    expect(mockRevoke.mock.invocationCallOrder[0]).toBeLessThan(mockWriteTombstone.mock.invocationCallOrder[0]);
    expect(await res.json()).toMatchObject({ data: { success: true, appleRevoke: 'revoked' } });
  });

  it('没带 code（线上 1.2.8 / 非 Apple 登录）→ 跳过撤销，照常删号', async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ data: { success: true, appleRevoke: 'skipped' } });
    expect(batchDeletedSKs().length).toBe(3);
  });

  it('撤销失败不阻断删号', async () => {
    mockRevoke.mockResolvedValue('failed');
    const res = await delWithBody({ appleAuthorizationCode: 'c-expired' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { success: true, appleRevoke: 'failed' } });
    expect(mockWriteTombstone).toHaveBeenCalled();
  });

  it('越权删号被拒时不调用 Apple（code 不会被别人消耗）', async () => {
    hoisted.tokenOwner = OTHER;
    const res = await delWithBody({ appleAuthorizationCode: 'c-123' });
    expect(res.status).toBe(403);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('code 不是字符串 / 空串 → 当作没带', async () => {
    await delWithBody({ appleAuthorizationCode: 123 });
    await delWithBody({ appleAuthorizationCode: '   ' });
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
