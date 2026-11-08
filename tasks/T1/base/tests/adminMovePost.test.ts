/**
 * 管理后台：把帖子挪到新店或已有的店（2026-10-21）
 *
 * 覆盖：
 *   a) 挪到新店：建 REST（编号用帖子 SK）、原店按下标删 postRef、POST 跟着改店名城市与 feed-index、
 *      videos 改店、RI 补新店删旧店、导入者的稍后去吃挪过去、两家店各一行 ADMINLOG
 *   b) 挪到已有店：postRefs 追加；原店挪空就下架；目标店已下架不让挪
 *   c) 编号被占用时顺延 -2；参数校验
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return {
    ...actual,
    getDocClient: () => ({ send: mockSend }),
    USERS_TABLE: 'users', SHARED_TABLE: 'shared', VIDEOS_TABLE: 'videos',
  };
});
vi.mock('../src/middleware/adminAuth.js', () => ({
  adminAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  verifyAdminCredentials: vi.fn(),
  signAdminToken: vi.fn(),
  verifyAdminToken: vi.fn(),
}));

import { Hono } from 'hono';
import { adminRoute } from '../src/routes/admin.js';

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);
const named = (n: string) => cmds().filter((c) => c.constructor.name === n);

function app() {
  const a = new Hono();
  a.route('/admin', adminRoute);
  return a;
}

const FROM = '7193153066038824248';
const MOVED = '7615850547782813861';
const IMPORTER = 'ap-southeast-1:importer';
const INF = '9001';

/** 按表和主键返回假数据；没列出的一律当不存在 */
function mockDb(rows: Record<string, Record<string, unknown>>) {
  mockSend.mockImplementation((cmd: Cmd) => {
    const n = cmd.constructor.name;
    if (n === 'GetCommand') {
      const { TableName, Key } = cmd.input;
      return Promise.resolve({ Item: rows[`${TableName}|${Key.PK}|${Key.SK}`] });
    }
    if (n === 'BatchGetCommand') {
      const keys = cmd.input.RequestItems.shared.Keys as { PK: string; SK: string }[];
      return Promise.resolve({ Responses: { shared: keys.map((k) => rows[`shared|${k.PK}|${k.SK}`]).filter(Boolean) } });
    }
    return Promise.resolve({});
  });
}

