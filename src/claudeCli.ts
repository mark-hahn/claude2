import { spawn, type ChildProcess } from "child_process";
import { EFFORT_OPTIONS, MODEL_OPTIONS, type ClaudePhase, type ClaudeRunResult, type RunningStatus } from "./types";

const maxTurns = 8;
const maxBudgetUsd = 2;
const titleBudgetUsd = 0.25;
const compactWindow = "256k";

interface RunPromptOptions {
  sessionId: string;
  turnId: string;
  prompt: string;
  model: string;
  effort: string;
  contextWindow: number;
  workspacePath: string;
  onText: (text: string) => void;
  onStatus: (status: RunningStatus) => void;
}

interface RunningProcess {
  child: ChildProcess;
  status: RunningStatus;
  stopped: boolean;
}

export class ClaudeCliRunner {
  private readonly running = new Map<string, RunningProcess>();

  public constructor(private readonly log: (line: string) => void) {}

  public isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  public status(sessionId: string): RunningStatus | null {
    const running = this.running.get(sessionId);
    return running ? this.snapshot(running.status) : null;
  }

  public stop(sessionId: string): boolean {
    const running = this.running.get(sessionId);
    if (!running) {
      return false;
    }
    running.stopped = true;
    running.child.kill("SIGTERM");
    return true;
  }

  public dispose(): void {
    for (const running of this.running.values()) {
      running.stopped = true;
      running.child.kill("SIGTERM");
    }
    this.running.clear();
  }

  public async runPrompt(options: RunPromptOptions): Promise<ClaudeRunResult> {
    if (this.running.has(options.sessionId)) {
      throw new Error("A Claude response is already running for this session.");
    }

    const status: RunningStatus = {
      active: true,
      sessionId: options.sessionId,
      turnId: options.turnId,
      turns: 0,
      maxTurns,
      costUsd: null,
      contextTokens: 0,
      codeLines: 0,
      phase: "thinking",
      elapsedMs: 0,
      startedAt: Date.now(),
    };

    const args = [
      "-p",
      options.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      sanitizeModel(options.model),
      "--effort",
      sanitizeEffort(options.effort),
      "--autocompact",
      compactWindow,
      "--max-budget-usd",
      String(maxBudgetUsd),
      "--max-turns",
      String(maxTurns),
      "--session-id",
      options.sessionId,
      "--permission-mode",
      "auto",
      "--append-system-prompt",
      claude2SystemPrompt(options.contextWindow),
    ];

    const child = spawn("claude", args, {
      cwd: options.workspacePath,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running: RunningProcess = { child, status, stopped: false };
    this.running.set(options.sessionId, running);

    return await new Promise<ClaudeRunResult>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrText = "";
      let responseText = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let contextTokens = 0;
      let costUsd: number | null = null;
      let stopReason: string | null = null;
      let resultError: string | null = null;
      let settled = false;

      const emitStatus = (): void => {
        options.onStatus(this.snapshot(status));
      };

      const cleanup = (): void => {
        this.running.delete(options.sessionId);
      };

      const settle = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line) {
            handleClaudeLine(line);
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
      });

      child.on("error", (error) => {
        settle(() => reject(new Error(`Could not start Claude CLI: ${error.message}`)));
      });

      child.on("close", (exitCode) => {
        if (stdoutBuffer.trim()) {
          handleClaudeLine(stdoutBuffer.trim());
        }
        status.active = false;
        status.phase = null;
        status.costUsd = costUsd;
        status.contextTokens = contextTokens;
        emitStatus();

        const finalResult: ClaudeRunResult = {
          stopped: running.stopped,
          text: responseText,
          tokensIn,
          tokensOut,
          contextTokens,
          costUsd,
          stopReason,
          turns: status.turns || 1,
        };

        if (running.stopped) {
          settle(() => resolve(finalResult));
          return;
        }
        if (resultError) {
          const errorText = resultError;
          settle(() => reject(new Error(errorText)));
          return;
        }
        if (exitCode !== 0) {
          settle(() => reject(new Error(stderrText.trim() || `Claude CLI exited with code ${exitCode ?? "unknown"}.`)));
          return;
        }
        settle(() => resolve(finalResult));
      });

      emitStatus();

      const handleClaudeLine = (line: string): void => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.log(line);
          return;
        }
        if (!isRecord(message)) {
          return;
        }
        const messageType = stringOf(message.type);
        if (messageType === "stream_event") {
          const event = recordOf(message.event);
          if (event) {
            const usage = recordOf(recordOf(event.message)?.usage);
            if (usage) {
              const totals = usageTotals(usage);
              tokensIn = Math.max(tokensIn, totals.input);
              tokensOut = Math.max(tokensOut, totals.output);
              contextTokens = Math.max(contextTokens, totals.context);
              status.contextTokens = contextTokens;
            }
            const eventType = stringOf(event.type);
            if (eventType === "message_start") {
              status.turns += 1;
            } else if (eventType === "content_block_start") {
              const block = recordOf(event.content_block);
              status.phase = phaseForBlock(stringOf(block?.type));
            } else if (eventType === "content_block_stop") {
              status.phase = "working";
            } else if (eventType === "content_block_delta") {
              const delta = recordOf(event.delta);
              const textDelta = stringOf(delta?.text) || stringOf(delta?.partial_json);
              if (textDelta) {
                responseText += textDelta;
                status.codeLines = countCodeLines(responseText);
                options.onText(textDelta);
              }
            }
            emitStatus();
          }
        } else if (messageType === "assistant") {
          const assistantError = stringOf(message.error);
          if (assistantError) {
            resultError = assistantError;
          }
        } else if (messageType === "rate_limit_event") {
          status.phase = "working";
          emitStatus();
        } else if (messageType === "result") {
          const usage = recordOf(message.usage);
          if (usage) {
            const totals = usageTotals(usage);
            tokensIn = Math.max(tokensIn, totals.input);
            tokensOut = Math.max(tokensOut, totals.output);
            contextTokens = Math.max(contextTokens, totals.context);
          }
          const resultText = stringOf(message.result);
          if (!responseText && resultText) {
            responseText = resultText;
          }
          costUsd = numberOf(message.total_cost_usd);
          stopReason = stringOf(message.stop_reason) || stringOf(message.terminal_reason);
          if (message.is_error === true) {
            resultError = stringOf(message.subtype) || "Claude returned an error.";
          }
        }
      };
    });
  }

  public async generateTitle(prompt: string, model: string, workspacePath: string): Promise<string> {
    const titlePrompt = [
      "Name this Claude conversation in two to six plain words.",
      "Return only the title, without quotes or punctuation.",
      "",
      prompt,
    ].join("\n");
    const args = [
      "-p",
      titlePrompt,
      "--output-format",
      "json",
      "--model",
      sanitizeModel(model),
      "--effort",
      "low",
      "--max-budget-usd",
      String(titleBudgetUsd),
      "--tools",
      "",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--system-prompt",
      "You write concise conversation titles.",
    ];

    const output = await collectProcess("claude", args, workspacePath, 25000);
    try {
      const parsed = JSON.parse(output) as unknown;
      const result = isRecord(parsed) ? stringOf(parsed.result) : "";
      return cleanTitle(result || output, prompt);
    } catch {
      return cleanTitle(output, prompt);
    }
  }

  private snapshot(status: RunningStatus): RunningStatus {
    return { ...status, elapsedMs: Date.now() - status.startedAt };
  }
}

