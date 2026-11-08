import type { Widget } from "../board/widgets.ts";
import { drawParams, resolveTemplates, seededRandom } from "./params.ts";
import type { Answer, Item, Level } from "./types.ts";

/** 出好数的一道题：显示板数值、问法、答案、提示、讲解都已算好，可以直接上板、交给小熊 */
export interface ItemInstance {
  id: string;
  level: Level;
  kind: string;
  ask: string;
  board: Widget[];
  answer: Answer;
  hints: string[];
  explain: string;
  misconceptions: string[];
  /** 参数化题抽到的数（便于记录与复现） */
  params?: Record<string, number>;
}

/** 出一道题：参数化题按范围抽数、满足约束后算出全部模板；抽不出来抛错（内容校验会提前发现） */
export function instantiateItem(item: Item, random: () => number = Math.random): ItemInstance {
  const env = item.params ? drawParams(item.params, item.where, random) : {};
  if (!env) throw new Error(`item ${item.id}: parameters cannot be drawn within the constraints`);
  const r = resolveTemplates({ ask: item.ask, board: item.board, answer: item.answer, hints: item.hints, explain: item.explain }, env);
  // 数字题的答案是数；选择、短语与开放题的答案是文字（"{a}" 这类整串模板也按文字）
  const answer = r.answer.type === "number" ? r.answer : { ...r.answer, value: String(r.answer.value) };
  return {
    id: item.id, level: item.level, kind: item.kind, ask: r.ask, board: r.board, answer, hints: r.hints, explain: r.explain,
    misconceptions: item.misconceptions ?? [], ...(item.params ? { params: env } : {}),
  };
}

/** 一节课一个种子：同一节课里参数化题可复现（合成语音自测与排错用） */
export const lessonRandom = (seed = Date.now()) => seededRandom(seed);

/** 念给孩子与记在账本里的答案文字：数字题写数，其余写原文；再附上也算对的说法 */
export function answerText(a: Answer): string {
  const main = typeof a.value === "number" ? String(a.value) : a.value;
  return a.accept?.length ? `${main} (also right: ${a.accept.join("; ")})` : main;
}
