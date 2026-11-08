# F3 · Rebuild the 烟火小店 home page from a recording (frontend)

**Dimension:** rebuild a screen · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** an empty SwiftUI project `Replica`, the original screen recording `materials/reference.mp4` (iPhone 18 Pro Max simulator, 1320×2868, 12.4 s, no sound), the five fonts the page uses, and the shop photos, recommender avatars and icons already in `Assets.xcassets`. No keyframes, no text, no colors, no description of the gestures: the agent has to read the video itself, and hard-code the data (no network).

The page is the home of 烟火小店, a food-map app on the App Store: a horizontally paged "Top 10" of featured shops (photo, name, distance, and a pinned note card with rank, quote, recommender, price and district, with page dots), a "好店发现" feed of shop cards (photo with a like badge, a note with the recommender's quote, name, category, price, distance and keyword tags) and a floating tab bar.

**Grading (`runner/grade_f3.py`):** build (Release) and install on the simulator, replay `f3-play.json` (page the featured cards, scroll the feed down and back to the top, page twice more) while recording, and screenshot four settled states.
- Automatic score (30%): `runner/f2_score.py` with `FTASK=F3` compares the four screenshots with `scoring/states/` (normalized so the empty project in `scoring/blank/` is 0 and the original is 100). Mid-scroll positions depend on fling speed and are not compared.
- Video review (70%): the side-by-side video is rated for static fidelity, motion fidelity and interaction feel, 1–10 each.

---

**中文：** 只给原录屏、五款字体、店铺照片、推荐者头像和图标，复刻烟火小店首页：主推卡横滑、好店发现卡片流、浮动标签栏。题面不描述手势。判分：回放时翻主推卡、上下滚动再翻两张，四个停稳的画面自动比对占 30%；并排视频评审占 70%。