function claude2SystemPrompt(contextWindow: number): string {
  return [
    "You are running in the Claude2 VS Code extension.",
    "Use the local graft command for repository context before grepping or reading source files.",
    "Prefer graft ask, graft grep, graft skeleton, graft callers, and graft map according to the repository guidance.",
    `The UI tracks a ${contextWindow.toLocaleString()} token context window for this session.`,
  ].join("\n");
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function sanitizeModel(model: string): string {
  return MODEL_OPTIONS.includes(model) || /^claude-[a-z0-9-]+$/i.test(model) ? model : "fable";
}

function sanitizeEffort(effort: string): string {
  return EFFORT_OPTIONS.includes(effort) ? effort : "xhigh";
}

function phaseForBlock(blockType: string): ClaudePhase {
  if (blockType === "thinking") {
    return "thinking";
  }
  if (blockType === "text" || blockType === "tool_use") {
    return blockType === "tool_use" ? "querying" : "writing";
  }
  return "working";
}

function usageTotals(usage: Record<string, unknown>): { input: number; output: number; context: number } {
  const input = numberOf(usage.input_tokens) ?? 0;
  const output = numberOf(usage.output_tokens) ?? 0;
  const cacheRead = numberOf(usage.cache_read_input_tokens) ?? 0;
  const cacheCreate = numberOf(usage.cache_creation_input_tokens) ?? 0;
  return { input, output, context: input + output + cacheRead + cacheCreate };
}

function countCodeLines(text: string): number {
  const codeMatches = text.match(/```[\s\S]*?```/g);
  if (!codeMatches) {
    return 0;
  }
  return codeMatches.reduce((total, block) => total + block.split("\n").length - 2, 0);
}

function collectProcess(command: string, args: string[], workspacePath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspacePath, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let stdoutText = "";
    let stderrText = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude title generation timed out."));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutText += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === 0) {
        resolve(stdoutText.trim());
      } else {
        reject(new Error(stderrText.trim() || `Claude exited with code ${exitCode ?? "unknown"}.`));
      }
    });
  });
}

function cleanTitle(rawTitle: string, prompt: string): string {
  const title = rawTitle.replace(/["'`]/g, "").replace(/[.!?:;]+$/g, "").trim().split(/\s+/).slice(0, 8).join(" ");
  if (title) {
    return title.slice(0, 80);
  }
  return prompt.replace(/\s+/g, " ").trim().slice(0, 56) || "New session";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}