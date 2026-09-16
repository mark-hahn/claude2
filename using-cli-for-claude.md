# Prompt: drive Claude through the Claude Code CLI (Agent SDK) with streaming, stop, quota monitoring and a spend log

This describes a pattern that is running in production in another project (a Node
server on Linux). Reproduce the same logic in this project, which runs under
**WSL** (Windows Subsystem for Linux). Everything below runs *inside the WSL
distro*: Node, the `claude` CLI, its credentials file and this app. Nothing
touches the Windows side.

## What the pattern is

Every LLM call goes through the Claude Code harness, not the Messages API. The
app spawns a Claude Code session via `@anthropic-ai/claude-agent-sdk`'s `query()`.
Reasons, all still true:

- **Billing.** The session authenticates with the CLI's OAuth login, so work is
  charged to the Claude Max subscription while quota lasts and rolls onto usage
  credits (API rates) after that. Below the wall it is free; above it, identical
  to an API key. Strictly dominant over an API key.
- **The harness owns the tool loop.** Tools are in-process MCP servers the
  harness calls directly. The app watches tool use go past on the stream instead
  of executing it between turns. `maxTurns` and `maxBudgetUsd` replace a
  hand-written loop.
- **The harness prefix is removable.** By default a session carries ~25-29k
  tokens of Claude Code's system prompt, built-in tool schemas and CLAUDE.md.
  `tools: []`, an explicit `systemPrompt` and `settingSources: []` take it to a
  few hundred tokens. Do not use `--bare` / bare mode: it disables OAuth.

Dependencies: `@anthropic-ai/claude-agent-sdk` (^0.3.x) and `zod` (the SDK's MCP
tool helper takes Zod shapes; zod is already a transitive dep of the SDK).
Node >= 22.

## WSL setup (do this first)

1. Inside WSL, install Node 22+ and Claude Code, then run `claude` once in a WSL
   terminal and sign in to the subscription. That writes
   `~/.claude/.credentials.json` in the WSL home directory (or under
   `$CLAUDE_CONFIG_DIR` if set). The Windows-side `%USERPROFILE%\.claude` is a
   different, unrelated login; the app never reads it.
2. If the app runs as a daemon (systemd in WSL, pm2, a Windows service that
   launches `wsl.exe`), an interactive OAuth flow is not available. Use
   `claude setup-token` in WSL to issue a long-lived subscription token, or make
   sure the same Linux user that logged in is the one running the app so it
   finds the credentials file.
3. Make sure `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are **not** set in
   the WSL environment of the app, and strip them from the child env anyway
   (see `childEnv()` below). A stray key silently diverts billing to the API.
4. If the app is launched from Git Bash / MSYS via `wsl.exe`, MSYS mangles
   `/mnt/c/...` style arguments. Set `MSYS_NO_PATHCONV=1` for that launch.
5. WSL clocks can drift after sleep/resume; the quota window math below uses
   `Date.now()`. If readings look wrong after the laptop wakes, that is why.

## Module 1: `agent.js` -- one function runs every session

```js
import { query } from '@anthropic-ai/claude-agent-sdk';

export const MODEL = 'claude-opus-5';        // pick per project

function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const PHASES = { thinking: 'thinking', text: 'writing', tool_use: 'querying' };

function readUsage(session) {
  // Experimental SDK call; absence or failure is not an error.
  const fn = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof fn !== 'function') return null;
  return Promise.resolve(fn.call(session)).catch(() => null);
}

