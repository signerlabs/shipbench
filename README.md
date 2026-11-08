# ShipBench

**Can your AI coding agent ship a real app?** ShipBench measures first-party coding stacks — each vendor's own agent CLI driving its own model (Claude Code + Claude, Codex + GPT, Qwen Code + Qwen, Gemini CLI + Gemini, Kimi CLI + Kimi) — on the kind of work an indie app developer does every day: fixing bugs in a shipping codebase, rebuilding an iOS screen from a screen recording (motion included), building a backend from a spec, and following a project's own rules.

[中文说明](README.zh-CN.md)

- Tasks come from real commits, real screens and real backend requirements of apps that are on the App Store. Every task — prompt, starting code, hidden tests, reference recordings, graders — is in this repository.
- Every run happens fully autonomously in an isolated macOS user account, with a fresh workspace, no time limit (3-hour safety cap) and the same prompt for every tool.
- Results report three separate scores: **quality** (the headline), **speed** and **cost**.

## Latest results — sample round, 2026-11-08

Four sample tasks, one run each, every tool at its second-highest reasoning effort (`xhigh`).

| | Claude Code + Opus 5.5 | Codex + GPT-6 Astra |
|---|---|---|
| **Quality** (headline) | **97.5** | 93.7 |
| Speed | 38.3 | **61.7** |
| Cost | 40.8 | **59.2** |
| Wall-clock time, 4 tasks | 119 min 33 s | 46 min 48 s |
| Cost at API list price, 4 tasks | $33.76 | $13.55 |

| Task | Weight | Claude Code | Codex |
|---|---|---|---|
| S2 · bug fix (Swift package, 8 hidden tests) | 30% | 100 | 100 |
| F1 · rebuild an onboarding screen from a recording | 25% | 94.2 | 83.9 |
| B2 · backend from a spec (49 hidden API checks + code quality) | 25% | 95.8 | 91.0 |
| R9 · follow the project's rules (ShipSwift) | 20% | 100 | 100 |

Both stacks passed every pass/fail check. The gap is in what pass/fail cannot see: how faithfully the rebuilt screen moves, and how well the backend code is written. Per-task scores, diffs, rationales and side-by-side videos are in [`results/2026-11-08-xhigh`](results/2026-11-08-xhigh).

This is a sample round (8 sample tasks exist, 4 were run at `xhigh`). The full round has 31 tasks and is in progress.

## What is measured

Four dimensions, weighted into the quality score:

| Dimension | Weight | What the agent does | How it is judged |
|---|---|---|---|
| Fix bugs & add features | 30% | Change a real codebase from a symptom-only bug report | Hidden tests (70%) + code-quality review (30%) |
| Rebuild a screen | 25% | Rebuild an iOS screen in SwiftUI from a screen recording and assets, motion and interaction included | Replay on a simulator with the same taps, compare the settled frames automatically (30%) + review of the side-by-side video for static fidelity, motion and feel (70%) |
| Build a backend | 25% | Build a Cloudflare Workers + D1 service from a written spec | Hidden API acceptance tests: features, auth & isolation, robustness under bad input and concurrency (70%) + code-quality review (30%) |
| Follow project rules | 20% | Add a feature to an app that uses the ShipSwift component library, where the project's docs list pitfalls to avoid | Static checks that the right components were used and documented pitfalls avoided, plus a build (70%) + code-quality review (30%) |

### Speed and cost

Reported next to quality, not folded into it. For each task:

```
score = clamp(50 + 25 × log2(reference / actual), 0, 100)
```

Matching the reference scores 50; twice as fast (or half the cost) scores 75; four times as fast scores 100; twice as slow scores 25. The reference for each task is the geometric mean of the first round's results and is then frozen, so later entrants are measured against the same yardstick. A task whose quality score is below 60, or that hit the safety cap, scores 0 for speed and cost. Cost uses each vendor's API list price per million tokens, regardless of how the run was actually billed. Dimension scores use the same weights as quality.

### Code-quality review

