/**
 * Secrets Manager 工具模块
 *
 * 从 AWS Secrets Manager 获取密钥
 * 内存缓存已获取的密钥（App Runner 长驻进程复用）
 *
 * 2026-10-19 审查 HIGH 6：缓存加 TTL。旧实现缓存永不过期——在 Secrets Manager 里补写/轮换
 * 字段（如 REVENUECAT_WEBHOOK_AUTH、App Store 反查密钥）对运行中的实例永远不生效，必须重新
 * 部署；多实例时还会出现部分实例新值、部分旧值的间歇性故障。现在：
 *   - 命中 TTL 内直接用缓存；过期后重新拉取，改值最迟 SECRET_CACHE_TTL_MS 后全实例生效
 *   - 过期后拉取失败（Secrets Manager 抖动）→ 回落到上一份值并打日志，不让瞬时故障打断业务
 *   - 并发过期只发一次请求（in-flight 合并），避免 TTL 到点时被并发请求打爆
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// Secrets Manager 客户端单例
const secretsClient = new SecretsManagerClient({
  region: process.env.REGION || 'ap-southeast-1',
});

/** 缓存有效期：5 分钟（轮换后最迟 5 分钟全实例生效） */
export const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

// 密钥缓存（key: `${格式}:${secretArn}`，JSON 与纯字符串分开存，避免同一 ARN 两种读法互相污染）
const cache = new Map<string, CacheEntry>();
// 进行中的拉取（同一 key 并发只发一次请求）
const inflight = new Map<string, Promise<unknown>>();

/**
 * 带 TTL 的读取骨架：命中直接返回；过期则拉取，拉取失败且有旧值时回落旧值
 */
async function readCached<T>(
  cacheKey: string,
  secretArn: string,
  parse: (raw: string) => T,
): Promise<T> {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) {
    return hit.value as T;
  }

  const pending = inflight.get(cacheKey);
  if (pending) return pending as Promise<T>;

  const task = (async (): Promise<T> => {
    try {
      const response = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      );
      if (!response.SecretString) {
        throw new Error(`Secret ${secretArn} 返回空值`);
      }
      const value = parse(response.SecretString);
      cache.set(cacheKey, { value, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
      return value;
    } catch (err) {
      if (hit) {
        // 过期值兜底：Secrets Manager 抖动时继续用上一份，不把瞬时故障放大成业务故障
        console.warn(`[secrets] 刷新 ${secretArn} 失败，暂用过期缓存`, err);
        return hit.value as T;
      }
      throw err;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, task);
  return task;
}

/**
 * 获取密钥（JSON 格式）
 *
 * 从 Secrets Manager 读取并解析为 JSON 对象，结果按 TTL 缓存在内存中
 *
 * @param secretArn Secret ARN 或名称
 * @returns 解析后的 JSON 对象
 */
export async function getSecretJson<T = Record<string, string>>(secretArn: string): Promise<T> {
  return readCached<T>(`json:${secretArn}`, secretArn, (raw) => JSON.parse(raw) as T);
}

/**
 * 获取密钥（纯字符串格式）
 *
 * @param secretArn Secret ARN 或名称
 * @returns 原始字符串
 */
export async function getSecretString(secretArn: string): Promise<string> {
  return readCached<string>(`str:${secretArn}`, secretArn, (raw) => raw);
}

/**
 * 获取应用密钥
 *
 * 从 APP_SECRET_ARN 环境变量指定的 Secret 中读取 JSON 格式密钥
 * 包含 TIKHUB_API_KEY、GEMINI_API_KEY 等
 */
export async function getAppSecrets(): Promise<Record<string, string>> {
  const secretArn = process.env.APP_SECRET_ARN;
  if (!secretArn) {
    throw new Error('APP_SECRET_ARN 环境变量未配置');
  }
  return getSecretJson<Record<string, string>>(secretArn);
}

/** 仅供单测：清空缓存 */
export function __resetSecretsCacheForTests(): void {
  cache.clear();
  inflight.clear();
}
