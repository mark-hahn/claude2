import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { CLAUDE2_CONTEXT_WINDOW, type ClaudeSession, type ClaudeTurn } from "./types";

const sessionsKey = "claude2.sessions.v1";

function normalizeTurn(turn: Partial<ClaudeTurn>): ClaudeTurn {
  return {
    id: typeof turn.id === "string" ? turn.id : randomUUID(),
    prompt: typeof turn.prompt === "string" ? turn.prompt : "",
    response: typeof turn.response === "string" ? turn.response : "",
    createdAt: typeof turn.createdAt === "number" ? turn.createdAt : Date.now(),
    completedAt: typeof turn.completedAt === "number" ? turn.completedAt : null,
    model: typeof turn.model === "string" ? turn.model : "fable",
    effort: typeof turn.effort === "string" ? turn.effort : "xhigh",
    tokensIn: typeof turn.tokensIn === "number" ? turn.tokensIn : 0,
    tokensOut: typeof turn.tokensOut === "number" ? turn.tokensOut : 0,
    contextWindow: typeof turn.contextWindow === "number" ? turn.contextWindow : CLAUDE2_CONTEXT_WINDOW,
    contextUsed: typeof turn.contextUsed === "number" ? turn.contextUsed : 0,
    finished: turn.finished === true,
    stopped: turn.stopped === true,
    error: typeof turn.error === "string" ? turn.error : null,
    costUsd: typeof turn.costUsd === "number" ? turn.costUsd : null,
    stopReason: typeof turn.stopReason === "string" ? turn.stopReason : null,
  };
}

function normalizeSession(session: Partial<ClaudeSession>): ClaudeSession {
  const createdAt = typeof session.createdAt === "number" ? session.createdAt : Date.now();
  return {
    id: typeof session.id === "string" ? session.id : randomUUID(),
    name: typeof session.name === "string" && session.name.trim() ? session.name : "New session",
    createdAt,
    updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : createdAt,
    turns: Array.isArray(session.turns) ? session.turns.map((turn) => normalizeTurn(turn)) : [],
  };
}

export class SessionStore {
  private sessions: ClaudeSession[];

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.sessions = this.context.globalState.get<Partial<ClaudeSession>[]>(sessionsKey, []).map((session) => normalizeSession(session));
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
      turns: [],
    };
    this.sessions.unshift(session);
    await this.save();
    return session;
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
    await this.context.globalState.update(sessionsKey, this.sessions);
  }
}