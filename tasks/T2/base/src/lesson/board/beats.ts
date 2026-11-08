import type { Widget } from "./widgets.ts";

/**
 * 显示板动效的节拍（PRD §7.8 第一期）：一段话念到哪里，板换成哪一块。纯函数，浏览器、Node 与测试通用。
 * - 预合成配音有完整波形：原文按标点切成小段，与配音里的停顿按先后对上；拍落在小段开头就取那段开口的时刻，段中间按字数插值。
 * - 实时合成没有波形：按语速估，同一句里的几拍合到句首（直接出这句的最后一拍），免得画面和话对不齐。
 */

export interface BeatLike {
  at: string;
  board: Widget[];
}

/** 最后一拍的板（没有节拍就是原板）：静态显示、给大脑看的都用它 */
export const finalBoard = (board: Widget[], beats?: BeatLike[]): Widget[] => (beats?.length ? beats[beats.length - 1].board : board);

const WORD = /[A-Za-z0-9]/, DIGIT = /[0-9]/;
/**
 * at 在原文里从 from 起的位置：两头要落在词界上（「t equals 2」不能命中「140t equals 280」），
 * 数字也要整个对上（「is 1」不命中「is 1,000」，「is 3」不命中「is 3.5」）；找不到为 -1
 */
function findAt(text: string, at: string, from: number): number {
  for (let i = text.indexOf(at, from); i >= 0; i = text.indexOf(at, i + 1)) {
    const b1 = text[i - 1] ?? "", b2 = text[i - 2] ?? "", a1 = text[i + at.length] ?? "", a2 = text[i + at.length + 1] ?? "";
    const first = at[0], last = at[at.length - 1];
    const left = !WORD.test(first) || (!WORD.test(b1) && !(DIGIT.test(first) && (b1 === "," || b1 === ".") && DIGIT.test(b2)));
    const right = !WORD.test(last) || (!WORD.test(a1) && !(DIGIT.test(last) && (a1 === "," || a1 === ".") && DIGIT.test(a2)));
    if (left && right) return i;
  }
  return -1;
}

/** 每拍在原文里的字符位置：按先后依次往后找（拍与拍不重叠），找不到为 -1 */
export function beatOffsets(text: string, beats: BeatLike[]): number[] {
  const out: number[] = [];
  let from = 0;
  for (const b of beats) {
    const i = b.at ? findAt(text, b.at, from) : -1;
    out.push(i);
    if (i >= 0) from = i + b.at.length;
  }
  return out;
}

/** 一段配音的说话轮廓（秒）：开口、收声，以及中间的停顿 [开始, 结束] */
export interface SpeechShape {
  duration: number;
  onset: number;
  end: number;
  pauses: [number, number][];
}

/**
 * 从波形量出说话轮廓：10 毫秒一帧算音量，低于响度参考一成的算静音；连续静音不短于 minPause 的算停顿
 * （火山合成的句末约停 0.4–0.6 秒，逗号约 0.2–0.3 秒）。响度参考取第 95 百分位，不被个别爆音带偏
 */
export function speechShape(samples: Float32Array, rate: number, minPause = 0.12): SpeechShape {
  const hop = Math.max(1, Math.round(rate / 100));
  const frames = Math.floor(samples.length / hop);
  const time = (f: number) => (f * hop) / rate;
  const level = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) sum += samples[i] * samples[i];
    level[f] = Math.sqrt(sum / hop);
  }
  const sorted = Float32Array.from(level).sort();
  const loud = frames ? sorted[Math.min(frames - 1, Math.floor(frames * 0.95))] : 0;
  const quiet = Math.max(loud * 0.1, 1e-4);
  const voiced = (f: number) => level[f] > quiet;
  let first = 0;
  while (first < frames && !voiced(first)) first++;
  let last = frames - 1;
  while (last > first && !voiced(last)) last--;
  const pauses: [number, number][] = [];
  const minFrames = Math.max(1, Math.round((minPause * rate) / hop));
  let run = -1;
  for (let f = first; f <= last; f++) {
    if (!voiced(f)) {
      if (run < 0) run = f;
    } else if (run >= 0) {
      if (f - run >= minFrames) pauses.push([time(run), time(f)]);
      run = -1;
    }
  }
  return { duration: samples.length / rate, onset: first < frames ? time(first) : 0, end: first < frames ? time(last + 1) : 0, pauses };
}

