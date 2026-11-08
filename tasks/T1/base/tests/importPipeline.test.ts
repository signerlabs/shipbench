/**
 * 导入流水线 persistImportedRestaurant（create 模式）单元测试（2026-10-19；2026-10-20 改为吃认店代理的结果）
 *
 * 覆盖：
 *   a) 非探店 → videos 写 failReason=not_food_review；额度退回走幂等事务（带 jobId）
 *   b) 处理阶段：落库前依次写 stage=geocoding / persisting
 *   c) 调序：用户收藏行（users REST# / INFLUENCER#）在 shared 实体之后写——收藏行一落库就会经
 *      Stream 驱动计数，计数要求实体已存在，先写收藏会漏计 / 旧版会抢跑建出残缺店
 *   d) 代理认不出店名 → 拒收（带原因码 + 完整提示、退额度、不建店）；境外的店 2026-10-21 起照收
 *   e) 代理定到店 → 坐标、三层城市、地址、高德编号取选中的店，店名纠为高德官方名；
 *      Google 定到的（台湾和中国以外）记 Google 编号、坐标来源 google；
 *      拿不准 → 不上地图（城市空、标待补全），候选与代理的依据存到店上交后台
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { persistImportedRestaurant } from '../src/lib/video-import-pipeline.js';
import type { AgentPoi, ShopAgentResult } from '../src/lib/shop-agent.js';

const mockSend = vi.fn();
const s3Send = vi.fn();

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);

const UID = 'ap-southeast-1:11111111-2222-3333-4444-555555555555';
const AWEME = '7400000000000000002';

function deps() {
  return {
    dynamoClient: { send: mockSend } as never,
    s3Client: { send: s3Send } as never,
    ffmpegPath: '/bin/false',
    bucket: 'bucket',
    videosTable: 'videos',
    usersTable: 'users',
    sharedTable: 'shared',
  };
}

function meta() {
  return {
    awemeId: AWEME,
    identityId: UID,
    rateLimitDate: '2026-10-19',
    jobId: 'job-9',
    videoMeta: { influencerUid: '9001', influencerName: '博主' },
    coverUrlPromise: Promise.resolve('https://img.shopmap.example/covers/x.jpg'),
    avatarUrlPromise: Promise.resolve('https://img.shopmap.example/avatars/9001.jpg'),
  };
}

const POI: AgentPoi = {
  id: 'B0FFTEST01', name: '老王面馆(朝阳店)', address: '朝阳路 1 号',
  administrativeArea: '北京市', city: '北京市', district: '朝阳区', type: '餐饮服务;中餐厅', typecode: '050100',
  lat: 39.9, lng: 116.4, source: 'amap',
};
const GPOI: AgentPoi = {
  id: 'ChIJnerbone', name: 'Da Nerbone', address: 'Piazza del Mercato Centrale, 50123 Firenze FI, Italy',
  administrativeArea: 'Tuscany', city: 'Florence', district: '', type: 'restaurant|food', typecode: '',
  lat: 43.776, lng: 11.253, source: 'google', countryCode: 'IT', status: 'OPERATIONAL',
};

/** 认店代理的结果：默认认出店名、没定到位置 */
function agentResult(over: Partial<ShopAgentResult> = {}): ShopAgentResult {
  return {
    is_restaurant_review: true, rejection_reason: null, restaurant_name: '老王面馆', name_evidence: 'signboard',
    city: '北京市', location_hint: '北京市朝阳区', dishes: [], tags: ['面'],
    decision: 'uncertain', chosen: null, candidates: [], reason: '招牌写着老王面馆，高德上朝阳有两家分不清',
    source: 'video', model: 'gemini-3.1-pro-preview', turns: 3, toolCalls: 2, toolErrors: 0, trace: [],
    usage: { calls: 3, promptTokens: 0, audioTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0 }, ms: 1000,
    ...over,
  };
}

const run = (a: ShopAgentResult) => persistImportedRestaurant(deps(), a, { videoPath: '/tmp/__nope__.mp4' }, meta(), { mode: 'create' });
const restPut = () => cmds().find((c) => c.constructor.name === 'PutCommand' && c.input.Item?.PK === 'REST')!;
const postPut = () => cmds().find((c) => c.constructor.name === 'PutCommand' && c.input.Item?.PK === 'POST')!;
const videoWrites = () => cmds().filter((c) => c.constructor.name === 'UpdateCommand' && c.input.TableName === 'videos');

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  s3Send.mockReset();
});

describe('非探店视频', () => {
  it('videos 写 rejected + failReason=not_food_review，额度退回带 jobId 走事务', async () => {
    const out = await run(agentResult({ is_restaurant_review: false, rejection_reason: '这是 vlog', decision: 'not_review' }));
    expect(out.isRestaurantReview).toBe(false);

    const rejected = videoWrites()[0];
    expect(rejected.input.ExpressionAttributeValues[':s']).toBe('rejected');
    expect(rejected.input.ExpressionAttributeValues[':fr']).toBe('not_food_review');

    const refund = cmds().find((c) => c.constructor.name === 'TransactWriteCommand')!;
    expect(refund.input.TransactItems[0].Update.Key).toEqual({ PK: UID, SK: 'JOB#job-9' });
  });
});

