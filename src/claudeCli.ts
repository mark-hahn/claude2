import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ModelMap } from "./modelInfo";
import { TOOL_LINE_MARK, type ClaudePhase, type ClaudeRunResult, type PluginFlags, type PonySkip, type RunningStatus } from "./types";

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
  plugins: PluginFlags;
  onText: (text: string) => void;
  onStatus: (status: RunningStatus) => void;
}

type SessionMode = "new" | "resume";

interface RunningProcess {
  child: ChildProcess;
  status: RunningStatus;
  stopped: boolean;
  // Armed when Stop sends an interrupt, cleared when the run settles: the SIGTERM fallback for a
  // CLI that never answers the interrupt.
  killTimer: ReturnType<typeof setTimeout> | null;
}

// How long a graceful interrupt gets before the process is killed outright.
// ponytail: fixed grace, make it a setting if a real tool ever needs longer to unwind.
const INTERRUPT_GRACE_MS = 15000;

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
    if (running.killTimer) {
      return true;
    }
    // A control request stops the CLI at its own turn boundary, the way Escape does in the
    // interactive client: the partial message is flushed, "[Request interrupted by user]" is
    // written, and the session file stays valid for the next --resume. SIGTERM would cut the
    // file mid-message and could strand a tool_use with no result.
    try {
      running.child.stdin?.write(JSON.stringify({
        type: "control_request",
        request_id: `stop_${sessionId}`,
        request: { subtype: "interrupt" },
      }) + "\n");
    } catch (error) {
      this.log(`Claude interrupt failed: ${errorText(error)}`);
      running.child.kill("SIGTERM");
      return true;
    }
    running.killTimer = setTimeout(() => running.child.kill("SIGTERM"), INTERRUPT_GRACE_MS);
    return true;
  }

  public dispose(): void {
    for (const running of this.running.values()) {
      running.stopped = true;
      if (running.killTimer) {
        clearTimeout(running.killTimer);
        running.killTimer = null;
      }
      // No graceful interrupt here: the extension host is going away and nothing is left to
      // read the result the CLI would write back.
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
      ponySkips: [],
      codeLines: 0,
      phase: "thinking",
      compactedAt: null,
      elapsedMs: 0,
      startedAt: Date.now(),
      modelId: "",
    };

    // The prompt goes in on stdin so that text beginning with "-" is never parsed as a CLI option,
    // as a stream-json message rather than raw text so that stdin stays open as a control channel
    // for the interrupt `stop` sends.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      sanitizeModel(options.model),
      ...effortArgs(options.effort),
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
    if (!options.plugins.ponytail) {
      // Command-line settings outrank the user scope, so this turns the globally-enabled
      // ponytail plugin off for just this run.
      args.push("--settings", JSON.stringify({ enabledPlugins: { "ponytail@ponytail": false } }));
    }

    const child = spawn("claude", args, {
      cwd: options.workspacePath,
      env: childEnv(options.contextWindow, options.plugins.graft),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const running: RunningProcess = { child, status, stopped: false, killTimer: null };
    this.running.set(options.sessionId, running);
    child.stdin.on("error", (error) => this.log(`Claude stdin error: ${error.message}`));
    // Left open on purpose: under stream-json input the CLI reads stdin for the whole run, and
    // closing it is what lets the process exit, so that waits until the result line lands.
    child.stdin.write(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: options.prompt }] },
      parent_tool_use_id: null,
    }) + "\n");

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
      let ponySkips: PonySkip[] = [];
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
        if (running.killTimer) {
          clearTimeout(running.killTimer);
          running.killTimer = null;
        }
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
        // The result text can land without ever streaming a delta, so the final parse runs here.
        ponySkips = ponySkipsIn(responseText);
        status.ponySkips = ponySkips;
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
          ponySkips,
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
              // Subagents stream through here too, tagged with their parent tool call, and may run
              // on another model; only the main conversation's says what the prompt ran on.
              const answeredBy = stringOf(recordOf(event.message)?.model);
              if (answeredBy && !message.parent_tool_use_id) {
                status.modelId = answeredBy;
              }
            } else if (eventType === "content_block_start") {
              const block = recordOf(event.content_block);
              status.phase = phaseForBlock(stringOf(block?.type));
              if (responseText && !responseText.endsWith("\n")) {
                responseText += "\n";
                options.onText(DUMP_RAW_MESSAGES ? "\n\n" : "\n");
              }
            } else if (eventType === "content_block_stop") {
              status.phase = "working";
              // Re-parsed from the whole text each time, so the list rebuilds rather than double-counts.
              ponySkips = ponySkipsIn(responseText);
              status.ponySkips = ponySkips;
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
            status.compactedAt = Date.now();
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
          // The run is over but the CLI is still reading stdin; closing it is what ends the
          // process, whether the result came from a finished turn or from a Stop interrupt.
          child.stdin.end();
        }
      };
    });
  }

  // Called with the cheapest model: a short title needs nothing more, and it keeps background
  // naming off the quota of whatever model the user picked.
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

  public async updateCli(workspacePath: string): Promise<void> {
    await collectProcess("claude", ["update"], workspacePath, 180000, null);
  }

  // Asks the CLI which models this account can use and each one's effort levels: the same
  // initialize handshake the Agent SDK sends, answered without starting a turn.
  // Each model's Anthropic name: its description up to a " · " when it has one (only there
  // does "opus[1m]" say "Opus 5.5 with 1M context"), else its display name, e.g. "Sonnet 5".
  public async listModels(workspacePath: string): Promise<{ models: ModelMap; names: Record<string, string> }> {
    const request = JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } });
    const output = await collectProcess("claude", ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"], workspacePath, 30000, request + "\n");
    for (const line of output.split("\n")) {
      const parsed = line.includes('"control_response"') ? (JSON.parse(line) as { response?: { response?: { models?: { value?: unknown; supportedEffortLevels?: unknown; description?: unknown; displayName?: unknown }[] } } }) : undefined;
      const models: ModelMap = {};
      const names: Record<string, string> = {};
      for (const model of parsed?.response?.response?.models ?? []) {
        const value = stringOf(model.value);
        if (value && value !== "default") {
          models[value] = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.map(stringOf).filter(Boolean) : [];
          const description = stringOf(model.description);
          names[value] = (description.includes(" · ") ? description.split(" · ")[0] : stringOf(model.displayName)).trim();
        }
      }
      if (Object.keys(models).length > 0) {
        return { models, names };
      }
    }
    throw new Error("the CLI returned no model list.");
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
    `The UI tracks a ${contextWindow.toLocaleString()} token context window for this session.`,
  ].join("\n");
}

