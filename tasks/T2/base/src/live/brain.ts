import { finalBoard } from "../lesson/board/beats.ts";
import { describeBoard } from "../lesson/board/describe.ts";
import type { Widget } from "../lesson/board/widgets.ts";
import { answerText, instantiateItem, type ItemInstance } from "../lesson/knowledge/items.ts";
import type { Answer, Beat, Item, NodeContent, TeachStep, WorkedExample } from "../lesson/knowledge/types.ts";
import { agesOf, describeProgress, scopeText, type LearnerContext, type ProgressFacts } from "./instructions.ts";

/**
 * 教学大脑（PRD §3.4 / §11.6 / ADR #31、#34、#40）：课上只有这一个会思考的模型——小熊说的每句话（开场、对答案的回应、提示、讲解、
 * 闲聊）都由它写，程序照原样合成念出；「怎么走」也由它定：孩子的话是不是在答题、对不对，下一步是等／讲解（演示、例题）／
 * 从练习题库挑题／进闯关／宣布结果、点亮后停下。题目只从知识点的题库里来：大脑只回题号，问法、显示板、答案、提示由程序从内容里取
 * （参数化题由程序出数算答案），问法由程序念；闯关题由程序按难度计划从测试题库抽。
 * 程序只记账（上过板的题、大脑对每次作答的判定），闯关分数按账本数；不解读说话内容、不设关键词。纯函数，测试直接跑。
 */

/** 课堂进度：阶段与备注由大脑给出，点亮由程序按账本结算 */
export interface LessonState {
  phase: "practice" | "challenge";
  /** 这节课已经闯关点亮 */
  starLit: boolean;
  /** 大脑写给自己的备注 */
  notes: string;
}

export const INITIAL_STATE: LessonState = { phase: "practice", starLit: false, notes: "" };

/**
 * 开场方式（PRD §3.3 / ADR #29），不让孩子选：learn 先讲解（有讲解课的从第一步讲起）再练习、再闯关，产品里一律用它；
 * test 开场直接闯关、没过再回到练习，只供调试（地址 ?mode=test、sim:live 的 SIM_MODE=test）
 */
export type LessonMode = "learn" | "test";

export const initialState = (mode: LessonMode): LessonState => ({ ...INITIAL_STATE, phase: mode === "test" ? "challenge" : "practice" });

/**
 * 叫醒大脑的时机（只看时间与事件，不看内容）：开课、孩子说完一句（识别出定稿）、小熊讲完演示或例题、
 * 问完题后久久没人说话、暂停后回来。
 */
export type BrainTrigger = "start" | "child_paused" | "bruno_done" | "silence" | "resume";

// —— 课堂账本：程序只记账、不判题 ——

/** 上过显示板的一道题与大脑对它的判定；teach 是讲解课里的想一想（不计分） */
export interface AskedQuestion {
  q: ItemInstance;
  phase: "teach" | "practice" | "challenge";
  /** 第几轮闯关（结算过几轮），练习题不用 */
  round: number;
  /** 闯关第几题（练习为 0） */
  n: number;
  /** 大脑对这题每次作答的判定，按先后；闯关题只记第一次 */
  verdicts: ("correct" | "incorrect")[];
}

export interface LessonBook {
  asked: AskedQuestion[];
  /** 孩子对板上这题说的、大脑还没判过的话（片段按到达先后接起来） */
  unjudged: string;
  /** 已结算的闯关轮数：结算后再出的闯关题算新一轮，从第 1 题数起 */
  rounds: number;
  /** 板上不是题时写着是什么（演示、例题、讲解课的一步）；空串＝最近那道题在板上 */
  display: string;
  /** 讲解课讲完了几步（下次从第几步接着讲；念完没被打断才算讲完） */
  taught: number;
}

/** 新的一节课；一开课板上是今日之星卡（COVER_DISPLAY） */
export const newBook = (display = ""): LessonBook => ({ asked: [], unjudged: "", rounds: 0, display, taught: 0 });

export const DEMO_DISPLAY = "the demonstration";
/** 开课时显示板上的今日之星卡（产品负责人 2026-09-29 定）：星名与怎么点亮，不是题；出第一题才换成题目 */
export const COVER_DISPLAY = "today's star card (the topic name and how to light the star; no question)";

