/**
 * 「我导入的」导入记录（2026-10-19）
 *
 * 用户自建下线后加店只靠导入抖音视频，「我的」页原来的「推荐」子页改成「我导入的」。
 * 一条导入记录 = users 表本人分区的一行：
 *   PK = identityId, SK = IMPORT#<awemeId>
 *   awemeId      — 抖音视频 ID（= 导入帖 POST 的 SK）
 *   restaurantId — 导入时挂到的店（快照：店后来被合并时以 POST 上的 restaurantId 为准，读取侧不依赖它）
 *   importedAt   — 导入时间（ISO 字符串），「我导入的」按它倒序
 *   via          — 写入来源：pipeline / dedup / poll / backfill，排查与回填回滚用
 *
 * 写入时机（都是条件写 attribute_not_exists：同一视频只记第一次导入，重复写无副作用）：
 *   ① 解析 Lambda 新视频落库（video-import-pipeline Step 9，给提交者写收藏行之后）
 *   ② POST /v1/parse 去重命中「已完成」的视频（当前用户也算导入了它）
 *   ③ GET /v1/parse/jobs/:jobId 轮询拿到 completed（别人正在处理、我也提交了的情况；① 漏写时也由它补上）
 *   被判非探店（rejected）或处理失败（failed）的不写；system-batch（运营批量导入）不写。
 *   同一视频本人可能同时有 JOB#<id> 与 JOB#existing-<awemeId> 两条任务行，导入记录按 awemeId 只有一行。
 *
 * 读取：GET /v1/auth/my-imports 与 GET /v1/auth/stats 的 importCount（routes/auth.ts），只认 IMPORT# 行，
 * 不依赖有 30 天 TTL 的 JOB# 行。账号注销删本人分区全部行，IMPORT# 随之删除。
 * users 表 Stream 的计数 Lambda 只处理 REST# / INFLUENCER# / LIKE#，IMPORT# 行不触发任何计数。
 *
 * 本模块会被 parse-processor Lambda 打包：只依赖传入的 DocumentClient 与表名，不读 process.env、不 new 客户端。
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';

/** 导入记录行的 SK 前缀 */
export const IMPORT_SK_PREFIX = 'IMPORT#';

/** 写入来源 */
export type ImportRecordVia = 'pipeline' | 'dedup' | 'poll' | 'backfill';

/** 写入结果：created=新建；exists=本人之前已导入过这个视频（条件写未通过）；skipped=不该记（system-batch / 缺字段） */
export type ImportRecordOutcome = 'created' | 'exists' | 'skipped';

/**
 * 记一条导入记录（幂等）。
 *
 * 条件写失败视为「已记过」正常返回；其余异常照常抛出，由调用方按所在流程处理
 * （流水线交全局异常处理、接口回 500 让客户端重试——各写入点都幂等，重试安全）。
 */
export async function recordImport(
  client: DynamoDBDocumentClient,
  usersTable: string,
  params: {
    identityId: string;
    awemeId: string;
    restaurantId: string;
    importedAt: string;
    via: ImportRecordVia;
  },
): Promise<ImportRecordOutcome> {
  const { identityId, awemeId, restaurantId, importedAt, via } = params;
  if (!identityId || identityId === 'system-batch' || !awemeId || !restaurantId) return 'skipped';

  try {
    await client.send(new PutCommand({
      TableName: usersTable,
      Item: {
        PK: identityId,
        SK: `${IMPORT_SK_PREFIX}${awemeId}`,
        awemeId,
        restaurantId,
        importedAt,
        via,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return 'created';
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return 'exists';
    throw err;
  }
}