export async function runAgent({
  system, prompt, schema = null, tools = null /* {serverName: mcpServer, allowed:[...]} */,
  maxTurns = 1, effort = 'high', maxBudgetUsd = null, control = null, on = () => {},
}) {
  const abort = new AbortController();
  if (control) control.abort = () => abort.abort();

  const options = {
    model: MODEL,
    systemPrompt: system,        // REPLACES Claude Code's prompt
    tools: [],                   // no Read/Edit/Bash etc.
    settingSources: [],          // ignore ~/.claude and repo CLAUDE.md
    persistSession: false,       // the app stores its own transcript
    includePartialMessages: true,// gives stream_event deltas
    maxTurns,
    effort,
    abortController: abort,
    env: childEnv(),
    strictMcpConfig: true,
  };
  if (schema) options.outputFormat = { type: 'json_schema', schema };
  if (maxBudgetUsd != null) options.maxBudgetUsd = maxBudgetUsd;
  if (tools) { options.mcpServers = tools.servers; options.allowedTools = tools.allowed; }

  const session = query({ prompt, options });
  let result = null, turns = 0, assistantError = null, answering = false, usageRead = null;

  for await (const msg of session) {
    if (control?.aborted) { abort.abort(); break; }
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          noteSession(msg);
          // Must be issued while the session is alive (control request on the
          // same pipe). Apply the reply the moment it arrives, not after the run.
          usageRead = readUsage(session).then(noteUsage);
        }
        break;
      case 'rate_limit_event':
        noteRateLimit(msg.rate_limit_info);
        break;
      case 'stream_event': {
        const ev = msg.event;
        if (ev.type === 'message_start') {
          turns += 1;                                   // one per API turn
          on({ turn: { n: turns, usage: ev.message?.usage } });
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          // Structured output arrives as a FORCED TOOL CALL, not text. A
          // tool_use block that is not one of our tools is the answer.
          answering = b?.type === 'tool_use' && !isOurTool(b.name);
          on({ phase: answering ? 'writing' : (PHASES[b?.type] ?? 'working') });
        } else if (ev.type === 'content_block_stop') {
          answering = false;
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') on({ text: ev.delta.text });
          else if (answering && ev.delta.type === 'input_json_delta') on({ text: ev.delta.partial_json });
        }
        break;
      }
      case 'assistant':
        if (msg.error) assistantError = msg.error;   // auth/billing failures land here
        break;
      case 'result':
        result = msg;
        break;
    }
  }
  await usageRead;

  if (control?.aborted) return { stopped: true, turns, billing: billingOf() };
  if (assistantError) throw new AgentError(assistantError);
  if (!result) throw new AgentError('no_result');
  if (result.is_error) throw new AgentError(result.subtype, result);

  return {
    structured: result.structured_output ?? null,
    text: typeof result.result === 'string' ? result.result : '',
    usage: result.usage ?? null,
    costUsd: result.total_cost_usd ?? null,   // notional list price, from the session
    stopReason: result.stop_reason ?? null,
    terminalReason: result.terminal_reason ?? null,
    billing: billingOf(),                     // 'quota' | 'credits'
    turns: turns || result.num_turns || 1,
  };
}
```

`AgentError(kind, result)` maps the SDK's error subtypes to user-facing messages
and to a one-word `errorKind` for the log. Kinds seen: `authentication_failed`,
`oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `rate_limit`,
`overloaded`, `invalid_request`, `model_not_found`, `server_error`,
`max_output_tokens`, `error_max_turns`, `error_max_budget_usd`,
`error_max_structured_output_retries`, `no_result`. An `AbortError` is "Stopped".

Key facts to keep:

- `message_start` carries the input-side usage already, so the readout moves
  during a long turn. Cost is only known at the end (`total_cost_usd` on the
  `result`). Do **not** estimate cost from streamed characters: summarised
  thinking makes it ~4x low.
- With `outputFormat` set there are **no `text_delta` events**; the JSON streams
  as `input_json_delta` on a `tool_use` block. Forward those as text and pull
  the field you want out with a streaming reader (Module 3).
- Put the human-readable field **first** in the JSON schema; structured output
  is generated in schema order, so prose reaches the page while the long field
  is still being written.
- `stopped` is not an error: the app returns `{stopped:true}` and stores nothing.

