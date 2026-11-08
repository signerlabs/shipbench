/**
 * 用户认证路由
 *
 * POST /profile      — 创建/更新用户 Profile (PK=identityId, SK=PROFILE)
 * GET  /profile      — 获取当前用户 Profile
 * PUT  /profile      — 更新用户昵称（2-12 字符）
 * POST /avatar       — 上传头像（base64，JPEG/PNG，<= 2MB）
 * GET  /stats        — 获取用户统计（Profile + 导入条数 importCount）
 * GET  /my-posts     — 旧版「我的 · 推荐」：用户自建 10/22 已删，恒返回空列表
 * GET  /my-imports   — 当前用户导入过的帖子（「我的 · 我导入的」，按导入时间倒序，最多 200 条）
 * GET  /liked-posts  — 当前用户点赞过的帖子
 * POST /subscription — 同步订阅状态 (PK=identityId, SK=SUBSCRIPTION)
 * GET  /subscription — 获取当前用户订阅状态
 * DELETE /me         — 注销账号：删除个人信息 + 撤销 Apple 登录授权（需验签 JWT）
 */

import { Hono } from 'hono';
import { GetCommand, UpdateCommand, PutCommand, QueryCommand, BatchGetCommand, BatchWriteCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { identityMiddleware, getIdentity, requireWriteAuth, resolveIdentityIdByToken } from '../middleware/auth.js';
import { rejectBannedWrites } from '../middleware/ban.js';
import { writeDeletionTombstone } from '../lib/account-tombstone.js';
import { getDocClient, USERS_TABLE, SHARED_TABLE } from '../lib/dynamodb.js';
import { uploadToS3, deleteFromS3 } from '../lib/s3.js';
import { moderateText, moderateImage } from '../lib/content-moderation.js';
import { ensureAuthorId } from '../lib/author-id.js';
import { processPostsForResponse } from '../lib/post-utils.js';
import { verifySubscriptionWithApple, verifyLifetimePurchaseWithApple } from '../lib/appstore.js';
import { isLifetimeProduct, LIFETIME_PRODUCT_ID } from '../lib/iap-products.js';
import { revokeAppleAuthorization, type AppleRevokeOutcome } from '../lib/apple-signin.js';
import { IMPORT_SK_PREFIX } from '../lib/import-record.js';

/** CDN 域名，用于拼接头像公开 URL */
const CDN_DOMAIN = 'img.shopmap.example';

/** 「我导入的」最多返回条数（按导入时间倒序取最新的；importCount 不受此限） */
const MY_IMPORTS_LIMIT = 200;

export const authRoute = new Hono();

// 所有路由需要 Identity ID
authRoute.use('*', identityMiddleware);
// 写请求验签（默认软兼容放行，ENFORCE_WRITE_AUTH=true 时强制 JWT）
authRoute.use('*', requireWriteAuth);
// 被封禁的身份不能改头像 / 资料（中间件只拦写方法，GET /profile 不受影响）。
// 刻意不挂 /subscription（购买记账）与 /me（注销是法定权利），理由见 middleware/ban.ts
authRoute.use('/avatar', rejectBannedWrites);
authRoute.use('/profile', rejectBannedWrites);

// ============================================================
// POST /avatar — 上传头像
// ============================================================

authRoute.post('/avatar', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const body = await c.req.json<{
    image: string;     // base64 编码的图片数据
    mimeType?: string; // 可选，默认 image/jpeg
  }>();

  // 验证必填字段
  if (!body.image || typeof body.image !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'image（base64）为必填字符串' },
    }, 400);
  }

  // 验证 MIME 类型
  const mimeType = body.mimeType || 'image/jpeg';
  if (!['image/jpeg', 'image/png'].includes(mimeType)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: '仅支持 JPEG 和 PNG 格式' },
    }, 400);
  }

  // 解码 base64
  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(body.image, 'base64');
  } catch {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'base64 解码失败' },
    }, 400);
  }

  // 验证大小（<= 2MB）
  const MAX_SIZE = 2 * 1024 * 1024; // 2MB
  if (imageBuffer.length > MAX_SIZE) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: '图片大小不能超过 2MB' },
    }, 400);
  }

  // 上传到 S3: avatars/{authorId}/avatar-{timestamp}.jpg
  // S3 key 加时间戳，每次生成新 URL，避免 CDN 一年缓存导致换头像后返回旧图
  // P1-B 安全修复：key 不再包含 identityId（头像地址是公开 URL，旧格式等于把鉴权凭据广播出去），
  // 改用 authorId（公开代理标识）。
  // iOS 端把 avatarUrl 当完整 URL 直接加载、不解析格式，改动对端上透明。存量头像不迁移。
  const authorId = await ensureAuthorId(identityId);
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const s3Key = `avatars/${authorId}/avatar-${Date.now()}.${ext}`;
  await uploadToS3(s3Key, imageBuffer, mimeType);

  // 生成 CDN URL
  const avatarUrl = `https://${CDN_DOMAIN}/${s3Key}`;

  // 阿里云 Green 图片审核（同步，先审后发）
  try {
    const imageResult = await moderateImage(avatarUrl);
    if (!imageResult.pass) {
      // 审核不通过 → 删除已上传的 S3 文件
      await deleteFromS3(s3Key);
      console.log(`[avatar] 头像审核不通过: ${identityId.slice(-12)} labels=${imageResult.labels.join(',')}`);
      return c.json({
        error: { code: 'CONTENT_VIOLATION', message: '头像包含违规内容，请更换' },
      }, 400);
    }
  } catch (err) {
    // 审核 API 异常时不阻断上传（降级放行），但记录日志
    console.error(`[avatar] 图片审核 API 异常，降级放行: ${identityId.slice(-12)}`, err);
  }

  const now = new Date().toISOString();

  // 更新 users 表 PROFILE 的 avatarUrl
  await docClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'PROFILE' },
    UpdateExpression: 'SET avatarUrl = :url, updatedAt = :now',
    ExpressionAttributeValues: {
      ':url': avatarUrl,
      ':now': now,
    },
  }));

  console.log(`[avatar] 头像上传成功: ${identityId.slice(-12)} → ${s3Key}`);

  return c.json({ data: { avatarUrl } });
});

