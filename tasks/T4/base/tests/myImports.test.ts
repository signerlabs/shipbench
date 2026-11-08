/**
 * 「我导入的」单元测试（2026-10-19）
 *
 * 约定：导入记录 = users 表 PK=<identityId>, SK="IMPORT#<awemeId>"，{ awemeId, restaurantId, importedAt, via }，
 *       条件写 attribute_not_exists（同一视频只记第一次导入）
 * 覆盖：
 *   a) recordImport：条件写、重复写返回 exists、system-batch / 缺字段不写、其它异常照抛
 *   b) 三处写入时机及幂等：
 *      · 解析流水线新视频落库（收藏行之后、videos completed 之前；重跑不覆盖第一次的导入时间）
 *      · POST /v1/parse 去重命中「已完成」（同时下发这家店的 latitude / longitude / city）
 *      · GET /v1/parse/jobs/:jobId 轮询拿到 completed（先记导入、再翻 JOB；写失败 500 且 JOB 不翻）
 *   c) 不写的情况：非探店 / 失败 / 新视频入队 / 处理中 / system-batch / JOB 已是终态
 *   d) GET /v1/auth/my-imports：导入时间倒序、最多 200 条（被跳过的由更早的补足）、跳过已不存在与被下架的、
 *      经安全管线（剥 recommendedBy、带 liked）、分页读全部导入记录
 *   e) GET /v1/auth/stats 的 importCount：与列表同一口径、不受 200 条上限影响
 *
 * DynamoDB 用一个极简内存表模拟（Get / 条件 Put / Query / BatchGet 有真实效果，Update 只记录不生效）。
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
const mockLambdaSend = vi.fn();

const hoisted = vi.hoisted(() => ({
  identity: { identityId: 'ap-southeast-1:11111111-2222-3333-4444-555555555555', cognitoSub: 'sub-1' } as {
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
  isEnforceParseAuth: () => true,
}));
vi.mock('../src/middleware/adminAuth.js', () => ({
  adminAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/middleware/ban.js', () => ({
  rejectBannedWrites: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/lib/secrets.js', () => ({ getAppSecrets: vi.fn(async () => ({ TIKHUB_API_KEY: 'k' })) }));
vi.mock('../src/lib/s3.js', () => ({ uploadToS3: vi.fn(), deleteFromS3: vi.fn(), existsInS3: vi.fn() }));
vi.mock('../src/lib/content-moderation.js', () => ({ moderateText: vi.fn(), moderateImage: vi.fn() }));
vi.mock('../src/lib/account-tombstone.js', () => ({ writeDeletionTombstone: vi.fn(), isDeletedIdentity: vi.fn() }));
vi.mock('../src/lib/appstore.js', () => ({ verifySubscriptionWithApple: vi.fn(), verifyLifetimePurchaseWithApple: vi.fn() }));
vi.mock('../src/lib/apple-signin.js', () => ({ revokeAppleAuthorization: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send(...a: unknown[]) { return mockLambdaSend(...a); } },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));

import { Hono } from 'hono';
import { parseRoute } from '../src/routes/parse.js';
import { authRoute } from '../src/routes/auth.js';
import { recordImport } from '../src/lib/import-record.js';
import { persistImportedRestaurant } from '../src/lib/video-import-pipeline.js';
import type { ShopAgentResult } from '../src/lib/shop-agent.js';

const UID = hoisted.identity.identityId;
const AWEME = '7400000000000000011';
const REST_ID = 'rest-1';

// ============================================================
// 极简内存 DynamoDB
// ============================================================

type Item = Record<string, any>;
type Cmd = { constructor: { name: string }; input: Record<string, any> };

class ConditionalCheckFailedException extends Error {
  override name = 'ConditionalCheckFailedException';
}

const tables: Record<string, Map<string, Item>> = { users: new Map(), shared: new Map(), videos: new Map() };
const log: Cmd[] = [];
/** Query 每页条数（测分页时调小） */
let queryPageSize = Infinity;

const keyOf = (table: string, key: Item) => (table === 'videos' ? String(key.awemeId) : `${key.PK}|${key.SK}`);
const seed = (table: string, item: Item) => { tables[table].set(keyOf(table, item), { ...item }); };
const row = (table: string, key: Item) => tables[table].get(keyOf(table, key));

