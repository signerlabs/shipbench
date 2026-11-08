# S4 · Cleared fields come back after editing (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** Swift (iOS)

**Starting code (`base/`):** a shipping iOS pet health-records app (SwiftUI, no third-party dependencies: pet profiles, vaccinations, deworming, vet visits, local reminder notifications), renamed `PetBook`, with private values and images of unclear origin removed. A unit-test target `PetBookTests` (Swift Testing, hosted in the app) with 5 tests was added. One fix from a real commit was reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese):** after clearing a vaccination's next due date, brand or notes and saving, the old values come back. The backend's PATCH only changes fields present in the body and clears a column when the value is `null`. Cleared fields must really be cleared on edit (vaccinations, deworming, vet visits and pet profiles); creates must not send `null`; a pet's sex must never be sent as `null` but setting it back to "unknown" must be saved; editing a profile must not clear the photo. Add tests; `xcodebuild test` must pass.

**Grading (`runner/grade_s4.py` + `runner/grade_ios_common.py`):** 6 hidden tests from `hidden/` that capture the request bodies through a stub `URLProtocol` (no network): 4 scored cases (edits of vaccinations, deworming, vet visits and pets send `null` for cleared fields; sex "unknown" is sent; the photo is not cleared) and 2 guards (creates never send `null`; filled values are still sent on edit). Score = scored cases passed / 4 × 100; 0 if it does not build; halved if a guard or any other test fails or any of the 5 original tests is missing.

---

**中文：** 题面写现象：编辑疫苗记录清空几个字段，保存后旧值又回来了；题面说明了后端约定（PATCH 只改出现的字段，null 清空）。编辑时清空的字段要真的清空，新建不发 null，性别任何时候不发 null，编辑资料不能清掉照片。判分：在模拟器上跑 6 个隐藏用例（截下请求体看），4 个目标用例过几个算几分，编不过 0 分；2 个守门用例和其余测试有挂、或原有 5 条测试少了，分数减半。