// ============================================================
// PUT /profile — 更新用户昵称和/或简介
// ============================================================

authRoute.put('/profile', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const body = await c.req.json<{
    nickname?: string;
    bio?: string | null;
  }>();

  // 审查 M31：「清空简介」两种表达都认——空串 "" 与显式 null 都表示清空（写成空串，
  // GET /stats 对空简介返回 null）。键缺失仍表示「本次不改简介」，老客户端行为不变。
  if (body.bio === null) body.bio = '';

  // 至少传一个字段
  if (!body.nickname && body.bio === undefined) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: '至少提供 nickname 或 bio' },
    }, 400);
  }

  // 验证 nickname（2-12 字符，可选）
  let trimmedNickname: string | undefined;
  if (body.nickname !== undefined) {
    if (typeof body.nickname !== 'string' || !body.nickname.trim()) {
      return c.json({
        error: { code: 'INVALID_INPUT', message: 'nickname 为非空字符串' },
      }, 400);
    }
    trimmedNickname = body.nickname.trim();
    if (trimmedNickname.length < 2 || trimmedNickname.length > 12) {
      return c.json({
        error: { code: 'INVALID_INPUT', message: '昵称长度需在 2-12 个字符之间' },
      }, 400);
    }
  }

  // 验证 bio（最多 50 字符，可选）
  let trimmedBio: string | undefined;
  if (body.bio !== undefined) {
    if (typeof body.bio !== 'string') {
      return c.json({
        error: { code: 'INVALID_INPUT', message: 'bio 必须为字符串' },
      }, 400);
    }
    trimmedBio = body.bio.trim();
    if (trimmedBio.length > 50) {
      return c.json({
        error: { code: 'INVALID_INPUT', message: '简介长度不能超过 50 个字符' },
      }, 400);
    }
  }

  // 阿里云 Green 文本审核（同步，先审后发）
  // 将 nickname 和 bio 合并审核，减少 API 调用次数
  const textsToModerate: string[] = [];
  if (trimmedNickname) textsToModerate.push(trimmedNickname);
  if (trimmedBio) textsToModerate.push(trimmedBio);

  if (textsToModerate.length > 0) {
    try {
      const textResult = await moderateText(textsToModerate.join(' '));
      if (!textResult.pass) {
        console.log(`[profile] 内容审核不通过: ${identityId.slice(-12)} labels=${textResult.labels.join(',')}`);
        return c.json({
          error: { code: 'CONTENT_VIOLATION', message: '内容包含违规信息，请修改' },
        }, 400);
      }
    } catch (err) {
      // 审核 API 异常时不阻断（降级放行），但记录日志
      console.error(`[profile] 文本审核 API 异常，降级放行: ${identityId.slice(-12)}`, err);
    }
  }

  const now = new Date().toISOString();

  // 动态构建 UpdateExpression，只更新传入的字段
  const setParts: string[] = ['updatedAt = :now'];
  const exprValues: Record<string, unknown> = { ':now': now };

  if (trimmedNickname !== undefined) {
    setParts.push('nickname = :name');
    exprValues[':name'] = trimmedNickname;
  }
  if (trimmedBio !== undefined) {
    setParts.push('bio = :bio');
    exprValues[':bio'] = trimmedBio;
  }

  // 更新 users 表 PROFILE
  await docClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'PROFILE' },
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeValues: exprValues,
  }));

  const updates: string[] = [];
  if (trimmedNickname !== undefined) updates.push(`nickname="${trimmedNickname}"`);
  if (trimmedBio !== undefined) updates.push(`bio="${trimmedBio}"`);
  console.log(`[profile] 更新: ${identityId.slice(-12)} → ${updates.join(', ')}`);

  return c.json({ data: { success: true } });
});

// ============================================================
// POST /profile — 创建/更新用户 Profile
// ============================================================

authRoute.post('/profile', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const body = await c.req.json<{
    cognitoSub: string;
    email?: string;
    displayName?: string;
    provider: string;
  }>();

  // 验证必填字段
  if (!body.cognitoSub || typeof body.cognitoSub !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'cognitoSub 为必填字符串' },
    }, 400);
  }
  if (!body.provider || typeof body.provider !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'provider 为必填字符串' },
    }, 400);
  }

  const now = new Date().toISOString();

  await docClient.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'PROFILE' },
    UpdateExpression:
      'SET identityId = :id, cognitoSub = :sub, email = :email, displayName = :name, provider = :provider, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
    ExpressionAttributeValues: {
      ':id': identityId,
      ':sub': body.cognitoSub,
      ':email': body.email || null,
      ':name': body.displayName || null,
      ':provider': body.provider,
      ':now': now,
    },
  }));

  // 建档时生成（或读取已有的）authorId：对外代理编号，头像对象路径用它，不暴露 identityId
  const authorId = await ensureAuthorId(identityId);

  // 返回 authorId 给 iOS：前端可用它判断「列表里这条内容是不是我发的」（与公开响应的 authorId 比对）
  return c.json({ data: { success: true, authorId } });
});

// ============================================================
// GET /profile — 获取当前用户 Profile
// ============================================================

authRoute.get('/profile', async (c) => {
  const identity = getIdentity(c);
  const { identityId, cognitoSub } = identity;
  const docClient = getDocClient();

  const result = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'PROFILE' },
  }));

  // 2026-10-19：只带 x-identity-id 请求头（没有验签通过的 JWT）的请求不下发登录带来的个人信息。
  // 匿名请求信任请求头，知道别人的 identityId 就能读他的资料——email、Apple 实名（displayName）、
  // 登录 sub 只给本人验签请求。iOS（含线上 1.2.8）不调用本接口，收紧无客户端影响。
  let profile = result.Item || null;
  if (profile && !cognitoSub) {
    const { email: _email, displayName: _displayName, cognitoSub: _sub, ...rest } = profile;
    profile = rest;
  }

  return c.json({ data: { profile } });
});