/** 换上新题：记一笔，闯关题接着本轮往下编号；孩子对上一题的话清空 */
export function bookBoard(book: LessonBook, q: ItemInstance, phase: AskedQuestion["phase"]): AskedQuestion {
  const n = phase === "challenge" ? book.asked.filter((a) => a.phase === "challenge" && a.round === book.rounds).length + 1 : 0;
  const entry: AskedQuestion = { q, phase, round: book.rounds, n, verdicts: [] };
  book.asked.push(entry);
  book.unjudged = "";
  book.display = "";
  return entry;
}

/**
 * 接上一段字幕片段：句中片段自带前导空格或是标点，新的一句开头常不带空格——
 * 新片段以字母或数字开头、前文以字母数字或标点结尾时补一个空格，免得两句粘成「catsI」。
 */
export const joinSpeech = (text: string, delta: string) =>
  text + (text && /^[A-Za-z0-9]/.test(delta) && /[A-Za-z0-9.!?,…]$/.test(text) ? " " : "") + delta;

/** 孩子说的话记进账本（板上有题才记） */
export function bookHear(book: LessonBook, delta: string) {
  if (!book.asked.length || !delta) return;
  book.unjudged = joinSpeech(book.unjudged, delta);
}

/** 叫醒大脑时的账本快照：当时板上是哪题、孩子哪些话大脑看到了 */
export interface BookSnapshot {
  index: number;
  heard: string;
}

export const bookSnapshot = (book: LessonBook): BookSnapshot => ({ index: book.asked.length - 1, heard: book.unjudged });

/**
 * 大脑判了对错：记到它当时看到的那道题上（闯关题只记第一次，不许重答刷分），它看过的那些话不再算新话。
 * 没判（none）就什么都不动：可能是抢答时它还没看懂，小熊说完会再叫醒它看一次。
 * 它当时没看到孩子的新话也不记：实测它会把判过的话再判一次，练习里一次答错被记成两次、提前换题。
 */
export function bookVerdict(book: LessonBook, snap: BookSnapshot, verdict: "correct" | "incorrect" | "none") {
  const entry = book.asked[snap.index];
  if (verdict === "none" || !entry || !snap.heard.trim()) return;
  if (entry.phase !== "challenge" || !entry.verdicts.length) entry.verdicts.push(verdict);
  if (snap.index === book.asked.length - 1) {
    book.unjudged = book.unjudged.startsWith(snap.heard) ? book.unjudged.slice(snap.heard.length).trimStart() : "";
  }
}

/** 本轮闯关：出了几题、答对几题（每题按第一次判定） */
export function challengeTally(book: LessonBook) {
  const round = book.asked.filter((a) => a.phase === "challenge" && a.round === book.rounds);
  return { asked: round.length, correct: round.filter((a) => a.verdicts[0] === "correct").length };
}

/** 闯关结算：按账本上的判定算过没过；之后再出的闯关题算新一轮 */
export function settleChallenge(book: LessonBook, passScore: number) {
  const t = challengeTally(book);
  book.rounds++;
  return { ...t, passed: t.correct >= passScore };
}

/** 练习连续答对几题（每题看最后一次判定；板上这题还没答不算断，闯关题之前的不算） */
export function practiceStreak(book: LessonBook): number {
  let n = 0;
  for (let i = book.asked.length - 1; i >= 0; i--) {
    const a = book.asked[i];
    if (a.phase !== "practice") break;
    if (!a.verdicts.length && i === book.asked.length - 1) continue;
    if (a.verdicts[a.verdicts.length - 1] !== "correct") break;
    n++;
  }
  return n;
}

// —— 讲解课 ——

/**
 * 讲解课接下来讲哪几步：从 from（步号，大脑要重讲某一步时给）或上次讲到的地方起，一直讲到下一个想一想（含）为止；
 * 已经讲完、又没指定从哪讲，就从头再讲
 */
export function teachSegment(c: NodeContent, book: LessonBook, from = ""): TeachStep[] {
  const steps = c.core.teach ?? [];
  let i = steps.findIndex((s) => s.id === from);
  if (i < 0) i = book.taught < steps.length ? book.taught : 0;
  const end = steps.findIndex((s, j) => j >= i && s.check);
  return steps.slice(i, end < 0 ? steps.length : end + 1);
}

/** 讲解课的一步上板：板上写明讲到哪一步；带想一想的，把它当作板上的题记进账本（不计分，孩子的话记到它名下） */
export function bookTeach(book: LessonBook, step: TeachStep): AskedQuestion | null {
  if (!step.check) {
    book.display = `teaching step ${step.id}: ${step.title}`;
    return null;
  }
  const { ask, answer, hints, explain } = step.check;
  return bookBoard(book, { id: step.id, level: 1, kind: "Quick check", ask, board: finalBoard(step.board, step.beats), answer, hints, explain, misconceptions: [] }, "teach");
}

