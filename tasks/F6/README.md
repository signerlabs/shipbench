# F6 · Rebuild the Duolingo learning path from a recording (frontend, third-party app)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica` and the original screen recording `materials/reference.mp4`. The recording shows the learning path in **Duolingo**, captured on an iPhone (1290×2796, 11.5 s, no sound). No assets are provided: characters, illustrations and icons are to be drawn with SF Symbols and placeholder shapes. No description of the gestures; the data is hard-coded (no network).

The page: a notification banner, a stats row, a sticky unit card that changes color and title with the unit, a winding path of round lesson nodes with characters and chests, and a tab bar. In the recording the path is scrolled back to the previous unit and several nodes are tapped, each popping up a speech-bubble card that closes on the next touch.

**Grading (`runner/grade_f6.py`):** build (Release) and install on the simulator, replay `f6-play.json` (scroll back by the measured distance with slow drags, then tap the same nodes) while recording, and screenshot three states: the starting unit, the previous unit after the scroll, and the first popup.
- Automatic score (30%): `runner/f2_score.py` with `FTASK=F6` against `scoring/states/` (empty project in `scoring/blank/` = 0, original = 100). Later taps depend on earlier scroll offsets and are only compared in the video.
- Video review (70%): side-by-side video rated for static fidelity, motion fidelity and interaction feel, 1–10 each.

The recording is of another company's app, included only to evaluate how well agents rebuild it.

---

**中文：** 复刻别家 App Duolingo 的学习路径页，只给原录屏，不给素材。录屏里先往上滚回上一单元（吸顶单元卡跟着变色换标题），再连点几个关卡节点，每次弹出气泡卡片。判分：开头、滚回停稳、第一个气泡三个画面自动比对占 30%，并排视频评审占 70%。原录屏是别家公司的界面，只用于评测。
