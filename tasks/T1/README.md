# T1 · Duplicate opening-hours periods (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** TypeScript

**Starting code (`base/`):** the server of a shipping food-map app (TypeScript, Hono on AWS Lambda; 340+ vitest tests that run offline with the AWS clients mocked). Project names were neutralized; `npm ci` installs the locked dependencies. One fix from a real commit was reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese), symptoms only:** a restaurant's detail page lists the same opening-hours period twice ("18:00–24:00, 18:00–24:00") because the map provider's raw text repeats a segment. Each period should appear once per day; different periods are still all listed. Add a reproducing test, `npm test` must pass, keep the public API and existing tests.

**Grading (`runner/grade_t1.py` + `runner/grade_vitest_common.py`):** 4 hidden tests from `hidden/` (the real raw text, a whole week repeated, a repeat inside one segment, same start with different end kept). Score = passed / 4 × 100, halved if any other test fails or any original test is missing.

---

**中文：** 题面只写现象：营业时间原文同一段写了两遍，详情页同一个时段列两遍；每天每个时段只列一次。底稿是一个已上线美食地图 App 的服务端（TypeScript），退回了一处真实修复。判分：4 个隐藏用例，过几个算几分；其他测试有失败、或原有测试少了，分数减半。
