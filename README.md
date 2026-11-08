# ShipBench

**Can an AI coding model ship a real app?** ShipBench tests each model inside its own vendor's coding agent — Claude in Claude Code, GPT in Codex, Qwen in Qwen Code, Gemini in Gemini CLI, Kimi in Kimi Code CLI — on the kind of work an indie app developer does every day: fixing bugs in a shipping codebase, rebuilding an iOS screen from a screen recording (motion included), building a backend from a spec, and following a project's own rules.

[中文说明](README.zh-CN.md)

- Tasks come from real commits, real screens and real backend requirements of apps that are on the App Store.
- Every run happens fully autonomously in an isolated macOS user account, with a fresh workspace, no time limit (3-hour safety cap) and the same prompt for every tool.
- Results report three separate scores: **quality** (the headline), **speed** and **cost**.

## Why ShipBench

- **Real usage.** Developers work through coding agents such as Claude Code and Codex, not raw API calls, so each model is tested inside its own vendor's agent. The agent stays fixed; what changes from round to round is the model.
- **Work that public leaderboards don't cover.** An iOS screen rebuilt with its motion, a backend with auth and concurrency, a feature added under a project's own rules, all on the code of apps that are on the App Store. Math and general reasoning are left to existing benchmarks.
- **Fast.** When a new model ships, only that model needs to run; earlier results are reused against frozen speed and cost references.

## Reports

Each round picks tasks from the bank, runs every stack once per task and publishes a report (Chinese and English) with scores, analysis, diffs, rationales and side-by-side videos. Rounds live in [`reports/`](reports).