// ============================================================
// GET /stats — 获取用户统计
// ============================================================

authRoute.get('/stats', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  // 并行读取 PROFILE 与导入条数
  const [profileResult, importCount] = await Promise.all([
    docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: 'PROFILE' },
    })),
    countMyImports(docClient, identityId),
  ]);

  const profile = profileResult.Item;

  return c.json({
    data: {
      authorId: (profile?.['authorId'] as string) || null,
      nickname: (profile?.['nickname'] as string) || (profile?.['displayName'] as string) || null,
      avatarUrl: (profile?.['avatarUrl'] as string) || null,
      bio: (profile?.['bio'] as string) || null,
      // 被关注数、贡献数只有用户自建作者才有（10/22 已删）；1.2.8 和现版 iOS 都按非可选 Int 解码，恒回 0
      totalFollowers: 0,
      contributionCount: 0,
      // 我导入的条数（2026-10-19）：与 GET /my-imports 同一口径（IMPORT# 行里帖子还在、没被下架的），
      // 不受列表 200 条上限影响
      importCount,
    },
  });
});

// ============================================================
// GET /my-posts — 旧版「我的 · 推荐」：用户自建 10/19 停用、10/22 数据已彻底删除
// 1.2.8 这页还在调，恒返回空列表（报错会让旧版这页显示失败）
// ============================================================

authRoute.get('/my-posts', (c) => c.json({ data: [] }));

// ============================================================
// GET /my-imports — 当前用户导入过的帖子（「我的 · 我导入的」）
// ============================================================
//
// 2026-10-19：用户自建下线后加店只靠导入，「我的」页原「推荐」子页（/my-posts）改成「我导入的」。
// 鉴权与 /liked-posts 相同（只要身份头）；返回结构与 /liked-posts 完全相同（同一个帖子数组，
// 同样经 processPostsForResponse 安全管线），liked 按本人真实点赞状态。
// 数据只认 users 表 IMPORT#<awemeId> 行（写入时机见 lib/import-record.ts），不依赖有 30 天 TTL 的 JOB# 行；
// 按导入时间倒序，最多 MY_IMPORTS_LIMIT 条；帖子已不存在或被下架的跳过（跳过后从更早的导入补足）。

authRoute.get('/my-imports', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const rows = await queryMyImportRows(docClient, identityId);
  if (rows.length === 0) {
    return c.json({ data: [] });
  }

  const posts = await fetchVisibleImportPosts(docClient, rows, { limit: MY_IMPORTS_LIMIT });

  // 安全管线处理（顺序不变：仍是导入时间倒序）
  const processed = await processPostsForResponse(posts, identityId);

  return c.json({ data: processed });
});

// ============================================================
// GET /liked-posts — 当前用户点赞过的帖子
// ============================================================