describe('代理认不出店名：拒收不建店', () => {
  it('认不出真实店名（代理交 no_name，或没店名也没选中店）：rejected + no_place_name，不编名字建店', async () => {
    for (const a of [agentResult({ decision: 'no_name', restaurant_name: undefined }), agentResult({ restaurant_name: undefined })]) {
      mockSend.mockClear();
      const out = await run(a);
      expect(out.isRestaurantReview).toBe(false);
      expect(videoWrites()[0].input.ExpressionAttributeValues[':fr']).toBe('no_place_name');
      expect(cmds().some((c) => c.input.TableName === 'shared')).toBe(false);
    }
  });

  it('认不出店名的留下模型交的其余字段，二次确认到店后不用再跑模型（2026-11-05）', async () => {
    await run(agentResult({ decision: 'no_name', restaurant_name: undefined, blogger_summary: '这家很好吃', tags: ['川菜'], reason: '没看到招牌' }));
    const write = videoWrites()[0].input;
    expect(write.UpdateExpression).toContain('noNameDraft = :draft');
    const draft = write.ExpressionAttributeValues[':draft'];
    expect(draft.bloggerSummary).toBe('这家很好吃');
    expect(draft.tags).toEqual(['川菜']);
    expect(draft.reason).toBe('没看到招牌');
    expect(Array.isArray(draft.dishes)).toBe(true);
    // 交给 DynamoDB 的值里不能有 undefined
    expect(JSON.stringify(draft)).toBe(JSON.stringify(JSON.parse(JSON.stringify(draft))));
  });

  it('其他拒收原因不留这些字段', async () => {
    await run(agentResult({ is_restaurant_review: false, rejection_reason: '这是 vlog', decision: 'not_review', blogger_summary: '不该留' }));
    const write = videoWrites()[0].input;
    expect(write.UpdateExpression).not.toContain('noNameDraft');
    expect(write.ExpressionAttributeValues[':draft']).toBeUndefined();
  });
});

describe('太短没价值、不是小店、不是餐饮店：拒收不建店（2026-10-21、10-26）', () => {
  it('low_quality / not_xiaodian / not_food 各给自己的码和不提视频的提示，退额度，不写 shared', async () => {
    const cases: Array<[Partial<ShopAgentResult>, string, string]> = [
      [{ decision: 'low_quality', rejection_reason: '7 秒只拍了门头' }, 'low_quality', '这条太短'],
      [{ decision: 'not_xiaodian', rejection_reason: '麦当劳', restaurant_name: '麦当劳' }, 'not_xiaodian', '连锁快餐'],
      [{ decision: 'not_food', rejection_reason: '书店里的书吧', restaurant_name: '某书店' }, 'not_food', '不是餐饮店'],
      [{ decision: 'closed', rejection_reason: '高德标了暂停营业', restaurant_name: '老王面馆' }, 'shop_closed', '已经关门'],
    ];
    for (const [over, code, hint] of cases) {
      mockSend.mockClear();
      const out = await run(agentResult(over));
      expect(out.isRestaurantReview).toBe(false);
      const w = videoWrites()[0];
      expect(w.input.ExpressionAttributeValues[':s']).toBe('rejected');
      expect(w.input.ExpressionAttributeValues[':fr']).toBe(code);
      expect(w.input.ExpressionAttributeValues[':fm']).toContain(hint);
      expect(w.input.ExpressionAttributeValues[':fm']).not.toMatch(/视频|导入|抖音|链接/);
      expect(cmds().some((c) => c.constructor.name === 'TransactWriteCommand')).toBe(true);
      expect(cmds().some((c) => c.input.TableName === 'shared')).toBe(false);
    }
  });
});

