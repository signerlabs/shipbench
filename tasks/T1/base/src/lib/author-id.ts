/**
 * authorId：用户的对外代理编号（Cognito 鉴权改造第二波；2026-10-22 随用户自建内容删除精简）
 *
 *   - identityId（Cognito Identity ID，形如 "ap-southeast-1:uuid"）同时是 x-identity-id 鉴权凭据面，
 *     绝不能出现在公开响应或公开 URL 里。
 *   - authorId（UUID）与它完全解耦，用在需要公开的地方：头像对象路径 avatars/{authorId}/…（7/2 起）。
 *   - 存储：正向 users 表 PROFILE.authorId；反向 users 表 PK=AUTHOR#{authorId}, SK=MAPPING, identityId=…
 *     （与 TXID# 交易映射同模式，注销账户时一并删除）。
 *   - 用户自建内容 10/22 彻底删除后，INFLUENCER 上不再有用户作者，不再镜像 authorId 到 INFLUENCER。
 */

import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, USERS_TABLE } from './dynamodb.js';

/**
 * 判断一个字符串是不是 Cognito identityId（"<region>:<uuid>"）。
 * 抖音 uid 是纯数字串，不含冒号；后台封禁 / 解封等入参用它做格式校验。
 */
export function isIdentityId(uid: string | undefined | null): boolean {
  if (!uid || typeof uid !== 'string') return false;
  // identityId 形如 "<region>:<uuid>"，region 含连字符、uuid 含连字符
  return /^[a-z]{2}-[a-z]+-\d+:/.test(uid);
}

/**
 * 读取（不存在则惰性生成）某 identityId 对应的 authorId。
 *
 * 幂等：已存在 authorId 时直接返回（顺手补齐 AUTHOR# 反向映射），不重复生成。
 *
 * @returns 稳定的 authorId（UUID）
 */
export async function ensureAuthorId(identityId: string): Promise<string> {
  const docClient = getDocClient();

  const profileRes = await docClient.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: 'PROFILE' },
    ProjectionExpression: 'authorId',
  }));
  const existing = profileRes.Item?.['authorId'] as string | undefined;
  if (existing) {
    await ensureMapping(identityId, existing);
    return existing;
  }

  // 没有 → 生成新 authorId，写 PROFILE + 反向映射
  const authorId = crypto.randomUUID();
  const now = new Date().toISOString();

  // PROFILE（条件 attribute_not_exists(authorId) 防并发覆盖；PROFILE 不存在则一并创建占位）
  try {
    await docClient.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: 'PROFILE' },
      UpdateExpression: 'SET authorId = :aid, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: { ':aid': authorId, ':now': now },
      ConditionExpression: 'attribute_not_exists(authorId)',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    // 并发：已有人写入 PROFILE.authorId，回读胜出者
    const reread = await docClient.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { PK: identityId, SK: 'PROFILE' },
      ProjectionExpression: 'authorId',
    }));
    const won = reread.Item?.['authorId'] as string | undefined;
    if (won) {
      await ensureMapping(identityId, won);
      return won;
    }
  }

  // 反向映射记录 AUTHOR#{authorId} → identityId（GetItem 直查，无 GSI）
  await docClient.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      PK: `AUTHOR#${authorId}`,
      SK: 'MAPPING',
      identityId,
      authorId,
      createdAt: now,
    },
  }));

  return authorId;
}

/** AUTHOR# 反向映射兜底（幂等；已存在不覆盖） */
async function ensureMapping(identityId: string, authorId: string): Promise<void> {
  try {
    await getDocClient().send(new PutCommand({
      TableName: USERS_TABLE,
      Item: { PK: `AUTHOR#${authorId}`, SK: 'MAPPING', identityId, authorId, createdAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
}
