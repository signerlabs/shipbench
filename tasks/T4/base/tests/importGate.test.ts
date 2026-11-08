/**
 * 用户端导入下线（2026-10-28）：POST /v1/parse 回 403 + UGC_DISABLED（旧版 1.2.9 认识这个码，提示「这项功能已下线」）
 *
 * 运行方式：npm test
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { importRemoved, IMPORT_DISABLED_BODY } from '../src/middleware/importGate.js';

describe('importRemoved', () => {
  it('回 403 + UGC_DISABLED，提示里不提抖音、导入、视频、链接', async () => {
    const app = new Hono();
    app.post('/v1/parse', importRemoved);
    const res = await app.request('/v1/parse', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(IMPORT_DISABLED_BODY);
    expect(IMPORT_DISABLED_BODY.error.code).toBe('UGC_DISABLED');
    expect(IMPORT_DISABLED_BODY.error.message).not.toMatch(/抖音|导入|视频|链接/);
  });
});
