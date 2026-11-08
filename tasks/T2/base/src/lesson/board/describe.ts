import { BOX_KEYS, boxStep, prismView, daysInMonth, longDivision, parsePosition, parseTime, placeDigits, planeRange, SERIES_COLORS, shapePoints, SUANPAN_PLACES, suanpanDigits, suanpanRods, timeText, type BoxKey, type Color, type Currency, type Num, type Widget } from "./widgets.ts";

/**
 * 把显示板写成一句英文，交给小熊与教学大脑（它们看不见板面）。数量照实写：
 * 小熊据此当场判对错，但不念给孩子（孩子自己看板，指令里另有交代）。纯函数。
 */

/** 图标、容器与图形的英文读法：不规则的写明单复数，其余按规则（-y → -ies，-s／-x／-sh／-ch → -es） */
const NAMES: Record<string, [string, string]> = {
  child: ["child", "children"], fish: ["fish", "fish"], sheep: ["sheep", "sheep"], grapes: ["bunch of grapes", "bunches of grapes"],
  icecream: ["ice cream", "ice creams"], schoolbag: ["school bag", "school bags"], bread: ["loaf of bread", "loaves of bread"],
  jeans: ["pair of jeans", "pairs of jeans"], dice: ["dice", "dice"], corn: ["corn cob", "corn cobs"], juice: ["juice box", "juice boxes"],
  milk: ["glass of milk", "glasses of milk"], water: ["drop of water", "drops of water"], paper: ["sheet of paper", "sheets of paper"],
  chocolate: ["chocolate bar", "chocolate bars"], card: ["playing card", "playing cards"], bulb: ["light bulb", "light bulbs"],
  tap: ["water tap", "water taps"], plant: ["pot plant", "pot plants"], gem: ["gem", "gems"], peach: ["peach", "peaches"],
  waterbottle: ["water bottle", "water bottles"], carton: ["big drink carton", "big drink cartons"], can: ["tin can", "tin cans"],
};
const plural = (n: number | string, word: string) => {
  const named = NAMES[word];
  if (named) return n === 1 ? named[0] : named[1];
  if (n === 1) return word;
  return /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(s|x|sh|ch)$/.test(word) ? `${word}es` : `${word}s`;
};
export const moneyText = (cents: number | string, currency: Currency = "sgd") => {
  if (typeof cents !== "number") return String(cents);
  const big = Number.isInteger(cents / 100) ? String(cents / 100) : (cents / 100).toFixed(2);
  if (cents >= 100) return `${currency === "gbp" ? "£" : currency === "cny" ? "¥" : "$"}${big}`;
  // 人民币：角是十分（5 jiao），不足一角写分（2 fen）
  if (currency === "cny") return cents % 10 === 0 ? `${cents / 10} jiao` : `${cents} fen`;
  return `${cents}${currency === "gbp" ? "p" : currency === "aud" ? "c" : "¢"}`;
};
/** 位值与数量：1 ten、2 tens，「?」照写 */
const units = (v: number | string, word: string) => `${v} ${v === 1 ? word : `${word}s`}`;
const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
const ordinal = (n: number | string) => {
  if (typeof n !== "number") return String(n);
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};
/** 数写给模型看：整数五位以上加千分位逗号，小数去掉浮点尾巴；文字（"?"、分数）照写 */
const fmt = (v: Num | undefined) => {
  if (typeof v !== "number") return String(v ?? "");
  if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? v.toLocaleString("en-US") : String(v);
  return String(Math.round(v * 1e6) / 1e6);
};
/** 统计图第 i 组数据（或第 i 块扇形）画出来的颜色：写了就用写的，没写按画板的默认顺序 */
const seriesColor = (color: Color | undefined, i: number) => color ?? SERIES_COLORS[i % SERIES_COLORS.length];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a));
/** 分数刻度的读法：1/4、1 1/4、2；不在刻度上的点（如 8 等分刻度上的 15/16）换用能除尽的更细分母，不四舍五入到最近的刻度 */
const fractionLabel = (v: number, den: number, simplify = false) => {
  const m = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((m) => Math.abs(v * den * m - Math.round(v * den * m)) < 1e-9);
  if (m === undefined) return fmt(v);
  const d = den * m, k = Math.round(v * d), whole = Math.trunc(k / d), rest = Math.abs(k % d);
  if (!rest) return String(whole);
  // 刻度上的点照刻度写（4/8）；刻度之间的点约成最简（12/40 → 3/10）
  const g = m > 1 || simplify ? gcd(rest, d) : 1;
  return `${whole ? `${whole} ` : k < 0 ? "-" : ""}${rest / g}/${d / g}`;
};
const pointText = (p: [Num, Num]) => `(${fmt(p[0])}, ${fmt(p[1])})`;
/** 正多边形的名字（按边数） */
const REGULAR_NAMES: Record<number, string> = { 3: "equilateral triangle", 4: "square", 5: "regular pentagon", 6: "regular hexagon", 7: "regular heptagon", 8: "regular octagon", 9: "regular nonagon", 10: "regular decagon", 11: "regular 11-sided shape", 12: "regular dodecagon" };
/** 英寸尺上的读数写成最简分数（2.25 → 2 1/4），不在八分之一刻度上的照写小数 */
const eighths = (v: number) => {
  const k = Math.round(v * 8);
  if (Math.abs(v * 8 - k) > 1e-9) return fmt(v);
  const whole = Math.floor(k / 8), rest = k % 8, g = gcd(rest, 8);
  return rest ? `${whole ? `${whole} ` : ""}${rest / g}/${8 / g}` : String(whole);
};
/** 立体图形的面、棱、顶点数，以及画出来看不见的面、棱、顶点各几个（标出面、棱、顶点时写给模型）；四棱以上的棱柱按 prismView 算 */
const SOLID_PARTS: Record<string, { faces: number; edges: number; vertices: number; hiddenFaces: number; hiddenEdges: number; hiddenVertices: number }> = {
  cube: { faces: 6, edges: 12, vertices: 8, hiddenFaces: 3, hiddenEdges: 3, hiddenVertices: 1 },
  cuboid: { faces: 6, edges: 12, vertices: 8, hiddenFaces: 3, hiddenEdges: 3, hiddenVertices: 1 },
  prism: { faces: 5, edges: 9, vertices: 6, hiddenFaces: 3, hiddenEdges: 3, hiddenVertices: 1 },
  pyramid: { faces: 5, edges: 8, vertices: 5, hiddenFaces: 3, hiddenEdges: 3, hiddenVertices: 1 },
};

