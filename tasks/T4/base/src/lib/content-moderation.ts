/**
 * 阿里云 Green 内容审核公共模块
 *
 * 供 App Runner 路由（auth.ts 等）同步调用。
 * content-moderator Lambda 有独立编译上下文，不能直接 import 本模块，
 * 但审核逻辑与 Lambda 中的实现保持一致。
 *
 * 支持：
 * - 文本审核（moderateText）— 用于昵称、推荐语等
 * - 图片审核（moderateImage）— 用于头像等
 */

import { getAppSecrets } from './secrets.js';

/** 审核结果 */
export interface ModerationResult {
  pass: boolean;
  labels: string[];
  reason?: string;
}

/**
 * 获取阿里云密钥
 *
 * 不再自建永久缓存（审查 HIGH 6）：getAppSecrets 已按 TTL 缓存，轮换 AK 后最迟 5 分钟生效
 */
async function getAlicloudKeys(): Promise<{ accessKeyId: string; accessKeySecret: string }> {
  const secrets = await getAppSecrets();
  const accessKeyId = secrets['ALICLOUD_ACCESS_KEY_ID'];
  const accessKeySecret = secrets['ALICLOUD_ACCESS_KEY_SECRET'];

  if (!accessKeyId || !accessKeySecret) {
    throw new Error('阿里云密钥未配置（ALICLOUD_ACCESS_KEY_ID / ALICLOUD_ACCESS_KEY_SECRET）');
  }

  return { accessKeyId, accessKeySecret };
}

/**
 * 创建阿里云 Green 客户端
 */
async function createGreenClient() {
  const { accessKeyId, accessKeySecret } = await getAlicloudKeys();

  const OpenApi = await import('@alicloud/openapi-client');
  const Green20220302 = await import('@alicloud/green20220302');

  const config = new OpenApi.default.Config({
    accessKeyId,
    accessKeySecret,
    endpoint: 'green-cip.cn-shanghai.aliyuncs.com',
    regionId: 'cn-shanghai',
  });

  return new Green20220302.default.default(config);
}

/**
 * 文本审核
 *
 * 调用阿里云 Green API 文字审核（comment_detection 服务）
 * 与 content-moderator Lambda 中的逻辑一致
 *
 * @param text 待审核文本
 * @returns 审核结果
 */
export async function moderateText(text: string): Promise<ModerationResult> {
  const Green20220302 = await import('@alicloud/green20220302');
  const Util = await import('@alicloud/tea-util');

  const greenClient = await createGreenClient();

  const request = new Green20220302.default.TextModerationRequest({
    service: 'comment_detection',
    serviceParameters: JSON.stringify({
      content: text,
    }),
  });

  const runtime = new Util.default.RuntimeOptions({});
  const response = await greenClient.textModerationWithOptions(request, runtime);
  const body = response.body;

  if (!body || body.code !== 200) {
    throw new Error(`阿里云 Green 文本审核 API 返回错误: code=${body?.code}, msg=${body?.message}`);
  }

  const data = body.data;
  const labels = data?.labels || '';
  const reason = data?.reason || '';

  // labels 为空字符串表示通过
  if (!labels) {
    return { pass: true, labels: [] };
  }

  return {
    pass: false,
    labels: labels.split(','),
    reason,
  };
}

/**
 * 图片审核
 *
 * 调用阿里云 Green API 图片审核（baselineCheck 服务）
 * 支持传入图片 URL 或 base64
 *
 * @param imageUrl 图片公开 URL（CDN URL）
 * @returns 审核结果
 */
export async function moderateImage(imageUrl: string): Promise<ModerationResult> {
  const Green20220302 = await import('@alicloud/green20220302');
  const Util = await import('@alicloud/tea-util');

  const greenClient = await createGreenClient();

  const request = new Green20220302.default.ImageModerationRequest({
    service: 'baselineCheck',
    serviceParameters: JSON.stringify({
      imageUrl,
    }),
  });

  const runtime = new Util.default.RuntimeOptions({});
  const response = await greenClient.imageModerationWithOptions(request, runtime);
  const body = response.body;

  if (!body || body.code !== 200) {
    throw new Error(`阿里云 Green 图片审核 API 返回错误: code=${body?.code}, msg=${body?.message}`);
  }

  const data = body.data;
  const dataResult = data?.dataId;
  const result = data?.result;

  // result 是一个数组，每个元素包含 label, confidence, description
  if (!result || !Array.isArray(result) || result.length === 0) {
    // 无检测结果，视为通过
    return { pass: true, labels: [], reason: dataResult };
  }

  // 收集所有非 nonLabel 的标签
  const flaggedLabels: string[] = [];
  for (const item of result) {
    const label = item.label as string;
    const confidence = item.confidence as number;
    // confidence >= 80 视为命中
    if (label && label !== 'nonLabel' && confidence >= 80) {
      flaggedLabels.push(label);
    }
  }

  if (flaggedLabels.length === 0) {
    return { pass: true, labels: [] };
  }

  return {
    pass: false,
    labels: flaggedLabels,
    reason: `检测到违规内容: ${flaggedLabels.join(', ')}`,
  };
}
