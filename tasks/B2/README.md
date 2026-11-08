# B2 · Household items and expiry reminders (backend)

**Dimension:** build a backend · **Published:** 2026-11-08 · **Stack:** Cloudflare Workers (TypeScript) + D1, local `wrangler dev`

**Given (`base/`):** an empty directory with `wrangler` installed. **The task (`prompt.md`, Chinese, ~5000 characters):** sign-up and login, households with one-time invite codes and owner/member roles, three-level storage locations, items with quantities and expiry dates, "days left" computed in each household's own time zone, cursor pagination that survives deletes, and an hourly scheduled job that creates reminders for items expiring within 3 days without duplicates — robust against bad input, oversized bodies and concurrent requests.

**Grading:**
- Acceptance (70%): `grade.mjs` writes `.dev.vars`, applies migrations, starts `wrangler dev` and runs 49 hidden API checks in three groups — features (22), auth & isolation (13), robustness (14) — including 10 concurrent invite redemptions, concurrent sign-ups, time-zone edges (UTC+14 vs UTC−11) and triggering the scheduled job at chosen times. Score = passed / 49 × 100.
- Code quality (30%): a reviewer scores five criteria 1–10; objective metrics from `runner/grade_quality.py` are published as evidence.
- `reference/` passes 49/49; `checks/lazy/` is a deliberately sloppy version used to make sure the acceptance tests can fail.

---

**中文：** 按约 5000 字的需求文档从零搭「家庭物品与过期提醒」后端。判分：49 条隐藏接口验收（功能 22、鉴权与隔离 13、健壮性 14）占 70%，代码质量评审占 30%。`reference/` 是参考实现（49 条全过），`checks/lazy/` 是故意偷懒的版本，用来确认验收脚本能判出错。
