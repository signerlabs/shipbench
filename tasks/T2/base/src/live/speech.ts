/**
 * 小熊的声音与预合成配音（PRD §11.6）：课上实时合成（web/src/live/volcFrames.ts）、配音脚本（web/scripts/gen-lesson-voice.ts）
 * 与后端托底生成（server/src/lib/speech.ts）共用这一份——音色、说话方式与文字都一致，配音的名字才对得上。纯函数，浏览器、Node 与 Worker 通用。
 */

/** 火山豆包语音合成 2.0 */
export const TTS_MODEL = "seed-tts-2.0";
/** Charlotte：英式女声（产品负责人 2026-09-29 从 7 个候选里选定） */
export const SPEAKER = "en_female_authoritative-british_uranus_bigtts";
/** 合成的说话方式（不计费）：像耐心的老师对小孩子说话 */
export const STYLE = "Speak warmly and patiently, like a kind tutor talking to a seven-year-old.";
/** 小熊的声音：24kHz */
export const OUT_RATE = 24_000;

/** 配音的声音版本：模型、音色、说话方式与格式；任何一项变了，名字全变，旧配音不再命中（托底会按新声音重新生成） */
export const CLIP_VOICE = `${TTS_MODEL}|${SPEAKER}|${STYLE}|mp3-${OUT_RATE}-64k`;

