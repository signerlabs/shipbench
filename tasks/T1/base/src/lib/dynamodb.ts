/**
 * DynamoDB 客户端模块
 *
 * 提供 DynamoDBDocumentClient 单例和表名常量
 * region 和表名从环境变量读取
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';

// DynamoDB Document 客户端单例
let docClient: DynamoDBDocumentClient | null = null;

/**
 * 获取 DynamoDBDocumentClient 单例
 */
export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    const region = process.env.REGION || 'ap-southeast-1';
    const rawClient = new DynamoDBClient({
      region,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 5000,
        socketTimeout: 30000,
        httpAgent: new HttpAgent({ maxSockets: 200 }),
        httpsAgent: new HttpsAgent({ maxSockets: 200 }),
      }),
    });
    docClient = DynamoDBDocumentClient.from(rawClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }
  return docClient;
}

/**
 * 表名常量（从环境变量读取，带默认值）
 */
export const VIDEOS_TABLE = process.env.VIDEOS_TABLE || 'shopmap-videos';
export const USERS_TABLE = process.env.USERS_TABLE || 'shopmap-users';
export const SHARED_TABLE = process.env.SHARED_TABLE || 'shopmap-shared';

/**
 * 将 DynamoDB 的 List (L) 或 String Set (SS) 统一转为 string[]
 * DocumentClient v3 将 L 反序列化为 Array，SS 反序列化为 Set
 * 防御性处理，避免 SS 类型脏数据导致下游 as string[] 强转出错
 */
export function toStringArray(val: unknown): string[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as string[];
  if (val instanceof Set) return Array.from(val) as string[];
  return [];
}
