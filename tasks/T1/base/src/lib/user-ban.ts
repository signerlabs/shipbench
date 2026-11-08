/**
 * 用户封禁（2026-10-19）
 *
 * 约定：封禁记录 = users 表 PK=<identityId>, SK="BAN"，字段 { reason, createdAt, createdBy: "admin" }。
 * 由管理后台主审操作（POST / DELETE /admin/users/:identityId/ban）。
 *
 * 写接口与 /v1/parse 遇到被封禁的身份返回 403 USER_BANNED（见 middleware/ban.ts），读接口不拦。
 * 每个写请求都查一次会多一次 DynamoDB 往返，因此加短时内存缓存（含「未封禁」的否定缓存）：
 * 封禁 / 解封在处理该请求的实例上立即生效，其它实例最迟 BAN_CACHE_TTL_MS 后生效。
 */

import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, USERS_TABLE } from './dynamodb.js';

/** 封禁记录 */
export interface BanRecord {
  reason: string;
  createdAt: string;
  createdBy: string;
}

const BAN_SK = 'BAN';

/** 缓存有效期：60 秒（多实例下封禁 / 解封的最长生效延迟） */
export const BAN_CACHE_TTL_MS = 60_000;
/** 缓存条目上限：超过即整体清空，防长驻进程内存无界增长 */
const BAN_CACHE_MAX_ENTRIES = 10_000;

const banCache = new Map<string, { banned: boolean; expiresAt: number }>();

/** 该身份是否被封禁（带短时缓存；DynamoDB 异常向上抛，由调用方决定放行与否） */
export async function isIdentityBanned(identityId: string): Promise<boolean> {
  const hit = banCache.get(identityId);
  if (hit && Date.now() < hit.expiresAt) return hit.banned;

  const res = await getDocClient().send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: BAN_SK },
    ProjectionExpression: 'PK',
  }));
  const banned = !!res.Item;
  if (banCache.size >= BAN_CACHE_MAX_ENTRIES) banCache.clear();
  banCache.set(identityId, { banned, expiresAt: Date.now() + BAN_CACHE_TTL_MS });
  return banned;
}

/** 封禁（重复封禁覆盖原因与时间） */
export async function banIdentity(identityId: string, reason: string, createdBy = 'admin'): Promise<BanRecord> {
  const record: BanRecord = { reason, createdAt: new Date().toISOString(), createdBy };
  await getDocClient().send(new PutCommand({
    TableName: USERS_TABLE,
    Item: { PK: identityId, SK: BAN_SK, ...record },
  }));
  banCache.set(identityId, { banned: true, expiresAt: Date.now() + BAN_CACHE_TTL_MS });
  return record;
}

/** 解封（记录不存在也视为成功） */
export async function unbanIdentity(identityId: string): Promise<void> {
  await getDocClient().send(new DeleteCommand({
    TableName: USERS_TABLE,
    Key: { PK: identityId, SK: BAN_SK },
  }));
  banCache.set(identityId, { banned: false, expiresAt: Date.now() + BAN_CACHE_TTL_MS });
}

/** 仅供单测：清空缓存 */
export function __resetBanCacheForTests(): void {
  banCache.clear();
}
