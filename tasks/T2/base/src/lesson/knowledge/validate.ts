import { beatOffsets } from "../board/beats.ts";
import { checkBoard, decimalPlaces, type Widget } from "../board/widgets.ts";
import { demoLine, exampleLine, teachLines } from "../../live/brain.ts";
import { instantiateItem } from "./items.ts";
import { seededRandom, templateVars } from "./params.ts";
import type { Beat, Item, NodeContent, TeachStep } from "./types.ts";

/**
 * 知识点内容 v2 的结构与数量校验（PRD §7.6）。errors 必须清零；warnings 提醒人工看一眼（如提示里可能露了答案）。
 * graph 传入时，再核对节点 id、阶段与前置是否与图谱一致。纯函数，课堂加载与 npm run check:knowledge 共用。
 */
export interface GraphInfo {
  nodes: Map<string, { stage: number; prereqs: string[] }>;
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/** 话术禁用说法（铁律 §0.2 的英文同义） */
const BANNED = ["tutor", "cram", "guarantee", "score boost", "boost your score", "boost scores", "ahead of school", "get ahead of", "head start", "top the class", "top of the class"];
const CJK = /[㐀-鿿＀-￯]/;
/** 分数答案的写法：3/4、1 1/2、-2/3，或整数 */
const FRACTION = /^-?(\d+|\d+\/\d+|\d+ \d+\/\d+)$/;

const str = (v: unknown, min = 1, max = 1000) => typeof v === "string" && v.trim().length >= min && v.length <= max;
const strs = (v: unknown, min: number, max: number) => Array.isArray(v) && v.length >= min && v.length <= max && v.every((s) => str(s));

/** 数值答案有没有在一段话里原样出现（前后不接数字） */
const mentions = (text: string, n: number) => new RegExp(`(^|[^\\d.])${String(n).replace(".", "\\.")}([^\\d]|$)`).test(text);

export function checkContent(raw: unknown, graph?: GraphInfo): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);
  const c = raw as NodeContent;
  if (!c || typeof c !== "object") return { errors: ["not a JSON object"], warnings };

  // —— 元数据 ——
  if (c.schema !== 2) err("schema must be 2");
  if (!str(c.nodeId)) err("missing nodeId");
  if (!Number.isInteger(c.version) || c.version < 1) err("version must be an integer ≥ 1");
  if (!str(c.title, 3, 80)) err("title must be 3–80 characters");
  if (!Number.isInteger(c.stage) || c.stage < 0 || c.stage > 6) err("stage must be 0–6");
  if (!Array.isArray(c.ages) || c.ages.length !== 2 || !c.ages.every((a) => Number.isInteger(a) && a >= 3 && a <= 13) || c.ages[0] > c.ages[1]) err("ages must be [min, max] within 3–13");
  if (!c.syllabus || !Array.isArray(c.syllabus.moe)) err("syllabus.moe must be an array (may be empty for now)");
  if (!Array.isArray(c.prerequisites) || !c.prerequisites.every((p) => str(p))) err("prerequisites must be an array of node ids");
  if (!strs(c.objectives, 2, 4)) err("objectives must have 2–4 entries");

  // —— 核心讲解 ——
  const core = c.core;
  if (!core) err("missing core");
  else {
    if (!str(core.standard, 40)) err("core.standard is too short (≥ 40 characters)");
    if (!str(core.plain, 30)) err("core.plain is too short (≥ 30 characters)");
    if (!core.demo) err("missing core.demo");
    else {
      errors.push(...checkBoard(core.demo.board, "core.demo.board"));
      if (!strs(core.demo.steps, 2, 5)) err("core.demo.steps must have 2–5 sentences");
      else checkBeats(core.demo.board, core.demo.beats, demoLine(c), "core.demo", err);
    }
    if (!Array.isArray(core.vocabulary) || core.vocabulary.length < 2 || core.vocabulary.length > 6 || !core.vocabulary.every((v) => str(v?.term) && str(v?.meaning))) err("core.vocabulary must have 2–6 {term, meaning} entries");
    if (core.teach === undefined) err("missing core.teach");
    else {
      checkTeach(core.teach, err, warn);
      if (Array.isArray(core.teach)) checkTeachStyle(c, warn);
    }
  }

  // —— 常见错法 ——
  const misIds = new Set<string>();
  if (!Array.isArray(c.misconceptions) || c.misconceptions.length < 2 || c.misconceptions.length > 5) err("misconceptions must have 2–5 entries");
  else for (const [i, m] of c.misconceptions.entries()) {
    if (!/^m-\d+$/.test(m?.id ?? "")) err(`misconceptions[${i}] id must be m-<number>`);
    else if (misIds.has(m.id)) err(`duplicate misconceptions id: ${m.id}`);
    else misIds.add(m.id);
    if (!str(m?.wrong) || !str(m?.why) || !str(m?.fix)) err(`misconceptions[${i}] needs wrong, why and fix`);
  }

  // —— 题目 ——
  const ids = new Set<string>();
  const checkItem = (it: Item, where: string, idPattern: RegExp) => {
    const at = `${where} ${it?.id ?? "?"}`;
    if (!it || typeof it !== "object") return err(`${where} is not an object`);
    if (!idPattern.test(it.id ?? "")) err(`${at}: id must match ${idPattern.source}`);
    else if (ids.has(it.id)) err(`${at}: duplicate id`);
    else ids.add(it.id);
    if (![1, 2, 3].includes(it.level)) err(`${at}: level must be 1, 2 or 3`);
    const idLevel = /^[pt]-(\d)-/.exec(it.id ?? "")?.[1];
    if (idLevel && Number(idLevel) !== it.level) err(`${at}: level ${idLevel} in the id does not match level ${it.level}`);
    if (!str(it.kind, 3, 60)) err(`${at}: kind must be 3–60 characters`);
    if (!str(it.ask, 8, 240)) err(`${at}: ask must be 8–240 characters`);
    if (!strs(it.hints, 2, 3)) err(`${at}: hints must have 2–3 entries`);
    if (!str(it.explain, 20)) err(`${at}: explain is too short (≥ 20 characters)`);
    for (const m of it.misconceptions ?? []) if (!misIds.has(m)) err(`${at}: misconceptions refers to nonexistent ${m}`);
    const a = it.answer;
    if (!a || !["number", "fraction", "choice", "text", "open"].includes(a.type)) err(`${at}: answer.type must be number, fraction, choice, text or open`);
    else {
      // 选择题：答案与选项可以随参数变（{pick:…}），是否在选项里留到出数后逐次核对
      const templated = /\{/.test(String(a.value)) || (Array.isArray(a.options) && a.options.some((o) => /\{/.test(String(o))));
      if (a.type === "choice" && (!Array.isArray(a.options) || a.options.length < 2 || (!templated && !a.options.includes(String(a.value))))) err(`${at}: choice items need at least 2 options, with value among them`);
      if (a.type === "open" && !str(a.rubric, 10)) err(`${at}: open items need a rubric (≥ 10 characters)`);
      if ((a.type === "text" || a.type === "open" || a.type === "fraction") && !str(a.value)) err(`${at}: answer.value cannot be empty`);
      if (a.accept !== undefined && !Array.isArray(a.accept)) err(`${at}: accept must be an array`);
      // 选择题的 accept 不能收别的选项（收了等于选哪个都算对）：答案固定时不收错误选项；答案随参数变时不写死任何一个选项
      if (a.type === "choice" && Array.isArray(a.options) && Array.isArray(a.accept)) {
        const norm = (v: unknown) => String(v).trim().toLowerCase();
        const fixed = a.options.filter((o) => !/\{/.test(String(o))).map(norm);
        const wrong = templated && /\{/.test(String(a.value)) ? fixed : fixed.filter((o) => o !== norm(a.value));
        const leak = a.accept.filter((x) => !/\{/.test(String(x)) && wrong.includes(norm(x)));
        if (leak.length) err(`${at}: accept must not list other options (${leak.join(", ")}); any choice would count as right`);
      }
    }
    // 参数：引用的参数都要定义；抽 20 次都能出题，显示板摆得下、答案是数
    const params = it.params ?? {};
    for (const [k, r] of Object.entries(params)) {
      if (!/^[a-z]\w*$/.test(k)) err(`${at}: parameter name ${k} must start with a lowercase letter`);
      if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isInteger) || r[0] > r[1]) err(`${at}: parameter ${k} must be an integer range [min, max]`);
    }
    const texts: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect({ ask: it.ask, board: it.board, answer: it.answer, hints: it.hints, explain: it.explain });
    const unknown = [...new Set(texts.flatMap(templateVars))].filter((v) => !(v in params));
    if (unknown.length) return err(`${at}: template uses undefined parameter ${unknown.join(", ")}`);
    for (const w of it.where ?? []) for (const v of templateVars(`{${w}}`)) if (!(v in params)) err(`${at}: where uses undefined parameter ${v}`);
    const samples = it.params ? 20 : 1;
    // 泄底：每次出数都查（参数化题换了数可能撞上），同一道题只提醒一次
    let leaked = false;
    for (let s = 0; s < samples; s++) {
      let inst;
      try {
        inst = instantiateItem(it, seededRandom(1000 + s));
      } catch (e) {
        return err(`${at}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const boardErrs = checkBoard(inst.board, `${at} board`);
      const withParams = (m: string) => (it.params ? `${m} (params ${JSON.stringify(inst.params)})` : m);
      if (boardErrs.length) { errors.push(...boardErrs.map(withParams)); return; }
      if (inst.answer.type === "choice" && !(inst.answer.options ?? []).includes(String(inst.answer.value))) return err(withParams(`${at}: filled-in answer "${inst.answer.value}" is not in options ${JSON.stringify(inst.answer.options)}`));
      if (inst.answer.type === "fraction") {
        const v = String(inst.answer.value);
        if (!FRACTION.test(v) || /\/0+$/.test(v)) return err(withParams(`${at}: fraction answer must be written as "3/4", "1 1/2" or a whole number, got "${v}"`));
        if (!leaked && [inst.ask, ...inst.hints].some((t) => t.includes(v))) {
          leaked = true;
          warn(withParams(`${at}: answer ${v} appears in ask or hints; make sure it does not give the answer away`));
        }
      }
      if (inst.answer.type === "number") {
        const v = inst.answer.value;
        if (typeof v !== "number" || !Number.isFinite(v)) return err(`${at}: number answer does not evaluate to a number: ${JSON.stringify(v)}`);
        if (decimalPlaces(v) > 3) return err(withParams(`${at}: answer ${v} has more than 3 decimal places (inexact division or floating-point error?)`));
        // 学前到二年级只用整数；三年级起小数是正常的
        if (!Number.isInteger(v) && c.stage < 3) warn(`${at}: answer ${v} is not a whole number; check it suits the stage`);
        if (!leaked) {
          const where = [mentions(inst.ask, v) ? "ask" : "", ...inst.hints.map((h, k) => (mentions(h, v) ? `hint ${k + 1}` : ""))].filter(Boolean);
          if (where.length) {
            leaked = true;
            warn(withParams(`${at}: answer ${v} appears in ${where.join(", ")}; make sure it does not give the answer away`));
          }
        }
      }
    }
    return undefined;
  };

  const ext = c.extension;
  if (!ext) err("missing extension");
  else {
    if (!strs(ext.realLife, 3, 8)) err("extension.realLife must have 3–8 entries");
    if (!str(ext.whyItMatters, 30)) err("extension.whyItMatters is too short (≥ 30 characters)");
    if (!Array.isArray(ext.challenge) || ext.challenge.length < 1 || ext.challenge.length > 3) err("extension.challenge must have 1–3 items");
    else ext.challenge.forEach((it, i) => { checkItem(it, `extension.challenge[${i}]`, /^c-\d+$/); if (it?.level !== 3) err(`extension.challenge[${i}]: challenge items must be level 3`); });
  }

  if (!Array.isArray(c.examples) || c.examples.length < 3 || c.examples.length > 5) err("examples must have 3–5 entries");
  else for (const [i, e] of c.examples.entries()) {
    const at = `examples[${i}] ${e?.id ?? "?"}`;
    if (!/^e-\d+$/.test(e?.id ?? "")) err(`${at}: id must be e-<number>`);
    else if (ids.has(e.id)) err(`${at}: duplicate id`);
    else ids.add(e.id);
    if (!str(e?.title, 3, 80) || !str(e?.question, 8) || !str(e?.answer)) err(`${at}: needs title, question and answer`);
    if (!strs(e?.steps, 3, 6)) err(`${at}: steps must have 3–6 sentences`);
    errors.push(...checkBoard(e?.board, `${at} board`));
    if (str(e?.question) && strs(e?.steps, 3, 6)) checkBeats(e.board, e.beats, exampleLine(e), at, err);
    for (const m of e?.misconceptions ?? []) if (!misIds.has(m)) err(`${at}: misconceptions refers to nonexistent ${m}`);
  }

  if (!Array.isArray(c.practice)) err("missing practice");
  else {
    c.practice.forEach((it, i) => checkItem(it, `practice[${i}]`, /^p-\d-\d+$/));
    for (const level of [1, 2, 3]) {
      const n = c.practice.filter((it) => it?.level === level).length;
      if (n < 4) err(`practice needs at least 4 level ${level} items, has ${n}`);
    }
    if (c.practice.length > 30) err(`practice has ${c.practice.length} items, max 30`);
    if (c.practice.filter((it) => it?.params).length < 2) err("practice needs at least 2 parameterised items (params)");
  }

  const t = c.test;
  if (!t) err("missing test");
  else {
    if (!Number.isInteger(t.count) || t.count < 1 || t.count > 5) err("test.count must be 1–5");
    if (!Number.isInteger(t.passScore) || t.passScore < 1 || t.passScore > t.count) err("test.passScore must be between 1 and count");
    if (!Array.isArray(t.plan) || t.plan.length !== t.count || !t.plan.every((l) => [1, 2, 3].includes(l))) err("test.plan must give a level (1–3) for each question, with length equal to count");
    if (!Array.isArray(t.items)) err("missing test.items");
    else {
      t.items.forEach((it, i) => checkItem(it, `test.items[${i}]`, /^t-\d-\d+$/));
      for (const level of new Set(t.plan ?? [])) {
        const n = t.items.filter((it) => it?.level === level).length;
        if (n < 2) err(`test.items needs at least 2 level ${level} items to choose from, has ${n} (retries use different items)`);
      }
    }
  }

  const sc = c.scope;
  if (!sc || !strs(sc.core, 2, 8) || !strs(sc.nearby, 2, 8) || !strs(sc.avoid, 1, 8)) err("scope needs core (2–8), nearby (2–8) and avoid (1–8)");

  // —— 全文：英文、禁用说法 ——
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (path !== "nodeId" && !path.startsWith("prerequisites") && CJK.test(v)) err(`${path}: must be in English; found Chinese or full-width characters`);
      const low = v.toLowerCase();
      for (const b of BANNED) if (low.includes(b)) err(`${path}: uses banned phrase "${b}"`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(c, "");

  // —— 与图谱一致 ——
  if (graph && str(c.nodeId)) {
    const node = graph.nodes.get(c.nodeId);
    if (!node) err(`node ${c.nodeId} is not in the graph`);
    else {
      if (node.stage !== c.stage) err(`stage must be ${node.stage} (from the graph)`);
      for (const p of c.prerequisites ?? []) if (!graph.nodes.has(p)) err(`prerequisites: ${p} is not in the graph`);
      const missing = node.prereqs.filter((p) => !(c.prerequisites ?? []).includes(p));
      if (missing.length) warn(`graph prerequisites missing from prerequisites: ${missing.join(", ")}`);
    }
  }
  return { errors, warnings };
}

/**
 * 讲解课：6–14 步、步号 s-1 起依次编号，每步一块板、1–3 句；想一想 2–5 个（答案不随参数变，不放在这一步的话里）；
 * 板上图示至少三种（讲解要有图有例，不只是算式）
 */
function checkTeach(teach: TeachStep[], err: (m: string) => void, warn: (m: string) => void) {
  if (!Array.isArray(teach) || teach.length < 6 || teach.length > 14) return err("core.teach must have 6–14 steps");
  const types = new Set<string>();
  let checks = 0;
  for (const [i, s] of teach.entries()) {
    const at = `core.teach[${i}] ${s?.id ?? "?"}`;
    if (s?.id !== `s-${i + 1}`) err(`${at}: id must be s-${i + 1} (numbered in order)`);
    if (!str(s?.title, 3, 60)) err(`${at}: title must be 3–60 characters`);
    if (!strs(s?.say, 1, 3) || s.say.some((l) => l.length > 240)) err(`${at}: say must have 1–3 sentences of up to 240 characters`);
    const boardErrs = checkBoard(s?.board, `${at} board`);
    boardErrs.forEach(err);
    if (!boardErrs.length) for (const w of s.board) types.add(w.type);
    if (Array.isArray(s?.beats)) for (const b of s.beats) for (const w of Array.isArray(b?.board) ? b.board : []) types.add(w.type);
    if (strs(s?.say, 1, 3)) checkBeats(s.board, s.beats, teachLines(s)[0], at, err);
    const q = s?.check;
    if (!q) continue;
    checks++;
    if (!str(q.ask, 8, 240)) err(`${at}: check.ask must be 8–240 characters`);
    if (!strs(q.hints, 1, 2)) err(`${at}: check.hints must have 1–2 entries`);
    if (!str(q.explain, 20)) err(`${at}: check.explain is too short (≥ 20 characters)`);
    const a = q.answer;
    if (!a || !["number", "fraction", "choice", "text"].includes(a.type)) err(`${at}: check.answer.type must be number, fraction, choice or text`);
    else if (a.type === "number" ? typeof a.value !== "number" : !str(a.value)) err(`${at}: check.answer.value must be ${a.type === "number" ? "a number" : "non-empty text"}`);
    else if (a.type === "choice" && (!Array.isArray(a.options) || a.options.length < 2 || !a.options.includes(String(a.value)))) err(`${at}: choice checks need at least 2 options, with value among them`);
    else if (a.type === "fraction" && !FRACTION.test(String(a.value))) err(`${at}: fraction answer must be written as "3/4", "1 1/2" or a whole number`);
    else if (typeof a.value === "number" ? [...(s.say ?? []), q.ask].some((t) => mentions(t, a.value as number)) : a.type === "fraction" && [...(s.say ?? []), q.ask].some((t) => t.includes(String(a.value)))) {
      warn(`${at}: check answer ${a.value} appears in what Bruno says before asking; make sure it does not give the answer away`);
    }
  }
  if (checks < 2 || checks > 5) err(`core.teach must have 2–5 quick checks, has ${checks}`);
  if (types.size < 3) warn(`core.teach boards use only ${types.size} kinds of diagram (${[...types].join(", ")}); aim for at least 3`);
}

/**
 * 动效节拍（PRD §7.8）：at 依次出现在这一段念的原文里（数数一个数一拍，所以最多 12 拍）；每拍是一块合规的板，
 * 前面已有的图示按原顺序保留、种类不变，新图示只加在末尾；和上一块板一模一样的拍没有用
 */
function checkBeats(base: Widget[], beats: Beat[] | undefined, text: string, at: string, err: (m: string) => void) {
  if (beats === undefined) return;
  if (!Array.isArray(beats) || beats.length < 1 || beats.length > 12) return err(`${at}: beats must have 1–12 entries`);
  const offsets = beatOffsets(text, beats);
  let prev: Widget[] = Array.isArray(base) ? base : [];
  beats.forEach((b, k) => {
    const here = `${at} beats[${k}]`;
    if (!str(b?.at, 1, 80)) err(`${here}: at must be 1–80 characters`);
    else if (offsets[k] < 0) err(`${here}: "${b.at}" is not in what Bruno says (after the previous beat)`);
    const boardErrs = checkBoard(b?.board, `${here} board`);
    boardErrs.forEach(err);
    if (boardErrs.length) return;
    if (b.board.length < prev.length || prev.some((w, i) => b.board[i].type !== w.type)) err(`${here}: keep the earlier diagrams in the same order and add new ones only at the end`);
    else if (JSON.stringify(b.board) === JSON.stringify(prev)) err(`${here}: the board is the same as before; change something or drop this beat`);
    prev = b.board;
  });
}

/** 讲解课按年级的长度（PRD §7.7）：步数、想一想个数、每步念的词数 */
const teachSize = (stage: number) =>
  stage <= 1 ? { steps: [6, 8], checks: [2, 2], words: 30 } : stage <= 4 ? { steps: [8, 11], checks: [3, 3], words: 40 } : { steps: [10, 13], checks: [3, 4], words: 45 };

/** 照原文念的话里不该有的写法（合成会读错，板上可以用）：+ − × ÷ = / ° ² 等符号、「数 R 数」的余数、数后面的单位缩写 */
const SPOKEN_SYMBOLS = /[+×÷=°²√]|\d\s*[−–]\s*\d|\d\s*\/\s*\d|\b\d+\s*R\s*\d|\b\d+\s?(?:cm|mm|km|kg|ml|m|g|l)\b/;

/**
 * 讲解课写作规范的提醒（PRD §7.7）：长度按年级；讲解课、例题与演示照原文念的话不用符号；
 * 不带想一想的步骤不以问句结尾（孩子一答就打断讲解）
 */
function checkTeachStyle(c: NodeContent, warn: (m: string) => void) {
  const teach = c.core.teach ?? [];
  const size = teachSize(c.stage);
  const checks = teach.filter((s) => s?.check).length;
  if (teach.length < size.steps[0] || teach.length > size.steps[1]) warn(`core.teach has ${teach.length} steps; aim for ${size.steps[0]}–${size.steps[1]} at this stage`);
  if (checks < size.checks[0] || checks > size.checks[1]) warn(`core.teach has ${checks} quick checks; aim for ${size.checks.join("–")} at this stage`);
  const spoken: [string, string][] = [];
  for (const [i, s] of teach.entries()) {
    if (!Array.isArray(s?.say)) continue;
    const words = s.say.join(" ").split(/\s+/).filter(Boolean).length;
    if (words > size.words) warn(`core.teach[${i}] ${s.id}: ${words} words; aim for at most ${size.words} at this stage`);
    if (!s.check && /\?\s*$/.test(s.say[s.say.length - 1] ?? "")) warn(`core.teach[${i}] ${s.id}: ends with a question but has no quick check; the child's answer would cut the teaching short`);
    s.say.forEach((line, k) => spoken.push([`core.teach[${i}] ${s.id} say[${k}]`, line]));
    if (s.check) spoken.push([`core.teach[${i}] ${s.id} check.ask`, s.check.ask]);
  }
  for (const e of c.examples ?? []) [e?.question, ...(e?.steps ?? [])].forEach((line, k) => spoken.push([`examples ${e?.id} ${k ? `steps[${k - 1}]` : "question"}`, line]));
  (c.core.demo?.steps ?? []).forEach((line, k) => spoken.push([`core.demo.steps[${k}]`, line]));
  for (const [at, line] of spoken) {
    if (typeof line === "string" && SPOKEN_SYMBOLS.test(line)) warn(`${at}: read aloud as written, so write maths in words (three twelfths, divided by, centimetres), not symbols: "${line.slice(0, 60)}"`);
  }
}

/** 课堂加载用：校验不过直接抛错（带前几条原因），由特写层的错误边界兜住 */
export function validateContent(raw: unknown): NodeContent {
  const { errors } = checkContent(raw);
  if (errors.length) throw new Error(`lesson ${(raw as NodeContent)?.nodeId ?? "?"} content is invalid: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? ` (${errors.length} problems in total)` : ""}`);
  return raw as NodeContent;
}