async function move(id: string, body: unknown) {
  const res = await app().request(`/admin/posts/${id}/move`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-actor': 'local' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any };
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('POST /admin/posts/:id/move 挪到新店', () => {
  beforeEach(() => {
    mockDb({
      [`shared|POST|${MOVED}`]: { PK: 'POST', SK: MOVED, restaurantId: FROM, influencerUid: INF, recommendedBy: IMPORTER, source: 'import', createdAt: '2026-03-01T00:00:00.000Z' },
      [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, restaurantName: '墨纪', city: '北京市', source: 'import', postRefs: [FROM, MOVED] },
      [`shared|POST|${FROM}`]: { PK: 'POST', SK: FROM, restaurantId: FROM, influencerUid: '9002', recommendedBy: 'someone-else', source: 'import' },
      [`users|${IMPORTER}|REST#${FROM}`]: { PK: IMPORTER, SK: `REST#${FROM}`, restaurantId: FROM, bookmarked: true, GSI3PK: `${IMPORTER}#BOOKMARK`, GSI3SK: `REST#${FROM}`, createdAt: '2026-03-01T00:00:00.000Z' },
    });
  });

  it('建新店、原店删 postRef、帖子跟着走、派生态和收藏一起改', async () => {
    const { status, json } = await move(MOVED, {
      to: 'new',
      restaurant: { restaurantName: '五道口墨西哥餐厅', city: '北京市', latitude: 39.99, longitude: 116.33, amapPoiId: 'B0TEST', confirmedBy: 'admin' },
    });
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ from: FROM, to: MOVED, createdNew: true, fromClosed: false, riAdded: true, riRemoved: true, bookmarkMoved: true });

    const rest = named('PutCommand').find((c) => c.input.Item.PK === 'REST')!.input;
    expect(rest.Item).toMatchObject({
      SK: MOVED, restaurantName: '五道口墨西哥餐厅', city: '北京市', GSI1PK: 'CITY#北京市', GSI1SK: `REST#${MOVED}`,
      latitude: 39.99, longitude: 116.33, coordinateSource: 'admin', amapPoiId: 'B0TEST', confirmedBy: 'admin',
      postRefs: [MOVED], splitFrom: FROM, createdAt: '2026-03-01T00:00:00.000Z',
    });
    expect(rest.Item.needsManualReview).toBeUndefined();
    expect(rest.ConditionExpression).toBe('attribute_not_exists(PK)');

    const fromUpd = named('UpdateCommand').find((c) => c.input.Key.PK === 'REST' && c.input.Key.SK === FROM)!.input;
    expect(fromUpd.UpdateExpression).toContain('REMOVE postRefs[1]');
    expect(fromUpd.ConditionExpression).toBe('postRefs[1] = :sk');
    expect(fromUpd.UpdateExpression).not.toContain('permanentlyClosed');

    const postUpd = named('UpdateCommand').find((c) => c.input.Key.PK === 'POST')!.input;
    expect(postUpd.ExpressionAttributeValues).toMatchObject({ ':rid': MOVED, ':name': '五道口墨西哥餐厅', ':city': '北京市', ':g4pk': 'FEEDCITY#北京市' });
    expect(postUpd.UpdateExpression).toContain('GSI4SK = if_not_exists(GSI4SK, :g4sk)');

    const video = named('UpdateCommand').find((c) => c.input.TableName === 'videos')!.input;
    expect(video.Key).toEqual({ awemeId: MOVED });
    expect(video.ExpressionAttributeValues[':rid']).toBe(MOVED);

    expect(named('PutCommand').some((c) => c.input.Item.PK === 'RI' && c.input.Item.SK === `${INF}#${MOVED}`)).toBe(true);
    expect(named('DeleteCommand').some((c) => c.input.Key.PK === 'RI' && c.input.Key.SK === `${INF}#${FROM}`)).toBe(true);

    const bmPut = named('PutCommand').find((c) => c.input.TableName === 'users')!.input;
    expect(bmPut.Item).toMatchObject({ PK: IMPORTER, SK: `REST#${MOVED}`, restaurantId: MOVED, GSI3SK: `REST#${MOVED}`, bookmarked: true });
    expect(named('DeleteCommand').some((c) => c.input.TableName === 'users' && c.input.Key.SK === `REST#${FROM}`)).toBe(true);

    const logs = named('PutCommand').filter((c) => c.input.Item.PK === 'ADMINLOG').map((c) => c.input.Item);
    expect(logs.map((l) => l.changes.action).sort()).toEqual(['move-post', 'move-post-in']);
    expect(logs.find((l) => l.restaurantId === FROM).before.postRefs).toEqual([FROM, MOVED]);
    expect(logs.every((l) => l.actor === 'local')).toBe(true);
  });

  it('导入者在原店还有别的帖子：给他收藏新店，原店收藏留着', async () => {
    mockDb({
      [`shared|POST|${MOVED}`]: { PK: 'POST', SK: MOVED, restaurantId: FROM, influencerUid: INF, recommendedBy: IMPORTER, source: 'import' },
      [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, restaurantName: '墨纪', city: '北京市', postRefs: [FROM, MOVED] },
      [`shared|POST|${FROM}`]: { PK: 'POST', SK: FROM, restaurantId: FROM, influencerUid: INF, recommendedBy: IMPORTER, source: 'import' },
      [`users|${IMPORTER}|REST#${FROM}`]: { PK: IMPORTER, SK: `REST#${FROM}`, restaurantId: FROM, bookmarked: true },
    });
    const { json } = await move(MOVED, { to: 'new', restaurant: { restaurantName: '新店' } });
    expect(json.data).toMatchObject({ bookmarkAdded: true, bookmarkMoved: false, riRemoved: false });
    expect(named('DeleteCommand')).toHaveLength(0);
    // 没城市、没坐标的新店进待补全，帖子退出 feed-index
    expect(named('PutCommand').find((c) => c.input.Item.PK === 'REST')!.input.Item.needsManualReview).toBe(true);
    expect(named('UpdateCommand').find((c) => c.input.Key.PK === 'POST')!.input.UpdateExpression).toContain('GSI4PK, GSI4SK');
  });

  it('帖子 SK 就是原店编号：新店编号顺延 -2', async () => {
    mockDb({
      [`shared|POST|${FROM}`]: { PK: 'POST', SK: FROM, restaurantId: FROM, source: 'import' },
      [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, restaurantName: '墨纪', city: '北京市', postRefs: [FROM, MOVED] },
    });
    const { status, json } = await move(FROM, { to: 'new', restaurant: { restaurantName: 'MAZ', city: '东京' } });
    expect(status).toBe(200);
    expect(json.data.to).toBe(`${FROM}-2`);
    const fromUpd = named('UpdateCommand').find((c) => c.input.Key.PK === 'REST' && c.input.Key.SK === FROM)!.input;
    expect(fromUpd.UpdateExpression).toContain('REMOVE postRefs[0]');
  });
});

