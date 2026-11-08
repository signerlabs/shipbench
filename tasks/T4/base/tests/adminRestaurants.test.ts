/**
 * 管理后台：改店城市同步 Feed 分区 + 导入帖举报对得上（2026-10-19）
 *
 * 覆盖：
 *   a) PUT /admin/restaurants/:id 改城市：REST 同步 locality / GSI1SK；POST 改 feed-index 分区
 *      （GSI4PK=FEEDCITY#新城市，缺 GSI4SK 时按原 createdAt 补），清掉残留 GSI1PK 与 cityHint；
 *      派生态 videos.city、RI.city 同步
 *   b) 举报：用户 REPORT 行 SK 一律 REPORT#POST#<裸 id>；导入帖 SK 是裸 awemeId，
 *      admin 旧实现按 REPORT#<awemeId> 查——查不到帖子举报，反而撞上同 id 店铺的举报行
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
import { adminRoute, reportSkForTarget } from '../src/routes/admin.js';

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);

function app() {
  const a = new Hono();
  a.route('/admin', adminRoute);
  return a;
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

// ============================================================
// a) 改城市
// ============================================================

describe('PUT /admin/restaurants/:id 改城市', () => {
  const REST_ID = '7400000000000000009';
  const IMPORT_POST = REST_ID; // 导入店 restaurantId 默认等于 awemeId
  const IMPORT_POST_2 = '7400000000000000019'; // 另一位博主并进来的帖子

  beforeEach(() => {
    mockSend.mockImplementation((cmd: Cmd) => {
      const n = cmd.constructor.name;
      if (n === 'GetCommand') {
        return Promise.resolve({ Item: { PK: 'REST', SK: REST_ID, city: '', postRefs: [IMPORT_POST, IMPORT_POST_2] } });
      }
      if (n === 'BatchGetCommand') {
        return Promise.resolve({
          Responses: {
            shared: [
              { PK: 'POST', SK: IMPORT_POST, createdAt: '2026-05-01T00:00:00.000Z', influencerUid: '9001', source: 'import' },
              { PK: 'POST', SK: IMPORT_POST_2, createdAt: '2026-06-01T00:00:00.000Z', influencerUid: '9002', source: 'import' },
            ],
          },
        });
      }
      if (n === 'QueryCommand') return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });
  });

  async function changeCity() {
    const res = await app().request(`/admin/restaurants/${REST_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: '天津市' }),
    });
    expect(res.status).toBe(200);
  }
  const updatesOn = (pk: string) => cmds().filter((c) => c.constructor.name === 'UpdateCommand' && c.input.Key?.PK === pk);

  it('REST：city 与 locality 同值，city-index 两个键都写（原来没城市的店补 GSI1SK），清 cityHint', async () => {
    await changeCity();
    const [rest] = updatesOn('REST');
    expect(rest.input.UpdateExpression).toContain('locality = :city');
    expect(rest.input.UpdateExpression).toContain('GSI1SK = :gsi1sk');
    expect(rest.input.ExpressionAttributeValues[':gsi1pk']).toBe('CITY#天津市');
    expect(rest.input.ExpressionAttributeValues[':gsi1sk']).toBe(`REST#${REST_ID}`);
    expect(rest.input.UpdateExpression).toMatch(/REMOVE .*cityHint/);
  });

  it('POST：改 feed-index 分区与 locality，按原 createdAt 补 GSI4SK，清残留 GSI1PK', async () => {
    await changeCity();
    const posts = updatesOn('POST');
    expect(posts).toHaveLength(2);
    const imp = posts.find((p) => p.input.Key.SK === IMPORT_POST)!;
    expect(imp.input.UpdateExpression).toContain('GSI4PK = :gsi4pk');
    expect(imp.input.UpdateExpression).toContain('locality = :city');
    expect(imp.input.UpdateExpression).toContain('GSI4SK = if_not_exists(GSI4SK, :gsi4sk)');
    expect(imp.input.UpdateExpression).toMatch(/REMOVE GSI1PK, cityHint/);
    expect(imp.input.UpdateExpression).not.toContain('GSI1PK = ');
    expect(imp.input.ExpressionAttributeValues[':gsi4pk']).toBe('FEEDCITY#天津市');
    expect(imp.input.ExpressionAttributeValues[':gsi4sk']).toBe(`2026-05-01T00:00:00.000Z#${IMPORT_POST}`);
  });

  it('派生态：videos.city 与 RI.city（两位博主）同步', async () => {
    await changeCity();
    const videos = cmds().filter((c) => c.constructor.name === 'UpdateCommand' && c.input.TableName === 'videos');
    expect(videos.map((v) => v.input.Key.awemeId).sort()).toEqual([IMPORT_POST, IMPORT_POST_2].sort());
    expect(videos.every((v) => v.input.ConditionExpression === 'attribute_exists(awemeId)')).toBe(true);
    const ri = updatesOn('RI').map((r) => r.input.Key.SK).sort();
    expect(ri).toEqual([`9001#${REST_ID}`, `9002#${REST_ID}`].sort());
  });

  it('只改店名不动城市 → 不碰 feed 分区', async () => {
    await app().request(`/admin/restaurants/${REST_ID}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurantName: '新名字' }),
    });
    expect(updatesOn('POST').every((p) => !p.input.UpdateExpression.includes('GSI4PK'))).toBe(true);
    expect(cmds().some((c) => c.input.TableName === 'videos')).toBe(false);
  });
});

// ============================================================
// a2) 认店出处、挽回状态与改动记录（2026-10-21）
// ============================================================

describe('PUT /admin/restaurants/:id 认店出处与改动记录', () => {
  const REST_ID = '7400000000000000010';

  beforeEach(() => {
    mockSend.mockImplementation((cmd: Cmd) => {
      const n = cmd.constructor.name;
      if (n === 'GetCommand') {
        return Promise.resolve({ Item: { PK: 'REST', SK: REST_ID, restaurantName: '肠粉店', rescueStatus: 'pending', postRefs: [] } });
      }
      if (n === 'QueryCommand') return Promise.resolve({ Items: [] });
      return Promise.resolve({});
    });
  });

  const put = (body: Record<string, unknown>, headers: Record<string, string> = {}) => app().request(`/admin/restaurants/${REST_ID}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const restUpdate = () => cmds().find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key?.PK === 'REST')!;
  const auditRow = () => cmds().find((c) => c.constructor.name === 'PutCommand' && c.input.Item?.PK === 'ADMINLOG')!;

  it('写入店并记出处：设 confirmedBy 与 locatedAt，清掉等云端找的状态，留改动记录', async () => {
    const res = await put({
      restaurantName: '陆河肠粉(邱屋小区店)', latitude: 22.7, longitude: 114.2, city: '深圳市',
      amapPoiId: 'B0FFG8HNLW', locatedBy: 'gemini-4-argon', locateReason: '博主评论给了店名和地址', confirmedBy: 'rerun',
    }, { 'x-admin-actor': 'cloud' });
    expect(res.status).toBe(200);
    const u = restUpdate();
    expect(u.input.UpdateExpression).toContain('confirmedBy = :cb');
    expect(u.input.UpdateExpression).toContain('locatedAt = :now');
    expect(u.input.UpdateExpression).toContain('amapPoiId = :poi');
    expect(u.input.UpdateExpression).toMatch(/REMOVE .*rescueStatus/);
    expect(u.input.ExpressionAttributeValues[':cb']).toBe('rerun');
    const a = auditRow();
    expect(a.input.Item.SK).toMatch(new RegExp(`#${REST_ID}$`));
    expect(a.input.Item.actor).toBe('cloud');
    expect(a.input.Item.before).toMatchObject({ restaurantName: '肠粉店', rescueStatus: 'pending' });
    expect(a.input.Item.changes).toMatchObject({ confirmedBy: 'rerun', amapPoiId: 'B0FFG8HNLW' });
  });

  it('confirmedBy 不在白名单 → 400，不写库', async () => {
    const res = await put({ confirmedBy: 'someone' });
    expect(res.status).toBe(400);
    expect(cmds().some((c) => c.constructor.name === 'UpdateCommand')).toBe(false);
  });

  it('只标挽回状态与说明：设 rescueStatus=owner，不记 locatedAt', async () => {
    const res = await put({ rescueStatus: 'owner', rescueNote: '高德两家分店，视频看不出是哪家' });
    expect(res.status).toBe(200);
    const u = restUpdate();
    expect(u.input.UpdateExpression).toContain('rescueStatus = :rs');
    expect(u.input.UpdateExpression).toContain('rescueNote = :rn');
    expect(u.input.UpdateExpression).not.toContain('locatedAt');
    expect(u.input.UpdateExpression).not.toMatch(/REMOVE .*rescueStatus/);
  });

  it('rescueStatus=null → 清掉；乱填的操作人记成 admin', async () => {
    const res = await put({ rescueStatus: null }, { 'x-admin-actor': 'Robert"); drop' });
    expect(res.status).toBe(200);
    expect(restUpdate().input.UpdateExpression).toMatch(/REMOVE .*rescueStatus/);
    expect(auditRow().input.Item.actor).toBe('admin');
  });

  it('rescueStatus 不在白名单 → 400', async () => {
    expect((await put({ rescueStatus: 'later' })).status).toBe(400);
  });

  it('只记出处或挽回状态 → 不去结这家店的用户反馈；改了店才结', async () => {
    const issueQueries = () => cmds().filter((c) => c.constructor.name === 'QueryCommand' && c.input.ExpressionAttributeValues?.[':pk'] === 'ISSUE');
    await put({ rescueStatus: 'pending', rescueNote: '管线认不出店名' });
    await put({ amapPoiId: 'B0FFG8HNLW', confirmedBy: 'rerun' });
    expect(issueQueries()).toHaveLength(0);
    await put({ restaurantName: '新名字', confirmedBy: 'cloud' });
    expect(issueQueries()).toHaveLength(1);
  });
});

// ============================================================
// b) 举报对得上
// ============================================================

describe('举报行 SK', () => {
  it('reportSkForTarget', () => {
    expect(reportSkForTarget('POST', '7400000000000000009')).toBe('REPORT#POST#7400000000000000009');
    expect(reportSkForTarget('POST', 'POST#uuid')).toBe('REPORT#POST#uuid');
    expect(reportSkForTarget('REST', '7400000000000000009')).toBe('REPORT#7400000000000000009');
  });

  it('GET /admin/reports：导入帖按 REPORT#POST#<awemeId> 查举报详情', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'ScanCommand') {
        return Promise.resolve({
          Items: cmd.input.ExpressionAttributeValues[':pk'] === 'POST'
            ? [{ PK: 'POST', SK: '7400000000000000009', reportCount: 1, restaurantName: '店' }]
            : [],
        });
      }
      if (cmd.constructor.name === 'QueryCommand') {
        return Promise.resolve({
          Items: cmd.input.ExpressionAttributeValues[':sk'] === 'REPORT#POST#7400000000000000009'
            ? [{ PK: 'ap-southeast-1:u', category: 'spam', createdAt: '2026-10-19' }]
            : [],
        });
      }
      return Promise.resolve({});
    });
    const body = await (await app().request('/admin/reports')).json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].reports).toHaveLength(1);
    expect(body.data[0].reports[0].category).toBe('spam');
  });

  it('驳回导入帖举报 → 删 REPORT#POST#<awemeId> 行，不误删同 id 店铺的举报行', async () => {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'GetCommand') return Promise.resolve({ Item: { PK: 'POST', SK: '7400000000000000009' } });
      if (cmd.constructor.name === 'QueryCommand') return Promise.resolve({ Items: [{ PK: 'ap-southeast-1:u' }] });
      return Promise.resolve({});
    });
    const res = await app().request('/admin/reports/POST/7400000000000000009/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss' }),
    });
    expect(res.status).toBe(200);
    const query = cmds().find((c) => c.constructor.name === 'QueryCommand')!;
    expect(query.input.ExpressionAttributeValues[':sk']).toBe('REPORT#POST#7400000000000000009');
    const batch = cmds().find((c) => c.constructor.name === 'BatchWriteCommand')!;
    expect(batch.input.RequestItems.users[0].DeleteRequest.Key.SK).toBe('REPORT#POST#7400000000000000009');
  });
});