authRoute.get('/liked-posts', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  // 1. 查询用户的所有 LIKE# 实体
  const likeResult = await docClient.send(new QueryCommand({
    TableName: USERS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': identityId,
      ':prefix': 'LIKE#',
    },
  }));

  const likeItems = likeResult.Items || [];
  if (likeItems.length === 0) {
    return c.json({ data: [] });
  }

  // 2. 提取帖子编号，BatchGet 帖子实体
  // LIKE# SK 有两种：LIKE#<awemeId>（现行）与 LIKE#POST#<awemeId>（旧格式）；帖子 SK 都是裸 awemeId
  const allCandidateIds = [...new Set(likeItems.map((item) => (item['SK'] as string).replace(/^LIKE#(POST#)?/, '')))];

  const allPosts: Record<string, unknown>[] = [];
  const BATCH_SIZE = 100;
  const seenSKs = new Set<string>();

  for (let i = 0; i < allCandidateIds.length; i += BATCH_SIZE) {
    const batch = allCandidateIds.slice(i, i + BATCH_SIZE);
    let keys = batch.map((id) => ({ PK: 'POST' as const, SK: id }));
    while (keys.length > 0) {
      const res = await docClient.send(new BatchGetCommand({
        RequestItems: { [SHARED_TABLE]: { Keys: keys } },
      }));
      for (const item of res.Responses?.[SHARED_TABLE] ?? []) {
        const sk = item['SK'] as string;
        if (!seenSKs.has(sk)) {
          seenSKs.add(sk);
          allPosts.push(item);
        }
      }
      const unprocessed = res.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
      keys = (unprocessed && unprocessed.length > 0) ? unprocessed as typeof keys : [];
    }
  }

  // 3. 过滤掉缺 restaurantId 等必需字段的帖子（iOS 解码会失败）
  const validPosts = allPosts.filter((p) => p['restaurantId']);

  // 4. 安全管线处理 + 标记 liked=true
  const processed = await processPostsForResponse(validPosts, identityId);
  const withLiked = processed.map((p) => ({ ...p, liked: true }));

  return c.json({ data: withLiked });
});

// ============================================================
// POST /subscription — 同步订阅状态
// ============================================================
//
// P0-2 安全修复：active 写入不再信任客户端自声明，必须带 originalTransactionId
// 并通过 Apple 服务端反查验证（verifySubscriptionWithApple）：
//   - 交易真实存在 + bundleId 匹配 + 订阅当前有效，expiresDate/productId 以 Apple 返回为准
//   - 查无此单 / 订阅无效 → 403 SUBSCRIPTION_VERIFICATION_FAILED
//   - Apple API 异常 / IAP 密钥未配置 → 503 fail-closed，绝不静默放行
//   - TXID 映射条件写：一个 originalTransactionId 只允许绑定一个 identityId（一单多绑防护）
//
// 防降级闸（2026-07-04 事故修复）：原假设「status='expired' 降级无害放行不验」被推翻——
// 旧版客户端 StoreKit 空结果误报 expired，把 6 位有效会员的 active 覆盖成脏数据。
// 现有行 active 且未到期时，降级声明必须经 Apple 反查确认（真退款/真过期才放行）；
// 误报则忽略并返回 200（旧版客户端视为已同步不再重试，DB 保持正确的 active）。
//
// 永久会员（2026-10-19，productId = com.example.shopmap.lifetime.68，非消耗型）：
//   - active 改用 Get Transaction Info 反查（按 transactionId，缺省用 originalTransactionId）：
//     商品 ID 对、无 revocationDate 才写；行上不写 expiresDate，打 lifetime: true
//   - 永久档的行不接受客户端 expired 声明降级（没有到期一说；退款由 RC / Apple 通知收回）
//   - 订阅档的 active 同步不覆盖永久档的行（用户先订阅后买断，StoreKit 两份权益都在）
//
// 竞态（审查 HIGH 7）：防降级闸是「先读后写」，读与写之间 webhook 可能刚把行续成 active。
// 现在 expired 写入带乐观锁条件（行的 updatedAt 与闸读到的一致才写），被抢先更新则放弃本次
// 降级、返回 200 ignored=CONCURRENT_UPDATE——更新的写者（webhook）信息更新，让它说了算。

authRoute.post('/subscription', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const body = await c.req.json<{
    productId: string;
    status: string;
    originalTransactionId?: string;
    transactionId?: string;
    expiresDate?: number; // ms timestamp
  }>();

  if (!body.productId || typeof body.productId !== 'string') {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'productId 为必填字符串' },
    }, 400);
  }
  if (!body.status || !['active', 'expired'].includes(body.status)) {
    return c.json({
      error: { code: 'INVALID_INPUT', message: 'status 必须为 active 或 expired' },
    }, 400);
  }

  const now = new Date().toISOString();
  const lifetimeClaim = isLifetimeProduct(body.productId);

  // ---- active 写入：Apple 服务端反查验证 ----
  // 验证通过后 productId / expiresDate 以 Apple 返回为准（不信客户端）
  let verifiedProductId: string | undefined;
  let verifiedExpiresDate: number | undefined;
  // 行上与 TXID 映射记录的交易号：订阅沿用客户端上报值（已经 Apple 反查过）；永久会员以 Apple 返回为准
  let originalTxToRecord = body.originalTransactionId;
  let transactionIdToRecord = body.transactionId;

  if (body.status === 'active' && lifetimeClaim) {
    const lookupId = body.transactionId || body.originalTransactionId;
    if (!lookupId) {
      console.warn(`[subscription] 403 永久会员 active 写入缺少交易号 | identityId=${identityId.slice(-12)}`);
      return c.json({
        error: { code: 'SUBSCRIPTION_VERIFICATION_FAILED', message: '订阅验证失败：缺少交易凭证，请升级 App 后重试' },
      }, 403);
    }

    let lifetimeResult;
    try {
      lifetimeResult = await verifyLifetimePurchaseWithApple(lookupId);
    } catch (err) {
      console.error(
        `[subscription] Apple 永久会员反查异常（fail-closed 503）| identityId=${identityId.slice(-12)} | txid=${lookupId}`,
        err,
      );
      return c.json({
        error: { code: 'SUBSCRIPTION_VERIFICATION_UNAVAILABLE', message: '订阅验证服务暂时不可用，请稍后重试' },
      }, 503);
    }

    if (!lifetimeResult.verified) {
      console.warn(
        `[subscription] 403 Apple 永久会员反查未通过 | reason=${lifetimeResult.reason} | env=${lifetimeResult.environment} | identityId=${identityId.slice(-12)} | txid=${lookupId}`,
      );
      return c.json({
        error: { code: 'SUBSCRIPTION_VERIFICATION_FAILED', message: '订阅验证失败' },
      }, 403);
    }
    if (lifetimeResult.environment === 'Sandbox') {
      console.log(`[subscription] Sandbox 环境永久会员验证通过 | identityId=${identityId.slice(-12)} | txid=${lookupId}`);
    }

    verifiedProductId = LIFETIME_PRODUCT_ID;
    originalTxToRecord = lifetimeResult.originalTransactionId || lookupId;
    transactionIdToRecord = lifetimeResult.transactionId || body.transactionId;
  } else if (body.status === 'active') {
    if (!body.originalTransactionId) {
      // 老版本客户端不带 originalTransactionId 的新购买会命中此分支（产品负责人已接受的权衡）
      console.warn(`[subscription] 403 active 写入缺少 originalTransactionId | identityId=${identityId.slice(-12)}`);
      return c.json({
        error: { code: 'SUBSCRIPTION_VERIFICATION_FAILED', message: '订阅验证失败：缺少交易凭证，请升级 App 后重试' },
      }, 403);
    }

    let verifyResult;
    try {
      verifyResult = await verifySubscriptionWithApple(body.originalTransactionId);
    } catch (err) {
      // Apple API 不可用 / IAP 密钥未配置 → fail-closed，让客户端重试，绝不放行
      console.error(
        `[subscription] Apple 订阅反查异常（fail-closed 503）| identityId=${identityId.slice(-12)} | otxid=${body.originalTransactionId}`,
        err,
      );
      return c.json({
        error: { code: 'SUBSCRIPTION_VERIFICATION_UNAVAILABLE', message: '订阅验证服务暂时不可用，请稍后重试' },
      }, 503);
    }

    if (!verifyResult.verified) {
      console.warn(
        `[subscription] 403 Apple 订阅反查未通过 | reason=${verifyResult.reason} | env=${verifyResult.environment} | identityId=${identityId.slice(-12)} | otxid=${body.originalTransactionId}`,
      );
      return c.json({
        error: { code: 'SUBSCRIPTION_VERIFICATION_FAILED', message: '订阅验证失败' },
      }, 403);
    }

    if (verifyResult.environment === 'Sandbox') {
      // Sandbox 命中也算验证通过（TestFlight/审核机场景），日志标注便于区分
      console.log(`[subscription] Sandbox 环境订阅验证通过 | identityId=${identityId.slice(-12)} | otxid=${body.originalTransactionId}`);
    }

    verifiedProductId = verifyResult.productId;
    verifiedExpiresDate = verifyResult.expiresDate;
  }

  // ---- expired 写入：防降级闸（见头注释，2026-07-04 事故修复）----
  // 闸读到的行状态留给最终写入做乐观锁（审查 HIGH 7）；强一致读，避免拿到旧 updatedAt 误判冲突
  let observedRow: { exists: boolean; updatedAt?: string } | undefined;
  if (body.status === 'expired') {
    const existing = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: 'SUBSCRIPTION' },
      ProjectionExpression: '#s, expiresDate, originalTransactionId, lifetime, updatedAt',
      ExpressionAttributeNames: { '#s': 'status' },
      ConsistentRead: true,
    }));
    const cur = existing.Item;
    observedRow = {
      exists: !!cur,
      updatedAt: typeof cur?.['updatedAt'] === 'string' ? (cur['updatedAt'] as string) : undefined,
    };
    const curActive = cur?.['status'] === 'active';

    // 永久会员：没有到期一说，客户端 expired 声明一律不降级（退款由 RC / Apple 通知收回）。
    // 必须先于下方的订阅闸：永久档行没有 expiresDate 会进闸，而订阅反查查不到非消耗型交易，
    // 会被当成「Apple 确认已无权益」放行降级
    if (curActive && cur?.['lifetime'] === true) {
      console.warn(`[subscription] 拦截降级：永久会员不接受 expired 声明 | identityId=${identityId.slice(-12)}`);
      return c.json({ data: { success: true, ignored: 'DOWNGRADE_REJECTED_LIFETIME' } });
    }

    // S3 修复（张居正审核）：expiresDate 缺失的 active 行（存量 43 条历史数据）同样进闸——
    // 缺字段不代表已过期，交 Apple 反查权威判定；仅「有到期日且确已过期」的 active 行放行正常降级
    const curExpires = typeof cur?.['expiresDate'] === 'number' ? (cur['expiresDate'] as number) : null;

    if (curActive && (curExpires === null || curExpires > Date.now())) {
      // 现有权益 active 且未到期，降级声明可疑——以 Apple 为准
      const otx = (cur?.['originalTransactionId'] as string | undefined) ?? body.originalTransactionId;
      if (!otx) {
        // 无凭证可反查 → 不降级（真到期/退款由 App Store Server Notifications 权威降级）
        console.warn(`[subscription] 拦截无凭证降级（现有 active 未到期）| identityId=${identityId.slice(-12)}`);
        return c.json({ data: { success: true, ignored: 'DOWNGRADE_REJECTED_NO_PROOF' } });
      }
      try {
        const verify = await verifySubscriptionWithApple(otx);
        if (verify.verified) {
          // Apple 确认订阅仍有效 → 客户端误报，拒绝降级、静默成功
          console.warn(`[subscription] 拦截误报降级：Apple 确认订阅仍有效 | identityId=${identityId.slice(-12)} | otxid=${otx}`);
          return c.json({ data: { success: true, ignored: 'DOWNGRADE_REJECTED_STILL_ACTIVE' } });
        }
        // Apple 确认已无权益（退款/真过期）→ 放行降级
        console.log(`[subscription] 降级经 Apple 确认放行 | reason=${verify.reason} | identityId=${identityId.slice(-12)}`);
      } catch (err) {
        // Apple 反查异常 → fail-safe：保持 active 不降级（与 active 的 fail-closed 方向一致：保护真实付费状态）
        console.error(`[subscription] 降级反查异常，保持 active 不降级 | identityId=${identityId.slice(-12)}`, err);
        return c.json({ data: { success: true, ignored: 'DOWNGRADE_DEFERRED_VERIFY_UNAVAILABLE' } });
      }
    }
  }

  // ---- 一单多绑防护：TXID 映射条件写（先于 SUBSCRIPTION 行写入，作为绑定闸门）----
  // 映射用于 App Store Server Notifications V2 通过 originalTransactionId 反查用户，
  // 条件 attribute_not_exists(PK) OR identityId = :id 保证一个交易只绑一个 identityId。
  if (originalTxToRecord) {
    try {
      await docClient.send(new PutCommand({
        TableName: USERS_TABLE,
        Item: {
          PK: `TXID#${originalTxToRecord}`,
          SK: 'MAPPING',
          identityId,
          productId: verifiedProductId ?? body.productId,
          createdAt: now,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR identityId = :id',
        ExpressionAttributeValues: { ':id': identityId },
      }));
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
      // 该交易已绑定其他 identityId
      if (body.status === 'active') {
        console.warn(
          `[subscription] 403 originalTransactionId 已绑定其他用户 | identityId=${identityId.slice(-12)} | otxid=${originalTxToRecord}`,
        );
        return c.json({
          error: { code: 'TRANSACTION_ALREADY_BOUND', message: '该订阅凭证已绑定其他账号' },
        }, 403);
      }
      // expired 写入：不覆盖他人映射，跳过映射写入，仍允许写自己的 expired 行（降级无害）
      console.warn(
        `[subscription] expired 写入命中他人 TXID 映射，跳过映射写入 | identityId=${identityId.slice(-12)} | otxid=${originalTxToRecord}`,
      );
    }
  }

  // ---- 写 SUBSCRIPTION 行（active 时 productId/expiresDate 以 Apple 返回为准）----
  const expressionParts = [
    'identityId = :id',
    'productId = :pid',
    '#status = :status',
    'updatedAt = :now',
    'createdAt = if_not_exists(createdAt, :now)',
  ];
  const removeParts: string[] = [];
  const attrValues: Record<string, unknown> = {
    ':id': identityId,
    ':pid': verifiedProductId ?? body.productId,
    ':status': body.status,
    ':now': now,
  };

  if (originalTxToRecord) {
    expressionParts.push('originalTransactionId = :otxid');
    attrValues[':otxid'] = originalTxToRecord;
  }
  if (transactionIdToRecord) {
    expressionParts.push('transactionId = :txid');
    attrValues[':txid'] = transactionIdToRecord;
  }

  if (body.status === 'active' && lifetimeClaim) {
    // 永久会员：打 lifetime 标记，清掉到期日（残留订阅的到期戳会让防降级闸误放行）
    expressionParts.push('lifetime = :lifetime');
    attrValues[':lifetime'] = true;
    removeParts.push('expiresDate');
  } else {
    // active：只写 Apple 返回的 expiresDate（客户端值不落库）；expired：沿用客户端值（无权益语义）
    const expiresDateToWrite = body.status === 'active' ? verifiedExpiresDate : body.expiresDate;
    if (expiresDateToWrite !== undefined) {
      expressionParts.push('expiresDate = :exp');
      attrValues[':exp'] = expiresDateToWrite;
    }
  }

  // 条件写：expired 走乐观锁（行与闸读到的一致）；订阅 active 不覆盖永久会员行
  let conditionExpression: string | undefined;
  let ignoredOnConflict = '';
  if (body.status === 'expired' && observedRow) {
    if (!observedRow.exists) {
      conditionExpression = 'attribute_not_exists(PK)';
    } else if (observedRow.updatedAt) {
      conditionExpression = 'updatedAt = :observedAt';
      attrValues[':observedAt'] = observedRow.updatedAt;
    } else {
      conditionExpression = 'attribute_not_exists(updatedAt)';
    }
    ignoredOnConflict = 'CONCURRENT_UPDATE';
  } else if (body.status === 'active' && !lifetimeClaim) {
    conditionExpression = 'attribute_not_exists(lifetime) OR lifetime <> :lifetimeTrue';
    attrValues[':lifetimeTrue'] = true;
    ignoredOnConflict = 'LIFETIME_ROW_PROTECTED';
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: 'SUBSCRIPTION' },
      UpdateExpression: `SET ${expressionParts.join(', ')}` + (removeParts.length ? ` REMOVE ${removeParts.join(', ')}` : ''),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: attrValues,
      ...(conditionExpression && { ConditionExpression: conditionExpression }),
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException' && ignoredOnConflict) {
      console.warn(`[subscription] 条件写未通过，放弃本次同步 | ignored=${ignoredOnConflict} | status=${body.status} | identityId=${identityId.slice(-12)}`);
      return c.json({ data: { success: true, ignored: ignoredOnConflict } });
    }
    throw err;
  }

  return c.json({ data: { success: true } });
});

