/**
 * 五国路线图（PRD §7.2、ADR #43）：五国共用一个星库，每国给每颗星定主线阶段、拓展或不显示。
 * 正本在 curriculum/roadmaps/<国>.json（带说明与放宽前置的理由）；构建图谱时校验并生成精简版 graph/roadmaps.json 给前后端用。
 */
/** 首发五国（展示顺序：首站新加坡在前） */
export const COUNTRIES = ["sg", "cn", "us", "uk", "au"] as const;
export type Country = (typeof COUNTRIES)[number];
/** 还没选国家的老账号按新加坡算（产品负责人 2026-10-06 定） */
export const DEFAULT_COUNTRY: Country = "sg";
export const isCountry = (v: unknown): v is Country => typeof v === "string" && (COUNTRIES as readonly string[]).includes(v);

/** main = 本国主线（计入阶段解锁）；ext = 拓展（可学、不计入解锁）；hidden = 别国特有，本国不显示 */
export type RoadmapKind = "main" | "ext" | "hidden";
export interface RoadmapEntry {
  kind: RoadmapKind;
  /** 0 = 学前，1–6 = 年级（按本国学制第几年）；不显示的为 -1 */
  stage: number;
}

/** 精简版 graph/roadmaps.json 的结构 */
export interface RoadmapsJson {
  countries: string[];
  /** 国家 → 星 → "m3"（主线第 3 阶段）／"e4"（拓展放第 4 阶段）／"h"（不显示） */
  stars: Record<string, Record<string, string>>;
  /** 国家 → 本国放宽的 hard 前置，写成 "前置>后继" */
  relaxed: Record<string, string[]>;
}

export function readEntry(code: string | undefined): RoadmapEntry | null {
  if (!code) return null;
  if (code === "h") return { kind: "hidden", stage: -1 };
  const stage = Number(code.slice(1));
  if (!Number.isInteger(stage)) return null;
  return { kind: code[0] === "m" ? "main" : "ext", stage };
}

/** 本国学制第几年的孩子大约几岁（教学大脑按它定说话深浅）：一年级 6–7 岁，英国 Year 1 早一年入学、5–6 岁 */
export function stageAges(country: Country, stage: number): [number, number] {
  const s = Math.min(Math.max(stage, 0), 6);
  if (s === 0) return country === "uk" ? [4, 5] : [4, 6];
  const start = (country === "uk" ? 4 : 5) + s;
  return [start, start + 1];
}
