# Claude2

A VS Code extension that puts Claude Code in the sidebar and in editor panes,
driving the `claude` CLI directly instead of wrapping a terminal.

## Features

- **Sidebar session list** — create, rename, delete, and switch sessions from the
  Claude2 activity-bar view. Drafts survive reloads.
- **Conversation panes** — one editor pane per session with a prompt box, model and
  effort pickers, streaming responses, live status (thinking / writing / working /
  compacting), token and cost readouts, and per-turn copy and fork.
- **Fork a turn** — rewind a session to any earlier turn; the CLI transcript is
  truncated to match so `--resume` picks up from there.
- **Instructions pane** — edit the workspace `CLAUDE.md` in place, with on-disk change
  detection so a concurrent edit is not clobbered.
- **Quota pane** — polls Anthropic usage for the 5-hour and 7-day windows plus credits,
  keeps a local history, and shares readings and rate-limit pauses across windows.
- **Markdown and pony panes** — render a response as markdown, or view the ponytail
  report: skips recorded per session plus the `ponytail:` ceiling comments in the workspace.
- **Screen capture** — attach a desktop screenshot to a prompt. Under WSL or a remote
  SSH host the extension delegates to the `claude2-cap` companion extension running on
  the local machine (see `claude2-cap/README.md`).
- **Sign-in handling** — detects auth expiry, runs the CLI login flow, and reports the
  signed-in account.

## Settings

| Setting                        | Default                 | Purpose                                  |
| ------------------------------ | ----------------------- | ---------------------------------------- |
| `claude2.enabled`              | `true`                  | Enable the extension                     |
| `claude2.model`                | `claude-opus-5`         | Default model for new prompts            |
| `claude2.effort`               | `high`                  | Default effort (`low`…`max`)             |
| `claude2.contextWindowTokens`  | `256000`                | Context window shown in conversations    |
| `claude2.maxTurns`             | `50`                    | `--max-turns` per prompt                 |
| `claude2.maxBudgetUsd`         | `0`                     | `--max-budget-usd` per prompt (0 = none) |
| `claude2.permissionMode`       | `auto`                  | CLI permission mode                      |
| `claude2.timezone`             | `America/Los_Angeles`   | Timezone used by the quota pane          |

## Commands

`Claude2: New Session`, `Claude2: Open Instructions`, `Claude2: Open Quota`.

## Development

```sh
npm install
npm run watch      # rebuild on change (esbuild + tsc type-check)
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.
Open the Claude2 view in the activity bar and run **Claude2: New Session** to confirm it works.

`./deploy` bumps the patch version, builds the VSIX, and installs it into WSL, Windows,
and the remote VS Code server, plus the `claude2-cap` VSIX on Windows.

## Scripts

| Script            | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `npm run compile` | Type-check, lint, and bundle to `dist/`        |
| `npm run watch`   | Incremental rebuild while editing              |
| `npm run lint`    | ESLint over `src/`                             |
| `npm test`        | Run integration tests in a VS Code instance    |
| `npm run package` | Production bundle (minified)                   |
| `npm run vsix`    | Build a `.vsix` for local install or publishing|

## Layout

- `src/extension.ts` — activation entry point and `Claude2Controller`, which owns the
  sidebar, conversation panes, management panes, and all webview messaging
- `src/claudeCli.ts` — spawns the `claude` CLI, parses its streaming JSON, tracks run
  status, and truncates transcripts when a turn is forked
- `src/sessionStore.ts` — session and turn persistence in extension global state
- `src/webviews.ts` — HTML/CSS/JS for every pane (sidebar, conversation, instructions,
  quota, markdown, pony, cap)
- `src/quota.ts` — Anthropic usage polling, history file, cross-window sharing
- `src/instructionsFile.ts` — read/write of the workspace `CLAUDE.md`
- `src/capture.ts` — desktop screenshot, local or via the `claude2-cap` companion
- `src/types.ts` — shared session, turn, run, and quota types
- `src/test/` — Mocha tests run by `@vscode/test-cli`
- `claude2-cap/` — separate `ui`-kind extension providing client-side screen capture
- `esbuild.js` — bundler config (CommonJS output to `dist/extension.js`)
- `deploy` — version bump, package, and install to WSL / Windows / remote
- `.vscode/` — launch and task configs for F5 debugging
