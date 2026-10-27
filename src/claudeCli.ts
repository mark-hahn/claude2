import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ModelMap } from "./modelInfo";
import { TOOL_LINE_MARK, type ClaudePhase, type ClaudeRunResult, type PluginFlags, type PonySkip, type RunningStatus } from "./types";

// TEMP: when true, every raw stream-json line from claude is shown in the response, blank-line separated.
const DUMP_RAW_MESSAGES = false;

const titleBudgetUsd = 0.25;
// Opus reading ~5k tokens of diff and prompts costs a few cents at API rates.
const describeBudgetUsd = 0.5;
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
  // Handed to the CLI as its auto-compact window; null leaves the model's own window in charge.
  compactWindow: number | null;
  workspacePath: string;
  hasPriorTurns: boolean;
  // Context is a level, not a total: a run inherits where the last one left off so the gauge
  // never drops to zero while the first API call of the run is still in flight.
  priorContextTokens: number;
  limits: RunLimits;
  // The Long tool display setting: tool lines in longToolUseLine's form instead of toolUseLine's.
  longTools: boolean;
  fastMode: boolean;
  // Empty for none, else the family the advisor tool consults (the Use advisor setting, advisorFor).
  advisor: string;
  // The Prompt suggestions setting: the CLI predicts the next prompt after the turn and
  // onSuggestion gets it. Not every turn has one; the CLI skips a cold cache, for one.
  promptSuggestions: boolean;
  onSuggestion: (suggestion: string) => void;
  plugins: PluginFlags;
  // Where the run's debug record goes: one <sessionId>.jsonl per session holding what each turn
  // was started with (args, env) and the CLI's init message (version, tools, plugins, memory files).
  debugDir: string;
  onText: (text: string) => void;
  onStatus: (status: RunningStatus) => void;
}

type SessionMode = "new" | "resume";

// What contextUsage needs to start the CLI the way a run of the session would.
export interface ContextProbeOptions {
  sessionId: string;
  workspacePath: string;
  // Empty leaves the CLI on its own default model.
  model: string;
  contextWindow: number;
  compactWindow: number | null;
  permissionMode: string;
  advisor: string;
  plugins: PluginFlags;
}

