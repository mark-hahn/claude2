import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type ClaudeSession, type InstallStats, type PluginFlags } from "./types";

// All plugin stats live on one server task (claude2-stats on hahnca.com, see claude2-stats/),
// so the Plugins pane shows the same table from every workspace on every machine. Each install
// (host + workspace) owns one record and is its only writer: the record carries running totals,
// so a push that fails offline costs nothing — the next one carries everything accumulated
// since, and the server merges counters with max() so replays and backfills can never regress.

const statsHost = "hahnca.com";
const statsPort = 7301;
const statsKey = "plugin.stats";
const flagsKey = "plugin.flags";
const graftSeenKey = "plugin.graftSeen";
const turnEventsKey = "plugin.turnEvents";
// The pre-plugins ledger's counters; they remember turns whose sessions were since deleted.
const tallyKey = "pony.tally";

// Every field of a record that is a running counter; the rest are identity, a gauge, or a stamp.
const counterFields = ["sessions", "turns", "wallMs", "costUsd", "tokensIn", "tokensOut", "ponySkips", "graftCalls", "graftTokensSaved", "graftUsdSaved",
  "turnsPonyOn", "turnsPonyOff", "costPonyOn", "costPonyOff", "turnsGraftOn", "turnsGraftOff", "costGraftOn", "costGraftOff"] as const;
const gaugeFields = ["ponyCeilings", "srcFiles", "srcLines"] as const;
const numericFields = [...counterFields, ...gaugeFields, "updatedAt"] as const;

export type StatsDelta = Partial<Pick<InstallStats, (typeof counterFields)[number]>>;
export type StatsGauges = Partial<Pick<InstallStats, (typeof gaugeFields)[number]>>;

// Which of the user's three machines this install runs on. A bare Linux box is the server:
// the only non-WSL Linux host in this setup is hahnca.com itself.
function hostType(): string {
  if (process.platform === "win32") {
    return "windows";
  }
  return os.release().toLowerCase().includes("microsoft") || fs.existsSync("/mnt/c/Windows") ? "wsl" : "server";
}

