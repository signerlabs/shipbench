# F2 · Rebuild the Trovy stats report (frontend)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica`, the original screen recording (`materials/reference.mp4`, 1320×2868, about 10.5 s, no audio) and the room and item images in `Assets.xcassets`. Nothing else: no keyframes, no timeline, no list of the gestures or the numbers on the page. The agent has to read layout, data, motion and gestures from the video itself. (The 2026-11-07 sample run used keyframes and a written timeline; that prompt is kept as `prompt-2026-11-07-keyframes.md`.)

The page is the stats report of Trovy, a household inventory app on the App Store: three counters that count up, a donut chart with legends, per-room bars, a room list with thumbnails, then a tap into the Bedroom detail and back.

**Grading (`runner/grade_task.py`, `grade_f2`):** build, install, replay `f2-play.json` while recording and screenshot 7 states; automatic score with `runner/f2_score.py` against `scoring/states/` (30%) and a review of the side-by-side video (70%).

---

**中文：** 只给原录屏和图片素材（不给关键帧、时间轴，也不写操作和页面上的数据），复刻 Trovy 的统计报表页和房间详情页，布局、数据、动效和手势都要工具自己从录屏里看。11-07 样题试跑用的是「关键帧 + 时间轴」版，题面留作 `prompt-2026-11-07-keyframes.md`。判分同 F1：7 个状态自动比对占 30%，并排视频评审占 70%。