describe('POST /admin/posts/:id/move 挪到已有店', () => {
  const TO = '7000000000000000001';

  it('追加到目标店；原店挪空就下架', async () => {
    mockDb({
      [`shared|POST|${MOVED}`]: { PK: 'POST', SK: MOVED, restaurantId: FROM, source: 'import' },
      [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, restaurantName: '墨纪', postRefs: [MOVED] },
      [`shared|REST|${TO}`]: { PK: 'REST', SK: TO, restaurantName: '目标店', city: '北京市', postRefs: [TO] },
    });
    const { status, json } = await move(MOVED, { to: TO });
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ to: TO, createdNew: false, fromClosed: true });
    const toUpd = named('UpdateCommand').find((c) => c.input.Key.PK === 'REST' && c.input.Key.SK === TO)!.input;
    expect(toUpd.UpdateExpression).toContain('list_append');
    expect(toUpd.ConditionExpression).toBe('NOT contains(postRefs, :sk)');
    const fromUpd = named('UpdateCommand').find((c) => c.input.Key.PK === 'REST' && c.input.Key.SK === FROM)!.input;
    expect(fromUpd.UpdateExpression).toContain('permanentlyClosed = :t');
    expect(fromUpd.UpdateExpression).toContain('rescueStatus');
  });

  it('目标店已下架：不让挪', async () => {
    mockDb({
      [`shared|POST|${MOVED}`]: { PK: 'POST', SK: MOVED, restaurantId: FROM },
      [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, postRefs: [FROM, MOVED] },
      [`shared|REST|${TO}`]: { PK: 'REST', SK: TO, permanentlyClosed: true, postRefs: [TO] },
    });
    const { status } = await move(MOVED, { to: TO });
    expect(status).toBe(409);
    expect(named('UpdateCommand')).toHaveLength(0);
  });
});

describe('POST /admin/posts/:id/move 参数校验', () => {
  beforeEach(() => {
    mockDb({
      [`shared|POST|${MOVED}`]: { PK: 'POST', SK: MOVED, restaurantId: FROM },
      [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, postRefs: [FROM] },
    });
  });
  it('缺 to、新店没店名、坐标只给一半、挪回原店：400', async () => {
    expect((await move(MOVED, {})).status).toBe(400);
    expect((await move(MOVED, { to: 'new' })).status).toBe(400);
    expect((await move(MOVED, { to: 'new', restaurant: { restaurantName: 'x', latitude: 1 } })).status).toBe(400);
    expect((await move(MOVED, { to: FROM })).status).toBe(400);
  });
  it('原店帖子列表里没有这条：409；帖子不存在：404', async () => {
    expect((await move(MOVED, { to: 'new', restaurant: { restaurantName: 'x' } })).status).toBe(409);
    expect((await move('nope', { to: 'new', restaurant: { restaurantName: 'x' } })).status).toBe(404);
  });
});

describe('PUT /admin/restaurants/:id 记 Google 店铺编号（2026-10-21）', () => {
  it('只给 googlePlaceId：记上、留改动记录，不结用户反馈', async () => {
    mockDb({ [`shared|REST|${FROM}`]: { PK: 'REST', SK: FROM, restaurantName: 'MAZ', city: 'Tokyo' } });
    const res = await app().request(`/admin/restaurants/${FROM}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ googlePlaceId: 'ChIJtest', confirmedBy: 'admin' }),
    });
    expect(res.status).toBe(200);
    const upd = named('UpdateCommand').find((c) => c.input.Key.PK === 'REST')!.input;
    expect(upd.UpdateExpression).toContain('googlePlaceId = :gp');
    expect(upd.ExpressionAttributeValues[':gp']).toBe('ChIJtest');
    expect(named('PutCommand').some((c) => c.input.Item.PK === 'ADMINLOG')).toBe(true);
    // 只记出处：不查、不结这家店的用户反馈
    expect(named('QueryCommand').some((c) => c.input.ExpressionAttributeValues?.[':pk'] === 'ISSUE')).toBe(false);
  });
});