// One request, resolving null on any failure: an unreachable stats server never costs a turn,
// a dialog, or a hung pane. Every failure is logged with its real reason, since the panes
// themselves only ever say "unreachable". Uses fetch, not node:http — the extension host
// patches node:http with its proxy agent, which returned empty 200 bodies; fetch bypasses it.
async function httpJson(method: string, urlPath: string, body: unknown, timeoutMs: number, log: (line: string) => void): Promise<Record<string, unknown> | null> {
  const fail = (reason: string): null => {
    log(`stats server ${statsHost}:${statsPort}: ${method} ${urlPath} failed — ${reason}`);
    return null;
  };
  try {
    const response = await fetch(`http://${statsHost}:${statsPort}${urlPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200) {
      return fail(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fail(`unparseable body (${text.length} bytes): ${text.slice(0, 200)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return fail(`no response in ${timeoutMs}ms`);
    }
    const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
    return fail(cause?.code ? `${cause.code} ${cause.message}` : String(error instanceof Error ? error.message : error));
  }
}

export class PluginStats {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspacePath: string,
    private readonly log: (line: string) => void,
  ) {}

  // The project's column identity everywhere: pane, flags, records. Sanitized to the same
  // safe charset the server accepts in URLs, so no path ever needs URI encoding.
  public projectName(): string {
    return (path.basename(this.workspacePath) || this.workspacePath).replace(/[^A-Za-z0-9._-]+/g, "-");
  }

  public installKey(): string {
    return `${hostType()}__${this.workspacePath}`.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  }

  private emptyRecord(): InstallStats {
    return {
      host: hostType(),
      project: this.projectName(),
      path: this.workspacePath,
      sessions: 0,
      turns: 0,
      wallMs: 0,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      ponySkips: 0,
      ponyCeilings: 0,
      graftCalls: 0,
      graftTokensSaved: 0,
      graftUsdSaved: 0,
      turnsPonyOn: 0,
      turnsPonyOff: 0,
      costPonyOn: 0,
      costPonyOff: 0,
      turnsGraftOn: 0,
      turnsGraftOff: 0,
      costGraftOn: 0,
      costGraftOff: 0,
      srcFiles: 0,
      srcLines: 0,
      updatedAt: 0,
    };
  }

  public local(): InstallStats {
    const saved = this.context.workspaceState.get<Partial<InstallStats>>(statsKey, {});
    const record = this.emptyRecord();
    for (const field of numericFields) {
      const value = saved[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        record[field] = value;
      }
    }
    return record;
  }

  // First run in a workspace adopts what the stored sessions still show, and the old pony
  // tally where it counted higher — it remembers turns the sessions no longer do. Later runs
  // leave the record alone; by then it is the history the sessions themselves have forgotten.
  public async seed(sessions: ClaudeSession[]): Promise<void> {
    if (this.context.workspaceState.get(statsKey) !== undefined) {
      return;
    }
    const record = this.emptyRecord();
    for (const session of sessions) {
      if (session.turns.length === 0) {
        continue;
      }
      record.sessions += 1;
      for (const turn of session.turns) {
        record.turns += 1;
        record.wallMs += turn.durationMs || (turn.completedAt ? Math.max(0, turn.completedAt - turn.createdAt) : 0);
        record.costUsd += turn.costUsd ?? 0;
        record.tokensIn += turn.tokensIn;
        record.tokensOut += turn.tokensOut;
        record.ponySkips += turn.ponySkips.length;
      }
    }
    const tally = this.context.workspaceState.get<{ sessions?: number; turns?: number }>(tallyKey, {});
    record.sessions = Math.max(record.sessions, Number(tally.sessions) || 0);
    record.turns = Math.max(record.turns, Number(tally.turns) || 0);
    await this.save(record);
  }

  // Counts a turn's numbers into the local record, takes fresh gauge readings as given, and
  // pushes the new totals. Kept locally first so nothing is lost to a deleted session or an
  // offline server.
  public async add(delta: StatsDelta, gauges: StatsGauges = {}): Promise<void> {
    const record = this.local();
    for (const field of counterFields) {
      const value = delta[field];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        record[field] += value;
      }
    }
    for (const field of gaugeFields) {
      const value = gauges[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        record[field] = value;
      }
    }
    await this.save(record);
  }

  private async save(record: InstallStats): Promise<void> {
    record.updatedAt = Date.now();
    await this.context.workspaceState.update(statsKey, record);
    void httpJson("POST", `/install/${this.installKey()}`, record, 5000, this.log);
  }

  // One raw per-turn event, queued locally and drained to the server's append-only log. The
  // table needs none of this; it is the extensive record future stats get computed from, so
  // it carries everything the turn knew. Events leave the queue only once the server confirms
  // the batch, so an unreachable server just leaves them for the next turn or activation.
  // Duplicate delivery is possible when a reply is lost — analysis dedupes by id.
  public async logTurn(event: Record<string, unknown>): Promise<void> {
    const queue = [...this.context.workspaceState.get<Record<string, unknown>[]>(turnEventsKey, [])];
    queue.push({ id: randomUUID(), at: Date.now(), host: hostType(), project: this.projectName(), path: this.workspacePath, install: this.installKey(), ...event });
    // ponytail: backlog capped at 2000 turns, dropping oldest; a server dead for months loses the tail, not the workspace
    queue.splice(0, Math.max(0, queue.length - 2000));
    await this.context.workspaceState.update(turnEventsKey, queue);
    await this.flushTurns();
  }

  public async flushTurns(): Promise<void> {
    const queue = this.context.workspaceState.get<Record<string, unknown>[]>(turnEventsKey, []);
    if (queue.length === 0) {
      return;
    }
    if (await httpJson("POST", "/turns", { events: queue }, 8000, this.log)) {
      const sent = new Set(queue.map((event) => event.id));
      const remaining = this.context.workspaceState.get<Record<string, unknown>[]>(turnEventsKey, []).filter((event) => !sent.has(event.id));
      await this.context.workspaceState.update(turnEventsKey, remaining);
    }
  }

  // What graft saved this claude session so far, minus what was already counted. graft keeps
  // cumulative per-session metrics in <workspace>/graft/.cache/session/<id>.json, including the
  // session's real billed input rate, which prices the saved tokens the same way graft does.
  public async graftDelta(sessionId: string): Promise<{ graftCalls: number; graftTokensSaved: number; graftUsdSaved: number }> {
    const zero = { graftCalls: 0, graftTokensSaved: 0, graftUsdSaved: 0 };
    let metrics: Record<string, unknown>;
    try {
      metrics = JSON.parse(fs.readFileSync(path.join(this.workspacePath, "graft", ".cache", "session", `${sessionId}.json`), "utf8")) as Record<string, unknown>;
    } catch {
      return zero;
    }
    const saved = Number(metrics.savedTokens) || 0;
    const reads = Number(metrics.graftReads) || 0;
    const seen = { ...this.context.workspaceState.get<Record<string, { t: number; c: number }>>(graftSeenKey, {}) };
    const prior = seen[sessionId] ?? { t: 0, c: 0 };
    const tokens = Math.max(0, saved - prior.t);
    const calls = Math.max(0, reads - prior.c);
    seen[sessionId] = { t: saved, c: reads };
    // ponytail: unbounded growth trimmed by dropping oldest insertions; enough for years of sessions
    for (const key of Object.keys(seen).slice(0, Math.max(0, Object.keys(seen).length - 200))) {
      delete seen[key];
    }
    await this.context.workspaceState.update(graftSeenKey, seen);
    const costMicros = Number(metrics.inputCostMicros) || 0;
    const tokensBilled = Number(metrics.inputTokensBilled) || 0;
    const usd = tokens > 0 && costMicros > 0 && tokensBilled > 0 ? (tokens * (costMicros / tokensBilled)) / 1e6 : 0;
    return { graftCalls: calls, graftTokensSaved: tokens, graftUsdSaved: Number.isFinite(usd) ? usd : 0 };
  }

  // Every install's record and every project's flags, straight off the server. Null when it
  // is unreachable; the pane then shows this workspace alone from the local record.
  public async fetchAll(): Promise<{ installs: Record<string, InstallStats>; flags: Record<string, Partial<PluginFlags>> } | null> {
    const body = await httpJson("GET", "/stats", undefined, 6000, this.log);
    if (!body || typeof body.installs !== "object") {
      return null;
    }
    return body as unknown as { installs: Record<string, InstallStats>; flags: Record<string, Partial<PluginFlags>> };
  }

  // This project's switches, asked fresh before each run so a toggle made in another window
  // takes effect on the next prompt. The last answer is kept as the offline fallback; a
  // project the server has never heard of runs with both plugins on.
  public async flags(): Promise<PluginFlags> {
    const body = await httpJson("GET", `/flags/${this.projectName()}`, undefined, 2500, this.log);
    if (body) {
      const flags = { graft: body.graft !== false, ponytail: body.ponytail !== false };
      await this.context.workspaceState.update(flagsKey, flags);
      return flags;
    }
    const cached = this.context.workspaceState.get<Partial<PluginFlags>>(flagsKey, {});
    return { graft: cached.graft !== false, ponytail: cached.ponytail !== false };
  }

  public async setFlag(project: string, plugin: string, enabled: boolean): Promise<boolean> {
    if (plugin !== "graft" && plugin !== "ponytail") {
      return false;
    }
    const body = await httpJson("POST", `/flags/${project.replace(/[^A-Za-z0-9._-]+/g, "-")}`, { [plugin]: enabled }, 5000, this.log);
    return body !== null;
  }
}
