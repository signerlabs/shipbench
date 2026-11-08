# R3 · Meal photo (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus a meal log form, a mock `MealAPI` and an `Info.plist` already wired into the project (so usage descriptions can be added without touching build settings).

**The task (`prompt.md`, Chinese):** add "take a photo" to the meal form: open the camera, show a thumbnail, allow a retake, save the JPEG with the meal. The documented pitfalls it steps on: the camera doc's integration checklist (camera usage description or the app crashes, `.swAlert()` at the root for camera errors, and a way to close the camera view, which has no close button of its own), plus "don't write your own camera".

**Grading (`runner/grade_r3.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually open a camera and pass JPEG data to `MealAPI`), then 8 static checks (`SWCameraView`, no hand-made camera, `NSCameraUsageDescription`, pushed or presented with a close button, alert attached once at the app entry, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched — adding an `INFOPLIST_KEY_` usage description to the project is allowed). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 38.

---

**中文：** 在「Sprout」的记一餐页加拍照，踩 camera 文档清单里写明的坑（没有相机权限说明会闪退、根视图要挂 .swAlert()、相机页自己没有关闭按钮）。判分：两道门（能编译、真的做了需求）加 8 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）38 分。
