/**
 * 参数化题（PRD §7.6 / ADR #34）：数值由程序在范围内抽取并满足约束，问法、显示板、答案、提示里的 {表达式} 由程序计算，
 * 答案不会出错。表达式只支持整数四则、取余、比较、&&、||、括号与 min/max/floor/ceil/round/abs，不执行任意代码。
 * 文字模板另有三种写法（结果是文字，不会被当成数）：
 * - {ord:表达式} 序数：1st、2nd、3rd、4th、11th、21st……
 * - {plural:表达式:单数[:复数]} 按数取单复数：{plural:n:cube} → cube／cubes，{plural:n:is:are} → is／are（复数缺省按 -s／-es 规则）
 * - {pick:表达式:词0:词1:…} 按表达式的值（从 0 数起）取词，比较结果为 1 或 0：{pick:a>b:no:yes}、{pick:p<=3:right:left}
 * - {sep:表达式} 大数加千分位逗号：{sep:a*1000} → 12,000（念给孩子听也不会读错）
 * 另有 gcd／lcm（最大公因数、最小公倍数），约分可写 {a/gcd(a,b)}/{b/gcd(a,b)}。算出的非整数去掉浮点尾巴（0.1*3 → 0.3）。
 * 纯函数，校验脚本与课堂共用。
 */

export type Env = Record<string, number>;

const gcdOf = (a: number, b: number): number => { a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b)); while (b) [a, b] = [b, a % b]; return a; };

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs,
  gcd: (...a) => a.reduce((x, y) => gcdOf(x, y)),
  lcm: (...a) => a.reduce((x, y) => (x && y ? Math.abs(Math.round(x) * Math.round(y)) / gcdOf(x, y) : 0)),
};

/** 计算一个表达式（比较与逻辑运算得 1 或 0）；有未知变量、语法错误或除以 0 时抛错 */
export function evaluate(expr: string, env: Env): number {
  const src = expr.replace(/\s+/g, "");
  let i = 0;
  const peek = (s: string) => src.startsWith(s, i);
  const eat = (s: string) => { if (peek(s)) { i += s.length; return true; } return false; };
  const fail = (m: string): never => { throw new Error(`expression "${expr}": ${m}`); };

  const primary = (): number => {
    if (eat("(")) { const v = or(); if (!eat(")")) fail("missing closing parenthesis"); return v; }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    const id = /^[a-zA-Z_]\w*/.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      if (eat("(")) {
        const fn = FUNCS[id[0]] ?? fail(`unknown function ${id[0]}`);
        const args = [or()];
        while (eat(",")) args.push(or());
        if (!eat(")")) fail("missing closing parenthesis in function call");
        return fn(...args);
      }
      if (!(id[0] in env)) fail(`uses undefined parameter ${id[0]}`);
      return env[id[0]];
    }
    return fail(`cannot read character ${i + 1}`);
  };
  const unary = (): number => (eat("-") ? -unary() : primary());
  const mul = (): number => {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) { const d = unary(); if (d === 0) fail("division by 0"); v /= d; }
      else if (eat("%")) { const d = unary(); if (d === 0) fail("remainder by 0"); v %= d; }
      else return v;
    }
  };
  const add = (): number => {
    let v = mul();
    for (;;) {
      if (eat("+")) v += mul();
      else if (peek("-")) { i += 1; v -= mul(); }
      else return v;
    }
  };
  const cmp = (): number => {
    const v = add();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (eat(op)) {
        const w = add();
        return Number(op === "<=" ? v <= w : op === ">=" ? v >= w : op === "==" ? v === w : op === "!=" ? v !== w : op === "<" ? v < w : v > w);
      }
    }
    return v;
  };
  const and = (): number => { let v = cmp(); while (eat("&&")) { const w = cmp(); v = Number(!!v && !!w); } return v; };
  const or = (): number => { let v = and(); while (eat("||")) { const w = and(); v = Number(!!v || !!w); } return v; };

  const v = or();
  if (i !== src.length) fail(`unexpected text at character ${i + 1}`);
  if (!Number.isFinite(v)) fail("result is not a finite number");
  // 去掉浮点尾巴：0.1*3 = 0.30000000000000004 → 0.3（整数原样）
  return Number.isInteger(v) ? v : Math.round(v * 1e9) / 1e9;
}

/** 数字写成文字：整数原样，小数最多四位（去掉末尾的 0） */
export const formatNumber = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4));

