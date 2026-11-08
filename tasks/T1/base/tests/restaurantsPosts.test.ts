/**
 * 小店 / 帖子写接口单元测试（2026-10-19）
 *
 * 覆盖：
 *   a) 用户自建已下线：旧版 App 的创建小店 / 补充推荐 / 自建内容配图上传入口 → 403 UGC_DISABLED
 *   c) 举报计数防幽灵行：目标不存在 → 404 且撤回举报行；重复举报用条件写拦（并发不再 +2）
 *   d) GET /v1/posts?restaurantIds= 上限 50（ENFORCE_POSTS_IDS_LIMIT 打开才拒绝）
 *   e) 报「已关门」：两位不同用户的待处理关门反馈 → 先下架（记 closedByReportsAt），一位或同一人重复报不动
 *   g) 第三层（rescueStatus=owner）的店先不给用户看（2026-10-24）：查店的三种方式都不返回，按城市取帖子也不带
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

const hoisted = vi.hoisted(() => ({
  identity: { identityId: 'ap-southeast-1:11111111-2222-3333-4444-555555555555', cognitoSub: 'sub-1' },
}));

vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return {
    ...actual,
    getDocClient: () => ({ send: mockSend }),
    USERS_TABLE: 'users', SHARED_TABLE: 'shared', VIDEOS_TABLE: 'videos',
  };
});
vi.mock('../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../src/middleware/auth.js')>('../src/middleware/auth.js');
  return {
    identityMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('identity', hoisted.identity);
      await next();
    },
    requireWriteAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
    requireSignedIn: actual.requireSignedIn,
    getIdentity: (c: { get: (k: string) => unknown }) => c.get('identity'),
  };
});
vi.mock('../src/middleware/ban.js', () => ({
  rejectBannedWrites: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/lib/post-utils.js', () => ({ processPostsForResponse: vi.fn(async (p: unknown[]) => p) }));

import { Hono } from 'hono';
import { restaurantsRoute } from '../src/routes/restaurants.js';
import { postsRoute } from '../src/routes/posts.js';
import { ugcRemoved } from '../src/middleware/ugcGate.js';

const UID = hoisted.identity.identityId;
const AWEME = '7400000000000000003';
const REST_ID = AWEME;

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);

function app() {
  const a = new Hono();
  a.route('/restaurants', restaurantsRoute);
  a.route('/posts', postsRoute);
  a.post('/images/upload', ugcRemoved); // 与 server.ts 挂法一致
  return a;
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app().request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

class ConditionalCheckFailedException extends Error {
  override name = 'ConditionalCheckFailedException';
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.ENFORCE_POSTS_IDS_LIMIT;
});

// ============================================================
// a) UGC 下线
// ============================================================

describe('用户自建已下线', () => {
  it.each([
    ['/restaurants', { restName: '店', latitude: 1, longitude: 1, recommendation: '好吃' }],
    ['/posts', { restId: 'r1', recommendation: '好吃' }],
    ['/images/upload', { image: 'aGk=', purpose: 'dish', entityId: 'e1' }],
  ])('%s 一律 403 UGC_DISABLED，不读不写数据库', async (path, body) => {
    const res = await postJson(path, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'UGC_DISABLED', message: '这项功能已下线，可以通过导入添加小店' },
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('收藏等其他入口照常', async () => {
    const res = await postJson(`/restaurants/${REST_ID}/bookmark`, { bookmarked: true });
    expect(res.status).toBe(200);
  });
});

// ============================================================
// c) 举报计数防幽灵行
// ============================================================

describe('举报', () => {
  it('举报不存在的店 → 404，撤回刚写的举报行（计数带 attribute_exists）', async () => {
    mockSend.mockImplementation((cmd: Cmd) => (
      cmd.constructor.name === 'UpdateCommand' ? Promise.reject(new ConditionalCheckFailedException()) : Promise.resolve({})
    ));
    const res = await postJson('/restaurants/ghost/report', { category: 'spam' });
    expect(res.status).toBe(404);
    const update = cmds().find((c) => c.constructor.name === 'UpdateCommand')!;
    expect(update.input.ConditionExpression).toBe('attribute_exists(PK)');
    const del = cmds().find((c) => c.constructor.name === 'DeleteCommand')!;
    expect(del.input.Key).toEqual({ PK: UID, SK: 'REPORT#ghost' });
  });

  it('重复举报（举报行条件写失败）→ 400 ALREADY_REPORTED，不加计数', async () => {
    mockSend.mockImplementation((cmd: Cmd) => (
      cmd.constructor.name === 'PutCommand' ? Promise.reject(new ConditionalCheckFailedException()) : Promise.resolve({})
    ));
    const res = await postJson('/restaurants/r1/report', { category: 'spam' });
    expect(res.status).toBe(400);
    expect(cmds().some((c) => c.constructor.name === 'UpdateCommand')).toBe(false);
  });

  it('举报存在的店 → 200，计数 +1', async () => {
    mockSend.mockImplementation((cmd: Cmd) => (
      cmd.constructor.name === 'UpdateCommand' ? Promise.resolve({ Attributes: { reportCount: 2 } }) : Promise.resolve({})
    ));
    const res = await postJson('/restaurants/r1/report', { category: 'spam' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { reportCount: 2 } });
  });

  it('举报不存在的帖子 → 404，撤回举报行（不再凭空建 POST#<id> 空壳）', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({}); // resolvePostSK：裸 id 不存在
      if (cmd.constructor.name === 'UpdateCommand') return Promise.reject(new ConditionalCheckFailedException());
      return Promise.resolve({});
    });
    const res = await postJson('/posts/123/report', { category: 'spam' });
    expect(res.status).toBe(404);
    const del = cmds().find((c) => c.constructor.name === 'DeleteCommand')!;
    expect(del.input.Key).toEqual({ PK: UID, SK: 'REPORT#POST#123' });
  });
});

// ============================================================
// d) restaurantIds 上限
// ============================================================

describe('GET /posts?restaurantIds= 上限', () => {
  const ids = Array.from({ length: 51 }, (_, i) => `r${i}`).join(',');

  it('开关打开：超过 50 个 → 400 TOO_MANY_IDS', async () => {
    process.env.ENFORCE_POSTS_IDS_LIMIT = 'true';
    const res = await app().request(`/posts?restaurantIds=${ids}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'TOO_MANY_IDS' } });
  });

  it('开关关闭（默认）：照常返回，不打断线上 1.2.8 的整城请求', async () => {
    const res = await app().request(`/posts?restaurantIds=${ids}`);
    expect(res.status).toBe(200);
  });

  it('50 个以内不受影响', async () => {
    process.env.ENFORCE_POSTS_IDS_LIMIT = 'true';
    const res = await app().request(`/posts?restaurantIds=${Array.from({ length: 50 }, (_, i) => `r${i}`).join(',')}`);
    expect(res.status).toBe(200);
  });
});

// ============================================================
// e) 两人报关门先下架（2026-10-20）
// ============================================================

describe('POST /restaurants/:id/issue 报已关门', () => {
  const report = () => postJson(`/restaurants/${REST_ID}/issue`, { issueTypes: ['closed'], restaurantName: '老王面馆' });
  const closeWrite = () => cmds().find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key?.PK === 'REST');
  const issuesFrom = (ids: string[]) => (cmd: Cmd) => (
    cmd.constructor.name === 'QueryCommand' && cmd.input.ExpressionAttributeValues?.[':pk'] === 'ISSUE'
      ? Promise.resolve({ Items: ids.map((identityId) => ({ identityId })) })
      : Promise.resolve({})
  );

  it('两位不同用户都报了 → 先下架，记 closedByReportsAt，条件写防重复', async () => {
    mockSend.mockImplementation(issuesFrom([UID, 'ap-southeast-1:99999999-2222-3333-4444-555555555555']));
    const res = await report();
    expect(res.status).toBe(200);
    const w = closeWrite()!;
    expect(w.input.ExpressionAttributeValues[':t']).toBe(true);
    expect(w.input.UpdateExpression).toContain('closedByReportsAt');
    expect(w.input.ConditionExpression).toContain('attribute_not_exists(permanentlyClosed)');
  });

  it('只有一位（或同一人报了两次）→ 不下架', async () => {
    mockSend.mockImplementation(issuesFrom([UID, UID]));
    const res = await report();
    expect(res.status).toBe(200);
    expect(closeWrite()).toBeUndefined();
  });

  it('店已下架（条件写失败）→ 反馈照常提交成功', async () => {
    mockSend.mockImplementation((cmd: Cmd) => (cmd.constructor.name === 'UpdateCommand'
      ? Promise.reject(new ConditionalCheckFailedException())
      : issuesFrom([UID, 'ap-southeast-1:99999999-2222-3333-4444-555555555555'])(cmd)));
    const res = await report();
    expect(res.status).toBe(200);
  });
});

// ============================================================
// f) 举报并进反馈、好吃 / 不好吃（2026-10-21）
// ============================================================

describe('POST /restaurants/:id/issue 新反馈类型', () => {
  it('不是小店、内容违规可以提交；不认识的类型仍 400', async () => {
    for (const t of ['not_xiaodian', 'inappropriate']) {
      const res = await postJson(`/restaurants/${REST_ID}/issue`, { issueTypes: [t], restaurantName: '老王面馆' });
      expect(res.status).toBe(200);
    }
    const bad = await postJson(`/restaurants/${REST_ID}/issue`, { issueTypes: ['spam'], restaurantName: '老王面馆' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /restaurants/:id/taste 好吃 / 不好吃', () => {
  const restWith = (counts: Record<string, number>, oldTaste?: string) => (cmd: Cmd) => {
    if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: { PK: 'REST', ...counts } });
    if (cmd.constructor.name === 'UpdateCommand' || cmd.constructor.name === 'DeleteCommand') {
      return Promise.resolve(oldTaste ? { Attributes: { taste: oldTaste } } : {});
    }
    return Promise.resolve({});
  };
  const tasteWrite = () => cmds().find((c) => (c.constructor.name === 'UpdateCommand' || c.constructor.name === 'DeleteCommand') && c.input.TableName === 'users')!;

  it('评好吃：写 users TASTE#<店id>，不直接改店上的计数；响应按这次推算', async () => {
    mockSend.mockImplementation(restWith({ tastyCount: 2, untastyCount: 1 }));
    const res = await postJson(`/restaurants/${REST_ID}/taste`, { taste: 'tasty' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ restaurantId: REST_ID, taste: 'tasty', tastyCount: 3, untastyCount: 1 });
    const w = tasteWrite();
    expect(w.constructor.name).toBe('UpdateCommand');
    expect(w.input.Key).toEqual({ PK: UID, SK: `TASTE#${REST_ID}` });
    expect(w.input.ExpressionAttributeValues[':t']).toBe('tasty');
    expect(cmds().some((c) => c.constructor.name === 'UpdateCommand' && c.input.TableName === 'shared')).toBe(false);
  });

  it('好吃改成不好吃：好吃 -1、不好吃 +1', async () => {
    mockSend.mockImplementation(restWith({ tastyCount: 2, untastyCount: 1 }, 'tasty'));
    const res = await postJson(`/restaurants/${REST_ID}/taste`, { taste: 'untasty' });
    expect((await res.json()).data).toMatchObject({ taste: 'untasty', tastyCount: 1, untastyCount: 2 });
  });

  it('taste 为 null：删掉那一行，原来的计数 -1', async () => {
    mockSend.mockImplementation(restWith({ tastyCount: 1 }, 'tasty'));
    const res = await postJson(`/restaurants/${REST_ID}/taste`, { taste: null });
    expect((await res.json()).data).toMatchObject({ taste: null, tastyCount: 0, untastyCount: 0 });
    expect(tasteWrite().constructor.name).toBe('DeleteCommand');
  });

  it('不认识的值 → 400；店不存在 → 404 且不写', async () => {
    expect((await postJson(`/restaurants/${REST_ID}/taste`, { taste: 'meh' })).status).toBe(400);
    mockSend.mockResolvedValue({});
    expect((await postJson(`/restaurants/${REST_ID}/taste`, { taste: 'tasty' })).status).toBe(404);
    expect(cmds().some((c) => c.input.TableName === 'users')).toBe(false);
  });

  it('没有登录凭证（只带身份 ID）→ 401 且不读不写，不看 ENFORCE_WRITE_AUTH', async () => {
    const sub = hoisted.identity.cognitoSub;
    (hoisted.identity as { cognitoSub?: string }).cognitoSub = undefined;
    try {
      mockSend.mockImplementation(restWith({ tastyCount: 2 }));
      expect((await postJson(`/restaurants/${REST_ID}/taste`, { taste: 'untasty' })).status).toBe(401);
      expect(cmds()).toHaveLength(0);
    } finally {
      hoisted.identity.cognitoSub = sub;
    }
  });
});

describe('GET /restaurants 带上自己的好吃 / 不好吃', () => {
  it('按 restaurantIds 查：bookmarked 与 myTaste 来自当前用户的 REST# / TASTE# 行', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'QueryCommand') {
        const prefix = cmd.input.ExpressionAttributeValues[':sk'];
        if (prefix === 'REST#') return Promise.resolve({ Items: [{ restaurantId: 'r1', bookmarked: true }] });
        if (prefix === 'TASTE#') return Promise.resolve({ Items: [{ restaurantId: 'r2', taste: 'untasty' }] });
      }
      if (cmd.constructor.name === 'BatchGetCommand') {
        return Promise.resolve({ Responses: { shared: [{ SK: 'r1', restaurantId: 'r1', tastyCount: 4 }, { SK: 'r2', restaurantId: 'r2' }] } });
      }
      return Promise.resolve({});
    });
    const res = await app().request('/restaurants?restaurantIds=r1,r2');
    const { data } = await res.json() as { data: Array<Record<string, unknown>> };
    expect(data.find((r) => r['restaurantId'] === 'r1')).toMatchObject({ bookmarked: true, myTaste: null, tastyCount: 4 });
    expect(data.find((r) => r['restaurantId'] === 'r2')).toMatchObject({ bookmarked: false, myTaste: 'untasty' });
  });
});

// ============================================================
// g) 第三层先不给用户看（2026-10-24）
// ============================================================

describe('第三层（rescueStatus=owner）的店先不给用户看', () => {
  const RESTS = [
    { SK: 'r1', restaurantId: 'r1', postRefs: ['p1'] },
    { SK: 'r2', restaurantId: 'r2', postRefs: ['p2'], rescueStatus: 'owner' },
    { SK: 'r3', restaurantId: 'r3', postRefs: ['p3'], rescueStatus: 'pending' },
    { SK: 'r4', restaurantId: 'r4', postRefs: ['p4'], permanentlyClosed: true },
  ];

  beforeEach(() => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'QueryCommand') {
        if (cmd.input.IndexName === 'city-index') return Promise.resolve({ Items: RESTS });
        if (cmd.input.IndexName === 'bookmark-index') return Promise.resolve({ Items: RESTS.map((r) => ({ restaurantId: r.restaurantId })) });
        return Promise.resolve({ Items: [] });
      }
      if (cmd.constructor.name === 'BatchGetCommand') {
        const keys = cmd.input.RequestItems.shared.Keys as Array<{ PK: string; SK: string }>;
        if (keys[0]?.PK === 'POST') return Promise.resolve({ Responses: { shared: keys.map((k) => ({ SK: k.SK })) } });
        return Promise.resolve({ Responses: { shared: RESTS.filter((r) => keys.some((k) => k.SK === r.SK)) } });
      }
      return Promise.resolve({});
    });
  });

  it('按城市、按 restaurantIds、按收藏查店：第三层和已下架的都不返回，第二层照常', async () => {
    for (const q of [`city=${encodeURIComponent('北京市')}`, 'restaurantIds=r1,r2,r3,r4', 'bookmarked=true']) {
      const res = await app().request(`/restaurants?${q}`);
      const { data } = await res.json() as { data: Array<Record<string, unknown>> };
      expect(data.map((r) => r['restaurantId']).sort(), q).toEqual(['r1', 'r3']);
    }
  });

  it('按城市取帖子：第三层店的帖子不取', async () => {
    const res = await app().request(`/posts?city=${encodeURIComponent('北京市')}`);
    expect(res.status).toBe(200);
    const postGet = cmds().find((c) => c.constructor.name === 'BatchGetCommand')!;
    const sks = (postGet.input.RequestItems.shared.Keys as Array<{ SK: string }>).map((k) => k.SK);
    expect(sks).toContain('p1');
    expect(sks).not.toContain('p2');
  });
});

describe('GET /restaurants/:id/place 店铺地图详情（1.3.0）', () => {
  it('整理成 App 要的样子；没有地图详情 data 为 null；店不存在 404', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        city: '郑州市',
        placeDetails: {
          source: 'amap', id: 'B0FFFY46NQ', api: 'amap-v5', fetchedAt: '', rawKey: '', photoTotal: 1,
          avgPrice: 14, rating: 4.7, phone: '13333862126;13673713806', hours: ['周一至周日 10:30-14:50,17:20-22:10'],
          photos: [{ key: 'place-photos/r/amap-0.jpg' }],
        },
      },
    });
    const res = await app().request(`/restaurants/${REST_ID}/place`);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      source: 'amap', priceText: '人均 ¥14', phones: ['13333862126', '13673713806'],
      photos: [{ url: 'https://img.shopmap.example/place-photos/r/amap-0.jpg' }],
      hoursLines: ['周一至周日 10:30–14:50、17:20–22:10'], timeZone: 'Asia/Shanghai',
    });
    const get = cmds().find((c) => c.constructor.name === 'GetCommand')!;
    expect(get.input.Key).toEqual({ PK: 'REST', SK: REST_ID });

    mockSend.mockResolvedValueOnce({ Item: { city: '郑州市' } });
    expect(await (await app().request(`/restaurants/${REST_ID}/place`)).json()).toEqual({ data: null });

    mockSend.mockResolvedValueOnce({});
    expect((await app().request(`/restaurants/${REST_ID}/place`)).status).toBe(404);
  });
});
