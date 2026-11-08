import { describe, expect, it } from 'vitest';
import { describeNetworkError } from '../src/lib/amap-mcp.js';

describe('describeNetworkError', () => {
  it('把 fetch failed 里的底层原因带出来', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }) });
    expect(describeNetworkError(err)).toBe('fetch failed（ETIMEDOUT connect ETIMEDOUT 1.2.3.4:443）');
  });
  it('多个地址都连不上时逐个列出', () => {
    const cause = new AggregateError([
      Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ENETUNREACH ::1:443'), { code: 'ENETUNREACH' }),
    ]);
    const out = describeNetworkError(new TypeError('fetch failed', { cause }));
    expect(out).toContain('ETIMEDOUT');
    expect(out).toContain('ENETUNREACH');
  });
  it('没有 cause 时只给原话', () => {
    expect(describeNetworkError(new Error('高德 MCP HTTP 500'))).toBe('高德 MCP HTTP 500');
    expect(describeNetworkError('x')).toBe('x');
  });
});
