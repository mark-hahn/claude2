import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_EFFORT, EFFORT_OPTIONS, MODEL_OPTIONS, TOOL_LINE_MARK, type ClaudePhase, type ClaudeRunResult, type RunningStatus } from "./types";

// TEMP: when true, every raw stream-json line from claude is shown in the response, blank-line separated.
const DUMP_RAW_MESSAGES = false;

const titleBudgetUsd = 0.25;
const permissionModes = ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];

export interface RunLimits {
  maxTurns: number;
  maxBudgetUsd: number;
  permissionMode: string;
}

interface RunPromptOptions {
  sessionId: string;
  turnId: string;
  prompt: string;
  model: string;
  effort: string;
  contextWindow: number;
  workspacePath: string;
  hasPriorTurns: boolean;
  // Context is a level, not a total: a run inherits where the last one left off so the gauge
  // never drops to zero while the first API call of the run is still in flight.
  priorContextTokens: number;
  limits: RunLimits;
  onText: (text: string) => void;
  onStatus: (status: RunningStatus) => void;
}

type SessionMode = "new" | "resume";

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
    // The CLI refuses --session-id for a session it already stores and refuses --resume for one it
    // does not, so pick by the transcript on disk and fall back once if the CLI disagrees.
    const firstMode: SessionMode = options.hasPriorTurns && sessionTranscriptExists(options.workspacePath, options.sessionId) ? "resume" : "new";
    try {
      return await this.execute(options, firstMode);
    } catch (error) {
      const text = errorText(error);
      if (firstMode === "new" && /already in use/i.test(text)) {
        this.log(`Claude session ${options.sessionId} already exists; resuming instead.`);
        return await this.execute(options, "resume");
      }
      if (firstMode === "resume" && /No conversation found/i.test(text)) {
        this.log(`Claude session ${options.sessionId} could not be resumed; starting it fresh.`);
        return await this.execute(options, "new");
      }
      throw error;
    }
  }

  private async execute(options: RunPromptOptions, mode: SessionMode): Promise<ClaudeRunResult> {
    const status: RunningStatus = {
      active: true,
      sessionId: options.sessionId,
      turnId: options.turnId,
      turns: 0,
      maxTurns: options.limits.maxTurns,
      costUsd: null,
      contextTokens: Math.max(0, options.priorContextTokens),
      graftSaved: 0,
      codeLines: 0,
      phase: "thinking",
      elapsedMs: 0,
      startedAt: Date.now(),
    };

    // The prompt goes in on stdin so that text beginning with "-" is never parsed as a CLI option.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      sanitizeModel(options.model),
      "--effort",
      sanitizeEffort(options.effort),
      "--max-turns",
      String(Math.max(1, Math.floor(options.limits.maxTurns) || 1)),
      mode === "resume" ? "--resume" : "--session-id",
      options.sessionId,
      "--permission-mode",
      sanitizePermissionMode(options.limits.permissionMode),
      // Cap screenshots land in the temp dir, outside the workspace; this keeps them readable.
      "--add-dir",
      capTempDir(),
      "--append-system-prompt",
      claude2SystemPrompt(options.contextWindow),
    ];
    if (options.limits.maxBudgetUsd > 0) {
      args.push("--max-budget-usd", String(options.limits.maxBudgetUsd));
    }

    const child = spawn("claude", args, {
      cwd: options.workspacePath,
      env: childEnv(options.contextWindow),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const running: RunningProcess = { child, status, stopped: false };
    this.running.set(options.sessionId, running);
    child.stdin.on("error", (error) => this.log(`Claude stdin error: ${error.message}`));
    child.stdin.end(options.prompt);

    return await new Promise<ClaudeRunResult>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderrText = "";
      let responseText = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let contextTokens = Math.max(0, options.priorContextTokens);
      let costUsd: number | null = null;
      let stopReason: string | null = null;
      let durationMs = 0;
      let graftSaved = 0;
      // What the CLI itself counted. --max-turns is enforced against this, not against the
      // message_start tally the gauge runs on live, and the two do not agree.
      let reportedTurns = 0;
      let resultError: string | null = null;
      let settled = false;
      let sawTextDelta = false;
      let toolBatchOpen = false;
      // Tool calls are announced once each; the CLI can repeat an assistant message, so key off the block id.
      const seenToolUses = new Set<string>();

      // Tool lines stack one per line with no blank line between them; the blank lines go around the batch.
      const appendToolLine = (text: string): void => {
        const gap = toolBatchOpen || !responseText || responseText.endsWith("\n\n") ? "" : responseText.endsWith("\n") ? "\n" : "\n\n";
        const chunk = `${gap}${text}\n`;
        responseText += chunk;
        options.onText(chunk);
        toolBatchOpen = true;
      };

      // Closes an open batch with the blank line that separates it from the prose that follows.
      const closeToolBatch = (): void => {
        if (!toolBatchOpen) {
          return;
        }
        toolBatchOpen = false;
        responseText += "\n";
        options.onText("\n");
      };

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
        if (DUMP_RAW_MESSAGES) {
          options.onText("[stderr] " + chunk + "\n\n");
        }
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
          turns: reportedTurns || status.turns || 1,
          // A run killed by Stop never reports its own duration, so fall back to the wall clock.
          durationMs: durationMs || Math.max(0, Date.now() - status.startedAt),
          graftSaved,
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
        if (DUMP_RAW_MESSAGES) {
          options.onText(line + "\n\n");
        }
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
            // message_start (and message_delta) carry this API turn's usage. Context used is the size of
            // the latest turn, not a sum over turns, so keep the newest figure rather than a running max.
            const usage = recordOf(recordOf(event.message)?.usage) ?? recordOf(event.usage);
            if (usage) {
              const totals = usageTotals(usage);
              if (totals.context > 0) {
                contextTokens = totals.context;
                status.contextTokens = contextTokens;
              }
            }
            const eventType = stringOf(event.type);
            if (eventType === "message_start") {
              status.turns += 1;
            } else if (eventType === "content_block_start") {
              const block = recordOf(event.content_block);
              status.phase = phaseForBlock(stringOf(block?.type));
              if (responseText && !responseText.endsWith("\n")) {
                responseText += "\n";
                options.onText(DUMP_RAW_MESSAGES ? "\n\n" : "\n");
              }
            } else if (eventType === "content_block_stop") {
              status.phase = "working";
            } else if (eventType === "content_block_delta") {
              const delta = recordOf(event.delta);
              const textDelta = stringOf(delta?.text);
              if (textDelta) {
                closeToolBatch();
                sawTextDelta = true;
                responseText += textDelta;
                status.codeLines = countCodeLines(responseText);
                options.onText(DUMP_RAW_MESSAGES ? textDelta + "\n\n" : textDelta);
              }
            }
            emitStatus();
          }
        } else if (messageType === "assistant") {
          const assistantError = stringOf(message.error);
          if (assistantError) {
            resultError = assistantError;
          }
          // The completed assistant message is the first place a tool call arrives with its input filled in.
          const content = recordOf(message.message)?.content;
          if (Array.isArray(content)) {
            for (const entry of content) {
              const block = recordOf(entry);
              if (!block || stringOf(block.type) !== "tool_use") {
                continue;
              }
              const blockId = stringOf(block.id);
              if (blockId && seenToolUses.has(blockId)) {
                continue;
              }
              seenToolUses.add(blockId);
              appendToolLine(toolUseLine(block));
            }
          }
        } else if (messageType === "user") {
          // Tool output comes back as the user turn that carries the tool results, which is where
          // graft reports what it reckons it saved.
          const saved = graftSavedIn(message);
          if (saved > 0) {
            graftSaved += saved;
            status.graftSaved = graftSaved;
            emitStatus();
          }
        } else if (messageType === "system") {
          // Compaction runs between API calls, so nothing else on the stream moves while it works.
          // Without this the phase would sit on whatever it last showed for the whole pause.
          const subtype = stringOf(message.subtype);
          if (subtype === "status" && stringOf(message.status) === "compacting") {
            status.phase = "compacting";
            emitStatus();
          } else if (subtype === "compact_boundary") {
            // The summary replaces the conversation, so the level drops to where it now stands.
            // post_tokens is optional; without it the gauge waits for the next message_start.
            const meta = recordOf(message.compact_metadata);
            const after = numberOf(meta?.post_tokens);
            const before = numberOf(meta?.pre_tokens);
            status.phase = "working";
            if (typeof after === "number" && after > 0) {
              contextTokens = after;
              status.contextTokens = after;
            }
            appendToolLine(`**compacted** conversation summarised${before ? ` from ${before.toLocaleString()} tokens` : ""}`);
            emitStatus();
          }
        } else if (messageType === "rate_limit_event") {
          status.phase = "working";
          emitStatus();
        } else if (messageType === "result") {
          // The result usage is the whole run's total, which is what the in/out counters report.
          const usage = recordOf(message.usage);
          if (usage) {
            const totals = usageTotals(usage);
            tokensIn = Math.max(tokensIn, totals.prompt);
            tokensOut = Math.max(tokensOut, totals.output);
            // No context reading here: the result usage sums cache reads over every API call in the
            // run, so it runs far past the window. Only a stream_event carries a real context level.
          }
          const resultText = stringOf(message.result);
          const isError = message.is_error === true;
          // Tool lines alone do not count as a response, so the result text still has to land after
          // them. An error result's text is the error itself and is reported there instead.
          if (!sawTextDelta && resultText && !isError) {
            closeToolBatch();
            responseText += resultText;
            options.onText(resultText);
          }
          costUsd = numberOf(message.total_cost_usd);
          durationMs = numberOf(message.duration_ms) ?? 0;
          reportedTurns = numberOf(message.num_turns) ?? 0;
          if (reportedTurns > 0) {
            // Snap the live tally to the real count now that the run has one to give.
            status.turns = reportedTurns;
            emitStatus();
          }
          stopReason = stringOf(message.stop_reason) || stringOf(message.terminal_reason);
          if (isError) {
            const subtype = stringOf(message.subtype);
            // An auth failure arrives as is_error under subtype "success", with the real story in
            // the result text; only a true error_ subtype has a readable form of its own.
            resultError = subtype.startsWith("error_") ? readableResultError(subtype, options.limits.maxTurns) : resultText || readableResultError(subtype, options.limits.maxTurns);
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

    const output = await collectProcess("claude", args, workspacePath, 25000, titlePrompt);
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

// Where Cap screenshots are read from: the WSL host reads them off the Windows side of the
// mount, every other host uses its own temp dir (see capture.ts).
function capTempDir(): string {
  return process.platform === "linux" && fs.existsSync("/mnt/c/Windows/Temp") ? "/mnt/c/Windows/Temp" : os.tmpdir();
}

function claude2SystemPrompt(contextWindow: number): string {
  return [
    "You are running in the Claude2 VS Code extension.",
    "Use the local graft command for repository context before grepping or reading source files.",
    "Prefer graft ask, graft grep, graft skeleton, graft callers, and graft map according to the repository guidance.",
    `The UI tracks a ${contextWindow.toLocaleString()} token context window for this session.`,
  ].join("\n");
}

function childEnv(autoCompactWindow: number | null = null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A stray key would divert billing from the subscription to the API.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // This CLI build has no --autocompact flag; the auto-compact window is set through the environment
  // (accepts 100k-1M tokens).
  if (autoCompactWindow !== null) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(1000000, Math.max(100000, Math.floor(autoCompactWindow))));
  }
  return env;
}

