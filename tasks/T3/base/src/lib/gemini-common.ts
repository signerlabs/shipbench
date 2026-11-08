/**
 * Gemini 调用的公共部分（2026-10-20 从 gemini-video-analysis 拆出；认店代理的 Gemini 接入层与考卷共用）
 *
 *  - uploadVideoToGemini：视频传 File API，轮询到 ACTIVE
 *  - withTransientRetry：繁忙或限流（503 / 429 / 超时）时等一会儿再试，不是同参立刻重试
 *    （2026-10-20 考卷两成撞 503，多在上传那步）
 *  - GeminiUsage / addUsage：记 token 用量，算成本用
 */

import type { GenerateContentResponseUsageMetadata, GoogleGenAI } from '@google/genai';

/** 一次任务用掉的 token（多轮对话、重试都累加），算成本用 */
export interface GeminiUsage {
  calls: number;
  promptTokens: number;
  /** promptTokens 里音频占的部分（2.5 Flash 音频单价更高） */
  audioTokens: number;
  /** promptTokens 里命中缓存的部分（按缓存价计，多轮对话里视频反复带上时用得上） */
  cachedTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export const emptyUsage = (): GeminiUsage => ({ calls: 0, promptTokens: 0, audioTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0 });

/** 把一次 generateContent 的 usageMetadata 累加进 usage */
export function addUsage(usage: GeminiUsage, u: GenerateContentResponseUsageMetadata | undefined): void {
  usage.calls++;
  usage.promptTokens += u?.promptTokenCount ?? 0;
  usage.audioTokens += (u?.promptTokensDetails ?? []).filter((d) => d.modality === 'AUDIO').reduce((s, d) => s + (d.tokenCount ?? 0), 0);
  usage.cachedTokens += u?.cachedContentTokenCount ?? 0;
  usage.outputTokens += u?.candidatesTokenCount ?? 0;
  usage.thoughtsTokens += u?.thoughtsTokenCount ?? 0;
}

const TRANSIENT_RE = /\b(503|429|500)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|timeout|ECONNRESET|fetch failed/i;
const TRANSIENT_DELAYS_MS = [5000, 15000];

export async function withTransientRetry<T>(log: string, step: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i >= TRANSIENT_DELAYS_MS.length || !TRANSIENT_RE.test(msg)) throw err;
      console.warn(`${log} Gemini ${step}繁忙，${TRANSIENT_DELAYS_MS[i] / 1000}s 后重试: ${msg.slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, TRANSIENT_DELAYS_MS[i]));
    }
  }
}

/**
 * 视频传给 Gemini File API，轮询到 ACTIVE（2s 间隔，最多 5 分钟）。
 * 返回的 name 由调用方在 finally 里 files.delete 释放配额
 */
export async function uploadVideoToGemini(
  genai: GoogleGenAI,
  videoBuffer: Buffer,
  log: string,
): Promise<{ uri: string; name: string | null }> {
  const uploadResult = await withTransientRetry(log, '上传', () => genai.files.upload({
    file: new Blob([videoBuffer], { type: 'video/mp4' }),
    config: { mimeType: 'video/mp4' },
  }));
  console.log(`${log} 文件已上传: name=${uploadResult.name}, state=${uploadResult.state}`);

  let geminiFile = uploadResult;
  let pollCount = 0;
  const maxPolls = 150; // 最多等 5 分钟（150 * 2s）
  while (geminiFile.state === 'PROCESSING') {
    pollCount++;
    if (pollCount > maxPolls) {
      throw new Error('Gemini 文件处理超时（超过 5 分钟）');
    }
    await new Promise(r => setTimeout(r, 2000));
    geminiFile = await withTransientRetry(log, '查询文件', () => genai.files.get({ name: geminiFile.name! }));
  }
  if (geminiFile.state === 'FAILED') {
    throw new Error('Gemini 文件处理失败');
  }
  console.log(`${log} 文件处理完成: state=${geminiFile.state}（轮询 ${pollCount} 次）`);
  return { uri: geminiFile.uri!, name: uploadResult.name || null };
}
