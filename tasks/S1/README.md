# S1 · Pinboard dedupe across two Macs (bug fix, sample)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** Swift

**Starting code (`base/`):** the data layer of a shipping macOS clipboard manager, packaged as the Swift package `ClipData` (SwiftData storage, sync across Macs through iCloud). Taken from a real commit; the package was renamed.

**The task (`prompt.md`, Chinese):** pinned items that arrive from two Macs through iCloud are sometimes both deleted during dedupe, or each Mac keeps a different copy. iCloud drops sub-millisecond precision. Make every Mac pick the same survivor (compare by whole seconds, then fall back to the existing rules), add a test that reproduces the bug, keep the public API and existing tests.

**Grading (`runner/grade_task.py`, `grade_s1`):** the hidden test in `hidden/` replaces the matching test file; `swift test` must pass completely.

---

**中文：** 两台 Mac 经 iCloud 同步来的同一条置顶内容，合并去重时有时两份都被删，或两台各留一份不同的。底稿是一个已上架的 Mac 剪贴板 App 的数据层（改名为 `ClipData`）。判分：用 `hidden/` 里的隐藏测试替换对应测试文件，`swift test` 全过。
