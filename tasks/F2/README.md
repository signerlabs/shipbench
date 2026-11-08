# F2 · Rebuild the Trovy stats report (frontend, sample)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica`, keyframes from the original recording and a written timeline of what moves and every number on the page (`materials/`), and room and item images in `Assets.xcassets`. This is the first-round sample, so keyframes and a timeline were still provided; later frontend tasks give only the recording. The original recording is `scoring/reference.mp4`.

The page is the stats report of Trovy, a household inventory app on the App Store: three counters that count up, a donut chart with legends, per-room bars, a room list with thumbnails, then a tap into the Bedroom detail and back.

**Grading (`runner/grade_task.py`, `grade_f2`):** build, install, replay `f2-play.json` while recording and screenshot 7 states; automatic score with `runner/f2_score.py` against `scoring/states/` (30%) and a review of the side-by-side video (70%).

---

**中文：** 样题。给关键帧、时间轴说明和图片素材，复刻 Trovy 的统计报表页和房间详情页。判分同 F1：7 个状态自动比对占 30%，并排视频评审占 70%。
