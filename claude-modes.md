# Claude2 slash command support

> is the /cmd prompt format supported in claude2 extension?

Checking past session transcripts to see whether a `/cmd` prompt ever got expanded by the CLI.

Testing it directly: sending a `/cmd` the same way the extension does (stream-json, text-block array).

***

Yes. The extension sends your prompt to `claude -p` exactly as typed (`src/claudeCli.ts:864`), and the CLI handles the slash command itself. I tested it by sending `/context` the same way the extension does. The CLI answered it locally: 0 turns, $0 cost, and it returned the context-usage table.

Only commands the CLI lists for print mode work. That includes your skills and plugin commands (`/code-review`, `/simplify`, `/ponytail:ponytail-help`, …) and some built-ins (`/compact`, `/clear`, `/context`, `/model`, `/usage`, …). Commands that only work in the interactive terminal, like `/help`, `/resume` and `/login`, aren't available, so they would just reach the model as plain text.

---

> /model

Current model: `Opus 5.5` (effort: xhigh)
Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.

---

> /fast

Fast mode unavailable: Fast mode is not available in the Agent SDK

---

> where is fast mode supported

Fast mode is available in:

- **The terminal CLI.** Toggle it with `/fast`, or set `"fastMode": true` in your user settings.
- **The official VS Code extension.** It has a "Toggle fast mode" command.
- **claude.ai/code and cloud sessions.** Use `/fast on`, or the model menu in the browser.
- **The API, through the Console.** It's not offered on Bedrock, Google Cloud or Foundry.

The docs don't mention the desktop app or JetBrains either way.

It only runs on Opus 5.5, Opus 5 and Opus 4.8. On Pro, Max, Team or Enterprise plans it's paid from usage credits, not your subscription limits, so credits must be turned on.

**Why it failed here:** claude2 runs each turn as `claude -p`, which the CLI counts as Agent SDK use. According to the docs, `/fast` in `-p` mode only works if the process was started with `--settings '{"fastMode": true}'`. claude2 doesn't pass that. Right now it only passes `--settings` to turn ponytail off (`src/claudeCli.ts:212`).

Supporting it would mean adding `fastMode: true` to that same `--settings` value, behind a toggle in claude2. I haven't checked whether `/fast` sticks across turns, given that each turn is a fresh `-p --resume` process. Want me to add the toggle?

---

> add checkbox for fast mode to settings pane below Long tool display checkbox

Typecheck passes. Quick check that a non-Opus run doesn't break with the flag on:

***

I added a "Fast mode" checkbox to the Settings pane, just below "Long tool display". When it's checked, each run starts with `fastMode: true` in its `--settings`, alongside the existing ponytail-off setting. It's off by default.

The typecheck passes. A quick Haiku run with the flag on finished normally, so non-Opus models ignore the setting. I haven't tried it on Opus, because that would spend usage credits. That test is yours: check that fast mode really kicks in and that it stays on across turns.

The changes are in `src/settings.ts`, `src/webviews.ts`, `src/claudeCli.ts` and `src/extension.ts`. Nothing is deployed or committed.

---

> test it
> 

Running a real Opus turn with the same flags the extension uses, and checking whether the CLI reports fast mode as active.

***

Fast mode works. I ran two Opus 5.5 turns with the same flags the extension uses, one with the new setting on and one with it off:

| | Setting on | Setting off |
|---|---|---|
| Fast mode reported by the CLI | `on` | `off` (reason: `sdk_opt_in_required`) |
| Speed reported by the API | `fast` | `standard` |
| API time, same 120-token answer | 1.0 s | 4.5 s |
| Cost | $0.40 | $0.12 |

The cost gap isn't purely fast-mode pricing: the second run reused about 10.7k tokens of prompt cache that the first one had just written, which made it cheaper. Both together cost about $0.52.

Fast mode should stay on across turns, because the extension passes `--settings` again every time it starts a run. I tested from the CLI, not by clicking through the Settings pane. The checkbox itself is yours to try after you deploy.

---

> can you measure with purely fast-mode pricing

Rerunning both modes back-to-back with a warm cache so the token mix matches, then pricing identical token counts at each mode's rates.

***

With the cache warm for both, the two runs used exactly the same tokens (2 input, 24,875 read from cache, 120 output). That leaves pricing as the only difference: **fast mode costs exactly 2× standard.**

| | Fast | Standard |
|---|---|---|
| Cost per turn | $0.014766 | $0.007383 |
| API time (2 runs each) | 1.0 s, 1.2 s | 4.2 s, 5.9 s |

The CLI's cost figures match these per-million-token rates:

| Per million tokens | Fast | Standard |
|---|---|---|
| Input | $8 | $4 |
| Cache write (1 h) | $16 | $8 |
| Cache read | $0.40 | $0.20 |
| Output | $40 | $20 |

