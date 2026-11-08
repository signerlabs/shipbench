/**
 * 认店代理管线层 runShopAgent 单元测试（2026-10-20）
 *
 * 覆盖（模型接入层用假的，高德官方 MCP 与 Web 服务详情用假的 fetch）：
 *   a) 交了查到过的编号 → 按编号取高德详情：坐标、三层城市、类别都来自详情，不信模型
 *   b) 交了没查到过的编号 → 拿不准；选中的店地图上不归餐饮类：模型写了依据照收，没写判不是餐饮店（not_food），
 *      不返回店也不留候选；模型自己判不是餐饮店照收（2026-10-26 产品负责人定：非餐饮的不上地图，以模型判断为准）
 *   c) 查过地图又判「不是探店」→ 拿不准
 *   g) 台湾和中国以外用 Google（2026-10-21）：按编号取详情（境外英文、台湾中文），城市按坐标反查；
 *      Google 上标停业的判关门（2026-10-26）、用错了地图的（Google 上的大陆港澳店、高德上的台湾店）只当候选；没配 Key 不算查地图报错
 *   d) 查高德全部报错 → 抛 AmapUnavailableError（导入转失败、Lambda 重试）
 *   e) 查询次数用完 → mustSubmit 为真；看视频那一趟失败 → 退回只看文字
 *   f) 菜品推荐分按 10 分制给的换算回 0–1
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AmapUnavailableError, douyinPublishedAt, runShopAgent, type AgentJob, type ShopAgentModel } from '../src/lib/shop-agent.js';

const usage = { calls: 1, promptTokens: 0, audioTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0 };

/** Google：搜店结果、按语言的详情、坐标反查城市 */
interface GoogleStub {
  places?: Array<Record<string, unknown>>;
  details?: Record<string, Record<string, unknown>>;
  detailsZh?: Record<string, Record<string, unknown>>;
  geocode?: Array<Record<string, unknown>>;
}