// ============================================================
// GET /subscription — 获取当前用户订阅状态
// ============================================================

authRoute.get('/subscription', async (c) => {
  const identity = getIdentity(c);
  const { identityId } = identity;
  const docClient = getDocClient();

  const result = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'SUBSCRIPTION' },
  }));

  return c.json({ data: { subscription: result.Item || null } });
});

// ============================================================
// DELETE /me — 注销账号（个人信息删除）
// ============================================================

/**
 * 注销口径（2026-09-16 定；10-22 用户自建内容彻底删除后，不再有要匿名化的公开内容）：**删除个人信息**，
 * 满足《个人信息保护法》第 47 条的删除义务。导入的帖子署名是原视频博主，不动。
 *
 * 两段：0. 只读收集（无副作用，任何失败都不留痕）；1. 删个人信息。
 * 全流程幂等，失败回 500，客户端重试安全。
 */
authRoute.delete('/me', async (c) => {
  const identity = getIdentity(c);
  const { identityId, cognitoSub } = identity;
  const docClient = getDocClient();

  // 闸 1：必须持验签 JWT。**不跟随** ENFORCE_WRITE_AUTH 软兼容开关。
  if (!cognitoSub) {
    return c.json({
      error: { code: 'AUTH_REQUIRED', message: '请先登录后再注销账号' },
    }, 401);
  }

  // 闸 2：**每次**都向 Identity Pool 求证这张 JWT 真正拥有这个 identityId。
  // identityMiddleware 的绑定校验只在首次建绑定时求证；这里是不可逆操作，
  // 不依赖任何历史绑定状态，单独再证一次。
  const idToken = (c.req.header('Authorization') ?? '').slice(7);
  let owner: string | null;
  try {
    owner = await resolveIdentityIdByToken(idToken);
  } catch (err) {
    console.error(`[auth] 注销前归属校验异常，拒绝执行 | identityId=${identityId.slice(-12)}`, err);
    return c.json({
      error: { code: 'IDENTITY_VERIFICATION_UNAVAILABLE', message: '身份校验暂时不可用，请稍后重试' },
    }, 503);
  }
  if (owner !== identityId) {
    console.warn(
      `[auth] 注销被拒：token 归属与请求身份不符 | 请求=${identityId.slice(-12)} | 归属=${owner ? owner.slice(-12) : 'null'}`,
    );
    return c.json({
      error: { code: 'IDENTITY_MISMATCH', message: '身份凭证与 Identity ID 不匹配' },
    }, 403);
  }

  // 撤销 Apple 登录授权用的一次性 authorizationCode（App Store 审核指南 5.1.1(v)）：
  // iOS 删号前用原生 Sign in with Apple 重新授权拿到，随请求体上送。可选——没带（老版本 /
  // 非 Apple 登录）或撤销失败都不阻断删号，只打日志。线上 1.2.8 的 DELETE 不带请求体
  const deleteBody = (await c.req.json().catch(() => null)) as { appleAuthorizationCode?: unknown } | null;
  const appleCode = typeof deleteBody?.appleAuthorizationCode === 'string'
    && deleteBody.appleAuthorizationCode.trim()
    && deleteBody.appleAuthorizationCode.length <= 4096
    ? deleteBody.appleAuthorizationCode.trim()
    : undefined;

  const now = new Date().toISOString();

  try {
    // ================= 阶段 0：只读收集 =================

    const [profileRes, subRes] = await Promise.all([
      docClient.send(new GetCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: 'PROFILE' },
        ProjectionExpression: 'authorId, avatarUrl',
      })),
      docClient.send(new GetCommand({
        TableName: USERS_TABLE,
        Key: { PK: identityId, SK: 'SUBSCRIPTION' },
        ProjectionExpression: 'originalTransactionId',
      })),
    ]);
    const authorId = profileRes.Item?.['authorId'] as string | undefined;
    const avatarUrl = profileRes.Item?.['avatarUrl'] as string | undefined;
    const otx = subRes.Item?.['originalTransactionId'] as string | undefined;

    // ================= 撤销 Apple 登录授权（尽力而为）=================
    // 放在只读收集之后、删除之前（与另一个项目同序）：阶段 0 失败时 code 未被消耗，客户端可带同一个
    // code 重试；撤销后删除若失败，只是用户下次 Apple 登录要重新授权，账号本身仍完整可用。
    // revokeAppleAuthorization 自带超时、绝不抛错。
    let appleRevoke: AppleRevokeOutcome = 'skipped';
    if (appleCode) {
      appleRevoke = await revokeAppleAuthorization(appleCode);
      if (appleRevoke === 'revoked') {
        console.log(`[auth] 注销：Apple 登录授权已撤销 | identityId=${identityId.slice(-12)}`);
      } else {
        console.warn(`[auth] 注销：Apple 登录授权撤销失败（不阻断删号）| identityId=${identityId.slice(-12)}`);
      }
    } else {
      console.warn(`[auth] 注销：请求未带 appleAuthorizationCode，跳过 Apple 授权撤销 | identityId=${identityId.slice(-12)}`);
    }

    // ================= 阶段 1：删除个人信息 =================

    // 1a. 墓碑**先写**：此后 RevenueCat 仍会按这个 identityId 发续订事件，
    //     webhook 据此拒写，避免把订阅行凭空复活（见 lib/account-tombstone.ts）
    await writeDeletionTombstone(identityId, now);

    // 1b. users 表 PK=identityId 的全部行
    //     PROFILE / SUBSCRIPTION / REST# / INFLUENCER# / LIKE# / TASTE# / REPORT# / REC# / JOB# / IMPORT# / RATELIMIT#
    //     （TASTE# 删掉后 Stream 计数 Lambda 会把店上的好吃 / 不好吃人数减回去）
    let deletedRows = 0;
    let rowsLastKey: Record<string, unknown> | undefined;
    do {
      const rows = await docClient.send(new QueryCommand({
        TableName: USERS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': identityId },
        ProjectionExpression: 'PK, SK',
        ...(rowsLastKey && { ExclusiveStartKey: rowsLastKey }),
      }));
      const items = rows.Items || [];
      for (let i = 0; i < items.length; i += 25) {
        let requests = items.slice(i, i + 25).map((it) => ({
          DeleteRequest: { Key: { PK: it['PK'], SK: it['SK'] } },
        }));
        while (requests.length > 0) {
          const res = await docClient.send(new BatchWriteCommand({
            RequestItems: { [USERS_TABLE]: requests },
          }));
          const unprocessed = (res.UnprocessedItems?.[USERS_TABLE] || []) as typeof requests;
          deletedRows += requests.length - unprocessed.length;
          requests = unprocessed;
        }
      }
      rowsLastKey = rows.LastEvaluatedKey;
    } while (rowsLastKey);

    // 1c. 三条以其他 PK 存储、却能反推回本人的映射——只删 PK=identityId 的行会漏掉它们：
    //   · COGNITO#<sub>  → identityId：登录身份与数据的关联
    //   · AUTHOR#<authorId> → identityId：公开 authorId 反查原账号（「匿名化」形同虚设）
    //   · TXID#<otx> → identityId：不删的话 Apple 每次续订经 /webhooks/appstore 把订阅行写回；
    //     且付费用户注销后用同一 Apple ID 重新注册，新身份会被一单多绑挡成 403，永远拿不回会员
    const mappingDeletes: Promise<unknown>[] = [
      docClient.send(new DeleteCommand({
        TableName: USERS_TABLE,
        Key: { PK: `COGNITO#${cognitoSub}`, SK: 'BINDING' },
      })),
    ];
    if (authorId) {
      mappingDeletes.push(docClient.send(new DeleteCommand({
        TableName: USERS_TABLE,
        Key: { PK: `AUTHOR#${authorId}`, SK: 'MAPPING' },
        // 仅当映射确实指向本人才删，防止脏 authorId 误删他人映射
        ConditionExpression: 'identityId = :me',
        ExpressionAttributeValues: { ':me': identityId },
      })).catch(ignoreConditionalFailure));
    }
    if (otx) {
      mappingDeletes.push(docClient.send(new DeleteCommand({
        TableName: USERS_TABLE,
        Key: { PK: `TXID#${otx}`, SK: 'MAPPING' },
        // **必须条件删**：originalTransactionId 是客户端上报的，可能是认领来的他人 otx；
        // 映射若已随 TRANSFER 转给别人，也绝不能删
        ConditionExpression: 'identityId = :me',
        ExpressionAttributeValues: { ':me': identityId },
      })).catch(ignoreConditionalFailure));
    }
    await Promise.all(mappingDeletes);

    // 1d. 头像 S3 对象：清空 avatarUrl 字段不等于删了人脸照，CDN 上仍可长期直取。
    //     只删本服务上传到头像目录的对象，外部 URL（如抖音头像）不碰
    const avatarKey = avatarS3KeyFromUrl(avatarUrl);
    if (avatarKey) {
      try {
        await deleteFromS3(avatarKey);
      } catch (err) {
        // 头像删失败不阻断注销（个人信息主体已删），记日志交人工补删
        console.error(`[auth] 注销时删除头像失败，需人工补删 | key=${avatarKey}`, err);
      }
    }

    console.log(
      `[auth] 账号注销完成 | identityId=${identityId.slice(-12)}` +
      ` | 删除 ${deletedRows} 行` +
      ` | 映射清理 authorId=${!!authorId} otx=${!!otx} | 头像=${!!avatarKey} | Apple 授权=${appleRevoke}`,
    );
    return c.json({ data: { success: true, deletedRows, appleRevoke } });
  } catch (err) {
    // 不吞异常：客户端必须知道没删成，绝不能提示「已删除」。全流程幂等，重试安全。
    console.error(`[auth] 账号注销失败 | identityId=${identityId.slice(-12)}`, err);
    return c.json({
      error: { code: 'DELETE_ACCOUNT_FAILED', message: '注销失败，请稍后重试' },
    }, 500);
  }
});

