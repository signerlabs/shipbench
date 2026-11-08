# T4 · Re-importing a closed restaurant (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** TypeScript

**Starting code (`base/`):** the server of a shipping food-map app (TypeScript, Hono on AWS Lambda; 340+ vitest tests that run offline with the AWS clients mocked). Project names were neutralized; `npm ci` installs the locked dependencies. One fix from a real commit was reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese):** re-importing an old video whose restaurant has since closed still says "added to the map" and flies to the old coordinates. Import results must omit coordinates and set `restaurantClosed: true` for closed restaurants, omit coordinates (without `restaurantClosed`) for restaurants handed to the owner to fix their location (`rescueStatus = owner`), on both paths that return an import result (a duplicate submission that hits a finished import, and polling the import job). Open restaurants still get coordinates. Add tests; `npm test` must pass.

**Grading (`runner/grade_t4.py`):** 6 hidden API tests, 3 per path: closed and owner-fix are the 4 scored cases; "open restaurant still gets coordinates" is a guard on each path. Score = scored cases passed / 4 × 100, halved if a guard or any other test fails or any original test is missing.

---

**中文：** 题面写现象：重新导入一条老视频，店已经关了，App 还说「已加到地图」并飞到旧坐标。已关闭的店不返回坐标并标 `restaurantClosed`，交给店主补位置的店也不返回坐标；去重命中和轮询任务结果两条路径都要改。判分：6 个隐藏接口用例，两条路径各 3 个，其中照常营业照给坐标的 2 个是守门用例（挂了分数减半），其余 4 个过几个算几分。
