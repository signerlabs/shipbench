# Sample round · 2026-11-08 · xhigh

Four sample tasks (S2, F1, B2, R9), one run each, run sequentially on one Mac. Every tool at its second-highest reasoning effort, set explicitly.

| | Claude Code 2.1.319 + `claude-opus-5-5` | Codex CLI 0.167.0 + `gpt-6-astra` |
|---|---|---|
| Reasoning effort | `--effort xhigh` | `-c model_reasoning_effort="xhigh"` |
| **Quality** | **97.5** | 93.7 |
| Speed | 38.3 | **61.7** |
| Cost | 40.8 | **59.2** |
| Wall-clock, 4 tasks | 7 173 s (119 min 33 s) | 2 808 s (46 min 48 s) |
| Cost at API list price, 4 tasks | $33.76 | $13.55 |

| Task | Claude Code: quality · time · cost · tool calls | Codex: quality · time · cost · tool calls |
|---|---|---|
| S2 bug fix | 100 · 7 min 42 s · $2.28 · 33 | 100 · 7 min 02 s · $2.81 · 34 |
| F1 frontend | 94.2 · 76 min 48 s · $23.07 · 303 | 83.9 · 19 min 20 s · $5.46 · 47 |
| B2 backend | 95.8 · 18 min 29 s · $4.38 · 48 | 91.0 · 14 min 59 s · $3.29 · 19 |
| R9 project rules | 100 · 16 min 34 s · $4.04 · 52 | 100 · 5 min 27 s · $2.00 · 22 |

Machine-readable: [`summary.json`](summary.json). Each `<task>/<tool>/` folder has `meta.json` (versions, effort, time, tokens, tool calls, safety checks, the agent's final message), `grade.json` and `diff.patch`. B2 also has `quality.json` (objective code metrics). Full agent transcripts include details of the test machine and are kept by the maintainer; they are available on request.

## F1 — rebuilt onboarding screen

Side-by-side, aligned at app appearance and at each tap: [`F1/video/f1-ref.mp4`](F1/video/f1-ref.mp4) (original), [`f1-claude.mp4`](F1/video/f1-claude.mp4), [`f1-codex.mp4`](F1/video/f1-codex.mp4).

| | Claude Code | Codex |
|---|---|---|
| Static fidelity (1–10) | 10 | 9 |
| Motion fidelity (1–10) | 9 | 7 |
| Interaction feel (1–10) | 9 | 8 |
| Video score (mean × 10, 70%) | 93.3 | 80.0 |
| Automatic score (30%) | 96.4 | 93.1 |
| **F1** | **94.2** | **83.9** |

- **Claude Code** built its own "record on the simulator → compare frame by frame with the original → fit the easing curves" loop and iterated until timing errors were about one frame. The settled frames nearly overlap the original; the order and spacing of every entrance animation match; in step 3 the plane's route, arrival time, the "arrived" bubble and the shop's bounce line up almost frame by frame. The one deduction: the app fades in at launch, so the whole sequence starts about 0.4 s late. It also noticed that a few texts use the system font rather than the three supplied fonts.
- **Codex** got the static layout close, the counter rolls digit by digit and reads "2000" like the original, and steps 2 and 3 are close. Deductions are in step 1: a ~0.75 s stall right after launch (no frames recorded), after which the third avatar and the note card arrive late and the typing effect is almost instant; page transitions use the same push style but run faster than the original.

## B2 — code quality

Both passed all 49 acceptance checks; the difference is in how the code is written.

| | Claude Code | Codex |
|---|---|---|
| Structure and layering | 9 | 7 |
| Readability | 8 | 6 |
| Consistency | 9 | 7 |
| Robustness | 8 | 8 |
| Maintainability | 9 | 7 |
| **Code quality** | **86** | **70** |
| Acceptance (49 checks) | 100 | 100 |
| **B2** (70% acceptance + 30% quality) | **95.8** | **91.0** |
| Objective: source files · non-empty lines | 14 · 1 142 | 11 · 633 |
| Objective: `tsc --strict` errors · Biome per 1k lines · duplication | 0 · 26.3 · 0% | 0 · 26.9 · 0% |
| Objective: test cases (approx.) | 54 | 27 |

Rationales for every criterion are in [`B2/rating.json`](B2/rating.json). In short: Claude Code split handlers by resource behind a routing table with typed auth contexts, kept validation and HTTP plumbing in their own modules, commented every concurrency decision and wrote extensive tests; Codex had the strictest database design of the two (composite foreign keys, depth checks, a trigger for atomic invite acceptance, membership re-checked inside every statement) but denser code, a hand-written routing chain and more casts.

## How the subjective scores were produced

The F1 video ratings and the B2 code-quality review were done by an AI reviewer — Claude (Opus 5.5) running in Claude Code — with the two outputs labeled 甲/乙 at random and revealed only after scoring (`blind.json`). The blinding was imperfect: the reviewer had seen the agents' final summaries and some metrics. The reviewer is from the same vendor as one of the contestants, which is why everything needed to re-score is published here. Later rounds add a reviewer from another vendor and a human calibration sample.

## Incidents

- Codex ran out of its ChatGPT Plus quota halfway through F1 (`F1/codex-void-limit` in the maintainers' records, not scored); the account was upgraded and F1 re-run from scratch.
- R9: Codex added `case expenses` to a page enum that the ShipSwift docs explicitly ask you to extend; the grader first counted that as editing component source. The grader was fixed and the run re-graded (93 → 100).
- The simulator records variable-frame-rate video with sparse keyframes; fast seeking picked wrong frames, so the video alignment now decodes from the start.
