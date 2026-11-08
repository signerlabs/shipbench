/**
 * 链接解析路由
 *
 * POST /              — 提交抖音链接解析
 * GET  /jobs/:jobId   — 轮询解析状态
 * POST /batch         — 批量解析博主所有视频（运营内部工具，需 Admin JWT）
 */

import { Hono } from 'hono';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { identityMiddleware, getIdentity, requireParseAuth } from '../middleware/auth.js';
import { adminAuthMiddleware } from '../middleware/adminAuth.js';
import { rejectBannedWrites } from '../middleware/ban.js';
import { getDocClient, VIDEOS_TABLE, USERS_TABLE, SHARED_TABLE } from '../lib/dynamodb.js';
import { getAppSecrets } from '../lib/secrets.js';
import { uploadToS3, existsInS3 } from '../lib/s3.js';
import { sanitizeCategories } from '../lib/restaurant-categories.js';
import { DAILY_PARSE_LIMIT, currentDateKeyUTC8, rateLimitTTL } from '../lib/parse-quota.js';
import { jobProgressFromVideo } from '../lib/import-status.js';
import { recordImport } from '../lib/import-record.js';
import { existingInfluencerAvatar } from '../lib/influencer-avatar.js';

export const parseRoute = new Hono();

// 所有路由需要 Identity ID
parseRoute.use('*', identityMiddleware);

// P0-1 配套：ENFORCE_PARSE_AUTH=true 时，parse 写端点必须携带验签通过的 Cognito JWT
// （绑定匹配已由 identityMiddleware 保证，不匹配会先被 403）。2026-10-19 起 CDK 置 true：
// 导入对所有登录用户免费开放，必须登录才能导入，防匿名身份（可无限免费生成）绕过每日限额。
parseRoute.use('*', requireParseAuth);

// 被封禁的身份不能提交导入（POST）；轮询（GET）不拦
parseRoute.use('*', rejectBannedWrites);

// 2026-07-05：/v1/parse 会员校验（requirePaid）下线——会员判定回归纯客户端 StoreKit，
// server 端改用下方「每日导入限流」兜底成本，避免客户端/server 会员态分裂误弹付费墙。

// Lambda 客户端
const lambdaClient = new LambdaClient({
  region: process.env.REGION || 'ap-southeast-1',
});

// ============================================================
// 每日导入限流（每 identityId 每天最多 DAILY_PARSE_LIMIT 次成功受理）
// ============================================================
//
// 常量与日期分片在 lib/parse-quota.ts（Lambda 退额度共用）。
// 计数口径：只对「成功入队触发解析」的任务 +1（提交即失败的不扣）；
// Lambda 判定非探店（rejected）或处理失败（failed）时退回 -1（同一任务最多退一次）。
// 读检查与递增之间存在极小并发窗口（同一用户并发提交可能略过线），
// 本限流是成本兜底而非安全边界，可接受；GET /jobs/:jobId 轮询不受限流影响。

// ============================================================
// TikHub API 调用（骨架，后续填入完整实现）
// ============================================================

/**
 * 从抖音短链中提取 aweme_id
 *
 * 调用 TikHub App V3 API 解析短链获取视频元数据
 * 预计耗时 ~3s，在 App Runner 同步完成
 *
 * @param url 抖音分享链接（短链或长链）
 * @returns 视频元数据
 */
interface TikHubVideoMeta {
  awemeId: string;
  description: string;
  coverUrl: string;
  douyinUrl: string;
  videoUrl?: string;       // 无水印视频直链（海外友好 URL 优先）
  videoUrlList?: string[]; // 所有可用的视频直链（用于 fallback）
  influencerUid: string;
  influencerName: string;
  influencerAvatar: string;
  influencerSignature?: string;  // 博主个人签名/简介
  // --- 新增字段（2026-03-16）---
  poiName?: string;        // 抖音 POI 定位：餐厅名称
  publishedAt?: string;    // 视频发布时间（ISO 字符串）
  likeCount?: number;      // 点赞数
  commentCount?: number;   // 评论数
  collectCount?: number;   // 收藏数
  shareCount?: number;     // 分享数
  videoDuration?: number;  // 视频时长（秒）
  awemeType?: number;      // 内容类型（0=视频, 68=图文, 150=图文）
}

/**
 * 从 aweme_detail 对象中提取视频元数据
 *
 * 列表 API 和单视频 API 返回的 aweme_detail 结构一致，
 * 统一用此函数提取字段，避免重复代码。
 */
export function extractVideoMeta(awemeDetail: Record<string, unknown>): TikHubVideoMeta {
  const awemeId = awemeDetail['aweme_id'] as string;
  const desc = (awemeDetail['desc'] as string) || '';

  const video = awemeDetail['video'] as Record<string, unknown> | undefined;
  const cover = video?.['cover'] as Record<string, unknown> | undefined;
  const originCover = video?.['origin_cover'] as Record<string, unknown> | undefined;
  const coverUrlList = (cover?.['url_list'] as string[]) || (originCover?.['url_list'] as string[]) || [];
  const playAddr = video?.['play_addr'] as Record<string, unknown> | undefined;
  const playUrlList = (playAddr?.['url_list'] as string[]) || [];

  const author = awemeDetail['author'] as Record<string, unknown> | undefined;
  const avatarThumb = author?.['avatar_thumb'] as Record<string, unknown> | undefined;
  const avatarMedium = author?.['avatar_medium'] as Record<string, unknown> | undefined;
  const avatarUrlList = (avatarThumb?.['url_list'] as string[]) || (avatarMedium?.['url_list'] as string[]) || [];

  const shareUrl = (awemeDetail['share_url'] as string) || `https://www.douyin.com/video/${awemeId}`;

  // --- 提取 POI 定位信息（仅保留 poiName，坐标字段已清理） ---
  const poiInfo = awemeDetail['poi_info'] as Record<string, unknown> | undefined;
  const poiName = (poiInfo?.['poi_name'] as string) || undefined;

  // --- 提取发布时间 ---
  const createTime = awemeDetail['create_time'] as number | undefined;
  const publishedAt = createTime ? new Date(createTime * 1000).toISOString() : undefined;

  // --- 提取互动数据 ---
  const statistics = awemeDetail['statistics'] as Record<string, unknown> | undefined;
  const likeCount = statistics?.['digg_count'] as number | undefined;
  const commentCount = statistics?.['comment_count'] as number | undefined;
  const collectCount = statistics?.['collect_count'] as number | undefined;
  const shareCount = statistics?.['share_count'] as number | undefined;

  // --- 提取视频时长（毫秒→秒） ---
  const rawDuration = (video?.['duration'] as number) ?? (awemeDetail['duration'] as number);
  const videoDuration = typeof rawDuration === 'number'
    ? (rawDuration >= 1000 ? Math.round(rawDuration / 1000) : rawDuration)
    : undefined;

  // --- 提取内容类型（0=视频, 68/150=图文） ---
  const awemeType = awemeDetail['aweme_type'] as number | undefined;

  return {
    awemeId,
    description: desc,
    coverUrl: coverUrlList[0] || '',
    douyinUrl: shareUrl,
    videoUrl: selectOverseasFriendlyUrl(playUrlList),
    videoUrlList: playUrlList.length > 0 ? playUrlList : undefined,
    influencerUid: (author?.['uid'] as string) || '',
    influencerName: (author?.['nickname'] as string) || '',
    influencerAvatar: avatarUrlList[0] || '',
    influencerSignature: (author?.['signature'] as string) || undefined,
    poiName,
    publishedAt,
    likeCount,
    commentCount,
    collectCount,
    shareCount,
    videoDuration,
    awemeType,
  };
}