// A run that hit a limit comes back as a bare subtype like "error_max_turns". Both panes show this
// string as it stands, so it becomes a sentence here rather than being decoded in each of them.
function readableResultError(subtype: string, maxTurns: number): string {
  if (subtype === "error_max_turns") {
    return `Stopped at the turn limit of ${maxTurns}. The response above is unfinished — send another prompt to carry on, or raise claude2.maxTurns.`;
  }
  if (subtype === "error_during_execution") {
    return "The Claude CLI stopped part way through this response.";
  }
  if (subtype.startsWith("error_")) {
    return `Claude stopped: ${subtype.slice(6).replace(/_/g, " ")}.`;
  }
  return subtype || "Claude returned an error.";
}

function sanitizePermissionMode(mode: string): string {
  return permissionModes.includes(mode) ? mode : "auto";
}

// Claude Code stores transcripts under <config dir>/projects/<cwd with non-alphanumerics as "-">/<session id>.jsonl.
function sessionTranscriptExists(workspacePath: string, sessionId: string): boolean {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectKey = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
  try {
    return fs.existsSync(path.join(configDir, "projects", projectKey, `${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeModel(model: string): string {
  return MODEL_OPTIONS.includes(model) || /^claude-[a-z0-9-]+$/i.test(model) ? model : "fable";
}

function sanitizeEffort(effort: string): string {
  return EFFORT_OPTIONS.includes(effort) ? effort : DEFAULT_EFFORT;
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

// One tool call on one line: the tool name plus whichever input field best names what it was pointed at.
// The name is wrapped in ** so the conversation view can bold it; nothing else in the line is markup.
function toolUseLine(block: Record<string, unknown>): string {
  const name = stringOf(block.name) || "tool";
  const input = recordOf(block.input);
  const detailKeys = ["description", "command", "file_path", "path", "pattern", "query", "prompt", "url"];
  const detail = input ? detailKeys.map((key) => stringOf(input[key])).find((value) => value.trim()) ?? "" : "";
  const oneLine = detail.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return `${TOOL_LINE_MARK}**${name}**`;
  }
  return `${TOOL_LINE_MARK}**${name}:** ${oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine}`;
}

// graft prints its own estimate of what reading the files whole would have cost into its output.
const graftSavedPattern = /\[graft\] tokens saved ≈ ([\d,]+)/g;

function graftSavedIn(message: Record<string, unknown>): number {
  const content = recordOf(message.message)?.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let saved = 0;
  for (const entry of content) {
    const block = recordOf(entry);
    if (!block || stringOf(block.type) !== "tool_result") {
      continue;
    }
    // A tool result is usually one string; some tools hand back an array of content blocks instead.
    const raw = block.content;
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => stringOf(recordOf(part)?.text)).join("\n") : "";
    for (const match of text.matchAll(graftSavedPattern)) {
      saved += Number(match[1].replace(/,/g, "")) || 0;
    }
  }
  return saved;
}

function usageTotals(usage: Record<string, unknown>): { prompt: number; output: number; context: number } {
  const input = numberOf(usage.input_tokens) ?? 0;
  const output = numberOf(usage.output_tokens) ?? 0;
  const cacheRead = numberOf(usage.cache_read_input_tokens) ?? 0;
  const cacheCreate = numberOf(usage.cache_creation_input_tokens) ?? 0;
  // On a resumed session nearly all input arrives as cache reads, so the prompt total has to count
  // them: input_tokens on its own is only the uncached remainder and reads as a handful of tokens.
  const prompt = input + cacheRead + cacheCreate;
  return { prompt, output, context: prompt + output };
}

function countCodeLines(text: string): number {
  const codeMatches = text.match(/```[\s\S]*?```/g);
  if (!codeMatches) {
    return 0;
  }
  return codeMatches.reduce((total, block) => total + block.split("\n").length - 2, 0);
}

function collectProcess(command: string, args: string[], workspacePath: string, timeoutMs: number, stdinText: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspacePath, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdinText ?? "");
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