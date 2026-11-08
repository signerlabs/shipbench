/**
 * existingInfluencerAvatar 单元测试（2026-10-28）
 *
 * 覆盖：库里有头像就沿用；没这个人、没头像、读失败都回 null（按新推荐者拉抖音头像）
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi } from 'vitest';
import { existingInfluencerAvatar } from '../src/lib/influencer-avatar.js';

const client = (impl: () => Promise<unknown>) => ({ send: vi.fn(impl) }) as never;
const CLAY = 'https://img.shopmap.example/avatars/clay/77243783127-1028.webp';

describe('existingInfluencerAvatar', () => {
  it('库里有头像就返回它', async () => {
    expect(await existingInfluencerAvatar(client(async () => ({ Item: { influencerAvatar: CLAY } })), 'shared', '77243783127')).toBe(CLAY);
  });

  it('没这个人、没头像回 null', async () => {
    expect(await existingInfluencerAvatar(client(async () => ({})), 'shared', '1')).toBeNull();
    expect(await existingInfluencerAvatar(client(async () => ({ Item: { influencerAvatar: '' } })), 'shared', '1')).toBeNull();
  });

  it('没有 uid 不查库，回 null', async () => {
    const send = vi.fn();
    expect(await existingInfluencerAvatar({ send } as never, 'shared', '')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('读失败回 null，按新推荐者处理', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await existingInfluencerAvatar(client(async () => { throw new Error('boom'); }), 'shared', '1')).toBeNull();
  });
});
