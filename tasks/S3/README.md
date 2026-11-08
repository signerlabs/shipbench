# S3 · Same-day reminders collide (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** Swift (iOS)

**Starting code (`base/`):** a shipping iOS pet health-records app (SwiftUI, no third-party dependencies: pet profiles, vaccinations, deworming, vet visits, local reminder notifications), renamed `PetBook`, with private values and images of unclear origin removed. A unit-test target `PetBookTests` (Swift Testing, hosted in the app) with 5 tests was added. One fix from a real commit was reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese), symptoms only:** a cat got two vaccines on the same day with the same next due date, but only one reminder fires. Every record needs its own reminders (deworming and follow-ups too), and notification identifiers must be stable when nothing changed. Add a reproducing test; `xcodebuild test` must pass.

**Grading (`runner/grade_s3.py` + `runner/grade_ios_common.py`):** 5 hidden tests from `hidden/`, run with `xcodebuild test` on a simulator: 4 scored cases (two same-day vaccines, dewormings and follow-ups each get their own notifications; identifiers are stable across re-planning) and 1 guard (different pets and single records behave as before). Score = scored cases passed / 4 × 100; 0 if it does not build; halved if the guard or any other test fails or any of the 5 original tests is missing.

---

**中文：** 题面写现象：同一天打的两针疫苗、到期日相同，只响一条提醒；每条记录都要有自己的提醒，通知标识要稳定。底稿是一个已上线的宠物健康档案 iOS App（改名 PetBook，清掉了私有值和来源不明的图片，加了单元测试目标），退回了一处真实修复。判分：在模拟器上跑 5 个隐藏用例，4 个目标用例过几个算几分，编不过 0 分；守门用例和其余测试有挂、或原有 5 条测试少了，分数减半。
