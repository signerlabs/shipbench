/**
 * 抖音导入每日限额（App Runner 的 parse.ts 与 parse-processor Lambda 共用）
 *
 * 计数行：users 表 PK=identityId, SK=RATELIMIT#parse#<yyyy-mm-dd>（UTC+8 自然日），
 * 字段 usedCount（原子 ADD 递增）+ ttl（次日过期 + 1 天缓冲，表 TTL 自动清理）。
 * 计数口径：只对「成功入队触发解析」的任务 +1；Lambda 判定非探店（rejected）或处理失败（failed）
 * 时退回，用户的无效提交和我方故障都不白扣额度。
 *
 * 本模块会被 Lambda 打包：只依赖传入的 DocumentClient 与表名，不读 process.env、不 new 客户端。
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/** 每个身份每天（UTC+8 自然日）最多成功受理的导入次数（经 /v1/config 的 freeImportLimit 下发给 iOS） */
export const DAILY_PARSE_LIMIT = 20;

/** 当前 UTC+8 自然日字符串（yyyy-mm-dd），作为限流计数行的日期分片 */
export function currentDateKeyUTC8(nowMs: number = Date.now()): string {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 限流计数行 TTL：UTC+8 次日零点 + 1 天缓冲（行残留不影响正确性，dateKey 已翻篇） */
export function rateLimitTTL(nowMs: number = Date.now()): number {
  const utc8Now = nowMs + 8 * 3600_000;
  const nextMidnightUTC8Ms = (Math.floor(utc8Now / 86_400_000) + 1) * 86_400_000 - 8 * 3600_000;
  return Math.floor(nextMidnightUTC8Ms / 1000) + 86_400;
}

/** 退额度的结果：refunded=已退回；skipped=无需退（已退过 / 额度行没有可退的 / 批量任务） */
export type QuotaRefundOutcome = 'refunded' | 'skipped';

/**
 * 退回一次导入额度（幂等）。
 *
 * 为什么要幂等：失败任务会被 Lambda 异步调用自动重试（retryAttempts=1），每次失败都退一次就会
 * 多退、白送额度。带 jobId 时用一个事务把「JOB 行打 quotaRefunded 标记」与「额度 -1」绑在一起：
 * 标记已存在 → 整个事务取消，同一个任务最多退一次。
 *
 * 不带 jobId（老调用方）时退化为旧行为：仅做「usedCount >= 1 才减」的条件减。
 * 任何异常只打日志、不抛出——退额度失败不能影响导入主流程的状态回写。
 */
export async function refundDailyParseQuota(
  client: DynamoDBDocumentClient,
  usersTable: string,
  params: { identityId: string; rateLimitDate?: string; jobId?: string },
): Promise<QuotaRefundOutcome> {
  const { identityId, rateLimitDate, jobId } = params;
  if (!rateLimitDate || !identityId || identityId === 'system-batch') return 'skipped';

  const counterUpdate = {
    TableName: usersTable,
    Key: { PK: identityId, SK: `RATELIMIT#parse#${rateLimitDate}` },
    UpdateExpression: 'ADD usedCount :minusOne',
    ConditionExpression: 'usedCount >= :one',
    ExpressionAttributeValues: { ':minusOne': -1, ':one': 1 },
  };

  try {
    if (jobId) {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: usersTable,
              Key: { PK: identityId, SK: `JOB#${jobId}` },
              UpdateExpression: 'SET quotaRefunded = :t',
              ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(quotaRefunded)',
              ExpressionAttributeValues: { ':t': true },
            },
          },
          { Update: counterUpdate },
        ],
      }));
    } else {
      await client.send(new UpdateCommand(counterUpdate));
    }
    return 'refunded';
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
      // 已经退过 / JOB 行不存在 / 额度行已是 0（跨天或 TTL 清理）—— 都是「不该再退」，正常跳过
      return 'skipped';
    }
    console.warn(`[quota] 退回导入额度失败（不影响主流程）| identityId=${identityId.slice(-12)} | date=${rateLimitDate}`, err);
    return 'skipped';
  }
}
