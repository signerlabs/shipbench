# F5 · Rebuild an Airbnb listing page from a recording (frontend, third-party app)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica` and the original screen recording `materials/reference.mp4`. The recording shows a listing detail page in **Airbnb**, captured on an iPhone (1290×2796, 20.3 s, no sound). No assets are provided: photos and icons are to be drawn with SF Symbols and placeholder shapes. No description of the gestures; the data is hard-coded (no network).

The page: a horizontally paged photo header with a page counter and floating back/share/save buttons, a rounded content sheet with the title, rating, host and highlights, then description, reviews, sleeping arrangements, amenities, a map, the host card, availability and house rules; a sticky booking bar at the bottom and a navigation bar that appears after scrolling.

**Grading (`runner/grade_f5.py`):** build (Release) and install on the simulator, replay `f5-play.json` (page the header photos twice, then fling to the bottom of the page) while recording, and screenshot four states: photo 1, photo 2, photo 3, bottom of the page.
- Automatic score (30%): `runner/f2_score.py` with `FTASK=F5` against `scoring/states/` (empty project in `scoring/blank/` = 0, original = 100). Mid-scroll positions depend on fling speed and are not compared.
- Video review (70%): side-by-side video rated for static fidelity, motion fidelity and interaction feel, 1–10 each.

The recording is of another company's app, included only to evaluate how well agents rebuild it.

---

**中文：** 复刻别家 App Airbnb 的房源详情页，只给原录屏，不给素材。录屏里先左右翻两次顶部大图，再一路往下滚到页底，导航栏随滚动出现，底部预订栏常驻。判分：大图三张和页底四个画面自动比对占 30%，并排视频评审占 70%。原录屏是别家公司的界面，只用于评测。