interface RunningProcess {
  child: ChildProcess;
  status: RunningStatus;
  stopped: boolean;
  // Armed when Stop sends an interrupt, cleared when the run settles: the SIGTERM fallback for a
  // CLI that never answers the interrupt.
  killTimer: ReturnType<typeof setTimeout> | null;
  // What the process was started with; a follow-up prompt has to match, since neither can change mid-process.
  model: string;
  effort: string;
  advisor: string;
  // Hands the live process to a new prompt's block while it waits on a background task.
  followUp: ((next: RunPromptOptions) => Promise<ClaudeRunResult>) | null;
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
    // Waiting on a background task there is no turn to interrupt; closing stdin makes the CLI
    // kill the task and exit.
    if (running.status.phase === "background") {
      running.child.stdin?.end();
      running.killTimer = setTimeout(() => running.child.kill("SIGTERM"), INTERRUPT_GRACE_MS);
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

  // True while the pill shows B and this prompt could go into the waiting process, which keeps
  // the background task alive, rather than stopping it.
  public canFollowUp(sessionId: string, model: string, effort: string, advisor: string): boolean {
    const running = this.running.get(sessionId);
    return !!running?.followUp && !running.stopped && running.status.phase === "background" && running.model === model && running.effort === effort && running.advisor === advisor;
  }

  public async runPrompt(options: RunPromptOptions): Promise<ClaudeRunResult> {
    const live = this.running.get(options.sessionId);
    if (live?.followUp && this.canFollowUp(options.sessionId, options.model, options.effort, options.advisor)) {
      return await live.followUp(options);
    }
    if (live) {
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
      phase: "working",
      compactedAt: null,
      elapsedMs: 0,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      sinceEventMs: 0,
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
      claude2SystemPrompt(options.contextWindow, options.advisor),
    ];
    if (options.limits.maxBudgetUsd > 0) {
      args.push("--max-budget-usd", String(options.limits.maxBudgetUsd));
    }
    // Command-line settings outrank every settings file, so these apply to just this run.
    // advisorModel is what /advisor sets, but /advisor writes it to the user's settings file,
    // where it would reach every session on the machine. Always sent: the CLI reads "" as no
    // advisor, so none here overrides an advisorModel left in any settings file.
    const runSettings: Record<string, unknown> = { advisorModel: options.advisor ? sanitizeModel(options.advisor) : "" };
    if (!options.plugins.ponytail) {
      // Turns the globally-enabled ponytail plugin off.
      runSettings.enabledPlugins = { "ponytail@ponytail": false };
    }
    if (options.fastMode) {
      // A -p run only gets fast mode from its --settings.
      runSettings.fastMode = true;
    }
    if (options.promptSuggestions) {
      // A -p run only predicts with the flag, and the setting outranks a promptSuggestionEnabled
      // false that /config may have left in a settings file.
      args.push("--prompt-suggestions", "true");
      runSettings.promptSuggestionEnabled = true;
    }
    args.push("--settings", JSON.stringify(runSettings));

    const env = childEnv(options.compactWindow, options.plugins.graft);
    if (!options.fastMode) {
      // Fast mode bills usage credits, so off is a hard off that outranks a fastMode in any settings file.
      env.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
    }
    // The env var outranks every setting. Off is a hard off; on drops an inherited one, since its
    // "true" would also keep suggestions running near the plan limit, where the CLI otherwise stops.
    if (options.promptSuggestions) {
      delete env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION;
    } else {
      env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
    }
    const child = spawn("claude", args, {
      cwd: options.workspacePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The debugging record: the CLI's transcript keeps neither what it was started with nor its
    // init message, and the two are what a "why did this session behave differently" hunt needs.
    const debugFile = path.join(options.debugDir, `${options.sessionId}.jsonl`);
    const debugLog = (record: Record<string, unknown>): void => {
      fs.promises.mkdir(options.debugDir, { recursive: true })
        .then(() => fs.promises.appendFile(debugFile, `${JSON.stringify({ at: new Date().toISOString(), turnId: options.turnId, ...record })}\n`))
        .catch((error) => this.log(`Debug record failed: ${errorText(error)}`));
    };
    debugLog({ spawn: { mode, cwd: options.workspacePath, args, env: { GRAFT_DIR: env.GRAFT_DIR, CLAUDE_CODE_AUTO_COMPACT_WINDOW: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, CLAUDE_CODE_DISABLE_FAST_MODE: env.CLAUDE_CODE_DISABLE_FAST_MODE, CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION } } });
    const running: RunningProcess = { child, status, stopped: false, killTimer: null, model: options.model, effort: options.effort, advisor: options.advisor, followUp: null };
    this.running.set(options.sessionId, running);
    child.stdin.on("error", (error) => this.log(`Claude stdin error: ${error.message}`));
    // Left open on purpose: under stream-json input the CLI reads stdin for the whole run, and
    // closing it is what lets the process exit, so that waits until the result line lands.
    child.stdin.write(userMessage(options.prompt));

    return await new Promise<ClaudeRunResult>((resolve, reject) => {
      // A follow-up prompt swaps in its own block: its promise, its callbacks, fresh counters.
      let resolveBlock = resolve;
      let rejectBlock = reject;
      // total_cost_usd counts from the start of the process; a follow-up block reports only its share.
      let costBase = 0;
      let stdoutBuffer = "";
      let stderrText = "";
      let responseText = "";
      let tokensIn = 0;
      let tokensOut = 0;
      let contextTokens = Math.max(0, options.priorContextTokens);
      let costUsd: number | null = null;
      let modelWindow: number | null = null;
      let stopReason: string | null = null;
      let answer = "";
      let durationMs = 0;
      let ponySkips: PonySkip[] = [];
      // What the CLI itself counted. --max-turns is enforced against this, not against the
      // message_start tally the gauge runs on live, and the two do not agree.
      let reportedTurns = 0;
      // Background shells and agents still running. When one finishes the CLI starts another
      // turn on its own, but only while stdin is still open.
      let backgroundTasks = 0;
      let resultError: string | null = null;
      // /clear: the CLI carries on in a new session, whose id the result line brings.
      let conversationReset = false;
      let clearedInto: string | null = null;
      let settled = false;
      let sawTextDelta = false;
      let toolBatchOpen = false;
      let turnEnded = false;
      // Tool calls are announced once each; the CLI can repeat an assistant message, so key off the block id.
      const seenToolUses = new Set<string>();

      // Everything the pane shows goes through here. Only a chunk with something visible in it
      // restarts the footer's quiet timer: a bare separator newline shows nothing.
      const show = (text: string): void => {
        if (text.trim()) {
          status.lastEventAt = Date.now();
        }
        options.onText(text);
      };

      // Tool lines stack one per line with no blank line between them; the blank lines go around the batch.
      // Each carries the mark and the local wall-clock time it arrived, "hh:mm:ss ", ahead of its text.
      // A long tool line's continuation lines carry the mark too, so they stay in its tool group.
      const appendToolLine = (text: string, now = new Date()): void => {
        const gap = toolBatchOpen || !responseText || responseText.endsWith("\n\n") ? "" : responseText.endsWith("\n") ? "\n" : "\n\n";
        const t = laParts(now);
        const chunk = `${gap}${TOOL_LINE_MARK}${t.hour}:${t.minute}:${t.second} ${text.replace(/\n/g, `\n${TOOL_LINE_MARK}`)}\n`;
        responseText += chunk;
        show(chunk);
        toolBatchOpen = true;
      };

      // Closes an open batch with the blank line that separates it from the prose that follows.
      const closeToolBatch = (): void => {
        if (!toolBatchOpen) {
          return;
        }
        toolBatchOpen = false;
        responseText += "\n";
        show("\n");
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
          show("[stderr] " + chunk + "\n\n");
        }
      });

      child.on("error", (error) => {
        settle(() => rejectBlock(new Error(`Could not start Claude CLI: ${error.message}`)));
      });

      const blockResult = (): ClaudeRunResult => {
        // The result text can land without ever streaming a delta, so the final parse runs here.
        ponySkips = ponySkipsIn(responseText);
        return {
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
          answer,
          clearedInto,
          modelWindow,
        };
      };

      child.on("close", (exitCode) => {
        if (stdoutBuffer.trim()) {
          handleClaudeLine(stdoutBuffer.trim());
        }
        appendToolLine(FINISHED_LINE);
        const finalResult = blockResult();
        status.active = false;
        status.phase = null;
        status.costUsd = costUsd;
        status.contextTokens = contextTokens;
        status.ponySkips = ponySkips;
        emitStatus();

        if (running.stopped) {
          settle(() => resolveBlock(finalResult));
          return;
        }
        if (resultError) {
          const errorText = resultError;
          settle(() => rejectBlock(new Error(errorText)));
          return;
        }
        if (exitCode !== 0) {
          settle(() => rejectBlock(new Error(stderrText.trim() || `Claude CLI exited with code ${exitCode ?? "unknown"}.`)));
          return;
        }
        settle(() => resolveBlock(finalResult));
      });

      // The waiting block is finished as it stands and the new prompt's block takes over the
      // process. When the task ends, the CLI's turn about it lands in whichever block is current.
      running.followUp = (next) => new Promise<ClaudeRunResult>((nextResolve, nextReject) => {
        appendToolLine(FINISHED_LINE);
        resolveBlock(blockResult());
        resolveBlock = nextResolve;
        rejectBlock = nextReject;
        options = next;
        costBase += costUsd ?? 0;
        responseText = "";
        tokensIn = 0;
        tokensOut = 0;
        costUsd = null;
        stopReason = null;
        answer = "";
        durationMs = 0;
        ponySkips = [];
        reportedTurns = 0;
        conversationReset = false;
        clearedInto = null;
        sawTextDelta = false;
        toolBatchOpen = false;
        turnEnded = false;
        const now = new Date();
        appendToolLine(startedLine(now), now);
        Object.assign(status, { turnId: next.turnId, turns: 0, costUsd: null, ponySkips: [], codeLines: 0, phase: "working", compactedAt: null, startedAt: Date.now(), lastEventAt: Date.now() });
        emitStatus();
        child.stdin.write(userMessage(next.prompt));
      });

      const now = new Date();
      appendToolLine(startedLine(now), now);
      emitStatus();

      const handleClaudeLine = (line: string): void => {
        if (DUMP_RAW_MESSAGES) {
          show(line + "\n\n");
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
              // A turn the CLI started on its own, when a background task finished, opens a new paragraph.
              const gap = turnEnded ? "\n\n" : "\n";
              turnEnded = false;
              if (responseText && !responseText.endsWith(gap)) {
                const chunk = responseText.endsWith("\n") ? "\n" : gap;
                responseText += chunk;
                show(DUMP_RAW_MESSAGES ? "\n\n" : chunk);
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
                show(DUMP_RAW_MESSAGES ? textDelta + "\n\n" : textDelta);
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
              // The advisor runs on the API side: its call is a server_tool_use with no input.
              const advisorCall = stringOf(block?.type) === "server_tool_use" && stringOf(block?.name) === "advisor";
              if (!block || (stringOf(block.type) !== "tool_use" && !advisorCall)) {
                continue;
              }
              const blockId = stringOf(block.id);
              if (blockId && seenToolUses.has(blockId)) {
                continue;
              }
              seenToolUses.add(blockId);
              appendToolLine(advisorCall ? advisorLine(options.advisor) : options.longTools ? longToolUseLine(block) : toolUseLine(block));
            }
          }
        } else if (messageType === "system") {
          // Compaction runs between API calls, so nothing else on the stream moves while it works.
          // Without this the phase would sit on whatever it last showed for the whole pause.
          const subtype = stringOf(message.subtype);
          if (subtype === "init") {
            debugLog({ init: message });
          } else if (subtype === "status" && stringOf(message.status) === "compacting") {
            if (status.phase !== "compacting") {
              appendToolLine(COMPACTING_LINE);
            }
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
            appendToolLine(`**Compacted:** conversation summarised${before ? ` from ${before.toLocaleString()} tokens` : ""}`);
            emitStatus();
          } else if (subtype === "background_tasks_changed") {
            backgroundTasks = Array.isArray(message.tasks) ? message.tasks.length : 0;
            // A task finishing during the wait is what starts the next turn.
            if (status.phase === "background") {
              status.phase = "working";
              emitStatus();
            }
          }
        } else if (messageType === "rate_limit_event") {
          status.phase = "working";
          emitStatus();
        } else if (messageType === "conversation_reset") {
          // /clear: the context is empty from here on.
          conversationReset = true;
          contextTokens = 0;
          status.contextTokens = 0;
          emitStatus();
        } else if (messageType === "prompt_suggestion") {
          // Lands after the result, while the CLI holds the process open for it. A run stopped by
          // a new prompt keeps its guess to itself: the box now holds that prompt.
          const suggestion = stringOf(message.suggestion);
          if (suggestion.trim() && !running.stopped) {
            options.onSuggestion(suggestion);
          }
        } else if (messageType === "result") {
          // Each result covers only its own turn (a background task can bring a second one), so
          // usage, duration and turns add up; total_cost_usd alone is already the process total.
          const usage = recordOf(message.usage);
          if (usage) {
            const totals = usageTotals(usage);
            tokensIn += totals.prompt;
            tokensOut += totals.output;
            // No context reading here: the result usage sums cache reads over every API call in the
            // run, so it runs far past the window. Only a stream_event carries a real context level.
          }
          const resultText = stringOf(message.result);
          const isError = message.is_error === true;
          if (!isError) {
            answer = resultText;
          }
          // Tool lines alone do not count as a response, so the result text still has to land after
          // them. An error result's text is the error itself and is reported there instead.
          if (!sawTextDelta && resultText && !isError) {
            closeToolBatch();
            responseText += resultText;
            show(resultText);
          }
          const totalCost = numberOf(message.total_cost_usd);
          costUsd = totalCost === null ? null : totalCost - costBase;
          modelWindow = mainModelWindow(recordOf(message.modelUsage), status.modelId) ?? modelWindow;
          durationMs += numberOf(message.duration_ms) ?? 0;
          reportedTurns += numberOf(message.num_turns) ?? 0;
          if (reportedTurns > 0) {
            // Snap the live tally to the real count now that the run has one to give.
            status.turns = reportedTurns;
            emitStatus();
          }
          stopReason = stringOf(message.stop_reason) || stringOf(message.terminal_reason);
          const reportedSession = stringOf(message.session_id);
          if (conversationReset && reportedSession && reportedSession !== options.sessionId) {
            clearedInto = reportedSession;
          }
          if (isError) {
            const subtype = stringOf(message.subtype);
            // An auth failure arrives as is_error under subtype "success", with the real story in
            // the result text; only a true error_ subtype has a readable form of its own.
            resultError = subtype.startsWith("error_") ? readableResultError(subtype, options.limits) : resultText || readableResultError(subtype, options.limits);
          }
          // The run is over but the CLI is still reading stdin; closing it is what ends the
          // process, whether the result came from a finished turn or from a Stop interrupt.
          // With a background task still running it stays open so the CLI can carry on when the
          // task finishes. ponytail: a task that never ends (a dev server) holds the run open until Stop.
          turnEnded = true;
          if (isError || running.stopped || backgroundTasks === 0) {
            child.stdin.end();
          } else {
            status.phase = "background";
            emitStatus();
          }
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

  // The Git changes check's reminder of what is waiting to be committed. Opus on the
  // subscription, asked only once the warning is going to open; no tools, settings or MCP
  // servers, so the CLI starts as fast as it can.
  public async describeChanges(changesMessage: string, workspacePath: string): Promise<string> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-opus-5-5",
      ...effortArgs("low"),
      "--max-budget-usd",
      String(describeBudgetUsd),
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt",
      "You describe uncommitted git changes in one or two short plain sentences, the way a commit message would. Return only the description.",
    ];
    const output = await collectProcess("claude", args, workspacePath, 30000, `${changesMessage}Describe these uncommitted changes.`);
    let result = output;
    try {
      const parsed = JSON.parse(output) as unknown;
      result = isRecord(parsed) ? stringOf(parsed.result) : output;
    } catch {}
    return result.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim().slice(0, 400);
  }

  public async updateCli(workspacePath: string): Promise<void> {
    await collectProcess("claude", ["update"], workspacePath, 180000, null);
  }

  public async cliVersion(workspacePath: string): Promise<string> {
    return (await collectProcess("claude", ["--version"], workspacePath, 30000, null)).trim();
  }

  // The CLI re-downloads the account's settings -- which decide the model list it reports --
  // only when it actually talks to the API, so a one-word prompt on the cheapest model is what
  // brings a stale list up to date. Its answer is thrown away.
  public async refreshAccountSettings(model: string, workspacePath: string): Promise<void> {
    const args = ["-p", "--output-format", "json", "--model", sanitizeModel(model), "--max-turns", "1", "--max-budget-usd", String(titleBudgetUsd), "--tools", "", "--setting-sources", "", "--no-session-persistence"];
    await collectProcess("claude", args, workspacePath, 60000, "ok");
  }

  // Asks the CLI which models this account can use and each one's effort levels: the same
  // initialize handshake the Agent SDK sends, answered without starting a turn.
  // Each model's Anthropic name: its description up to a " · " when it has one (only there
  // does "opus[1m]" say "Opus 5.5 with 1M context"), else its display name, e.g. "Sonnet 5".
  public async listModels(workspacePath: string): Promise<{ models: ModelMap; names: Record<string, string>; ids: Record<string, string> }> {
    const request = JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } });
    const output = await collectProcess("claude", ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"], workspacePath, 30000, request + "\n");
    for (const line of output.split("\n")) {
      const parsed = line.includes('"control_response"') ? (JSON.parse(line) as { response?: { response?: { models?: { value?: unknown; resolvedModel?: unknown; supportedEffortLevels?: unknown; description?: unknown; displayName?: unknown }[] } } }) : undefined;
      const models: ModelMap = {};
      const names: Record<string, string> = {};
      const ids: Record<string, string> = {};
      for (const model of parsed?.response?.response?.models ?? []) {
        const value = stringOf(model.value);
        if (value && value !== "default") {
          models[value] = Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.map(stringOf).filter(Boolean) : [];
          const description = stringOf(model.description);
          names[value] = (description.includes(" · ") ? description.split(" · ")[0] : stringOf(model.displayName)).trim();
          ids[value] = stringOf(model.resolvedModel);
        }
      }
      if (Object.keys(models).length > 0) {
        return { models, names, ids };
      }
    }
    throw new Error("the CLI returned no model list.");
  }

  // Each model's context window as the CLI sizes it with no auto-compact override, asked over the
  // control channel (set_model, then get_context_usage) without starting a turn. The CLI answers
  // control requests concurrently, so each waits on the one before or it measures the wrong model.
  public async modelWindows(models: string[], workspacePath: string): Promise<Record<string, number>> {
    const channel = controlChannel([], childEnv(), workspacePath, 60000);
    const windows: Record<string, number> = {};
    try {
      await channel.ask({ subtype: "initialize" });
      for (const model of models) {
        if (await channel.ask({ subtype: "set_model", model })) {
          const window = numberOf((await channel.ask({ subtype: "get_context_usage" }))?.maxTokens);
          if (window !== null && window > 0) {
            windows[model] = window;
          }
        }
      }
    } finally {
      channel.close();
    }
    return windows;
  }

  // The CLI's own count of what fills the session's context (its /context, as data), without
  // starting a turn. It resumes a throwaway copy of the transcript: resuming the real one appends
  // the CLI's bookkeeping lines to it. Started with a run's flags, so the system prompt and tools
  // it measures are the ones a run sends. Null when the session has no transcript or the CLI fails.
  public async contextUsage(options: ContextProbeOptions): Promise<Record<string, unknown> | null> {
    const probeId = randomUUID();
    const runSettings: Record<string, unknown> = { advisorModel: options.advisor ? sanitizeModel(options.advisor) : "" };
    if (!options.plugins.ponytail) {
      runSettings.enabledPlugins = { "ponytail@ponytail": false };
    }
    const args = [
      ...(options.model ? ["--model", sanitizeModel(options.model)] : []),
      "--resume",
      probeId,
      "--permission-mode",
      sanitizePermissionMode(options.permissionMode),
      "--add-dir",
      capTempDir(),
      "--append-system-prompt",
      claude2SystemPrompt(options.contextWindow, options.advisor),
      "--settings",
      JSON.stringify(runSettings),
    ];
    // Copied only once the flags are known good, so nothing can throw between the copy and its removal.
    if (!copySessionTranscript(options.workspacePath, options.sessionId, probeId)) {
      return null;
    }
    const channel = controlChannel(args, childEnv(options.compactWindow, options.plugins.graft), options.workspacePath, 30000);
    // The CLI writes the copy's last lines as it exits, so the copy goes only once it has.
    void channel.exited.then(() => fs.promises.rm(transcriptPath(options.workspacePath, probeId), { force: true })).catch(() => undefined);
    try {
      return (await channel.ask({ subtype: "initialize" })) ? (await channel.ask({ subtype: "get_context_usage" })) ?? null : null;
    } finally {
      channel.close();
    }
  }

  private snapshot(status: RunningStatus): RunningStatus {
    const now = Date.now();
    return { ...status, elapsedMs: now - status.startedAt, sinceEventMs: now - status.lastEventAt };
  }
}

// A CLI process driven only over its control channel: no prompt goes in, so no turn runs and
// nothing is billed. The CLI answers control requests concurrently, so a caller that needs them
// in order awaits each before sending the next.
function controlChannel(args: string[], env: NodeJS.ProcessEnv, workspacePath: string, timeoutMs: number): {
  ask: (request: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  close: () => void;
  exited: Promise<void>;
} {
  const child = spawn("claude", ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", ...args], { cwd: workspacePath, env, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<string, (response: Record<string, unknown> | undefined) => void>();
  let closed = false;
  let markExited = (): void => undefined;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const finish = (): void => {
    closed = true;
    for (const resolve of waiting.values()) {
      resolve(undefined);
    }
    waiting.clear();
    markExited();
  };
  const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  child.on("error", finish);
  child.on("close", finish);
  child.stdin.on("error", () => undefined);
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines.filter((candidate) => candidate.includes('"control_response"'))) {
      try {
        const reply = recordOf(recordOf(JSON.parse(line))?.response);
        const id = stringOf(reply?.request_id);
        waiting.get(id)?.(stringOf(reply?.subtype) === "success" ? recordOf(reply?.response) ?? {} : undefined);
        waiting.delete(id);
      } catch {}
    }
  });
  let sent = 0;
  const ask = (request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => new Promise((resolve) => {
    if (closed) {
      resolve(undefined);
      return;
    }
    const id = `w${(sent += 1)}`;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
  });
  const close = (): void => {
    clearTimeout(timeout);
    child.stdin.end();
  };
  return { ask, close, exited };
}

// Where Cap screenshots are read from: the WSL host reads them off the Windows side of the
// mount, every other host uses its own temp dir (see capture.ts).
function capTempDir(): string {
  return process.platform === "linux" && fs.existsSync("/mnt/c/Windows/Temp") ? "/mnt/c/Windows/Temp" : os.tmpdir();
}

// The context window the CLI reports for the model the main conversation ran on. modelUsage also
// lists subagent and side-task models, so the main one is picked out by the id the stream gave;
// with no id yet, a lone entry is taken as it.
function mainModelWindow(modelUsage: Record<string, unknown> | undefined, modelId: string): number | null {
  const entries = Object.entries(modelUsage ?? {});
  const main = entries.find(([key, usage]) => key === modelId || key.startsWith(`${modelId}[`) || stringOf(recordOf(usage)?.canonicalModel) === modelId)
    ?? (entries.length === 1 ? entries[0] : undefined);
  const window = main ? numberOf(recordOf(main[1])?.contextWindow) : null;
  return window !== null && window > 0 ? window : null;
}

function claude2SystemPrompt(contextWindow: number, advisor: string): string {
  return [
    "You are running in the Claude2 VS Code extension.",
    `The UI tracks a ${contextWindow.toLocaleString()} token context window for this session.`,
    // The sidebar's tool line is the Bash description; without one it falls back to the raw
    // command, which the user reads as a bug. The model drops the field for a whole session
    // once its first Bash call lacks it, so the rule names the first call in particular.
    "IMPORTANT: Every Bash tool call MUST include the `description` field -- a short plain-English phrase saying what the command does, e.g. \"Find gutter code occurrences\". This is required even for quick greps and one-liners, and above all on the very first Bash call of the session: the Claude2 UI shows that description as the tool line, and a missing one shows the raw command instead, which the user treats as a bug.",
    // Also read by the CLI's prompt-suggestion request, which otherwise favours "commit this" or
    // "push it" once a task is done.
    "The user does all git commits and pushes themselves and never asks Claude to. Never predict a commit or push prompt.",
    // The CLI's own advisor guidance asks for a call before and after every multi-step task, which
    // the user finds far too often. There is no setting for how often; only the prompt can say.
    ...(advisor ? ["The user finds advisor calls too frequent. This overrides the default advisor guidance: do not call the advisor before starting or after finishing routine work, on short tasks, or to answer questions. Call it only when stuck (errors recurring, an approach not converging) or before a large or hard-to-reverse change."] : []),
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
  } else {
    // An inherited one would quietly overrule each model's own window.
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
  return env;
}

// A run that hit a limit comes back as a bare subtype like "error_max_turns". Both panes show this
// string as it stands, so it becomes a sentence here rather than being decoded in each of them.
// The two Settings-pane limits stop a run the same way, so they read the same way.
function readableResultError(subtype: string, limits: RunLimits): string {
  const hitLimit = (limit: string): string => `Stopped at the ${limit}. The response above is unfinished — send another prompt to carry on, or raise the limit in the Settings pane.`;
  if (subtype === "error_max_turns") {
    return hitLimit(`turn limit of ${limits.maxTurns}`);
  }
  if (subtype === "error_max_budget_usd") {
    return hitLimit(`budget limit of $${limits.maxBudgetUsd.toFixed(2)}`);
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
export function transcriptPath(workspacePath: string, sessionId: string): string {
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
// /clear leaves the old conversation in its transcript and goes on in a new one. Trading the two
// files' ids keeps the session on its own id, now holding the cleared conversation, and leaves the
// old one resumable from a terminal under the other id, as the CLI's own /clear does.
export function swapSessionTranscripts(workspacePath: string, sessionId: string, otherId: string): boolean {
  try {
    const mine = fs.readFileSync(transcriptPath(workspacePath, sessionId), "utf8");
    const other = fs.readFileSync(transcriptPath(workspacePath, otherId), "utf8");
    fs.writeFileSync(transcriptPath(workspacePath, sessionId), other.split(otherId).join(sessionId), "utf8");
    fs.writeFileSync(transcriptPath(workspacePath, otherId), mine.split(sessionId).join(otherId), "utf8");
    return true;
  } catch {
    return false;
  }
}

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
  // The real prompts, in order, with their text. Tool results and subagent traffic are user entries
  // too, so a prompt is the narrower thing: top-level, text only, and sourced from a caller.
  const prompts: { index: number; text: string }[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const text = promptText((entry.message as { content?: unknown } | undefined)?.content);
      if (entry.type === "user" && entry.isSidechain !== true && entry.promptSource && text !== null) {
        prompts.push({ index, text });
      }
    } catch {
      // A half-written line is not a prompt; the scan carries on past it.
    }
  });
  // The prompt at the keep boundary, unless the transcript disagrees with the pane's count — then
  // the first later prompt whose text matches the run being dropped.
  let cut = prompts.length > keepPrompts ? prompts[keepPrompts] : undefined;
  if (droppedPrompt && cut?.text !== droppedPrompt) {
    cut = prompts.find((prompt) => prompt.text === droppedPrompt);
  }
  if (!cut) {
    return false;
  }
  try {
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, lines.slice(0, cut.index).join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// A prompt's text as the transcript holds it: a plain string, or a list of blocks (the form
// userMessage sends) whose text blocks are joined. Null for content with a tool result in it, or
// no text at all: that entry is not a prompt.
function promptText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  const blocks = Array.isArray(content) ? content.map(recordOf) : [];
  const text = blocks.filter((block) => stringOf(block?.type) === "text");
  return text.length && !blocks.some((block) => stringOf(block?.type) === "tool_result") ? text.map((block) => stringOf(block?.text)).join("") : null;
}

function userMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null }) + "\n";
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

// Every block's response opens and closes with these, stored with it like any tool line.
// Tool-line times and the Started date both come from here, in LA time, so they can't disagree.
// h23 keeps midnight as 00, not en-US's 24.
function laParts(now: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
  return Object.fromEntries(parts.map((x) => [x.type, x.value]));
}

// Started carries the LA date, e.g. "**Started:** Mon 2026/10/19". Pass the same Date given to appendToolLine.
function startedLine(now: Date): string {
  const p = laParts(now);
  return `**Started:** ${p.weekday} ${p.year}/${p.month}/${p.day}`;
}
const FINISHED_LINE = "**Finished:** =======";
const COMPACTING_LINE = "**Compacting:** =======";

// One tool call on one line: the tool name plus whichever input field best names what it was pointed at.
// The name is wrapped in ** so the conversation view can bold it; nothing else in the line is markup.
// An advisor call says who was asked. What it advised comes back encrypted, for Claude alone.
function advisorLine(advisor: string): string {
  const model = advisor ? advisor[0].toUpperCase() + advisor.slice(1) : "the advisor model";
  return `**Advisor:** asking ${model} to review the work so far`;
}

function toolUseLine(block: Record<string, unknown>): string {
  const name = stringOf(block.name) || "tool";
  const input = recordOf(block.input);
  const detailKeys = ["description", "command", "file_path", "path", "pattern", "query", "prompt", "url"];
  // A Skill call has no detail field, just the skill's name and any args, as in the Long form.
  const skillDetail = name === "Skill" && input ? [stringOf(input.skill).replace(/^\//, ""), stringOf(input.args)].filter(Boolean).join(" ") : "";
  const detail = skillDetail || (input ? detailKeys.map((key) => stringOf(input[key])).find((value) => value.trim()) ?? "" : "");
  const oneLine = detail.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return `**${name}**`;
  }
  return `**${name}:** ${oneLine.length > 160 ? `${oneLine.slice(0, 159)}…` : oneLine}`;
}

// The Long tool display form: what the official Claude Code extension shows for the call -- its
// header detail, and the input it lists under IN -- with that input indented on the lines below.
// Tool results are not shown.
function longToolUseLine(block: Record<string, unknown>): string {
  const name = stringOf(block.name) || "tool";
  const input = recordOf(block.input) ?? {};
  const field = (key: string): string => stringOf(input[key]);
  const head = (detail: string): string => (detail ? `**${name}:** ${detail}` : `**${name}**`);
  const withBody = (detail: string, body: string): string => head(detail) + (body.trim() ? `\n${body.replace(/^/gm, "    ")}` : "");
  const lines = (count: number): string => `${count} line${count === 1 ? "" : "s"}`;
  switch (name) {
    case "Bash":
    case "PowerShell":
      return withBody(field("description"), field("command"));
    case "Agent":
    case "Task":
      return withBody(field("description"), field("prompt"));
    case "Read": {
      // The CLI's offset is the 1-based first line, so this is not the official +1.
      const offset = numberOf(input.offset);
      const limit = numberOf(input.limit);
      const range = offset === null ? "" : limit === null ? ` (from line ${offset})` : ` (lines ${offset}-${offset + limit - 1})`;
      return head(field("file_path") + range);
    }
    case "Edit": {
      const before = field("old_string").split("\n").length;
      const after = field("new_string").split("\n").length;
      const added = Math.max(0, after - before);
      const removed = Math.max(0, before - after);
      const change = [added ? `added ${lines(added)}` : "", removed ? `removed ${lines(removed)}` : ""].filter(Boolean).join(", ");
      return head(`${field("file_path")} (${change || "modified"})`);
    }
    case "Write":
      return head(`${field("file_path")} (${lines(field("content").split("\n").length)})`);
    case "Grep": {
      const where = [field("path") && `in ${field("path")}`, field("glob") && `glob: ${field("glob")}`, field("type") && `type: ${field("type")}`].filter(Boolean);
      return head(`"${field("pattern")}"${where.length ? ` (${where.join(", ")})` : ""}`);
    }
    case "Glob":
      return head(`pattern: "${field("pattern")}"${field("path") ? ` (in ${field("path")})` : ""}`);
    case "WebFetch":
      return head(field("url"));
    case "WebSearch": {
      const list = (key: string): string => (Array.isArray(input[key]) ? (input[key] as unknown[]).map(String).join(", ") : "");
      const domains = [list("allowed_domains") && `allowed: ${list("allowed_domains")}`, list("blocked_domains") && `blocked: ${list("blocked_domains")}`].filter(Boolean);
      return head(field("query") + (domains.length ? ` (${domains.join(" · ")})` : ""));
    }
    case "Skill":
      return head([field("skill").replace(/^\//, ""), field("args")].filter(Boolean).join(" "));
    default:
      return withBody("", Object.keys(input).length ? JSON.stringify(input, null, 2) : "");
  }
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
        // -p --output-format json reports its errors in stdout's result, leaving stderr empty.
        let result = "";
        try {
          result = stringOf((JSON.parse(stdoutText) as Record<string, unknown>).result);
        } catch {}
        reject(new Error(stderrText.trim() || result.trim() || `Claude exited with code ${exitCode ?? "unknown"}.`));
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