/** 这一步念完了：下次从它后面接着讲（重讲前面的步骤不往回退） */
export function bookTaught(c: NodeContent, book: LessonBook, step: TeachStep) {
  book.taught = Math.max(book.taught, (c.core.teach ?? []).indexOf(step) + 1);
}

/** 讲解课这一步小熊要念的：先念这一步的话，带想一想的再单独问一句（各占一个字幕气泡，问题留在屏上给孩子看） */
export const teachLines = (step: TeachStep) => [joinSay(...step.say), ...(step.check ? [step.check.ask] : [])];

/** 例题念的：问法接着分步讲解 */
export const exampleLine = (ex: WorkedExample) => joinSay(ex.question, ...ex.steps);

/** 演示念的 */
export const demoLine = (c: NodeContent) => joinSay(...c.core.demo.steps);

/**
 * 这节课里写死、每次都一样的话（讲解课、例题、演示）：可以预先合成成音频（PRD §11.6），课上与生成脚本都从这里取，文字一字不差才对得上。
 * 大脑现写的话与参数化题的问法每次不同，仍实时合成
 */
export const fixedLines = (c: NodeContent) => [...new Set([...(c.core.teach ?? []).flatMap(teachLines), ...c.examples.map(exampleLine), demoLine(c)])];

// —— 从题库取题 ——

/** 下一道闯关题：按难度计划取本轮第 n 题的难度，在该难度里挑这节课用得最少的一道（重闯换题），同样少时按题库顺序 */
export function pickTestItem(c: NodeContent, book: LessonBook): Item {
  const n = challengeTally(book).asked;
  const level = c.test.plan[Math.min(n, c.test.plan.length - 1)];
  const pool = c.test.items.filter((it) => it.level === level);
  const used = (id: string) => book.asked.filter((a) => a.q.id === id).length;
  return (pool.length ? pool : c.test.items).reduce((best, it) => (used(it.id) < used(best.id) ? it : best));
}

/** 大脑挑的练习题；题号不在题库里时，挑这节课用得最少的一道（同样少时按题库顺序，即由易到难） */
export function pickPracticeItem(c: NodeContent, book: LessonBook, id: string): Item {
  const found = c.practice.find((it) => it.id === id);
  if (found) return found;
  const used = (key: string) => book.asked.filter((a) => a.q.id === key).length;
  return c.practice.reduce((best, it) => (used(it.id) < used(best.id) ? it : best));
}

// —— 大脑的指令、决定格式与叫醒材料 ——

/** 交给大脑的答案：选择题另按先后列出选项，孩子说「第二个」「最后那个」也能判 */
const answerForBrain = (a: Answer) =>
  a.type === "choice" && a.options?.length ? `${answerText(a)}; options in order: ${a.options.map((o) => `"${o}"`).join(", ")}` : answerText(a);

const teachStepLine = (s: TeachStep) =>
  `- ${s.id} ${s.title}: "${s.say.join(" ")}"${s.check ? ` → quick check: "${s.check.ask}" (answer: ${answerForBrain(s.check.answer)})` : ""}`;

const itemLine = (it: Item) =>
  `- ${it.id} (level ${it.level}, ${it.kind}): "${it.ask}"${it.params ? " — the app picks the numbers each time" : ` — answer: ${answerForBrain(it.answer)}`}`;