| Round | Date | Models (agent) | Tasks | Report |
|---|---|---|---|---|
| [Round 1](reports/round-01) | 2026-11-08 | **Opus 5.5** (in Claude Code) vs **GPT-6 Astra** (in Codex), both `xhigh` | 8 of 31 (lite set: two per dimension) | [report page](https://claude.ai/artifact/C2fe52C6DcYjLHraFvygpw) · [data](reports/round-01) |

**Round 1 in one line:** quality **94.5** for Opus 5.5 vs 88.7 for GPT-6 Astra; speed 38.1 vs **61.9**; cost 42.1 vs **57.9**. Both pass every pass/fail check; the gap is in how the rebuilt screens move (frontend 92.5 vs 77.2) and in code quality, while GPT-6 Astra finishes the 8 tasks in 1 h 19 min for $23 against 3 h 6 min and $52.

## The task bank

31 tasks in four dimensions. The dimension weights make up the quality score.

| Dimension | Weight | Tasks | What the agent does | How it is judged |
|---|---|---|---|---|
| Fix bugs & add features | 30% | S1–S5 (Swift), T1–T4 (TypeScript), P1 (Python) | Change a real codebase from a bug report that describes symptoms | Hidden tests (70%) + code-quality review (30%) |
| Rebuild a screen | 25% | F1–F6 | Rebuild an iOS screen in SwiftUI from a screen recording and its assets, motion and interaction included. No keyframes, no timeline, no description of the gestures | Replay the same gestures on a simulator, compare the settled frames automatically (30%) + review of the side-by-side video for static fidelity, motion and feel (70%) |
| Build a backend | 25% | B1–B5 | Build a Cloudflare Workers + D1 service from a written spec | Hidden API acceptance tests: features, auth and isolation, robustness under bad input and concurrency (70%) + code-quality review (30%) |
| Follow project rules | 20% | R1–R10 | Add a feature to an app that uses the ShipSwift component library, where the project's docs list pitfalls to avoid | Static checks that the right components were used and the documented pitfalls avoided, plus a build (70%) + code-quality review (30%) |

Task IDs are a letter and a number: **S**wift, **T**ypeScript and **P**ython for bug fixes and features, **F**rontend, **B**ackend, **R**ules. All 31 tasks are listed in [`tasks/README.md`](tasks/README.md); each task folder has its own README.

**How tasks are made.**

- *Bug fixes and features:* taken from fix commits in the apps' history (1–5 files changed), with the code reverted to before the fix. The prompt describes the symptom in the voice of whoever reported it and never hints at the fix. Hidden tests come from the original commit or are written for the task. Some tasks are synthetic: a single fix reverted in today's code.
- *Rebuild a screen:* three screens from the maintainer's own apps and three from well-known apps recorded on a real device. The agent gets the recording and the assets only; how to extract frames and read the motion is up to the agent.
- *Build a backend:* one written spec per task. The stack is fixed (Cloudflare Workers + D1) and everything runs locally, with no cloud account. The checks cover features; auth and isolation (requests without a session, or reading or changing someone else's data, must be refused); and robustness (bad input, duplicate submissions, concurrent requests, oversized requests).
- *Follow project rules:* an iOS project with the ShipSwift component library and a rules file (the same text as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md`) that says to prefer ShipSwift components, read the matching skill doc first and avoid the pitfalls it lists. Each task lands on a documented pitfall. The free ShipSwift library is public, so models may have seen it, but what is tested is whether the agent follows the project's rules.
- Every task is validated before use: the reference solution scores 100, and the starting code or a deliberately lazy version scores clearly lower.

**What is public.** Every task's prompt, README and starting code are public. A task's hidden tests, reference solution and grader are published with the first round that uses it, so that agents with web access cannot look them up during a run. After Round 1, eight tasks are fully public: S1, S2, F1, F2, B2, B4, R5 and R9.

## How scores are computed

**Quality** is the weighted sum of the four dimensions; each dimension is the mean of its tasks in that round.

**Speed and cost** are reported next to quality, not folded into it. For each task:

```
score = clamp(50 + 25 × log2(reference / actual), 0, 100)
```

Matching the reference scores 50; twice as fast (or half the cost) scores 75; four times as fast scores 100; twice as slow scores 25. The reference for each task is the geometric mean of the first round that ran it, and is then frozen ([`rounds/references.json`](rounds/references.json)), so later entrants are measured against the same yardstick. A task whose quality is below 60, or that hit the safety cap, scores 0 for speed and cost. Cost uses each vendor's API list price per million tokens, regardless of how the run was actually billed. The scale is logarithmic because stacks differ by multiples (tens of times on the same task), so every doubling is worth the same 25 points. "Fastest scores 100" is not used, because every new entrant would change everyone else's score.

**Code-quality review.** Five criteria, 1–10 each: structure and layering, readability, consistency (errors, validation, the project's existing patterns), robustness (edge cases, no unsafe casts or force unwraps, concurrency safety, no test-gaming) and maintainability (duplication, constants, tests). For backends, objective metrics are published alongside as evidence: file count and size, `tsc --strict` errors, Biome lint density, jscpd duplication, test count ([`runner/grade_quality.py`](runner/grade_quality.py)).

## Fairness rules

- Same prompt, byte for byte, and a fresh copy of the starting code for every tool.
- Each tool runs in a dedicated macOS user with no access to the operator's files, keys, git or GitHub credentials, and a fresh config directory for every run (agents remember earlier sessions otherwise).
- Reasoning effort is set explicitly to each tool's second-highest level. Defaults differ wildly between vendors (Claude Code defaults Opus 5.5 to `medium`, Codex defaults GPT-6 Astra to `low`), so defaults are not used.
- No time limit; wall-clock time is recorded. A 3-hour safety cap only catches stuck runs.
- Runs are sequential on the same machine: one run at a time. Before every run, leftover processes from the previous run are stopped, apps installed on the simulator are removed and the shared `/tmp` is cleared.
- `git push`, deleting baseline files or touching credentials scores 0 for that task.
- Agents have network access, which they need to reach their model, but no logged-in accounts, so they cannot push code anywhere.
- Infrastructure failures (rate limits, exhausted quota, API errors) void the run, which is redone from scratch; they are not counted as attempts.
- Hidden tests, reference solutions and reference frames are never in the agent's workspace.

## Honest limitations

- **One run per task.** Single runs vary; close results are reported as ties rather than ranked.
- **The subjective parts are scored by an AI reviewer.** Video ratings and code-quality reviews are done by Claude (Opus 5.5) with the two outputs labeled at random and revealed only after scoring. The reviewer comes from the same vendor as one of the contestants, so every rationale, video and diff is published for anyone to re-score. Full agent transcripts include details of the test machine and are kept by the maintainer; they are available on request. Later rounds add a reviewer from another vendor and a human calibration sample.
- **Tasks become public after they are used**, so future models may have seen them. Every task records when it was published, and each round adds tasks that have not been run before.
- Frontend tasks are iOS only for now, and need macOS with Xcode.

## Run it yourself

Requirements: macOS with Xcode and an iPhone 18 Pro Max simulator (iOS 27; the reference recordings are 1320×2868), Node.js, Python 3 with `pillow` and `numpy`, `ffmpeg`, and the agent CLIs you want to test.

1. Create a standard macOS user for the agents (default name `agenteval`) and allow your own account to run commands as it without a password, e.g. `/etc/sudoers.d/agenteval`: `youruser ALL=(agenteval) NOPASSWD: ALL`. Install the agent CLIs inside that user. Create an iOS simulator inside that user (it gets its own).
2. Copy `runner/local.env.example` to `runner/local.env` and fill in the user name, the simulator UDID, the results folder and where your credentials live. Credentials are injected into each run as environment variables and never written into the repository.
3. Deploy the tasks, graders and replay project into the agent user: `tools/deploy_tasks.sh`.
4. Run a task: `python3 runner/run.py B2 claude my-batch`. Results land in `runs/my-batch/B2/claude/`. Frontend tasks are replayed and recorded separately: `python3 runner/run.py grade F1 claude my-batch`, then score with `runner/f2_score.py` and build the side-by-side video with `runner/f2_sbs.py` (`FTASK=F1`). To run a whole round in order, use `runner/schedule_formal.py --tasks=S1,S2 --tools=claude my-batch`.

## Repository layout

```
reports/   one folder per round: report page (Chinese and English), summary.json, per-task data and videos
rounds/    which tasks each round used, and the frozen speed and cost references
tasks/     prompt, starting code (base/), and, once used in a round, hidden tests, reference solutions, graders, recordings
runner/    run a task, inject credentials, collect transcript/diff/time/cost, grade, schedule a round
player/    XCUITest project that replays gestures on the simulator while recording
tools/     deploy tasks to the agent user, generate an empty iOS project, build a round's summary
```

## License

- Code (`runner/`, `player/`, `tools/`): MIT.
- Tasks (`tasks/`), including starting code taken from commercial apps and their assets: [CC BY-NC 4.0](tasks/LICENSE.md) — use them to evaluate and research, not to ship. Third-party files keep their own licenses (fonts: SIL OFL; ShipSwift components and docs: MIT; photos: Unsplash License).
- Reports (`reports/`): [CC BY 4.0](reports/LICENSE.md).

Maintained by [SignerLabs](https://github.com/signerlabs).
