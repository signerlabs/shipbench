# R6 · Settings page (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus ShipSwift's settings template copied in unchanged, a mock `AuthStore` and a sign-in screen. The starting code does not build: the template's "recommended apps" section references logo images the project does not have, a pitfall its doc spells out.

**The task (`prompt.md`, Chinese):** add a settings page with language, share, terms, privacy, version, sign out and delete account (nothing else), with the given URLs; deleting must really delete the server account; after signing out or deleting, go back to the sign-in screen. The documented pitfalls it steps on: the setting doc's checklist (replace the URLs, remove the recommended apps section, wire up sign out and delete) and known pitfalls (delete is client-side only by default, sign out does not navigate), plus the alert component the template uses.

**Grading (`runner/grade_r6.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually wire sign out to `AuthStore`), then 9 static checks (`SWSettingView`, recommended apps removed rather than papered over with placeholder logos, URLs replaced, delete confirmed and sent to the backend, delete errors through the alert component attached once at the app entry, root view switching on sign-in state, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched — editing the settings template, which the doc tells you to do, is allowed). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 44.

---

**中文：** 在「Sprout」里加设置页，底稿里 ShipSwift 设置模板的「推荐 App」一栏缺图编译不过，这是 setting 文档写明的坑；另有换网址、删除要调后端、退出后根视图要跟着切。判分：两道门（能编译、真的接上了退出登录）加 9 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）44 分。