/**
 * 从 URL 列表中优先选择海外友好的视频直链
 * amemv.com 域名会 302 重定向到 douyinvod.com，对海外 IP 友好
 * zjcdn.com 是中国大陆 CDN，海外 Lambda 下载经常 403 或断连
 */
function selectOverseasFriendlyUrl(urlList: string[]): string | undefined {
  if (!urlList || urlList.length === 0) return undefined;
  // 优先选 amemv.com 域名（海外友好）
  const amemvUrl = urlList.find(u => u.includes('amemv.com'));
  if (amemvUrl) return amemvUrl;
  // fallback 到第一个
  return urlList[0];
}

/**
 * 判断是否为视频内容（过滤图文/slides/note 等非视频帖子）
 *
 * 图文帖子送进 Lambda pipeline 会导致 Gemini 返回 500，
 * 必须在触发 Lambda 之前过滤掉。
 *
 * 判断条件（满足任一即为非视频）：
 * 1. videoDuration === 0（图文帖子没有时长）
 * 2. douyinUrl 包含 /slides/ 或 /note/（抖音图文链接特征）
 * 3. aweme_type 不是视频类型（0=视频, 68=图文, 150=图文）
 */
export function isVideoContent(meta: TikHubVideoMeta, awemeType?: number): boolean {
  // 视频时长为 0 → 图文帖子
  if (meta.videoDuration === 0) {
    return false;
  }

  // URL 包含图文路径特征
  if (meta.douyinUrl && (/\/slides\//.test(meta.douyinUrl) || /\/note\//.test(meta.douyinUrl))) {
    return false;
  }

  // aweme_type 非视频类型（0 = 普通视频，其他常见非视频类型：68, 150 = 图文）
  if (awemeType !== undefined && awemeType !== 0) {
    return false;
  }

  return true;
}

async function fetchVideoMeta(url: string): Promise<TikHubVideoMeta> {
  const secrets = await getAppSecrets();
  const apiKey = secrets['TIKHUB_API_KEY'];
  if (!apiKey) {
    throw new Error('TIKHUB_API_KEY 未配置');
  }

  // 15 秒超时控制
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const endpoint = 'https://api.tikhub.io/api/v1/douyin/app/v3/fetch_one_video_by_share_url';
    const queryUrl = `${endpoint}?share_url=${encodeURIComponent(url)}`;

    const resp = await fetch(queryUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    if (resp.status === 429) {
      throw new Error('TikHub API 限流，请稍后重试 (429)');
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`TikHub API 返回异常: HTTP ${resp.status} ${body}`);
    }

    const json = await resp.json() as Record<string, unknown>;
    const data = json['data'] as Record<string, unknown> | undefined;
    const awemeDetail = data?.['aweme_detail'] as Record<string, unknown> | undefined;

    if (!awemeDetail) {
      throw new Error('无效的抖音链接：未找到视频信息 (aweme_detail 为空)');
    }

    return extractVideoMeta(awemeDetail);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('TikHub API 请求超时 (15s)');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// POST / — 提交抖音链接解析
// ============================================================

parseRoute.post('/', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  // 1. 解析请求体
  const body = await c.req.json<{ url: string }>();
  if (!body.url || typeof body.url !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'url 字段为必填项' },
    }, 400);
  }

  const url = body.url.trim();

  // 简单验证：必须包含 douyin 相关域名
  if (!url.includes('douyin.com') && !url.includes('iesdouyin.com')) {
    return c.json({
      error: { code: 'INVALID_URL', message: '仅支持抖音链接' },
    }, 400);
  }

  // 1.5 每日导入限流检查（放在 TikHub 调用前，超限时不产生任何外部 API 成本）
  // 计数 +1 在下方 Lambda 成功触发后执行；error.code=DAILY_LIMIT_EXCEEDED 是前后端契约，
  // 客户端据此展示自定义文案，绝不复用 SUBSCRIPTION_REQUIRED（会误弹付费墙）。
  const rateLimitDate = currentDateKeyUTC8();
  if (identityId !== 'system-batch') {
    const rl = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: `RATELIMIT#parse#${rateLimitDate}` },
      ProjectionExpression: 'usedCount',
    }));
    const used = (rl.Item?.['usedCount'] as number | undefined) ?? 0;
    if (used >= DAILY_PARSE_LIMIT) {
      console.log(`[parse] 429 每日导入限流 | identityId=${identityId.slice(-12)} | used=${used}/${DAILY_PARSE_LIMIT}`);
      return c.json({
        error: { code: 'DAILY_LIMIT_EXCEEDED', message: `今日导入次数已达上限（${DAILY_PARSE_LIMIT} 次/天），请明天再试` },
      }, 429);
    }
  }

  // 2. 调用 TikHub 获取 aweme_id（同步，~3s）
  let videoMeta: TikHubVideoMeta;
  try {
    videoMeta = await fetchVideoMeta(url);
  } catch (err) {
    console.error('[parse] TikHub 调用失败:', err);
    return c.json({
      error: { code: 'PARSE_FAILED', message: '视频信息获取失败，请稍后重试' },
    }, 502);
  }

  // 2.5 过滤非视频内容（图文帖子无法截帧分析，会导致 Gemini 500 错误）
  if (!isVideoContent(videoMeta, videoMeta.awemeType)) {
    console.log(`[parse] 跳过非视频内容: videoDuration=${videoMeta.videoDuration}, type=${videoMeta.awemeType}, url=${videoMeta.douyinUrl}`);
    return c.json({
      error: { code: 'NOT_VIDEO', message: '仅支持视频内容，图文帖子暂不支持解析' },
    }, 400);
  }

  const { awemeId } = videoMeta;

  // 3. 去重检查：查 videos 表
  const existingVideo = await docClient.send(new GetCommand({
    TableName: VIDEOS_TABLE,
    Key: { awemeId },
  }));

  // 3.1 视频正在处理中 → 不重复触发 Lambda
  if (existingVideo.Item && (existingVideo.Item['status'] === 'pending' || existingVideo.Item['status'] === 'processing')) {
    // P1-8 僵尸任务判定：pending/processing 超 15 分钟（Lambda timeout 10 分钟 + 缓冲）
    // 视为 Lambda 超时/OOM 后未能回写状态的僵尸，重置后重新触发；否则永久卡死。
    const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000;
    const videoUpdatedAt = existingVideo.Item['updatedAt'] as string | undefined;
    const isZombie = !videoUpdatedAt
      || Date.now() - new Date(videoUpdatedAt).getTime() > ZOMBIE_THRESHOLD_MS;

    if (!isZombie) {
      // 正常处理中：为当前用户创建真实 JOB# 行后返回。
      // P1-8 修复：原先返回假 jobId "dedup-{awemeId}"，GET /jobs/:jobId 查
      // JOB#dedup-… 必 404，前端轮询直接报错。现在返回可正常轮询的 jobId
      // （GET /jobs 的 pending 分支会去 videos 表查最新状态，完全复用现有状态机）。
      const jobId = await createPollableJob(docClient, identityId, awemeId, url);
      return c.json({
        data: {
          jobId,
          status: existingVideo.Item['status'] as string,
          awemeId,
          stage: jobProgressFromVideo(existingVideo.Item).stage,
          message: '该视频正在处理中，请稍候轮询结果',
        },
      });
    }

    // 僵尸任务：条件重置为 pending（条件比对原 updatedAt，防并发重复重置）
    try {
      await docClient.send(new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { awemeId },
        UpdateExpression: 'SET #s = :pending, updatedAt = :now',
        ConditionExpression: videoUpdatedAt ? 'updatedAt = :stale' : 'attribute_not_exists(updatedAt)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':pending': 'pending',
          ':now': new Date().toISOString(),
          ...(videoUpdatedAt ? { ':stale': videoUpdatedAt } : {}),
        },
      }));
      console.warn(`[parse] 僵尸任务已重置为 pending，重新触发解析: awemeId=${awemeId}, 原 updatedAt=${videoUpdatedAt ?? '(缺失)'}`);
      // 不 return：继续走下方"创建 JOB + 触发 Lambda"流程重新解析
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
      // 并发请求已抢先重置并重新触发 → 本请求按"正常处理中"返回可轮询 JOB
      const jobId = await createPollableJob(docClient, identityId, awemeId, url);
      return c.json({
        data: {
          jobId,
          status: 'pending',
          awemeId,
          stage: 'queued',
          message: '该视频正在处理中，请稍候轮询结果',
        },
      });
    }
  }

  // 3.1.5 上次处理失败的视频 → 条件重置为 pending 后重新解析（2026-10-19）
  // 旧实现直接落到下方「未命中」分支：videos 占位写因行已存在而静默失败，行仍是 failed，
  // Lambda 接手前的空窗里轮询会立刻读到 failed（连同上一次的失败原因）判导入失败。
  // 条件 status=failed 保证并发重试只有一个请求真正触发 Lambda。
  if (existingVideo.Item && existingVideo.Item['status'] === 'failed') {
    try {
      await docClient.send(new UpdateCommand({
        TableName: VIDEOS_TABLE,
        Key: { awemeId },
        UpdateExpression: 'SET #s = :pending, updatedAt = :now REMOVE failReason, stage, #err',
        ConditionExpression: '#s = :failed',
        ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
        ExpressionAttributeValues: {
          ':pending': 'pending',
          ':failed': 'failed',
          ':now': new Date().toISOString(),
        },
      }));
      console.log(`[parse] 失败视频已重置为 pending，重新解析: awemeId=${awemeId}`);
      // 不 return：继续走下方"创建 JOB + 触发 Lambda"流程
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
      // 并发请求已抢先重置并触发 → 本请求按"正常处理中"返回可轮询 JOB
      const jobId = await createPollableJob(docClient, identityId, awemeId, url);
      return c.json({
        data: {
          jobId,
          status: 'pending',
          awemeId,
          stage: 'queued',
          message: '该视频正在处理中，请稍候轮询结果',
        },
      });
    }
  }

  // 3.2 视频已被判定为非探店内容 → 直接返回
  if (existingVideo.Item && existingVideo.Item['status'] === 'rejected') {
    return c.json({
      data: {
        jobId: `rejected-${awemeId}`,
        status: 'rejected',
        awemeId,
        rejectionReason: existingVideo.Item['rejectionReason'],
        failReason: jobProgressFromVideo(existingVideo.Item).failReason,
        ...(jobProgressFromVideo(existingVideo.Item).failMessage ? { failMessage: jobProgressFromVideo(existingVideo.Item).failMessage } : {}),
      },
    });
  }

  if (existingVideo.Item && existingVideo.Item['status'] === 'completed') {
    // 命中已完成的视频 → 从 shared 表 POST/REST 复制数据到用户（不再依赖 videos 表的 Gemini 字段）
    const video = existingVideo.Item;
    const restaurantId = video['restaurantId'] as string || awemeId;
    const influencerUid = video['influencerUid'] as string;

    // 从 shared 表 POST 读取 Gemini 分析结果（博主评价、标签、菜品等）
    // 回退到 videos 表（兼容 shared 表尚未写入的边界情况）
    let sourcePost = video; // 默认回退到 videos 表
    try {
      const sharedPost = await docClient.send(new GetCommand({
        TableName: SHARED_TABLE,
        Key: { PK: 'POST', SK: awemeId },
      }));
      if (sharedPost.Item) {
        sourcePost = sharedPost.Item;
      }
    } catch { /* shared 表 POST 不存在，使用 videos 表数据 */ }

    // 从 REST 获取最新城市名（MKLocalSearch 或 Admin 可能已更新）
    // 优先查用户自己的 REST#，再查 shared 表
    let city = (sourcePost['city'] as string) || video['city'] as string || 'unknown';
    // 这家店的坐标（2026-10-19）：随 completed 下发，与 GET /jobs 的 completed 同一契约
    // （latitude/longitude 挂 data 顶层）。本地刷新城市没拉到这家店时 iOS 靠它定位，
    // 否则会误弹「暂时无法定位」；店还没坐标时字段缺省，iOS 照走兜底
    let restLatitude: number | undefined;
    let restLongitude: number | undefined;
    try {
      const [userRest, sharedRest] = await Promise.all([
        docClient.send(new GetCommand({
          TableName: USERS_TABLE,
          Key: { PK: identityId, SK: `REST#${restaurantId}` },
          ProjectionExpression: 'city',
        })),
        docClient.send(new GetCommand({
          TableName: SHARED_TABLE,
          Key: { PK: 'REST', SK: restaurantId },
          ProjectionExpression: 'city, latitude, longitude',
        })),
      ]);
      if (userRest.Item?.['city']) {
        city = userRest.Item['city'] as string;
      } else if (sharedRest.Item?.['city']) {
        city = sharedRest.Item['city'] as string;
      }
      if (typeof sharedRest.Item?.['latitude'] === 'number' && typeof sharedRest.Item?.['longitude'] === 'number') {
        restLatitude = sharedRest.Item['latitude'];
        restLongitude = sharedRest.Item['longitude'];
      }
    } catch { /* REST 读取失败，使用默认 city、不带坐标（iOS 兜底） */ }
    // city 直接用已有店的高德权威值（或空串待 admin），不再 normalizeCity 归一化

    // Phase 5: 去重命中路径只写用户偏好数据（REST# + INFLUENCER#），不再写 POST# 和 RI#
    // 帖子和达人统计数据完全由 shared 表维护
    const now = new Date().toISOString();

    // 0. 先同步 shared 表（全局共享数据池，所有用户可见），再写用户收藏行。
    // P1-7 修复：同步失败不再静默返回 completed —— 返回 503 让客户端重试
    // （writeSharedTable 各实体条件写幂等，重试可安全补齐）。
    // 2026-10-19 调序（原在收藏行之后）：收藏行经 Stream 驱动计数，计数现在要求实体已存在，
    // 先写 shared 保证店被合并 / 删掉后由本路径重建时，这一次收藏不被漏计、也不会被空壳抢跑。
    if (identityId !== 'system-batch') {
      try {
        await writeSharedTable(docClient, {
          awemeId,
          restaurantId,
          influencerUid,
          city,
          video,
          now,
          identityId,
        });
      } catch (err) {
        console.error(`[parse] shared 表同步失败（去重命中路径），返回 503: awemeId=${awemeId}`, err);
        return c.json({
          error: { code: 'SHARED_SYNC_FAILED', message: '数据同步失败，请稍后重试' },
        }, 503);
      }
    }

    // 1. REST# — 仅存 restaurantId + bookmarked + GSI3（如果不存在则创建，已存在则跳过）
    try {
      await docClient.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          PK: identityId,
          SK: `REST#${restaurantId}`,
          restaurantId,
          bookmarked: identityId !== 'system-batch',
          ...(identityId !== 'system-batch' && {
            GSI3PK: `${identityId}#BOOKMARK`,
            GSI3SK: `REST#${restaurantId}`,
          }),
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
      // REST# 已存在 → 跳过（用户偏好数据不需要更新）
    }

    // 2. INFLUENCER# — 仅存 influencerUid + bookmarked + GSI3（如果不存在则创建，已存在则跳过）
    try {
      await docClient.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          PK: identityId,
          SK: `INFLUENCER#${influencerUid}`,
          influencerUid,
          bookmarked: identityId !== 'system-batch',
          ...(identityId !== 'system-batch' && {
            GSI3PK: `${identityId}#BOOKMARK`,
            GSI3SK: `INFLUENCER#${influencerUid}`,
          }),
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
      // INFLUENCER# 已存在 → 跳过（用户偏好数据不需要更新）
    }

    // 3. 记一条已完成的 JOB 行（2026-10-19）：作为「本人导入过这个视频」的凭证，
    // 让 GET /jobs/existing-<awemeId> 可轮询。
    // 固定 jobId，重复导入同一视频覆盖写，幂等。
    if (identityId !== 'system-batch') {
      await docClient.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          PK: identityId,
          SK: `JOB#existing-${awemeId}`,
          jobId: `existing-${awemeId}`,
          awemeId,
          url,
          status: 'completed',
          city,
          createdAt: now,
          updatedAt: now,
          ttl: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        },
      }));
    }

    // 4. 记一条「我导入的」导入记录（2026-10-19，见 lib/import-record.ts）：去重命中已完成的视频，
    // 当前用户也算导入了它。条件写只记第一次导入，重复导入同一视频不刷新导入时间；
    // system-batch 由 recordImport 内部跳过。写失败回 500，客户端重试时本路径各步都幂等
    await recordImport(docClient, USERS_TABLE, {
      identityId,
      awemeId,
      restaurantId,
      importedAt: now,
      via: 'dedup',
    });

    return c.json({
      data: {
        jobId: `existing-${awemeId}`,
        status: 'completed',
        awemeId,
        city,
        ...(restLatitude !== undefined && restLongitude !== undefined
          ? { latitude: restLatitude, longitude: restLongitude } : {}),
        result: {
          // 优先从 shared 表 POST 读取 Gemini 分析结果，回退到 videos 表（向后兼容）
          restaurantName: sourcePost['restaurantName'] ?? video['restaurantName'],
          locationHint: sourcePost['locationHint'] ?? video['locationHint'],
          influencerName: sourcePost['influencerName'] ?? video['influencerName'],
          dishes: sourcePost['dishes'] ?? video['dishes'],
          tags: sourcePost['tags'] ?? video['tags'],
          isRestaurantReview: video['isRestaurantReview'],
        },
      },
    });
  }

  // 4. 未命中 → 创建 JOB 和 videos 占位
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  // 写 videos 表占位（条件写入防并发：仅当 awemeId 不存在时写入）
  try {
    await docClient.send(new PutCommand({
      TableName: VIDEOS_TABLE,
      Item: {
        awemeId,
        description: videoMeta.description,
        coverUrl: videoMeta.coverUrl,
        douyinUrl: videoMeta.douyinUrl,
        influencerUid: videoMeta.influencerUid,
        influencerName: videoMeta.influencerName,
        influencerAvatar: videoMeta.influencerAvatar,
        influencerSignature: videoMeta.influencerSignature,
        // 新增字段（DynamoDB schemaless，直接写入）
        poiName: videoMeta.poiName,
        publishedAt: videoMeta.publishedAt,
        likeCount: videoMeta.likeCount,
        commentCount: videoMeta.commentCount,
        collectCount: videoMeta.collectCount,
        shareCount: videoMeta.shareCount,
        videoDuration: videoMeta.videoDuration,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(awemeId)',
    }));
  } catch (err: unknown) {
    // 条件写入失败说明已有其他请求在处理，忽略即可
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }

  // 写 users 表 JOB 项（TTL 30 天）
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  await docClient.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      PK: identityId,
      SK: `JOB#${jobId}`,
      jobId,
      awemeId,
      url,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ttl,
    },
  }));

  // 5. 异步触发 Lambda
  const lambdaArn = process.env.PARSE_LAMBDA_ARN;
  if (lambdaArn) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: lambdaArn,
        InvocationType: 'Event', // 异步调用，fire-and-forget
        Payload: JSON.stringify({
          jobId,
          awemeId,
          identityId,
          videoMeta,
          rateLimitDate, // 供 Lambda 判定 rejected 后回退同一天的限流额度
        }),
      }));
      console.log(`[parse] Lambda 已触发: jobId=${jobId}, awemeId=${awemeId}`);

      // 5.5 每日导入限流计数 +1（原子递增；只对成功入队的解析任务计数）
      // 计数失败不阻断导入（成本兜底优先级低于用户功能），仅打日志。
      if (identityId !== 'system-batch') {
        try {
          await docClient.send(new UpdateCommand({
            TableName: USERS_TABLE,
            Key: { PK: identityId, SK: `RATELIMIT#parse#${rateLimitDate}` },
            UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD usedCount :one',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':ttl': rateLimitTTL(), ':one': 1 },
          }));
        } catch (err) {
          console.warn(`[parse] 限流计数递增失败（不阻断导入）: identityId=${identityId.slice(-12)}`, err);
        }
      }
    } catch (err) {
      console.error(`[parse] Lambda 触发失败: jobId=${jobId}`, err);

      // 更新 JOB 状态为失败
      await docClient.send(new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: `JOB#${jobId}` },
        UpdateExpression: 'SET #s = :s, #err = :err, updatedAt = :now',
        ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
        ExpressionAttributeValues: {
          ':s': 'failed',
          ':err': 'Lambda 触发失败',
          ':now': new Date().toISOString(),
        },
      }));

      return c.json({
        error: { code: 'LAMBDA_FAILED', message: '解析服务暂时不可用' },
      }, 503);
    }
  } else {
    console.warn('[parse] PARSE_LAMBDA_ARN 未配置，任务将保持 pending 状态');
  }

  return c.json({
    data: {
      jobId,
      status: 'pending',
      awemeId,
      stage: 'queued',
    },
  });
});

