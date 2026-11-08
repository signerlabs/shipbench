# R7 · Stats page (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus a mock `StatsAPI` (weekly summary, last seven days, 120 days of check-ins).

**The task (`prompt.md`, Chinese):** add a stats page: four headline numbers with week-over-week change, a bar chart of the last seven days, and a GitHub-style contribution grid of the last 120 days. What it tests is the project rule "use the ShipSwift component when there is one": the KPI card (two-column grid with delta tags), bar chart and activity heatmap docs.

**Grading (`runner/grade_r7.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually call the three `StatsAPI` methods), then 9 static checks (`SWKPICard` ×4, two-column grid, `SWKPIDeltaTag`, `SWBarChart`, `SWActivityHeatmap.HeatmapGrid`, no hand-written Swift Charts marks, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 33.

---

**中文：** 在「Sprout」里加统计页（四个数字卡带涨跌、近 7 天柱状图、打卡格子图），考「组件库有就用组件」：kpi-card、bar-chart、activity-heatmap 三份文档。判分：两道门（能编译、真的做了需求）加 9 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）33 分。
