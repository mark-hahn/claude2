# The "Plan quota over time" pane, and how to build it in another project

Written 2026-09-15 from the finance app on hahnca.com (`/root/dev/apps/finance`).
Everything below is what that app actually does today; the numbers were read from
the code, not remembered. Source files to copy are listed in section 5. Section 6
is a prompt you can hand to a coding agent in the other project.

## 1. What the pane is

A workspace pane opened by a `$` glyph button. It draws every reading of the
Claude Max plan's quota the server has ever recorded, as three graphs side by side:

| graph | name shown | series | x axis is one full period of | y axis |
|---|---|---|---|---|
| 1 | `5h` | five-hour session window | 5 hours, ending at the window's reset | 0–100% |
| 2 | `7d` | weekly window (blue) and the model-scoped weekly cap (red, "fable") | 7 days, ending at the weekly reset | 0–100% |
| 3 | `credits` | usage-credit spend this month, in dollars | the calendar month | $0 to the monthly credit limit |

What the user sees, top to bottom:

- **Heading row**: the title `Plan quota over time`; then, pushed right, the time of
  day (HH:MM:SS, household timezone) of the server's last successful reading; then
  its age as `m:ss` (ticks every 10 s, click re-reads the wall clock); then an
  `Update` button (forces a fresh reading now, disabled while one is out) and `Close`.
- **Three graphs in a row**, each with:
  - a name line, with a legend of colour swatches on the shared 7d graph only;
  - `‹ label ›` arrows that page through the periods the recordings fall into.
    The label names the period by one moment: the 5h graph prints the period's
    end as `M/D HH:MM`, the 7d graph prints the end as `Thu 9/18`, the month
    graph prints the month name;
  - the plot (SVG): horizontal gridlines at 0/50/100% (or $0 / half / limit),
    vertical gridlines at the period's natural divisions, a dashed diagonal
    **pace line** from bottom-left to top-right, and the data lines;
  - a figures line under the plot: each series' latest value in its own colour
    (`18%`, `37%` `62%`, or `$0.00`), then for the two percentage graphs how far
    the period has elapsed (`42%`) and how long it has left (`2d 5h left`,
    `1h 12m left`, `9m left`, or `period over`).
- **Click a plot** and that graph takes the whole pane; a click anywhere in the graph
  area other than the arrows puts the trio back. The arrows keep working while expanded.
- **Empty states**: `Taking a reading…` before the first response; an error line if
  the first load fails; `Nothing recorded yet…` when the table is empty.

The pace line is the point of the graph. A point on it is spending the period's
whole allowance exactly as fast as the period elapses; above it is faster, below
it slower. The data line is carried level from its newest reading to the last
moment the figure is known to have held (see 4.4), so a quiet stretch reads as a
flat line, not a gap.

Colours: black ink for everything, except blue `#2457d6` for the 7d line and red
`#c62828` for the model-scoped line, because two black lines on one plot cannot
be told apart. Light theme only.

## 2. Where the numbers come from

