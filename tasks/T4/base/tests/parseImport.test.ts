/**
 * 抖音导入：处理阶段 / 失败原因下发（审查 M20）+ 每日额度退回 + 去重命中路径调序（2026-10-19）
 *
 * 覆盖：
 *   a) jobProgressFromVideo：stage 取值对齐 iOS ImportTracker（queued/downloading/analyzing/geocoding/persisting），
 *      failReason 用 iOS 已有机器码
 *   b) GET /v1/parse/jobs/:jobId 下发 stage / failReason，失败原因记到 JOB 行
 *   c) POST /v1/parse：新任务 stage=queued；已判非探店 → failReason；上次失败的视频条件重置后重新解析
 *   d) 去重命中「已完成」：先写 shared 再写用户收藏行；补一条 JOB 行作为导入凭证
 *   e) refundDailyParseQuota：带 jobId 时事务 + JOB 标记保证同一任务最多退一次
 *   f) /v1/config 下发真实每日限额 20
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
const mockLambdaSend = vi.fn();

const hoisted = vi.hoisted(() => ({
  identity: { identityId: 'ap-southeast-1:11111111-2222-3333-4444-555555555555', cognitoSub: 'sub-1' },
}));

vi.mock('../src/lib/dynamodb.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/dynamodb.js')>('../src/lib/dynamodb.js');
  return {
    ...actual,
    getDocClient: () => ({ send: mockSend }),
    USERS_TABLE: 'users', SHARED_TABLE: 'shared', VIDEOS_TABLE: 'videos',
  };
});

vi.mock('../src/middleware/auth.js', () => ({
  identityMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('identity', hoisted.identity);
    await next();
  },
  requireParseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
  getIdentity: (c: { get: (k: string) => unknown }) => c.get('identity'),
  isEnforceWriteAuth: () => false,
  isEnforceParseAuth: () => true,
}));
vi.mock('../src/middleware/adminAuth.js', () => ({
  adminAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/middleware/ban.js', () => ({
  rejectBannedWrites: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));
vi.mock('../src/lib/secrets.js', () => ({ getAppSecrets: vi.fn(async () => ({ TIKHUB_API_KEY: 'k' })) }));
vi.mock('../src/lib/s3.js', () => ({ uploadToS3: vi.fn(), existsInS3: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send(...a: unknown[]) { return mockLambdaSend(...a); } },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));

import { Hono } from 'hono';
import { parseRoute } from '../src/routes/parse.js';
import { configRoute } from '../src/routes/config.js';
import { jobProgressFromVideo } from '../src/lib/import-status.js';
import { refundDailyParseQuota, DAILY_PARSE_LIMIT } from '../src/lib/parse-quota.js';

const UID = hoisted.identity.identityId;
const AWEME = '7400000000000000001';

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const cmds = () => mockSend.mock.calls.map(([c]) => c as Cmd);

function app() {
  const a = new Hono();
  a.route('/parse', parseRoute);
  return a;
}

/** TikHub 返回一条普通视频 */
function stubTikHub() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    data: {
      aweme_detail: {
        aweme_id: AWEME, desc: '探店', aweme_type: 0,
        video: { duration: 30000, play_addr: { url_list: ['https://v.amemv.com/x.mp4'] }, cover: { url_list: ['https://c/x.jpg'] } },
        author: { uid: '9001', nickname: '博主', avatar_thumb: { url_list: ['https://a/x.jpg'] } },
      },
    },
  }), { status: 200 })));
}

function submit() {
  return app().request('/parse', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://v.douyin.com/abc/' }),
  });
}

class ConditionalCheckFailedException extends Error {
  override name = 'ConditionalCheckFailedException';
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  mockLambdaSend.mockReset();
  mockLambdaSend.mockResolvedValue({});
  process.env.PARSE_LAMBDA_ARN = 'arn:aws:lambda:ap-southeast-1:000:function:parse';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PARSE_LAMBDA_ARN;
});

// ============================================================
// a) jobProgressFromVideo
// ============================================================

describe('jobProgressFromVideo', () => {
  it('pending → queued（忽略残留 stage）', () => {
    expect(jobProgressFromVideo({ status: 'pending', stage: 'persisting' })).toEqual({ stage: 'queued' });
  });
  it('processing → Lambda 写的 stage；老数据没有 stage → downloading', () => {
    expect(jobProgressFromVideo({ status: 'processing', stage: 'geocoding' })).toEqual({ stage: 'geocoding' });
    expect(jobProgressFromVideo({ status: 'processing' })).toEqual({ stage: 'downloading' });
    expect(jobProgressFromVideo({ status: 'processing', stage: 'bogus' })).toEqual({ stage: 'downloading' });
  });
  it('rejected → not_food_review（老数据没写 failReason 也给码）', () => {
    expect(jobProgressFromVideo({ status: 'rejected' }).failReason).toBe('not_food_review');
  });
  it('failed → 只认 iOS 已有机器码；内部故障没有码', () => {
    expect(jobProgressFromVideo({ status: 'failed', failReason: 'download_failed' }).failReason).toBe('download_failed');
    expect(jobProgressFromVideo({ status: 'failed' }).failReason).toBeUndefined();
    expect(jobProgressFromVideo({ status: 'failed', failReason: 'weird' }).failReason).toBeUndefined();
  });
  it('没有视频行 → queued', () => {
    expect(jobProgressFromVideo(undefined)).toEqual({ stage: 'queued' });
  });
});