/** 条件写/删失败（目标不存在或不属于本人）视为正常跳过，其余异常继续抛 */
function ignoreConditionalFailure(err: unknown): void {
  if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
}

/**
 * 从头像 CDN URL 解析出本服务管理的 S3 key。只认 img.shopmap.example 下 avatars/ 前缀，
 * 其余（外部 URL、非头像目录）一律返回 null，绝不去删不属于头像的对象。
 */
function avatarS3KeyFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== CDN_DOMAIN) return null;
    const key = u.pathname.replace(/^\/+/, '');
    return key.startsWith('avatars/') ? key : null;
  } catch {
    return null;
  }
}

// ============================================================
// 「我导入的」读取（GET /my-imports 与 GET /stats 的 importCount 共用，口径一致）
// ============================================================

/** 一条导入记录（users 表 IMPORT#<awemeId> 行） */
interface ImportRow {
  awemeId: string;
  importedAt: string;
}

/** 本人全部导入记录，按导入时间倒序（同一时刻按 awemeId 倒序，保证顺序稳定） */
async function queryMyImportRows(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: USERS_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': identityId, ':prefix': IMPORT_SK_PREFIX },
      ProjectionExpression: 'SK, awemeId, importedAt',
      ...(lastKey && { ExclusiveStartKey: lastKey }),
    }));
    for (const item of res.Items || []) {
      const awemeId = (item['awemeId'] as string | undefined) || (item['SK'] as string).slice(IMPORT_SK_PREFIX.length);
      if (!awemeId) continue;
      rows.push({ awemeId, importedAt: typeof item['importedAt'] === 'string' ? item['importedAt'] : '' });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  // SK 按 awemeId 排序，不是导入顺序——全部读出后在内存里按导入时间排
  rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt) || b.awemeId.localeCompare(a.awemeId));
  return rows;
}

