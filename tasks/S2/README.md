# S2 · Search paging and Pinboard reordering (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** Swift

**Starting code (`base/`):** the same `ClipData` Swift package as S1 (data layer of a shipping macOS clipboard manager: SwiftData storage, SQLite full-text search index, Pinboards synced through iCloud). Two fixes from a real pre-release review commit were reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese), symptoms only:** (1) while paging through search results, the next page sometimes starts over or repeats items after an item was deleted or pasted (moved to the top); (2) after two Macs' Pinboards are merged, some Pinboards can't be reordered — they snap back. Fix both, add reproducing tests, `swift test` must pass, keep the public API and existing tests.

**Grading (`runner/grade_s2.py`):** 8 hidden regression tests from `hidden/` (deleted and reused cursor anchors for long and two-character queries, full scans while deleting or reusing, three and four equal sort keys). Score = passed / 8 × 100, halved if any other test fails or any of the 38 original tests is missing.

---

**中文：** 题面只写两个现象：搜索翻页时回到开头或重复；两台 Mac 的 Pinboard 合并后拖不动。底稿同 S1。判分：8 个隐藏回归用例，过几个算几分；其他测试有失败、或原有 38 个测试少了，分数减半。
