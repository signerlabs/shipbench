/**
 * 推荐者头像：库里已有就沿用（2026-10-28 产品负责人定）
 *
 * 推荐者头像在库里换成了软陶像（S3 avatars/clay/，产品负责人定期批量替换），导入不能再拿抖音头像覆盖。
 * 以前每次导入都重拉一遍抖音头像、覆盖同一个文件、再把同一个地址写回库里，本来就是白做；
 * 现在库里有这位推荐者且有头像就直接用它，只有新推荐者才去拉抖音头像。
 */

import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** 库里这位推荐者现有的头像；没这个人、没头像或读失败都回 null（读失败按新推荐者处理） */
export async function existingInfluencerAvatar(
  docClient: DynamoDBDocumentClient,
  sharedTable: string,
  influencerUid: string,
): Promise<string | null> {
  if (!influencerUid) return null;
  try {
    const result = await docClient.send(new GetCommand({
      TableName: sharedTable,
      Key: { PK: 'INFLUENCER', SK: influencerUid },
      ProjectionExpression: 'influencerAvatar',
    }));
    const avatar = result.Item?.['influencerAvatar'];
    return typeof avatar === 'string' && avatar ? avatar : null;
  } catch (err) {
    console.warn(`[avatar] 读推荐者 ${influencerUid} 现有头像失败，按新推荐者处理:`, err);
    return null;
  }
}
