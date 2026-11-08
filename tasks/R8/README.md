# R8 · Bottom tab bar (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus three placeholder screens. The brand green is already set as the app's global accent color in the project settings.

**The task (`prompt.md`, Chinese):** switch the app to a four-tab bar (Today, Stats, Coach, Settings), outline icons when not selected and filled icons when selected, the selected tab in the brand green. The documented pitfalls it steps on: the root-tab-view doc and the pitfalls note (use the iOS 18 `Tab(value:)` API, turn off the default symbol variants and switch to `.fill` yourself, and set the tint explicitly because from iOS 26 the tab bar ignores the global accent color).

**Grading (`runner/grade_r8.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually put the four screens in a `TabView`), then 8 static checks (`Tab(value:)`, no `.tabItem`, symbol variants off, selected/unselected icon switch, explicit tint, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched — editing `SWRootTabView.swift`, which the doc tells you to do, is allowed). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 38.

---

**中文：** 把「Sprout」改成四个标签的底部标签栏，踩 root-tab-view 文档和踩坑笔记写明的坑（用 Tab(value:) 新写法、关掉默认符号变体自己切实心、iOS 26 起标签栏不认全局主色要显式设 tint）。判分：两道门（能编译、真的做了需求）加 8 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）38 分。