/** 大脑的指令：知识点内容、题库、课的走法、判题原则、决定的写法（英文，产品语言为英文） */
export function buildBrainInstructions(c: NodeContent, learner: LearnerContext, mode: LessonMode = "learn"): string {
  const teach = c.core.teach ?? [];
  const start = mode === "test"
    ? "1. Start (trigger \"start\"): this star is from an earlier leg the child is catching up on, so the lesson opens with the star challenge: skip the teaching and practice. The opening comes in two parts that Bruno says one after the other. intro: \"Hi, astronaut!\" and then one short sentence, about 15 words, on the child's progress (talk to them as \"you\"; say any star names in simple English). intro_today: one or two short sentences, about 20 words: today we start with the star challenge for this topic, and if it's tricky we'll practise together. No self-introduction. Then next is \"challenge\" (phase \"challenge\") and say is \"\" (the app asks challenge question 1)."
    : teach.length
      ? "1. Start (trigger \"start\"): the board shows today's star card (no question yet), and the opening comes in two parts that Bruno says one after the other. intro: \"Hi, astronaut!\" and then one short sentence, about 15 words, on the child's progress (talk to them as \"you\"; say any star names in simple English). intro_today: one or two short sentences, about 20 words: what today's topic is in the simple way, and that you'll show them how it works first. No self-introduction. Then next is \"teach\" (item_id \"\") and say is \"\": the teaching starts."
      : "1. Start (trigger \"start\"): the board shows today's star card (no question yet), and the opening comes in two parts that Bruno says one after the other. intro: \"Hi, astronaut!\" and then one short sentence, about 15 words, on the child's progress (talk to them as \"you\"; say any star names in simple English). intro_today: three short sentences, about 35 words: what today's topic is in the simple way, one everyday example, and why it matters. No self-introduction. Then next is \"practice\" with an easy level 1 item and say is \"Let's begin!\".";
  const teaching = teach.length
    ? "2. Teaching and practice. The teaching comes first: before any practice, the app shows the teaching steps below one by one: each step puts its board up and Bruno reads its lines, and a step with a quick check ends by asking it and waits for the child. Quick checks are not marked; they keep the child thinking. React to a check answer as in practice: praise a right answer in a few words, without explaining it again (the next step carries on from there); if it's wrong the first time, say kindly what went wrong and give the check's hint, and let them try again (next \"none\"); if it's wrong again, explain it using the check's explanation. Then carry on with next \"teach\" (item_id \"\"). The steps do the explaining, so keep your say short during the teaching (one or two sentences); if the child asks a question, answer it simply from the lesson plan, then carry on with next \"teach\". When the teaching is finished (trigger \"bruno_done\" after the last step), say something short like \"Now it's your turn!\" and go to practice with an easy level 1 item. If the child asks to skip to the star challenge, you may. Practice: go from easy to hard."
    : "2. Practice: go from easy to hard.";
  return [
    `You are the teacher brain behind Bruno, a bear astronaut and AI learning companion who teaches maths by voice to ${agesOf(learner)} children on a spaceship. Bruno's voice reads out exactly what you write in intro, intro_today and say, and nothing else: everything Bruno says comes from you, except the questions, which the app reads. So write as Bruno, in the first person ("I", "let me show you"), and never talk about Bruno by name. You decide how the lesson goes, and you choose what goes on the display board.`,
    "You teach from the approved lesson plan below. Questions come only from the question bank, by id: never invent a question, a method or a fact that is not in the plan. The app puts the chosen question on the board and reads it out, so your say never contains the question itself and never announces or describes it (no \"Question 3: …\", no reading out the next question, no \"let's try a kite next\"): just react and, if you like, say something short like \"Here's the next one.\"",
    "React to every answer yourself, at the start of say: in practice, praise a right answer in a few words; for a wrong one, first say kindly that it isn't right yet and what went wrong (for example, a thing counted twice, or the wrong part counted), without giving the answer and without saying how far off it is (never \"one too many\" or \"two less\", which gives the answer away), then give the next hint. In the star challenge, say \"That's right!\" for a right answer; for a wrong one, kindly explain why it's wrong and how to get it, in two or three short sentences, using that question's explanation (it still counts as wrong: no second try). Your input lists the hints and the explanation for the question on the board.",
    "The app keeps the record for you: every question that went on the board and how you judged each answer. Trust the record and the counts it gives; don't count from the conversation.",
    "",
    `Topic: "${c.title}"`,
    `Lesson mode: ${mode === "test" ? "challenge first (a star from an earlier leg: the star challenge starts right away; if the star isn't lit, practise and try again)" : "learn then test (explain, practise, then the star challenge)"}`,
    `Learning goals: ${c.objectives.join("; ")}`,
    `Standard explanation: ${c.core.standard}`,
    `Simple explanation: ${c.core.plain}`,
    `Demonstration (next "demo" shows it; Bruno says these steps): ${c.core.demo.steps.join(" ")}`,
    ...(teach.length
      ? [`Teaching steps (next "teach" plays them in order from where the teaching stopped, up to and including the next quick check; item_id with a step id goes back to that step to explain it again). Bruno reads exactly these lines:`, ...teach.map(teachStepLine)]
      : []),
    `Key words: ${c.core.vocabulary.map((v) => `${v.term} (${v.meaning})`).join("; ")}`,
    `Everyday examples: ${c.extension.realLife.join(" ")}`,
    `Why it matters: ${c.extension.whyItMatters}`,
    `Common mistakes: ${c.misconceptions.map((m) => `${m.id}: ${m.wrong} (why: ${m.why}; fix: ${m.fix})`).join("; ")}`,
    `Scope: ${scopeText(c)}`,
    ...(learner.litPrereqs.length ? [`Already learned: ${learner.litPrereqs.join(", ")}.`] : []),
    ...(learner.missingPrereqs.length ? [`Not yet learned (warm up briefly when needed): ${learner.missingPrereqs.join(", ")}.`] : []),
    "Worked examples (next \"example\" with item_id shows one on the board and Bruno walks through its steps):",
    ...c.examples.map((e) => `- ${e.id}: ${e.title} — "${e.question}" → ${e.answer}`),
    "Practice question bank (next \"practice\" with item_id; easy to hard):",
    ...c.practice.map(itemLine),
    `Star challenge: the app picks the challenge questions from a separate test bank, ${c.test.count} questions (levels ${c.test.plan.join(", ")}); the star lights up with ${c.test.passScore} or more right.`,
    "",
    "How the lesson goes:",
    start,
    `${teaching} If the child is right, praise them in a few words and choose the next practice item, usually one level harder. If the record shows no wrong answer yet for the question on the board and the child is wrong, say what went wrong and give the first hint, and let them try again (verdict \"incorrect\", next \"none\"). If the record already shows a wrong answer for it and the child is wrong again, explain it clearly using that question's explanation, then choose another item at the same or a lower level. Prefer items not used yet.`,
    ("3. Star challenge: after 2 practice questions right in a row, or if the child asks to try, say \"Let's do the star challenge and light up this star!\" with next \"challenge\" (phase \"challenge\"); the app asks \"Question 1\" from the test bank. No hints before an answer. After each answer, react in say: \"That's right!\", or for a wrong one why it's wrong and how to get it (it still counts as wrong, no second try, but it is never skipped silently); then next \"challenge\" again until all the challenge questions are answered. When the child has answered the last one, react to it, then give the result from the record plus this answer, saying the actual score (for example \"all three right\" or \"two out of three\"), never \"at least\".") +
      " If enough are right, challenge_result is \"passed\": celebrate and always say plainly that the star is now lit, say they can see it glowing on the star map, and stop (stop_after_speaking true, next \"none\"). Otherwise challenge_result is \"failed\": encourage them, say they can try the challenge again anytime, and go back to practice with next \"practice\" (phase \"practice\").",
    "4. After the star is lit, only continue if the child asks for more practice.",
    "5. Judging: judge only the child's words listed as not judged yet, against the question on the board. The child can see the board and often answers while Bruno is still talking, so their words can show up before or in the middle of Bruno's lines: that is still an answer, judge it. Judge by meaning, not exact words: numbers may be said as words (\"five\") or with units (\"five stars\"); the answer's other right ways count too. For a choice question the options are listed in order: the child may say the option itself or point to it by position (\"the first one\", \"the middle one\", \"the last one\"); judge the option they mean. The child may count out loud first (\"one, two, three, four... four!\"): the number they settle on is the answer, and saying the last number twice (\"five, six, six!\") is how children finish counting, not one counted too many. If they are clearly still counting, thinking, or stopped mid-sentence, choose \"wait\". If the child is answering a smaller step you asked in a hint (not yet the question on the board), don't judge the board question: verdict \"none\", say whether the step is right, and ask for the full answer. If the record shows the question on the board was already answered right (or, in the challenge, answered at all), don't wait: move on. The child's words come from speech recognition: numbers usually appear as digits or symbols (\"3/4\" is three quarters), and a word may be misheard, so judge by the most likely meaning: a misheard word often sounds like the expected one (\"dirty\" for \"thirty\", \"for\" for \"four\", \"ate\" for \"eight\"), and if it sounds like the right answer, count it as said; if you really can't tell, kindly ask them to say it again.",
    `6. When the child says something that isn't an answer: if it's small talk or off-topic, reply kindly in one or two sentences and bring them back to the question on the board (next "none"); if they keep going off-topic, gently bring them back. If they ask for help, say they don't understand, or ask why, help in say with the next hint or a simple explanation (next "none"); but in the star challenge give no hints: kindly encourage them to have a go, and tell them it's fine to say they don't know. If the child doesn't understand the idea itself, teach it: ${teach.length ? `next "teach" with the id of the teaching step that explains it, or ` : ""}next "demo" or next "example" with a worked example id, then continue with practice. If you can't make out what they said, kindly ask them to say it again.`,
    `7. Trigger "bruno_done": Bruno just finished walking through ${teach.length ? "the teaching steps, " : ""}the demonstration or a worked example: move on, usually with a practice item.`,
    "8. Trigger \"silence\": nobody has spoken for a while. If the question on the board is answered, move on. Otherwise gently encourage the child and repeat or rephrase the question in say (in practice you may add the next hint). If Bruno has already prompted twice with no reply from the child, or the star is lit, choose \"wait\" (the app pauses the lesson).",
    "9. If the child asks to hear the question again, say it again in say, with next \"none\".",
    "10. Trigger \"resume\": the child came back after a pause. Welcome them back in one sentence without starting over, then ask the current question again in say; if the star is already lit, they want more practice, so choose a new practice item. Only say \"welcome back\" for this trigger.",
    "11. Write for the ear, short and simple: one to three short sentences (the second part of the opening and explaining a wrong star challenge answer can be a little longer). Say maths symbols in words (\"three quarters\", \"greater than\"). Never reveal an answer before the child answers, and never say how many things are on the board. Don't include the question text when a new question goes on the board: the app reads it (repeat it only as rules 8–10 say).",
    "12. Tone and safety: warm and patient; call the child \"astronaut\"; stay inside the scope; never use words like tutoring, cramming, score boosting or guaranteed results; never promise learning outcomes; never ask for personal information.",
    "",
    "Your decision:",
    "- action: \"wait\" (nothing to do now) or \"speak\".",
    "- verdict: \"correct\" or \"incorrect\" if the child's words not judged yet answer the question on the board; otherwise \"none\".",
    "- intro: the first part of the opening (greeting and progress), only at trigger \"start\"; otherwise \"\".",
    "- intro_today: the second part of the opening (what we do today), only at trigger \"start\"; otherwise \"\".",
    "- say: what Bruno says now: your reaction to the child's words first, then anything before a new question (\"\" when waiting or when nothing else is needed).",
    `- next: "practice" (a practice item from the bank), "challenge" (the next star challenge question), ${teach.length ? `"teach" (carry on with the teaching), ` : ""}"demo" (show the demonstration), "example" (show a worked example), or "none" (keep the board).`,
    `- item_id: the practice item for next "practice", ${teach.length ? `a teaching step to go back to for next "teach" ("" carries on where the teaching stopped), ` : ""}or the worked example for next "example"; otherwise "".`,
    "- phase: \"practice\" or \"challenge\" after this decision (a new question belongs to this phase).",
    "- challenge_result: \"passed\" or \"failed\" only at the moment the challenge ends; otherwise \"none\".",
    "- stop_after_speaking: true only when Bruno should stop and wait quietly after speaking.",
    "- notes: a few words to yourself for next time.",
  ].join("\n");
}

