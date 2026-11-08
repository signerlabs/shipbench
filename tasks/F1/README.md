# F1 · Rebuild the 烟火小店 onboarding from a recording (frontend)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica`, the original screen recording `materials/reference.mp4` (iPhone 18 Pro Max simulator, 1320×2868, 14.5 s, no sound), the three fonts the page uses, and the images (avatars, illustrations, icons) already in `Assets.xcassets`. No keyframes, no timeline, no text, no colors, no source: the agent has to read the video itself.

The page is the three-step onboarding of 烟火小店, a food-map app on the App Store: avatars pop in, a note card rises and types out a recommendation, flames and a noodle bowl bounce in; a folded map rises while eight pins drop and a counter rolls to 2000; a dashed route draws, a paper plane flies along it with its nose following the curve, and the shop bounces with an "arrived" bubble. Pages slide with parallax and a progress bar.

**Grading (`runner/grade_f1.py`):** build (Release) and install on the simulator, then replay `f1-play.json` (wait for step 1, tap "next" twice) while recording, and screenshot the three settled states.
- Automatic score (30%): `runner/f2_score.py` with `FTASK=F1` compares the three screenshots with the matching frames in `scoring/states/` (SSIM on grayscale + color closeness, status bar cropped), normalized so the empty project (`scoring/blank/`) is 0 and the original is 100.
- Video review (70%): `runner/f2_sbs.py` aligns each recording with the original (app appearance, then each tap), and a reviewer rates static fidelity, motion fidelity and interaction feel 1–10 each (`results/*/F1/rating.json`).

---

**中文：** 只给原录屏、三款字体和图片素材，复刻烟火小店的三步引导页，连动效和交互。判分：编译安装后按同一套操作回放录屏，三个演完的画面自动比对占 30%；对齐后的并排视频由评审按静态还原、动效还原、交互手感各打 1–10 分，占 70%。
