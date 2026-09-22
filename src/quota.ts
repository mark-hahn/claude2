import { spawn } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { cheapestModel, readModelInfo } from "./modelInfo";
import { httpJson } from "./pluginStats";
import type { QuotaHistoryPayload, QuotaReadingRow, QuotaState, QuotaWindowState } from "./types";

const usageUrl = "https://api.anthropic.com/api/oauth/usage";
const historyFilename = "quota-history.json";
const metaFilename = "quota-meta.json";
const fiveMinutesMs = 5 * 60 * 1000;
const oneMinuteMs = 60 * 1000;
const fifteenMinutesMs = 15 * 60 * 1000;
// The endpoint rate-limits the whole account: measured (see the finance app's
// quota-poll.js) ten calls in five minutes draws a 429, and a steady call a
// minute lasts about eighteen minutes before one. Every VS Code window runs
// its own QuotaService, so freshness and 429 pauses are shared through a meta
// file in global storage; timer ticks defer to any window's reading younger
// than this, keeping the fleet at one background call per five minutes.
const timerFreshMs = fiveMinutesMs - 30 * 1000;
const fetchTimeoutMs = 5000;
// The stats server is on the LAN, so a call to it costs milliseconds; every one of them resolves
// null rather than throwing when it is down, and each caller below falls back to the local files.
const sharedTimeoutMs = 3000;
// The footer's cost stat goes red when any window first crosses this, and stays red until
// clicked. Both the flag and the last-seen levels live in global state so a reload comes back
// to the same warning rather than re-raising it (or losing it) on the next reading.
const alertPct = 95;
const alertKey = "claude2.quotaAlert";
const alertSeenKey = "claude2.quotaSeenPct";

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
  private storageDirPromise: Promise<string> | null = null;
  // What this window last painted. globalState is shared by every window, but only the window
  // that took the reading (or took the click) knows it changed, so the rest compare on each tick.
  private lastAlertShown = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspacePath: string,
    private readonly log: (line: string) => void,
    private readonly onAlert: () => void = () => {},
  ) {}

  // True while a window has crossed 95% without the warning being cleared.
  public alerting(): boolean {
    return this.context.globalState.get<boolean>(alertKey, false);
  }

  public clearAlert(): void {
    void this.context.globalState.update(alertKey, undefined);
    this.lastAlertShown = false;
  }

  // globalState carries the flag to every window, but nothing tells a window it arrived, so the
  // timer tick that already runs everywhere doubles as the check. Worst case a window repaints a
  // reading behind — within the same five minutes it would have refreshed the quota anyway.
  private syncAlert(): void {
    const now = this.alerting();
    if (now !== this.lastAlertShown) {
      this.lastAlertShown = now;
      this.onAlert();
    }
  }

  // Raises the warning only on a crossing: a window that was already at or above the line when
  // last read stays quiet, so the footer does not re-redden every five minutes. Levels unseen
  // before (first reading after an install) arm the check rather than trip it.
  private noteAlertCrossings(state: QuotaState): void {
    const seen = this.context.globalState.get<Record<string, number>>(alertSeenKey, {});
    const next: Record<string, number> = {};
    let crossed = false;
    for (const window of state.windows) {
      if (window.pct === null) {
        continue;
      }
      next[window.key] = window.pct;
      const before = seen[window.key];
      if (typeof before === "number" && before < alertPct && window.pct >= alertPct) {
        crossed = true;
      }
    }
    void this.context.globalState.update(alertSeenKey, next);
    if (crossed && !this.alerting()) {
      void this.context.globalState.update(alertKey, true);
      this.lastAlertShown = true;
      this.onAlert();
    }
  }

  public start(): void {
    this.schedule(5000 + Math.floor(Math.random() * 10000));
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

  public async read(force: boolean, background = false): Promise<QuotaState> {
    await this.ensureLoaded();
    await this.adoptShared();
    const freshMs = background ? timerFreshMs : oneMinuteMs;
    if (!force && this.lastReadAt && Date.now() - this.lastReadAt < freshMs) {
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
      void this.read(false, true).finally(() => {
        this.syncAlert();
        this.schedule(fiveMinutesMs);
      });
    }, delayMs);
  }

  private async takeReading(force: boolean): Promise<QuotaState> {
    const now = Date.now();
    if (this.pausedUntil > now) {
      this.state = { ...this.state, pausedUntil: this.pausedUntil };
      return this.state;
    }

    if (!(await this.claim(force))) {
      this.state = { ...this.state, pausedUntil: this.pausedUntil || null };
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
      this.pausedUntil = 0;
      this.noteAlertCrossings(state);
      await this.recordReading(state);
      await this.writeSharedMeta();
      return this.state;
    } catch (error) {
      this.noteFailure(error);
      this.state = { ...this.state, available: this.lastReadAt > 0, error: errorMessage(error), pausedUntil: this.pausedUntil || null };
      if (this.pausedUntil > Date.now()) {
        await this.sharePause();
      }
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
    const model = cheapestModel(readModelInfo(this.context.globalState).models);
    this.probeInFlight = new Promise<void>((resolve, reject) => {
      const child = spawn("claude", ["-p", "quota", "--model", model, "--max-turns", "1", "--output-format", "stream-json", "--include-partial-messages", "--tools", ""], {
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

  // The usage endpoint rate-limits the whole account, and an arbitrary number of windows across
  // three machines all want to poll it, so the right to call it is leased: the server hands out
  // one claim per five-minute cycle and everyone else paints the winner's reading. A user asking
  // for a reading by hand skips the queue — one person clicking cannot stampede, and the pause
  // check above still stops them from poking a 429. An unreachable server means no lease to be
  // had: poll anyway, since a stale quota pane is worse than a rate limit that may not come.
  private async claim(force: boolean): Promise<boolean> {
    if (force) {
      return true;
    }
    const reply = await httpJson("POST", "/quota/claim", {}, sharedTimeoutMs, this.log);
    if (reply === null) {
      return true;
    }
    const pausedUntil = numberOf(reply.pausedUntil) ?? 0;
    if (pausedUntil > this.pausedUntil) {
      this.pausedUntil = pausedUntil;
    }
    return reply.poll === true;
  }

  // What every other window on the account knows. The server is the shared copy; the meta file
  // beside the history is what is left when it cannot be reached, and still joins the Windows and
  // WSL window groups through /mnt/c.
  private async fetchShared(): Promise<{ lastReadAt: number; pausedUntil: number; state: QuotaState | null; rows: QuotaReadingRow[] }> {
    const remote = await httpJson("GET", "/quota", undefined, sharedTimeoutMs, this.log);
    if (remote === null) {
      return { ...await this.readSharedMeta(), rows: [] };
    }
    const state = recordOf(remote.state);
    return {
      lastReadAt: numberOf(remote.readAt) ?? 0,
      pausedUntil: numberOf(remote.pausedUntil) ?? 0,
      state: state && Array.isArray(state.windows) ? state as unknown as QuotaState : null,
      rows: Array.isArray(remote.rows) ? remote.rows.map((row) => normalizeRow(row)).filter((row) => row !== null) : [],
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.readings = await this.loadReadings();
    const newest = [...this.readings].sort((left, right) => right.at - left.at)[0];
    if (newest) {
      this.lastReadAt = newest.at;
    }
  }

  private async loadReadings(): Promise<QuotaReadingRow[]> {
    return await readRows(await this.historyPath());
  }

  private async recordReading(state: QuotaState): Promise<void> {
    const row = rowFromState(state);
    // Other windows append to the same file; merge from disk before writing.
    const merged = new Map<number, QuotaReadingRow>((await this.loadReadings()).map((reading) => [reading.at, reading]));
    for (const reading of this.readings) {
      if (!merged.has(reading.at)) {
        merged.set(reading.at, reading);
      }
    }
    this.readings = [...merged.values()].sort((left, right) => left.at - right.at);
    const newest = this.readings[this.readings.length - 1];
    let kept = false;
    if (!newest || rowChanged(newest, row) || row.at - newest.at >= 60 * 60 * 1000) {
      if (!this.readings.some((reading) => reading.at === row.at)) {
        this.readings.push(row);
      }
      await fs.mkdir(await this.storageDir(), { recursive: true });
      await fs.writeFile(await this.historyPath(), JSON.stringify(this.readings.sort((left, right) => left.at - right.at), null, 2), "utf8");
      kept = true;
    }
    // Told even when the row folded into the last one: readAt is what the lease counts from, so
    // without this push the fleet would decide nobody had read and poll again within the minute.
    await httpJson("POST", "/quota", { rows: kept ? [row] : [], readAt: row.at, state: this.state }, sharedTimeoutMs, this.log);
  }

  private async adoptShared(): Promise<void> {
    const shared = await this.fetchShared();
    if (shared.pausedUntil > this.pausedUntil) {
      this.pausedUntil = shared.pausedUntil;
    }
    // Rows from the other machines, whether or not their newest reading beats ours: this is the
    // whole point of the shared history, and it is what fills the gaps the graphs used to show.
    if (shared.rows.length) {
      const merged = new Map<number, QuotaReadingRow>(this.readings.map((row) => [row.at, row]));
      for (const row of shared.rows) {
        merged.set(row.at, row);
      }
      this.readings = [...merged.values()].sort((left, right) => left.at - right.at);
    }
    if (shared.state && shared.lastReadAt > this.lastReadAt) {
      this.state = shared.state;
      this.lastReadAt = shared.lastReadAt;
    }
  }

  private async readSharedMeta(): Promise<{ lastReadAt: number; pausedUntil: number; state: QuotaState | null }> {
    try {
      const raw = await fs.readFile(await this.metaPath(), "utf8");
      const record = recordOf(JSON.parse(raw));
      const state = recordOf(record?.state);
      return {
        lastReadAt: numberOf(record?.lastReadAt) ?? 0,
        pausedUntil: numberOf(record?.pausedUntil) ?? 0,
        state: state && Array.isArray(state.windows) ? state as unknown as QuotaState : null,
      };
    } catch {
      return { lastReadAt: 0, pausedUntil: 0, state: null };
    }
  }

  private async writeSharedMeta(): Promise<void> {
    try {
      await fs.mkdir(await this.storageDir(), { recursive: true });
      await fs.writeFile(await this.metaPath(), JSON.stringify({ lastReadAt: this.lastReadAt, pausedUntil: this.pausedUntil, state: this.state }), "utf8");
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private async sharePause(): Promise<void> {
    try {
      const meta = await this.readSharedMeta();
      if (this.pausedUntil > meta.pausedUntil) {
        await fs.mkdir(await this.storageDir(), { recursive: true });
        await fs.writeFile(await this.metaPath(), JSON.stringify({ lastReadAt: meta.lastReadAt, pausedUntil: this.pausedUntil, state: meta.state }), "utf8");
      }
      await httpJson("POST", "/quota", { pausedUntil: this.pausedUntil }, sharedTimeoutMs, this.log);
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private storageDir(): Promise<string> {
    this.storageDirPromise ??= this.resolveStorageDir();
    return this.storageDirPromise;
  }

  // In WSL, store readings in the Windows-side extension storage through
  // /mnt/c, so the Windows and WSL window groups share one reading cadence,
  // one 429 pause, and one graph history. Falls back to this side's own
  // storage when no Windows VS Code profile is reachable.
  private async resolveStorageDir(): Promise<string> {
    const local = this.context.globalStorageUri.fsPath;
    let users: string[];
    try {
      users = await fs.readdir("/mnt/c/Users");
    } catch {
      return local;
    }
    const extensionDirName = this.context.extension.id.toLowerCase();
    for (const user of users) {
      try {
        const storageRoot = path.join("/mnt/c/Users", user, "AppData", "Roaming", "Code", "User", "globalStorage");
        if (!(await fs.stat(storageRoot)).isDirectory()) {
          continue;
        }
        const shared = path.join(storageRoot, extensionDirName);
        await fs.mkdir(shared, { recursive: true });
        await this.migrateHistory(local, shared);
        return shared;
      } catch {
        continue;
      }
    }
    return local;
  }

  // Carry rows recorded before storage was shared into the shared file; idempotent.
  private async migrateHistory(fromDir: string, toDir: string): Promise<void> {
    const legacy = await readRows(path.join(fromDir, historyFilename));
    if (legacy.length === 0) {
      return;
    }
    const sharedPath = path.join(toDir, historyFilename);
    const merged = new Map<number, QuotaReadingRow>((await readRows(sharedPath)).map((row) => [row.at, row]));
    let added = false;
    for (const row of legacy) {
      if (!merged.has(row.at)) {
        merged.set(row.at, row);
        added = true;
      }
    }
    if (added) {
      await fs.writeFile(sharedPath, JSON.stringify([...merged.values()].sort((left, right) => left.at - right.at), null, 2), "utf8");
    }
  }

  private async historyPath(): Promise<string> {
    return path.join(await this.storageDir(), historyFilename);
  }

  private async metaPath(): Promise<string> {
    return path.join(await this.storageDir(), metaFilename);
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

async function readRows(filePath: string): Promise<QuotaReadingRow[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((row) => normalizeRow(row)).filter((row) => row !== null) : [];
  } catch {
    return [];
  }
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