/** 大脑决定的结构化输出（strict：每个字段都要有，用不到的填空串） */
export function brainSchema(c: NodeContent) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["wait", "speak"] },
      verdict: { type: "string", enum: ["correct", "incorrect", "none"] },
      intro: { type: "string" },
      intro_today: { type: "string" },
      say: { type: "string" },
      next: { type: "string", enum: ["none", "practice", "challenge", ...(c.core.teach?.length ? ["teach"] : []), "demo", "example"] },
      item_id: { type: "string", enum: ["", ...c.practice.map((it) => it.id), ...(c.core.teach ?? []).map((s) => s.id), ...c.examples.map((e) => e.id)] },
      phase: { type: "string", enum: ["practice", "challenge"] },
      challenge_result: { type: "string", enum: ["none", "passed", "failed"] },
      stop_after_speaking: { type: "boolean" },
      notes: { type: "string" },
    },
    required: ["action", "verdict", "intro", "intro_today", "say", "next", "item_id", "phase", "challenge_result", "stop_after_speaking", "notes"],
  };
}

/**
 * 每次叫醒大脑时交给它的材料：时机、阶段、账本（最近几题与每次判定、闯关与练习的计数、已用过的题号）、
 * 板上这题的提示与讲解（小熊的回应由大脑写）、孩子对板上这题还没被判过的话、最近的对话（开场另带进度事实）。
 */