function fakeSend(cmd: Cmd): Promise<unknown> {
  log.push(cmd);
  const i = cmd.input;
  switch (cmd.constructor.name) {
    case 'GetCommand': {
      const item = row(i.TableName, i.Key);
      return Promise.resolve({ Item: item ? { ...item } : undefined });
    }
    case 'PutCommand': {
      if (String(i.ConditionExpression ?? '').includes('attribute_not_exists') && row(i.TableName, i.Item)) {
        return Promise.reject(new ConditionalCheckFailedException('exists'));
      }
      seed(i.TableName, i.Item);
      return Promise.resolve({});
    }
    case 'QueryCommand': {
      const pk = i.ExpressionAttributeValues[':pk'];
      const prefix = String(i.ExpressionAttributeValues[':prefix'] ?? '');
      const all = [...tables[i.TableName].values()]
        .filter((it) => it.PK === pk && String(it.SK).startsWith(prefix))
        .sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
      const start = i.ExclusiveStartKey ? all.findIndex((it) => it.SK === i.ExclusiveStartKey.SK) + 1 : 0;
      const page = all.slice(start, start + queryPageSize);
      const more = start + page.length < all.length;
      return Promise.resolve({
        Items: page.map((it) => ({ ...it })),
        ...(more ? { LastEvaluatedKey: { PK: pk, SK: page[page.length - 1].SK } } : {}),
      });
    }
    case 'BatchGetCommand': {
      const Responses: Record<string, Item[]> = {};
      for (const [table, req] of Object.entries<any>(i.RequestItems)) {
        Responses[table] = req.Keys.map((k: Item) => row(table, k)).filter(Boolean).map((it: Item) => ({ ...it }));
      }
      return Promise.resolve({ Responses });
    }
    default:
      // UpdateCommand / TransactWriteCommand：只记录，本测试不依赖其效果
      return Promise.resolve({});
  }
}

const importRows = () => [...tables.users.values()].filter((it) => String(it.SK).startsWith('IMPORT#'));
const importPuts = () => log.filter((c) => c.constructor.name === 'PutCommand' && String(c.input.Item?.SK).startsWith('IMPORT#'));

function seedVideoAndShop(video: Item = {}) {
  seed('videos', { awemeId: AWEME, status: 'completed', restaurantId: REST_ID, influencerUid: '9001', city: '北京市', ...video });
  seed('shared', { PK: 'POST', SK: AWEME, awemeId: AWEME, restaurantId: REST_ID, source: 'import', recommendedBy: 'ap-southeast-1:someone-else', city: '北京市', restaurantName: '老王面馆' });
  seed('shared', { PK: 'REST', SK: REST_ID, restaurantId: REST_ID, city: '北京市', latitude: 39.9, longitude: 116.4, postRefs: [AWEME] });
}

function app() {
  const a = new Hono();
  a.route('/parse', parseRoute);
  a.route('/auth', authRoute);
  return a;
}

/** TikHub 返回一条普通视频 */
function stubTikHub() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: {
      aweme_detail: {
        aweme_id: AWEME, desc: '探店', aweme_type: 0,
        video: { duration: 30000, play_addr: { url_list: ['https://v.amemv.com/x.mp4'] }, cover: { url_list: ['https://c/x.jpg'] } },
        author: { uid: '9001', nickname: '博主', avatar_thumb: { url_list: ['https://a/x.jpg'] } },
      },
    },
  }), { status: 200 })));
}

function submit() {
  return app().request('/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://v.douyin.com/abc/' }),
  });
}

beforeEach(() => {
  for (const t of Object.values(tables)) t.clear();
  log.length = 0;
  queryPageSize = Infinity;
  hoisted.identity = { identityId: UID, cognitoSub: 'sub-1' };
  mockSend.mockReset();
  mockSend.mockImplementation(fakeSend);
  mockLambdaSend.mockReset();
  mockLambdaSend.mockResolvedValue({});
  process.env.PARSE_LAMBDA_ARN = 'arn:aws:lambda:ap-southeast-1:000:function:parse';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PARSE_LAMBDA_ARN;
});

