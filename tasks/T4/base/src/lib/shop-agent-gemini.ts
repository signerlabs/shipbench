/**
 * 认店代理的 Gemini 接入层（2026-10-20；管线层见 shop-agent.ts）
 *
 * Gemini 能直接看视频、听声音：视频传 File API，和提示词、评论图片一起放在第一轮；之后每轮把模型的工具调用
 * 交给管线层执行（高德官方 MCP），结果原样回给模型，直到它调 submit_answer。
 * Gemini 3 的函数调用要把模型每轮的原样内容（含思考签名）带回去，所以 history 直接推 candidates[0].content。
 * 查询次数或时间用完（job.mustSubmit）后只许调 submit_answer，并把 job.submitNudge 告诉它。
 *
 * 默认模型 2026-10-21 起是 gemini-4-argon（正式版）：考卷 39 家各考两遍，定准 36、35，错位 0；
 * 原先的 gemini-3.1-pro-preview 定准 34、33，有一遍错位 1，还有一家拖了 18 分钟（超过 Lambda 的 10 分钟上限）。
 */

import { FunctionCallingConfigMode, type Content, type GoogleGenAI, type Part } from '@google/genai';
import { addUsage, emptyUsage, uploadVideoToGemini, withTransientRetry } from './gemini-common.js';
import type { AgentJob, AgentRun, ShopAgentModel } from './shop-agent.js';

export const DEFAULT_AGENT_MODEL = 'gemini-4-argon';

/** 最多几轮对话（查询次数上限之外的保险） */
const MAX_TURNS = 16;

export function geminiShopAgent(genai: GoogleGenAI, model: string = DEFAULT_AGENT_MODEL): ShopAgentModel {
  return {
    name: model,
    async run(job: AgentJob): Promise<AgentRun> {
      const usage = emptyUsage();
      let uploaded: { uri: string; name: string | null } | null = null;
      try {
        if (job.video) uploaded = await uploadVideoToGemini(genai, job.video, job.log);
        const parts: Part[] = [];
        if (uploaded) parts.push({ fileData: { fileUri: uploaded.uri, mimeType: 'video/mp4' } });
        for (const img of job.images) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        parts.push({ text: job.prompt });
        const contents: Content[] = [{ role: 'user', parts }];
        const functionDeclarations = job.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));

        let imagesDropped = false;
        for (let turn = 1; turn <= MAX_TURNS; turn++) {
          const onlySubmit = job.mustSubmit();
          const generate = () => withTransientRetry(job.log, '认店', () => genai.models.generateContent({
            model,
            contents,
            config: {
              tools: [{ functionDeclarations }],
              toolConfig: {
                functionCallingConfig: {
                  mode: FunctionCallingConfigMode.ANY,
                  ...(onlySubmit ? { allowedFunctionNames: ['submit_answer'] } : {}),
                },
              },
            },
          }));
          let resp: Awaited<ReturnType<typeof generate>>;
          try {
            resp = await generate();
          } catch (err) {
            // 评论区坏图（400 "Unable to process input image"）：去掉评论图片再来
            if (imagesDropped || !job.images.length || !/Unable to process input image/i.test(err instanceof Error ? err.message : String(err))) throw err;
            console.warn(`${job.log} 评论图片无法处理，去图重试`);
            imagesDropped = true;
            contents[0] = { role: 'user', parts: (contents[0].parts ?? []).filter((p) => !p.inlineData) };
            resp = await generate();
          }
          addUsage(usage, resp.usageMetadata);

          const modelContent = resp.candidates?.[0]?.content;
          const calls = resp.functionCalls ?? [];
          if (modelContent) contents.push(modelContent);
          if (calls.length === 0) {
            contents.push({ role: 'user', parts: [{ text: '请调用 submit_answer 交答案。' }] });
            continue;
          }
          const submit = calls.find((c) => c.name === 'submit_answer');
          if (submit) return { answer: (submit.args ?? {}) as Record<string, unknown>, turns: turn, usage };

          const responses: Part[] = [];
          for (const call of calls) {
            const output = await job.callTool(call.name ?? '', (call.args ?? {}) as Record<string, unknown>);
            responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { output } } });
          }
          if (job.mustSubmit()) responses.push({ text: job.submitNudge });
          contents.push({ role: 'user', parts: responses });
        }
        return { answer: null, turns: MAX_TURNS, usage };
      } finally {
        if (uploaded?.name) await genai.files.delete({ name: uploaded.name }).catch(() => undefined);
      }
    },
  };
}
