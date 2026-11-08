# B3 · Nearby shops and ratings (backend)

**Dimension:** build a backend · **Published:** 2026-11-08 · **Stack:** Cloudflare Workers (TypeScript) + D1, local `wrangler dev`

**Given (`base/`):** an empty directory with `wrangler` installed. **The task (`prompt.md`, Chinese, ~4000 characters):** sign-up and login, user-added shops, a "nearby" query by latitude, longitude and radius sorted by great-circle distance with cursor pagination, favorites, and 1–5 ratings with average and count — where distances must be right anywhere on Earth (high latitudes, across the 180° meridian, near the pole), paging never repeats or skips a shop even when shops are deleted mid-way, a repeated rating only counts once, and ten simultaneous ratings still give the exact average and count.

**Grading:**
- Acceptance (70%): `grade.mjs` writes `.dev.vars`, applies migrations, starts `wrangler dev` and runs 49 hidden API checks in three groups — features (21), auth & isolation (11), robustness (17) — with shops placed in Singapore, Nairobi, Lisbon, Fiji (across 180°), Svalbard, the North Pole and more, plus five concurrency checks. Score = passed / 49 × 100.
- Code quality (30%): a reviewer scores five criteria 1–10; objective metrics from `runner/grade_quality.py` are published as evidence.
- `reference/` passes 49/49; `checks/lazy/` is a deliberately sloppy version (69/100) used to make sure the acceptance tests can fail.

---

**中文：** 按约 4000 字的需求文档从零搭「附近的店和评分」后端：按经纬度和半径查附近的店、按距离排序和游标分页、收藏、打分。判分：49 条隐藏接口验收（功能 21、鉴权与隔离 11、健壮性 17，距离用例覆盖高纬度、跨经度 180°、极点附近）占 70%，代码质量评审占 30%。`reference/` 是参考实现（49 条全过），`checks/lazy/` 是故意偷懒的版本（69 分），用来确认验收脚本能判出错。
