import type { Widget } from "../board/widgets.ts";

/**
 * 知识点内容 v2（PRD §7.6 / ADR #34）：每个知识点一份 JSON（curriculum/knowledge/<节点 id>.json），
 * 是长期维护的核心资产；不设审阅状态，全部直接上线，要改就直接改、push 即发布。内容用英文（新加坡 MOE 用语）；代码注释用中文。
 * 大脑照这份内容上课：从练习／测试题库挑题、讲解与提示取自这里；小熊的会话指令只放这里的内容。
 * 题目一律原创，不照搬教材原题（§0.7）。结构与数量要求由 validate.ts 校验（npm run check:knowledge）。
 */

/** 1 = 基础，2 = 巩固，3 = 挑战 */
export type Level = 1 | 2 | 3;

export interface Answer {
  /**
   * number：一个数（可为模板 "{a+b}"，程序计算）；fraction：一个分数或带分数（"3/4"、"1 1/2"，可为模板 "{a}/{b}"，要不要约分在问法里说清，
   * 其他等值写法算不算对写进 accept）；choice：从 options 里选一个（如 more／less／same、>、<、=）；
   * text：一句短语（如 "3 groups of 4"）；open：开放回答，由教学大脑按 rubric 判
   */
  type: "number" | "fraction" | "choice" | "text" | "open";
  value: number | string;
  options?: string[];
  /** 其他也算对的说法（数字的英文读法不必列，小熊与大脑都认） */
  accept?: string[];
  /** open 题：好的回答要包含什么 */
  rubric?: string;
}

/** 一道题：练习题、测试题与拓展挑战题共用 */
export interface Item {
  /** 本知识点内唯一：练习 p-<级>-<序>，测试 t-<级>-<序>，挑战 c-<序> */
  id: string;
  level: Level;
  /** 题型（简短英文，如 "Count the objects"） */
  kind: string;
  /** 小熊念给孩子的问法：不含答案，不念显示板上的数量（孩子自己看板） */
  ask: string;
  board: Widget[];
  answer: Answer;
  /** 2–3 级提示，由浅到深，都不说出答案 */
  hints: string[];
  /** 完整讲解：同一题第二次答错时讲给孩子听（可以说出答案与算法） */
  explain: string;
  /** 这题针对的常见错法（misconceptions 里的 id） */
  misconceptions?: string[];
  /** 参数化：整数范围（含两端），问法、显示板、答案、提示、讲解里用 {a}、{a+b} 引用 */
  params?: Record<string, [number, number]>;
  /** 参数约束，如 ["a+b<=10", "a>b"] */
  where?: string[];
}

/**
 * 显示板动效的一拍（PRD §7.8 第一期）：小熊念到 at（这一段念的原文里的几个词，按先后出现）时，板换成 board。
 * board 是一整块板：图示按原顺序保留、只改要动的数，新图示只加在末尾；所在那一项的 board 是开头的样子。
 * 整步按最后一拍排版，静态显示与大脑看到的都是最后一拍的板（finalBoard）
 */
export interface Beat {
  at: string;
  board: Widget[];
}

/** 教课例题：边摆显示板边讲，一步一句 */
export interface WorkedExample {
  /** e-<序> */
  id: string;
  title: string;
  board: Widget[];
  /** 例题的问法 */
  question: string;
  /** 分步讲解，3–6 句，小熊依次说出 */
  steps: string[];
  answer: string;
  misconceptions?: string[];
  /** 动效节拍：讲「变化」的例题才有，at 取自问法与讲解（PRD §7.8） */
  beats?: Beat[];
}

/** 想一想：讲解课里停下来问孩子的一句（不计分），孩子答完、大脑回应后接着讲 */
export interface QuickCheck {
  /** 念完这一步的话接着问：不含答案 */
  ask: string;
  answer: Answer;
  /** 1–2 级提示，都不说出答案 */
  hints: string[];
  /** 第二次答错时讲给孩子听（可以说出答案） */
  explain: string;
}

/**
 * 讲解课的一步（PRD §3.4 / §7.6）：一块板配小熊照念的 1–3 句，一步只讲一个意思；
 * 带想一想的一步念完就停下等孩子回答。说的话把数学符号写成词（three twelfths），板上用符号
 */
export interface TeachStep {
  /** s-<序> */
  id: string;
  /** 这一步讲什么（简短英文，大脑与审阅页看） */
  title: string;
  board: Widget[];
  /** 小熊依次说的话，1–3 句，程序照念 */
  say: string[];
  check?: QuickCheck;
  /** 动效节拍：讲「变化」的一步才有，at 取自 say；带想一想的一步只演题目前提，不演答案（PRD §7.8） */
  beats?: Beat[];
}

export interface Misconception {
  /** m-<序> */
  id: string;
  /** 典型错法 */
  wrong: string;
  /** 错在哪里 */
  why: string;
  /** 怎么纠正 */
  fix: string;
}

export interface NodeContent {
  schema: 2;
  /** 图谱节点 id */
  nodeId: string;
  version: number;
  /** 英文标题（孩子听得懂的叫法） */
  title: string;
  /** 七个学习阶段：0 = 学前，1–6 = 年级（与图谱一致） */
  stage: number;
  /** 适合年龄，如 [4, 6] */
  ages: [number, number];
  /** 对应的新加坡 MOE 课纲条目（课纲校准后补全，可先空） */
  syllabus: { moe: string[] };
  /** 前置知识点 id（取自图谱） */
  prerequisites: string[];
  /** 学完能做到的 2–4 条 */
  objectives: string[];
  /** 核心讲解 */
  core: {
    /** 标准讲法 */
    standard: string;
    /** 通俗讲法：孩子说「听不懂」时用 */
    plain: string;
    /** 显示板演示：一块板加 2–5 句讲解（孩子听不懂时用） */
    demo: { board: Widget[]; steps: string[]; beats?: Beat[] };
    /**
     * 讲解课：开课后先按顺序一步步上板讲完（从生活情境引入、看图弄懂为什么、再归纳方法，6–14 步，2–5 步带想一想），再进练习。
     * 全部知识点必填；缺失或为空的内容不得发布。
     */
    teach: TeachStep[];
    /** 关键词与孩子听得懂的解释（2–6 个） */
    vocabulary: { term: string; meaning: string }[];
  };
  /** 拓展内容：拓展不是抢跑，不用铁律禁用的说法 */
  extension: {
    /** 生活中的应用，至少 3 条 */
    realLife: string[];
    /** 为什么重要（后面学什么要用到它） */
    whyItMatters: string;
    funFact?: string;
    /** 思维拓展题 1–3 道（level 3，id 为 c-<序>） */
    challenge: Item[];
  };
  misconceptions: Misconception[];
  /** 教课例题 3–5 道 */
  examples: WorkedExample[];
  /** 练习题库：每级至少 4 道，至少 2 道参数化 */
  practice: Item[];
  /** 测试题库：与练习分开，闯关只从这里抽；plan 为每轮各题的难度，每个难度至少 2 道备选 */
  test: { count: number; passScore: number; plan: Level[]; items: Item[] };
  /** 范围三圈：主线；可以聊一两句；其余温和拉回（avoid 举几个要拉回的例子） */
  scope: { core: string[]; nearby: string[]; avoid: string[] };
}
