import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { QuotaHistoryPayload, QuotaReadingRow, QuotaState, QuotaWindowState } from "./types";

const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const historyFilename = "quota-history.json";
const fiveMinutesMs = 5 * 60 * 1000;
const oneMinuteMs = 60 * 1000;
const fifteenMinutesMs = 15 * 60 * 1000;
const fetchTimeoutMs = 5000;

interface HttpJsonResponse {
  statusCode: number;
  retryAfter: string | undefined;
  body: unknown;
  rawBody: string;
}

interface TokenCredentials {
  accessToken: string;
  expiresAt: number | null;
}

export class QuotaService {
  private state: QuotaState = emptyState(null);
  private readings: QuotaReadingRow[] = [];
  private loaded = false;
  private inFlight: Promise<QuotaState> | null = null;
  private probeInFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastReadAt = 0;
  private lastFailureReason: string | null = null;
  private pausedUntil = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspacePath: string,
    private readonly log: (line: string) => void,
  ) {}

  public start(): void {
    this.schedule(5000);
  }

  public dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public async history(force: boolean): Promise<QuotaHistoryPayload> {
    await this.ensureLoaded();
    await this.read(force);
    return { readAt: this.lastReadAt || null, rows: [...this.readings].sort((left, right) => left.at - right.at), state: this.state };
  }

  public async read(force: boolean): Promise<QuotaState> {
    await this.ensureLoaded();
    if (!force && this.lastReadAt && Date.now() - this.lastReadAt < oneMinuteMs) {
      return this.state;
    }
    if (this.inFlight) {
      if (!force) {
        return await this.inFlight;
      }
      await this.inFlight;
    }
    this.inFlight = this.takeReading(force).finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.read(false).finally(() => this.schedule(fiveMinutesMs));
    }, delayMs);
  }

  private async takeReading(force: boolean): Promise<QuotaState> {
    const now = Date.now();
    if (this.pausedUntil > now) {
      this.state = { ...this.state, pausedUntil: this.pausedUntil };
      return this.state;
    }

    try {
      const credentials = await this.credentials();
      if (credentials.expiresAt !== null && credentials.expiresAt <= now) {
        await this.probeQuotaRefresh();
      }
      const state = await this.fetchUsageAfterRefresh(force, false);
      this.state = state;
      this.lastReadAt = state.at ?? Date.now();
      this.lastFailureReason = null;
      await this.recordReading(state);
      return this.state;
    } catch (error) {
      this.noteFailure(error);
      this.state = { ...this.state, available: this.lastReadAt > 0, error: errorMessage(error), pausedUntil: this.pausedUntil || null };
      return this.state;
    }
  }

  private async fetchUsageAfterRefresh(force: boolean, retried: boolean): Promise<QuotaState> {
    const credentials = await this.credentials();
    const response = await getJson(credentials.accessToken);
    if (response.statusCode === 429) {
      this.pausedUntil = retryAfterMs(response.retryAfter);
      throw new Error(`Claude usage endpoint is rate limited until ${new Date(this.pausedUntil).toLocaleTimeString()}.`);
    }
    if (response.statusCode === 401 && !retried) {
      await this.probeQuotaRefresh();
      return await this.fetchUsageAfterRefresh(force, true);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Claude usage endpoint returned ${response.statusCode}: ${response.rawBody.slice(0, 200)}`);
    }
    return reshapeUsage(response.body, Date.now());
  }

  private async credentials(): Promise<TokenCredentials> {
    const credentialsPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
    const raw = await fs.readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const oauth = recordOf(recordOf(parsed)?.claudeAiOauth);
    const accessToken = stringOf(oauth?.accessToken);
    if (!accessToken) {
      throw new Error(`No Claude OAuth access token found in ${credentialsPath}.`);
    }
    return { accessToken, expiresAt: numberOf(oauth?.expiresAt) };
  }

  private async probeQuotaRefresh(): Promise<void> {
    if (this.probeInFlight) {
      await this.probeInFlight;
      return;
    }
    this.probeInFlight = new Promise<void>((resolve, reject) => {
      const child = spawn("claude", ["-p", "quota", "--max-turns", "1", "--output-format", "stream-json", "--include-partial-messages", "--tools", ""], {
        cwd: this.workspacePath,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let settled = false;
      let stderrText = "";
      const timeout = setTimeout(() => finish(new Error("Claude quota token refresh probe timed out.")), 20000);
      const finish = (error: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      child.stdout.on("data", () => finish(null));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
      });
      child.on("error", (error) => finish(error));
      child.on("close", (exitCode) => {
        if (!settled && exitCode !== 0) {
          finish(new Error(stderrText.trim() || `Claude quota probe exited with code ${exitCode ?? "unknown"}.`));
        } else {
          finish(null);
        }
      });
    }).finally(() => {
      this.probeInFlight = null;
    });
    await this.probeInFlight;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.historyPath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.readings = Array.isArray(parsed) ? parsed.map((row) => normalizeRow(row)).filter((row) => row !== null) : [];
      const newest = [...this.readings].sort((left, right) => right.at - left.at)[0];
      if (newest) {
        this.lastReadAt = newest.at;
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        this.noteFailure(error);
      }
    }
  }

  private async recordReading(state: QuotaState): Promise<void> {
    const row = rowFromState(state);
    const newest = [...this.readings].sort((left, right) => right.at - left.at)[0];
    if (!newest || rowChanged(newest, row) || row.at - newest.at >= 60 * 60 * 1000) {
      if (!this.readings.some((reading) => reading.at === row.at)) {
        this.readings.push(row);
      }
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
      await fs.writeFile(this.historyPath(), JSON.stringify(this.readings.sort((left, right) => left.at - right.at), null, 2), "utf8");
    }
  }

  private historyPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, historyFilename);
  }

  private noteFailure(error: unknown): void {
    const reason = errorMessage(error);
    if (reason !== this.lastFailureReason) {
      this.lastFailureReason = reason;
      this.log(`Claude quota read failed: ${reason}`);
    }
  }
}

async function getJson(accessToken: string): Promise<HttpJsonResponse> {
  // Uses the global fetch instead of https.get: the VS Code extension host patches the
  // https module and every request through it failed with "Parse Error: JS Exception".
  let response: Response;
  try {
    response = await fetch(usageUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Claude usage endpoint timed out.");
    }
    throw error;
  }
  const rawBody = await response.text();
  let body: unknown = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = rawBody;
  }
  return { statusCode: response.status, retryAfter: response.headers.get("retry-after") ?? undefined, body, rawBody };
}

function reshapeUsage(body: unknown, at: number): QuotaState {
  const root = recordOf(body);
  const five = windowFrom(recordOf(root?.five_hour), "five", "5h");
  const seven = windowFrom(recordOf(root?.seven_day), "seven", "7d");
  const scoped = modelScopedWindow(root);
  const credits = creditsFrom(recordOf(root?.extra_usage));
  return {
    at,
    available: true,
    subscription: stringOf(root?.subscription) || null,
    credits,
    windows: [five, seven, scoped],
    error: null,
    pausedUntil: null,
  };
}

function windowFrom(value: Record<string, unknown> | undefined, key: "five" | "seven", label: string): QuotaWindowState {
  return {
    key,
    label,
    pct: numberOrNull(value?.utilization),
    resetsAt: secondsFromIso(value?.resets_at),
  };
}

function modelScopedWindow(root: Record<string, unknown> | undefined): QuotaWindowState {
  const limits = Array.isArray(root?.limits) ? root.limits : [];
  for (const limit of limits) {
    const record = recordOf(limit);
    const displayName = stringOf(recordOf(recordOf(record?.scope)?.model)?.display_name);
    if (displayName) {
      return { key: "model", label: displayName, pct: numberOrNull(record?.percent), resetsAt: secondsFromIso(record?.resets_at) };
    }
  }
  return { key: "model", label: "Fable", pct: null, resetsAt: null };
}

function creditsFrom(value: Record<string, unknown> | undefined): QuotaState["credits"] {
  if (!value) {
    return null;
  }
  const decimalPlaces = numberOf(value.decimal_places) ?? 2;
  const divisor = 10 ** decimalPlaces;
  const spent = numberOf(value.used_credits);
  const limit = numberOf(value.monthly_limit);
  return {
    enabled: value.is_enabled === true,
    spentUsd: spent === null ? null : spent / divisor,
    limitUsd: limit === null ? null : limit / divisor,
  };
}

function rowFromState(state: QuotaState): QuotaReadingRow {
  const five = state.windows.find((windowState) => windowState.key === "five");
  const seven = state.windows.find((windowState) => windowState.key === "seven");
  const model = state.windows.find((windowState) => windowState.key === "model");
  return {
    at: state.at ?? Date.now(),
    five_pct: five?.pct ?? null,
    five_resets: five?.resetsAt ?? null,
    seven_pct: seven?.pct ?? null,
    seven_resets: seven?.resetsAt ?? null,
    fable_pct: model?.pct ?? null,
    fable_resets: model?.resetsAt ?? null,
    spent_usd: state.credits?.spentUsd ?? null,
    limit_usd: state.credits?.limitUsd ?? null,
  };
}

function rowChanged(left: QuotaReadingRow, right: QuotaReadingRow): boolean {
  return ["five_pct", "five_resets", "seven_pct", "seven_resets", "fable_pct", "fable_resets", "spent_usd", "limit_usd"].some((key) => {
    const typedKey = key as keyof Omit<QuotaReadingRow, "at">;
    return left[typedKey] !== right[typedKey];
  });
}

function normalizeRow(value: unknown): QuotaReadingRow | null {
  const record = recordOf(value);
  const at = numberOf(record?.at);
  if (at === null) {
    return null;
  }
  return {
    at,
    five_pct: numberOrNull(record?.five_pct),
    five_resets: numberOrNull(record?.five_resets),
    seven_pct: numberOrNull(record?.seven_pct),
    seven_resets: numberOrNull(record?.seven_resets),
    fable_pct: numberOrNull(record?.fable_pct),
    fable_resets: numberOrNull(record?.fable_resets),
    spent_usd: numberOrNull(record?.spent_usd),
    limit_usd: numberOrNull(record?.limit_usd),
  };
}

function emptyState(error: string | null): QuotaState {
  return { at: null, available: false, subscription: null, credits: null, windows: [], error, pausedUntil: null };
}

function retryAfterMs(firstValue: string | undefined): number {
  if (!firstValue) {
    return Date.now() + fifteenMinutesMs;
  }
  const seconds = Number(firstValue);
  if (Number.isFinite(seconds)) {
    return Date.now() + Math.max(oneMinuteMs, seconds * 1000);
  }
  const dateMs = Date.parse(firstValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(Date.now() + oneMinuteMs, dateMs);
  }
  return Date.now() + fifteenMinutesMs;
}

function secondsFromIso(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : numberOf(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}