describe('代理定到店 / 拿不准', () => {
  it('定到店：坐标、三层城市、地址、高德编号取选中的店，店名纠为高德官方名，进城市分区', async () => {
    const out = await run(agentResult({ decision: 'located', chosen: POI, reason: '门头和地址对得上' }));
    expect(out.city).toBe('北京市');
    const rest = restPut().input.Item;
    expect(rest).toMatchObject({
      restaurantName: '老王面馆(朝阳店)', latitude: 39.9, longitude: 116.4, coordinateSource: 'amap', amapPoiId: 'B0FFTEST01',
      address: '朝阳路 1 号', city: '北京市', locality: '北京市', administrativeArea: '北京市', subLocality: '朝阳区',
      GSI1PK: 'CITY#北京市', locateReason: '门头和地址对得上', locatedBy: 'gemini-3.1-pro-preview', nameSource: 'identified',
    });
    expect(rest.needsManualReview).toBeUndefined();
    expect(rest.geoCandidates).toBeUndefined();
    expect(postPut().input.Item).toMatchObject({ restaurantName: '老王面馆(朝阳店)', city: '北京市', GSI4PK: 'FEEDCITY#北京市' });
    const completed = videoWrites().pop()!;
    expect(completed.input.ExpressionAttributeValues).toMatchObject({ ':s': 'completed', ':ld': 'located', ':lb': 'gemini-3.1-pro-preview', ':as': 'video' });
  });

  it('Google 定到的店（2026-10-21）：记 Google 编号、坐标来源 google，不记高德编号，店名用 Google 的', async () => {
    const out = await run(agentResult({ decision: 'located', chosen: GPOI, restaurant_name: 'Da Nerbone', city: 'Florence' }));
    expect(out.city).toBe('Florence');
    const rest = restPut().input.Item;
    expect(rest).toMatchObject({
      restaurantName: 'Da Nerbone', latitude: 43.776, longitude: 11.253, coordinateSource: 'google', googlePlaceId: 'ChIJnerbone',
      address: 'Piazza del Mercato Centrale, 50123 Firenze FI, Italy', city: 'Florence', administrativeArea: 'Tuscany', GSI1PK: 'CITY#Florence',
    });
    expect(rest.amapPoiId).toBeUndefined();
    expect(rest.subLocality).toBeUndefined();
  });

  it('拿不准时 Google 的候选记 Google 编号', async () => {
    await run(agentResult({ candidates: [GPOI] }));
    expect(restPut().input.Item.geoCandidates).toEqual([expect.objectContaining({ name: 'Da Nerbone', googlePlaceId: 'ChIJnerbone', source: 'agent' })]);
    expect(restPut().input.Item.geoCandidates[0].poiId).toBeUndefined();
  });

  it('拿不准：不上地图（无坐标、城市空、标待补全），候选与依据存到店上，城市线索留给后台', async () => {
    await run(agentResult({ candidates: [POI] }));
    const rest = restPut().input.Item;
    expect(rest.latitude).toBeUndefined();
    expect(rest.city).toBe('');
    expect(rest.GSI1PK).toBeUndefined();
    expect(rest.needsManualReview).toBe(true);
    expect(rest.cityHint).toBe('北京市');
    expect(rest.geoReviewReason).toBe('agent-uncertain');
    expect(rest.geoCandidates).toEqual([{
      name: '老王面馆(朝阳店)', address: '朝阳路 1 号', latitude: 39.9, longitude: 116.4, city: '北京市', poiId: 'B0FFTEST01', source: 'agent',
    }]);
    expect(rest.locateReason).toContain('分不清');
    expect(rest.restaurantName).toBe('老王面馆');
  });
});

describe('已有推荐者再导入（2026-10-28）', () => {
  it('INFLUENCER 已存在：只更新名字和计数，不改头像（库里的头像可能已换成软陶像）', async () => {
    mockSend.mockImplementation(async (c: Cmd) => {
      if (c.constructor.name === 'PutCommand' && c.input.Item?.PK === 'INFLUENCER') {
        throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    });
    await run(agentResult());
    const upd = cmds().find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key?.PK === 'INFLUENCER')!;
    expect(upd.input.UpdateExpression).not.toContain('influencerAvatar');
    expect(upd.input.ExpressionAttributeValues).not.toHaveProperty(':avatar');
  });
});

describe('探店视频落库顺序', () => {
  it('处理阶段依次 geocoding → persisting，且都在 shared 落库之前', async () => {
    await run(agentResult());
    const all = cmds();
    const stageWrites = all
      .map((c, i) => ({ i, stage: c.constructor.name === 'UpdateCommand' && c.input.TableName === 'videos' ? c.input.ExpressionAttributeValues[':stage'] : undefined }))
      .filter((s) => s.stage);
    expect(stageWrites.map((s) => s.stage)).toEqual(['geocoding', 'persisting']);
    const firstShared = all.findIndex((c) => c.input.TableName === 'shared');
    expect(stageWrites[1].i).toBeLessThan(firstShared);
  });

  it('用户收藏行在 shared 实体（POST/REST/INFLUENCER/RI）之后写', async () => {
    await run(agentResult());
    const puts = cmds()
      .filter((c) => c.constructor.name === 'PutCommand')
      .map((c) => `${c.input.TableName}:${c.input.Item.PK}`);
    const userRows = puts.map((p, i) => (p.startsWith('users:') ? i : -1)).filter((i) => i >= 0);
    const sharedRows = puts.map((p, i) => (p.startsWith('shared:') ? i : -1)).filter((i) => i >= 0);
    expect(sharedRows.length).toBeGreaterThanOrEqual(4);
    // 收藏 REST# / INFLUENCER# + 「我导入的」导入记录 IMPORT#（2026-10-19）
    expect(userRows.length).toBe(3);
    expect(Math.min(...userRows)).toBeGreaterThan(Math.max(...sharedRows));

    // completed 仍是最后的提交点
    const last = videoWrites().pop()!;
    expect(last.input.ExpressionAttributeValues[':s']).toBe('completed');
  });
});
