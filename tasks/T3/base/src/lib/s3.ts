/**
 * S3 服务模块
 *
 * 上传、删除、检查对象（头像等）
 * 在 AWS 环境中使用 IAM Role 自动获取凭证
 */

import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

// S3 客户端单例
let s3Client: S3Client | null = null;

/**
 * 获取 S3 客户端单例
 */
function getS3Client(): S3Client {
  if (!s3Client) {
    const region = process.env.S3_REGION || process.env.REGION || 'ap-southeast-1';
    s3Client = new S3Client({ region });
  }
  return s3Client;
}

/**
 * 获取 S3 Bucket 名称
 */
function getBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error('S3_BUCKET 环境变量未配置');
  }
  return bucket;
}

/**
 * 检查 S3 对象是否存在
 */
export async function existsInS3(key: string): Promise<boolean> {
  const client = getS3Client();
  const bucket = getBucket();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 上传文件到 S3
 */
export async function uploadToS3(key: string, body: Buffer, contentType: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucket();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  }));
}

/**
 * 删除 S3 对象
 *
 * 用于审核不通过时清理已上传的文件
 */
export async function deleteFromS3(key: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucket();
  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
}
