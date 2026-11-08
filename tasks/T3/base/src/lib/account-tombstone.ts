/**
 * 账号注销墓碑
 *
 * 为什么需要：注销删光了 users 表 PK=identityId 的所有行，但外部系统不知道这个
 * identityId 已经没了——RevenueCat 仍按它作 app_user_id 发续订事件，而 webhook
 * 的 UpdateCommand 是 upsert，会凭空给已注销账号重建一条 active 的 SUBSCRIPTION 行：
 * 数据复活、admin 统计把它当新增订阅、且该行重新与 identityId 关联起来。
 * （Apple 那条链路靠注销时删 TXID#<otx> 映射挡住：/webhooks/appstore 反查不到就跳过。）
 *
 * 键刻意不用 PK=identityId：那样会被注销流程自己的「删 PK=identityId 全部行」一并清掉。
 * 内容只有 identityId（注销后已无法关联自然人）+ 时间，不含任何个人信息。
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getDocClient, USERS_TABLE } from './dynamodb.js';

/** 保留时长：覆盖一个年订阅周期 + 缓冲，期间 RC 仍可能按旧 identityId 发续订事件 */
const TOMBSTONE_TTL_DAYS = 400;

const tombstoneKey = (identityId: string) => ({ PK: `DELETED#${identityId}`, SK: 'TOMBSTONE' });

/** 写入墓碑（幂等：重复注销覆盖写无副作用） */
export async function writeDeletionTombstone(identityId: string, now: string): Promise<void> {
  await getDocClient().send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      ...tombstoneKey(identityId),
      deletedAt: now,
      // users 表 TTL 属性为 ttl（秒级 epoch），到期由 DynamoDB 自动清理
      ttl: Math.floor(Date.now() / 1000) + TOMBSTONE_TTL_DAYS * 86_400,
    },
  }));
}

/** 该 identityId 是否已注销（webhook 写入前必查，防止复活） */
export async function isDeletedIdentity(identityId: string): Promise<boolean> {
  const res = await getDocClient().send(new GetCommand({
    TableName: USERS_TABLE,
    Key: tombstoneKey(identityId),
    ProjectionExpression: 'PK',
  }));
  return !!res.Item;
}
