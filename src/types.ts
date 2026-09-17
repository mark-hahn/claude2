export const CLAUDE2_CONTEXT_WINDOW = 256000;
export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_EFFORT = "high";

// U+2063 INVISIBLE SEPARATOR, prefixed to every tool-call line in a response. It is what the
// conversation view hides on: bold alone is not the tell, since the model opens its own prose with
// **bold** runs too. Zero width, so it shows as nothing wherever a response is read as plain text.
export const TOOL_LINE_MARK = "⁣";

export const MODEL_OPTIONS = ["fable", "opus", "sonnet", "claude-fable-5", "claude-opus-5", "claude-sonnet-5"];
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

export type ClaudePhase = "thinking" | "writing" | "querying" | "working" | null;

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
  codeLines: number;
  phase: ClaudePhase;
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