function childEnv(autoCompactWindow: number | null = null, graftEnabled = true): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A stray key would divert billing from the subscription to the API.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // The globally-hooked graft resolves its graph from GRAFT_DIR before <repo>/graft, so
  // pointing it at a dir with no INDEX.md makes every graft hook a silent no-op for this run.
  if (!graftEnabled) {
    env.GRAFT_DIR = path.join(os.tmpdir(), "claude2-graft-off");
  }
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
    return `Stopped at the turn limit of ${maxTurns}. The response above is unfinished — send another prompt to carry on, or raise the turn limit in the Models pane.`;
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
function transcriptPath(workspacePath: string, sessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectKey = workspacePath.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(configDir, "projects", projectKey, `${sessionId}.jsonl`);
}

// Assistant messages per model per hour (since the epoch) across every transcript on this machine.
// A streamed reply is written as several lines sharing one message id, and a forked session copies
// its parent's lines, so ids are deduped.
// ponytail: rereads all transcripts (~1s for 140MB) on every count; cache by file mtime if it gets slow.
export async function modelHours(): Promise<Record<string, Record<string, number>>> {
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  const files = (await fs.promises.readdir(projectsDir, { recursive: true }).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl"));
  const messages = new Map<string, { model: string; at: number }>();
  for (const file of files) {
    const text = await fs.promises.readFile(path.join(projectsDir, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"type":"assistant"')) {
        continue;
      }
      try {
        const entry = JSON.parse(line) as { uuid?: string; timestamp?: string; message?: { id?: string; model?: string } };
        const model = entry.message?.model;
        if (model && model !== "<synthetic>") {
          messages.set(entry.message?.id || entry.uuid || line, { model, at: Date.parse(entry.timestamp ?? "") || 0 });
        }
      } catch {
        // A line cut off mid-write by a running session.
      }
    }
  }
  const usage: Record<string, Record<string, number>> = {};
  for (const { model, at } of messages.values()) {
    const hours = (usage[model] ??= {});
    const hour = String(Math.floor(at / 3600000));
    hours[hour] = (hours[hour] ?? 0) + 1;
  }
  return usage;
}

function sessionTranscriptExists(workspacePath: string, sessionId: string): boolean {
  try {
    return fs.existsSync(transcriptPath(workspacePath, sessionId));
  } catch {
    return false;
  }
}

// A fork keeps the whole conversation alive under a new session id, so the CLI transcript is copied
// across with the old id swapped out -- the copy resumes as a session of its own, not as the source.
export function copySessionTranscript(workspacePath: string, fromId: string, toId: string): boolean {
  try {
    const text = fs.readFileSync(transcriptPath(workspacePath, fromId), "utf8");
    fs.writeFileSync(transcriptPath(workspacePath, toId), text.split(fromId).join(toId), "utf8");
    return true;
  } catch {
    return false;
  }
}

// Forking a conversation only means anything to Claude if the CLI forgets the dropped runs too:
// the next prompt resumes from this file, so it is cut at the prompt that starts the first dropped
// run. keepPrompts is how many prompts stay; droppedPrompt is the text of the first one to go, used
// to confirm the cut lands where the pane thinks it does. The old file is kept alongside as .bak.
export function truncateSessionTranscript(workspacePath: string, sessionId: string, keepPrompts: number, droppedPrompt: string): boolean {
  const file = transcriptPath(workspacePath, sessionId);
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return false;
  }
  // Line numbers of the real prompts, in order. Tool results and subagent traffic are user entries
  // too, so a prompt is the narrower thing: top-level, plain text, and sourced from a caller.
  const promptLines: number[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const message = entry.message as { content?: unknown } | undefined;
      if (entry.type === "user" && entry.isSidechain !== true && entry.promptSource && typeof message?.content === "string") {
        promptLines.push(index);
      }
    } catch {
      // A half-written line is not a prompt; the scan carries on past it.
    }
  });
  // The prompt at the keep boundary, unless the transcript disagrees with the pane's count — then
  // the first later prompt whose text matches the run being dropped.
  let cut = promptLines.length > keepPrompts ? promptLines[keepPrompts] : -1;
  const textAt = (index: number): string => {
    try {
      return String((JSON.parse(lines[index]) as { message?: { content?: unknown } }).message?.content ?? "");
    } catch {
      return "";
    }
  };
  if (droppedPrompt && (cut < 0 || textAt(cut) !== droppedPrompt)) {
    const match = promptLines.find((index) => textAt(index) === droppedPrompt);
    cut = match === undefined ? -1 : match;
  }
  if (cut < 0) {
    return false;
  }
  try {
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, lines.slice(0, cut).join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A bad name refuses the run rather than quietly running some other model.
export function sanitizeModel(model: string): string {
  if (!model) {
    throw new Error("No model to run: no preset is enabled in the Models pane.");
  }
  if (!/^[a-z0-9.-]+(\[[a-z0-9]+\])?$/i.test(model)) {
    throw new Error(`Malformed model name: ${JSON.stringify(model)}`);
  }
  return model;
}

// A model with no effort levels (haiku) runs with no --effort at all; anything else malformed
// refuses the run rather than letting the CLI pick an effort.
export function effortArgs(effort: string): string[] {
  if (effort && !/^[a-z]+$/.test(effort)) {
    throw new Error(`Malformed effort: ${JSON.stringify(effort)}`);
  }
  return effort ? ["--effort", effort] : [];
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

// Ponytail closes a response with lines like "skipped: X, add when Y" — X is what it declined to
// build, Y the condition that would justify building it. The line may open a sentence or follow
// an arrow mid-line; anything looser than the documented shape is not counted.
// ponytail: parses only the documented "skipped: X[, add when Y]" form; widen if real output drifts.
const ponySkipPattern = /(?:^[-•*]?|→)\s*skipped:\s*(.+?)(?:[,;]\s*add when\s+(.+?))?\s*\.?\s*$/i;

function ponySkipsIn(text: string): PonySkip[] {
  const skips: PonySkip[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(TOOL_LINE_MARK)) {
      continue;
    }
    const match = ponySkipPattern.exec(line);
    if (match) {
      skips.push({ x: match[1].trim(), y: (match[2] ?? "").trim() });
    }
  }
  return skips;
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
      reject(new Error(`claude ${args[0] ?? ""} timed out.`));
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

// The model sometimes answers with a title line followed by a markdown body, so only the first
// non-blank line counts, and markdown markup is stripped from it.
function cleanTitle(rawTitle: string, prompt: string): string {
  const title = plainLine(rawTitle).replace(/[.!?:;]+$/g, "").split(" ").slice(0, 6).join(" ");
  if (title) {
    return title.slice(0, 60);
  }
  return plainLine(prompt).slice(0, 56) || "New session";
}

function plainLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/^(#+|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_`~"'#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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