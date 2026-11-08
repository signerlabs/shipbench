# B5 · CSV import and spending stats (backend)

**Dimension:** build a backend · **Published:** 2026-11-08 · **Stack:** Cloudflare Workers (TypeScript) + D1, local `wrangler dev`

**Given (`base/`):** an empty directory with `wrangler` installed. **The task (`prompt.md`, Chinese, ~4400 characters):** sign-up and login with a per-user IANA time zone, CSV upload of timestamped spending records (validated row by row — bad rows are skipped and reported by line number, files over 1 MB are rejected), deleting an import, a paginated record list, day / week (Monday-first) / month totals computed in the user's own time zone, and a limit of 5 imports per user per 60 seconds that answers 429 beyond it.

**Grading:**
- Acceptance (70%): `grade.mjs` writes `.dev.vars`, applies migrations, starts `wrangler dev` and runs 46 hidden API checks in three groups — features (21), auth & isolation (9), robustness (16) — covering BOM / CRLF / quoted CSV, exact cents, Singapore (UTC+8) day boundaries, New York daylight-saving switches, Kolkata's half-hour offset, a 20,000-row file just under the size limit, paging that survives a deleted import, 8 simultaneous imports of which exactly 5 may succeed, and recovery after 60 seconds. Score = passed / 46 × 100.
- Code quality (30%): a reviewer scores five criteria 1–10; objective metrics from `runner/grade_quality.py` are published as evidence.
- `reference/` passes 46/46; `checks/lazy/` is a deliberately sloppy version (72/100) used to make sure the acceptance tests can fail.

---

**中文：** 按约 4400 字的需求文档从零搭「记账数据导入和统计」后端：上传 CSV 逐行校验入库（坏行按行号报出、超过 1 MB 拒绝）、按用户时区按天 / 周（周一开头）/ 月汇总、每人每分钟最多导入 5 次。判分：46 条隐藏接口验收（功能 21、鉴权与隔离 9、健壮性 16，含夏令时、半小时时区、并发导入只成 5 个）占 70%，代码质量评审占 30%。`reference/` 是参考实现（46 条全过），`checks/lazy/` 是故意偷懒的版本（72 分），用来确认验收脚本能判出错。
