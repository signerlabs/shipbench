/**
 * 用户端导入已下线（2026-10-28 苹果 5.2.3 整改：App 里不再导入第三方视频分享链接，小店由后台导入）
 *
 * POST /v1/parse 一律 403 + UGC_DISABLED；已提交的任务照常能轮询 GET /v1/parse/jobs/:jobId，
 * 后台批量导入走 /v1/parse/batch，都不受影响。
 * 1.3.0 构建 2 起 App 里没有导入入口，还会打这个接口的只有没升级的旧版：
 * 1.2.9 认识 UGC_DISABLED，提示「这项功能已下线」。原先回 IMPORT_DISABLED，1.2.9 不认识，
 * 按 403 兜底提示「没有权限进行此操作」，用户看不懂、写进了差评（2026-11-08 改）。
 * 1.2.8 及以前两个码都不认识，仍按历史的同城校验 403 提示。
 */

import type { Handler } from 'hono';

export const IMPORT_DISABLED_BODY = {
  error: { code: 'UGC_DISABLED', message: '这项功能已下线' },
} as const;

export const importRemoved: Handler = (c) => c.json(IMPORT_DISABLED_BODY, 403);
