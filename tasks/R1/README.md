# R1 · Friends leaderboard (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus a `LeaderboardEntry` model and the API base URL.

**The task (`prompt.md`, Chinese):** add a friends leaderboard fetched from `GET /v1/leaderboard`: rank, round avatar, name and streak per row, pull to refresh, an error with a retry button. The documented pitfalls it steps on: the cached-image doc (no `AsyncImage`, stable ids rather than fresh `UUID()`s) and the pitfalls note's "don't call APIs through `URLSession.shared`".

**Grading (`runner/grade_r1.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually request the endpoint and decode `LeaderboardEntry`), then 9 static checks (`SWCachedImage` for avatars, no `AsyncImage`, no `UUID()` ids, rows keyed by `userId`, no `URLSession.shared`, a dedicated session without a cache, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 33.

---

**中文：** 在「Sprout」里加好友排行榜，踩 cached-image 文档和踩坑笔记里写明的坑（头像别用 AsyncImage、id 别现造 UUID、接口别走 URLSession.shared）。判分：两道门（能编译、真的做了需求）加 9 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）33 分。
