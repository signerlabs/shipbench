# F4 · Rebuild the Moonlitt moon-phase screen from a recording (frontend, third-party app)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica` and the original screen recording `materials/reference.mp4`. The recording shows **Moonlitt**, a third-party moon-phase app (winner of an Apple Design Award for interaction), captured on an iPhone (1290×2796, 7.3 s, no sound). No assets are provided: photos, illustrations and icons are to be drawn with SF Symbols and placeholder shapes. No description of the gestures; the data is hard-coded (no network).

The screen: a sky that changes with the time of day, an orbit ellipse with the moon and its phase, a vertical timeline on the right edge with a time bubble, a date bubble on the left, and buttons at the top and bottom. In the recording the time is scrubbed from midday to early morning; the sky, moon phase and position change continuously while the chrome fades out.

**Grading (`runner/grade_f4.py`):** build (Release) and install on the simulator, replay `f4-play.json` (scrub the timeline the same distance and speed) while recording, and screenshot two states: the starting screen and the end of the scrub.
- Automatic score (30%): `runner/f2_score.py` with `FTASK=F4` against `scoring/states/` (empty project in `scoring/blank/` = 0, original = 100). The original was recorded without lifting the finger; the replay has to lift it before the second screenshot.
- Video review (70%): side-by-side video rated for static fidelity, motion fidelity and interaction feel, 1–10 each.

The recording is of another company's app, included only to evaluate how well agents rebuild it.

---

**中文：** 复刻别家 App Moonlitt 的月相主界面，只给原录屏，不给素材（用 SF Symbols 和占位图形）。录屏里沿右边缘拖动时间轴，天空颜色、月相和月亮位置跟着连续变化。判分：起始和拖完两个画面自动比对占 30%，并排视频评审占 70%。原录屏是别家公司的界面，只用于评测。
