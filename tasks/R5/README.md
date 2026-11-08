# R5 · Edit a habit, with global alerts (project rules, sample)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** "Sprout", a small fictional habit-tracking app built for this benchmark. It uses the open-source [ShipSwift](https://github.com/signerlabs/ShipSwift) components (`Sprout/ShipSwift/`), ships their docs (`docs/shipswift/`) and a SwiftUI pitfalls note (`docs/swiftui-notes.md`), and states its rules in `CLAUDE.md` / `AGENTS.md`: prefer ShipSwift components, read the matching doc before coding, never step on a documented pitfall.

**The task (`prompt.md`, Chinese):** tap a habit to open an edit sheet (name and color), save through `HabitStore`, show "Saved" at the top on success and the error's description on failure.

**Grading (`runner/grade_task.py`, `grade_r5`):** must build; 9 static checks from the alert component's docs — success and failure both use the component, `.swAlert()` attached exactly once at the app entry, no delays waiting for the sheet to close, no hand-made banners or system alerts, uses a sheet, no compatibility branches for iOS 18 and below, ShipSwift sources and project settings untouched.

---

**中文：** 样题。在虚构的习惯打卡 App「Sprout」里加编辑页，照项目约定用 ShipSwift 组件。判分：先要能编译，再看 9 条静态检查是否都守住。
