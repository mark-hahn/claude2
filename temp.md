# Handoff: model selection — no fallbacks, no hidden model swaps

These changes were made from another conversation, which was accidentally running in the dev-host test project (/root/wsl-apps/test).
All edits are in /root/apps/claude2. Nothing is committed. `npm run compile` (check-types + lint + esbuild) passes, and so does
`node src/test/webview-scripts.check.mjs`. Nothing has been exercised in a running extension host yet.

## Why
The user noticed that 53% of this week's Fable quota was used even though they don't pick Fable. The likely cause: sessions that had picked Fable
earlier kept running it, plus old code paths that quietly swapped in a hard-wired model. The user's rules:
- Never fall back to anything. A prompt runs only on the model the user sees selected; otherwise show an error and send nothing.
- The Models pane default is used ONLY to set the model selector when a new session is created.
- Models pane Save must show an error and save nothing when the setup is invalid (e.g. every model unchecked).
- An old saved turn with no model shows a blank string.
- A malformed model name gives an error and the prompt is refused.
- Report any other hard-wired model use or hidden Claude usage.

## Changes
- src/claudeCli.ts
  - `sanitizeModel` is now exported. It throws on an empty model ("no preset is enabled") and on a malformed name. It used to return "fable".
  - `effortArgs` is now exported. It throws on a malformed effort. An empty effort still means no --effort (e.g. haiku).
- src/extension.ts
  - New `createSession()` copies `defaultPresetOf(...)`'s model/effort into `store.create(model, effort)`. Both callers
    (`newSession` and the stranded-draft rescue) use it. This is the only place the Models pane default is read.
  - `conversationDefaults(sessionId)` now returns only session.model/effort. The preset, the `claude2.model`/`claude2.effort` config,
    DEFAULT_MODEL, and the "retired model falls back" `known` logic are all gone. The sessionId parameter is required.
  - `submitPrompt` checks `sanitizeModel(model)` and `effortArgs(effort)` before running. On failure it calls showErrorMessage
    "Prompt not sent: …", puts the prompt back as the draft (`noteDraft`), and returns.
  - `runTurn` uses the webview's model/effort exactly. The `model || defaults.model` and `model ? effort : defaults.effort` fallbacks are removed.
  - The `savePresets` handler validates inside `reply()`: it throws (and writes nothing) if `presets[defaultPreset]` is not enabled after
    prunePresets (which covers every model unchecked / no preset on), or if an enabled preset has a malformed model (checked via sanitizeModel).
    The pane already shows "Save failed: <error>".
  - Draft naming now calls `generateTitle(draft, session.model, …)` instead of the default model.
- src/modelInfo.ts: `defaultPresetOf` returns the chosen preset only when it is enabled, and undefined otherwise. It no longer falls back to the first enabled preset.
- src/sessionStore.ts: `create(model, effort)` takes the initial picks. `normalizeTurn` defaults model and effort to "" (previously "fable" / DEFAULT_EFFORT).
- src/webviews.ts: the conversation pane's initial selector values are `defaults.model` / `defaults.effort`, with no `|| DEFAULT_*`.
- src/types.ts: `DEFAULT_MODEL` is removed. `DEFAULT_EFFORT` stays (used only by the webview effort picker, see below).
- package.json: the `claude2.model` and `claude2.effort` settings are removed.

## Consequence
Old sessions that never saved picks now open with a blank model and refuse to send until the user picks one. This is intended.

## Still open (reported to the user, not changed; waiting on their answer)
1. Hidden Claude usage:
   - `nameSessionFromPrompt`: an extra low-effort `generateTitle` call on the selected model after the first prompt.
   - `nameSessionFromDraft`: a `generateTitle` call while the user types a draft of six or more words.
   - The quota token-refresh probe (src/quota.ts, `probeQuotaRefresh`) runs `claude -p quota` without --model, so it uses the CLI
     default (`opus[1m]` in ~/.claude/settings.json). It fires only on an expired token or a 401 from the usage endpoint.
   I offered to remove both naming calls and name sessions from their first words only (`firstWords`). No other token-refresh method is known yet.
2. Webview effort picker (`fillEfforts`): when the selected model doesn't offer the current effort, the picker visibly moves to
   DEFAULT_EFFORT ("high") or the list's first entry. It's visible before sending, so it hasn't been changed.
3. Models pane `renderDefault` visibly moves the default selector to the first enabled preset when the chosen one is turned off. Also visible, also unchanged.
4. The seed list in src/modelInfo.ts (models + presets) is hard-wired. It applies only until the pane is first saved on a host.
5. Not implemented: checking the CLI's actually resolved model (the system/init message or result.modelUsage). The init message only
   appears after a prompt is sent, so the model can't be checked before usage.

## Other findings
- The 7d quota graph is correct. The usage API returned 7d = 42% (it reports whole percents only). A 5h window's worth of use adds only about 1% to the weekly.
- /root/wsl-apps/test/claude2 is a stale copy from Sep 16. Don't use it for reference.
