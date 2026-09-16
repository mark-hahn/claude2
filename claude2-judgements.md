# Claude2 Implementation Judgements

- Conversation and management webviews open in `ViewColumn.One`, treating the first editor group as the requested default VS Code tab group.
- The Instructions pane edits workspace-root `CLAUDE.md`, matching the requested `claude.md` editor rather than the finance app's `docs/ledger-rules.md` file.
- Quota graph dates use `America/Los_Angeles` as the household timezone because the source pane did and no different timezone was specified.
- Prompt bars are implemented as one visible text line with ellipsis, interpreting “one char tall” as one row of prompt text.
- Claude2 uses the installed `claude` CLI directly with `stream-json` instead of adding the Agent SDK dependency; this still routes prompts through Claude Code OAuth and avoids the Messages API.