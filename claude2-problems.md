# Claude2 Implementation Problems

- The referenced quota and instruction panes describe a web app with HTTP routes and SQLite. This VS Code extension has no server process or database layer, so the implementation uses webview messages plus `globalStorage` JSON for equivalent persisted state.
- VS Code does not let an extension cancel a user closing a webview editor tab from the tab strip. The instructions editor guards in-pane Close and pane switches, but a direct tab close cannot be blocked by the extension host API.
- The installed Claude CLI help exposes `--autocompact 100k-1M` but no explicit `--max-output-tokens` flag. Claude2 uses `--autocompact 256k` and tracks a 256,000-token context window in the UI.
## Corrections (2026-09-15, second review)

- The installed Claude CLI (2.1.220) does **not** accept `--autocompact`; that was the cause of `error: unknown option '--autocompact'`. The auto-compact window is set through the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable (100k–1M tokens). Claude2 now sets it to 256000 for every prompt run; the UI still tracks a 256,000-token window.
- `--session-id` is only accepted for a session the CLI has not stored yet; a second prompt in the same session must use `--resume <id>` or the CLI exits with `Session ID ... is already in use`. Claude2 now picks by whether the transcript exists on disk and falls back once if the CLI disagrees.
- The sidebar view was declared without `"type": "webview"` in package.json, so VS Code expected a tree data provider and showed `There is no data provider registered that can provide view data.`