/** 四棱以上的棱柱按底面边数的叫法 */
const PRISM_NAMES: Record<number, string> = { 4: "square", 5: "pentagonal", 6: "hexagonal", 7: "heptagonal", 8: "octagonal" };

export function describeWidget(w: Widget): string {
  switch (w.type) {
    case "objects": {
      const groups = w.groups.map((g) => `${g.count} ${plural(g.count, g.icon)}${g.label ? ` (${g.label})` : ""}`);
      const how = w.layout === "row" ? "in a row" : w.layout === "rows" ? "in rows, one row for each group, lined up from the left" : w.layout === "scatter" ? "scattered" : w.groups.length > 1 ? "in separate groups" : "in a group";
      const marks = w.highlight === undefined ? [] : Array.isArray(w.highlight) ? w.highlight : [w.highlight];
      const front = w.front ? `, the front of the line is on the ${w.front}` : "";
      const from = typeof w.numberedFrom === "number" && w.numberedFrom > 1 ? ` starting from the ${ordinal(w.numberedFrom)} one` : "";
      const numbered = typeof w.numbered === "number" && w.numbered > 0 ? `, numbered 1 to ${w.numbered}${from}` : "";
      const ring = w.ring ? `, all circled together and labelled "${w.ring}"` : "";
      const pairs = typeof w.pairs === "number" && w.pairs > 0 ? `, the first ${w.pairs} of the top two rows matched one to one by lines` : "";
      return `${list(groups)} ${how}${front}${marks.length ? `, with the ${list(marks.map(ordinal))} ${marks.length > 1 ? "ones" : "one"}${w.front ? " from the front" : ""} highlighted` : ""}${numbered}${ring}${pairs}`;
    }
    case "equalGroups": return `${w.groups} ${plural(w.groups, w.container ?? "plate")} with ${w.perGroup} ${plural(w.perGroup, w.icon)} ${w.container === "box" || w.container === "bag" ? "in" : "on"} each${typeof w.extra === "number" && w.extra > 0 ? `, and ${w.extra} more ${plural(w.extra, w.icon)} left over outside` : ""}`;
    case "array": {
      const split = [w.split?.cols !== undefined ? `split by a dashed line after column ${w.split.cols}` : "", w.split?.rows !== undefined ? `split by a dashed line after row ${w.split.rows}` : ""].filter(Boolean);
      return `${w.hollow ? "a hollow square" : "an array"} of ${w.rows} rows with ${w.cols} ${plural(w.cols, w.icon)} in each row${w.hollow ? " (only the outside ring is filled)" : ""}${split.length ? `, ${split.join(" and ")}` : ""}`;
    }
    case "tenFrame": {
      const glow = w.glow === "row" ? ", with the full rows lit up" : w.glow === "frame" ? ", with the full ten frame lit up and labelled 10" : w.glow === "empty" ? ", with the empty boxes highlighted" : "";
      const numbered = w.numbered ? `, with counters ${w.numbered[0]} to ${w.numbered[1]} numbered` : "";
      return `${w.frames === 2 ? "two ten frames" : "a ten frame"} with ${w.filled} filled${w.icon ? ` (${plural(2, w.icon)})` : ""}${glow}${numbered}`;
    }
    case "numberBond": {
      const shownPart = w.parts.find((p) => p !== "");
      if (shownPart === undefined) return `a number bond with whole ${w.whole}, not split into parts yet`;
      // 只剩一个部分：另一部分被拿走或盖住了（动效里淡出），写清楚免得读成空的
      if (w.parts.some((p) => p === "")) return `a number bond with whole ${w.whole}; one part is ${shownPart} and the other part is not shown (taken away)`;
      return `a number bond with whole ${w.whole} and parts ${w.parts[0]} and ${w.parts[1]}`;
    }
    case "numberLine": {
      const den = typeof w.denominator === "number" ? w.denominator : 0;
      const at = (v: Num) => (den ? fractionLabel(parsePosition(v) ?? 0, den, !!w.simplify) : typeof v === "number" ? fmt(v) : String(v));
      const extra = [
        w.marks?.length ? `marked at ${list(w.marks.map(at))}` : "",
        w.jumps?.length ? `jumps ${list(w.jumps.map((j) => `from ${at(j.from)} to ${at(j.to)}${j.label ? ` (${j.label})` : ""}`))}` : "",
        w.labels?.length ? `labelled ${list(w.labels.map((l) => `"${l.text}" at ${at(l.at)}`))}` : "",
        w.hidden?.length ? `with ${list(w.hidden.map(at))} hidden as ?` : "",
        // 点图／线图：每处摞了几个点（大脑据此数、比）
        w.dots?.some((d) => d.count !== 0) ? `with ${w.dotStyle === "x" ? "X marks" : "dots"} stacked above it (a line plot): ${list(w.dots.filter((d) => d.count !== 0).map((d) => `${d.count} above ${at(d.at)}`))}` : "",
        // 不等式的解集：圈是空心还是实心、箭头朝哪边，并写明是哪些数
        w.ray ? `${w.ray.open ? "an open" : "a filled"} circle at ${at(w.ray.at)} and an arrow to the ${w.ray.dir} (numbers ${w.ray.dir === "right" ? "greater than" : "less than"}${w.ray.open ? "" : " or equal to"} ${at(w.ray.at)})` : "",
        w.segment ? `${w.segment.openFrom ? "an open" : "a filled"} circle at ${at(w.segment.from)} and ${w.segment.openTo ? "an open" : "a filled"} circle at ${at(w.segment.to)} joined by a thick line (numbers greater than${w.segment.openFrom ? "" : " or equal to"} ${at(w.segment.from)} and less than${w.segment.openTo ? "" : " or equal to"} ${at(w.segment.to)})` : "",
      ].filter(Boolean);
      const steps = den ? ` in steps of 1/${den}` : w.step && w.step !== 1 ? ` in steps of ${fmt(w.step)}` : "";
      return `a number line from ${fmt(w.from)} to ${fmt(w.to)}${steps}${extra.length ? `, ${extra.join(", ")}` : ""}`;
    }
    case "placeValue": {
      const parts = [w.hundreds !== undefined && w.hundreds !== 0 ? units(w.hundreds, "hundred") : "", units(w.tens, "ten"), units(w.ones, "one")].filter(Boolean);
      return `place value ${w.style === "abacus" ? "on an abacus" : w.style === "chart" ? "in a place value chart" : "with base-ten blocks"}: ${list(parts)}`;
    }
    case "placeChart": {
      const digits = typeof w.number === "number" ? placeDigits(w.number, w.places) : null;
      if (!digits) return `a place value chart for ${fmt(w.number)}`;
      const hide = new Set(w.hide ?? []);
      const parts = digits.map((d) => `${hide.has(d.place) ? "?" : d.digit} in the ${d.place} place`);
      return `a place value chart ${w.style === "discs" ? "with number discs " : ""}showing ${list(parts)}${hide.size ? "" : ` (the number ${fmt(w.number)})`}`;
    }
    case "barModel": {
      const bars = w.bars.map((b) => `${b.label ? `${b.label}: ` : ""}${b.parts.map((p) => `${p.value === "" ? "[blank unit]" : p.value}${p.label ? ` (${p.label})` : ""}`).join(" + ")}`);
      // 缺省的 total 括在第一条上方：只有一条时就是总数；几条时说清是第一条的总长，免得被当成几条之和
      const first = w.bars[0]?.label ? `the ${w.bars[0].label} bar` : "the first bar";
      const total = w.total === undefined ? "" : w.totalSide === "right" && w.bars.length > 1 ? `; all the bars together make ${w.total}` : w.bars.length > 1 ? `; ${first} makes ${w.total} in all (marked above it)` : `; total ${w.total}`;
      return `a bar model: ${bars.join("; ")}${total}`;
    }
    case "shapes": return `shapes: ${list(w.items.map((s) => `${s.count ?? 1} ${s.size ? `${s.size} ` : ""}${s.color ? `${s.color} ` : ""}${plural(s.count ?? 1, s.shape)}`))}${w.highlight?.length ? `, with the ${list(w.highlight.map(ordinal))} circled` : ""}`;
    case "clock": {
      const mm = String(w.minute).padStart(2, "0"), ss = w.second !== undefined ? `:${String(w.second).padStart(2, "0")}` : "";
      if (w.digital === "24h") return `a digital clock (24-hour) showing ${String(w.hour).padStart(2, "0")}:${mm}${ss}`;
      const time = `${w.hour}:${mm}${ss}${w.period ? ` ${w.period}` : ""}`;
      return w.digital ? `a digital clock showing ${time}` : `a clock${w.roman ? " with Roman numerals (I to XII)" : ""} showing ${time}${w.second !== undefined ? " (with a second hand)" : ""}`;
    }
    case "money": return `money: ${list(w.items.map((m) => `${m.count} × ${moneyText(m.value, w.currency)}${m.note ? " note" : ""}`))}`;
    case "pattern": return `a pattern: ${w.sequence.map((s, i) => (w.missing?.includes(i) ? "?" : s)).join(", ")}${w.box ? `, with items ${w.box[0] + 1} to ${w.box[0] + w.box[1]} boxed as one group` : ""}${w.highlight?.length ? `, with items ${list(w.highlight.map((h) => String(h + 1)))} circled` : ""}`;
    case "lengths": {
      const items = w.items.map((l) => `${l.label} ${l.length}${w.unit ? ` ${w.unit}` : " units"}${l.start ? `, starting ${l.start} units further along` : ""}`);
      return `${w.vertical ? "heights standing on the same floor" : "lengths"}: ${list(items)}`;
    }
    case "balance": return `a balance with ${w.left || "nothing"} on the left and ${w.right || "nothing"} on the right; ${w.heavier === "same" ? "it is level" : `the ${w.heavier} side is heavier`}`;
    case "grid": return `a ${w.rows} by ${w.cols} grid (row 1 is the top${w.compass ? ", north is up" : ""}) with ${list(w.items.map((g) => `${g.label ? `${g.label} (a ${g.icon})` : `a ${g.icon}`} at row ${g.row}, column ${g.col}`))}`;
    case "pictureGraph": {
      // 半个图标：3.5 → 3 and a half pictures
      const pics = (c: Num) => {
        if (typeof c !== "number" || Number.isInteger(c)) return `${c} ${c === 1 ? "picture" : "pictures"}`;
        const whole = Math.floor(c);
        return whole ? `${whole} and a half pictures` : "half a picture";
      };
      return w.scale
        ? `a picture graph where each picture stands for ${w.scale}${w.categories.some((c) => typeof c.count === "number" && !Number.isInteger(c.count)) ? " (half a picture is drawn as its left half)" : ""}: ${list(w.categories.map((c) => `${c.label} ${pics(c.count)}${typeof c.count === "number" && typeof w.scale === "number" ? ` (${fmt(c.count * w.scale)})` : ""}`))}`
        : `a picture graph: ${list(w.categories.map((c) => `${c.label} ${c.count}`))}`;
    }
    case "hundredChart": return `a number chart from ${w.from ?? 1} to ${w.to ?? 100}${w.highlight?.length ? `, highlighting ${list(w.highlight.map(String))}` : ""}${w.missing?.length ? `, with ${list(w.missing.map(String))} missing` : ""}${w.crossed?.length ? `, with ${list(w.crossed.map(String))} crossed out` : ""}${w.circled?.length ? `, with ${list(w.circled.map(String))} circled` : ""}`;
    case "column": {
      const name = w.op === "+" ? "addition" : w.op === "-" ? "subtraction" : "multiplication";
      let partials = "";
      if (Array.isArray(w.partials)) partials = `, with the partial products written as ${list(w.partials.map((p) => fmt(p)))}`;
      else if (w.partials && typeof w.top === "number" && typeof w.bottom === "number") {
        const digits = String(w.bottom).split("").reverse().map(Number);
        partials = `, with the partial products ${list(digits.map((d, i) => fmt(w.top as number * d * 10 ** i)))} shown`;
      }
      const carries = w.carries?.some((c) => c !== null) ? `, with small carried digits ${list(w.carries.map((c, i) => (c === null ? "" : `${c} above the ${["ones", "tens", "hundreds", "thousands", "ten thousands", "hundred thousands", "millions", "ten millions"][i]} column`)).filter(Boolean))}` : "";
      const crossed = w.crossed?.length ? `, with the top ${list(w.crossed.map((i) => ["ones", "tens", "hundreds", "thousands", "ten thousands", "hundred thousands", "millions", "ten millions"][i]))} digit${w.crossed.length > 1 ? "s" : ""} crossed out` : "";
      return `a column ${name}: ${fmt(w.top)} ${w.op} ${fmt(w.bottom)} = ${fmt(w.result ?? "?")}${partials}${carries}${crossed}`;
    }
    case "division": {
      const show = w.show ?? "question";
      const head = `a long division: ${fmt(w.dividend)} ÷ ${fmt(w.divisor)}`;
      if (show === "question" || typeof w.dividend !== "number" || typeof w.divisor !== "number") return `${head}, with the quotient shown as ?`;
      const places = typeof w.places === "number" ? w.places : String(w.dividend).split(".")[1]?.length ?? 0;
      const d = longDivision(w.dividend, w.divisor, places);
      const rest = d.remainder ? (places ? " and it keeps going (not exact)" : ` remainder ${fmt(d.remainder)}`) : "";
      if (show === "working" && typeof w.steps === "number" && (w.steps < d.steps.length || w.last)) {
        // 已写出的商：从被除数第一位对齐的商里取到这一步为止，在被除数的小数点处点上小数点
        const k = Math.min(w.steps, d.steps.length), s = d.steps[k - 1];
        const digits = String(d.whole), intLen = digits.length - places, upTo = s.end;
        const q = String(Math.floor(d.whole / w.divisor)).padStart(digits.length, "0").slice(0, upTo + 1);
        const sofar = (intLen > 0 ? q.slice(0, intLen) + (q.length > intLen ? `.${q.slice(intLen)}` : "") : `0.${"0".repeat(-intLen)}${q}`).replace(/^0+(?=\d)/, "");
        // 最后一步只写到一半（last）：说清写到哪儿了
        const half = w.last === "digit" ? `; in the last step the quotient digit ${s.q} is written but not yet multiplied`
          : w.last === "product" ? `; in the last step ${s.q} × ${fmt(w.divisor)} = ${s.product} is written under ${s.part}, not yet subtracted`
          : w.last === "left" ? `; in the last step ${s.part} − ${s.product} = ${s.left} is written${k < d.steps.length ? ", and the next digit is not yet brought down" : ""}` : "";
        const next = !w.last && k < d.steps.length ? `, and the next number to divide is ${fmt(d.steps[k].part)}` : "";
        return `${head}, with only the first ${k} ${k === 1 ? "step" : "steps"} of the working shown: the quotient so far reads ${sofar}${half}${next}`;
      }
      return `${head} = ${fmt(d.quotient)}${rest}${show === "working" ? ", with every step of the working shown" : ""}`;
    }
    case "fraction": {
      const parts = Number(w.parts), shaded = Number(w.shaded);
      const shape = w.shape === "bar" ? "fraction bar" : w.shape;
      const grid = w.shape === "rectangle" && parts > 12 ? ` (a grid of ${parts} small squares)` : "";
      const label = w.label ? `, labelled "${w.label}"` : "";
      if (w.unequal) return `a ${shape} cut into ${parts} parts that are NOT equal, with ${shaded} ${shaded === 1 ? "part" : "parts"} shaded${label}`;
      const wholes = Math.max(1, Math.ceil(shaded / parts));
      if (parts === 1) return `${wholes > 1 ? `${wholes} whole ${shape}s` : `a whole ${shape}`} (not cut)${shaded ? `, ${shaded >= wholes ? "all" : shaded} shaded` : ", not shaded"}${label}`;
      const second = (typeof w.shaded2 === "number" && w.shaded2 > 0 ? ` in ${w.color ?? "blue"} and ${w.shaded2} more ${w.shaded2 === 1 ? "part" : "parts"} shaded in ${w.color2 ?? "yellow"}` : "") + (typeof w.split === "number" ? `, and each part is split into ${w.split} smaller equal parts by thin lines (${parts * w.split} small parts in all)` : "");
      if (wholes === 1) return `a ${shape} cut into ${parts} equal parts${grid}, with ${shaded} ${shaded === 1 ? "part" : "parts"} shaded${second}${label}`;
      const full = Math.floor(shaded / parts), rest = shaded - full * parts;
      return `${wholes} ${plural(wholes, shape)}, each cut into ${parts} equal parts, with ${shaded} parts shaded in all (${full} whole ${plural(full, shape)}${rest ? ` and ${rest} ${rest === 1 ? "part" : "parts"} of the next` : ""})${label}`;
    }
    case "pie": {
      const total = w.slices.reduce((s, x) => s + (typeof x.value === "number" ? x.value : 0), 0) || 1;
      const hide = new Set(w.hide ?? []);
      const show = w.show ?? (w.spinner ? "none" : "percent");
      const slice = (x: (typeof w.slices)[number], i: number) => {
        const v = typeof x.value === "number" ? x.value : 0;
        const share = show === "percent" ? `${fmt(Math.round((v / total) * 1000) / 10)}%` : show === "angle" ? `${fmt(Math.round((v / total) * 3600) / 10)}°` : show === "fraction" ? (() => { const g = gcd(Math.round(v * 1000), Math.round(total * 1000)); return `${Math.round(v * 1000) / g}/${Math.round(total * 1000) / g}`; })() : fmt(v);
        return `${x.label} (${seriesColor(x.color, i)}) ${hide.has(i) ? "? (hidden; it is really " + share + ")" : share}`;
      };
      const kind = w.spinner ? "a spinner" : `a pie chart${w.title ? ` "${w.title}"` : ""}`;
      return `${kind}: ${list(w.slices.map(slice))}${show === "none" ? " (sizes only, no numbers written)" : ""}`;
    }
    case "barChart":
    case "lineGraph": {
      const cats = w.type === "barChart" ? w.categories : w.labels;
      // 每组写明颜色（孩子和小熊常按颜色说「绿色那根柱子」）
      const mark = w.type === "barChart" ? "bars" : "line";
      const series = w.series.map((s, k) => `${s.label ? `${s.label} (${seriesColor(s.color, k)} ${mark})` : `${seriesColor(s.color, k)} ${mark}`}: ${list(cats.map((c, i) => `${c} ${fmt(s.values[i])}`))}`);
      const kind = w.type === "barChart" ? (w.histogram ? "a histogram (the bars touch, one for each group)" : w.series.length > 1 ? "a double bar graph" : "a bar graph") : w.series.length > 1 ? "a double line graph" : "a line graph";
      const every = typeof w.labelEvery === "number" ? w.labelEvery : 1;
      const scale = w.step !== undefined ? `, the scale goes up in ${fmt(w.step)}s${every > 1 ? ` (only every ${ordinal(every)} line is numbered)` : ""}` : "";
      // 条形图纵轴不从 0 开始：折断记号之后从 min 起，条的高矮差被放大
      const broken = w.type === "barChart" && typeof w.min === "number" && w.min > 0 ? `, the ${w.horizontal ? "horizontal" : "vertical"} axis does not start at 0: after a zigzag break mark it starts at ${fmt(w.min)}` : "";
      const ref = w.refLine ? `, with a dashed line across at ${fmt(w.refLine.value)}${w.refLine.label ? ` labelled "${w.refLine.label}"` : ""}` : "";
      return `${kind}${w.title ? ` "${w.title}"` : ""}${w.unit ? ` (${w.unit})` : ""}: ${series.join("; ")}${scale}${broken}${ref}${w.showValues ? ", values written on the graph" : ""}`;
    }
    case "table": {
      const row = (r: Num[]) => r.map((c) => fmt(c)).join(" | ");
      // 高亮格用表头说清楚（有表头就写列名，有行表头就写行名），免得小熊念错行列号
      const cellName = ([r, c]: [number, number]) => {
        const colName = w.header ? `column "${fmt(w.header[c])}"` : `column ${c + 1}`;
        if (r < 0) return `the header "${fmt(w.header?.[c] ?? "")}"`;
        const rowName = w.rowHeaders ? `row "${fmt(w.rows[r]?.[0])}"` : `row ${r + 1}`;
        return `${rowName}, ${colName}`;
      };
      return `a table${w.title ? ` "${w.title}"` : ""}${w.header ? ` with columns ${row(w.header)}` : ""}; rows: ${w.rows.map(row).join("; ")}${w.highlight?.length ? `; highlighted: ${list(w.highlight.map(cellName))}` : ""}`;
    }
    case "angle": {
      const kind = w.degrees === 90 ? "a right angle" : w.degrees === 180 ? "a straight angle (180°)" : w.degrees === 360 && w.rays?.length ? "angles at a point (a full turn, 360°)" : `an angle of ${fmt(w.degrees)}°`;
      // 中间的射线把大角分成几个小角：从第一条边起依次说各小角的度数与标签
      const cuts = [0, ...(w.rays ?? []).map(Number), Number(w.degrees)];
      const parts = w.rays?.length ? `, split by ${w.rays.length} more ${w.rays.length === 1 ? "ray" : "rays"} into smaller angles of ${list(cuts.slice(1).map((c, i) => `${fmt(c - cuts[i])}°${w.parts?.[i] !== undefined && w.parts[i] !== null ? ` (marked "${w.parts[i]}")` : ""}`))}` : "";
      // 有射线时整个角的标签写在角外（如平角下面的 180°）
      const mark = w.label ? (w.rays?.length ? `, the whole angle marked "${w.label}"` : `, marked "${w.label}"`) : "";
      return `${kind}${w.names ? ` (angle ${w.names.join("")})` : ""}${mark}${parts}${w.protractor ? ", with a protractor lined up on it" : ""}`;
    }
    case "plane": {
      const bits: string[] = [];
      for (const s of w.shapes ?? []) {
        const pts = shapePoints(s);
        const names = s.names?.length ? ` ${s.names.join("")}` : "";
        const sides = (s.sides ?? []).map((l, i) => (l === null || l === undefined ? "" : `side ${i + 1} labelled ${fmt(l)}`)).filter(Boolean);
        const angles = (s.angles ?? []).map((l, i) => (l === null || l === undefined ? "" : `angle at corner ${i + 1} labelled ${fmt(l)}`)).filter(Boolean);
        const right = s.right?.length ? `right angles at corner ${list(s.right.map((r) => String(r + 1)))}` : "";
        const look = [s.dashed ? "dashed" : "", s.fill === "hole" ? "cut out (not shaded)" : s.fill === "none" ? "outline only" : "", s.color ?? ""].filter(Boolean).join(", ");
        // 平行边记号：第几组画几个小箭头
        const parallel = (s.parallel ?? []).map((g, k) => `sides ${list(g.map((i) => String(i + 1)))} marked parallel (${k + 1} ${k ? "arrows" : "arrow"} on each)`);
        const marks = [...sides, ...angles, right, ...parallel].filter(Boolean).length ? `; ${[...sides, ...angles, right, ...parallel].filter(Boolean).join(", ")}` : "";
        // 正多边形：说边数、中心与半径，再列各顶点
        if (s.regular) {
          const k = Number(s.regular.sides), name = REGULAR_NAMES[k] ?? `regular ${k}-sided shape`;
          bits.push(`${/^[aeiou]/.test(name) ? "an" : "a"} ${name}${names}${s.label ? ` "${s.label}"` : ""} (${k} equal sides) centred at ${pointText(s.regular.center)}, each corner ${fmt(s.regular.r)} squares from the centre, corners at ${pts.map((p) => pointText([Math.round(Number(p[0]) * 100) / 100, Math.round(Number(p[1]) * 100) / 100])).join(", ")}${look ? ` (${look})` : ""}${s.regular.spokes ? ", with lines drawn from the centre to every corner" : ""}${marks}`);
          continue;
        }
        // 九个点以上、边多是斜的，多半是用折线近似的弧（跑道、半圆）：只说起止或所占范围，不逐点念坐标（悄悄话太长）；横平竖直的组合图形照常逐角说
        const edges = pts.slice(s.open ? 1 : 0).map((p, i, arr) => [s.open ? pts[i] : arr[(i + arr.length - 1) % arr.length], p]);
        const slanted = edges.filter(([p, q]) => Number(p[0]) !== Number(q[0]) && Number(p[1]) !== Number(q[1])).length;
        if (pts.length >= 9 && slanted * 2 > edges.length) {
          const xs = pts.map((p) => Number(p[0])), ys = pts.map((p) => Number(p[1]));
          const where = s.open ? `from ${pointText(pts[0])} round to ${pointText(pts[pts.length - 1])}` : `filling the area from (${fmt(Math.min(...xs))}, ${fmt(Math.min(...ys))}) to (${fmt(Math.max(...xs))}, ${fmt(Math.max(...ys))})`;
          bits.push(`a ${s.open ? "curved line" : "rounded shape"}${names}${s.label ? ` "${s.label}"` : ""} ${where}${look ? ` (${look})` : ""}${marks}`);
          continue;
        }
        bits.push(`a ${pts.length === 2 ? "line" : s.open ? `bent line through ${pts.length} points` : `${pts.length}-sided shape`}${names}${s.label ? ` "${s.label}"` : ""} with ${s.open ? "points" : "corners"} at ${pts.map(pointText).join(", ")}${look ? ` (${look})` : ""}${marks}`);
      }
      for (const c of w.circles ?? []) {
        bits.push(`a circle${c.label ? ` "${c.label}"` : ""} with centre ${pointText(c.center)} and radius ${fmt(c.r)} squares${c.radius !== undefined ? `, radius labelled ${fmt(c.radius)}` : ""}${c.diameter !== undefined ? `, diameter labelled ${fmt(c.diameter)}` : ""}${c.fill === "hole" ? " (cut out)" : ""}${c.color ? ` (${c.color})` : ""}`);
      }
      for (const l of w.lines ?? []) {
        const kind = l.kind === "segment" ? "a line segment" : l.kind === "ray" ? "a ray" : l.kind === "line" ? "a straight line (both ends go on)" : l.kind === "arrow" ? "an arrow" : "a line";
        const look = [l.dashed ? "dashed" : "", l.color ?? ""].filter(Boolean).join(", ");
        bits.push(`${kind}${look ? ` (${look})` : ""} from ${pointText(l.from)} to ${pointText(l.to)}${l.label ? ` labelled ${fmt(l.label)}` : ""}${l.foot ? " meeting at a right angle" : ""}`);
      }
      for (const p of w.points ?? []) bits.push(`a point${p.label ? ` ${p.label}` : ""} at ${pointText(p.at)}`);
      for (const t of w.texts ?? []) bits.push(`the words "${t.text}" written at ${pointText(t.at)}`);
      const axes = !!w.axes || w.origin !== undefined;
      const steps = axes && (w.xStep !== undefined || w.yStep !== undefined) ? `, each square is ${fmt(w.xStep ?? 1)} across and ${fmt(w.yStep ?? 1)} up on the axes` : "";
      const names = w.origin === undefined && w.axes && (w.xLabel || w.yLabel) ? `, axes named ${[w.xLabel ? `"${w.xLabel}" (across)` : "", w.yLabel ? `"${w.yLabel}" (up)` : ""].filter(Boolean).join(" and ")}` : "";
      // 四个象限：坐标按原点算，写明 x、y 的范围
      if (w.origin !== undefined) {
        const r = planeRange(w), sx = typeof w.xStep === "number" ? w.xStep : 1, sy = typeof w.yStep === "number" ? w.yStep : 1;
        const head = `a coordinate grid with the ${w.xLabel ?? "x"}-axis and ${w.yLabel ?? "y"}-axis crossing at the origin (0, 0), both with arrows at each end; ${w.xLabel ?? "x"} goes from ${fmt(r.x0 * sx)} to ${fmt(r.x1 * sx)} and ${w.yLabel ?? "y"} from ${fmt(r.y0 * sy)} to ${fmt(r.y1 * sy)}${steps}${w.grid ? "" : " (no grid lines)"}${w.compass ? ", north is up" : ""}; points are (x, y) from the origin, negative to the left and down`;
        return `${head}: ${bits.join("; ")}`;
      }
      // 等距点阵：x 是第几列点、y 是往上第几个点（奇数列错开半个点），用来画立体图
      const canvas = w.grid === "iso"
        ? `an isometric dot grid for drawing solids, ${fmt(w.width)} columns of dots across and ${fmt(w.height)} dots up (points are (column, dots up) from the bottom left; every other column is shifted up half a dot${w.compass ? "; north is up" : ""})`
        : `${w.grid === "dots" ? "a dot grid" : w.grid ? "a square grid" : "a drawing"} ${fmt(w.width)} squares wide and ${fmt(w.height)} squares high (coordinates from the bottom left${axes ? ", with numbered axes" : ""}${steps}${names}${w.compass ? ", north is up" : ""})`;
      return `${canvas}: ${bits.join("; ")}`;
    }
    case "solid": {
      // 三棱柱的 width、height 是两端三角形的底和高；四棱以上的棱柱两端是正多边形，width 是它的边长
      const sides = w.shape === "prism" && typeof w.sides === "number" && w.sides > 3 ? w.sides : 0;
      const dimName = (k: string) => (w.shape !== "prism" ? k : k === "width" ? (sides ? "side of each end face" : "triangle base") : k === "height" ? "triangle height" : k);
      const dims = (["length", "width", "height", "radius", "diameter"] as const).filter((k) => w[k] !== undefined).map((k) => `${dimName(k)} ${fmt(w[k])}`);
      const units = w.units ? ` made of ${w.units[0]} by ${w.units[1]} by ${w.units[2]} unit cubes` : "";
      const name = sides ? `${PRISM_NAMES[sides] ?? `${sides}-sided`} prism (lying on one of its long faces, a ${REGULAR_NAMES[sides] ?? `regular ${sides}-sided shape`} at each end, one end facing you)`
        : w.shape === "prism" ? "triangular prism (lying down, a triangle at each end)" : w.shape;
      const p = sides ? prismView(sides) : SOLID_PARTS[w.shape];
      const mark = !w.mark || !p ? ""
        : w.mark === "faces" ? `, with its ${p.faces} faces coloured (${p.faces - p.hiddenFaces} can be seen, ${p.hiddenFaces} are hidden from view)`
        : w.mark === "edges" ? `, with its ${p.edges} edges drawn thick (the ${p.hiddenEdges} hidden edges dashed)`
        : `, with its ${p.vertices} vertices marked as dots (${p.hiddenVertices} hidden at the back, drawn fainter)`;
      const head = `${w.color ? `${w.color} ` : ""}${name}`;
      return `${/^[aeiou]/.test(head) ? "an" : "a"} ${head}${units}${dims.length ? ` labelled ${list(dims)}` : ""}${w.water !== undefined ? `, with water in it ${fmt(w.water)} deep` : ""}${mark}${w.label ? ` ("${w.label}")` : ""}`;
    }
    case "cubes": {
      const total = w.layout.flat().reduce<number>((s, h) => s + (typeof h === "number" ? h : 0), 0);
      // 从后往前：back row、middle row（三排时）或 row 2、row 3…（更多排时）、front row
      const rows = w.layout.map((r, i) => `${i === 0 ? "back row" : i === w.layout.length - 1 ? "front row" : w.layout.length === 3 ? "middle row" : `row ${i + 1} from the back`}: ${r.join(", ")}`);
      return `a stack of ${total} unit cubes seen from the front, a little from above; the heights of the stacks, left to right, ${w.layout.length > 1 ? rows.join("; ") : `are ${w.layout[0].join(", ")}`}`;
    }
    case "ruler": {
      const unit = w.unit ?? "cm";
      // 英制写全称，读数按英寸的分数写（2 1/4 inches）
      const many = unit === "in" ? "inches" : unit === "ft" ? "feet" : unit, one = unit === "in" ? "inch" : unit === "ft" ? "foot" : unit;
      const read = (v: Num) => (unit === "in" && typeof v === "number" ? eighths(v) : fmt(v));
      const ticks = w.minor === 10 && unit === "cm" ? " with millimetre marks"
        : unit === "in" && w.minor ? ` with ${w.minor === 2 ? "half-inch" : w.minor === 4 ? "quarter-inch" : "eighth-inch"} marks`
        : unit === "ft" && w.minor === 12 ? " with inch marks (12 inches in each foot)"
        : w.minor ? ` with each ${one} split into ${w.minor}` : "";
      const items = (w.items ?? []).map((it) => `${it.label ?? (it.icon ? `a ${it.icon}` : "a strip")} from ${read(it.from)} to ${read(it.to)} ${it.to === 1 ? one : many}`);
      const start = typeof w.start === "number" && w.start ? ` marked from ${w.start} to ${w.start + Number(w.length)} ${many}` : "";
      const head = unit === "in" || unit === "ft" ? `a ${fmt(w.length)}-${one} ruler${unit === "ft" && w.length === 3 ? " (one yard long)" : ""}` : `a ${fmt(w.length)} ${unit} ruler`;
      return `${head}${start}${ticks}${items.length ? `; ${list(items)}` : ""}`;
    }
    case "gauge": {
      const kind = w.kind === "scale" ? "a weighing scale" : w.kind === "jug" ? "a measuring jug" : "a thermometer";
      const reading = w.kind === "scale" ? "the pointer is at" : w.kind === "jug" ? "the liquid comes up to" : "the reading is";
      return `${kind}${w.label ? ` labelled "${w.label}"` : ""} marked from ${fmt(w.min ?? 0)} to ${fmt(w.max)} ${w.unit} in steps of ${fmt(w.step)} ${w.unit}; ${reading} ${fmt(w.value)} ${w.unit}`;
    }
    case "calendar": {
      const y = Number(w.year), m = Number(w.month);
      const first = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { weekday: "long" });
      return `a calendar for ${MONTHS[m - 1]} ${y} (${daysInMonth(y, m)} days, the 1st is a ${first})${w.highlight?.length ? `, with the ${list(w.highlight.map(ordinal))} circled` : ""}${w.missing?.length ? `, with the ${list(w.missing.map(ordinal))} shown as ?` : ""}`;
    }
    case "timeline": {
      const f = w.format ?? "12h";
      const t = (s: string) => { const v = parseTime(s); return v === null ? s : timeText(v, f); };
      const mark = (m: string | { at: string; label?: string }) => (typeof m === "string" ? t(m) : `${t(m.at)}${m.label ? ` (labelled "${m.label}")` : ""}`);
      const extra = [
        w.marks?.length ? `marked at ${list(w.marks.map(mark))}` : "",
        w.jumps?.length ? `jumps ${list(w.jumps.map((j) => `from ${t(j.from)} to ${t(j.to)}${j.label ? ` (${j.label})` : ""}`))}` : "",
      ].filter(Boolean);
      return `a timeline from ${t(w.from)} to ${t(w.to)}, a mark every ${w.step ?? 30} minutes${extra.length ? `, ${extra.join(", ")}` : ""}`;
    }
    case "venn": {
      const totals = [w.leftTotal !== undefined ? `the whole ${w.left} circle is ${fmt(w.leftTotal)}` : "", w.rightTotal !== undefined ? `the whole ${w.right} circle is ${fmt(w.rightTotal)}` : ""].filter(Boolean);
      return `a Venn diagram with two overlapping circles${w.total ? ` inside a box "${w.total}"` : ""}: only ${w.left} ${fmt(w.leftOnly)}, both ${fmt(w.both)}, only ${w.right} ${fmt(w.rightOnly)}${w.neither !== undefined ? `, neither (outside both circles) ${fmt(w.neither)}` : ""}${totals.length ? `; ${totals.join(", ")}` : ""}`;
    }
    case "areaModel": {
      const cell = (r: number, c: number) => {
        const v = w.cells?.[r]?.[c];
        if (v === null) return "blank";
        if (v !== undefined) return fmt(v);
        const a = w.rows[r], b = w.cols[c];
        return typeof a === "number" && typeof b === "number" ? fmt(Math.round(a * b * 1e6) / 1e6) : "?";
      };
      const parts = w.rows.flatMap((_, r) => w.cols.map((_, c) => `${fmt(w.rows[r])} × ${fmt(w.cols[c])} part: ${cell(r, c)}`));
      return `an area model: a rectangle split into columns ${list(w.cols.map((c) => fmt(c)))} across and rows ${list(w.rows.map((r) => fmt(r)))} down${w.unit ? ` (lengths in ${w.unit}, areas in ${w.unit}²)` : ""}; ${parts.join("; ")}`;
    }
    case "suanpan": {
      // 逐档说珠子怎么拨（上珠当 5、下珠各当 1），大脑据此读数、判孩子拨得对不对
      const rods = suanpanRods(w), digits = suanpanDigits(w.number, rods);
      const head = `a Chinese abacus (suanpan) with ${rods} rods; an upper bead pushed to the middle bar is worth 5, each lower bead pushed to the bar is worth 1`;
      if (!digits) return `${head}; all the beads are pushed away from the bar (it shows nothing yet), with ? below the bar: the number is to be made`;
      const beads = (d: number) => [d >= 5 ? "1 upper bead" : "", d % 5 ? `${d % 5} lower ${d % 5 === 1 ? "bead" : "beads"}` : ""].filter(Boolean).join(" and ");
      const parts = digits.map((d, i) => {
        const place = SUANPAN_PLACES[rods - 1 - i];
        return d === "?" ? `${place} rod covered (?)` : `${place} ${d}${d ? ` (${beads(d)})` : ""}`;
      });
      return `${head}; ${typeof w.number === "number" ? `it shows ${fmt(w.number)}: ` : ""}${list(parts)}${w.labels ? " (each rod labelled with its place)" : ""}`;
    }
    case "fingers":
      return w.hands.length === 1 ? `a hand with ${w.hands[0]} ${Number(w.hands[0]) === 1 ? "finger" : "fingers"} up` : `${w.hands.length} hands with ${list(w.hands.map((h) => String(h)))} fingers up`;
    case "dice": {
      const what = w.card ? (w.faces.length === 1 ? "a dot card" : `${w.faces.length} dot cards`) : w.faces.length === 1 ? "a dice" : `${w.faces.length} dice`;
      const shown = w.faces.map((f) => (f === "?" ? "? (blank)" : `${f} ${Number(f) === 1 ? "spot" : "spots"}`));
      return `${what} showing ${list(shown)}${w.highlight?.length ? `, with ${list(w.highlight.map((h) => ordinal(h)))} circled` : ""}`;
    }
    case "coins": {
      // 硬币：每枚朝上的是正面（H，画着头像）还是反面（T，画着星），? 为还没看到
      const name = { H: "heads (H)", T: "tails (T)", "?": "? (not shown yet)" } as const;
      const what = w.faces.length === 1 ? "a coin" : `${w.faces.length} coins`;
      const hl = w.highlight ?? [];
      return `${what} showing ${list(w.faces.map((f) => name[f] ?? String(f)))}${hl.length ? `, with the ${list(hl.map((h) => ordinal(h)))} ${hl.length > 1 ? "ones" : "one"} circled` : ""}`;
    }
    case "tally": {
      const hide = new Set(w.hide ?? []);
      const rows = w.rows.map((r) => {
        const c = Number(r.count), g = Math.floor(c / 5), rest = c % 5;
        const how = g ? ` (${[`${g} ${g === 1 ? "group" : "groups"} of 5`, rest ? `${rest} more` : ""].filter(Boolean).join(" and ")})` : "";
        return `${r.label} ${c ? `${c} tally ${c === 1 ? "mark" : "marks"}${how}` : "no tally marks"}`;
      });
      const hidden = w.rows.filter((_, i) => hide.has(i)).map((r) => r.label);
      const totals = w.totals ? `, with a Total column${hidden.length ? ` (the ${hidden.length === 1 ? "total" : "totals"} for ${list(hidden)} shown as ?)` : ""}` : "";
      if (w.plain) return `a chart of marks${w.title ? ` "${w.title}"` : ""}, one line for each, not grouped in fives: ${list(w.rows.map((r) => `${r.label} ${r.count} ${Number(r.count) === 1 ? "mark" : "marks"}`))}${totals}`;
      return `a tally chart${w.title ? ` "${w.title}"` : ""} (each group of 5 is four lines crossed by a fifth): ${list(rows)}${totals}`;
    }
    case "flow": {
      // 按步骤顺序编号 (1)(2)…（板上可能竖排一列或排成几行）；问题写明 Yes、No 各去哪一步
      const go = (from: number, to: number) => `${to < from ? "go back to" : "go to"} (${to + 1})`;
      const boxes = w.steps.map((s, i) => {
        const kind = s.kind ?? "step";
        const branch = kind === "question" ? ` — Yes: ${go(i, s.yes ?? i + 1)}${s.no !== undefined ? `, No: ${go(i, s.no)}` : ""}` : s.next !== undefined && s.next !== i + 1 ? ` — then ${go(i, s.next)}` : "";
        return `(${i + 1}) ${kind} "${s.text}"${branch}`;
      });
      return `a flow chart, read along the arrows (each box leads to the next one unless it says where to go; an end box stops): ${boxes.join("; ")}`;
    }
    case "boxPlot": {
      // 箱线图：五个数照实写（大脑据此判对错），写 ? 的几个另外说明
      const words: Record<BoxKey, string> = { min: "minimum", q1: "lower quartile (Q1)", median: "median", q3: "upper quartile (Q3)", max: "maximum" };
      const plots = w.plots.map((p, k) => {
        const hidden = (p.hide ?? []).filter((h) => BOX_KEYS.includes(h));
        const head = p.label ? `${p.label} (${p.color ?? SERIES_COLORS[k % SERIES_COLORS.length]} box)` : `${p.color ?? SERIES_COLORS[k % SERIES_COLORS.length]} box`;
        return `${head}: ${list(BOX_KEYS.map((key) => `${words[key]} ${fmt(p[key])}`))}${hidden.length ? `; the ${list(hidden.map((h) => words[h]))} ${hidden.length > 1 ? "are" : "is"} shown as ? on the board` : ""}`;
      });
      const step = boxStep(w);
      return `${w.plots.length > 1 ? "two box plots, one above the other," : "a box plot"}${w.title ? ` "${w.title}"` : ""} over a number line from ${fmt(w.from)} to ${fmt(w.to)}${step !== null && step !== 1 ? ` in steps of ${fmt(step)}` : ""}${w.unit ? ` (${w.unit})` : ""} (whiskers from the minimum to the lower quartile and from the upper quartile to the maximum, a box from the lower to the upper quartile with a line at the median): ${plots.join("; ")}${w.showValues ? "; the other values are written on the plot" : ""}`;
    }
    case "text": {
      // 循环小数记号 0.[18]：念作 0.18，18 这几位一直重复
      const repeats = [...w.text.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
      return repeats.length ? `the text "${w.text.replace(/\[(\d+)\]/g, "$1")}" with dots over the repeating digits ${list(repeats)} (they repeat forever)` : `the text "${w.text}"`;
    }
  }
}

/** 整块板：各图示用分号连起来；空板说 empty */
export const describeBoard = (board: Widget[]) => board.map(describeWidget).join("; ") || "empty";