// ============================================================
// b) GET /jobs
// ============================================================

describe('GET /v1/parse/jobs/:jobId', () => {
  function rows(job: Record<string, unknown>, video?: Record<string, unknown>) {
    mockSend.mockImplementation((cmd: Cmd) => {
      if (cmd.constructor.name === 'GetCommand' && cmd.input.TableName === 'users') return Promise.resolve({ Item: job });
      if (cmd.constructor.name === 'GetCommand' && cmd.input.TableName === 'videos') return Promise.resolve({ Item: video });
      return Promise.resolve({});
    });
  }

  it('处理中 → 下发 Lambda 写的 stage', async () => {
    rows({ status: 'pending', awemeId: AWEME }, { status: 'processing', stage: 'analyzing' });
    const body = await (await app().request('/parse/jobs/job-1')).json();
    expect(body.data).toMatchObject({ status: 'pending', stage: 'analyzing' });
  });

  it('排队中 → stage=queued', async () => {
    rows({ status: 'pending', awemeId: AWEME }, { status: 'pending' });
    const body = await (await app().request('/parse/jobs/job-1')).json();
    expect(body.data.stage).toBe('queued');
  });

  it('失败 → 下发 failReason，并记到 JOB 行', async () => {
    rows({ status: 'pending', awemeId: AWEME }, { status: 'failed', failReason: 'download_failed', error: 'x' });
    const body = await (await app().request('/parse/jobs/job-1')).json();
    expect(body.data).toMatchObject({ status: 'failed', failReason: 'download_failed' });
    const jobUpdate = cmds().find((c) => c.constructor.name === 'UpdateCommand' && c.input.Key.SK === 'JOB#job-1')!;
    expect(jobUpdate.input.ExpressionAttributeValues[':fr']).toBe('download_failed');
  });

  it('内部故障失败 → 不给 failReason（iOS 回落「导入失败，请重试」）', async () => {
    rows({ status: 'pending', awemeId: AWEME }, { status: 'failed', error: 'DynamoDB 限流' });
    const body = await (await app().request('/parse/jobs/job-1')).json();
    expect(body.data.status).toBe('failed');
    expect(body.data.failReason).toBeUndefined();
  });

  it('非探店 → failReason=not_food_review（rejectionReason 原文照旧）', async () => {
    rows({ status: 'pending', awemeId: AWEME }, { status: 'rejected', rejectionReason: '这是 vlog' });
    const body = await (await app().request('/parse/jobs/job-1')).json();
    expect(body.data).toMatchObject({ status: 'rejected', failReason: 'not_food_review', rejectionReason: '这是 vlog' });
  });

  it('JOB 已是终态 → 从 JOB 行返回 failReason', async () => {
    rows({ status: 'failed', awemeId: AWEME, failReason: 'analysis_failed', error: 'x' });
    const body = await (await app().request('/parse/jobs/job-1')).json();
    expect(body.data).toMatchObject({ status: 'failed', failReason: 'analysis_failed' });
  });
});

// ============================================================
// c) / d) POST /v1/parse
// ============================================================

