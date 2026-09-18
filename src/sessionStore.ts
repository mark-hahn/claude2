import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { CLAUDE2_CONTEXT_WINDOW, DEFAULT_EFFORT, type ClaudeSession, type ClaudeTurn } from "./types";

const sessionsKey = "claude2.sessions.v1";

function normalizeTurn(turn: Partial<ClaudeTurn>): ClaudeTurn {
  return {
    id: typeof turn.id === "string" ? turn.id : randomUUID(),
    prompt: typeof turn.prompt === "string" ? turn.prompt : "",
    response: typeof turn.response === "string" ? turn.response : "",
    createdAt: typeof turn.createdAt === "number" ? turn.createdAt : Date.now(),
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    model: typeof turn.model === "string" ? turn.model : "fable",
    effort: typeof turn.effort === "string" ? turn.effort : DEFAULT_EFFORT,
    tokensIn: typeof turn.tokensIn === "number" ? turn.tokensIn : 0,
    tokensOut: typeof turn.tokensOut === "number" ? turn.tokensOut : 0,
    contextWindow: typeof turn.contextWindow === "number" ? turn.contextWindow : CLAUDE2_CONTEXT_WINDOW,
    contextUsed: typeof turn.contextUsed === "number" ? turn.contextUsed : 0,
    finished: turn.finished === true,
    stopped: turn.stopped === true,
    error: typeof turn.error === "string" ? turn.error : null,
    costUsd: typeof turn.costUsd === "number" ? turn.costUsd : null,
    stopReason: typeof turn.stopReason === "string" ? turn.stopReason : null,
    turns: typeof turn.turns === "number" ? turn.turns : 0,
    maxTurns: typeof turn.maxTurns === "number" ? turn.maxTurns : 0,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : 0,
    graftSaved: typeof turn.graftSaved === "number" ? turn.graftSaved : 0,
  };
}

function normalizeSession(session: Partial<ClaudeSession>): ClaudeSession {
  const createdAt = typeof session.createdAt === "number" ? session.createdAt : Date.now();
  return {
    id: typeof session.id === "string" ? session.id : randomUUID(),
    name: typeof session.name === "string" && session.name.trim() ? session.name : "New session",
    createdAt,
    updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : createdAt,
    trashed: session.trashed === true,
    model: typeof session.model === "string" ? session.model : "",
    effort: typeof session.effort === "string" ? session.effort : "",
    turns: Array.isArray(session.turns) ? session.turns.map((turn) => normalizeTurn(turn)) : [],
  };
}

export class SessionStore {
  private sessions: ClaudeSession[];

  public constructor(private readonly context: vscode.ExtensionContext) {
    const local = this.context.workspaceState.get<Partial<ClaudeSession>[]>(sessionsKey);
    // one-time migration: sessions used to live in globalState (shared across
    // workspaces); the first workspace opened after the update adopts them
    const legacy = local === undefined ? this.context.globalState.get<Partial<ClaudeSession>[]>(sessionsKey, []) : [];
    this.sessions = (local ?? legacy).map((session) => normalizeSession(session));
    if (local === undefined && legacy.length > 0) {
      void this.context.workspaceState.update(sessionsKey, this.sessions);
      void this.context.globalState.update(sessionsKey, undefined);
    }
  }

  public all(): ClaudeSession[] {
    return [...this.sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  public get(sessionId: string): ClaudeSession | undefined {
    return this.sessions.find((session) => session.id === sessionId);
  }

  public async create(): Promise<ClaudeSession> {
    const now = Date.now();
    const session: ClaudeSession = {
      id: randomUUID(),
      name: "New session",
      createdAt: now,
      updatedAt: now,
      trashed: false,
      model: "",
      effort: "",
      turns: [],
    };
    this.sessions.unshift(session);
    await this.save();
    return session;
  }

  public async remove(sessionId: string): Promise<boolean> {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) {
      return false;
    }
    this.sessions.splice(index, 1);
    await this.save();
    return true;
  }

  public async rename(sessionId: string, name: string): Promise<ClaudeSession | undefined> {
    const session = this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.name = name.trim() || "New session";
    session.updatedAt = Date.now();
    await this.save();
    return session;
  }

  public async setTrashed(sessionId: string, trashed: boolean): Promise<ClaudeSession | undefined> {
    const session = this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.trashed = trashed;
    await this.save();
    return session;
  }

  // The pickers' current position. Deliberately does not touch updatedAt: changing a
  // dropdown is not activity, and bumping it would reshuffle the sidebar.
  public async setPicks(sessionId: string, model: string, effort: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session || (session.model === model && session.effort === effort)) {
      return;
    }
    session.model = model;
    session.effort = effort;
    await this.save();
  }

  public async appendTurn(sessionId: string, turn: ClaudeTurn): Promise<ClaudeTurn | undefined> {
    const session = this.get(sessionId);
    if (!session) {
      return undefined;
    }
    session.turns.push(turn);
    session.updatedAt = Date.now();
    await this.save();
    return turn;
  }

  public async removeTurn(sessionId: string, turnId: string): Promise<void> {
    const session = this.get(sessionId);
    if (!session) {
      return;
    }
    session.turns = session.turns.filter((candidate) => candidate.id !== turnId);
    session.updatedAt = Date.now();
    await this.save();
  }

  // Forking: the named turn and everything before it stays, everything after it goes. Returns the
  // prompts that survive, which is what the CLI transcript has to be cut back to as well.
  public async keepThrough(sessionId: string, turnId: string): Promise<{ kept: number; dropped: ClaudeTurn[] } | undefined> {
    const session = this.get(sessionId);
    const index = session?.turns.findIndex((candidate) => candidate.id === turnId) ?? -1;
    if (!session || index < 0) {
      return undefined;
    }
    const dropped = session.turns.slice(index + 1);
    session.turns = session.turns.slice(0, index + 1);
    session.updatedAt = Date.now();
    await this.save();
    return { kept: session.turns.length, dropped };
  }

  public patchTurn(sessionId: string, turnId: string, patch: Partial<ClaudeTurn>, persist: boolean): ClaudeTurn | undefined {
    const session = this.get(sessionId);
    const turn = session?.turns.find((candidate) => candidate.id === turnId);
    if (!session || !turn) {
      return undefined;
    }
    Object.assign(turn, patch);
    session.updatedAt = Date.now();
    if (persist) {
      void this.save();
    }
    return turn;
  }

  public async flush(): Promise<void> {
    await this.save();
  }

  private async save(): Promise<void> {
    await this.context.workspaceState.update(sessionsKey, this.sessions);
  }
}