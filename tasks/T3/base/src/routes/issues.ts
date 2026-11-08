/**
 * 问题报告路由（运营用）
 *
 * GET / — 查询问题报告列表（仅管理员）
 *
 * 2026-10-19：此前不校验任何身份，任何人（只要 UA 像 iOS）都能读到全部用户反馈。
 * iOS 从不调用本接口（提交反馈走 POST /v1/restaurants/:id/issue），管理后台用的是
 * /admin/issues，故直接收紧为 Admin JWT 专用（与 /admin、/v1/parse/batch 同一套凭证）。
 */

import { Hono } from 'hono';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, SHARED_TABLE } from '../lib/dynamodb.js';
import { adminAuthMiddleware } from '../middleware/adminAuth.js';

export const issuesRoute = new Hono();

// 仅管理员可读（无 / 无效 Admin JWT → 401）
issuesRoute.use('*', adminAuthMiddleware);

// ============================================================
// GET / — 查询问题报告列表（运营用）
// ============================================================

issuesRoute.get('/', async (c) => {
  const docClient = getDocClient();
  const statusFilter = c.req.query('status') || 'pending';

  // 从 shared 表查询所有 ISSUE，按时间倒序
  const allItems: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: SHARED_TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'ISSUE' },
      ScanIndexForward: false, // 最新的在前
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    if (result.Items) allItems.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // 应用层按 status 过滤
  const filtered = allItems.filter(item => item['status'] === statusFilter);

  // 安全脱敏：ISSUE 实体存了举报人 identityId（鉴权凭据面），响应一律剥离。
  // 运营如需追溯举报人，走 /admin/issues（会关联用户资料）。
  const sanitized = filtered.map((item) => {
    const { identityId: _identityId, ...rest } = item;
    return rest;
  });

  return c.json({ data: sanitized });
});