/** 大数加千分位逗号：12000 → 12,000；小数部分照写 */
export const withCommas = (v: number) => {
  const [int, dec] = formatNumber(v).split(".");
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${dec ? `.${dec}` : ""}`;
};

/** {…} 是模板；要写真的花括号（如运算顺序里的 { }）写成 {{ 与 }} */
const TEMPLATE = /\{\{|\}\}|\{([^{}]+)\}/g;

/** 序数词：1st、2nd、3rd、4th……11th、12th、13th、21st */
export function ordinal(v: number): string {
  const n = Math.round(v), tail = n % 100;
  return `${n}${tail >= 11 && tail <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
}

/** 规则复数：辅音加 y 结尾改 ies，-s、-x、-sh、-ch 结尾加 es，其余加 s（不规则的在模板里写明复数） */
export const pluralWord = (word: string) =>
  /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(s|x|sh|ch)$/.test(word) ? `${word}es` : `${word}s`;

/** 文字模板的种类：ord／plural／pick／sep 得文字，其余是算式 */
function splitTemplate(inner: string): { kind: "ord" | "plural" | "pick" | "sep" | "expr"; expr: string; words: string[] } {
  const [head, ...rest] = inner.split(":");
  const kind = head.trim();
  if ((kind === "ord" || kind === "plural" || kind === "pick" || kind === "sep") && rest.length) return { kind, expr: rest[0], words: rest.slice(1).map((w) => w.trim()) };
  return { kind: "expr", expr: inner, words: [] };
}

/** 算一个 {…}：算式得数，ord／plural／pick／sep 得文字 */
function fillOne(inner: string, env: Env): string {
  const t = splitTemplate(inner);
  const v = evaluate(t.expr, env);
  if (t.kind === "ord") return ordinal(v);
  if (t.kind === "sep") return withCommas(v);
  if (t.kind === "plural") {
    if (!t.words[0]) throw new Error(`template "{${inner}}" needs a singular word`);
    return v === 1 ? t.words[0] : (t.words[1] ?? pluralWord(t.words[0]));
  }
  if (t.kind === "pick") {
    const word = t.words[v];
    if (word === undefined) throw new Error(`template "{${inner}}" gives ${v}, which has no matching word`);
    return word;
  }
  return formatNumber(v);
}

/** 文字里的 {…} 全部换成算出的数或词，{{ 与 }} 换成花括号本身 */
export const fillText = (text: string, env: Env) =>
  text.replace(TEMPLATE, (m, e: string | undefined) => (e === undefined ? m[0] : fillOne(e, env)));

/** 模板里用到的参数名（校验引用是否都已定义；ord／plural／pick／sep 只看算式部分） */
export function templateVars(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TEMPLATE)) if (m[1] !== undefined) for (const id of splitTemplate(m[1]).expr.match(/[a-zA-Z_]\w*/g) ?? []) if (!(id in FUNCS)) out.push(id);
  return out;
}

/** 可复现的伪随机数（同一种子同一串数），[0, 1) */
export function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 按范围抽参数并满足全部约束；最多试 400 次，抽不出来返回 null（校验时报错）。
 * params 形如 { a: [1, 9], b: [1, 9] }（含两端的整数范围），where 形如 ["a+b<=10", "a>b"]。
 */
export function drawParams(params: Record<string, [number, number]>, where: string[] = [], random: () => number = Math.random): Env | null {
  const names = Object.keys(params);
  for (let tries = 0; tries < 400; tries++) {
    const env: Env = {};
    for (const n of names) {
      const [lo, hi] = params[n];
      env[n] = lo + Math.floor(random() * (hi - lo + 1));
    }
    if (where.every((w) => evaluate(w, env) !== 0)) return env;
  }
  return null;
}

/** 这些字段永远是文字：整串恰好是一个 {算式} 也不换成数（如文字板 "{n}"、规律里的一项、选项、标签） */
const TEXT_KEYS = new Set(["text", "label", "left", "right", "sequence", "options", "accept", "unit", "ask", "hints", "explain", "rubric", "title"]);

/**
 * 把一段数据里的模板全部算出来：数值字段的字符串恰好是 "{算式}" 时换成数字（显示板的数值字段），
 * 文字字段与其余字符串里的 {…} 换成文字，"?" 与普通文字原样保留。
 */
export function resolveTemplates<T>(value: T, env: Env, asText = false): T {
  if (typeof value === "string") {
    const whole = asText ? null : /^\{([^{}]+)\}$/.exec(value);
    return (whole && splitTemplate(whole[1]).kind === "expr" ? evaluate(whole[1], env) : fillText(value, env)) as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, env, asText)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, env, asText || TEXT_KEYS.has(k))])) as T;
  }
  return value;
}
