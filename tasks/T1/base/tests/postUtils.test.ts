/**
 * processPostsForResponse 单元测试（2026-10-28 苹果 5.2.3 整改）
 *
 * 覆盖：卡片图换成店铺第一张照片（店没照片留空，不再下发视频封面）；
 *       菜品不带截图、菜名价格评价照留；recommendedBy 照旧不下发
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../src/lib/dynamodb.js', () => ({
  getDocClient: () => ({ send }),
  SHARED_TABLE: 'shared',
  USERS_TABLE: 'users',
}));

import { processPostsForResponse } from '../src/lib/post-utils.js';

type BatchGet = { input: { RequestItems: Record<string, { Keys: { SK: string }[] }> } };

const post = (over: Record<string, unknown> = {}) => ({
  SK: 'a1',
  restaurantId: 'r1',
  coverUrl: 'https://img.shopmap.example/covers/a1.jpg',
  recommendedBy: 'ap-southeast-1:00000000-0000-0000-0000-000000000000',
  dishes: [{ name: '牛肉面', price: '28', quote: '汤很鲜', s3Key: 'dishes/a1/dish_0.jpg' }],
  ...over,
});

beforeEach(() => {
  send.mockReset();
  // users 表：没点过赞；shared 表：只有 r1 这家店，带一张店铺照片
  send.mockImplementation(async (cmd: BatchGet) => {
    const req = cmd.input.RequestItems;
    if (req['users']) return { Responses: { users: [] } };
    return {
      Responses: {
        shared: req['shared'].Keys.filter((k) => k.SK === 'r1').map(() => ({
          SK: 'r1', tastyCount: 3, placeDetails: { photos: [{ key: 'place-photos/r1/amap-0.jpg' }] },
        })),
      },
    };
  });
});

describe('processPostsForResponse', () => {
  it('卡片图换成这家店的第一张店铺照片，不再下发视频封面', async () => {
    const [p] = await processPostsForResponse([post()], 'me');
    expect(p['coverUrl']).toBe('https://img.shopmap.example/place-photos/r1/amap-0.jpg');
    expect(p['tastyCount']).toBe(3);
  });

  it('店没有照片、店不存在都留空', async () => {
    const [p] = await processPostsForResponse([post({ SK: 'a2', restaurantId: 'r2' })], 'me');
    expect(p['coverUrl']).toBe('');
    expect(p['tastyCount']).toBe(0);
  });

  it('菜品去掉截图，菜名、价格、评价照留；recommendedBy 照旧不下发', async () => {
    const [p] = await processPostsForResponse([post()], 'me');
    expect(p['dishes']).toEqual([{ name: '牛肉面', price: '28', quote: '汤很鲜' }]);
    expect(p).not.toHaveProperty('recommendedBy');
  });
});