export function brainInput(o: {
  trigger: BrainTrigger;
  state: LessonState;
  book: LessonBook;
  test: { count: number; passScore: number };
  /** 讲解课共几步（没有讲解课为 0 或不写） */
  teachSteps?: number;
  lines: string[];
  facts?: ProgressFacts;
  now?: Date;
}): string {
  const s = o.state;
  // 板上是演示或例题时，最近那道题已不在板上
  const cur = o.book.display ? undefined : o.book.asked[o.book.asked.length - 1];
  const record = o.book.asked.slice(-8).map((a) => {
    const label = a.phase === "challenge" ? `Challenge question ${a.n} of ${o.test.count}` : a.phase === "teach" ? `Quick check ${a.q.id} (teaching, not marked)` : `Practice ${a.q.id}`;
    const judged = a.verdicts.length ? a.verdicts.map((v) => (v === "correct" ? "right" : "wrong")).join(", then ") : "not answered yet";
    return `- ${label}${a === cur ? " (on the board now)" : ""}: "${a.q.ask}" (board: ${describeBoard(a.q.board)}; answer: ${answerForBrain(a.q.answer)}) → ${judged}`;
  });
  const used = [...new Set(o.book.asked.filter((a) => a.phase === "practice").map((a) => a.q.id))];
  const t = challengeTally(o.book);
  const heard = o.book.unjudged.trim();
  return [
    `Trigger: ${o.trigger}`,
    `Lesson: phase=${s.phase}, star_lit=${s.starLit}, notes="${s.notes}"`,
    `Board now: ${o.book.display || (cur ? "the question marked below" : "empty")}`,
    "Questions so far (oldest first):",
    ...(record.length ? record : ["- none yet"]),
    ...(o.teachSteps ? [`Teaching: ${Math.min(o.book.taught, o.teachSteps)} of ${o.teachSteps} steps done${o.book.taught >= o.teachSteps ? " (finished)" : ""}`] : []),
    `Practice items used so far: ${used.length ? used.join(", ") : "none"}`,
    s.phase === "challenge"
      ? `Star challenge: ${t.asked} of ${o.test.count} questions asked, ${t.correct} right so far; the star lights up with ${o.test.passScore} or more right.${
          // 最后一题还没判：替大脑算好两种结局，免得它自己加错（实测把 3 题全对说成 two out of three）
          cur?.phase === "challenge" && !cur.verdicts.length && t.asked >= o.test.count
            ? ` This is the last question: if this answer is right, the final score is ${t.correct + 1} of ${o.test.count}${t.correct + 1 >= o.test.passScore ? " and the star is lit" : ""}; if it is wrong, ${t.correct} of ${o.test.count}${t.correct >= o.test.passScore ? " and the star is still lit" : " and the star is not lit yet"}.`
            : ""
        }`
      : `Practice: ${practiceStreak(o.book)} right in a row.`,
    ...(cur ? [`Hints for the question on the board, in order: ${cur.q.hints.map((h, i) => `${i + 1}) ${h}`).join(" ")} Its explanation: "${cur.q.explain}"`] : []),
    ...(cur ? [`The child's words about the question on the board, not judged yet: ${heard ? `"${heard.slice(-400)}"` : "(none)"}`] : []),
    ...(o.facts ? [`Progress facts for the opening: ${describeProgress(o.facts, o.now)}`] : []),
    "Recent conversation (oldest first; the last lines are the newest; the child may talk over Bruno):",
    ...(o.lines.length ? o.lines.slice(-14) : ["(nothing yet)"]),
  ].join("\n");
}

