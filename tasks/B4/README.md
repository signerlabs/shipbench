# B4 · Subscription membership from webhook events (backend, sample)

**Dimension:** build a backend · **Published:** 2026-11-08 · **Stack:** Cloudflare Workers (TypeScript) + D1, local `wrangler dev`

**Given (`base/`):** an empty directory with `wrangler` installed. Written from scratch for the benchmark. **The task (`prompt.md`, Chinese):** receive subscription events from a third-party subscription platform (purchase, renewal, cancellation, expiration, refund) behind a webhook secret, maintain each user's membership state, and expose a query API — handling duplicate and out-of-order deliveries.

**Grading (`runner/grade_task.py`, `grade_b4` + `grade.mjs`):** 17 hidden API checks (auth, validation, state transitions, duplicate and out-of-order events, 10 concurrent deliveries, complete fields). `reference/` passes 17/17. This first-round sample was graded on acceptance only; the code-quality review was added afterwards.

---

**中文：** 样题。按接口约定搭会员订阅回调服务：验密钥、处理开通续订取消过期退款、重复和乱序推送、查询会员状态。判分：17 条隐藏接口验收，参考实现 17 条全过。