/** 高德：官方 MCP（tools/list、tools/call）+ Web 服务详情；Google：Places（搜店、详情）+ Geocoding */
function stubAmap(opts: { searchFails?: boolean; detail?: Record<string, Record<string, unknown>>; google?: GoogleStub } = {}) {
  const tools = ['maps_text_search', 'maps_around_search', 'maps_search_detail', 'maps_geo', 'maps_regeocode', 'maps_weather']
    .map((name) => ({ name, description: `${name} 说明`, inputSchema: { type: 'object', properties: {} } }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes('places:searchText')) return new Response(JSON.stringify({ places: opts.google?.places ?? [] }), { status: 200 });
    if (url.includes('places.googleapis.com/v1/places/')) {
      const u = new URL(url);
      const id = decodeURIComponent(u.pathname.split('/').pop() ?? '');
      const p = (u.searchParams.get('languageCode') === 'zh-CN' ? opts.google?.detailsZh : opts.google?.details)?.[id];
      return p ? new Response(JSON.stringify(p), { status: 200 }) : new Response('{}', { status: 404 });
    }
    if (url.includes('/geocode/json')) return new Response(JSON.stringify({ status: 'OK', results: opts.google?.geocode ?? [] }), { status: 200 });
    if (url.includes('mcp.amap.com')) {
      const msg = JSON.parse(init?.body ?? '{}') as { method: string; id: number; params?: { name?: string } };
      if (msg.method === 'tools/call' && opts.searchFails) return new Response('boom', { status: 502 });
      const result = msg.method === 'tools/list' ? { tools }
        : msg.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ pois: [{ id: 'B0FFAAAAAA', name: '老王面馆' }, { id: 'B0FFBBBBBB', name: '老王商场' }] }) }] }
          : {};
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`, { status: 200 });
    }
    if (url.includes('/v3/place/detail')) {
      const id = new URL(url).searchParams.get('id') ?? '';
      const poi = opts.detail?.[id];
      return new Response(JSON.stringify({ infocode: '10000', pois: poi ? [poi] : [] }), { status: 200 });
    }
    throw new Error(`没料到的请求 ${url}`);
  }));
}

const FOOD = { id: 'B0FFAAAAAA', name: '老王面馆(朝阳店)', location: '116.4,39.9', address: '朝阳路 1 号', pname: '北京市', cityname: '北京市', adname: '朝阳区', type: '餐饮服务;中餐厅', typecode: '050100' };
const MALL = { id: 'B0FFBBBBBB', name: '老王商场', location: '116.41,39.91', address: '朝阳路 2 号', pname: '北京市', cityname: '北京市', adname: '朝阳区', type: '购物服务;商场', typecode: '060100' };

/** Google 上的一家店（Places New 的原始格式） */
const gPlace = (id: string, name: string, country: string, extra: Record<string, unknown> = {}) => ({
  id, displayName: { text: name }, formattedAddress: `${name} 的地址`, location: { latitude: 43.776, longitude: 11.253 },
  types: ['restaurant', 'food', 'point_of_interest'], businessStatus: 'OPERATIONAL',
  addressComponents: [{ shortText: country, types: ['country', 'political'] }], ...extra,
});
const NERBONE = gPlace('ChIJnerbone', 'Da Nerbone', 'IT');
const FLORENCE = [{
  place_id: 'ChIJflorence', types: ['locality', 'political'], formatted_address: 'Florence, Italy',
  address_components: [
    { long_name: 'Florence', short_name: 'Florence', types: ['locality', 'political'] },
    { long_name: 'Tuscany', short_name: 'Tuscany', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'Italy', short_name: 'IT', types: ['country', 'political'] },
  ],
}];
const googleSearch: Array<[string, Record<string, unknown>]> = [['google_search_places', { query: 'Da Nerbone Florence' }]];
const gopts = { amapKey: 'k', googleKey: 'g', logPrefix: '[t]' };

/** 假的模型：先按 calls 调工具，再交 answer */
function fakeModel(answer: Record<string, unknown>, calls: Array<[string, Record<string, unknown>]> = [['maps_text_search', { keywords: '老王面馆' }]], onRun?: (job: AgentJob) => void): ShopAgentModel {
  return {
    name: 'fake-model',
    async run(job) {
      onRun?.(job);
      for (const [name, args] of calls) await job.callTool(name, args);
      return { answer, turns: calls.length + 1, usage };
    },
  };
}

const input = { video: Buffer.from('v'), description: '老王面馆真好吃' };
const opts = { amapKey: 'k', logPrefix: '[t]' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runShopAgent：交答案后的底线检查', () => {
  it('交了查到过的编号：按编号取高德详情，坐标、三层城市、类别都来自详情', async () => {
    stubAmap({ detail: { B0FFAAAAAA: FOOD } });
    const r = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFAAAAAA', restaurant_name: '老王面馆', name_evidence: 'signboard', multi_shop: false, dishes: [], reason: '门头' }), input, opts);
    expect(r.decision).toBe('located');
    expect(r.chosen).toMatchObject({ id: 'B0FFAAAAAA', name: '老王面馆(朝阳店)', lat: 39.9, lng: 116.4, city: '北京市', district: '朝阳区', typecode: '050100' });
    expect(r.toolCalls).toBe(1);
    expect(r.source).toBe('video');
  });

  it('交了没查到过的编号：拿不准，不信模型', async () => {
    stubAmap({ detail: { B0FFZZZZZZ: { ...FOOD, id: 'B0FFZZZZZZ' } } });
    const r = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFZZZZZZ', restaurant_name: '老王面馆', multi_shop: false, dishes: [], reason: '' }), input, opts);
    expect(r.decision).toBe('uncertain');
    expect(r.chosen).toBeNull();
  });

  it('选中的店地图上不归餐饮类、模型没写依据（2026-10-26）：判不是餐饮店，不返回店、不留候选、不留菜品', async () => {
    stubAmap({ detail: { B0FFAAAAAA: FOOD, B0FFBBBBBB: MALL } });
    const r = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFBBBBBB', candidate_ids: ['B0FFAAAAAA'], restaurant_name: '老王面馆', multi_shop: false, dishes: [{ name: '面', timestamp: '00:12', score: 0.8 }], reason: '' }), input, opts);
    expect(r.decision).toBe('not_food');
    expect(r.chosen).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.dishes).toEqual([]);
    expect(r.is_restaurant_review).toBe(true);
    expect(r.rejection_reason).toContain('老王商场');
  });

  it('选中的店地图上不归餐饮类、模型写了依据（2026-10-26 以模型判断为准）：照收', async () => {
    stubAmap({ detail: { B0FFBBBBBB: MALL } });
    const r = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFBBBBBB', food_category_note: '视频里是正经堂食的面馆，地图归错了类', restaurant_name: '老王面馆', multi_shop: false, dishes: [{ name: '面', timestamp: '00:12', score: 0.8 }], reason: '' }), input, opts);
    expect(r.decision).toBe('located');
    expect(r.chosen?.id).toBe('B0FFBBBBBB');
    expect(r.dishes).toHaveLength(1);
    expect(r.reason).toContain('按模型判断照收');
  });

  it('高德店名带「暂停营业」「装修中」（2026-10-26）：判关门，不返回店、不留候选、不留菜品', async () => {
    for (const tag of ['暂停营业', '装修中']) {
      const shut = { ...FOOD, name: `老王面馆(朝阳店)(${tag})` };
      stubAmap({ detail: { B0FFAAAAAA: shut } });
      const r = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFAAAAAA', restaurant_name: '老王面馆', multi_shop: false, dishes: [{ name: '面', timestamp: '00:12', score: 0.8 }], reason: '' }), input, opts);
      expect(r.decision).toBe('closed');
      expect(r.chosen).toBeNull();
      expect(r.candidates).toEqual([]);
      expect(r.dishes).toEqual([]);
      expect(r.rejection_reason).toContain('暂停营业');
      vi.unstubAllGlobals();
    }
  });

  it('模型判店已关门（2026-10-26）：查过地图也照收；提示词里写上视频发布年月', async () => {
    stubAmap();
    let prompt = '';
    const r = await runShopAgent(fakeModel({ decision: 'closed', rejection_reason: '评论说去年就关了', multi_shop: false, dishes: [], reason: '' }, undefined, (job) => { prompt = job.prompt; }), { ...input, publishedAt: new Date('2021-05-09T00:00:00Z') }, opts);
    expect(r.decision).toBe('closed');
    expect(r.rejection_reason).toBe('评论说去年就关了');
    expect(prompt).toContain('视频发布于 2021 年 5 月');
  });

  it('视频编号换算发布时间：高 32 位是 Unix 秒，不像抖音编号的不算', () => {
    expect(douyinPublishedAt('7119018622256794916')?.toISOString().slice(0, 10)).toBe('2022-07-11');
    expect(douyinPublishedAt('abc')).toBeUndefined();
    expect(douyinPublishedAt(undefined)).toBeUndefined();
  });

  it('模型判不是餐饮店（2026-10-26）：查没查过地图都照收，原因用模型写的，不留菜品', async () => {
    stubAmap();
    const quick = await runShopAgent(fakeModel({ decision: 'not_food', rejection_reason: '书店里的书吧', multi_shop: false, dishes: [{ name: '拿铁', timestamp: '00:05', score: 0.6 }], reason: '' }, []), input, opts);
    expect(quick.decision).toBe('not_food');
    expect(quick.rejection_reason).toBe('书店里的书吧');
    expect(quick.dishes).toEqual([]);
    expect(quick.candidates).toEqual([]);
    const searched = await runShopAgent(fakeModel({ decision: 'not_food', multi_shop: false, dishes: [], reason: '地图上是超市' }), input, opts);
    expect(searched.decision).toBe('not_food');
    expect(searched.rejection_reason).toBe('不是餐饮店');
  });

  it('查过地图又判不是探店：按拿不准处理（被叫停时乱交）', async () => {
    stubAmap();
    const r = await runShopAgent(fakeModel({ decision: 'not_review', multi_shop: false, dishes: [], reason: '1' }), input, opts);
    expect(r.decision).toBe('uncertain');
    expect(r.is_restaurant_review).toBe(true);
  });

  it('没查地图就判不是探店：照收', async () => {
    stubAmap();
    const r = await runShopAgent(fakeModel({ decision: 'not_review', rejection_reason: '在家做饭', multi_shop: false, dishes: [], reason: '' }, []), input, opts);
    expect(r.decision).toBe('not_review');
    expect(r.is_restaurant_review).toBe(false);
    expect(r.rejection_reason).toBe('在家做饭');
  });

  it('不到 10 秒的视频：直接判太短没价值，不调模型、不连高德；10 秒起照常认，提示词里写上时长', async () => {
    stubAmap();
    let ran = false;
    const r = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFAAAAAA', multi_shop: false, dishes: [], reason: '' }, [], () => { ran = true; }), { ...input, durationSec: 7 }, opts);
    expect(r.decision).toBe('low_quality');
    expect(r.source).toBe('video');
    expect(ran).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();

    let prompt = '';
    await runShopAgent(fakeModel({ decision: 'no_name', multi_shop: false, dishes: [], reason: '' }, [], (job) => { prompt = job.prompt; }), { ...input, durationSec: 12 }, opts);
    expect(prompt).toContain('视频时长：12 秒');
  });

  it('太短没价值（2026-10-21）：没查地图就判照收，带默认原因、不留菜品；查过地图再这么判按拿不准', async () => {
    stubAmap();
    const quick = await runShopAgent(fakeModel({ decision: 'low_quality', multi_shop: false, dishes: [{ name: '面', timestamp: '00:02', score: 0.8 }], reason: '7 秒只拍了门头' }, []), input, opts);
    expect(quick.decision).toBe('low_quality');
    expect(quick.is_restaurant_review).toBe(true);
    expect(quick.rejection_reason).toBe('太短，看不出是哪家店');
    expect(quick.dishes).toEqual([]);
    const searched = await runShopAgent(fakeModel({ decision: 'low_quality', multi_shop: false, dishes: [], reason: '' }), input, opts);
    expect(searched.decision).toBe('uncertain');
  });

  it('不是小店（2026-10-21）：查没查过地图都照收，原因用模型写的', async () => {
    stubAmap();
    const r = await runShopAgent(fakeModel({ decision: 'not_xiaodian', rejection_reason: '麦当劳', restaurant_name: '麦当劳', multi_shop: false, dishes: [], reason: '招牌是麦当劳' }), input, opts);
    expect(r.decision).toBe('not_xiaodian');
    expect(r.rejection_reason).toBe('麦当劳');
    expect(r.dishes).toEqual([]);
  });

  it('不再收境外判定（2026-10-21 起境外的店用 Google 找）：交 overseas 按拿不准', async () => {
    stubAmap();
    const r = await runShopAgent(fakeModel({ decision: 'overseas', location_hint: '日本东京千代田区', multi_shop: false, dishes: [], reason: '' }, []), input, opts);
    expect(r.decision).toBe('uncertain');
  });

  it('店名只有观众评论说（2026-10-22）：没有门牌或邻店招牌互证的只当候选；有互证的照常定到', async () => {
    stubAmap({ detail: { B0FFAAAAAA: FOOD } });
    const answer = { decision: 'located', poi_id: 'B0FFAAAAAA', restaurant_name: '老王面馆', name_evidence: 'comment', multi_shop: false, dishes: [], reason: '评论说是老王面馆' };
    const no = await runShopAgent(fakeModel(answer), input, opts);
    expect(no.decision).toBe('uncertain');
    expect(no.candidates.map((c) => c.id)).toEqual(['B0FFAAAAAA']);
    expect(no.reason).toContain('观众评论');
    const yes = await runShopAgent(fakeModel({ ...answer, comment_name_proof: '00:15 隔壁「华瑞门窗」招牌，高德上在这家旁边 11 米' }), input, opts);
    expect(yes.decision).toBe('located');
    expect(yes.comment_name_proof).toContain('华瑞门窗');
  });

  it('菜品推荐分按 10 分制给的换算回 0–1，没名字的菜丢掉', async () => {
    stubAmap();
    const r = await runShopAgent(fakeModel({
      decision: 'uncertain', restaurant_name: '老王面馆', multi_shop: false, reason: '',
      dishes: [{ name: '牛肉面', timestamp: '00:12', score: 8.5 }, { name: '', timestamp: '00:20', score: 0.5 }],
    }), input, opts);
    expect(r.dishes).toEqual([{ name: '牛肉面', timestamp: '00:12', score: 0.85, quote: null }]);
  });
});

describe('runShopAgent：台湾和中国以外用 Google（2026-10-21）', () => {
  const located = (poi_id: string) => fakeModel({ decision: 'located', poi_id, restaurant_name: 'Da Nerbone', name_evidence: 'signboard', multi_shop: false, dishes: [], reason: '招牌' }, googleSearch);
  const requests = () => (fetch as unknown as { mock: { calls: Array<[string, { body?: string }?]> } }).mock.calls;

  it('交了搜到过的 Google 编号：按编号取英文详情，城市按坐标反查；搜索结果给模型看中文', async () => {
    stubAmap({ google: { places: [NERBONE], details: { ChIJnerbone: NERBONE }, geocode: FLORENCE } });
    const r = await runShopAgent(located('ChIJnerbone'), input, gopts);
    expect(r.decision).toBe('located');
    expect(r.chosen).toMatchObject({
      id: 'ChIJnerbone', name: 'Da Nerbone', address: 'Da Nerbone 的地址', city: 'Florence', administrativeArea: 'Tuscany',
      lat: 43.776, lng: 11.253, source: 'google', countryCode: 'IT', status: 'OPERATIONAL',
    });
    expect(r.trace[0]).toContain('1 家');
    const search = requests().find(([u]) => u.includes('places:searchText'));
    expect(JSON.parse(search![1]!.body!)).toMatchObject({ textQuery: 'Da Nerbone Florence', languageCode: 'zh-CN' });
    expect(requests().some(([u]) => u.includes('/v1/places/ChIJnerbone?languageCode=en'))).toBe(true);
    expect(requests().some(([u]) => u.includes('/geocode/json') && u.includes('language=en'))).toBe(true);
  });

  it('台湾的店：店名、地址、城市换中文再取', async () => {
    const en = gPlace('ChIJliu', 'Liu Jiang Bento', 'TW');
    const zh = gPlace('ChIJliu', '刘江便当', 'TW', { formattedAddress: '台湾高雄市三民区' });
    const kaohsiung = [{
      place_id: 'ChIJkh', types: ['administrative_area_level_1', 'political'], formatted_address: '台湾高雄市',
      address_components: [{ long_name: '高雄市', short_name: '高雄市', types: ['administrative_area_level_1', 'political'] }, { long_name: '台湾', short_name: 'TW', types: ['country', 'political'] }],
    }];
    stubAmap({ google: { places: [en], details: { ChIJliu: en }, detailsZh: { ChIJliu: zh }, geocode: kaohsiung } });
    const r = await runShopAgent(located('ChIJliu'), input, gopts);
    expect(r.chosen).toMatchObject({ name: '刘江便当', address: '台湾高雄市三民区', city: '高雄市', administrativeArea: '高雄市', countryCode: 'TW' });
    expect(requests().some(([u]) => u.includes('/geocode/json') && u.includes('language=zh-CN'))).toBe(true);
  });

  it('Google 上标停业（2026-10-26）：判关门，不返回店、不留候选', async () => {
    for (const status of ['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY']) {
      const closed = { ...NERBONE, businessStatus: status };
      stubAmap({ google: { places: [closed], details: { ChIJnerbone: closed }, geocode: FLORENCE } });
      const r = await runShopAgent(located('ChIJnerbone'), input, gopts);
      expect(r.decision).toBe('closed');
      expect(r.chosen).toBeNull();
      expect(r.candidates).toEqual([]);
      expect(r.rejection_reason).toContain(status);
      vi.unstubAllGlobals();
    }
  });

  it('用错了地图：Google 上的大陆店、高德上的台湾店都只当候选', async () => {
    const cn = gPlace('ChIJcn', '老王面馆', 'CN');
    stubAmap({ google: { places: [cn], details: { ChIJcn: cn }, geocode: FLORENCE } });
    const g = await runShopAgent(located('ChIJcn'), input, gopts);
    expect(g.decision).toBe('uncertain');
    expect(g.candidates.map((c) => c.id)).toEqual(['ChIJcn']);

    stubAmap({ detail: { B0FFAAAAAA: { ...FOOD, pname: '台湾省', cityname: '台北市', adname: '大安区' } } });
    const a = await runShopAgent(fakeModel({ decision: 'located', poi_id: 'B0FFAAAAAA', restaurant_name: '老王面馆', multi_shop: false, dishes: [], reason: '' }), input, gopts);
    expect(a.decision).toBe('uncertain');
    expect(a.reason).toContain('用错了地图');
  });

  it('拿不准时 Google 候选直接用搜索结果，不另查详情', async () => {
    stubAmap({ google: { places: [NERBONE] } });
    const r = await runShopAgent(fakeModel({ decision: 'uncertain', candidate_ids: ['ChIJnerbone', 'ChIJnever'], multi_shop: false, dishes: [], reason: '' }, googleSearch), input, gopts);
    expect(r.candidates).toEqual([expect.objectContaining({ id: 'ChIJnerbone', name: 'Da Nerbone', source: 'google', city: '' })]);
    expect(requests().some(([u]) => u.includes('/v1/places/'))).toBe(false);
  });

  it('没配 Google Key：工具回报错，但不算查地图报错（不整次失败），交的 Google 编号不认', async () => {
    stubAmap();
    const r = await runShopAgent(located('ChIJnerbone'), input, opts);
    expect(r.decision).toBe('uncertain');
    expect(r.trace[0]).toContain('Google 地图暂时用不了');
    expect(r.toolErrors).toBe(0);
  });
});

describe('runShopAgent：失败与上限', () => {
  it('查高德全部报错：抛 AmapUnavailableError，不把没查成当拿不准入库', async () => {
    stubAmap({ searchFails: true });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as never);
    await expect(runShopAgent(fakeModel({ decision: 'uncertain', multi_shop: false, dishes: [], reason: '' }), input, opts))
      .rejects.toBeInstanceOf(AmapUnavailableError);
  });

  it('查询次数用完：mustSubmit 为真；同一轮里超出上限的查询不真查', async () => {
    stubAmap();
    let job: AgentJob | undefined;
    const calls: Array<[string, Record<string, unknown>]> = [['maps_text_search', {}], ['maps_text_search', {}], ['maps_text_search', {}]];
    const r = await runShopAgent(fakeModel({ decision: 'uncertain', multi_shop: false, dishes: [], reason: '' }, calls, (j) => { job = j; }), input, { ...opts, maxToolCalls: 2 });
    expect(job!.mustSubmit()).toBe(true);
    expect(r.toolCalls).toBe(2);
    expect(r.trace[2]).toContain('超过查询上限');
    const mcpCalls = (fetch as unknown as { mock: { calls: Array<[string, { body?: string }]> } }).mock.calls
      .filter(([u, init]) => u.includes('mcp.amap.com') && String(init?.body).includes('tools/call'));
    expect(mcpCalls).toHaveLength(2);
    expect(job!.tools.map((t) => t.name)).toEqual(['maps_text_search', 'maps_around_search', 'maps_search_detail', 'maps_geo', 'maps_regeocode', 'google_search_places', 'submit_answer']);
  });

  it('看视频那一趟失败：退回只看文字再认一次', async () => {
    stubAmap();
    const videos: Array<Buffer | null> = [];
    const model: ShopAgentModel = {
      name: 'fake-model',
      async run(job) {
        videos.push(job.video);
        if (job.video) throw new Error('Gemini 文件处理失败');
        return { answer: { decision: 'no_name', multi_shop: false, dishes: [], reason: '' }, turns: 1, usage };
      },
    };
    const r = await runShopAgent(model, input, opts);
    expect(videos).toEqual([input.video, null]);
    expect(r.source).toBe('text');
    expect(r.decision).toBe('no_name');
  });
});