Five criteria, 1–10 each: structure and layering, readability, consistency (errors and validation), robustness (parameterized SQL, concurrency via constraints rather than read-then-write, no `any` escapes), and maintainability (duplication, constants, tests). Objective metrics are published alongside as evidence: file count and size, `tsc --strict` errors, Biome lint density, jscpd duplication, test count ([`runner/grade_quality.py`](runner/grade_quality.py)).

## Fairness rules

- Same prompt, byte for byte, and a fresh copy of the starting code for every tool.
- Each tool runs in a dedicated macOS user with no access to the operator's files, keys, git or GitHub credentials, and a fresh config directory for every run (agents remember earlier sessions otherwise).
- Reasoning effort is set explicitly to each tool's second-highest level. Defaults differ wildly between vendors (Claude Code defaults Opus 5.5 to `medium`, Codex defaults GPT-6 Astra to `low`, Qwen defaults to its highest level), so defaults are not used.
- No time limit; wall-clock time is recorded. A 3-hour safety cap only catches stuck runs.
- Runs are sequential on the same machine, and the shared `/tmp` is cleared between runs.
- `git push`, deleting baseline files or touching credentials scores 0 for that task.

## Honest limitations

- **One run per task** so far. Close results are not ranked; tasks with small gaps get re-run three times.
- **The subjective parts were scored by an AI reviewer.** In the 2026-11-08 round the video ratings and code-quality reviews were done by Claude (Opus 5.5, in Claude Code), using randomly assigned blind labels, and then checked by the maintainer. The reviewer comes from the same vendor as one of the contestants, so every rationale, video and diff is published for anyone to re-score. Full agent transcripts are kept by the maintainer (they include details of the test machine) and are available on request. Later rounds add a reviewer from another vendor and a human calibration sample.
- **The tasks are public**, so future models may have seen them. Every task records when it was published, and each round adds new tasks.
- Frontend tasks are iOS only for now, and need macOS with Xcode.

## Run it yourself

Requirements: macOS with Xcode and an iPhone 18 Pro Max simulator (iOS 27; the reference recordings are 1320×2868), Node.js, Python 3 with `pillow` and `numpy`, `ffmpeg`, and the agent CLIs you want to test.

1. Create a standard macOS user for the agents (default name `agenteval`) and allow your own account to run commands as it without a password, e.g. `/etc/sudoers.d/agenteval`: `youruser ALL=(agenteval) NOPASSWD: ALL`. Install the agent CLIs inside that user. Create an iOS simulator inside that user (it gets its own).
2. Copy `runner/local.env.example` to `runner/local.env` and fill in the user name, the simulator UDID, the results folder and where your credentials live. Credentials are injected into each run as environment variables and never written into the repository.
3. Deploy the tasks, graders and replay project into the agent user: `tools/deploy_tasks.sh`.
4. Run a task: `python3 runner/run.py B2 claude my-batch`. Results land in `runs/my-batch/B2/claude/`. Frontend tasks are replayed and recorded separately: `python3 runner/run.py grade F1 claude my-batch`, then score with `runner/f2_score.py` and build the side-by-side video with `runner/f2_sbs.py` (`FTASK=F1`).

## Repository layout

```
runner/    run a task, inject credentials, collect transcript/diff/time/cost, grade
player/    XCUITest project that replays taps on the simulator while recording
tools/     deploy tasks to the agent user, generate an empty iOS project
tasks/     prompt, starting code (base/), hidden tests, reference solutions, graders, recordings
results/   per-round scores, diffs, rationales, videos
```

## License

- Code (`runner/`, `player/`, `tools/`): MIT.
- Tasks (`tasks/`), including starting code taken from commercial apps and their assets: [CC BY-NC 4.0](tasks/LICENSE.md) — use them to evaluate and research, not to ship. Third-party files keep their own licenses (fonts: SIL OFL; ShipSwift components and docs: MIT).
- Results (`results/`): [CC BY 4.0](results/LICENSE.md).

Maintained by [SignerLabs](https://github.com/signerlabs).
