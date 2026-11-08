import type { NodeContent } from "../lesson/knowledge/types.ts";

/**
 * 实时课的共用小工具（PRD §0 / §3.4 / §11.6 / ADR #34、#40）：学习者情况、阶段英文名、范围三圈、开场的进度事实。纯函数，测试直接跑。
 * 产品语言为英文（ADR #32）：给模型的指令与念给孩子的话都用英文；代码注释仍用中文。
 * 课上只有教学大脑一个模型（见 brain.ts）：小熊说的每句话都由它写，识别与合成用火山豆包语音（web/src/live/volcVoice.ts）。
 */

export interface LearnerContext {
  /** 这个知识点对应的年龄段，如 [4, 6]；缺省按小学生说话 */
  ages?: [number, number];
  /** 已点亮的前置知识点名称 */
  litPrereqs: string[];
  /** 还没点亮的前置知识点名称 */
  missingPrereqs: string[];
}

export const agesOf = (learner: LearnerContext) => (learner.ages ? `${learner.ages[0]}–${learner.ages[1]}-year-old` : "primary school");

/** 七段航程的英文名（新加坡叫法）：开场的进度总结与界面上的阶段名（journeyState.ts）共用这一份 */
export const STAGE_NAMES_EN = ["Preschool", "Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6"];

/** 范围三圈写成一段话（大脑指令用） */
export const scopeText = (c: NodeContent) =>
  `Today's lesson covers: ${c.scope.core.join("; ")}. It is fine to talk briefly, in one or two sentences, about: ${c.scope.nearby.join("; ")}; then come back to the lesson. Anything else (for example ${c.scope.avoid.join("; ")}) is for another day: say so kindly and bring the child back to the board.`;

/** 开场用的进度事实：程序算好，大脑写进开场白 */
export interface ProgressFacts {
  /** 最近点亮的另一颗星与点亮时间（图谱里的英文星名） */
  lastLit?: { name: string; at: string };
  /** 这颗星：第一次学、上次没过关、已点亮过（来复习） */
  thisNode: "new" | "retry" | "lit";
  /** 所在航段：英文名、已点亮／总数／解锁下一段要点亮的颗数；next 为下一段的英文名（最后一段没有） */
  stage: { name: string; lit: number; total: number; need: number; next?: string };
}

/** 按本地日期说 today／yesterday／N days ago */
export function dayWord(at: string, now: Date = new Date()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(new Date(at))) / 86_400_000);
  return diff <= 0 ? "today" : diff === 1 ? "yesterday" : `${diff} days ago`;
}

/** 把进度事实写成给模型看的一段话（模型再用一句口语说给孩子） */
export function describeProgress(f: ProgressFacts, now: Date = new Date()): string {
  const parts: string[] = [];
  parts.push(f.lastLit ? `the child lit up the star "${f.lastLit.name}" ${dayWord(f.lastLit.at, now)} (say its name in simple English)` : "the child has just started the journey and hasn't lit up any stars yet");
  const { name, lit, total, need, next } = f.stage;
  parts.push(`${lit} of ${total} stars are lit on the ${name} leg${next && lit < need ? `, and ${need - lit} more will unlock the flight to ${next}` : ""}`);
  parts.push(f.thisNode === "retry" ? "last time this star needed a little more light, so today is another try" : f.thisNode === "lit" ? "this star is already lit, so today is a review" : "today is the first time learning this star");
  return parts.join("; ") + ".";
}