## Module 2: tools as in-process MCP servers

```js
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

export const SERVER = 'myserver';
export const TOOL_NAME = `mcp__${SERVER}__mytool`;   // the allowedTools string

export function makeServer() {                        // NEW INSTANCE PER SESSION
  return createSdkMcpServer({
    name: SERVER, version: '1.0.0',
    tools: [tool('mytool', DESCRIPTION, { arg: z.string().describe('...') },
      async ({ arg }) => {
        try { return { content: [{ type: 'text', text: doWork(arg) }] }; }
        catch (e) { return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }; }
      })],
  });
}
```

- **Build the server fresh for every session.** A shared instance holds one
  transport; two overlapping sessions leave the second with no tool and no
  error (the SDK logs it at debug level and drops the server).
- A failed tool must still return a result (`isError: true`); throwing strands
  the turn.
- Cap tool output by rows *and* bytes; every tool result is re-read on every
  later turn of the same session. Put "ask for the least that answers the
  question" guidance in the tool description.
- Any "nudge" the old hand-written loop injected between turns becomes a
  standing line in the system prompt or the tool description.

## Module 3: streaming the reply to the browser

Server: SSE over a **POST** (the request carries a body, so `EventSource` cannot
be used). Set `content-type: text/event-stream`, `cache-control: no-cache,
no-transform`, `x-accel-buffering: no`, call `flushHeaders()`, and write
`event: <name>\ndata: <json>\n\n` blocks. Events used: `text` (prose delta),
`status` (progress object), `done` (`{turn}` or `{stopped:true}`), `error`.
Refuse a second submission on the same conversation with 409 while one is in
flight. On `res.on('close')` stop the turn: a closed tab is still being billed.

Browser: `fetch()` the POST, read `res.body.getReader()`, decode, split the
buffer on `\n\n`, parse `event:`/`data:` lines, `JSON.parse` the data. Guard only
the parse, not the handler, or handler bugs vanish silently.

