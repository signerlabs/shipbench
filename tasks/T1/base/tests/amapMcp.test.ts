/**
 * 高德官方 MCP 客户端 AmapMcpClient 单元测试（2026-10-28）
 *
 * 覆盖（高德用假的 fetch，计时器用假的）：
 *   a) 拉工具列表连不上一阵子（新加坡到高德偶尔断几分钟）→ 隔一会儿再试，连上后照常拿到认店的五个工具
 *   b) 一直连不上 → 几轮都失败后抛出原错误
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AmapMcpClient } from '../src/lib/amap-mcp.js';

const tools = ['maps_text_search', 'maps_around_search', 'maps_search_detail', 'maps_geo', 'maps_regeocode', 'maps_weather']
  .map((name) => ({ name, description: `${name} 说明`, inputSchema: { type: 'object', properties: {} } }));

/** 前 failCount 次请求报 fetch failed，之后正常回包 */
function stubAmap(failCount: number) {
  let n = 0;
  const fn = vi.fn(async (_url: string, init?: { body?: string }) => {
    if (n++ < failCount) throw new TypeError('fetch failed');
    const msg = JSON.parse(init?.body ?? '{}') as { method: string; id: number };
    const result = msg.method === 'tools/list' ? { tools } : {};
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`, { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AmapMcpClient.listTools', () => {
  it('a) 连不上一阵子 → 隔一会儿再试，连上后拿到认店的五个工具', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 一轮 rpc 连试 3 次；前两轮共 6 次都失败，第三轮连上
    const fetchFn = stubAmap(6);
    const p = new AmapMcpClient('k').listTools();
    await vi.runAllTimersAsync();
    const got = await p;
    expect(got.map((t) => t.name)).toEqual(['maps_text_search', 'maps_around_search', 'maps_search_detail', 'maps_geo', 'maps_regeocode']);
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });

  it('b) 一直连不上 → 几轮后抛出原错误', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = stubAmap(Infinity);
    const p = new AmapMcpClient('k').listTools();
    const assertion = expect(p).rejects.toThrow('fetch failed');
    await vi.runAllTimersAsync();
    await assertion;
    // 初次 + 3 轮重试，每轮 rpc 连试 3 次
    expect(fetchFn).toHaveBeenCalledTimes(12);
  });
});
