/**
 * 认店代理的 Gemini 接入层 + Gemini 公共部分单元测试（2026-10-20）
 *
 * 覆盖：
 *   a) 多轮：模型调工具 → 交给管线层执行 → 结果回给模型 → 调 submit_answer 交答案；用完删掉上传的视频
 *   b) 查询次数用完：只许调 submit_answer，并把提示告诉模型
 *   c) 评论区坏图（400 Unable to process input image）：去掉评论图片再来
 *   d) 上传撞 503：等 5 秒再传（withTransientRetry）
 *
 * 运行方式：npm test
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { geminiShopAgent } from '../src/lib/shop-agent-gemini.js';
import { uploadVideoToGemini } from '../src/lib/gemini-common.js';
import type { AgentJob } from '../src/lib/shop-agent.js';

function fakeGenai(responses: Array<() => unknown>) {
  let i = 0;
  return {
    files: {
      upload: vi.fn(async () => ({ name: 'files/x', uri: 'gs://x', state: 'ACTIVE' })),
      get: vi.fn(),
      delete: vi.fn(async () => undefined),
    },
    models: { generateContent: vi.fn(async () => responses[Math.min(i++, responses.length - 1)]()) },
  };
}

const fcResp = (calls: Array<{ name: string; args: Record<string, unknown> }>) => ({
  functionCalls: calls,
  candidates: [{ content: { role: 'model', parts: calls.map((c) => ({ functionCall: c })) } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
});

function job(over: Partial<AgentJob> = {}): AgentJob {
  return {
    video: Buffer.from('v'),
    prompt: '认店',
    images: [],
    tools: [{ name: 'maps_text_search', description: '搜', parameters: { type: 'object' } }, { name: 'submit_answer', description: '交', parameters: { type: 'object' } }],
    callTool: vi.fn(async () => ({ pois: [] })),
    mustSubmit: () => false,
    submitNudge: '请交答案',
    log: '[t]',
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('geminiShopAgent', () => {
  it('多轮：调工具 → 结果回给模型 → 交答案；用完删掉上传的视频', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const g = fakeGenai([
      () => fcResp([{ name: 'maps_text_search', args: { keywords: '老王面馆' } }]),
      () => fcResp([{ name: 'submit_answer', args: { decision: 'located', poi_id: 'B0FFAAAAAA' } }]),
    ]);
    const j = job();
    const run = await geminiShopAgent(g as unknown as GoogleGenAI).run(j);
    expect(run.answer).toEqual({ decision: 'located', poi_id: 'B0FFAAAAAA' });
    expect(run.turns).toBe(2);
    expect(run.usage.promptTokens).toBe(200);
    expect(j.callTool).toHaveBeenCalledWith('maps_text_search', { keywords: '老王面馆' });
    // contents 是同一个数组（交答案那轮的模型内容随后也推了进去），工具结果在倒数第二条
    const second = g.models.generateContent.mock.calls[1][0] as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    expect(second.contents.at(-2)!.parts[0]).toMatchObject({ functionResponse: { name: 'maps_text_search', response: { output: { pois: [] } } } });
    expect(g.files.delete).toHaveBeenCalledWith({ name: 'files/x' });
  });

  it('查询次数用完：只许调 submit_answer，并把提示告诉模型', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let used = 0;
    const g = fakeGenai([
      () => fcResp([{ name: 'maps_text_search', args: {} }]),
      () => fcResp([{ name: 'submit_answer', args: { decision: 'uncertain' } }]),
    ]);
    const j = job({ callTool: vi.fn(async () => { used++; return { pois: [] }; }), mustSubmit: () => used >= 1 });
    await geminiShopAgent(g as unknown as GoogleGenAI).run(j);
    const second = g.models.generateContent.mock.calls[1][0] as {
      config: { toolConfig: { functionCallingConfig: { allowedFunctionNames?: string[] } } };
      contents: Array<{ parts: Array<{ text?: string }> }>;
    };
    expect(second.config.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(['submit_answer']);
    expect(second.contents.at(-2)!.parts.some((p) => p.text === '请交答案')).toBe(true);
  });

  it('评论区坏图：去掉评论图片再来', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const g = fakeGenai([
      () => { throw new Error('{"error":{"code":400,"message":"Unable to process input image."}}'); },
      () => fcResp([{ name: 'submit_answer', args: { decision: 'no_name' } }]),
    ]);
    const run = await geminiShopAgent(g as unknown as GoogleGenAI).run(job({ images: [{ mimeType: 'image/jpeg', data: 'AAAA' }] }));
    expect(run.answer).toEqual({ decision: 'no_name' });
    const retry = g.models.generateContent.mock.calls[1][0] as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(retry.contents[0].parts.some((p) => 'inlineData' in p)).toBe(false);
  });
});

describe('uploadVideoToGemini：繁忙时等一会儿再试', () => {
  it('上传撞 503：等 5 秒再传', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let n = 0;
    const g = {
      files: {
        upload: vi.fn(async () => {
          if (n++ === 0) throw new Error('{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}');
          return { name: 'files/x', uri: 'gs://x', state: 'ACTIVE' };
        }),
        get: vi.fn(),
      },
    };
    const p = uploadVideoToGemini(g as unknown as GoogleGenAI, Buffer.from('v'), '[t]');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ uri: 'gs://x', name: 'files/x' });
    expect(g.files.upload).toHaveBeenCalledTimes(2);
  });
});
