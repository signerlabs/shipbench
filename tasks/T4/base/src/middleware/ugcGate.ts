/**
 * 用户自建内容已下线（2026-10-19 停用，10-22 数据彻底删除）
 *
 * 旧版 App（1.2.8）还有三个自建入口，接口只留空壳、一律 403 UGC_DISABLED：
 *   - POST /v1/restaurants（创建小店）
 *   - POST /v1/posts（补充推荐）
 *   - POST /v1/images/upload（自建内容配图上传；头像走 /v1/auth/avatar，不受影响）
 * 1.2.9 起认识这个码；1.2.8 不认识，会按历史的同城校验 403 提示
 * 「只能推荐你当前所在城市的小店哦」——功能被挡住，只是文案不对。
 */

import type { Handler } from 'hono';

export const UGC_DISABLED_BODY = {
  error: { code: 'UGC_DISABLED', message: '这项功能已下线，可以通过导入添加小店' },
} as const;

export const ugcRemoved: Handler = (c) => c.json(UGC_DISABLED_BODY, 403);
