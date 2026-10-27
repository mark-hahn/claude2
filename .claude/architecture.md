# claude2 architecture

A VS Code extension that runs Claude Code in a sidebar session list and one editor pane per
session. It drives the `claude` CLI headless (`-p`, stream-json in and out), never a terminal.
The same build is installed on three hosts: WSL, Windows, and hahnca.com over Remote-SSH
(`./deploy`, which the user runs).

## Layout

- `src/extension.ts`: `Claude2Controller`, all host-side logic. One dispatcher per webview
  kind (`handleSidebarMessage`, `handleConversationMessage`, `handleManagementMessage`,
  `handleSnipsMessage`); prompts (`submitPrompt` → `runTurn`); images and file attachments;
  login/auth; fork; the Ctx popup (`postContextStats`). Posts state back with
  `postConversationState` / `postTurnDelta` / `refreshSidebar`.
- `src/claudeCli.ts`: `ClaudeCliRunner`. Spawns one CLI process per run, parses its stream
  (`handleClaudeLine`), keeps `RunningStatus`, and stops a run with an interrupt. While a
  background task runs, a new prompt joins the live process (`followUp`). Side jobs: titles,
  change descriptions, the model list, model windows, and `contextUsage`. Also the transcript
  helpers: `transcriptPath`, `copy/swap/truncateSessionTranscript`.
- `src/webviews.ts`: the HTML, CSS and JS of every webview, as template strings:
  `sidebarHtml`, `conversationHtml`, `managementHtml` (panes instructions | quota | plugins |
  models | settings | cap), `snipsHtml`.
- `src/contextStats.ts`: the Ctx popup's table (tokens by source), built from the transcript
  plus the CLI's own counts.
- `src/sessionStore.ts`: sessions and turns in workspaceState (key `hahnca.claude2`, field
  `claude2.sessions.v1`). On WSL that lives in the Windows-side `state.vscdb`.
- `src/quota.ts`: plan usage windows (5h, 7d, model) from Anthropic's usage endpoint, history
  and projection.
- `src/pluginStats.ts`: per-install counters and per-project plugin flags (graft, ponytail),
  kept on the stats server.
- `src/settings.ts`: the Settings pane's values. The copy on the stats server wins, cached in
  globalState.
- `src/modelInfo.ts`: the CLI's model list, the M-button presets, per-model prefs, `advisorFor`.
- `src/capture.ts`: Cap screenshots by three routes. Windows uses PowerShell directly; WSL uses
  the same PowerShell through `/mnt/c`; the server asks the `claude2-cap/` UI-side extension
  on the client.
- `src/gitCheck.ts`: the optional "Git changes check": one API call (the `claudeApiKey`
  setting, not the subscription) before a new session's first prompt.
- `src/instructionsFile.ts`: the Instructions pane edits the project CLAUDE.md and keeps
  `.github/copilot-instructions.md` an identical mirror.
- `src/types.ts`: shared types and constants (tool-line and answer marks, the 33k compact
  reserve).
- `claude2-stats/`: a small node server on hahnca.com:7301 (pm2 `claude2-stats`, deployed to
  `/root/dev/apps/claude2-stats` there). Its endpoints are listed at the top of `server.js`.
- `esbuild.js`: builds `dist/extension.js` and the Monaco prompt editor
  (`dist/promptEditor.js` plus its worker) that the conversation webview loads.

## Main flows

- **A prompt.** Webview `submitPrompt` → extension `submitPrompt` (draft, git check, interrupt
  confirm) → `runTurn` stores the turn → `runner.runPrompt` spawns the CLI. Text deltas are
  throttled into `turnDelta` posts every 80ms; status goes out through `postConversationState`.
  The result line settles the turn: `tokensIn`/`tokensOut` are the result usage (summed over
  every API call), `contextUsed` is the latest call's level, plus cost.
- **Session ↔ transcript.** A claude2 session id is the CLI session id. The transcript lives at
  `~/.claude/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`. `--resume` or
  `--session-id` is picked by whether that file exists. `/clear` makes the CLI move to a new id;
  claude2 swaps the two files so the session keeps its own id. A fork copies the transcript,
  then cuts it at a prompt boundary.
- **Control channel.** `claude -p` in stream-json with no prompt answers `control_request`s
  (`initialize`, `set_model`, `get_context_usage`) without running a turn. Model windows and the
  Ctx popup use it (`controlChannel`). Resuming a real session id writes bookkeeping lines into
  its transcript, so probes always resume a throwaway copy and delete it after the process exits.
- **The footer's context gauge.** It shows the latest stream event's usage (input + cache read
  + cache write + output) against `compactAtOf(window)` = window − 33k, where the CLI
  auto-compacts.
- **Shared state across machines.** Settings, plugin stats and flags, the quota-poll lease, and
  per-model hours all go through claude2-stats, plain HTTP on the LAN. A server that is down
  falls back to local copies; it never throws.

## Gotchas

- Webview JS lives inside TS template literals, so neither tsc nor eslint sees it. Run
  `node src/test/webview-scripts.check.mjs` (its header has the build commands). In those
  strings `\'` comes out as a bare `'` and breaks the script: use `’` or `\\'`. `${` interpolates.
- claude2 sends prompts as a list of text blocks (`userMessage`), so transcript prompts are
  arrays, not strings. A real prompt is a top-level user entry with `promptSource`.
- Transcript replies are written one line per content block, every line carrying the same
  `message.id` and usage: dedupe by id. Subagents have their own files under
  `<session id>/subagents/`.
- Result usage sums all of a run's calls, cache reads included, so it is never a context
  level. Thinking blocks are kept and re-sent on later calls.
- The child env drops `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, so billing stays on the
  subscription. The advisor is set only per run through `--settings advisorModel`, never by
  `/advisor`. How often it's called has no setting: `claude2SystemPrompt` adds a line asking
  for fewer calls whenever a run has an advisor.
- Graft is turned off per project by pointing `GRAFT_DIR` at an empty dir, ponytail by
  `enabledPlugins` in `--settings`.
- `--max-turns` is counted by the CLI (`num_turns`), not by `message_start` events.
- WSL runs in NAT mode: Windows services aren't reachable at `localhost`, and F5 debugging never
  attaches (the launch config is `noDebug`; Ctrl+F5 works).
- Every webview follows CLAUDE.md's display rules: font sizes 14–18px only, text solid black.