describe('POST /v1/parse', () => {
  beforeEach(() => stubTikHub());

  function videoRow(video: Record<string, unknown> | undefined, extra?: (cmd: Cmd) => unknown) {
    mockSend.mockImplementation((cmd: Cmd) => {
      const custom = extra?.(cmd);
      if (custom !== undefined) return custom;
      if (cmd.constructor.name === 'GetCommand' && cmd.input.TableName === 'videos') return Promise.resolve({ Item: video });
      return Promise.resolve({});
    });
  }

  it('新视频 → 入队，stage=queued', async () => {
    videoRow(undefined);
    const body = await (await submit()).json();
    expect(body.data).toMatchObject({ status: 'pending', stage: 'queued', awemeId: AWEME });
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  it('已判非探店 → 直接回 rejected + failReason', async () => {
    videoRow({ awemeId: AWEME, status: 'rejected', rejectionReason: '带货' });
    const body = await (await submit()).json();
    expect(body.data).toMatchObject({ status: 'rejected', failReason: 'not_food_review' });
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('上次失败的视频 → 条件重置为 pending（清 failReason/stage/error）后重新触发', async () => {
    videoRow({ awemeId: AWEME, status: 'failed', failReason: 'download_failed' });
    const body = await (await submit()).json();
    expect(body.data.status).toBe('pending');
    const reset = cmds().find((c) => c.constructor.name === 'UpdateCommand' && c.input.TableName === 'videos')!;
    expect(reset.input.ConditionExpression).toBe('#s = :failed');
    expect(reset.input.UpdateExpression).toContain('REMOVE failReason, stage, #err');
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
  });

  it('失败视频被并发请求抢先重置 → 不重复触发 Lambda，返回可轮询 JOB', async () => {
    videoRow({ awemeId: AWEME, status: 'failed' }, (cmd) => (
      cmd.constructor.name === 'UpdateCommand' && cmd.input.TableName === 'videos'
        ? Promise.reject(new ConditionalCheckFailedException()) : undefined
    ));
    const body = await (await submit()).json();
    expect(body.data).toMatchObject({ status: 'pending', stage: 'queued' });
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('去重命中「已完成」：先写 shared 实体，再写用户收藏行；补一条 JOB 行作为导入凭证', async () => {
    videoRow({ awemeId: AWEME, status: 'completed', restaurantId: AWEME, influencerUid: '9001', city: '北京市' });
    const res = await submit();
    expect((await res.json()).data.status).toBe('completed');

    const order = cmds()
      .filter((c) => c.constructor.name === 'PutCommand')
      .map((c) => `${c.input.TableName}:${String(c.input.Item.SK).split('#')[0]}`);
    const firstUserRow = order.findIndex((o) => o === 'users:REST' || o === 'users:INFLUENCER');
    const lastShared = order.map((o) => o.startsWith('shared:')).lastIndexOf(true);
    expect(firstUserRow).toBeGreaterThan(lastShared);

    const job = cmds().find((c) => c.constructor.name === 'PutCommand' && c.input.Item.SK === `JOB#existing-${AWEME}`)!;
    expect(job.input.Item).toMatchObject({ PK: UID, awemeId: AWEME, status: 'completed' });
  });
});

// ============================================================
// e) refundDailyParseQuota
// ============================================================

describe('refundDailyParseQuota', () => {
  const client = { send: mockSend } as never;

  it('带 jobId：一个事务里打 JOB 标记 + 额度 -1', async () => {
    const out = await refundDailyParseQuota(client, 'users', { identityId: UID, rateLimitDate: '2026-10-19', jobId: 'job-1' });
    expect(out).toBe('refunded');
    const [cmd] = cmds();
    expect(cmd.constructor.name).toBe('TransactWriteCommand');
    const [mark, counter] = cmd.input.TransactItems.map((t: { Update: Record<string, any> }) => t.Update);
    expect(mark.Key).toEqual({ PK: UID, SK: 'JOB#job-1' });
    expect(mark.ConditionExpression).toContain('attribute_not_exists(quotaRefunded)');
    expect(counter.Key).toEqual({ PK: UID, SK: 'RATELIMIT#parse#2026-10-19' });
    expect(counter.ConditionExpression).toBe('usedCount >= :one');
  });

  it('已经退过（事务取消）→ skipped，不再减', async () => {
    const err = new Error('cancelled'); err.name = 'TransactionCanceledException';
    mockSend.mockRejectedValue(err);
    const out = await refundDailyParseQuota(client, 'users', { identityId: UID, rateLimitDate: '2026-10-19', jobId: 'job-1' });
    expect(out).toBe('skipped');
  });

  it('批量任务 / 没有日期分片 → 不动额度', async () => {
    expect(await refundDailyParseQuota(client, 'users', { identityId: 'system-batch', rateLimitDate: '2026-10-19', jobId: 'b' })).toBe('skipped');
    expect(await refundDailyParseQuota(client, 'users', { identityId: UID, jobId: 'j' })).toBe('skipped');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('不带 jobId（老调用方）→ 退化为条件减', async () => {
    await refundDailyParseQuota(client, 'users', { identityId: UID, rateLimitDate: '2026-10-19' });
    expect(cmds()[0].constructor.name).toBe('UpdateCommand');
  });

  it('其它异常只打日志不抛出', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    await expect(refundDailyParseQuota(client, 'users', { identityId: UID, rateLimitDate: 'd', jobId: 'j' })).resolves.toBe('skipped');
  });
});

// ============================================================
// f) /v1/config
// ============================================================

describe('/v1/config', () => {
  it('freeImportLimit 下发真实每日限额 20，与环境变量无关', async () => {
    process.env.FREE_IMPORT_LIMIT = '3';
    const a = new Hono();
    a.route('/config', configRoute);
    const body = await (await a.request('/config')).json();
    expect(body.data.freeImportLimit).toBe(20);
    expect(DAILY_PARSE_LIMIT).toBe(20);
    expect(body.data.enforceParseAuth).toBe(true);
    delete process.env.FREE_IMPORT_LIMIT;
  });
});
