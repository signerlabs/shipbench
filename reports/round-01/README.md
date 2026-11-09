# Round 1 · 第一轮 · 2026-11-08

**Report · 报告：** https://claude.ai/artifact/C2fe52C6DcYjLHraFvygpw (Chinese and English · 中英双语). The same page is `index.html` in this folder · 本目录的 `index.html` 就是同一页。

**All rounds · 各轮总览：** https://claude.ai/artifact/PqeRTZmWJeqaGeKXWWwdBB

Round 1 includes the four tasks of the 2026-11-08 sample results (S2, F1, B2, R9), now with code-quality reviews added to S2 and R9; the earlier `results/2026-11-08-xhigh` folder is in the git history.

第一轮包含 2026-11-08 样题结果的四道题（S2、F1、B2、R9），S2、R9 补上了代码质量评审；原来的 `results/2026-11-08-xhigh` 目录留在 git 历史里。

**Opus 5.5** in Claude Code 2.1.319 (`--effort xhigh`) vs **GPT-6 Astra** in Codex CLI 0.167.0 (`model_reasoning_effort="xhigh"`). Lite set: two tasks per dimension from the 31-task bank, one run per task per tool.

**Opus 5.5**（在 Claude Code 2.1.319 里跑，`--effort xhigh`）对 **GPT-6 Astra**（在 Codex CLI 0.167.0 里跑，`model_reasoning_effort="xhigh"`）。精简版：从 31 道题库里每个维度挑两道，每家每题跑一次。

| | Opus 5.5 | GPT-6 Astra |
|---|---|---|
| **Quality · 质量** | **94.5** | 88.7 |
| Speed · 速度 | 38.1 | **61.9** |
| Cost · 成本 | 42.1 | **57.9** |
| Time, 8 tasks · 8 题用时 | 3 h 6 min | 1 h 19 min |
| Cost at list price · 按标价花费 | $52.36 | $23.28 |

| Dimension · 维度 | Weight · 权重 | Tasks · 题目 |
|---|---|---|
| Fix bugs & add features · 修 bug、加功能 | 30% | S1, S2 |
| Rebuild a screen · 前端复刻 | 25% | F2, F1 |
| Build a backend · 后端搭建 | 25% | B4, B2 |
| Follow project rules · 守规矩 | 20% | R5, R9 |

## Files · 文件

```
summary.json                 every score, time and cost · 全部分数、用时、花费（tools/build_round.py 生成）
index.html                   the report page · 报告页
media/                       side-by-side videos of the frontend tasks · 前端题的并排视频
<task>/blind.json            random 甲/乙 labels used during review · 评审时的随机甲乙标签
<task>/rating.json           subjective scores with rationales · 主观评分和理由
<task>/<tool>/meta.json      versions, effort, time, tokens, tool calls, safety checks, final message · 版本、档位、用时、token、工具调用、危险操作检查、最后的回复
<task>/<tool>/grade.json     correctness grading · 判对错
<task>/<tool>/diff.patch     the change the agent made · 工具做的改动
<task>/<tool>/quality.json   objective code metrics (backend) · 后端的客观代码指标
```

Full agent transcripts include details of the test machine and are kept by the maintainer; they are available on request.

完整的对话记录里有测评机器的细节，由维护者保存，需要可以索取。
