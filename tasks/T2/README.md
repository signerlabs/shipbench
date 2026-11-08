# T2 · Reading powers aloud (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** TypeScript

**Starting code (`base/`):** the core logic of a shipping AI maths tutor for primary-school children (pure TypeScript: curriculum content, the lesson board, the live lesson's teaching brain and speech). No dependencies; Node ≥ 23.6 runs the TypeScript directly and the tests use Node's built-in runner. Project names were neutralized. One fix from a real commit was reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese):** in live lessons the tutor's voice misreads powers such as "10³" and "2¹⁰". A superscript after a number is a power: ² reads "squared", ³ "cubed", anything else "to the power of N"; only the text sent to speech synthesis changes, and unit superscripts (cm², m³) stay as they are. Add tests; `npm test` must pass.

**Grading (`runner/grade_t2.py`):** 6 hidden tests from `hidden/`: 5 scored cases (squared/cubed/power of 10, a power before ≠, a fourth power, two powers in one sentence, a unit superscript and a power in the same sentence) and 1 guard (units unchanged). Score = scored cases passed / 5 × 100, halved if the guard or any other test fails or any of the 18 original tests is missing.

---

**中文：** 题面写现象：课上把「10³」「2¹⁰」念错了；数字后面的上标按乘方念（squared、cubed、to the power of N），单位上的上标不动。底稿是一个已上线小学数学 AI 学伴的核心逻辑（纯 TypeScript），退回了一处真实修复。判分：5 个目标用例过几个算几分，1 个守门用例（单位上标不动）和其余测试有挂、或原有 18 条测试少了，分数减半。
