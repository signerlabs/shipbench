/**
 * 视频导入入库共享模块（2026-07-09 阶段 A 从 parse-processor 提取）
 *
 * 把 parse-processor handler 的 Step 5–9.9 入库核心（判探店 → 截帧上传 →
 * 取认店代理选中的店定位 → 落库判重 → 写 REST/POST/INFLUENCER/RI/users →
 * videos completed → 原视频补传 S3）整体收敛为单一函数 persistImportedRestaurant，
 * 供 parse-processor（增量导入 · mode='create'）与重刷脚本 refresh-restaurants.ts
 * （mode='refresh'）共用同一实现，保证「重刷 = 完整视频导入流程」100% 一致。
 *
 * 设计约束：
 * - 依赖注入（dynamoClient/s3Client/表名/bucket/ffmpegPath 全由调用方传入），
 *   模块内绝不 new 客户端、绝不读 process.env，便于脚本复用与单测。
 * - refresh 路径：跳过判重、按 existingRestaurantId 覆盖已存在的店，带防误命中闸（见 performRefresh 的注释）。
 *
 * 2026-10-20 起认店（是不是探店、哪家店、菜品点评）由认店代理一次给出（shop-agent.ts，入参 ShopAgentResult），
 * 本模块不再自己调高德：坐标、三层城市、高德编号都取代理选中的店（chosen，代码按编号查的高德详情）；
 * 拿不准的不上地图，存候选与代理给的依据交后台。旧的高德补坐标决策流与补坐标重试队列已删除。
 *
 * 注意：findDuplicateRestaurant 内部用 dynamodb.ts 的 SHARED_TABLE/USERS_TABLE/
 * VIDEOS_TABLE 常量（读 process.env），与原 handler 行为一致；调用方需保证这些
 * 环境变量已设置（Lambda 由 CDK 注入，脚本由运行环境注入）。
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { sanitizeCategories } from './restaurant-categories.js';
import { findDuplicateRestaurant, normalizeRestName, distanceMeters } from './restaurant-merge.js';
import { toStringArray } from './dynamodb.js';
import type { AgentPoi, ShopAgentResult } from './shop-agent.js';
import { markImportStage } from './import-status.js';
import { refundDailyParseQuota } from './parse-quota.js';
import { recordImport } from './import-record.js';

// ============================================================
// 类型定义
// ============================================================

/** 依赖注入：AWS 客户端 + 表名 + 资源配置（模块内不 new 客户端、不读 env） */
export interface VideoImportDeps {
  dynamoClient: DynamoDBDocumentClient;
  s3Client: S3Client;
  /** ffmpeg 可执行文件路径（Lambda 走 Layer 的 /opt/bin/ffmpeg） */
  ffmpegPath: string;
  /** S3 桶名 */
  bucket: string;
  videosTable: string;
  usersTable: string;
  sharedTable: string;
}

/** 入库需要的视频元数据（Step 5–9.9 实际用到的字段子集） */
export interface VideoImportVideoMeta {
  influencerUid: string;
  influencerName: string;
  influencerSignature?: string;
  /** 抖音博主亲挂的 POI 名 */
  poiName?: string;
  /** 视频发布时间（写入 POST.publishedAt） */
  publishedAt?: string;
}

/** 一次导入的上下文元数据（身份 / 限流 / 视频元 / 封面头像上传句柄） */
export interface VideoImportMeta {
  /** 抖音视频 ID（= 默认 restaurantId + 各处主键） */
  awemeId: string;
  /** 提交用户身份（'system-batch' 走批量分支，跳过 users 表写入） */
  identityId: string;
  /** 提交当天限流日期分片（rejected 时回退额度；batch 调用不传） */
  rateLimitDate?: string;
  /** 解析任务 ID（退额度时在 JOB 行打标记，保证同一任务最多退一次；batch / 重刷不传） */
  jobId?: string;
  videoMeta: VideoImportVideoMeta;
  /**
   * 封面 S3 URL 的 promise（Step 3.5 提前启动上传、内部已 catch fallback，不会 reject）。
   * Step 7.5 在过了 Step 5 探店闸之后才 await —— 非探店提前 return 时不 await（与原 handler 一致）。
   */
  coverUrlPromise: Promise<string>;
  /** 博主头像 S3 URL 的 promise（同上） */
  avatarUrlPromise: Promise<string>;
}

/** 视频来源：磁盘路径（create 走此路）或内存 buffer（阶段 B 预留） */
export type VideoImportSource = { videoPath: string } | { videoBuffer: Buffer };

/** 入库模式 */
export interface VideoImportOptions {
  /** create=增量导入（判重新建，现状等价）；refresh=阶段 B 重刷（按 existingRestaurantId 覆盖） */
  mode: 'create' | 'refresh';
  /** refresh 模式下要覆盖的已知 restaurantId */
  existingRestaurantId?: string;
  /**
   * refresh 模式专用：true=只算不写（跑 Gemini/高德/截帧决策但绝不写 DynamoDB/S3，
   * 供重刷脚本 DRY_RUN 预览多维改动），默认 false。create 模式忽略此项。
   */
  dryRun?: boolean;
}

/** 入库结果 */
export interface VideoImportResult {
  /** 是否为探店视频（false = Step 5 早退，未落库 REST/POST） */
  isRestaurantReview: boolean;
  /** 落库的 restaurantId（探店时有值；早退为 null） */
  restaurantId: string | null;
  /** 最终 city（探店时；未命中高德可能为空串） */
  city: string;
  /** 菜品数（探店时；早退为 0） */
  dishesCount: number;
  /** refresh 模式专属：多维改动 + 防误命中拦截明细（create 模式不返回） */
  refresh?: RefreshDetail;
}

/**
 * refresh 重刷的逐维改动明细（供重刷脚本 DRY_RUN/APPLY 统一口径构建报告）。
 * 各 *Changed 布尔 = 「refresh 决定覆盖该字段且新值≠旧值」（改动率分子），
 * DRY_RUN 与 APPLY 计算一致，仅 applied 区分是否真写库。
 */
export interface RefreshDetail {
  existingRestaurantId: string;
  /** 是否真正写入 DynamoDB/S3（!dryRun 且判为探店时 true；DRY_RUN 恒 false） */
  applied: boolean;
  /** Gemini 重析是否判为探店（false=非探店，整店一字未动） */
  isRestaurantReview: boolean;
  /** 未处理原因（非探店 / 店不存在等；正常处理为 null） */
  skippedReason: string | null;
  /** 坐标级拦截（坐标跳变>2km 且未获证据分级豁免 → 不覆盖坐标+店名+city，标 needsManualReview） */
  blocked: boolean;
  /** 坐标级拦截原因清单（blocked=true 时非空） */
  blockReasons: string[];
  /** 店名级拦截原因（占位名/名泛 → 只拦店名，坐标/city 照覆盖、不标脏；null=未拦） */
  nameBlockReason: string | null;
  /** 新旧坐标 Haversine 距离（有新+旧坐标才有值，米） */
  coordDistanceM: number | null;
  // ---- 逐维改动（改动率分子）----
  nameChanged: boolean;
  coordChanged: boolean;
  cityChanged: boolean;
  dishesChanged: boolean;
  summaryChanged: boolean;
  tagsChanged: boolean;
  categoriesChanged: boolean;
  // ---- old/new 明细 ----
  oldName: string;
  newName: string | null;
  oldCity: string;
  newCity: string | null;
  oldCoord: { lat: number; lng: number } | null;
  newCoord: { lat: number; lng: number } | null;
  oldDishCount: number;
  newDishCount: number;
  oldTags: string[];
  newTags: string[];
  /** 本店关联 POST 数（覆盖 name/city 时全部同步；dishes/推荐语/tags 仅覆盖主 POST） */
  postCount: number;
  /** 认店代理的结论（located / uncertain / no_name / not_review / overseas / low_quality / not_xiaodian / not_food / closed） */
  decision?: string;
}

// ============================================================
// 入库主函数
// ============================================================

/**
 * 视频导入入库全流程（原 parse-processor handler Step 5–9.9）。
 *
 * create 模式：与原 handler 逐字段等价 —— 判探店 / 截帧上传 / 城市 + 高德补坐标 /
 * 落库判重 / 写 REST·POST·INFLUENCER·RI·users 全字段与 GSI / videos completed /
 * 原视频补传。非探店视频写 videos=rejected + 回退当日额度后早退。
 * 2026-10-19：各步骤写 videos.stage（轮询下发处理阶段）；rejected 写 failReason=not_food_review；
 * 用户收藏行（Step 9）挪到 shared 实体（Step 9.5）之后写（防计数抢跑建出残缺店，见 Step 9 注释）；
 * Step 9 同时给提交者记一条「我导入的」导入记录（users 表 IMPORT#<awemeId>，见 lib/import-record.ts）。
 *
 * refresh 模式：阶段 B 落地，当前抛出未实现（接口预留）。
 */