/** 一段话的配音名：「声音版本＋文字」的 SHA-256 取前 32 位；文字差一个字就是另一段 */
export async function clipKey(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${CLIP_VOICE}\n${text}`));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** 配音在 R2 桶 lesson-speech 里的位置 */
export const clipPath = (key: string) => `lesson/${key}.mp3`;
/** 核对没通过的记号（记下原文与听到的）：同一段不再反复生成；文字改了名字就变，自然重来 */
export const clipRejectedPath = (key: string) => `lesson/${key}.rejected.json`;

/** 火山单向流式合成（HTTP）：生成一段 mp3 配音 */
export function clipTtsRequest(text: string, apiKey: string): [string, RequestInit] {
  return [
    "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "X-Api-Resource-Id": TTS_MODEL, "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { uid: "app" },
        req_params: {
          text,
          speaker: SPEAKER,
          audio_params: { format: "mp3", sample_rate: OUT_RATE, bit_rate: 64_000 },
          additions: JSON.stringify({ explicit_language: "en", context_texts: [STYLE] }),
        },
      }),
    },
  ];
}

/** 合成的回应：一行一个 JSON，音频按 base64 分段返回，接起来就是完整的 mp3；出错抛错 */
export function clipAudio(body: string): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const j = JSON.parse(line) as { code?: number; message?: string; data?: string };
    if (j.data) parts.push(Uint8Array.from(atob(j.data), (ch) => ch.charCodeAt(0)));
    else if (j.code && j.code !== 20000000) throw new Error(`TTS failed (${j.code}): ${j.message}`);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (!out.length) throw new Error("TTS returned no audio");
  return out;
}

/** 转写核对：gpt-4o-transcribe 把配音转回文字（请它把数字与分数写成词，便于和原文比） */
export function transcribeRequest(mp3: Uint8Array, apiKey: string): [string, RequestInit] {
  const form = new FormData();
  form.append("model", "gpt-4o-transcribe");
  form.append("prompt", "Bruno, a bear astronaut, teaches maths to a child. British English. Write numbers and fractions in words, like three twelfths.");
  form.append("file", new Blob([mp3], { type: "audio/mpeg" }), "line.mp3");
  return ["https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form }];
}

/** 比较符号的读法（两边是数或字母时前面加 is） */
const COMPARE: Record<string, string> = { "≥": "greater than or equal to", "≤": "less than or equal to", "≠": "not equal to" };
/** 速度与时长单位缩写的全称 */
const UNIT_WORDS: Record<string, string> = { km: "kilometres", cm: "centimetres", m: "metres", h: "hour", min: "minute", s: "second" };

/**
 * 实时合成前把板上的写法换成读法（2026-10-01 逐类实测火山合成）：练习、闯关题的问法与大脑的话照原文实时合成，这些写法会念错——
 * × 时而念成 by；余数的 R 照字母念；「50: 5 tens」连读成 fifty-five tenths；「1 h 30 min」念成 one hundred thirty minute；
 * 「80 m/min」把数念错；算式里当空格的 ? 与「3.?2」里的方框念不出来；< 念成 hash；≈ 只念 approximately；钟面上的 6.15 念成小数。
 * ≥ ≤ ≠ √ ∛（六年级）照字面念不全，换成读法；+ − ÷ = 分数、带分数、钱、¢、%、°、cm²、cm³、千分位、a.m./p.m. 本来就念得对，不动；比 3 : 5 本也念得对，为了比里当空格的 ? 统一换成 to。只换送去合成的文字，字幕照原文；
 * 讲解课、例题、演示的预合成配音不经这里（那些话按读法写，PRD §7.7）。clock：显示板上有钟，裸写的 6.15 是钟点，按 6:15 念（six fifteen）
 */
export function speakable(text: string, clock = false): string {
  const t = clock ? text.replace(/(^|[^\d$.])(\d{1,2})\.(\d{2})(?!\d)/g, "$1$2:$3") : text;
  return (
    t
      // 冒号后面紧接着数（「Which pair makes 10: 6 and 3, …」）：念成问句再列选项，免得前后两个数连读；题号「Question 3: 5 + 3」断成两句
      .replace(/(Question \d+):\s+(?=\d)/g, "$1. ")
      .replace(/(\d):\s+(?=\d)/g, "$1? ")
      // 比 3 : 5（含当空格的 ?）读 to
      .replace(/([\d?])\s+:\s+(?=[\d?])/g, "$1 to ")
      // 小数里的方框 3.?2 读 box，算式里当空格的 ? 读 what（先于换 ×，靠算式符号认出空格）
      .replace(/(\d)\.\?(?=\d)/g, "$1 point box ")
      .replace(/([\d)]\s*[=+−×÷]\s*)\?/g, "$1what")
      .replace(/\?(\s*[=+−×÷]\s*[\d(])/g, "what$1")
      // × 读 times；4 × 4 数独、方格是尺寸，读 by
      .replace(/(\d)\s*×\s*(\d+)(?=\s+(?:Sudoku|grid)\b)/g, "$1 by $2")
      .replace(/\s*×\s*/g, " times ")
      .replace(/(\d)\s*R\s*(?=\d)/g, "$1 remainder ")
      // 问这个符号什么意思时不念出它的意思
      .replace(/\bsign\s*[≈≥≤≠]/g, "sign")
      .replace(/\s*≈\s*/g, " is approximately equal to ")
      // 六年级：≥ ≤ ≠ 在两个数或字母之间读 is …，单独出现（列出几个符号）不带 is；√49 读 the square root of 49，∛64 读 the cube root of 64
      .replace(/((?:^|[^A-Za-z])[A-Za-z]|[\d)?²³])\s*([≥≤≠])\s*(?=[\d(?−-]|[A-Za-z](?![A-Za-z]))/g, (_, a: string, sym: string) => `${a} is ${COMPARE[sym]} `)
      .replace(/\s*([≥≤≠])\s*/g, (_, sym: string) => ` ${COMPARE[sym]} `)
      .replace(/∛\s*/g, "the cube root of ")
      .replace(/√\s*/g, "the square root of ")
      .replace(/(\d)\s*>\s*(?=\d)/g, "$1 is greater than ")
      .replace(/(\d)\s*<\s*(?=\d)/g, "$1 is less than ")
      .replace(/\s*>\s*/g, " greater than ")
      .replace(/\s*<\s*/g, " less than ")
      .replace(/\b(km|cm|m)\/(h|min|s)\b/g, (_, a: string, b: string) => `${UNIT_WORDS[a]} per ${UNIT_WORDS[b]}`)
      .replace(/\b(\d+)\s+(h|min|s)\b/g, (_, n: string, u: string) => `${n} ${UNIT_WORDS[u]}${n === "1" ? "" : "s"}`)
      .replace(/\s+([?.,!])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

/** 数的英文读法：个位与十几、整十、倍数单位 */
const UNITS: Record<string, number> = Object.fromEntries(
  ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].map((w, i) => [w, i]),
);
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000 };
/** 分母的读法换成数：three twelfths 与 3/12 对得上 */
const DENOMINATORS: Record<string, string> = {
  half: "2", halves: "2", third: "3", thirds: "3", quarter: "4", quarters: "4", fourth: "4", fourths: "4", fifth: "5", fifths: "5",
  sixth: "6", sixths: "6", seventh: "7", sevenths: "7", eighth: "8", eighths: "8", ninth: "9", ninths: "9", tenth: "10", tenths: "10",
  eleventh: "11", elevenths: "11", twelfth: "12", twelfths: "12", hundredth: "100", hundredths: "100",
};
/**
 * 算式符号换成读法（连字符 one-half 不算减号）；横杠只在两个数字之间算减号，两边带空格夹在词之间的是停顿
 * （转写常把停顿写成 " - "，当成 minus 会把读对的配音拦下），停顿两边的数也不合成一个（one hundred - ninety 不是 190）
 */
const PAUSE = "zzpause";
const SYMBOLS: [RegExp, string][] = [[/\+/g, " plus "], [/(\d)\s*[−-]\s*(?=\d)/g, "$1 minus "], [/−/g, " minus "], [/\s[-–—]\s|—|–/g, ` ${PAUSE} `], [/=/g, " equals "], [/×/g, " times "], [/÷/g, " divided by "]];

/**
 * 连着的数的读法合成一个数（forty one → 41，three thousand six hundred → 3600，one hundred and twenty → 120）；
 * 两个个位数挨着（数数 one two three）各算各的
 */
function mergeNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  let total = 0, group = 0, last: "" | "unit" | "tens" | "scale" = "";
  const flush = () => {
    if (last) out.push(String(total + group));
    total = group = 0;
    last = "";
  };
  for (const [i, t] of tokens.entries()) {
    if (t in UNITS || t in TENS) {
      const v = UNITS[t] ?? TENS[t];
      // 十位后面接个位（forty one）、百千后面接数（hundred twenty）才连起来，其余另起一个数
      if (!(last === "scale" || (last === "tens" && t in UNITS && v < 10))) flush();
      group += v;
      last = t in TENS ? "tens" : "unit";
    } else if (t in SCALES && last) {
      if (t === "hundred") group = (group || 1) * 100;
      else {
        total += (group || 1) * SCALES[t];
        group = 0;
      }
      last = "scale";
    } else if (t === "and" && last === "scale" && (tokens[i + 1] in UNITS || tokens[i + 1] in TENS)) {
      continue;
    } else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

/** 单位缩写的全称（转写常把念的 centimetres 写成 cm） */
const UNIT_ABBR: Record<string, string> = { mm: "millimetres", cm: "centimetres", km: "kilometres", ml: "millilitres", kg: "kilograms" };

/** 比较前的归一：小写、符号换成读法、千分位去逗号、去撇号与标点，数与分母的英文读法换成阿拉伯数字（原文与转写各有各的写法） */
const words = (s: string) =>
  mergeNumbers(
    SYMBOLS.reduce((t, [re, word]) => t.replace(re, word), s.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/['’]/g, ""))
      // 念的 take away 转写常写成减号
      .replace(/\btake away\b/g, "minus")
      // 钱与百分数：原文写符号，转写多半写成词（$250 → 250 dollars，$2.50 → 2 dollars and 50 cents，9% → 9 percent，50¢ → 50 cents，£3 → 3 pounds）
      .replace(/\$\s?(\d+)\.(\d\d)\b/g, (_, d: string, c: string) => (d === "0" ? ` ${+c} cents ` : ` ${d} dollars and ${+c} cents `))
      .replace(/\$\s?(\d[\d.]*)/g, " $1 dollars ").replace(/£\s?(\d[\d.]*)/g, " $1 pounds ").replace(/(\d)\s?¢/g, "$1 cents ").replace(/(\d)\s?%/g, "$1 percent ").replace(/\bper cent\b/g, "percent")
      // 单位：念的是全称，转写常写缩写（5 cm、250 mL），缩写换回全称；美式拼写 meter／liter 换成英式
      .replace(/\b(mm|cm|km|ml|kg)\b/g, (u) => UNIT_ABBR[u]).replace(/(met|lit)er(s?)\b/g, "$1re$2")
      .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean),
  ).filter((w) => w !== PAUSE).map((w) => DENOMINATORS[w] ?? (w === "maths" ? "math" : w));

/** 按字符算编辑距离 */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * 配音读得对不对：原文与转写归一后按字符比较（人名的拼法 Mei Ling／Meiling 只差一两个字符），差的不超过 6%（至少容许 3 个）；
 * 漏读一个词组、一句话就拦下。拦不住个别词读错（如 1 R 5 读成 our five），靠写法规则：念的话用读法写
 */
export function clipMatches(text: string, heard: string): { ok: boolean; errors: number } {
  const expected = words(text).join(" ");
  const errors = editDistance(expected, words(heard).join(" "));
  return { ok: errors <= Math.max(3, Math.round(expected.length * 0.06)), errors };
}
