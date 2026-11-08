# R4 · First-launch onboarding (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), with habits now loaded asynchronously on appear, and an `Info.plist` already wired into the project.

**The task (`prompt.md`, Chinese):** show a three-page welcome flow on first launch only, ask for notification and location permission while it is on screen, and go straight into the app afterwards whatever the user answers. The documented pitfalls it steps on: the onboarding-view doc's "Permission Prefetch Pattern" (fire and forget, never poll for the answer, keep `CLLocationManager` in a property) and the location usage description.

**Grading (`runner/grade_r4.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually request both permissions), then 9 static checks (`SWOnboardingView`, no polling loop, entering the app not chained after awaiting a permission answer, location manager kept in a property, `NSLocationWhenInUseUsageDescription`, a persisted first-launch flag, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched — editing `SWOnboardingView.swift`, which the doc tells you to do, is allowed). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 44.

---

**中文：** 给「Sprout」加首次启动欢迎页并申请通知和定位权限，踩 onboarding-view 文档写明的坑（权限请求发出去就不管、不循环等回答、定位管理器存在属性里）。判分：两道门（能编译、真的申请了两种权限）加 9 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）44 分。