Streaming readers for structured output: a best-effort scanner over the
accumulating JSON text that finds `"response"\s*:\s*"` and decodes the string
forward one escape at a time, returning newly decoded characters; wait for the
next chunk when an escape (`\` or `\uXXXX`) is split across chunks. A second
scanner counts `\n` inside the `"code"` field to report lines written so far.
Both only drive the display; what is stored comes from parsing the finished
message.

Progress object (`statusOf(id)`), kept per conversation in a Map and frozen when
done (kept ~30 min so the row can still show what the last run cost):
`{active, turns, maxTurns, costUsd, contextTokens, codeLines, phase, elapsedMs}`.
`phase` is `thinking | writing | querying | working | null`. Update it on
`turn`, `phase` and code-line events and push `status` over SSE each time. Also
expose it on a GET so a reloaded page can recover it.

Stop: a per-conversation `{aborted, abort}` control object in a Map. The stop
route flips `aborted` and calls `abort()` (kills the CLI process); the running
request unwinds and reports `stopped`. Nothing is written until a turn lands, so
a stopped turn needs no undo. The entry is deleted only when the session has
actually ended, so `turnInFlight()` stays true through the unwind.

Constants that worked: `MAX_TURNS = 8`, `MAX_BUDGET_USD = 2` (a guard rail, not
a budget: free within quota, the only brake once on credits), `effort: 'xhigh'`
for code-writing turns, `'low'` for small labelling calls.

## Module 4: quota monitoring (`quota.js` + `quota-poll.js`)

Three sources, one state object, one reader function each:

1. `rate_limit_event` on every session turn: `{status, resetsAt (unix s),
   rateLimitType, utilization?, overageStatus, overageResetsAt, isUsingOverage}`.
   `utilization` appears only once a window crosses a warning threshold, so keep
   the last known figure rather than blanking it. `isUsingOverage` is the
   billing switch: `billingOf()` returns `'credits'` when true, else `'quota'`.
2. The SDK's experimental `/usage` call at session `init` (every window's
   percentage). Same payload shape as 3.
3. A **five-minute timer** that GETs
   `https://api.anthropic.com/api/oauth/usage` with
   `Authorization: Bearer <accessToken>` and `anthropic-beta: oauth-2025-04-20`,
   token read from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
   (`expiresAt` alongside). Undocumented endpoint; ~300 ms; no process spawn; no
   model request. Reshape `body.limits[]` entries whose `scope.model.display_name`
   is set into a `model_scoped` array so the same `noteUsage()` reads both.

Rules learned the hard way:

- **Never refresh the OAuth token yourself.** The refresh token rotates on use
  and a running CLI session would be left holding a dead one. On expiry or a
  401, run one `probeQuota()` -- start a session with `tools: []`, read
  `/usage` at `init`, abort immediately -- which makes the CLI refresh and
  rewrite the file, then retry the read. Serialise probes (one at a time).
- The usage endpoint rate-limits: honour `retry-after` (seconds or HTTP date),
  never pause less than a minute, default 15 min when the header is absent.
- Serve a reading under a minute old rather than re-reading; share an in-flight
  read between concurrent callers; a forced read (an Update button) queues
  behind one in flight.
- Windows: `five_hour` (18000 s), `seven_day` and the `seven_day_*` variants
  (604800 s). A window nobody has spent from since reset comes back as 0% with
  `resets_at: null`; **keep the null**, never inherit the previous reset, or the
  history graph draws the finished period falling to zero.
- Budget multiple = `utilization / elapsedFraction` where
  `elapsed = 1 - (resetsAt - now)/windowLength`; suppress below 3% elapsed, cap
  at 9.9. Above 1.0 means on course to run out before the reset.
- Usage credits come back as minor units with `decimal_places`; convert once.
- Log endpoint failures only when the reason changes, not every tick.
- Persist readings to a `quota_reading` table only when a figure moved or an
  hour has passed (heartbeat), so a quiet day is one row. Routes: `GET /quota`
  (take a reading, return state) and `GET /quota/history[?force=1]`.

Status row text format that stays under ~35 chars: `5h 8% 0.6 10:22, 7d 16% 0.4
8/13, $ 8/31`. Reset shows `HH:MM` under 24 h away, else `M/D`; the percent slot
is absent when unknown; over-budget is colour, not characters; dim the row when
stale and put the exact fetch time in `title`.

Decide deliberately what the app does on `isUsingOverage: true` (stop, warn,
drop model, or carry on). The event precedes the assistant message, so the
policy applies to the *next* turn.

## Module 5: the spend log (`llm_call`)

One row per session, written by `logCall({source, purpose, promptId, result,
error})`: `source` (which feature spent it), `purpose`, `model`, `prompt_id`,
`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, `stop_reason`, `cost_usd`, `billing`
(`api | quota | credits`), `turns`, `ok`, `error`, `error_kind`. `cost_usd` is
the session's own `total_cost_usd`: notional list price, real money only when
`billing = 'credits'`. Show quota-covered figures with an asterisk and total
billed and covered separately.

## Things measured that shape the design

- Default session prefix 29k input tokens; with `tools: []` 175. A prefix that
  small is below the cacheable minimum, and that is still ~30x cheaper than a
  perfectly cached default prefix. Cache what is yours (the conversation
  history), not the harness's.
- Subscription prompt cache TTL is one hour; on credits or an API key it is five
  minutes. The cache is server-side and keyed on prefix bytes, so consecutive
  spawned processes do share it.
- Cold spawn: 1.5-3 s to first token. The quota probe costs about four seconds
  and no tokens.
- The `--output-format json` result envelope carries nothing about quota; only
  the stream has `rate_limit_event`.
- The CLI fires a small haiku side-call for session titling that lands in the
  same usage; `persistSession: false` and the session's own cost figure absorb
  it.
