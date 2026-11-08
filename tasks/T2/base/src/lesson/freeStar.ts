import { DEFAULT_COUNTRY, type Country } from "../roadmap.ts";

/**
 * 登录即送的一颗星（PRD §3.6、§4，产品负责人 2026-09-30 定）：家长注册、同意后，按孩子上学的国家与起点年级送这一颗星的完整一节课（讲解、练习、闯关），
 * 不用绑卡；点亮之前可以随时回来接着学，点亮了（或想学别的星）就要先订阅（7 天绑卡试用）。
 * 每国每档一颗，须是这国路线图里这一档的主线星（ADR #43，2026-10-06）：优先用讲解课校准星（五年级是产品负责人试过的异分母分数加减），
 * 校准星不在这一档的，取这一档里前置都在更早阶段的第一颗主线星。前端与 Worker 共用。
 */
export const FREE_STARS: Record<Country, readonly string[]> = {
  sg: ["mt_g0_x03", "mt_g1u_009", "mt_g2u_011", "mt_g3d_012", "mt_g5d_019", "mt_g4d_022", "mt_g4d_030"],
  cn: ["mt_g0_x03", "mt_g1u_009", "mt_g2u_011", "mt_g3d_012", "mt_g4d_022", "mt_g5d_019", "mt_g6u_003"],
  us: ["mt_g0_x03", "mt_g1u_016", "mt_g1u_010", "mt_g3d_012", "mt_g2d_004", "mt_g5d_019", "mt_g2u_030"],
  uk: ["mt_g0_x03", "mt_g1u_009", "mt_g2u_011", "mt_g2u_005", "mt_g3d_012", "mt_g6u_003", "mt_g4d_022"],
  au: ["mt_g0_x03", "mt_g1u_003", "mt_g2u_011", "mt_g1d_016", "mt_g3d_012", "mt_g5d_019", "mt_g2u_007"],
};

/** 起点年级（0 = 学前 … 6 = 六年级）送的那颗星；还没选年级为 undefined；没选国家的老账号按新加坡 */
export const freeStarOf = (grade: number | null | undefined, country: Country = DEFAULT_COUNTRY): string | undefined =>
  grade === null || grade === undefined || !Number.isInteger(grade) ? undefined : FREE_STARS[country][Math.min(Math.max(grade, 0), 6)];
