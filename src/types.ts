export const CLAUDE2_CONTEXT_WINDOW = 256000;

// The CLI never lets the context reach the window: it holds back up to 20,000 tokens for the reply
// and a further 13,000 of headroom, and auto-compacts the conversation at what is left. That figure,
// not the window, is the ceiling the gauge is really counting towards.
export const CLAUDE2_COMPACT_RESERVE = 33000;
export const DEFAULT_EFFORT = "high";

// U+2063 INVISIBLE SEPARATOR, prefixed to every tool-call line in a response. It is what the
// conversation view hides on: bold alone is not the tell, since the model opens its own prose with
// **bold** runs too. Zero width, so it shows as nothing wherever a response is read as plain text.
export const TOOL_LINE_MARK = "⁣";

// U+2062 INVISIBLE TIMES, after the tool mark on a tool line's detail lines: the call's long form,
// stored under its short line. A finished box shows them in the line's place when it is clicked.
export const TOOL_DETAIL_MARK = "⁢";

// A line of just this, put in when the run ends, is where the closing answer starts; the
// conversation view draws a rule there. Zero width like the tool mark, and a different character.
export const ANSWER_MARK = "⁤";

// Graft (since removed) had the model close a response with a savings tally line opening with
// this sprout. Responses stored before the removal still carry those lines, so every view of a
// response keeps dropping lines starting with it.
export const GRAFT_TALLY_MARK = "🌱";

// One ponytail skip line out of a response: "skipped: <x>, add when <y>". x is what was not
// built, y is the condition that would justify building it after all.
export interface PonySkip {
  x: string;
  y: string;
}

// One install (host + workspace) of the extension: the running totals it owns on the
// claude2-stats server. ponyCeilings, srcFiles, and srcLines are gauges of the workspace as
// it stands now; every other numeric field is a counter that only ever grows. The On/Off
// pairs split turns and cost by the plugin flags each turn actually ran with, for $/turn
// comparisons; they start at the moment this shipped — no history assigns flags to older turns.
export interface InstallStats {
  host: string;
  project: string;
  path: string;
  sessions: number;
  turns: number;
  wallMs: number;
  tokensIn: number;
  tokensOut: number;
  ponySkips: number;
  ponyCeilings: number;
  graftCalls: number;
  graftTokensSaved: number;
  graftUsdSaved: number;
  // Turns and their API-priced cost, counted only since turn costs became each turn's own; the
  // older cost counters summed sessions' running totals and were dropped.
  pricedTurns: number;
  pricedUsd: number;
  srcFiles: number;
  srcLines: number;
  updatedAt: number;
}

export type ClaudePhase = "thinking" | "writing" | "querying" | "working" | "compacting" | "background" | null;

// One picture riding with a prompt. `kind` picks the sentence appended for it, and is what the
// Image pane names it by. `path` is a temp file while the image is still pending, and a copy under
// the extension's own storage once the prompt has been sent -- temp dirs get swept, and a submitted
// prompt's pictures have to outlive that.
export interface PromptImage {
  kind: "cap" | "paste";
  path: string;
}

export interface ClaudeTurn {
  id: string;
  prompt: string;
  // The pictures this prompt was sent with, in the order their 🖼️ chars read.
  images: PromptImage[];
  response: string;
  createdAt: number;
  completedAt: number | null;
  // The value sent with --model, as the CLI's model list gave it: often an alias like "opus[1m]".
  model: string;
  // The other names for that model, kept for debugging. modelName is the CLI list's description
  // name when the prompt was sent ("Opus 5.5 with 1M context"), modelAlias the Models pane alias
  // then, and modelId what actually answered ("claude-opus-5-5"), read off the reply itself.
  modelName: string;
  modelAlias: string;
  modelId: string;
  effort: string;
  tokensIn: number;
  tokensOut: number;
  contextWindow: number;
  contextUsed: number;
  // /clear ran in this turn: Claude's context starts over here, so the gauge takes this turn's level, even 0.
  cleared: boolean;
  finished: boolean;
  stopped: boolean;
  error: string | null;
  costUsd: number | null;
  // The CLI's running cost for the whole session when this turn ended. A resumed CLI process
  // starts its total_cost_usd there, so the next turn's own cost is measured from it.
  cliCostTotal: number | null;
  stopReason: string | null;
  turns: number;
  maxTurns: number;
  durationMs: number;
  ponySkips: PonySkip[];
}

export interface ClaudeSession {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  trashed: boolean;
  // The model/effort the session's pickers last sat on, so reopening it restores them.
  // Empty means the session never picked and the configured default applies.
  model: string;
  effort: string;
  // The conversation pane's big-prompt layout, so a reload comes back the way it was left.
  bigPrompt: boolean;
  // The prompt box is showing the last prompt again, read-only, rather than an editable draft.
  restoredPrompt: boolean;
  turns: ClaudeTurn[];
}

export interface RunningStatus {
  active: boolean;
  sessionId: string;
  turnId: string;
  turns: number;
  maxTurns: number;
  costUsd: number | null;
  contextTokens: number;
  ponySkips: PonySkip[];
  codeLines: number;
  phase: ClaudePhase;
  // When the conversation was last compacted in this run, so the gauge can flag that the level
  // it shows just dropped for a reason. Null until a compaction happens.
  compactedAt: number | null;
  elapsedMs: number;
  startedAt: number;
  // When the pane last got something visible to show, and how long ago that was as of the
  // snapshot, so the footer can show how long the response has looked stalled.
  lastEventAt: number;
  sinceEventMs: number;
  // The model id the API answered the main conversation with; empty until the first reply starts.
  modelId: string;
}

export interface ClaudeRunResult {
  stopped: boolean;
  text: string;
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  costUsd: number | null;
  // The CLI's own total_cost_usd: the session's running cost, not this turn's.
  cliCostTotal: number | null;
  stopReason: string | null;
  turns: number;
  durationMs: number;
  ponySkips: PonySkip[];
  // The text of the last message, the one that ended the run: what the CLI's result repeats.
  answer: string;
  // /clear moved Claude's conversation to this new CLI session; null when nothing was cleared.
  clearedInto: string | null;
  // The context window the CLI reported for the main model; null when no result said.
  modelWindow: number | null;
}

export interface QuotaReadingRow {
  at: number;
  five_pct: number | null;
  five_resets: number | null;
  seven_pct: number | null;
  seven_resets: number | null;
  fable_pct: number | null;
  fable_resets: number | null;
  spent_usd: number | null;
  limit_usd: number | null;
}

export interface QuotaWindowState {
  key: "five" | "seven" | "model";
  label: string;
  pct: number | null;
  resetsAt: number | null;
}

export interface QuotaState {
  at: number | null;
  available: boolean;
  subscription: string | null;
  credits: {
    enabled: boolean;
    spentUsd: number | null;
    limitUsd: number | null;
  } | null;
  windows: QuotaWindowState[];
  error: string | null;
  pausedUntil: number | null;
}

export interface QuotaHistoryPayload {
  readAt: number | null;
  rows: QuotaReadingRow[];
  state: QuotaState;
}