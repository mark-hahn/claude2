# Claude2 Implementation Problems

- The referenced quota and instruction panes describe a web app with HTTP routes and SQLite. This VS Code extension has no server process or database layer, so the implementation uses webview messages plus `globalStorage` JSON for equivalent persisted state.
- VS Code does not let an extension cancel a user closing a webview editor tab from the tab strip. The instructions editor guards in-pane Close and pane switches, but a direct tab close cannot be blocked by the extension host API.
- The installed Claude CLI help exposes `--autocompact 100k-1M` but no explicit `--max-output-tokens` flag. Claude2 uses `--autocompact 256k` and tracks a 256,000-token context window in the UI.