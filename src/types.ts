export const CLAUDE2_CONTEXT_WINDOW = 256000;

// The CLI never lets the context reach the window: it holds back up to 20,000 tokens for the reply
// and a further 13,000 of headroom, and auto-compacts the conversation at what is left. That figure,
// not the window, is the ceiling the gauge is really counting towards.
export const CLAUDE2_COMPACT_RESERVE = 33000;
export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT = "high";

// U+2063 INVISIBLE SEPARATOR, prefixed to every tool-call line in a response. It is what the
// conversation view hides on: bold alone is not the tell, since the model opens its own prose with
// **bold** runs too. Zero width, so it shows as nothing wherever a response is read as plain text.
export const TOOL_LINE_MARK = "⁣";

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

// The per-project on/off switches for the two agent plugins a spawned CLI run can carry.
export interface PluginFlags {
  graft: boolean;
  ponytail: boolean;
}

// One install (host + workspace) of the extension: the running totals it owns on the
// claude2-stats server. Every field but ponyCeilings is a counter that only ever grows;
// ponyCeilings is a gauge of the workspace as it stands now. The On/Off pairs split turns
// and cost by the plugin flags each turn actually ran with, for $/turn comparisons; they
// start at the moment this shipped — no history assigns flags to older turns.
export interface InstallStats {
  host: string;
  project: string;
  path: string;
  sessions: number;
  turns: number;
  wallMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  ponySkips: number;
  ponyCeilings: number;
  graftCalls: number;
  graftTokensSaved: number;
  graftUsdSaved: number;
  turnsPonyOn: number;
  turnsPonyOff: number;
  costPonyOn: number;
  costPonyOff: number;
  turnsGraftOn: number;
  turnsGraftOff: number;
  costGraftOn: number;
  costGraftOff: number;
  updatedAt: number;
}

export const MODEL_OPTIONS = ["fable", "opus", "sonnet", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"];
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

export type ClaudePhase = "thinking" | "writing" | "querying" | "working" | "compacting" | null;

export interface ClaudeTurn {
  id: string;
  prompt: string;
  response: string;
  createdAt: number;
  completedAt: number | null;
  model: string;
  effort: string;
  tokensIn: number;
  tokensOut: number;
  contextWindow: number;
  contextUsed: number;
  finished: boolean;
  stopped: boolean;
  error: string | null;
  costUsd: number | null;
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
}

export interface ClaudeRunResult {
  stopped: boolean;
  text: string;
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  costUsd: number | null;
  stopReason: string | null;
  turns: number;
  durationMs: number;
  ponySkips: PonySkip[];
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