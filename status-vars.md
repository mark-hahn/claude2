
## The scope rule

You spawn one `claude -p --resume` per prompt (`claudeCli.ts:112`), so **every number the CLI emits is scoped to that one run** — one user prompt plus all the agent turns inside it. Nothing in the stream is conversation-wide. Conversation totals only exist because you accumulate them yourself in `ClaudeTurn[]`.

Within a run there are two different scopes, and conflating them is the main trap:

- **Flows** (cost, tokens, turns, duration) — accumulate across the run, and are summable across runs.
- **Levels** (context used) — a snapshot of one API call's prompt size. Never summable, not even within a run.

## `result` message — once, at end of run

| field | is | scope |
|---|---|---|
| `num_turns` | 11 in the big capture | this run |
| `total_cost_usd` | 0.899 | this run |
| `usage.input_tokens` | 17 | this run, summed over API calls |
| `usage.output_tokens` | 3,902 | this run, summed |
| `usage.cache_read_input_tokens` | 273,880 | this run, summed |
| `usage.cache_creation_input_tokens` | 21,505 | this run, summed |
| `duration_ms` / `duration_api_ms` | 60,634 / 51,005 | this run |
| `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms` | 1,489 / 1,393 / 460 | this run |
| `stop_reason`, `terminal_reason`, `subtype`, `is_error`, `api_error_status` | terminal state | this run |
| `permission_denials[]` | array | this run |
| `modelUsage[model]` | per-model tokens + `costUSD` + **`contextWindow`** + `maxOutputTokens` | this run |
| `fast_mode_state` | "off" | session |

`modelUsage[m].contextWindow` reported 1,000,000 for fable — your UI hard-codes 256,000 (`types.ts:1`). That's the authoritative window and it's free in the stream.

## Live stream (per API call, arrives during the run)

- `stream_event / message_start.message.usage` — **the only true context reading.** `input + cache_read + cache_creation` = prompt size going into that call. Latest wins; your comment at `claudeCli.ts:281` has this right.
- `stream_event / message_delta.usage` — same call, with `output_tokens` final and `output_tokens_details.thinking_tokens`.
- `system / thinking_tokens` — `estimated_tokens` (cumulative within the current thinking block) + `estimated_tokens_delta`. A live thinking counter you're not using.
- `system / status` — `"requesting"`, a phase hint that fires per API call.
- `system / init` — once at start: `model`, `permissionMode`, `cwd`, `claude_code_version`, tool/skill/agent lists.
- `rate_limit_event.rate_limit_info` — `status`, `rateLimitType: "five_hour"`, `resetsAt`, `overageStatus`, `isUsingOverage`. Account-scoped. This is the same data `quota.ts` polls over HTTP, arriving free mid-run — you currently discard it at `claudeCli.ts:337`.

## What to display, and as what

Conversation totals (sum across turns): cost, output tokens, elapsed. Cost is the one worth the most pixels — it's the only number with a hard budget attached, and per-run it's meaningless while per-conversation it's the thing you actually watch.

Latest only (never summed): context used / window, phase, stop reason.

Per-turn row (last response): duration, cost, turns, stop reason.

Two things worth fixing while you're in here:

1. `tokensIn` sums `usage.input_tokens` only (`claudeCli.ts:483`, `webviews.ts:559`). That's the uncached remainder — 17 tokens for a 60-second run. The displayed "tokens N in" is effectively always near zero. Real input is `input + cache_read + cache_creation`, which is what `usageTotals().context` already computes.
2. Your `status.turns` counts `message_start` events (9 in the capture); `result.num_turns` said 11. Since `--max-turns` is enforced by the CLI's own counter, the `turns N/limit` gauge should reconcile to `num_turns` at end of run — otherwise the bar reads low right up until the run gets cut off.