- **Speed:** fast mode came back about 4–5× faster here. That's only two runs each with a 120-token answer, so expect the ratio to vary on real turns.
- **Billing:** these are the CLI's list-price numbers. On your subscription, a standard turn counts against your plan limits, while a fast turn is billed to usage credits. So the actual extra cost to you is the whole fast-mode price, not just double.

The four runs cost about $0.04 in total.

---

> i can't afford billed to usage credits. are you sure when fast mode checkbox is off it will not be used?

Checking three things: whether any settings file on this box turns fast mode on, what fast-mode state real claude2 runs have reported so far, and every other place the extension starts `claude`.

Now checking that the env var beats even `--settings '{"fastMode":true}'`. I'm using the no-turn initialize handshake so nothing gets billed.

***

Yes. Before today's change, all 45 claude2 runs in the extension's debug log had fast mode off, with the reason `sdk_opt_in_required`. No settings file on this box mentions `fastMode`.

There was still one gap. If you ever turned on `/fast` in the terminal or the official VS Code extension, `fastMode: true` would be saved to `~/.claude/settings.json`, which claude2 runs also read. I couldn't confirm whether a `-p` run would pick that up, so I closed it.

- **Hard off:** when the box is unchecked, each run now also gets `CLAUDE_CODE_DISABLE_FAST_MODE=1` (`src/claudeCli.ts:225`). That beats any settings file. The debug log now records it too.
- **Verified:** I started the CLI with `--settings '{"fastMode":true}'` plus that env var, using a handshake that doesn't run a turn and isn't billed. Fast mode came back `off`, with the reason `disabled_by_env`; without the env var it reports `on`. The typecheck passes.
- **Other `claude` calls:** session titles and quota checks use the cheapest model, which doesn't support fast mode, and the model-list check never runs a turn.

My earlier test runs with fast mode on came to about $0.43 of fast-mode usage. On your plan that was billed to usage credits. I should have pointed that out before running them.

---

> give me a list of modes like fast mode that can be turned on and off

Here are the on/off modes in Claude Code's docs, grouped by what they cost. "claude2" in the table means you could pass it per run through `--settings`, a flag, or an env var, the same way fast mode works.

**Cost extra or use more of your plan**

| Mode | What it does | How to toggle |
|---|---|---|
| **Fast mode** | Opus up to 2.5× faster; bills usage credits on subscription plans | `/fast`, Alt+O, `fastMode` (claude2: checkbox) |
| **Ultracode** | Top effort level that can run workflows with many agents; cost not stated | `/effort ultracode on/off`, `ultracode` key |
| **Advisor** | Asks a second model for guidance at key points; cost not stated, but it's an extra model call | `/advisor <model>` or `off`, `advisorModel` |
| **Prompt suggestions** | Suggests your next prompt; each one counts toward plan usage | `promptSuggestionEnabled`; off by default in `-p` |
| **Auto permission mode** | A classifier model checks actions before they run; billed only on Enterprise and API accounts | Shift+Tab, `--permission-mode auto` |
| **"You should know" mod** | Background checks that count toward plan usage | `/plugin enable` or `disable cc-plugin-you-should-know@builtin` |

**No extra cost stated**

| Mode | What it does | How to toggle |
|---|---|---|
| **Permission modes**: manual (`default`), acceptEdits, plan, dontAsk, bypassPermissions, auto | How much runs without asking | Shift+Tab, `--permission-mode` (claude2: already in Settings) |
| **Effort** | Reasoning depth, low to max | `/effort`, `--effort` (claude2: already a selector) |
| **Extended thinking** | Has no effect on Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable models, which always think | Alt+T, `alwaysThinkingEnabled` |
| **Auto-compact** | Compacts context automatically | `autoCompactEnabled`; `/autocompact` sets the window size |
| **Auto memory** | Claude saves memories itself | `/memory`, `autoMemoryEnabled` |
| **Goal** | Keeps working across turns until a condition is met | `/goal <condition>`, `/goal clear` |
| **Sandbox** | Runs Bash in a sandbox | `/sandbox`, `sandbox.enabled` |
| **Output style** | Response style, e.g. concise | `/output-style`, `outputStyle` |
| **Focus view** | Shows only the last prompt, a tool summary and the final answer | `/focus`; terminal only |
| **Verbose** | Full tool output instead of summaries | `/config verbose=true` |
| **Vim mode** | Vim keys in the prompt box | `editorMode: "vim"`; terminal only |
| **File checkpointing** | Snapshots that `/rewind` restores | `fileCheckpointingEnabled` |
| **Background tasks** | Bash runs in the background | Ctrl+B; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` turns it off |

The docs also list many settings-only switches: hooks, plugins, MCP servers, Remote Control, artifacts, spinner tips, spell check, auto-updates and more.

This came from code.claude.com: the settings, interactive-mode, commands, permission-modes and fast-mode pages. Some of those pages are long and were only partly read word-for-word. That makes these details less certain:
- the extended thinking env var
- the sandbox key
- the spinner tips key
- the auto-compact idle option

Want any of these added to the Settings pane?