/**
 * 导入帖是否还能展示：帖子已不存在（含没有 restaurantId 的空壳）或被下架（contentStatus 不是 approved）的跳过。
 * 与首页 Feed 的可见口径一致；导入帖的 recommendedBy 就是导入者，不能交给 processPostsForResponse
 * 的「作者本人可见自己未过审的帖」放行——被下架的导入帖对导入者也不再展示。
 */
function isVisibleImportPost(post: Record<string, unknown>): boolean {
  if (!post['restaurantId']) return false;
  const status = post['contentStatus'] as string | undefined;
  return !status || status === 'approved';
}

/**
 * 按导入顺序分批 BatchGet 导入帖（导入帖 POST 的 SK 就是 awemeId），跳过不能展示的。
 * 带 limit 时凑够即停：列表只要最新 MY_IMPORTS_LIMIT 条，被跳过的由更早的导入补足。
 * projection 只给计数用（不需要帖子全字段），必须含 SK、restaurantId、contentStatus。
 */
async function fetchVisibleImportPosts(
  docClient: ReturnType<typeof getDocClient>,
  rows: ImportRow[],
  options: { limit?: number; projection?: string } = {},
): Promise<Record<string, unknown>[]> {
  const { limit = Infinity, projection } = options;
  const visible: Record<string, unknown>[] = [];
  const BATCH_SIZE = 100;

  for (let i = 0; i < rows.length && visible.length < limit; i += BATCH_SIZE) {
    const batchIds = rows.slice(i, i + BATCH_SIZE).map((r) => r.awemeId);
    const found = new Map<string, Record<string, unknown>>();
    let keys = batchIds.map((id) => ({ PK: 'POST' as const, SK: id }));
    while (keys.length > 0) {
      const res = await docClient.send(new BatchGetCommand({
        RequestItems: { [SHARED_TABLE]: { Keys: keys, ...(projection && { ProjectionExpression: projection }) } },
      }));
      for (const item of res.Responses?.[SHARED_TABLE] ?? []) {
        found.set(item['SK'] as string, item);
      }
      const unprocessed = res.UnprocessedKeys?.[SHARED_TABLE]?.Keys;
      keys = (unprocessed && unprocessed.length > 0) ? unprocessed as typeof keys : [];
    }

    // BatchGet 不保证返回顺序，按导入顺序取回
    for (const id of batchIds) {
      const post = found.get(id);
      if (!post || !isVisibleImportPost(post)) continue;
      visible.push(post);
      if (visible.length >= limit) break;
    }
  }

  return visible;
}

/** 我导入的条数：与 GET /my-imports 同一口径（能展示的导入帖），但不受 200 条上限影响 */
async function countMyImports(
  docClient: ReturnType<typeof getDocClient>,
  identityId: string,
): Promise<number> {
  const rows = await queryMyImportRows(docClient, identityId);
  if (rows.length === 0) return 0;
  const visible = await fetchVisibleImportPosts(docClient, rows, { projection: 'SK, restaurantId, contentStatus' });
  return visible.length;
}
