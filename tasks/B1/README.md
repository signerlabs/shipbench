# B1 · Shared lists (backend)

**Dimension:** build a backend · **Published:** 2026-11-08 · **Stack:** Cloudflare Workers (TypeScript) + D1, local `wrangler dev`

**Given (`base/`):** an empty directory with `wrangler` installed. **The task (`prompt.md`, Chinese, ~4000 characters):** sign-up and login, lists with ordered to-do items (positions always contiguous from 0 through adds, deletes and moves), sharing a list with another user as read-only or editable, revoking and leaving shares, and copying any visible list as a template — where read-only users can't write, unshared users can't even see a list, revocation takes effect immediately and copies are fully independent of the original. Robust against bad input, oversized bodies and concurrent requests.

**Grading:**
- Acceptance (70%): `grade.mjs` writes `.dev.vars`, applies migrations, starts `wrangler dev` and runs 46 hidden API checks in three groups — features (19), auth & isolation (13), robustness (14) — including concurrent item adds and deletes on one list, concurrent shares to the same person, concurrent sign-ups, and paging that survives deletes. Score = passed / 46 × 100.
- Code quality (30%): a reviewer scores five criteria 1–10; objective metrics from `runner/grade_quality.py` are published as evidence.
- `reference/` passes 46/46; `checks/lazy/` is a deliberately sloppy version (74/100) used to make sure the acceptance tests can fail.

---

**中文：** 按约 4000 字的需求文档从零搭「多人共享清单」后端：清单和待办项、只读 / 可编辑分享、取消分享、复制成新清单。判分：46 条隐藏接口验收（功能 19、鉴权与隔离 13、健壮性 14）占 70%，代码质量评审占 30%。`reference/` 是参考实现（46 条全过），`checks/lazy/` 是故意偷懒的版本（74 分），用来确认验收脚本能判出错。
