/**
 * 抖音导入任务的处理阶段与失败原因（审查 M20，2026-10-19）
 *
 * 轮询接口 GET /v1/parse/jobs/:jobId 下发两个字段，与 iOS ImportTracker.swift 对齐：
 *   - stage：处理到哪一步。取值照抄 iOS ImportStage(serverValue:)：
 *       queued（排队中）→ downloading（获取视频）→ analyzing（识别小店）→
 *       geocoding（定位地址）→ persisting（写入地图）
 *     iOS 未识别的值一律当 queued，且阶段只前进不回退
 *   - failReason：失败原因机器码，iOS friendlyMessage 已有映射：
 *       not_video / not_food_review / no_place_name / place_not_found /
 *       download_failed / analysis_failed / duplicate
 *     2026-10-21 加 low_quality（太短、看不出店）/ not_xiaodian（连锁快餐、酒店早餐），
 *     2026-10-26 加 not_food（不是餐饮店：书店、酒吧、超市、酒店、景区等）、shop_closed（店已关门）：
 *     新版 App 有对应文案，旧版落到 rejected 的兜底「这条内容不是美食探店，换一条试试」
 *     服务端暂时只会产出 not_food_review / download_failed / analysis_failed（其余几种情况
 *     在现行流水线里不会让任务失败，见各处注释）；内部故障不给码，iOS 回落「导入失败，请重试」
 *
 * 存储位置：stage / failReason 写在 videos 表（每个视频一行），而不是 users 表的 JOB 行——
 * 同一个视频可能被多个用户同时导入（去重命中「正在处理中」会给每人建一条 JOB 行），只有
 * videos 行是所有轮询者共享的；Lambda 手里也只有发起者那一条 JOB。
 *
 * 本模块会被 parse-processor Lambda 打包：只依赖传入的 DocumentClient，不读 process.env。
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

/** 处理阶段（顺序即先后） */
export const IMPORT_STAGES = ['queued', 'downloading', 'analyzing', 'geocoding', 'persisting'] as const;
export type ImportStage = typeof IMPORT_STAGES[number];

/** 失败原因机器码（与 iOS ImportTracker.friendlyMessage 一致） */
export type ImportFailReason =
  | 'not_video'
  | 'not_food_review'
  | 'no_place_name'
  | 'place_not_found'
  | 'download_failed'
  | 'analysis_failed'
  | 'duplicate'
  | 'low_quality'
  | 'not_xiaodian'
  | 'not_food'
  | 'shop_closed';

const FAIL_REASONS: ReadonlySet<string> = new Set<ImportFailReason>([
  'not_video', 'not_food_review', 'no_place_name', 'place_not_found',
  'download_failed', 'analysis_failed', 'duplicate', 'low_quality', 'not_xiaodian', 'not_food', 'shop_closed',
]);

/**
 * 带失败原因的流水线异常：在「下载视频」「Gemini 分析」等步骤外包一层，
 * Lambda 的全局 catch 据此把机器码写进 videos.failReason
 */
export class ImportStepError extends Error {
  constructor(public readonly failReason: ImportFailReason, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'ImportStepError';
  }
}

/** 从任意异常里取失败原因机器码；内部故障（未包装）返回 undefined */
export function failReasonOf(err: unknown): ImportFailReason | undefined {
  return err instanceof ImportStepError ? err.failReason : undefined;
}

function asStage(v: unknown): ImportStage | undefined {
  return typeof v === 'string' && (IMPORT_STAGES as readonly string[]).includes(v) ? (v as ImportStage) : undefined;
}

function asFailReason(v: unknown): ImportFailReason | undefined {
  return typeof v === 'string' && FAIL_REASONS.has(v) ? (v as ImportFailReason) : undefined;
}

/**
 * 由 videos 行推导轮询要下发的 stage / failReason（纯函数，便于单测）
 *
 * - pending：Lambda 还没接手 → queued（忽略残留 stage，重新排队的任务不能显示旧进度）
 * - processing：取 Lambda 写入的 stage；老数据没有 stage → downloading（Step 2 起即在下载）
 * - rejected：not_food_review（老数据没写 failReason 也按此给码）
 * - failed：取 Lambda 写入的 failReason；内部故障没有码
 */
export function jobProgressFromVideo(
  video: Record<string, unknown> | undefined,
): { stage: ImportStage; failReason?: ImportFailReason; failMessage?: string } {
  const status = video?.['status'];
  // 完整提示（2026-10-20）：拒收境外店、认不出店名等给用户的一句话，新版 App 优先显示它，旧版忽略、按码显示
  const failMessage = typeof video?.['failMessage'] === 'string' && video['failMessage'] ? (video['failMessage'] as string) : undefined;
  if (status === 'processing') {
    return { stage: asStage(video?.['stage']) ?? 'downloading' };
  }
  if (status === 'rejected') {
    return { stage: 'persisting', failReason: asFailReason(video?.['failReason']) ?? 'not_food_review', ...(failMessage ? { failMessage } : {}) };
  }
  if (status === 'failed') {
    const failReason = asFailReason(video?.['failReason']);
    return { stage: asStage(video?.['stage']) ?? 'queued', ...(failReason ? { failReason } : {}), ...(failMessage ? { failMessage } : {}) };
  }
  if (status === 'completed') {
    return { stage: 'persisting' };
  }
  return { stage: 'queued' };
}

/**
 * 记录处理阶段（只写 stage + updatedAt）。
 *
 * 纯展示用途，失败只打日志绝不抛出；条件 attribute_exists 防止给不存在的视频凭空建行。
 * 顺带刷新 updatedAt：parse.ts 的僵尸任务判定以它为准，阶段推进说明 Lambda 还活着。
 */
export async function markImportStage(
  client: DynamoDBDocumentClient,
  videosTable: string,
  awemeId: string,
  stage: ImportStage,
): Promise<void> {
  try {
    await client.send(new UpdateCommand({
      TableName: videosTable,
      Key: { awemeId },
      UpdateExpression: 'SET stage = :stage, updatedAt = :now',
      ConditionExpression: 'attribute_exists(awemeId)',
      ExpressionAttributeValues: { ':stage': stage, ':now': new Date().toISOString() },
    }));
  } catch (err) {
    console.warn(`[stage] 记录处理阶段失败（不影响导入）| awemeId=${awemeId} stage=${stage}`, err);
  }
}