Claude Code's own `/usage` page is a plain GET to an OAuth endpoint, and the same
call works from any process on the machine using the CLI's stored bearer token.
No process spawn, no model request, roughly 300 ms.

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <accessToken>
anthropic-beta: oauth-2025-04-20
Content-Type: application/json
```

The token comes from Claude Code's credentials file:
`$CLAUDE_CONFIG_DIR/.credentials.json`, defaulting to `~/.claude/.credentials.json`.
Its shape is `{ "claudeAiOauth": { "accessToken", "refreshToken", "expiresAt", ... } }`
with `expiresAt` in ms since epoch. Under WSL this is the Linux home directory of
the user who ran `claude login`. (On macOS the CLI keeps it in the Keychain instead,
so this file-read approach is Linux/WSL/Windows only.)

**The endpoint is undocumented and its body changes.** Most window keys are internal
codenames and null. Only these parts are used; everything else is ignored:

```jsonc
{
  "five_hour":  { "utilization": 20, "resets_at": "2026-09-15T23:20:00.468371+00:00", ... },
  "seven_day":  { "utilization": 37, "resets_at": "2026-09-18T04:00:00.468394+00:00", ... },
  "extra_usage": {
    "is_enabled": true, "monthly_limit": 5000, "used_credits": 0,
    "decimal_places": 2, "utilization": null, "spend_limit_reached": false, ...
  },
  "limits": [
    { "kind": "session",       "percent": 20, "resets_at": "...", "scope": null },
    { "kind": "weekly_all",    "percent": 37, "resets_at": "...", "scope": null },
    { "kind": "weekly_scoped", "percent": 62, "resets_at": "...",
      "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } }
  ]
}
```

Reading rules, all of which matter for the graph to be honest:

- `five_hour` and `seven_day` are keyed objects: `utilization` is 0–100 (may be
  null), `resets_at` is ISO 8601 (may be null). Convert `resets_at` to whole unix
  **seconds**.
- **A null `resets_at` must be kept as null.** A window nobody has spent from
  since its last reset is not open: it comes back as `0%` with a null reset. An
  earlier version fell back to the last reset seen, which stamped the idle zero
  with the period that had just ended and made the graph draw that period
  dropping to nothing at its right edge.
- The model-scoped weekly cap is **not** a keyed window (the `seven_day_opus` /
  `seven_day_sonnet` slots come back null). It is the entry in `limits[]` whose
  `scope.model.display_name` is set. Take `percent` and `resets_at` from it. The
  display name today is `Fable`; key the column by whatever name you see, lower-cased.
- Usage credits are money in minor units with their own exponent:
  `used_credits: 7481` with `decimal_places: 2` is `$74.81`. Convert once, at
  read time, and store dollars. `monthly_limit` converts the same way. Note the
  `extra_usage.utilization` is often null; the graph uses dollars, not it.
- Both weekly windows' resets land on the same second (give or take one), which
  is what lets them share one graph.

**Rate limit on the endpoint** (measured 2026-09-07): ten calls inside five
minutes drew a 429 with `retry-after: 197`; a steady call a minute lasted
eighteen minutes before a 429 with `retry-after: 0`; a garbage token drew an
hour from what looks like a separate unauthenticated limiter. Five-minute
polling sits far under all of that.

**Token refresh.** The access token lives eight hours and the CLI renews it
lazily on its next request, rewriting the file. The refresh token rotates on
use, so a second process that refreshed behind the CLI's back would leave a
running Claude Code session holding a dead token. **Never refresh it yourself.**
When the file says the token is expired, or the endpoint answers 401, make the
CLI do it: start one Claude Code session (Agent SDK `query()` with `maxTurns: 1`,
no tools, a one-word prompt) and abort it the moment the `system`/`init`
message arrives. That costs a process spawn and no tokens, the CLI rewrites the
credentials file, and the read is retried once. In practice this fires a few
times a day at most and usually never, because interactive use refreshes first.
It also keeps the refresh token alive, which would otherwise age out after
fifteen idle days. If the other project has no SDK dependency, an equivalent is
`claude -p quota --max-turns 1` killed on first output.

(History: before 2026-09-07 the app read quota only from a Claude Code session's
`rate_limit_event` messages and the SDK's experimental `usage_…` call. That
opened idle windows by the act of looking at them and sent a real model request.
The direct GET replaced it.)

## 3. Server side

### 3.1 Poller

- One reading 5 s after startup, then **every 5 minutes**.
- Also a reading when the pane opens, when the app loads, and after every
  Claude submission (the moments the figure has just moved).
- A reading under **60 s** old is served again rather than re-read, unless
  `force` (the Update button). Concurrent callers share the fetch in flight; a
  forced read queues behind one in flight rather than joining it.
- Fetch timeout 5 s.
- On 429: go quiet for `retry-after` (seconds or HTTP date), never less than
  60 s, and 15 minutes when the header is absent. A `0` means "the next tick",
  not a hammering retry. A forced Update does not override the pause.
- Failures (no login, 401 after refresh, non-200, network) are logged **once per
  change of reason**, not every five minutes, and never thrown to the caller:
  feeding the graphs is never worth an error. The last good reading is what gets
  served.
- Keep in memory: the reshaped state and `lastReadAt` (ms of the last
  *successful* read, 0 if none). After a failed read `lastReadAt` stays old so
  the graph's carried line honestly stops where the data does.

### 3.2 Storage

```sql
CREATE TABLE IF NOT EXISTS quota_reading (
  at           INTEGER PRIMARY KEY,  -- ms since epoch, the reading's own time
  five_pct     REAL,
  five_resets  INTEGER,              -- unix seconds
  seven_pct    REAL,
  seven_resets INTEGER,
  fable_pct    REAL,                 -- the model-scoped weekly window
  fable_resets INTEGER,
  spent_usd    REAL,                 -- usage credits spent this month, dollars
  limit_usd    REAL                  -- monthly credit limit, dollars
);
```

Write rule (the only writer of this table): after every successful reading,
insert a row **only if** any of the eight value columns differs from the newest
row (null-aware compare), **or** the newest row is an hour or more old. So a
quiet day is one heartbeat row an hour rather than 288 identical rows, and a
running period still plots up to roughly now. `INSERT OR IGNORE` on the `at`
primary key. The live table holds about 1,300 rows after two weeks.

### 3.3 Routes

```
GET /api/quota
  takes a reading (or reuses one < 60 s old), returns the in-memory state
  {at, available, subscription, credits, windows:[...]}. The page calls this on
  load and after each submission purely to make a point land on the graph.

GET /api/quota/history[?force=1]
  takes a reading (forced if force=1), runs the write rule, then returns
  { readAt: <ms of last successful read or null>,
    rows:   SELECT * FROM quota_reading ORDER BY at }
```

## 4. Client side: how the graphs are built

All time arithmetic is in the household timezone (`America/Los_Angeles` in the
finance app; pick yours). The client fetches `/quota/history` on open and every
5 minutes while open, keeps a 30 s wall-clock tick for the elapsed/left figures,
and a 10 s tick for the `m:ss` age (also re-read on `visibilitychange`, window
focus, and click).

### 4.1 Carving readings into periods (5h and 7d graphs)

- A window's period is named by its reset second, which every reading carries.
  The reset the endpoint reports can drift a second or two between readings, so
  any reading whose reset is within **600 s** of a period already seen belongs to
  that period. No two real periods of a 5-hour-plus window can sit that close.
- Period span is `[reset − length, reset]` with length 5 h or 7 d.
- A reading with a null reset belongs to no period (window not open).
- A reading `r` with value field `f` belongs to a period ending at `end` when
  `r[f] != null` and either `r.at <= end`, or `r[f] > 0 && r.at − end < 600 s`.
  The second case is the reset rolling over a couple of minutes late, when the
  percentage is still the old period's; it is drawn at `min(r.at, end)`. A zero
  just after `end` is the next, unopened window and is dropped. Anything later
  is stale and dropped.
- Both weekly series (7d and model-scoped) are grouped by the **7d** reset,
  since their resets coincide.
- Drop a period with no points in any series. Sort periods by reset.

### 4.2 Month periods (credits graph)

- Group rows with a non-null `spent_usd` by the local year-month of `r.at`.
- Period span is local midnight starting the 1st to local midnight starting the
  next 1st (compute each midnight with the UTC offset read at that moment, so a
  DST change inside the month is handled).
- `yMax` is `limit_usd` from the **newest** row of the month that has one, so a
  mid-month limit change moves the axis instead of clipping the line; if no row
  has a limit, use `max(1, max spent)`.

### 4.3 Gridlines

Only lines strictly inside the period; the frame draws the ends.

- 5h: every clock hour.
- 7d: the period's own start (nothing else draws the left edge), then one line a
  day at the **reset's time of day** rather than at midnight, so each marks a
  whole day of the period. Step by re-snapping to local midnight three hours past
  the next midnight, so a 23- or 25-hour DST day keeps its time of day.
- month: the 1st, then every Sunday at local midnight.
- Horizontal: 0 / 50 / 100% labelled `0%` `50%` `100%`, or `$0` / `$limit/2` /
  `$limit` rounded.

### 4.4 Drawing

- Drawing space 320 × 200 with margins left 40 (room for y labels), right 6,
  top 6, bottom 6; `x(t)` is linear over `[start, end]`, `y(v)` is linear over
  `[0, yMax]` with `v` clamped to `yMax`.
- Pace line: from `(x(start), y(0))` to `(x(end), y(yMax))`, dashed `5 4`,
  black at 45% opacity, thinner than data.
- Gridlines: black at 15% opacity.
- Data: polyline, stroke width 1.6, no fill, the series' colour.
- **Carried level**: `knownTo = min(period.end, readAt)`. If a series' last point
  is earlier than `knownTo`, append `{t: knownTo, v: lastValue}`. This is why
  rows are only written on change: an unchanged figure has no row of its own.
- A series with fewer than two points draws a dot (r 2.4) instead, since a
  one-point polyline draws nothing.
- Under the plot: latest value per series in its colour; for percentage graphs
  `elapsed = clamp01((now − start)/(end − start))` as a percent (a period paged
  back through reads 100%), and time left in the coarsest two units
  (`Xd Yh`, `Xh Ym`, `Xm`, or `period over`).

### 4.5 Paging and expanding

- Each graph keeps a `back` count: how many periods back from the newest it is
  showing. Counted from the end, not as an index, so a new period arriving keeps
  an old view where it was instead of shifting it forward. A refetch therefore
  keeps whatever period is being looked at.
- `‹` disabled when `back >= periods.length − 1`; `›` disabled when `back == 0`.
- Expanded: the expanded plot is **drawn at its measured pixel size**
  (ResizeObserver on the div the SVG fills, minus its 1 px border), not scaled
  up from 320 × 200, so labels and strokes stay their normal size. The viewBox
  changes with the measurement; until it arrives, the small size is used.
- The pane's `max-width` (760 px) is lifted while expanded.

### 4.6 CSS worth copying

The three-up layout is a grid with three equal columns and 16 px gap,
`align-items: start`. Expanded is a flex column with the graph section
`flex: 1; min-height: 0` and the SVG `position: absolute; inset: 0; width:
100%; height: 100%` inside a `position: relative` plot div. SVG text is 11 px,
`text-anchor: end`, secondary ink. Tabular numerals on the period label and the
figures line. Cursor pointer on the plot is the only hint it is clickable.

## 5. Files to copy from this repo

All under `/root/dev/apps/finance` on hahnca.com (git remote if the other
machine has it: this repo's `main`).

| file | what it holds |
|---|---|
| `server/src/quota-poll.js` | endpoint, credentials, 429 handling, token refresh via probe, write rule, timer. ~250 lines, plain Node, only imports are `db`, `probeQuota`, and `quota.js`. |
| `server/src/quota.js` | in-memory state, `noteUsage()` (the single reader of a usage payload, minor-units conversion, the null-reset rule), `historyRow()` for the INSERT. |
| `server/src/agent.js` lines ~205–242 | `probeQuota()`: the SDK session that is aborted at init to make the CLI refresh the token. |
| `server/src/routes.js` lines ~294–320 | the two routes. |
| `server/src/schema.sql` lines ~620–633 | the table. |
| `web/src/components/QuotaHistory.vue` | the whole pane, Vue 3 `<script setup>`, ~560 lines including comments; no chart library, hand-built SVG. |
| `web/src/style.css` lines ~1455–1657 | every `.quota-*` and `.qgraph-*` rule. |
| `web/src/api.js` | `readerOffsetMinutes()` (offset of the household timezone at a moment) and `stamp()` (`M/D HH:MM` in that timezone). |

The finance app's timezone is hard-coded to `America/Los_Angeles` in both
`api.js` and the component. It also uses the app's colour tokens (`--ink`,
`--ink-secondary`, `--surface`, `--border`, `--gridline`), all black or
near-white.

## 6. Prompt for a coding agent in the other project

Paste this, filling in the bracketed parts, and give the agent this file (or
sections 1–4 of it) as the spec.

```
Build a "Plan quota over time" pane for this project, following the spec in
docs/temp2.md sections 1 through 4 exactly. That spec describes a working
implementation in another project; reproduce its behaviour, not its framework.

Stack here: [Node version / server framework / SQLite driver / front-end
framework or plain DOM / build tool]. Household timezone: [IANA zone].
Credentials file: [~/.claude/.credentials.json or $CLAUDE_CONFIG_DIR].

Server:
1. A module that reads https://api.anthropic.com/api/oauth/usage with the
   Claude Code bearer token and the anthropic-beta header from the spec,
   reshapes only the parts the spec lists (five_hour, seven_day, the
   limits[] entry with scope.model.display_name, extra_usage in minor units
   converted to dollars once), and keeps the last reading plus lastReadAt in
   memory. Null resets_at stays null. Do not refresh the OAuth token yourself;
   on expiry or 401, [spawn one aborted Claude Code session via the Agent SDK /
   run `claude -p quota --max-turns 1` and kill it at first output], then retry
   once.
2. A five-minute timer, a 60 s freshness reuse, force bypassing it, shared
   in-flight reads, 5 s fetch timeout, 429 pause honouring retry-after (min
   60 s, default 15 min), failures logged once per change of reason and never
   thrown.
3. The quota_reading table exactly as in section 3.2 and the write rule in
   3.2 (write on any value change or hourly heartbeat, never otherwise).
4. GET /quota and GET /quota/history?force=1 as in section 3.3.

Client:
5. The pane in section 1: heading with title, HH:MM:SS of last read, m:ss age,
   Update and Close; three graphs side by side; arrows paging periods; click
   to expand one; figures line under each plot; the three empty states.
6. Period carving per 4.1 and 4.2 including the 600 s reset tolerance, the
   belongs() rule, and grouping both weekly series by the 7d reset.
7. Gridlines per 4.3, DST-safe. Drawing per 4.4: hand-built SVG, no chart
   library, 320x200 with margins l40 r6 t6 b6, pace line, carried level to
   min(period end, readAt), a dot when a series has fewer than two points.
8. Paging counted back from the newest period; expanded plot drawn at its
   measured pixel size via ResizeObserver, not scaled.
9. Refetch every 5 min while open, 30 s clock tick, 10 s age tick re-read on
   visibilitychange/focus/click.
10. Light theme only; black ink, blue #2457d6 for 7d, red #c62828 for the
    model-scoped line. No other colour.

Comment the code the way the spec explains itself: say why each rule exists
(the null reset, the late rollover, the carried level, the token refresh),
not just what it does. Do not add features the spec does not describe. Do not
use a headless browser to test; I test it myself.
```

## 7. Gotchas seen while building the original

- The graph used to show a period collapsing to zero at its right edge. Cause:
  a 0% reading with a null reset being stamped with the previous reset. Keep
  nulls null.
- The first version took quota from Claude Code sessions. Reading quota that way
  opened idle windows and cost a model request per look. Use the GET.
- Rows were once written every poll. 288 identical rows a day for nothing;
  hence write-on-change plus the hourly heartbeat, and hence the client-side
  carried level so the flat stretches still draw.
- Scaling the small SVG up when expanded printed 30 px tick labels; measure and
  redraw instead.
- Rate-limiting the endpoint is easy to do by accident from two tabs plus a
  timer; the 60 s reuse and shared in-flight promise are what stop it.
- `expiresAt` in the credentials file is ms; `resets_at` in the body is ISO
  8601; `rate_limit_event` on the SDK stream carries unix seconds. Normalise at
  the edge, once.
