# Claude2 Implementation Judgements

- Conversation and management webviews open in `ViewColumn.One`, treating the first editor group as the requested default VS Code tab group.
- The Instructions pane edits workspace-root `CLAUDE.md`, matching the requested `claude.md` editor rather than the finance app's `docs/ledger-rules.md` file.
- Quota graph dates use `America/Los_Angeles` as the household timezone because the source pane did and no different timezone was specified.
- Prompt bars are implemented as one visible text line with ellipsis, interpreting “one char tall” as one row of prompt text.
- Claude2 uses the installed `claude` CLI directly with `stream-json` instead of adding the Agent SDK dependency; this still routes prompts through Claude Code OAuth and avoids the Messages API.
## Second review (2026-09-15)

- The Instructions pane now saves live (debounced ~400 ms after typing stops, Ctrl-S saves at once, leaving or closing the pane flushes first) instead of a Save button and leave dialog, per claude2-response.md. It also reloads when CLAUDE.md changes on disk and the pane holds no unsaved typing.
- The just-finished response stays open under its prompt bar until the next prompt is submitted; only then do older responses collapse. Hiding the answer the instant it finished seemed unusable.
- The token counter shows totals for the whole conversation (sum over prompts), as the instructions ask; context used is the latest API turn's size.
- Prompts are passed to the CLI on stdin rather than as an argument so a prompt beginning with `-` is never read as an option.
- The per-prompt guard rails from the finance app (8 turns, $2) were far too small for a coding assistant. They are now settings: `claude2.maxTurns` (default 200), `claude2.maxBudgetUsd` (default 0 = none) and `claude2.permissionMode` (default `auto`).