/** 原文里的停顿点：句末（. ! ?）与逗号类（, ; : —）后面接空白的位置，即下一小段的开头 */
function textBreaks(text: string): { at: number; strong: boolean }[] {
  const out: { at: number; strong: boolean }[] = [];
  const re = /([.!?]|[,;:]|—)["'”’)\]]*\s+/g;
  for (let m; (m = re.exec(text)); ) if (m.index + m[0].length < text.length) out.push({ at: m.index + m[0].length, strong: /[.!?]/.test(m[1]) });
  return out;
}

/**
 * 原文的停顿点与配音的停顿按先后对齐（动态规划，逐段）：相邻两个对上的点之间是一小段话，代价是这段的语速偏离整段平均语速多少
 * （按字数加权，短的段语速本来就不稳）；句末没对上停顿罚得重、逗号轻，配音里多出来的停顿按长短罚（长停顿几乎都对应标点）。
 * 数数这类一字一顿的话语速慢，按字数比例估时刻会错位，按语速连续性对就对得上。返回每个停顿点对上的停顿序号（没对上为 -1）
 */
function alignBreaks(text: string, breaks: { at: number; strong: boolean }[], shape: SpeechShape): number[] {
  const n = breaks.length, m = shape.pauses.length, N = Math.max(1, text.length);
  const len = shape.pauses.map(([a, b]) => b - a);
  const pauseSum = [0];
  len.forEach((l, j) => pauseSum.push(pauseSum[j] + l));
  const skipPause = len.map((l) => 2 * Math.max(0, l - 0.1));
  const skipPauseSum = [0];
  skipPause.forEach((s, j) => skipPauseSum.push(skipPauseSum[j] + s));
  const skipBreak = breaks.map((b) => (b.strong ? 0.6 : 0.25));
  const skipBreakSum = [0];
  skipBreak.forEach((s, i) => skipBreakSum.push(skipBreakSum[i] + s));
  const rate0 = N / Math.max(0.1, shape.end - shape.onset - pauseSum[m]);
  // 点 0 是开头（开口时刻），点 n+1 是结尾（收声时刻）；点 i（1..n）是第 i 个停顿点，对上第 j 个停顿（1..m）
  const charAt = (i: number) => (i === 0 ? 0 : i === n + 1 ? N : breaks[i - 1].at);
  const startT = (j: number) => (j === 0 ? shape.onset : shape.pauses[j - 1][1]);
  const endT = (j: number) => (j === m + 1 ? shape.end : shape.pauses[j - 1][0]);
  const key = (i: number, j: number) => i * (m + 2) + j;
  const best = new Map<number, { cost: number; from: number }>([[key(0, 0), { cost: 0, from: -1 }]]);
  const states: [number, number][] = [[0, 0]];
  for (let i = 1; i <= n + 1; i++) for (let j = 1; j <= m + 1; j++) if ((i === n + 1) === (j === m + 1)) states.push([i, j]);
  for (const [i, j] of states.slice(1)) {
    let top: { cost: number; from: number } | null = null;
    for (const [pi, pj] of states) {
      if (pi >= i || pj >= j) continue;
      const prev = best.get(key(pi, pj));
      if (!prev) continue;
      const chars = charAt(i) - charAt(pi);
      const voiced = endT(j) - startT(pj) - (pauseSum[j - 1] - pauseSum[pj]);
      if (voiced <= 0.05 || chars <= 0) continue;
      const seg = Math.min(1, chars / 12) * Math.abs(Math.log(chars / voiced / rate0));
      const cost = prev.cost + seg + (skipBreakSum[i - 1] - skipBreakSum[pi]) + (skipPauseSum[j - 1] - skipPauseSum[pj]);
      if (!top || cost < top.cost) top = { cost, from: key(pi, pj) };
    }
    if (top) best.set(key(i, j), top);
  }
  const match = new Array<number>(n).fill(-1);
  for (let k = key(n + 1, m + 1); k > 0; ) {
    const i = Math.floor(k / (m + 2)), j = k % (m + 2);
    if (i >= 1 && i <= n) match[i - 1] = j - 1;
    const step = best.get(k);
    if (!step) break;
    k = step.from;
  }
  return match;
}

/** 实时合成时估算的语速（字符／秒，火山 Charlotte 实测约 13.8） */
export const CHARS_PER_SECOND = 13.8;

/**
 * 每拍的时刻（秒，从这段配音开头算，单调不减）：有说话轮廓时与停顿对齐，提前 lead 秒出手（画面动起来要一点时间）；
 * 没有轮廓（实时合成）时按语速逐字推算（数数时一个个出来，不整句挤在句首）。找不到原文的拍放到最后
 */
export function beatTimes(text: string, beats: BeatLike[], shape?: SpeechShape | null, lead = 0.05): number[] {
  const offsets = beatOffsets(text, beats).map((c) => (c < 0 ? text.length : c));
  const breaks = textBreaks(text);
  let times: number[];
  if (!shape) {
    times = offsets.map((c) => c / CHARS_PER_SECOND);
  } else {
    const N = Math.max(1, text.length);
    const match = alignBreaks(text, breaks, shape);
    // 小段：开头的字符位置与开口时刻、结尾的字符位置与收声时刻（对上的停顿开始）；没对上停顿的停顿点不分段
    const segments: { c0: number; t0: number; c1: number; t1: number }[] = [];
    let c0 = 0, t0 = shape.onset;
    breaks.forEach((b, i) => {
      if (match[i] < 0) return;
      const [ps, pe] = shape.pauses[match[i]];
      segments.push({ c0, t0, c1: b.at, t1: ps });
      c0 = b.at;
      t0 = pe;
    });
    segments.push({ c0, t0, c1: N, t1: shape.end });
    const used = new Set(match.filter((j) => j >= 0));
    const inner = shape.pauses.filter((_, j) => !used.has(j));
    times = offsets.map((c) => {
      const s = segments.find((g) => c < g.c1) ?? segments[segments.length - 1];
      // 小段开头可能有引号、空格：落在头几个非字母字符上的拍算作开口
      if (!text.slice(s.c0, c).replace(/[^A-Za-z0-9]/g, "").length) return Math.max(0, s.t0 - lead);
      // 段中间：按字数分说话的时长（扣掉段里没对上的停顿），再把落在前面的停顿加回去
      const gaps = inner.filter(([a, b]) => a >= s.t0 && b <= s.t1);
      const voiced = s.t1 - s.t0 - gaps.reduce((sum, [a, b]) => sum + b - a, 0);
      let t = s.t0 + ((c - s.c0) / Math.max(1, s.c1 - s.c0)) * voiced;
      for (const [a, b] of gaps) if (a < t) t += b - a;
      return Math.max(0, t - lead);
    });
  }
  for (let k = 1; k < times.length; k++) times[k] = Math.max(times[k], times[k - 1]);
  return times;
}

/** 时刻 t 该显示第几拍（0 = 开头的板，k = 第 k 拍）：时刻已到的拍数 */
export function beatIndexAt(times: number[], t: number): number {
  let k = 0;
  while (k < times.length && times[k] <= t) k++;
  return k;
}
