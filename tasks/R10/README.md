# R10 · Goal due badges (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus a mock `GoalAPI` whose due dates are plain `"yyyy-MM-dd"` strings.

**The task (`prompt.md`, Chinese):** add a goals page showing each goal's due date in the user's local format, with a red `Overdue` badge and an orange `Due today` badge, for users in the US, the UK and Japan. The documented pitfalls it steps on: the status-badge doc and the pitfalls note's "parse date-only strings at local noon, never at UTC midnight" (or US users see the previous day), plus comparing by calendar day rather than against the current instant.

**Grading (`runner/grade_r10.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually fetch the goals), then 9 static checks (`SWStatusBadge` with the `.error` and `.warning` styles, no UTC parsing, noon parsing, day-based comparison, locale-aware date display, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 33.

---

**中文：** 在「Sprout」里加目标页，到期日按地区格式显示、逾期和今天到期打标签，踩 status-badge 文档和踩坑笔记写明的坑（纯日期按当地正午解析、不按 UTC 午夜）。判分：两道门（能编译、真的做了需求）加 9 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）33 分。
