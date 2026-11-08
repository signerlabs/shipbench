# T3 · Cleaning post tags (feature)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** TypeScript

**Starting code (`base/`):** the server of a shipping food-map app (TypeScript, Hono on AWS Lambda; 340+ vitest tests that run offline with the AWS clients mocked). Project names were neutralized; `npm ci` installs the locked dependencies. A tag-cleaning step from a real commit was removed; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese):** restaurants are imported from short videos and an AI model suggests tags, which now include platform words, influencer titles and promotion programs, and the recommending influencer's own name. Add `src/lib/post-tags.ts` exporting `sanitizeTags(input, ctx?)` with the rules in the prompt (drop platform words, titles, the influencer's name when the tag covers at least half of it; keep words that appear in the shop or dish names and short flavor words; trim, strip leading `#`, dedupe, keep order), and run both the "new import" and "refresh" write paths through it. Add tests; `npm test` must pass.

**Grading (`runner/grade_t3.py`):** 7 hidden tests: 5 for `sanitizeTags` and 2 that run the import pipeline with a mocked database and check the tags written for a new import and for a refresh. Score = passed / 7 × 100, halved if any other test fails or any original test is missing.

---

**中文：** 加功能题：短视频导入的店，AI 给的标签里混进了平台词、达人头衔、流量计划和博主自己的名字；题面写明了模块、函数签名和清洗规则，新导入和重新刷新两条入库路径都要用上。判分：7 个隐藏用例（5 个测函数本身，2 个跑入库流程看写进去的标签），过几个算几分；其他测试有失败、或原有测试少了，分数减半。