// ============================================================
// GET /jobs/:jobId — 轮询解析状态
// ============================================================

parseRoute.get('/jobs/:jobId', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const jobId = c.req.param('jobId');
  const docClient = getDocClient();

  // 1. 查询 users 表的 JOB 项
  const jobResult = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: `JOB#${jobId}` },
  }));

  if (!jobResult.Item) {
    return c.json({
      error: { code: 'NOT_FOUND', message: '任务不存在' },
    }, 404);
  }

  const job = jobResult.Item;
  const jobStatus = job['status'] as string;
  const awemeId = job['awemeId'] as string;

  // 2. 如果 JOB 是 pending/processing，检查 videos 表状态是否已更新
  if ((jobStatus === 'pending' || jobStatus === 'processing') && awemeId) {
    const videoResult = await docClient.send(new GetCommand({
      TableName: VIDEOS_TABLE,
      Key: { awemeId },
    }));

    if (videoResult.Item) {
      const videoStatus = videoResult.Item['status'] as string;

      if (videoStatus === 'completed') {
        // Phase 5: 从 shared 表 POST 读取 Gemini 分析结果，回退到 videos 表（向后兼容）
        let pollSource: Record<string, unknown> = videoResult.Item!;
        try {
          const sharedPost = await docClient.send(new GetCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'POST', SK: awemeId },
          }));
          if (sharedPost.Item) {
            pollSource = sharedPost.Item;
          }
        } catch { /* 读取失败，回退到 videos 表数据 */ }

        // 从 POST 实体获取 city，写回 JOB 记录（前端需要 city 来决定 reload 哪个城市）
        const jobCity = (pollSource['city'] as string) ?? (videoResult.Item!['city'] as string) ?? null;
        // 这次导入挂到的店（判重命中 / 合并后指向已有店；老数据缺省回落 awemeId）
        const jobRestaurantId = (videoResult.Item!['restaurantId'] as string) || awemeId;

        // 阶段 1（坐标 server 化）：读 REST 实体坐标随 completed 下发。
        // server 高德补到坐标时 iOS 免走 MKLocalSearch 兜底；未补到时字段缺省，
        // iOS ParseJob 的 latitude/longitude 解析为 nil、照走兜底。读取失败不阻断轮询。
        let restLatitude: number | undefined;
        let restLongitude: number | undefined;
        try {
          const restItem = await docClient.send(new GetCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'REST', SK: jobRestaurantId },
            ProjectionExpression: 'latitude, longitude',
          }));
          if (typeof restItem.Item?.['latitude'] === 'number' && typeof restItem.Item?.['longitude'] === 'number') {
            restLatitude = restItem.Item['latitude'];
            restLongitude = restItem.Item['longitude'];
          }
        } catch { /* REST 读取失败，坐标缺省，iOS 兜底 */ }

        // 记一条「我导入的」导入记录（2026-10-19，见 lib/import-record.ts）：覆盖「别人正在处理、我也提交了」——
        // 解析 Lambda 只给发起者记，同时提交的其他人在轮询到完成时补记；发起者自己轮询到这里时
        // 行已存在，条件写跳过。必须先于下面把 JOB 翻成 completed：写失败直接 500，JOB 仍是 pending，
        // 下次轮询还会再进这个分支补写（iOS 对轮询的 5xx 会继续等）
        await recordImport(docClient, USERS_TABLE, {
          identityId,
          awemeId,
          restaurantId: jobRestaurantId,
          importedAt: new Date().toISOString(),
          via: 'poll',
        });

        // 视频已处理完成，更新 JOB 状态（含 city）
        await docClient.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { PK: identityId, SK: `JOB#${jobId}` },
          UpdateExpression: 'SET #s = :s, city = :city, updatedAt = :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': 'completed',
            ':city': jobCity,
            ':now': new Date().toISOString(),
          },
        }));

        return c.json({
          data: {
            jobId,
            status: 'completed',
            awemeId,
            city: jobCity,
            // 坐标挂 data 顶层（iOS ParseJob 契约：latitude/longitude 与 jobId/city 同级）
            ...(restLatitude !== undefined && restLongitude !== undefined
              ? { latitude: restLatitude, longitude: restLongitude } : {}),
            result: {
              restaurantName: pollSource['restaurantName'],
              locationHint: pollSource['locationHint'] ?? videoResult.Item!['locationHint'],
              influencerName: pollSource['influencerName'] ?? videoResult.Item!['influencerName'],
              influencerSummary: pollSource['influencerSummary'],
              dishes: pollSource['dishes'],
              tags: pollSource['tags'],
              isRestaurantReview: videoResult.Item!['isRestaurantReview'],
              rejectionReason: videoResult.Item!['rejectionReason'],
            },
          },
        });
      }

      // 失败原因机器码（审查 M20）：videos 行上 Lambda 写的 failReason；内部故障没有码
      const { stage, failReason, failMessage } = jobProgressFromVideo(videoResult.Item);

      if (videoStatus === 'failed') {
        // 视频处理失败（failReason 一并记到 JOB 行，之后的轮询直接从 JOB 行返回）
        await docClient.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { PK: identityId, SK: `JOB#${jobId}` },
          UpdateExpression: `SET #s = :s, #err = :err, updatedAt = :now${failReason ? ', failReason = :fr' : ''}${failMessage ? ', failMessage = :fm' : ''}`,
          ExpressionAttributeNames: { '#s': 'status', '#err': 'error' },
          ExpressionAttributeValues: {
            ':s': 'failed',
            ':err': videoResult.Item['error'] || '视频处理失败',
            ':now': new Date().toISOString(),
            ...(failReason ? { ':fr': failReason } : {}),
            ...(failMessage ? { ':fm': failMessage } : {}),
          },
        }));

        return c.json({
          data: {
            jobId,
            status: 'failed',
            awemeId,
            error: videoResult.Item['error'] || '视频处理失败',
            ...(failReason ? { failReason } : {}),
            ...(failMessage ? { failMessage } : {}),
          },
        });
      }

      if (videoStatus === 'rejected') {
        // 非探店视频
        await docClient.send(new UpdateCommand({
          TableName: USERS_TABLE,
          Key: { PK: identityId, SK: `JOB#${jobId}` },
          UpdateExpression: `SET #s = :s, failReason = :fr, updatedAt = :now${failMessage ? ', failMessage = :fm' : ''}`,
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':s': 'rejected',
            ':fr': failReason ?? 'not_food_review',
            ':now': new Date().toISOString(),
            ...(failMessage ? { ':fm': failMessage } : {}),
          },
        }));

        return c.json({
          data: {
            jobId,
            status: 'rejected',
            awemeId,
            rejectionReason: videoResult.Item['rejectionReason'],
            failReason: failReason ?? 'not_food_review',
            ...(failMessage ? { failMessage } : {}),
          },
        });
      }

      // pending / processing：下发处理阶段（queued / downloading / analyzing / geocoding / persisting）
      return c.json({
        data: {
          jobId,
          status: jobStatus,
          awemeId,
          stage,
          ...(job['city'] && { city: job['city'] }),
          error: job['error'],
        },
      });
    }
  }

  // 3. 返回当前 JOB 状态（含 city，如果 JOB 记录中已有）
  const jobFailReason = typeof job['failReason'] === 'string'
    ? job['failReason']
    : (jobStatus === 'rejected' ? 'not_food_review' : undefined);
  return c.json({
    data: {
      jobId,
      status: jobStatus,
      awemeId,
      ...((jobStatus === 'pending' || jobStatus === 'processing') ? { stage: 'queued' } : {}),
      ...(jobFailReason ? { failReason: jobFailReason } : {}),
      ...(typeof job['failMessage'] === 'string' && job['failMessage'] ? { failMessage: job['failMessage'] } : {}),
      ...(job['city'] && { city: job['city'] }),
      error: job['error'],
    },
  });
});