// ============================================================
// a) recordImport
// ============================================================

describe('recordImport', () => {
  const client = { send: mockSend } as never;
  const params = { identityId: UID, awemeId: AWEME, restaurantId: REST_ID, importedAt: '2026-10-19T10:00:00.000Z', via: 'dedup' as const };

  it('条件写一行 IMPORT#<awemeId>：awemeId / restaurantId / importedAt / via', async () => {
    expect(await recordImport(client, 'users', params)).toBe('created');
    const [put] = importPuts();
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(put.input.Item).toEqual({
      PK: UID, SK: `IMPORT#${AWEME}`, awemeId: AWEME, restaurantId: REST_ID,
      importedAt: '2026-10-19T10:00:00.000Z', via: 'dedup',
    });
  });

  it('同一视频再记 → exists，第一次的导入时间不被覆盖', async () => {
    await recordImport(client, 'users', params);
    expect(await recordImport(client, 'users', { ...params, importedAt: '2026-10-20T00:00:00.000Z', via: 'poll' })).toBe('exists');
    expect(importRows()).toHaveLength(1);
    expect(importRows()[0]).toMatchObject({ importedAt: '2026-10-19T10:00:00.000Z', via: 'dedup' });
  });

  it('system-batch / 缺 restaurantId → skipped，不发请求', async () => {
    expect(await recordImport(client, 'users', { ...params, identityId: 'system-batch' })).toBe('skipped');
    expect(await recordImport(client, 'users', { ...params, restaurantId: '' })).toBe('skipped');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('其它异常照抛（交调用方：流水线转失败 / 接口回 500 让客户端重试）', async () => {
    mockSend.mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'));
    await expect(recordImport(client, 'users', params)).rejects.toThrow('ProvisionedThroughputExceeded');
  });
});

// ============================================================
// b/c) 写入时机 ①：解析流水线
// ============================================================

describe('解析流水线（persistImportedRestaurant create）', () => {
  const deps = () => ({
    dynamoClient: { send: mockSend } as never,
    s3Client: { send: vi.fn() } as never,
    ffmpegPath: '/bin/false',
    bucket: 'bucket',
    videosTable: 'videos',
    usersTable: 'users',
    sharedTable: 'shared',
  });
  const meta = (identityId = UID) => ({
    awemeId: AWEME,
    identityId,
    rateLimitDate: '2026-10-19',
    jobId: 'job-1',
    videoMeta: { influencerUid: '9001', influencerName: '博主' },
    coverUrlPromise: Promise.resolve('https://img.shopmap.example/covers/x.jpg'),
    avatarUrlPromise: Promise.resolve('https://img.shopmap.example/avatars/9001.jpg'),
  });
  // 认店代理的结果（2026-10-20 起入库入参）：认出店名但没定到位置（不调高德、不判重）
  const agentResult = (over: Partial<ShopAgentResult>): ShopAgentResult => ({
    is_restaurant_review: true, rejection_reason: null, restaurant_name: '老王面馆', name_evidence: 'signboard',
    city: '北京市', location_hint: '北京市朝阳区', dishes: [], tags: ['面'],
    decision: 'uncertain', chosen: null, candidates: [], reason: '',
    source: 'video', model: 'test-model', turns: 1, toolCalls: 0, toolErrors: 0, trace: [],
    usage: { calls: 1, promptTokens: 0, audioTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0 }, ms: 0,
    ...over,
  });
  const review = () => agentResult({});
  const run = (analysis: ShopAgentResult, identityId?: string) =>
    persistImportedRestaurant(deps(), analysis, { videoPath: '/tmp/__nope__.mp4' }, meta(identityId), { mode: 'create' });
  const completedIndex = () => log.findIndex((c) => c.constructor.name === 'UpdateCommand'
    && c.input.TableName === 'videos' && c.input.ExpressionAttributeValues?.[':s'] === 'completed');

  it('探店视频：收藏行之后、videos completed 之前给提交者记一条导入', async () => {
    await run(review());
    expect(importRows()).toEqual([expect.objectContaining({
      PK: UID, SK: `IMPORT#${AWEME}`, awemeId: AWEME, restaurantId: AWEME, via: 'pipeline',
    })]);
    const importIdx = log.indexOf(importPuts()[0]);
    const lastBookmarkIdx = Math.max(...log
      .map((c, i) => (c.constructor.name === 'PutCommand' && /^(REST|INFLUENCER)#/.test(String(c.input.Item?.SK)) && c.input.TableName === 'users' ? i : -1)));
    expect(importIdx).toBeGreaterThan(lastBookmarkIdx);
    expect(importIdx).toBeLessThan(completedIndex());
  });

  it('幂等：失败重试 / 重复导入再跑一遍 → 条件写跳过，导入时间仍是第一次的，流水线照常完成', async () => {
    await run(review());
    const first = { ...importRows()[0] };
    log.length = 0;
    await run(review());
    expect(importRows()).toEqual([first]);
    expect(completedIndex()).toBeGreaterThanOrEqual(0);
  });

  it('导入记录写失败 → 流水线抛错（交全局异常处理），不会把 videos 标成 completed', async () => {
    mockSend.mockImplementation((cmd: Cmd) => (
      cmd.constructor.name === 'PutCommand' && String(cmd.input.Item?.SK).startsWith('IMPORT#')
        ? Promise.reject(new Error('DynamoDB 5xx')) : fakeSend(cmd)
    ));
    await expect(run(review())).rejects.toThrow('DynamoDB 5xx');
    expect(completedIndex()).toBe(-1);
  });

  it('非探店视频 → 不记导入', async () => {
    await run(agentResult({ is_restaurant_review: false, rejection_reason: '这是 vlog', decision: 'not_review' }));
    expect(importPuts()).toHaveLength(0);
  });

  it('system-batch（运营批量导入）→ 不记导入', async () => {
    await run(review(), 'system-batch');
    expect(importPuts()).toHaveLength(0);
    expect([...tables.users.values()]).toHaveLength(0);
  });
});

// ============================================================
// b/c) 写入时机 ②：POST /v1/parse 去重命中
// ============================================================

describe('POST /v1/parse', () => {
  beforeEach(() => stubTikHub());

  it('去重命中「已完成」→ 当前用户记一条导入；响应带这家店的 latitude / longitude / city', async () => {
    seedVideoAndShop();
    const res = await submit();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      jobId: `existing-${AWEME}`, status: 'completed', city: '北京市', latitude: 39.9, longitude: 116.4,
    });
    expect(importRows()).toEqual([expect.objectContaining({
      PK: UID, SK: `IMPORT#${AWEME}`, restaurantId: REST_ID, via: 'dedup',
    })]);
  });

  it('同一视频再次导入 → 仍是 completed，导入记录只有一行、导入时间不变', async () => {
    seedVideoAndShop();
    await submit();
    const first = { ...importRows()[0] };
    const res = await submit();
    expect((await res.json()).data.status).toBe('completed');
    expect(importRows()).toEqual([first]);
  });

  it('店还没坐标 → 不带 latitude / longitude（iOS 照走兜底）', async () => {
    seedVideoAndShop();
    seed('shared', { PK: 'REST', SK: REST_ID, restaurantId: REST_ID, city: '北京市', postRefs: [AWEME] });
    const body = await (await submit()).json();
    expect(body.data.status).toBe('completed');
    expect(body.data).not.toHaveProperty('latitude');
    expect(body.data).not.toHaveProperty('longitude');
  });

  it('已判非探店 → 不记导入', async () => {
    seed('videos', { awemeId: AWEME, status: 'rejected', rejectionReason: '带货' });
    expect((await (await submit()).json()).data.status).toBe('rejected');
    expect(importPuts()).toHaveLength(0);
  });

  it('新视频入队 / 视频正在处理 → 这时不记（完成时由流水线或轮询记）', async () => {
    expect((await (await submit()).json()).data.status).toBe('pending');
    seed('videos', { awemeId: AWEME, status: 'processing', updatedAt: new Date().toISOString() });
    expect((await (await submit()).json()).data.status).toBe('processing');
    expect(importPuts()).toHaveLength(0);
  });
});

// ============================================================
// b/c) 写入时机 ③：GET /v1/parse/jobs/:jobId
// ============================================================

describe('GET /v1/parse/jobs/:jobId', () => {
  const poll = () => app().request('/parse/jobs/job-1');
  const jobFlip = () => log.find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key?.SK === 'JOB#job-1');

  it('别人正在处理、我也提交了：轮询到 completed → 记一条导入，且先于 JOB 翻成 completed', async () => {
    seedVideoAndShop();
    seed('users', { PK: UID, SK: 'JOB#job-1', jobId: 'job-1', awemeId: AWEME, status: 'pending' });
    const body = await (await poll()).json();
    expect(body.data).toMatchObject({ status: 'completed', latitude: 39.9, longitude: 116.4 });
    expect(importRows()).toEqual([expect.objectContaining({
      PK: UID, SK: `IMPORT#${AWEME}`, restaurantId: REST_ID, via: 'poll',
    })]);
    expect(log.indexOf(importPuts()[0])).toBeLessThan(log.indexOf(jobFlip()!));
  });

  it('发起者自己轮询（流水线已记过）→ 条件写跳过，保留流水线写的那行', async () => {
    seedVideoAndShop();
    seed('users', { PK: UID, SK: 'JOB#job-1', jobId: 'job-1', awemeId: AWEME, status: 'pending' });
    seed('users', { PK: UID, SK: `IMPORT#${AWEME}`, awemeId: AWEME, restaurantId: REST_ID, importedAt: '2026-10-19T01:00:00.000Z', via: 'pipeline' });
    const body = await (await poll()).json();
    expect(body.data.status).toBe('completed');
    expect(importRows()).toEqual([expect.objectContaining({ importedAt: '2026-10-19T01:00:00.000Z', via: 'pipeline' })]);
    expect(jobFlip()).toBeDefined();
  });

  it('导入记录写失败 → 500，JOB 不翻 completed（下次轮询再补写）', async () => {
    seedVideoAndShop();
    seed('users', { PK: UID, SK: 'JOB#job-1', jobId: 'job-1', awemeId: AWEME, status: 'pending' });
    mockSend.mockImplementation((cmd: Cmd) => (
      cmd.constructor.name === 'PutCommand' && String(cmd.input.Item?.SK).startsWith('IMPORT#')
        ? Promise.reject(new Error('DynamoDB 5xx')) : fakeSend(cmd)
    ));
    expect((await poll()).status).toBe(500);
    expect(jobFlip()).toBeUndefined();
  });

  it.each([['rejected'], ['failed']])('视频 %s → 不记导入', async (status) => {
    seed('videos', { awemeId: AWEME, status });
    seed('users', { PK: UID, SK: 'JOB#job-1', jobId: 'job-1', awemeId: AWEME, status: 'pending' });
    expect((await (await poll()).json()).data.status).toBe(status);
    expect(importPuts()).toHaveLength(0);
  });

  it('JOB 已是 completed（之前轮询过 / 去重命中的 existing- 任务）→ 不再写', async () => {
    seedVideoAndShop();
    seed('users', { PK: UID, SK: 'JOB#job-1', jobId: 'job-1', awemeId: AWEME, status: 'completed' });
    expect((await (await poll()).json()).data.status).toBe('completed');
    expect(importPuts()).toHaveLength(0);
  });
});

// ============================================================
// d) GET /v1/auth/my-imports
// ============================================================

/** 第 n 条导入：importedAt 随 n 递增（n 越大越新） */
function seedImport(n: number, post: Item | null = {}) {
  const awemeId = `74${String(n).padStart(6, '0')}`;
  // SK 顺序故意与导入时间相反，验证不是按 SK 排序
  const importedAt = new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
  seed('users', { PK: UID, SK: `IMPORT#${awemeId}`, awemeId, restaurantId: `r-${n}`, importedAt, via: 'pipeline' });
  if (post) {
    seed('shared', {
      PK: 'POST', SK: awemeId, awemeId, restaurantId: `r-${n}`, source: 'import',
      recommendedBy: UID, restaurantName: `店${n}`, ...post,
    });
  }
  return awemeId;
}

describe('GET /v1/auth/my-imports', () => {
  const list = async () => {
    const res = await app().request('/auth/my-imports');
    expect(res.status).toBe(200);
    return (await res.json()).data as Item[];
  };

  it('没有导入记录 → 空数组，不去读帖子', async () => {
    expect(await list()).toEqual([]);
    expect(log.some((c) => c.constructor.name === 'BatchGetCommand')).toBe(false);
  });

  it('按导入时间倒序；跳过已不存在 / 空壳 / 被下架的；经安全管线（剥 recommendedBy、带真实 liked）', async () => {
    const a = seedImport(1);
    const b = seedImport(2, { contentStatus: 'approved' });
    seedImport(3, null); // 帖子已不存在
    seedImport(4, { restaurantId: undefined }); // 只有 PK/SK 的空壳
    seedImport(5, { contentStatus: 'rejected' }); // 被下架（导入者本人也不再展示）
    const c = seedImport(6);
    seed('users', { PK: UID, SK: `LIKE#${b}` });
    // 别人的导入记录不出现
    seed('users', { PK: 'ap-southeast-1:other', SK: 'IMPORT#7499', awemeId: '7499', restaurantId: 'r', importedAt: '2030-01-01T00:00:00.000Z' });
    seed('shared', { PK: 'POST', SK: '7499', awemeId: '7499', restaurantId: 'r', source: 'import' });

    const data = await list();
    expect(data.map((p) => p.awemeId)).toEqual([c, b, a]);
    expect(data.every((p) => !('recommendedBy' in p))).toBe(true);
    expect(data.map((p) => p.liked)).toEqual([false, true, false]);
  });

  it('每条帖子带上所在店的「好吃」人数（首页卡片显示，2026-10-21）；店没人评过记 0', async () => {
    const a = seedImport(1);
    const b = seedImport(2);
    seed('shared', { PK: 'REST', SK: 'r-1', restaurantId: 'r-1', tastyCount: 7, untastyCount: 2 });
    const data = await list();
    const byId = Object.fromEntries(data.map((p) => [p.awemeId, p.tastyCount]));
    expect(byId).toEqual({ [a]: 7, [b]: 0 });
  });

  it('最多 200 条，取最新的；最新里被下架的跳过后由更早的补足', async () => {
    for (let n = 1; n <= 250; n++) seedImport(n, n >= 248 ? { contentStatus: 'rejected' } : {});
    const data = await list();
    expect(data).toHaveLength(200);
    // 最新可见的是第 247 条，第 200 条是第 48 条
    expect(data[0].restaurantName).toBe('店247');
    expect(data[199].restaurantName).toBe('店48');
  });

  it('导入记录分多页 → 全部读出后再排序', async () => {
    queryPageSize = 2;
    const ids = [1, 2, 3, 4, 5].map((n) => seedImport(n));
    const data = await list();
    expect(data.map((p) => p.awemeId)).toEqual([...ids].reverse());
    expect(log.filter((c) => c.constructor.name === 'QueryCommand').length).toBe(3);
  });
});

// ============================================================
// e) GET /v1/auth/stats importCount
// ============================================================

describe('GET /v1/auth/stats importCount', () => {
  const stats = async () => (await (await app().request('/auth/stats')).json()).data;

  it('没有导入记录 → 0', async () => {
    expect((await stats()).importCount).toBe(0);
  });

  it('与列表同一口径（不算已不存在 / 被下架的），且不受 200 条上限影响', async () => {
    for (let n = 1; n <= 230; n++) seedImport(n, n === 5 ? null : n === 6 ? { contentStatus: 'rejected' } : {});
    const data = await stats();
    expect(data.importCount).toBe(228);
    // 计数只取判定可见要用的字段
    const postReads = log.filter((c) => c.constructor.name === 'BatchGetCommand' && c.input.RequestItems.shared);
    expect(postReads.every((c) => c.input.RequestItems.shared.ProjectionExpression === 'SK, restaurantId, contentStatus')).toBe(true);
    // 其余字段照旧
    expect(data).toMatchObject({ totalFollowers: 0, contributionCount: 0 });
  });
});
