import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { httpJson } from "./pluginStats";

// The Settings pane's "Git changes check": before a new session's first prompt, ask whether the
// prompt continues the work already sitting uncommitted, so unrelated work can be committed
// first. The verdict is one Opus 5.5 call on the API at low effort in fast mode -- about 0.8s,
// and right on 19 of 20 real commits of this repo in testing. Every failure lets the prompt
// through: the check is a reminder, never a gate.

const checkModel = "claude-opus-5-5";
// $ per million tokens, input then output. Fast mode bills double.
const prices = { standard: [4, 20], fast: [8, 40] } as const;
// About 3.5k tokens of diff: enough to tell what the work is, cheap enough to send every time.
const changesBudget = 12000;
// Human scratch notes are never sent anywhere.
const excludes = [".", ":(glob,exclude)**/scratch.md", ":(glob,exclude)**/*.scratch.md"];
// Word for word what was tested; a rewording would need the 20 cases run again.
const system = "You decide whether a new coding request continues the work in a git working tree's uncommitted changes. Reply with exactly one word: related or unrelated.";

export interface UncommittedChanges {
  // For the warning: "3 changed files, 1 new file".
  summary: string;
  // For the models: diff stat, new-file names and heads, then the diff, cut to the budget.
  text: string;
  // When the last commit landed; prompts sent since then made these changes. 0 with no commits.
  lastCommitMs: number;
}

export interface CheckResult {
  related: boolean;
  costUsd: number;
  ms: number;
  speed: string;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

// What a commit right now would take. Null when the workspace is not in a repo or nothing waits.
export async function uncommittedChanges(cwd: string): Promise<UncommittedChanges | null> {
  let status: string;
  try {
    status = await git(cwd, ["status", "--porcelain", "--", ...excludes]);
  } catch {
    return null;
  }
  const lines = status.split("\n").filter(Boolean);
  if (!lines.length) {
    return null;
  }
  const lastCommit = (await git(cwd, ["log", "-1", "--format=%ct"]).catch(() => "")).trim();
  // A repo with no commits yet has no HEAD to diff against; the plain diff is all there is.
  const base = lastCommit ? ["HEAD"] : [];
  const [stat, diff, others] = await Promise.all([
    git(cwd, ["diff", ...base, "--stat", "--", ...excludes]).catch(() => ""),
    git(cwd, ["diff", ...base, "--", ...excludes]).catch(() => ""),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...excludes]).catch(() => ""),
  ]);
  const newFiles = others.split("\n").filter(Boolean);
  let text = stat + (newFiles.length ? `\nNew files:\n${newFiles.slice(0, 50).join("\n")}\n` : "") + `\n${diff}`;
  // A new file shows in no diff, and is often the heart of the work, so its head goes along.
  for (const file of newFiles.slice(0, 10)) {
    if (text.length >= changesBudget) {
      break;
    }
    const full = path.join(cwd, file);
    const size = (await fs.stat(full).catch(() => null))?.size ?? 0;
    const body = size && size < 200_000 ? await fs.readFile(full, "utf8").catch(() => "") : "";
    if (body && !body.includes("\0")) {
      text += `\n--- new file ${file}\n${body.slice(0, 2000)}`;
    }
  }
  const added = lines.filter((line) => line.startsWith("??")).length;
  const changed = lines.length - added;
  return {
    summary: [changed ? plural(changed, "changed file") : "", added ? plural(added, "new file") : ""].filter(Boolean).join(", "),
    text: text.slice(0, changesBudget),
    lastCommitMs: Number(lastCommit) * 1000 || 0,
  };
}

// The changes and the prompts that made them, as both the verdict and the description read them.
export function changesMessage(changes: string, earlier: string[]): string {
  return `Uncommitted changes:\n${changes}\n\n${earlier.length ? `Prompts that made those changes:\n${earlier.map((prompt) => `- ${prompt}`).join("\n")}\n\n` : ""}`;
}

export async function checkPrompt(options: { apiKey: string; workspaceId: string; changes: string; earlier: string[]; prompt: string; timeoutMs: number }): Promise<CheckResult> {
  // The key is not scoped to a workspace, so each request names one.
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: options.timeoutMs,
    defaultHeaders: options.workspaceId ? { "anthropic-workspace-id": options.workspaceId } : undefined,
  });
  const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
    model: checkModel,
    max_tokens: 2000,
    system,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: `${changesMessage(options.changes, options.earlier)}New prompt:\n${options.prompt}\n\nIs the new prompt related to the uncommitted changes?` }],
  };
  const start = Date.now();
  let response: Anthropic.Beta.Messages.BetaMessage;
  try {
    response = await client.beta.messages.create({ ...params, speed: "fast", betas: ["fast-mode-2026-02-01"] });
  } catch (error) {
    // Fast mode has a rate limit of its own; when it is hit, standard speed answers instead.
    if (!(error instanceof Anthropic.RateLimitError)) {
      throw error;
    }
    response = await client.beta.messages.create(params);
  }
  if (response.stop_reason !== "end_turn") {
    throw new Error(`the check stopped with ${response.stop_reason}`);
  }
  const answer = response.content.map((block) => (block.type === "text" ? block.text : "")).join("").toLowerCase().replace(/[^a-z]/g, "");
  if (answer !== "related" && answer !== "unrelated") {
    throw new Error(`the check answered ${JSON.stringify(answer.slice(0, 40))}`);
  }
  const speed = response.usage.speed === "fast" ? "fast" : "standard";
  const [inPrice, outPrice] = prices[speed];
  const usage = response.usage;
  const inTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  return {
    related: answer === "related",
    costUsd: (inTokens * inPrice + usage.output_tokens * outPrice) / 1e6,
    ms: Date.now() - start,
    speed,
  };
}

// Adds one check's cost to the month's total on the stats server, so every window on every
// host counts into the one figure. Null when the server can't be reached.
export async function recordCheckCost(timezone: string, usd: number, log: (line: string) => void): Promise<{ usd: number; count: number } | null> {
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(new Date());
  const reply = await httpJson("POST", "/checks", { month, usd }, 3000, log);
  return reply && typeof reply.usd === "number" && typeof reply.count === "number" ? { usd: reply.usd, count: reply.count } : null;
}
