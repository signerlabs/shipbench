# Run it yourself · 自己跑

Requirements: macOS with Xcode and an iPhone 18 Pro Max simulator (iOS 27; the reference recordings are 1320×2868), Node.js, Python 3 with `pillow` and `numpy`, `ffmpeg`, and the agent CLIs you want to test.

1. Create a standard macOS user for the agents (default name `agenteval`) and allow your own account to run commands as it without a password, e.g. `/etc/sudoers.d/agenteval`: `youruser ALL=(agenteval) NOPASSWD: ALL`. Install the agent CLIs inside that user. Create an iOS simulator inside that user (it gets its own).
2. Copy `runner/local.env.example` to `runner/local.env` and fill in the user name, the simulator UDID, the results folder and where your credentials live. Credentials are injected into each run as environment variables and never written into the repository.
3. Deploy the tasks, graders and replay project into the agent user: `tools/deploy_tasks.sh`.
4. Run a task: `python3 runner/run.py B2 claude my-batch`. Results land in `runs/my-batch/B2/claude/`. Frontend tasks are replayed and recorded separately: `python3 runner/run.py grade F1 claude my-batch`, then score with `runner/f2_score.py` and build the side-by-side video with `runner/f2_sbs.py` (`FTASK=F1`). To run a whole round in order, use `runner/schedule_formal.py --tasks=S1,S2 --tools=claude my-batch`.

To summarize a round, describe it in `rounds/<round>.json` and run `python3 tools/build_round.py <round>`. That writes `reports/<round>/summary.json` and updates the overview data in `overview/data.json`.

---

需要：装了 Xcode 的 Mac 和 iPhone 18 Pro Max 模拟器（iOS 27，原录屏是 1320×2868）、Node.js、带 `pillow` 和 `numpy` 的 Python 3、`ffmpeg`，以及要测的编程工具。

1. 建一个普通的 macOS 用户给工具用（默认叫 `agenteval`），让自己的账户免密码以它的身份执行命令，比如 `/etc/sudoers.d/agenteval` 写 `你的用户名 ALL=(agenteval) NOPASSWD: ALL`。在这个用户里装好各家工具，并给它建一台自己的 iOS 模拟器。
2. 把 `runner/local.env.example` 复制成 `runner/local.env`，填上用户名、模拟器 UDID、结果目录和凭证所在的位置。凭证每次运行时以环境变量注入，不会写进仓库。
3. 把题目、判分程序和回放工程部署到测评用户：`tools/deploy_tasks.sh`。
4. 跑一题：`python3 runner/run.py B2 claude my-batch`，结果在 `runs/my-batch/B2/claude/`。前端题另外回放录屏：`python3 runner/run.py grade F1 claude my-batch`，再用 `runner/f2_score.py` 算自动分、用 `runner/f2_sbs.py` 生成并排视频（`FTASK=F1`）。整轮按顺序跑用 `runner/schedule_formal.py --tasks=S1,S2 --tools=claude my-batch`。

汇总一轮：在 `rounds/<轮>.json` 里写好这一轮的配置，运行 `python3 tools/build_round.py <轮>`，会生成 `reports/<轮>/summary.json`，并更新 `overview/data.json` 里的总览数据。