export async function persistImportedRestaurant(
  deps: VideoImportDeps,
  analysis: ShopAgentResult,
  videoSource: VideoImportSource,
  meta: VideoImportMeta,
  options: VideoImportOptions,
): Promise<VideoImportResult> {
  const { mode } = options;
  if (mode === 'refresh') {
    // 阶段 B：跳过判重（Step 8.7）、跳过原视频补传（Step 9.9），按 existingRestaurantId
    // 覆盖式 upsert（UpdateCommand SET 只覆盖 Gemini 重产的内容字段，运营/关系/身份字段
    // 天然保留）。含防误命中闸：坐标跳变>2km 或 新店名更泛 → 不覆盖坐标+店名+city、标
    // needsManualReview。全流程逻辑收敛在 performRefresh，create 路径（下方）完全不受影响。
    if (!options.existingRestaurantId) {
      throw new Error('persistImportedRestaurant: refresh 模式必须提供 existingRestaurantId');
    }
    return performRefresh(deps, analysis, videoSource, meta, options.existingRestaurantId, options.dryRun ?? false);
  }

  // ==========================================================
  // 以下为 create 路径 —— 与原 handler Step 5–9.9 逐字段等价
  // ==========================================================
  const {
    dynamoClient, s3Client, ffmpegPath, bucket: s3Bucket,
    videosTable, usersTable, sharedTable,
  } = deps;
  const { awemeId, identityId, rateLimitDate, jobId, videoMeta, coverUrlPromise, avatarUrlPromise } = meta;

  // 视频路径：磁盘路径直接用；给 buffer（阶段 B）时落临时文件供 ffmpeg 读取
  let videoPath: string;
  if ('videoPath' in videoSource) {
    videoPath = videoSource.videoPath;
  } else {
    videoPath = `/tmp/${awemeId}.mp4`;
    writeFileSync(videoPath, videoSource.videoBuffer);
  }

  // ========================================
  // Step 5: 判断是否为探店视频；2026-10-20 起认不出真实店名的也拒收（不建店）
  // （2026-10-20 到 10-21 境外的店也拒收；10-21 起境外的店用 Google 找，照收）
  // ========================================
  // 拒收：videos=rejected + 失败原因码（iOS 按码显示提示）+ failMessage（完整提示，1.3.0 起 App 直接显示，
  // 改措辞不用发版；给用户看的，不出现抖音、导入、视频、链接这些字）；
  // 不扣用户当日导入额度（parse.ts 在任务入队时已 +1，这里退回；带 jobId 时幂等，同一任务最多退一次）
  const reject = async (failReason: string, reason: string, failMessage?: string, draft?: Record<string, unknown>): Promise<VideoImportResult> => {
    await dynamoClient.send(new UpdateCommand({
      TableName: videosTable,
      Key: { awemeId },
      // rejectionReason 原文保留供 admin 查看
      UpdateExpression: `SET #s = :s, rejectionReason = :reason, isRestaurantReview = :ir, failReason = :fr, updatedAt = :now${failMessage ? ', failMessage = :fm' : ''}${draft ? ', noNameDraft = :draft' : ''}`,
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': 'rejected',
        ':reason': reason,
        ':ir': failReason !== 'not_food_review',
        ':fr': failReason,
        ':now': new Date().toISOString(),
        ...(failMessage ? { ':fm': failMessage } : {}),
        ...(draft ? { ':draft': draft } : {}),
      },
    }));
    const refund = await refundDailyParseQuota(dynamoClient, usersTable, { identityId, rateLimitDate, jobId });
    if (refund === 'refunded') {
      console.log(`[Step 5] 拒收（${failReason}），已回退当日导入额度: ${rateLimitDate}`);
    }
    return { isRestaurantReview: false, restaurantId: null, city: '', dishesCount: 0 };
  };

  if (!analysis.is_restaurant_review) {
    console.log(`[Step 5] 非探店视频: ${analysis.rejection_reason}`);
    return reject('not_food_review', analysis.rejection_reason || '非探店视频');
  }
  // 2026-10-21 产品负责人定：几秒钟随手一拍、看不出店的视频，和连锁快餐、酒店早餐，直接不录入
  // （提示文案不提视频、导入；旧版 App 不认这两个码，显示 rejected 兜底「这条内容不是美食探店」）
  if (analysis.decision === 'low_quality') {
    console.log(`[Step 5] 太短、没有价值，拒收: ${analysis.rejection_reason ?? ''}`);
    return reject('low_quality', analysis.rejection_reason || '太短，看不出是哪家店', '这条太短，看不出是哪家店，换一条试试');
  }
  if (analysis.decision === 'not_xiaodian') {
    console.log(`[Step 5] 不是小店，拒收: ${analysis.restaurant_name ?? '（无店名）'} ${analysis.rejection_reason ?? ''}`);
    return reject('not_xiaodian', `不是小店：${analysis.restaurant_name ?? ''} ${analysis.rejection_reason ?? ''}`.trim(), '连锁快餐和酒店早餐不收录，换一家小店试试');
  }
  // 2026-10-26 产品负责人定：非餐饮的不上地图（书店、酒吧、超市、酒店、景区、服务区等，或地图上选中的不是餐饮店）
  // （旧版 App 不认这个码，显示 rejected 兜底「这条内容不是美食探店」）
  if (analysis.decision === 'not_food') {
    console.log(`[Step 5] 不是餐饮店，拒收: ${analysis.restaurant_name ?? '（无店名）'} ${analysis.rejection_reason ?? ''}`);
    return reject('not_food', `不是餐饮店：${analysis.restaurant_name ?? ''} ${analysis.rejection_reason ?? ''}`.trim(), '这家不是餐饮店，小店只收吃饭的地方，换一家试试');
  }
  // 2026-10-26 产品负责人定：店已经关门的不上地图（评论说关了，或地图标了暂停营业、装修中、停业）
  if (analysis.decision === 'closed') {
    console.log(`[Step 5] 店已关门，拒收: ${analysis.restaurant_name ?? '（无店名）'} ${analysis.rejection_reason ?? ''}`);
    return reject('shop_closed', `店已关门：${analysis.restaurant_name ?? ''} ${analysis.rejection_reason ?? ''}`.trim(), '这家店已经关门了，换一家试试');
  }
  // 认不出真实店名：不按菜品编名字建店（「肠粉店」这类店后台也找不到是哪一家）
  if (analysis.decision === 'no_name' || (!analysis.restaurant_name && !analysis.chosen)) {
    console.log(`[Step 5] 认不出真实店名，拒收（${analysis.multi_shop ? '合集视频' : '单店'}）`);
    // 2026-11-05 产品负责人定：只有认不出店名的留下模型交的其余字段；臣二次确认到店后直接用，不用再跑一遍 Gemini
    const draft = JSON.parse(JSON.stringify({
      bloggerSummary: analysis.blogger_summary,
      dishes: analysis.dishes,
      tags: analysis.tags,
      categories: analysis.categories,
      priceHint: analysis.price_hint,
      city: analysis.city,
      locationHint: analysis.location_hint,
      multiShop: analysis.multi_shop,
      shopCount: analysis.shop_count,
      reason: analysis.reason,
      model: analysis.model,
    })) as Record<string, unknown>;
    return reject('no_place_name', `认不出店名${analysis.multi_shop ? '（合集视频）' : ''}`, '没认出店名，换一条提到店名的试试', draft);
  }
  if (analysis.multi_shop) {
    console.log(`[Step 5] 合集视频（约 ${analysis.shop_count ?? '?'} 家），这次只收第一家: ${analysis.restaurant_name}`);
  }

  // 店名已在认店代理的管线层（shop-agent.ts）规整成字符串
  console.log(`[Step 5] 确认为探店视频: ${analysis.restaurant_name}`);
  const dishes = analysis.dishes || [];

  // 品类：过滤 Gemini 返回值到预定义白名单（挂在 REST 实体上）
  const categories = sanitizeCategories(analysis.categories);

  // ========================================
  // Step 6: ffmpeg 截帧
  // ========================================
  console.log(`[Step 6] 截取 ${dishes.length} 个菜品帧...`);
  for (let i = 0; i < dishes.length; i++) {
    const dish = dishes[i];
    if (!dish.timestamp) {
      console.warn(`[Step 6] 菜品 ${i} (${dish.name}) 无 timestamp，跳过截帧`);
      continue;
    }

    // 校验 timestamp 格式（MM:SS），防止命令注入
    if (!/^\d{1,2}:\d{2}$/.test(dish.timestamp)) {
      console.warn(`[Step 6] 菜品 ${i} (${dish.name}) timestamp 格式无效: "${dish.timestamp}"，跳过`);
      continue;
    }

    const outputPath = `/tmp/dish_${i}.jpg`;
    try {
      // timestamp 格式为 MM:SS，拼接为 00:MM:SS（HH:MM:SS）
      execSync(
        `${ffmpegPath} -y -ss 00:${dish.timestamp} -i ${videoPath} -frames:v 1 -q:v 2 ${outputPath}`,
        { timeout: 15_000, stdio: 'pipe' },
      );
      console.log(`[Step 6] 截帧成功: dish_${i} (${dish.name}) @ ${dish.timestamp}`);
    } catch (err) {
      // 截帧失败不中断 pipeline
      console.error(`[Step 6] 截帧失败: dish_${i} (${dish.name}) @ ${dish.timestamp}`, err);
    }
  }

  // ========================================
  // Step 7: 上传截图到 S3
  // ========================================
  console.log('[Step 7] 上传截图到 S3...');
  for (let i = 0; i < dishes.length; i++) {
    const framePath = `/tmp/dish_${i}.jpg`;
    if (!existsSync(framePath)) {
      console.warn(`[Step 7] 截图不存在: ${framePath}，跳过`);
      continue;
    }

    const frameKey = `dishes/${awemeId}/dish_${i}.jpg`;
    const frameBuffer = readFileSync(framePath);

    await s3Client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: frameKey,
      Body: frameBuffer,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=31536000', // 1 年缓存
    }));

    // 记录 S3 key 到 dish 对象
    dishes[i].s3Key = frameKey;
    console.log(`[Step 7] 上传成功: ${frameKey} (${(frameBuffer.length / 1024).toFixed(1)} KB)`);
  }

  // ========================================
  // Step 7.5: 等待封面 + 头像上传完成（已在 Step 3.5 提前启动，与 Gemini 分析并行）
  // ========================================
  // 此时 Gemini 分析已结束（中位约 60s），封面/头像上传（约 1-2s）大概率早已完成，
  // await 近乎零等待。原视频上传已后移至 Step 9.9（completed 落库之后）。
  const [s3CoverUrl, s3AvatarUrl] = await Promise.all([coverUrlPromise, avatarUrlPromise]);

  // ========================================
  // Step 8: 定位（2026-10-20 起由认店代理给出，这里只取结果）
  // ========================================
  // 城市分层（city 唯一权威=地图）：located → 代理选中的店（代码按编号查的高德或 Google 详情）的三层城市、坐标、地址、编号，
  // 并纠名为地图上的官方店名（境外取 Google 英文名，台湾取中文名）；拿不准 → 不上地图（city 留空，交后台），
  // 存候选与代理的依据，cityHint 存代理给的城市或位置线索供后台补。
  // （videos 表的 completed 写入在 Step 9.8：completed 是 pipeline 提交点，必须最后写）
  await markImportStage(dynamoClient, videosTable, awemeId, 'geocoding');
  const chosen = analysis.decision === 'located' ? analysis.chosen : null;
  const city = chosen?.city ?? '';
  const administrativeArea = chosen?.administrativeArea ?? '';
  const subLocality = chosen?.district ?? '';
  const cityHint = (analysis.city || analysis.location_hint || '').trim();
  if (chosen && chosen.name && chosen.name !== analysis.restaurant_name) {
    console.log(`[Step 8] 纠名: "${analysis.restaurant_name ?? ''}" → "${chosen.name}"（${chosen.source === 'google' ? 'Google' : '高德'}官方名）`);
    analysis.restaurant_name = chosen.name;
  }
  const geoCandidates = chosen ? [] : analysis.candidates.map(storedCandidate);
  console.log(chosen
    ? `[Step 8] 定位: ${chosen.name} (${chosen.lng},${chosen.lat}) ${city}${subLocality}`
    : `[Step 8] 拿不准，不上地图，候选 ${geoCandidates.length} 家：${analysis.reason}`);

  // ========================================
  // 落库准备（Step 9 用户收藏行已挪到 Step 9.5 shared 实体之后，见 Step 9 处注释）
  // ========================================
  await markImportStage(dynamoClient, videosTable, awemeId, 'persisting');
  const now = new Date().toISOString();
  let restaurantId = awemeId; // 默认 awemeId；下方判重命中时指向已有店
  const influencerUid = videoMeta.influencerUid;

  // Step 8.7: 落库前判重（去重合并迁移到 server 侧）——只有补到坐标才可能命中
  // （判重口径 = 同城同一个高德或 Google 编号；2026-10-22 产品负责人定不再按店名合并）。
  // 命中时 restaurantId 直接指向已有店：REST 落库走"已存在追加 postRef"分支、
  // POST/RI/users/videos 全部挂到已有店，从源头避免产生重复 REST（无需事后合并）。
  if (chosen?.id) {
    try {
      const dup = await findDuplicateRestaurant(dynamoClient, city, chosen.id);
      if (dup) {
        restaurantId = dup['SK'] as string;
        console.log(`[Step 8.7] 同城同一个编号的店已存在，本次导入挂到已有店: ${awemeId} → ${restaurantId}`);
      }
    } catch (err) {
      console.warn('[Step 8.7] 落库前判重失败（按新店落库，不阻断）:', err);
    }
  }

  // ========================================
  // Step 9.5: 同步写入 shared 表（全局共享数据池，所有请求都写）
  // ========================================
  {
    console.log('[Step 9.5] 同步写入 shared 表...');

    try {
      // POST — 帖子关联（不覆盖已有）
      // P1-5 同款修复：记录 POST 是否真的新建，达人 postCount 只在新建时递增
      // （失败重试 / 重复导入时 POST 已存在，不得重复累加）。
      let postCreated = false;
      try {
        await dynamoClient.send(new PutCommand({
          TableName: sharedTable,
          Item: {
            PK: 'POST',
            SK: awemeId,
            awemeId,
            influencerUid,
            restaurantId,
            influencerName: videoMeta.influencerName,
            influencerAvatar: s3AvatarUrl,
            restaurantName: analysis.restaurant_name,
            coverUrl: s3CoverUrl,
            // 城市三层（方案 B · city 权威=高德）：未命中 city 空串占位（前端不崩），cityHint 存 Gemini 原名供 admin 补
            city,
            locality: city,
            ...(administrativeArea ? { administrativeArea } : {}),
            ...(subLocality ? { subLocality } : {}),
            ...(!city && cityHint ? { cityHint } : {}),
            influencerSummary: analysis.blogger_summary,
            tags: analysis.tags || [],
            dishes,
            // priceHint 2026-11-04 停写：人均统一用地图详情 placeDetails 的 priceText，存量字段留给旧版 App
            source: 'import',
            ...(identityId !== 'system-batch' && { recommendedBy: identityId }),
            publishedAt: videoMeta.publishedAt,
            createdAt: now,
            // feed-index (GSI4)：按城市拉首页 Feed，按 createdAt 倒序
            // GSI key 空串会 ValidationException：city 空（待 admin）时省略分区键 → sparse index 不进 feed
            ...(city ? { GSI4PK: `FEEDCITY#${city}`, GSI4SK: `${now}#${awemeId}` } : {}),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
        postCreated = true;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
        // POST 已存在（重复导入 / 失败重试）→ postCreated 保持 false
      }

      // REST — 餐厅（不存在时创建，已存在则追加 postRef）
      //
      // 2026-05-16 四标志位统一为 needsManualReview：
      //   流水线认定"该店需要 admin 人工处理"的所有条件合并为单一标志位。
      //   - city 缺失/为 unknown
      //   - restaurantName 缺失或为兜底 placeholder（"美食小店"）
      //   注意：视频解析阶段本来就没坐标（坐标由 iOS POST /:id/location 后补），
      //   所以这里不判断坐标缺失。坐标补全的清标志位逻辑在 restaurants.ts /location 端点。
      const restaurantName = analysis.restaurant_name;
      // 2026-07-09 从「字面美食小店」扩为垃圾识名判定（合集名/超短名一并进 admin worklist）
      const isPlaceholderName = isJunkRestaurantName(restaurantName);
      // 没定到位置（city 空）或店名不可信 → 进后台待补全
      const needsManualReview = !city || city === 'unknown' || isPlaceholderName;
      try {
        await dynamoClient.send(new PutCommand({
          TableName: sharedTable,
          Item: {
            PK: 'REST',
            SK: restaurantId,
            restaurantId,
            restaurantName: analysis.restaurant_name,
            locationHint: analysis.location_hint,
            // 城市三层（方案 B · city 权威=高德）：未命中 city 空串占位（前端不崩），cityHint 存 Gemini 原名供 admin 补
            city,
            locality: city,
            ...(administrativeArea ? { administrativeArea } : {}),
            ...(subLocality ? { subLocality } : {}),
            ...(!city && cityHint ? { cityHint } : {}),
            postRefs: [awemeId],
            source: 'import',
            ...(categories.length > 0 ? { categories } : {}),
            // 认店代理选中的店：坐标、地址、编号都来自高德或 Google 详情（Google 的坐标是 WGS-84，App 直接用）
            ...(chosen ? {
              latitude: chosen.lat,
              longitude: chosen.lng,
              coordinateSource: chosen.source,
              ...(chosen.address ? { address: chosen.address } : {}),
              ...(chosen.source === 'google' ? { googlePlaceId: chosen.id } : { amapPoiId: chosen.id }),
            } : {}),
            // 拿不准时的定位候选（后台「待补全」里点一下就定）
            ...(geoCandidates.length > 0 ? { geoCandidates, geoCandidatesAt: now, geoReviewReason: 'agent-uncertain' } : {}),
            // 认店代理给的依据与模型（后台核对用）
            ...(analysis.reason ? { locateReason: analysis.reason.slice(0, 300) } : {}),
            locatedBy: analysis.model,
            // 店名是认出来的真实字号（认不出的已在 Step 5 拒收）；出处：标注/文案/博主评论/招牌/口播/观众评论
            nameSource: 'identified',
            ...(analysis.name_evidence && analysis.name_evidence !== 'none' ? { nameEvidence: analysis.name_evidence } : {}),
            // GSI key 空串会 ValidationException：city 空（待 admin）时省略 → sparse index 不进 city-index
            ...(city ? { GSI1PK: `CITY#${city}`, GSI1SK: `REST#${restaurantId}` } : {}),
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
            await dynamoClient.send(new UpdateCommand({
              TableName: sharedTable,
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
            // awemeId 已在 postRefs 中（幂等保护）
          }
        } else {
          throw err;
        }
      }

      // INFLUENCER — 达人（不存在时创建，已存在且本次真的新建了 POST 才累加 postCount）
      // P1-4 同款修复：初建 Item 不再写 restaurantCount:1 —— restaurantCount 统一交给
      // 下方 RI 新建成功后的 ADD +1 维护，否则首店会被记成 2。
      try {
        await dynamoClient.send(new PutCommand({
          TableName: sharedTable,
          Item: {
            PK: 'INFLUENCER',
            SK: influencerUid,
            influencerUid,
            influencerName: videoMeta.influencerName,
            influencerAvatar: s3AvatarUrl,
            ...(videoMeta.influencerSignature && { influencerSignature: videoMeta.influencerSignature }),
            postCount: postCreated ? 1 : 0,
            createdAt: now,
            updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
      } catch (err: unknown) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
          // 已有的推荐者不改头像（2026-10-28）：库里的头像可能已换成软陶像，导入不能拿抖音头像覆盖
          await dynamoClient.send(new UpdateCommand({
            TableName: sharedTable,
            Key: { PK: 'INFLUENCER', SK: influencerUid },
            UpdateExpression: postCreated
              ? 'SET updatedAt = :now, influencerName = :name ADD postCount :one'
              : 'SET updatedAt = :now, influencerName = :name',
            ExpressionAttributeValues: {
              ':now': now,
              ':name': videoMeta.influencerName,
              ...(postCreated ? { ':one': 1 } : {}),
            },
          }));
        } else {
          throw err;
        }
      }

      // RI — 餐厅-达人映射（幂等写入，新建时递增 INFLUENCER 统计）
      try {
        await dynamoClient.send(new PutCommand({
          TableName: sharedTable,
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
        // 新 RI 创建成功 → 递增 restaurantCount + 累加城市集合
        await dynamoClient.send(new UpdateCommand({
          TableName: sharedTable,
          Key: { PK: 'INFLUENCER', SK: influencerUid },
          UpdateExpression: 'ADD restaurantCount :one, cities :citySet',
          ExpressionAttributeValues: {
            ':one': 1,
            ':citySet': new Set([city]),
          },
        }));
        // cityPostCounts 嵌套 Map 计数（本城推荐者排行 + cityRestaurantCount 用）。
        // Map 父属性不存在时（老 INFLUENCER 未回填）嵌套 SET 会抛 ValidationException，兜底初始化。
        if (city && city !== 'unknown') {
          try {
            await dynamoClient.send(new UpdateCommand({
              TableName: sharedTable,
              Key: { PK: 'INFLUENCER', SK: influencerUid },
              UpdateExpression: 'SET #cpc.#city = if_not_exists(#cpc.#city, :zero) + :one',
              ExpressionAttributeNames: { '#cpc': 'cityPostCounts', '#city': city },
              ExpressionAttributeValues: { ':zero': 0, ':one': 1 },
              ConditionExpression: 'attribute_exists(PK)',
            }));
          } catch (cpcErr: unknown) {
            const cpcName = (cpcErr as { name?: string }).name;
            if (cpcName === 'ValidationException' || cpcName === 'ConditionalCheckFailedException') {
              await dynamoClient.send(new UpdateCommand({
                TableName: sharedTable,
                Key: { PK: 'INFLUENCER', SK: influencerUid },
                UpdateExpression: 'SET #cpc = :initMap',
                ExpressionAttributeNames: { '#cpc': 'cityPostCounts' },
                ExpressionAttributeValues: { ':initMap': { [city]: 1 } },
                ConditionExpression: 'attribute_exists(PK)',
              }));
            } else {
              throw cpcErr;
            }
          }
        }
      } catch (riErr: unknown) {
        if ((riErr as { name?: string }).name !== 'ConditionalCheckFailedException') {
          throw riErr;
        }
        // RI 已存在，跳过
      }

      console.log(`[Step 9.5] shared 表同步完成: POST/${awemeId}`);
    } catch (err) {
      // P1-7 修复：shared 表四实体写失败不再静默完成，抛出交给全局异常处理回写
      // videos=failed（用户重试导入时 failed 状态会重新触发 pipeline，Step 9.5 各实体
      // 条件写幂等，可安全补齐）。此时 videos 尚未标 completed（M1 调序后 completed
      // 在 Step 9.8 才写），轮询窗口内不会向用户误报"导入成功"。
      console.error('[Step 9.5] shared 表写入失败，pipeline 转为失败（不再静默完成）:', err);
      throw err;
    }
  }

  // ========================================
  // Step 9: 关联用户数据到 users 表（仅普通用户，system-batch 跳过）
  // ========================================
  // 2026-10-19 调序：用户收藏行改在 shared 实体（Step 9.5）之后写。收藏行一落库，users 表
  // Stream 就会驱动 leaderboard-aggregator 给 REST / INFLUENCER 加计数；旧顺序下计数可能抢在
  // REST 建店之前到达——旧版计数是无条件 ADD，会先 upsert 出一个只有 totalBookmarks 的空壳，
  // Step 9.5 的 REST 条件建店随即撞上它、走「已存在只追加 postRef」分支，落成一个没有店名、
  // 城市、分区键的残缺店。现在计数加了「实体必须存在」条件，先写 shared 也保证本人这一次收藏
  // 不被漏计。两段写入各自幂等，失败重跑结果不变。
  if (identityId !== 'system-batch') {
    console.log('[Step 9] 关联用户偏好数据...');

    // Phase 5: users 表只存用户偏好（bookmarked），不再写 POST# 和 RI#
    // 帖子数据和达人统计完全由 shared 表维护

    // 9.2 REST# — 仅存 restaurantId + bookmarked + GSI3（如果不存在则创建，已存在则跳过）
    try {
      await dynamoClient.send(new PutCommand({
        TableName: usersTable,
        Item: {
          PK: identityId,
          SK: `REST#${restaurantId}`,
          restaurantId,
          bookmarked: true,
          GSI3PK: `${identityId}#BOOKMARK`,
          GSI3SK: `REST#${restaurantId}`,
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

    // 9.3 INFLUENCER# — 仅存 influencerUid + bookmarked + GSI3（如果不存在则创建，已存在则跳过）
    try {
      await dynamoClient.send(new PutCommand({
        TableName: usersTable,
        Item: {
          PK: identityId,
          SK: `INFLUENCER#${influencerUid}`,
          influencerUid,
          bookmarked: true,
          GSI3PK: `${identityId}#BOOKMARK`,
          GSI3SK: `INFLUENCER#${influencerUid}`,
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

    // 9.4 IMPORT# — 「我导入的」导入记录（2026-10-19，见 lib/import-record.ts）。
    // 放在收藏行之后、videos completed（Step 9.8）之前：写失败同收藏行一样抛出交全局异常处理
    // （videos=failed，用户重试时各步幂等补齐）；非探店视频在 Step 5 已早退，不会走到这里。
    // 条件写：本人之前导入过这个视频（失败重试 / 重复导入）时保留第一次的导入时间
    const importRecord = await recordImport(dynamoClient, usersTable, {
      identityId,
      awemeId,
      restaurantId,
      importedAt: now,
      via: 'pipeline',
    });

    console.log(`[Step 9] 用户偏好数据关联完成（导入记录: ${importRecord}）`);
  } // end if (identityId !== 'system-batch')

  // ========================================
  // Step 9.8: 更新 videos 表为 completed（pipeline 提交点）
  // ========================================
  // M1 修复：completed 必须在 shared 表同步成功之后才写。轮询以 videos.status 为准，
  // 一旦写入 completed 用户即收到"导入成功"；若先写 completed 再同步 shared 表，
  // 同步失败的瞬间窗口会误报成功（店实际没进地图/feed，且 JOB 已翻转不再纠正）。
  console.log('[Step 9.8] 更新 videos 表...');

  // videos 表更新状态、分流决策字段和 city（前端轮询 JOB 时需要 city 来 reload 对应城市）
  // categories 一并写入 videos 表：completed 命中路径（parse.ts writeSharedTable）据此为新建 REST 补品类
  const videoUpdateValues: Record<string, unknown> = {
    ':s': 'completed',
    ':ir': true,
    ':city': city,
    ':rid': restaurantId, // 阶段 1：判重命中时指向已有店，GET /jobs 与去重命中路径据此找店
    ':now': new Date().toISOString(),
  };
  let videoUpdateExpr = 'SET #s = :s, isRestaurantReview = :ir, city = :city, restaurantId = :rid, updatedAt = :now';
  if (categories.length > 0) {
    videoUpdateExpr += ', categories = :categories';
    videoUpdateValues[':categories'] = categories;
  }
  // 2026-10-20：合集视频（这次只收了第一家，以后拆店据此重跑）、店名出处、认店方式与结论
  videoUpdateExpr += ', locateDecision = :ld, locatedBy = :lb';
  videoUpdateValues[':ld'] = analysis.decision;
  videoUpdateValues[':lb'] = analysis.model;
  if (analysis.multi_shop) {
    videoUpdateExpr += ', multiShop = :ms, shopCount = :sc';
    videoUpdateValues[':ms'] = true;
    videoUpdateValues[':sc'] = analysis.shop_count ?? 0;
  }
  if (analysis.name_evidence) {
    videoUpdateExpr += ', nameEvidence = :ne';
    videoUpdateValues[':ne'] = analysis.name_evidence;
  }
  videoUpdateExpr += ', analysisSource = :as';
  videoUpdateValues[':as'] = analysis.source;
  await dynamoClient.send(new UpdateCommand({
    TableName: videosTable,
    Key: { awemeId },
    UpdateExpression: videoUpdateExpr,
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: videoUpdateValues,
  }));
  console.log(`[Step 9.8] videos 表更新完成: status=completed, city=${city}, restaurantId=${awemeId}`);

  // ========================================
  // Step 9.9: 上传原始视频到 S3（后台补传，已挪出用户等待的关键路径）
  // ========================================
  // 原视频 key 未写入任何 DB 字段、无 API 读取方（仅 batch 导入用 existsInS3
  // 检查补传），completed 落库后再上传对用户不可见。此时 handler 尚未 return，
  // Lambda 不会提前冻结，继续 await 是安全的；上传失败降级为仅打日志，
  // 不影响已写入的 completed 状态。
  // （refresh 模式视频本就在 S3、阶段 B 跳过本步）
  try {
    if (existsSync(videoPath)) {
      const videoKey = `videos/${awemeId}.mp4`;
      const videoBuffer = readFileSync(videoPath);
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: videoKey,
        Body: videoBuffer,
        ContentType: 'video/mp4',
        CacheControl: 'public, max-age=31536000',
      }));
      console.log(`[Step 9.9] 视频上传成功: ${videoKey} (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    }
  } catch (err) {
    console.warn('[Step 9.9] 原视频上传失败（不影响 completed 状态）:', err);
  }

  console.log(`=== Pipeline 完成: awemeId=${awemeId}, restaurant=${analysis.restaurant_name}, dishes=${dishes.length} ===`);

  return {
    isRestaurantReview: true,
    restaurantId,
    city,
    dishesCount: dishes.length,
  };
}

// ============================================================
// refresh 重刷（阶段 B）
// ============================================================

/** 防误命中闸①：新旧坐标跳变阈值（米）。超此距离视为高德命中到别家店，不覆盖坐标+店名+city。 */
const REFRESH_COORD_JUMP_THRESHOLD_M = 2000;

/** 拿不准时存给后台的候选（REST.geoCandidates；admin-snapshot / 小店后台「用这家」读这些字段） */
function storedCandidate(p: AgentPoi): Record<string, unknown> {
  return {
    name: p.name,
    ...(p.address ? { address: p.address } : {}),
    latitude: p.lat,
    longitude: p.lng,
    ...(p.city ? { city: p.city } : {}),
    ...(p.source === 'google' ? { googlePlaceId: p.id } : { poiId: p.id }),
    source: 'agent',
  };
}

/**
 * 垃圾识名判定（2026-07-09 第一批重刷实战教训；create 用于标 needsManualReview，
 * refresh 用于拒绝覆盖旧名并标脏）：
 *  - 空 / 兜底占位名「美食小店」（早年识名失败时注入的兜底名）
 *  - 合集类命名（实测「青岛美食探店合集」——视频本身是多店合集，不是单店）
 *  - 超短名 ≤2 字（实测 OCR 碎片「O糕」；真实 2 字店名极罕见，宁保守）
 * 城市名污染（「伊宁市」「沧州市」）已在高德侧按权威 typecode 过滤断根
 * （amap-geocode.ts isNonMerchantPoiType），此处不自维护地名判断。
 */
export function isJunkRestaurantName(name: unknown): boolean {
  if (typeof name !== 'string') return true;
  const n = name.trim();
  if (!n || n === '美食小店') return true;
  if (n.length <= 2) return true;
  return /(探店|合集|美食汇|美食街|vlog)/i.test(n);
}

/** 取菜品名数组（POST.dishes 里每项的 name），用于 dishes 改动判定 */
function dishNamesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((d) => (d && typeof d === 'object' ? (d as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string');
}

/** 有序数组相等（用于 dishes/tags 改动判定；顺序变化也算改动，因新流程会重排） */
function arrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/**
 * refresh 重刷全流程（对应 create 的 Step 5–9.8，但语义为「覆盖已知店」）：
 *
 * 与 create 的差异：
 *  1. 跳过判重新建（Step 8.7）——店已知，直接按 existingRestaurantId 覆盖；
 *  2. 跳过原视频补传（Step 9.9）——视频本就在 S3；
 *  3. 截图仍重跑（Step 6-7，仅 APPLY）——新 dishes 重截帧 + 传 S3，写新 s3Key；
 *  4. 覆盖式 UpdateCommand SET：只覆盖 Gemini 重产的内容字段，运营/关系/身份/时间字段
 *     因不在 SET 清单里而天然保留（createdAt/postRefs/totalBookmarks/paidBookmarks/source/
 *     restaurantId；POST 的 createdAt、publishedAt、awemeId、influencerUid/Name/Avatar、coverUrl、postLikeCount、source）。
 *
 * 防误命中闸（重刷的主体是苹果地图兜底留下的老坐标，「旧数据大概率对」的前提不成立）：
 *  - 闸①坐标跳变 > 2km → 拦坐标+店名+city、标 needsManualReview；**豁免**：认店代理定到了店，
 *    且旧坐标来自苹果地图兜底（mklocalsearch）或没记来源 → 放行覆盖不论跳变距离；
 *    旧值来自高德或后台人工的，维持 2km 拦截交后台。
 *  - 闸②店名级拦截（nameBlockReason，只拦店名、不拦坐标/city）：
 *    · 垃圾识名（isJunkRestaurantName：兜底名「美食小店」/合集名/≤2 字超短名）：不覆盖
 *      真实店名，且标 needsManualReview（垃圾识名往往意味着视频是合集/错配，交 admin）；
 *    · 名泛：新店名 normalize 后是旧店名真子集（旧名更具体 → 保留旧名，坐标照覆盖，不标脏）；
 *    · 保长文：代理没定到店（没有高德官方名背书）且 normalize 后同店、新名更短（丢分店后缀）→ 保留旧长名，不标脏。
 *    另：选中的店必须是餐饮店（高德 typecode 05），在认店代理的管线层已经卡住。
 *  - 非探店（R0）：整店内容不动 + 标 needsManualReview 交 admin 追查（店可能本身是脏数据）。
 * dishes/推荐语/tags/categories 等纯 Gemini 内容字段不受闸影响，照常覆盖（非空才写，防退化清空）。
 *
 * 截图 S3 key 带版本后缀（dish_{i}_{ts}.jpg）：新 key 天然击穿 CDN 1 年缓存，旧图对象保留 ——
 * 快照回滚（restore-from-snapshots）还原旧 POST 行后，旧 dishes[].s3Key 仍指向未被覆盖的旧图。
 *
 * 城市变更时同步派生态（R6c）：videos.city（parse 去重命中兜底读）+ RI.city（admin 展示）。
 * INFLUENCER.cities/cityPostCounts 聚合不做增量迁移（增减需全局视角），批量重刷后跑
 * scripts/archive/backfill-feed-index.ts 全量重算。
 *
 * 前置约定：meta.awemeId = postRefs[0]（重刷的那条视频/主 POST），dishes/推荐语/tags
 * 只覆盖到主 POST（多视频店的其他 POST 内容不被本视频的重析污染）；name/三层 city/GSI4 同步全部 POST。
 */
async function performRefresh(
  deps: VideoImportDeps,
  analysis: ShopAgentResult,
  videoSource: VideoImportSource,
  meta: VideoImportMeta,
  existingRestaurantId: string,
  dryRun: boolean,
): Promise<VideoImportResult> {
  const { dynamoClient, s3Client, ffmpegPath, bucket: s3Bucket, sharedTable, videosTable } = deps;
  const { awemeId: primaryAwemeId } = meta;
  const tag = `[refresh ${existingRestaurantId}${dryRun ? ' DRY' : ''}]`;

  // 空明细骨架（非探店 / 店不存在早退时用）
  const skeleton = (over: Partial<RefreshDetail>): RefreshDetail => ({
    existingRestaurantId, applied: false, isRestaurantReview: false, skippedReason: null,
    blocked: false, blockReasons: [], nameBlockReason: null, coordDistanceM: null,
    nameChanged: false, coordChanged: false, cityChanged: false, dishesChanged: false,
    summaryChanged: false, tagsChanged: false, categoriesChanged: false,
    oldName: '', newName: null, oldCity: '', newCity: null,
    oldCoord: null, newCoord: null, oldDishCount: 0, newDishCount: 0,
    oldTags: [], newTags: [], postCount: 0,
    ...over,
  });

  // ---- R0: 非探店 → 拒绝覆盖，整店内容不动；标 needsManualReview 交 admin 追查 ----
  // 重析判非探店有两种可能：Gemini 误判（内容保住了）或该店本身是脏数据（视频压根不是探店），
  // 后者正是重刷要清理的对象 —— 标脏让 admin 复核，而不是只在报告里可见。
  if (!analysis.is_restaurant_review) {
    const reason = `not-restaurant:${analysis.rejection_reason || ''}`;
    console.log(`${tag} Gemini 判为非探店（${analysis.rejection_reason}），拒绝覆盖、标 needsManualReview`);
    if (!dryRun) {
      try {
        await dynamoClient.send(new UpdateCommand({
          TableName: sharedTable, Key: { PK: 'REST', SK: existingRestaurantId },
          UpdateExpression: 'SET needsManualReview = :nmr, refreshReviewReason = :rrr, updatedAt = :now',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':nmr': true, ':rrr': `refresh:${reason}`, ':now': new Date().toISOString(),
          },
        }));
      } catch (err) {
        console.warn(`${tag} 非探店标脏失败（不阻断）:`, err);
      }
    }
    return {
      isRestaurantReview: false, restaurantId: existingRestaurantId, city: '', dishesCount: 0,
      refresh: skeleton({ skippedReason: reason }),
    };
  }

  // ---- R1: 读现有 REST + 关联 POST（拿旧值做防误命中判 + GSI4SK 保序 + 报告明细）----
  const restGet = await dynamoClient.send(new GetCommand({
    TableName: sharedTable, Key: { PK: 'REST', SK: existingRestaurantId },
  }));
  const rest = restGet.Item;
  if (!rest) {
    throw new Error(`refresh: REST 不存在 restaurantId=${existingRestaurantId}（无法重刷不存在的店）`);
  }
  const oldName = typeof rest['restaurantName'] === 'string' ? rest['restaurantName'] : '';
  const oldCity = (typeof rest['locality'] === 'string' && rest['locality'])
    || (typeof rest['city'] === 'string' && rest['city']) || '';
  const oldLat = typeof rest['latitude'] === 'number' ? (rest['latitude'] as number) : null;
  const oldLng = typeof rest['longitude'] === 'number' ? (rest['longitude'] as number) : null;
  const oldCoordExists = oldLat !== null && oldLng !== null;
  const oldCategories = toStringArray(rest['categories']);

  const postRefs = toStringArray(rest['postRefs']);
  const posts: Record<string, unknown>[] = [];
  for (const pid of postRefs) {
    const g = await dynamoClient.send(new GetCommand({ TableName: sharedTable, Key: { PK: 'POST', SK: pid } }));
    if (g.Item) posts.push(g.Item);
  }
  const primaryPost = posts.find((p) => p['SK'] === primaryAwemeId) || posts[0] || null;
  const oldDishNames = dishNamesOf(primaryPost?.['dishes']);
  const oldTags = toStringArray(primaryPost?.['tags']);
  const oldSummary = typeof primaryPost?.['influencerSummary'] === 'string' ? (primaryPost!['influencerSummary'] as string) : '';

  // ---- R3: 定位（认店代理选中的店，与 create Step 8 同口径；纠名为高德官方名）----
  const chosen = analysis.decision === 'located' ? analysis.chosen : null;
  const newCityLayers = chosen ? { administrativeArea: chosen.administrativeArea, locality: chosen.city, subLocality: chosen.district } : null;
  if (chosen && chosen.name && chosen.name !== analysis.restaurant_name) {
    console.log(`${tag} 纠名: "${analysis.restaurant_name ?? ''}" → "${chosen.name}"`);
    analysis.restaurant_name = chosen.name;
  }
  const geoCandidates = chosen ? [] : analysis.candidates.map(storedCandidate);
  const finalName = analysis.restaurant_name || '';
  // 闸③垃圾识名（与 create 同口径，isJunkRestaurantName）：兜底名/合集名/超短名
  // 绝不覆盖真实店名，且往往意味着视频是合集/错配/识别失败 → R6a 标 needsManualReview。
  const isPlaceholderName = isJunkRestaurantName(finalName);

  // ---- R4: 防误命中闸 ----
  const blockReasons: string[] = [];
  let coordDistanceM: number | null = null;
  // 闸①：坐标跳变过大（需同时有新旧坐标）。
  // 豁免：旧坐标来自苹果地图兜底或没记来源（低可信旧源，重刷主体）且代理定到了店 → 放行覆盖不论跳变距离
  // ——老数据错得越离谱跳变越大，2km 闸保护的是错误一方。旧值已经高德或后台人工校准过 → 维持 2km 拦截交后台。
  const oldCoordSource = typeof rest['coordinateSource'] === 'string' ? (rest['coordinateSource'] as string) : '';
  if (chosen && oldCoordExists) {
    coordDistanceM = distanceMeters(oldLat as number, oldLng as number, chosen.lat, chosen.lng);
    if (coordDistanceM > REFRESH_COORD_JUMP_THRESHOLD_M) {
      const exempt = oldCoordSource === 'mklocalsearch' || !oldCoordSource;
      if (exempt) {
        console.log(`${tag} 坐标跳变 ${coordDistanceM.toFixed(0)}m>2km，但代理定到 + 旧源 ${oldCoordSource || '没记'} → 放行覆盖`);
      } else {
        blockReasons.push(`coord-jump:${coordDistanceM.toFixed(0)}m>${REFRESH_COORD_JUMP_THRESHOLD_M}m(oldSrc=${oldCoordSource})`);
      }
    }
  }
  const blocked = blockReasons.length > 0;
  if (blocked) console.log(`${tag} 防误命中拦截: ${blockReasons.join('; ')} → 不覆盖坐标/店名/city，标 needsManualReview`);

  // 闸②：店名级拦截（只拦店名，坐标/city 照覆盖、不标脏）——
  //  占位名：重析兜底名不覆盖真实店名；名泛：新名是旧名真子集（旧名更具体，保留旧名）
  const oldNorm = oldName ? normalizeRestName(oldName) : '';
  const newNorm = finalName ? normalizeRestName(finalName) : '';
  // 同名豁免：新旧 normalize 相同（「肥鸡」→「肥鸡」2 字真店重析同名）时覆盖无实际变化，
  // 不按垃圾名拦截、更不标 review（第一批实测 2 字同名店被误标进 admin worklist 的噪音）
  const junkName = isPlaceholderName && newNorm !== oldNorm;
  let nameBlockReason: string | null = null;
  if (junkName) {
    nameBlockReason = `junk-name:"${finalName || '(空)'}"`;
  } else if (oldNorm && newNorm && newNorm !== oldNorm && oldNorm.includes(newNorm)) {
    nameBlockReason = `name-generic:"${finalName}"⊂"${oldName}"`;
  } else if (!chosen && oldNorm && newNorm && newNorm === oldNorm
    && finalName.length < oldName.length) {
    // 保长文：没有高德官方名背书且 normalize 后同店，新名更短=丢分店后缀信息
    // （实测「紫光园(亦庄店)」→「紫光园」9 家），保留旧的更长原文；代理定到的（高德官方名）豁免
    nameBlockReason = `same-store-shorter:"${finalName}"(保留旧名"${oldName}")`;
  }
  if (nameBlockReason && !blocked) console.log(`${tag} 店名级拦截: ${nameBlockReason} → 店名保留旧值（坐标/city 不受影响）`);

  // ---- R5: 逐字段覆盖决策 ----
  // 坐标/city（源自高德命中）：坐标级 blocked 一律不覆盖；坐标需命中，city 还需 locality 非空；
  // 店名：坐标级 blocked（误命中的纠名不可信）或店名级拦截（占位名/名泛）都不覆盖
  const applyCoord = !!chosen && !blocked;
  const applyCity = applyCoord && !!(newCityLayers && newCityLayers.locality);
  const applyName = !blocked && !nameBlockReason;
  const newCity = applyCity ? newCityLayers!.locality : null;

  // 内容字段（纯 Gemini 重产，不受闸影响）：非空才覆盖，防一次退化重析把好数据清空
  const newDishes = analysis.dishes || [];
  const applyDishes = newDishes.length > 0;
  const newTags = analysis.tags || [];
  const applyTags = newTags.length > 0;
  const newSummary = typeof analysis.blogger_summary === 'string' ? analysis.blogger_summary.trim() : '';
  const applySummary = newSummary.length > 0;
  const newCategories = sanitizeCategories(analysis.categories);
  const applyCategories = newCategories.length > 0;

  // 逐维「是否改动」（改动率分子；决定覆盖 且 新值≠旧值）
  const newDishNames = newDishes.map((d) => d.name).filter((n): n is string => typeof n === 'string');
  const nameChanged = applyName && oldNorm !== newNorm;
  const coordChanged = applyCoord && (!oldCoordExists || (coordDistanceM !== null && coordDistanceM >= 1));
  const cityChanged = applyCity && oldCity.trim() !== (newCity || '').trim();
  const dishesChanged = applyDishes && !arrayEq(oldDishNames, newDishNames);
  const summaryChanged = applySummary && oldSummary.trim() !== newSummary;
  const tagsChanged = applyTags && !arrayEq(oldTags, newTags);
  const categoriesChanged = applyCategories && !arrayEq(oldCategories, newCategories);

  const detail: RefreshDetail = {
    existingRestaurantId, applied: false, isRestaurantReview: true, skippedReason: null,
    blocked, blockReasons, nameBlockReason, coordDistanceM,
    nameChanged, coordChanged, cityChanged, dishesChanged, summaryChanged, tagsChanged, categoriesChanged,
    oldName, newName: finalName || null, oldCity, newCity,
    oldCoord: oldCoordExists ? { lat: oldLat as number, lng: oldLng as number } : null,
    newCoord: chosen ? { lat: chosen.lat, lng: chosen.lng } : null,
    oldDishCount: oldDishNames.length, newDishCount: newDishNames.length,
    oldTags, newTags, postCount: posts.length,
    decision: analysis.decision,
  };

  // ---- DRY_RUN：只算不写，直接返回决策明细（供脚本预览多维改动 + 拦截清单）----
  if (dryRun) {
    console.log(`${tag} DRY_RUN 预览: name=${nameChanged} coord=${coordChanged} city=${cityChanged} dishes=${dishesChanged} summary=${summaryChanged} tags=${tagsChanged}`);
    return {
      isRestaurantReview: true, restaurantId: existingRestaurantId,
      city: newCity || oldCity, dishesCount: newDishNames.length, refresh: detail,
    };
  }

  // ==========================================================
  // 以下为 APPLY（!dryRun）：截图重跑 + 覆盖写库
  // ==========================================================

  // ---- R2: ffmpeg 截帧 + 上传 S3（写新 s3Key 到 newDishes；与 create Step 6-7 同一命令/参数）----
  // 与 create 的两点刻意差异：
  //  1. 帧临时文件带 awemeId 前缀 + finally 清理 —— 防 warm 容器复用/并发调用间残留帧串店
  //     （create 单任务由 handler cleanupTmpFiles 收口，refresh 由本函数自清）；
  //  2. S3 key 带版本后缀 dish_{i}_{ts}.jpg —— 新 key 击穿 CDN 1 年缓存立即可见，
  //     旧图对象保留：快照回滚还原旧 POST 行后旧 s3Key 仍指向完好旧图。
  // 视频物化到磁盘供 ffmpeg（仅 buffer 来源时由本函数负责删除）
  let videoPath: string;
  let materializedVideo = false;
  if ('videoPath' in videoSource) {
    videoPath = videoSource.videoPath;
  } else {
    videoPath = `/tmp/${primaryAwemeId}.mp4`;
    writeFileSync(videoPath, videoSource.videoBuffer);
    materializedVideo = true;
  }
  const framePathOf = (i: number): string => `/tmp/dish_${primaryAwemeId}_${i}.jpg`;
  const refreshVersion = Date.now();
  try {
    for (let i = 0; i < newDishes.length; i++) {
      const dish = newDishes[i];
      if (!dish.timestamp) { console.warn(`${tag} 菜品 ${i} (${dish.name}) 无 timestamp，跳过截帧`); continue; }
      if (!/^\d{1,2}:\d{2}$/.test(dish.timestamp)) { console.warn(`${tag} 菜品 ${i} timestamp 无效: "${dish.timestamp}"，跳过`); continue; }
      const outputPath = framePathOf(i);
      try {
        execSync(
          `${ffmpegPath} -y -ss 00:${dish.timestamp} -i ${videoPath} -frames:v 1 -q:v 2 ${outputPath}`,
          { timeout: 15_000, stdio: 'pipe' },
        );
      } catch (err) {
        console.error(`${tag} 截帧失败: dish_${i} (${dish.name}) @ ${dish.timestamp}`, err);
      }
    }
    for (let i = 0; i < newDishes.length; i++) {
      const framePath = framePathOf(i);
      if (!existsSync(framePath)) continue;
      const frameKey = `dishes/${primaryAwemeId}/dish_${i}_${refreshVersion}.jpg`;
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket, Key: frameKey, Body: readFileSync(framePath),
        ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000',
      }));
      newDishes[i].s3Key = frameKey; // 写新 s3Key（带版本）
    }
  } finally {
    for (let i = 0; i < newDishes.length; i++) {
      try { unlinkSync(framePathOf(i)); } catch { /* 未生成/已删，忽略 */ }
    }
    if (materializedVideo) {
      try { unlinkSync(videoPath); } catch { /* 忽略 */ }
    }
  }

  const now = new Date().toISOString();

  // ---- R6a: 覆盖 REST（UpdateCommand SET，未列字段天然保留）----
  const setParts: string[] = ['updatedAt = :now'];
  const vals: Record<string, unknown> = { ':now': now };
  const removeParts: string[] = [];
  if (applyName) {
    setParts.push('restaurantName = :rn'); vals[':rn'] = finalName;
    setParts.push('nameSource = :ns'); vals[':ns'] = 'identified';
  }
  if (applyCoord) {
    setParts.push('latitude = :lat', 'longitude = :lng', 'coordinateSource = :cs');
    vals[':lat'] = chosen!.lat; vals[':lng'] = chosen!.lng; vals[':cs'] = chosen!.source;
    if (chosen!.address) { setParts.push('address = :addr'); vals[':addr'] = chosen!.address; }
    // 高德、Google 编号只留这次定到的那个（境外的店以前错挂过高德编号）
    const [idField, staleField] = chosen!.source === 'google' ? ['googlePlaceId', 'amapPoiId'] : ['amapPoiId', 'googlePlaceId'];
    setParts.push(`${idField} = :pid`); vals[':pid'] = chosen!.id;
    removeParts.push(staleField);
  }
  if (applyCity) {
    const L = newCityLayers!;
    setParts.push('city = :city', 'locality = :loc', 'GSI1PK = :g1pk', 'GSI1SK = :g1sk');
    vals[':city'] = L.locality; vals[':loc'] = L.locality;
    vals[':g1pk'] = `CITY#${L.locality}`; vals[':g1sk'] = `REST#${existingRestaurantId}`;
    if (L.administrativeArea) { setParts.push('administrativeArea = :aa'); vals[':aa'] = L.administrativeArea; }
    if (L.subLocality) { setParts.push('subLocality = :sub'); vals[':sub'] = L.subLocality; }
  }
  if (applyCategories) { setParts.push('categories = :cats'); vals[':cats'] = newCategories; }
  // 认店代理给的依据与模型（后台核对用）
  if (analysis.reason) { setParts.push('locateReason = :lr'); vals[':lr'] = analysis.reason.slice(0, 300); }
  setParts.push('locatedBy = :lb'); vals[':lb'] = analysis.model;
  // locationHint 是认店内容字段（create 落库同款），重析非空即覆盖，防止新名/坐标配旧 hint
  if (analysis.location_hint) { setParts.push('locationHint = :lh'); vals[':lh'] = analysis.location_hint; }
  // 定位候选：这次定到位置就清掉旧候选；没定到且找到了新候选就换上
  if (applyCoord) removeParts.push('geoCandidates', 'geoCandidatesAt', 'geoReviewReason');
  else if (geoCandidates.length > 0) {
    setParts.push('geoCandidates = :gc', 'geoCandidatesAt = :gca', 'geoReviewReason = :grr');
    vals[':gc'] = geoCandidates; vals[':gca'] = now; vals[':grr'] = 'agent-uncertain';
  }
  // cityHint 与 create 口径一致：店最终仍无 city 时才写（admin 补 city 的参考线索）
  const newCityHint = (analysis.city || analysis.location_hint || '').trim();
  if (!applyCity && !oldCity && newCityHint) { setParts.push('cityHint = :chint'); vals[':chint'] = newCityHint; }
  // 防误命中：拦截标脏 + 记原因；垃圾识名（合集/错配/识别失败信号）同样标脏交 admin；
  // 干净命中新坐标且识名健康：清脏标（cityHint 只在 city 已解出时清）
  if (blocked) {
    setParts.push('needsManualReview = :nmr', 'refreshReviewReason = :rrr');
    vals[':nmr'] = true; vals[':rrr'] = blockReasons.join('; ');
  } else if (junkName) {
    setParts.push('needsManualReview = :nmr', 'refreshReviewReason = :rrr');
    vals[':nmr'] = true; vals[':rrr'] = `junk-name:${finalName || '(空)'}`;
  } else if (applyCoord) {
    removeParts.push('needsManualReview', 'refreshReviewReason');
    if (applyCity) removeParts.push('cityHint');
  }
  let restExpr = `SET ${setParts.join(', ')}`;
  if (removeParts.length > 0) restExpr += ` REMOVE ${removeParts.join(', ')}`;
  await dynamoClient.send(new UpdateCommand({
    TableName: sharedTable, Key: { PK: 'REST', SK: existingRestaurantId },
    UpdateExpression: restExpr, ExpressionAttributeValues: vals,
    ConditionExpression: 'attribute_exists(PK)',
  }));

  // ---- R6b: 覆盖每条 POST ----
  // name/三层 city/GSI4 同步全部 POST（餐厅级共享属性）；
  // dishes/推荐语/tags 只覆盖主 POST（meta.awemeId），避免多视频店互相污染。
  // GSI4SK 用 POST 原始 createdAt 保序（不是 now），与阶段2/reanalyze 口径一致。
  for (const post of posts) {
    const postId = post['SK'] as string;
    const pSet: string[] = [];
    const pVals: Record<string, unknown> = {};
    const pRemove: string[] = [];
    if (applyName) { pSet.push('restaurantName = :rn'); pVals[':rn'] = finalName; }
    if (applyCity) {
      const L = newCityLayers!;
      const createdAt = (typeof post['createdAt'] === 'string' && post['createdAt']) ? (post['createdAt'] as string) : now;
      pSet.push('city = :city', 'locality = :loc', 'GSI4PK = :g4pk', 'GSI4SK = :g4sk');
      pVals[':city'] = L.locality; pVals[':loc'] = L.locality;
      pVals[':g4pk'] = `FEEDCITY#${L.locality}`; pVals[':g4sk'] = `${createdAt}#${postId}`;
      if (L.administrativeArea) { pSet.push('administrativeArea = :aa'); pVals[':aa'] = L.administrativeArea; }
      if (L.subLocality) { pSet.push('subLocality = :sub'); pVals[':sub'] = L.subLocality; }
      pRemove.push('cityHint');
    }
    if (postId === primaryAwemeId) {
      if (applyDishes) { pSet.push('dishes = :dishes'); pVals[':dishes'] = newDishes; }
      if (applySummary) { pSet.push('influencerSummary = :sum'); pVals[':sum'] = newSummary; }
      if (applyTags) { pSet.push('tags = :tags'); pVals[':tags'] = newTags; }
    }
    if (pSet.length === 0 && pRemove.length === 0) continue; // 该 POST 无改动
    let pExpr = `SET ${pSet.join(', ')}`;
    if (pRemove.length > 0) pExpr += ` REMOVE ${pRemove.join(', ')}`;
    await dynamoClient.send(new UpdateCommand({
      TableName: sharedTable, Key: { PK: 'POST', SK: postId },
      UpdateExpression: pExpr, ExpressionAttributeValues: pVals,
      ConditionExpression: 'attribute_exists(PK)',
    }));
  }

  // ---- R6c: 城市变更 → 同步派生态 ----
  // /location 端点历史上只同步 REST/POST，这里补齐两处轻量派生态：
  //  · videos.city —— parse.ts 去重命中/GET jobs 的兜底读源（shared POST 缺失时才用到）
  //  · RI.city —— admin 达人-店映射展示
  // INFLUENCER.cities/cityPostCounts 聚合不做增量迁移（正确增减需要该达人全部店的全局视角），
  // 批量重刷若有 city 变更，批后跑 scripts/archive/backfill-feed-index.ts 全量重算。
  if (applyCity && cityChanged) {
    for (const post of posts) {
      const pid = post['SK'] as string;
      try {
        await dynamoClient.send(new UpdateCommand({
          TableName: videosTable,
          Key: { awemeId: pid },
          UpdateExpression: 'SET city = :c, updatedAt = :now',
          ConditionExpression: 'attribute_exists(awemeId)',
          ExpressionAttributeValues: { ':c': newCity, ':now': now },
        }));
      } catch (err: unknown) {
        // 没有 videos 行 → 条件失败跳过
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
    const riUids = new Set(
      posts
        .map((p) => (typeof p['influencerUid'] === 'string' ? (p['influencerUid'] as string) : ''))
        .filter(Boolean),
    );
    for (const uid of riUids) {
      try {
        await dynamoClient.send(new UpdateCommand({
          TableName: sharedTable,
          Key: { PK: 'RI', SK: `${uid}#${existingRestaurantId}` },
          UpdateExpression: 'SET city = :c',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':c': newCity },
        }));
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      }
    }
    console.log(`${tag} 派生态同步: videos.city×${posts.length} + RI.city×${riUids.size} → ${newCity}`);
  }

  detail.applied = true;
  console.log(`${tag} 已覆盖: name=${nameChanged} coord=${coordChanged} city=${cityChanged} dishes=${dishesChanged}(${detail.oldDishCount}→${detail.newDishCount}) summary=${summaryChanged} tags=${tagsChanged} | POST×${posts.length}`);
  return {
    isRestaurantReview: true, restaurantId: existingRestaurantId,
    city: newCity || oldCity, dishesCount: newDishNames.length, refresh: detail,
  };
}