/** 大脑的决定翻译成程序要做的事 */
export interface BrainPlan {
  /** 这次什么都不做 */
  wait: boolean;
  verdict: "correct" | "incorrect" | "none";
  /** 新的阶段与备注（点亮由程序结算） */
  state: LessonState;
  next: "none" | "practice" | "challenge" | "teach" | "demo" | "example";
  itemId: string;
  /** 开场分两段先说（说完再换板、念题）：intro 打招呼并总结进度，introToday 说今天学什么；分开说，免得一整段字幕太长 */
  intro: string;
  introToday: string;
  say: string;
  /** 说完就停下等着（点亮之后） */
  stop: boolean;
  /** 大脑宣布闯关结束（过没过由程序按账本结算） */
  result: "none" | "passed" | "failed";
}

const NEXTS = ["none", "practice", "challenge", "teach", "demo", "example"] as const;

/** 大脑的决定 → 程序要做的事。缺的字段沿用上次；等待时不换板、不结算闯关 */
export function planFromDecision(prev: LessonState, raw: unknown): BrainPlan {
  const d = (raw ?? {}) as Record<string, unknown>;
  const wait = d.action !== "speak";
  const verdict = d.verdict === "correct" || d.verdict === "incorrect" ? d.verdict : "none";
  const state: LessonState = {
    phase: d.phase === "challenge" || d.phase === "practice" ? d.phase : prev.phase,
    starLit: prev.starLit,
    notes: typeof d.notes === "string" ? d.notes.slice(0, 400) : prev.notes,
  };
  if (wait) return { wait: true, verdict, state, next: "none", itemId: "", intro: "", introToday: "", say: "", stop: false, result: "none" };
  const next = NEXTS.includes(d.next as (typeof NEXTS)[number]) ? (d.next as BrainPlan["next"]) : "none";
  return {
    wait: false,
    verdict,
    state,
    next,
    itemId: typeof d.item_id === "string" ? d.item_id : "",
    intro: typeof d.intro === "string" ? d.intro.trim() : "",
    introToday: typeof d.intro_today === "string" ? d.intro_today.trim() : "",
    say: typeof d.say === "string" ? d.say.trim() : "",
    stop: d.stop_after_speaking === true,
    result: d.challenge_result === "passed" || d.challenge_result === "failed" ? d.challenge_result : "none",
  };
}