// ============================================================
// 批量解析路由（运营内部工具，仅 Admin JWT 可调用）
// ============================================================

export const batchParseRoute = new Hono();

// P0-3 安全修复：本路由此前无任何鉴权，公网可直接触发批量解析
// （TikHub 付费 API + Gemini + Lambda 烧钱 + sleep 长时间占用实例）。
// 现锁死为 admin 专用：必须携带 Admin JWT（与 /admin 路由同一套凭证体系）。
// iOS 端不调用此端点，锁死对 App 零影响。
batchParseRoute.use('*', adminAuthMiddleware);

/**
 * 工具函数：延迟指定毫秒
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST / — 批量解析博主所有视频
 *
 * 输入博主 uid，自动遍历所有视频，去重后写入 videos 表并触发 Lambda。
 * 系统级操作，identityId 固定为 "system-batch"（Lambda 写入 shared 表）。
 */
batchParseRoute.post('/', async (c) => {
  const body = await c.req.json<{ uid: string; limit?: number }>();
  if (!body.uid || typeof body.uid !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'uid 字段为必填项' },
    }, 400);
  }

  const uid = body.uid.trim();
  const maxLimit = body.limit ?? Infinity; // 不传则遍历全部
  const docClient = getDocClient();

  // 获取 TikHub API Key
  const secrets = await getAppSecrets();
  const apiKey = secrets['TIKHUB_API_KEY'];
  if (!apiKey) {
    return c.json({
      error: { code: 'CONFIG_ERROR', message: 'TIKHUB_API_KEY 未配置' },
    }, 500);
  }

  // --- 第一步：通过 uid 获取 sec_user_id ---
  console.log(`[batch] 开始批量解析，博主 uid: ${uid}`);

  let secUserId: string;
  try {
    const profileUrl = `https://api.tikhub.io/api/v1/douyin/web/handler_user_profile_v3?uid=${encodeURIComponent(uid)}`;
    const profileResp = await fetch(profileUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    if (!profileResp.ok) {
      const errBody = await profileResp.text().catch(() => '');
      throw new Error(`HTTP ${profileResp.status} ${errBody}`);
    }

    const profileJson = await profileResp.json() as Record<string, unknown>;
    const profileData = profileJson['data'] as Record<string, unknown> | undefined;
    const innerData = profileData?.['data'] as Record<string, unknown> | undefined;
    secUserId = (innerData?.['sec_uid'] as string) || '';

    if (!secUserId) {
      return c.json({
        error: { code: 'USER_NOT_FOUND', message: `无法获取博主 sec_user_id，uid: ${uid}` },
      }, 404);
    }

    console.log(`[batch] 获取到 sec_user_id: ${secUserId}`);
  } catch (err) {
    console.error('[batch] 获取博主信息失败:', err);
    return c.json({
      error: { code: 'PROFILE_FAILED', message: '获取博主信息失败' },
    }, 502);
  }

  // --- 第二步：分页遍历所有视频 ---
  const lambdaArn = process.env.PARSE_LAMBDA_ARN;
  let cursor = '0';
  let hasMore = true;
  let totalCount = 0;
  let newCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const identityId = 'system-batch';

  while (hasMore && totalCount < maxLimit) {
    // 请求一页视频
    const listUrl = `https://api.tikhub.io/api/v1/douyin/app/v3/fetch_user_post_videos?sec_user_id=${encodeURIComponent(secUserId)}&max_cursor=${cursor}&count=20`;

    let awemeList: Record<string, unknown>[] = [];
    try {
      const listResp = await fetch(listUrl, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
      });

      if (listResp.status === 429) {
        console.warn('[batch] TikHub 限流 (429)，等待 5 秒后重试...');
        await sleep(5000);
        continue; // 重试当前页
      }

      if (!listResp.ok) {
        const errBody = await listResp.text().catch(() => '');
        throw new Error(`HTTP ${listResp.status} ${errBody}`);
      }

      const listJson = await listResp.json() as Record<string, unknown>;
      const listData = listJson['data'] as Record<string, unknown> | undefined;

      awemeList = (listData?.['aweme_list'] as Record<string, unknown>[]) || [];
      hasMore = (listData?.['has_more'] as boolean) ?? false;
      cursor = String(listData?.['max_cursor'] ?? '0');

      console.log(`[batch] 获取到 ${awemeList.length} 条视频，has_more=${hasMore}，cursor=${cursor}`);
    } catch (err) {
      console.error('[batch] 获取视频列表失败:', err);
      return c.json({
        error: { code: 'LIST_FAILED', message: '获取视频列表失败' },
        data: { totalCount, newCount, skippedCount, errorCount },
      }, 502);
    }

    // --- 第三步：逐条处理视频 ---
    for (const aweme of awemeList) {
      totalCount++;

      let videoMeta: TikHubVideoMeta;
      try {
        videoMeta = extractVideoMeta(aweme);
      } catch (err) {
        console.error(`[batch] [${totalCount}] 字段提取失败:`, err);
        errorCount++;
        continue;
      }

      const { awemeId } = videoMeta;

      // 过滤非视频内容（图文/slides/note 帖子无法截帧，会导致 Gemini 500 错误）
      const awemeType = aweme['aweme_type'] as number | undefined;
      if (!isVideoContent(videoMeta, awemeType)) {
        console.log(`[batch] [${totalCount}] 跳过非视频内容: ${awemeId} (duration=${videoMeta.videoDuration}, type=${awemeType}, url=${videoMeta.douyinUrl.slice(0, 60)})`);
        skippedCount++;
        continue;
      }

      console.log(`[batch] [${totalCount}] 处理视频 ${awemeId}: ${videoMeta.description.slice(0, 40)}...`);

      // 去重检查
      let existing: { Item?: Record<string, unknown> } | null = null;
      try {
        existing = await docClient.send(new GetCommand({
          TableName: VIDEOS_TABLE,
          Key: { awemeId },
        }));

        const existingStatus = existing.Item?.['status'] as string | undefined;

        // pending/processing：正在处理，跳过
        // rejected：非探店视频，跳过
        if (existingStatus === 'pending' || existingStatus === 'processing' || existingStatus === 'rejected') {
          console.log(`[batch] [${totalCount}] 跳过（状态=${existingStatus}）: ${awemeId}`);
          skippedCount++;
          continue;
        }

        // completed：已完成，只补传视频到 S3（不重新分析）
        if (existingStatus === 'completed') {
          const videoKey = `videos/${awemeId}.mp4`;
          if (videoMeta.videoUrl && !(await existsInS3(videoKey))) {
            try {
              const videoResp = await fetch(videoMeta.videoUrl);
              if (videoResp.ok) {
                const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
                await uploadToS3(videoKey, videoBuffer, 'video/mp4');
                console.log(`[batch] [${totalCount}] 视频已补传 S3: ${videoKey} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
              } else {
                console.warn(`[batch] [${totalCount}] 视频下载失败 HTTP ${videoResp.status}: ${awemeId}`);
              }
            } catch (err) {
              console.error(`[batch] [${totalCount}] 视频补传失败: ${awemeId}`, err);
            }
            await sleep(3000); // 下载间隔 3 秒
          } else {
            console.log(`[batch] [${totalCount}] 跳过（已完成，视频已在 S3）: ${awemeId}`);
          }
          skippedCount++;
          continue;
        }

        // failed：重新触发 Lambda（走下面的正常流程）
        if (existingStatus === 'failed') {
          console.log(`[batch] [${totalCount}] 重试失败视频: ${awemeId}`);
        }
      } catch (err) {
        console.error(`[batch] [${totalCount}] 去重检查失败: ${awemeId}`, err);
        errorCount++;
        continue;
      }

      // 写入或更新 videos 表
      const now = new Date().toISOString();
      try {
        // failed 记录已存在，用 UpdateCommand 重置状态
        if (existing?.Item?.['status'] === 'failed') {
          await docClient.send(new UpdateCommand({
            TableName: VIDEOS_TABLE,
            Key: { awemeId },
            UpdateExpression: 'SET #s = :s, updatedAt = :now',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':s': 'pending',
              ':now': now,
            },
          }));
        } else {
          // 新视频，PutCommand
          await docClient.send(new PutCommand({
            TableName: VIDEOS_TABLE,
            Item: {
              awemeId,
              description: videoMeta.description,
              coverUrl: videoMeta.coverUrl,
              douyinUrl: videoMeta.douyinUrl,
              influencerUid: videoMeta.influencerUid,
              influencerName: videoMeta.influencerName,
              influencerAvatar: videoMeta.influencerAvatar,
              poiName: videoMeta.poiName,
              publishedAt: videoMeta.publishedAt,
              likeCount: videoMeta.likeCount,
              commentCount: videoMeta.commentCount,
              collectCount: videoMeta.collectCount,
              shareCount: videoMeta.shareCount,
              videoDuration: videoMeta.videoDuration,
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            },
            ConditionExpression: 'attribute_not_exists(awemeId)',
          }));
        }
      } catch (err: unknown) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
          console.log(`[batch] [${totalCount}] 跳过（并发写入冲突）: ${awemeId}`);
          skippedCount++;
          continue;
        }
        console.error(`[batch] [${totalCount}] 写入 DynamoDB 失败: ${awemeId}`, err);
        errorCount++;
        continue;
      }

      // 触发 Lambda
      if (lambdaArn) {
        try {
          await lambdaClient.send(new InvokeCommand({
            FunctionName: lambdaArn,
            InvocationType: 'Event',
            Payload: JSON.stringify({
              jobId: `batch-${awemeId}`,
              awemeId,
              identityId,
              videoMeta,
            }),
          }));
          console.log(`[batch] [${totalCount}] Lambda 已触发: ${awemeId}`);
        } catch (err) {
          console.error(`[batch] [${totalCount}] Lambda 触发失败: ${awemeId}`, err);
          errorCount++;
        }

        // Lambda 触发间隔 30 秒，避免并发过高导致超时
        await sleep(30000);
      } else {
        console.warn(`[batch] [${totalCount}] PARSE_LAMBDA_ARN 未配置，跳过 Lambda 触发`);
      }

      newCount++;
    }

    // 每页请求间加 300ms 延迟（TikHub 限流 5 RPS）
    if (hasMore) {
      await sleep(300);
    }
  }

  console.log(`[batch] 批量解析完成: 总计=${totalCount}, 新增=${newCount}, 跳过=${skippedCount}, 错误=${errorCount}`);

  return c.json({
    data: {
      uid,
      secUserId,
      totalCount,
      newCount,
      skippedCount,
      errorCount,
    },
  });
});

// ============================================================
// 辅助函数：创建可轮询的 JOB# 行（P1-8）
// ============================================================

/**
 * 为当前用户创建一条真实的 JOB# 行并返回 jobId。
 *
 * 用于"视频正在处理中"的去重分支：JOB 行 status=pending，GET /jobs/:jobId
 * 的 pending 分支会自动查 videos 表最新状态并翻转 JOB，完全复用现有轮询状态机。
 */
async function createPollableJob(
  docClient: DynamoDBDocumentClient,
  identityId: string,
  awemeId: string,
  url: string,
): Promise<string> {
  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

  await docClient.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      PK: identityId,
      SK: `JOB#${jobId}`,
      jobId,
      awemeId,
      url,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ttl,
    },
  }));

  return jobId;
}

// ============================================================
// 辅助函数：写入 shared 表（全局共享数据池）
// ============================================================

/**
 * 将用户导入的视频数据同步写入 shared 表
 *
 * shared 表键值规则：
 * - POST:   PK='POST',       SK='{awemeId}'
 * - REST:   PK='REST',       SK='{restaurantId}'
 * - INFLUENCER: PK='INFLUENCER', SK='{uid}'
 * - RI:     PK='RI',         SK='{uid}#{rid}'
 * - GSI1:   GSI1PK='CITY#{city}', GSI1SK='REST#{restaurantId}'
 * - GSI2:   GSI2PK='INF#{uid}',   GSI2SK='REST#{restaurantId}'
 *
 * - 不写入 GSI3（bookmark-index）
 */
async function writeSharedTable(
  docClient: DynamoDBDocumentClient,
  params: {
    awemeId: string;
    restaurantId: string;
    influencerUid: string;
    city: string;
    video: Record<string, unknown>;
    now: string;
    identityId: string;
  },
): Promise<void> {
  const { awemeId, restaurantId, influencerUid, city, video, now, identityId } = params;

  try {
    // POST — 帖子关联（不覆盖已有）
    // P1-5 修复：记录 POST 是否真的新建，达人 postCount 只在新建时递增，
    // 避免重复导入同一视频使 postCount 虚高。
    // 头像用库里推荐者现有的（可能已换成软陶像，2026-10-28），新推荐者才用视频里带的抖音头像
    const influencerAvatar = (await existingInfluencerAvatar(docClient, SHARED_TABLE, influencerUid)) ?? video['influencerAvatar'];
    let postCreated = false;
    try {
      await docClient.send(new PutCommand({
        TableName: SHARED_TABLE,
        Item: {
          PK: 'POST',
          SK: awemeId,
          awemeId,
          influencerUid,
          restaurantId,
          influencerName: video['influencerName'],
          influencerAvatar,
          restaurantName: video['restaurantName'],
          coverUrl: video['coverUrl'],
          influencerSummary: video['influencerSummary'],
          tags: video['tags'],
          dishes: video['dishes'],
          ...(city !== 'unknown' ? { city } : {}),
          source: 'import',
          recommendedBy: identityId,
          publishedAt: video['publishedAt'],
          createdAt: now,
          ...(city !== 'unknown' ? { GSI4PK: `FEEDCITY#${city}`, GSI4SK: `${now}#${awemeId}` } : {}),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      postCreated = true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      // POST 已存在（重复导入）→ postCreated 保持 false
    }

    // REST — 餐厅（不存在时创建，已存在则追加 postRef）
    //
    // 2026-05-16 四标志位统一为 needsManualReview：与 Lambda parse-processor 对称。
    //   - city 缺失/为 unknown
    //   - restaurantName 缺失或为兜底 placeholder（"美食小店"）
    // 视频解析阶段没有坐标（由 iOS 后补），故不判断坐标缺失。
    const restaurantName = video['restaurantName'];
    const isPlaceholderName = !restaurantName ||
      typeof restaurantName !== 'string' ||
      restaurantName === '美食小店';
    const needsManualReview = !city || city === 'unknown' || isPlaceholderName;
    // 品类：parse-processor 已把 Gemini 分类结果写入 videos 表，命中已完成视频时透传给新建 REST
    const categories = sanitizeCategories(video['categories']);
    try {
      await docClient.send(new PutCommand({
        TableName: SHARED_TABLE,
        Item: {
          PK: 'REST',
          SK: restaurantId,
          restaurantId,
          restaurantName: video['restaurantName'],
          locationHint: video['locationHint'],
          city,
          postRefs: [awemeId],
          source: 'import',
          ...(categories.length > 0 ? { categories } : {}),
          GSI1PK: `CITY#${city}`,
          GSI1SK: `REST#${restaurantId}`,
          createdAt: now,
          updatedAt: now,
          ...(needsManualReview ? { needsManualReview: true } : {}),
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // 餐厅已存在 → 追加 postRef
        try {
          await docClient.send(new UpdateCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'REST', SK: restaurantId },
            UpdateExpression: 'SET updatedAt = :now, postRefs = list_append(if_not_exists(postRefs, :empty), :newRef)',
            ConditionExpression: 'NOT contains(postRefs, :awemeId)',
            ExpressionAttributeValues: {
              ':now': now,
              ':newRef': [awemeId],
              ':empty': [] as string[],
              ':awemeId': awemeId,
            },
          }));
        } catch {
          // awemeId 已在 postRefs 中（幂等保护），仅更新时间戳
          await docClient.send(new UpdateCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'REST', SK: restaurantId },
            UpdateExpression: 'SET updatedAt = :now',
            ExpressionAttributeValues: { ':now': now },
          }));
        }
      } else {
        throw err;
      }
    }

    // INFLUENCER — 达人（不存在时创建，已存在且本次真的新建了 POST 才累加 postCount）
    // P1-4 修复：初建 Item 不再写 restaurantCount:1 —— restaurantCount 统一交给下方
    // RI 新建成功后的 ADD +1 维护，否则首店会被记成 2。
    try {
      await docClient.send(new PutCommand({
        TableName: SHARED_TABLE,
        Item: {
          PK: 'INFLUENCER',
          SK: influencerUid,
          influencerUid,
          influencerName: video['influencerName'],
          influencerAvatar: video['influencerAvatar'],
          ...(video['influencerSignature'] ? { influencerSignature: video['influencerSignature'] as string } : {}),
          postCount: postCreated ? 1 : 0,
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        if (postCreated) {
          await docClient.send(new UpdateCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'INFLUENCER', SK: influencerUid },
            UpdateExpression: 'SET updatedAt = :now ADD postCount :one',
            ExpressionAttributeValues: {
              ':now': now,
              ':one': 1,
            },
          }));
        } else {
          // P1-5：重复导入（POST 未新建）→ postCount 不递增，仅刷新时间戳
          await docClient.send(new UpdateCommand({
            TableName: SHARED_TABLE,
            Key: { PK: 'INFLUENCER', SK: influencerUid },
            UpdateExpression: 'SET updatedAt = :now',
            ExpressionAttributeValues: { ':now': now },
          }));
        }
      } else {
        throw err;
      }
    }

    // RI — 餐厅-达人映射（幂等，新建时递增 INFLUENCER 的 restaurantCount）
    try {
      await docClient.send(new PutCommand({
        TableName: SHARED_TABLE,
        Item: {
          PK: 'RI',
          SK: `${influencerUid}#${restaurantId}`,
          influencerUid,
          restaurantId,
          city,
          GSI2PK: `INF#${influencerUid}`,
          GSI2SK: `REST#${restaurantId}`,
          createdAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      await docClient.send(new UpdateCommand({
        TableName: SHARED_TABLE,
        Key: { PK: 'INFLUENCER', SK: influencerUid },
        UpdateExpression: 'ADD restaurantCount :one, cities :citySet',
        ExpressionAttributeValues: {
          ':one': 1,
          ':citySet': new Set([city]),
        },
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
    }

    console.log(`[shared] 数据同步完成: POST/${awemeId}`);
  } catch (err) {
    // P1-7 修复：shared 表写入失败不再静默吞掉（否则调用方会返回假 completed，
    // 用户见"导入成功"但地图/feed 查无此店）。冒泡给调用方决定失败响应。
    console.error('[shared] 写入失败，冒泡给调用方:', err);
    throw err;
  }
}
