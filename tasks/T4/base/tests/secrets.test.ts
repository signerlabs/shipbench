/**
 * lib/secrets.ts 缓存 TTL 单元测试（审查 HIGH 6）
 *
 * 旧实现进程内缓存永不过期：在 Secrets Manager 补写 / 轮换字段对运行中的实例永远不生效。
 * 覆盖：
 *   a) TTL 内命中缓存，不重复请求
 *   b) 过 TTL 后重新拉取，新值生效（轮换最迟 5 分钟生效）
 *   c) 过期后拉取失败 → 回落上一份值（不把 Secrets Manager 抖动放大成业务故障）
 *   d) 从未成功拉取过 → 照常抛错
 *   e) 并发过期只发一次请求
 *   f) 同一 ARN 的 JSON / 字符串两种读法互不污染
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class {
    send(...a: unknown[]) { return mockSend(...a); }
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

import {
  getSecretJson,
  getSecretString,
  SECRET_CACHE_TTL_MS,
  __resetSecretsCacheForTests,
} from '../src/lib/secrets.js';

const ARN = 'shopmap/app-secrets';

beforeEach(() => {
  __resetSecretsCacheForTests();
  mockSend.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Secrets 缓存 TTL', () => {
  it('TTL 内命中缓存，只请求一次', async () => {
    mockSend.mockResolvedValue({ SecretString: JSON.stringify({ K: 'v1' }) });
    expect(await getSecretJson(ARN)).toEqual({ K: 'v1' });
    vi.setSystemTime(Date.now() + SECRET_CACHE_TTL_MS - 1);
    expect(await getSecretJson(ARN)).toEqual({ K: 'v1' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('过了 TTL 重新拉取，轮换后的新值生效', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ K: 'old' }) });
    expect(await getSecretJson(ARN)).toEqual({ K: 'old' });

    vi.setSystemTime(Date.now() + SECRET_CACHE_TTL_MS + 1);
    mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ K: 'new' }) });
    expect(await getSecretJson(ARN)).toEqual({ K: 'new' });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('过期后拉取失败 → 暂用上一份值，不抛错', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: JSON.stringify({ K: 'v1' }) });
    await getSecretJson(ARN);

    vi.setSystemTime(Date.now() + SECRET_CACHE_TTL_MS + 1);
    mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));
    expect(await getSecretJson(ARN)).toEqual({ K: 'v1' });
  });

  it('从未成功拉取过 → 照常抛错', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(getSecretJson(ARN)).rejects.toThrow('AccessDenied');
  });

  it('并发 miss 只发一次请求', async () => {
    let resolve!: (v: unknown) => void;
    mockSend.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const p1 = getSecretJson(ARN);
    const p2 = getSecretJson(ARN);
    resolve({ SecretString: JSON.stringify({ K: 'v' }) });
    expect(await p1).toEqual({ K: 'v' });
    expect(await p2).toEqual({ K: 'v' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('同一 ARN 的 JSON 与字符串读法分开缓存', async () => {
    mockSend.mockResolvedValue({ SecretString: '{"K":"v"}' });
    expect(await getSecretString(ARN)).toBe('{"K":"v"}');
    expect(await getSecretJson(ARN)).toEqual({ K: 'v' });
  });
});