/**
 * 大脑流式输出里提前取「要说的话」：结构化输出按字段定义的顺序生成（action 在前，say 在 next 之前），
 * 拿全了 say 就能先开口，不等后面的换板决定。action 不是 speak、或这是开场（intro 有内容，开场先说 intro）时返回空串；
 * say 还没生成完返回 null。只解析决定的 JSON 结构，不看说话内容。
 */
export function earlySay(partial: string): string | null {
  const m = partial.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  if (!/"action"\s*:\s*"speak"/.test(partial) || /"intro"\s*:\s*"(?:[^"\\]|\\.)+"/.test(partial)) return "";
  try {
    return (JSON.parse(`"${m[1]}"`) as string).trim();
  } catch {
    return null;
  }
}

/** 照大脑的决定换板的一步（大脑的 say 已先说完）：换什么板、随新板念什么、记了哪道题 */
export interface LessonStep {
  /** 新的一块板；null = 板不动 */
  board: Widget[] | null;
  /** 新题记进账本的那一笔（演示、例题与不换题时为 null） */
  entry: AskedQuestion | null;
  /** 随新板念的话：新题问法、演示或例题的讲解；不换板为空串 */
  say: string;
  /** 演示、例题有动效节拍时：开头的板与各拍的板（PRD §7.8，随 say 念到哪里换到哪一块）；board 是最后一拍的板 */
  beats?: { frames: Widget[][]; beats: Beat[] };
}

const joinSay = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ");

/** 有节拍时附上开头的板与各拍的板 */
const withBeats = (board: Widget[], beats?: Beat[]) => (beats?.length ? { beats: { frames: [board, ...beats.map((b) => b.board)], beats } } : {});

/**
 * 大脑的决定 → 换板这一步：练习题按题号取（参数化题现在出数），闯关题按难度计划从测试题库抽，
 * 演示与例题换上内容里的板、念讲解步骤。讲解课一次要讲好几步，由课堂按 teachSegment 逐步换板，不走这里。
 * random 由课堂提供（同一节课可复现）。
 */
export function lessonStep(c: NodeContent, book: LessonBook, plan: Pick<BrainPlan, "next" | "itemId">, random: () => number): LessonStep {
  switch (plan.next) {
    case "practice": {
      const first = !book.asked.some((a) => a.phase === "practice");
      const q = instantiateItem(pickPracticeItem(c, book, plan.itemId), random);
      const entry = bookBoard(book, q, "practice");
      return { board: q.board, entry, say: `${first ? "Question 1" : "Next question"}: ${q.ask}` };
    }
    case "challenge": {
      const q = instantiateItem(pickTestItem(c, book), random);
      const entry = bookBoard(book, q, "challenge");
      return { board: q.board, entry, say: `Question ${entry.n}: ${q.ask}` };
    }
    case "demo":
      book.display = DEMO_DISPLAY;
      return { board: finalBoard(c.core.demo.board, c.core.demo.beats), entry: null, say: demoLine(c), ...withBeats(c.core.demo.board, c.core.demo.beats) };
    case "example": {
      const ex = c.examples.find((e) => e.id === plan.itemId) ?? c.examples[0];
      book.display = `worked example ${ex.id}: ${ex.title}`;
      return { board: finalBoard(ex.board, ex.beats), entry: null, say: exampleLine(ex), ...withBeats(ex.board, ex.beats) };
    }
    default:
      return { board: null, entry: null, say: "" };
  }
}
