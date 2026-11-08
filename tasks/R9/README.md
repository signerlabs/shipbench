# R9 · Workout expenses page (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus a mock `ExpenseAPI`.

**The task (`prompt.md`, Chinese):** add a workout-expenses page: monthly total in the user's local currency format, a list with locally formatted dates, a `Today` badge and a red `Large` badge for amounts over 50, a "+" sheet to log an amount, "Logged" or an error at the top. One feature that steps on four documented pitfalls: the add-sheet, status-badge and alert docs, and the pitfalls note's "parse numbers by locale" and "parse date-only strings at local noon".

**Grading (`runner/grade_r9.py`):** two gates (must build; must actually implement the feature with `ExpenseAPI` fetch and add), then 14 static checks (right components, locale-aware parsing and currency display, no UTC parsing of date-only values, alert attached once at the app entry, no delays, no hand-made banners, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched — adding a page case to an enum the docs explicitly invite you to extend is allowed). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 21.

---

**中文：** 在「Sprout」里加健身花费页，一个需求踩 4 份文档里写明的坑。判分：两道门（能编译、真的做了需求）加 14 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）21 分。
