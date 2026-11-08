# P1 · Finding phrases in a Chinese voice-over (bug fix)

**Dimension:** fix bugs & add features · **Published:** 2026-11-08 · **Language:** Python

**Starting code (`base/`):** the single-file engine of a code-rendered short-video pipeline in production use (`hfcut.py`, standard library only: voice-over, sound effects, transitions, stickers; it writes an HTML + GSAP project and renders it to MP4), plus 6 tests for English voice-overs. Project names were neutralized. One fix from a real commit was reverted; this is a "synthetic" task built from real code.

**The task (`prompt.md`, Chinese):** scripts call `vo.at("phrase")` / `vo.span(...)` to sync visuals to the voice-over using per-character timestamps. With a Chinese voice-over, `vo.at("关注我")` raises "not found" although the phrase is spoken. Each Han character should count as a word and Chinese punctuation as a separator; mixed Chinese/English phrases must match with or without spaces; English tokenization must not change. Add tests with fake timestamps; `python3 -m unittest discover -s tests` must pass.

**Grading (`runner/grade_p1.py`):** 6 hidden tests from `hidden/`: 5 scored cases (one word per Han character, a Chinese phrase, a phrase with Chinese punctuation, mixed Chinese/English, a repeated phrase with `after=`) and 1 guard (missing phrases still raise, English unchanged). Score = scored cases passed / 5 × 100, halved if the guard or any other test fails or any of the 6 original tests is missing.

---

**中文：** 题面写现象：中文配音版里 `vo.at("关注我")` 报找不到。每个汉字算一个词，中文标点当分隔，中英混排有无空格都要找得到，英文拆法不变。底稿是一个在用的代码渲染短视频引擎（Python 单文件），退回了一处真实修复。判分：5 个目标用例过几个算几分，1 个守门用例和其余测试有挂、或原有 6 条测试少了，分数减半。
