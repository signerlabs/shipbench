# R2 · AI coach chat (project rules)

**Dimension:** follow project rules · **Published:** 2026-11-08 · **Language:** SwiftUI (iOS 18+)

**Given (`base/`):** the same "Sprout" app as R5 (fictional, built on the open-source ShipSwift components and docs, with project rules in `CLAUDE.md` / `AGENTS.md`), plus a mock `CoachAPI` whose `streamReply(to:)` streams a Markdown answer a few characters at a time.

**The task (`prompt.md`, Chinese):** add a coach chat page: the reply streams in as it is written, Markdown is rendered, the user cannot send while the coach is replying, errors show up in the chat. The documented pitfalls it steps on: the chat doc's "don't build the list with `ScrollView` + `LazyVStack`", "`SWChatView` appends the user's message itself", "messages are immutable, replace the whole message while streaming" and "disable input while waiting", plus the markdown-text component for LLM output.

**Grading (`runner/grade_r2.py`, shared helpers in `runner/grade_rcommon.py`):** two gates (must build; must actually call `streamReply`), then 9 static checks (`SWChatView`, no `LazyVStack`, no duplicated user message, whole-message replacement while streaming, `SWMarkdownText`, `isDisabled` bound to state, no iOS 18 compatibility branches, ShipSwift sources and project settings untouched). `reference/` scores 100; `checks/naive/` (a plausible but rule-breaking version) scores 33.

---

**中文：** 在「Sprout」里加 AI 教练聊天页，踩 chat 文档里写明的坑（别自己拼 LazyVStack 列表、用户消息组件会自己加、流式时整条替换、回复时关掉输入）和 Markdown 组件。判分：两道门（能编译、真的做了需求）加 9 条静态检查。`reference/` 100 分，`checks/naive/`（看起来能用但不守规矩的版本）33 分。
