import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { transcriptPath } from "./claudeCli";

// One row of the Ctx popup: a source of tokens and what it came to in the last prompt and over
// the whole conversation. depth nests a row under the one above it (a tool's files under the tool).
export interface ContextRow {
  label: string;
  depth: number;
  lastIn: number;
  lastOut: number;
  allIn: number;
  allOut: number;
}

export interface ContextTable {
  // The last row is the total.
  rows: ContextRow[];
  calls: { last: number; all: number };
  // What the CLI counts in the context right now; null when it has not been asked or did not answer.
  contextNow: { used: number; max: number } | null;
  // The system prompt and tool rows are the CLI's own counts, not sizes guessed from the transcript.
  measured: boolean;
}

interface Node {
  lastIn: number;
  lastOut: number;
  allIn: number;
  allOut: number;
  children: Map<string, Node>;
}

// A piece of the conversation that rides along in every later API call until a compaction drops
// it. weight is its size in tokens: exact for Claude's output, and for what arrives between two
// calls, a share of how much the second call's input grew. Each call shares out its messages
// total by weight, so the small drift left over still adds up to the call's real input.
interface Item {
  path: string[];
  weight: number;
}

interface Call {
  id: string;
  output: number;
  thinking: number;
  inLast: boolean;
  blocks: { path: string[]; chars: number }[];
}

// Top-level rows, in the order the popup shows them. Rows that come to nothing are left out.
const TOP_ROWS = ["System prompt", "Built-in tools", "MCP tools", "Memory files", "Skills list", "Reminders & hooks", "Your prompts", "Claude's text", "Thinking", "Tools", "Subagents", "Compaction summary", "Other messages"];
const ATTACHMENT_LABELS: Record<string, string> = {
  hook_success: "hook output",
  hook_additional_context: "hook output",
  deferred_tools_delta: "deferred tool list",
  mcp_instructions_delta: "MCP server instructions",
  agent_listing_delta: "agent list",
  total_tokens_reminder: "token count reminders",
  edited_text_file: "edited file notices",
};
// A picture's cost doesn't follow its base64 length; this is about what a screenshot takes.
const IMAGE_TOKENS = 1600;
const CHILD_ROWS = 12;

// Tokens by source for the Ctx popup. Every number rests on the usage the API reported for each
// call, which the CLI's transcript keeps: the totals are exact, and they are what the session's
// stats add up. Splitting a call's input by source is an estimate: the parts outside the messages
// (system prompt, tools) come from `usage`, the CLI's get_context_usage answer, when there is one,
// and the messages total is shared out by text size. Null when the session has no transcript.
export async function contextTable(workspacePath: string, sessionId: string, usage: Record<string, unknown> | null): Promise<ContextTable | null> {
  const file = transcriptPath(workspacePath, sessionId);
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const entries = text.split("\n").map(parseLine).filter((entry): entry is Record<string, unknown> => entry !== undefined);
  if (!entries.length) {
    return null;
  }
  const measuredFixed = usage ? fixedFromUsage(usage) : null;
  const fixed = measuredFixed ?? fixedFromShape(entries);
  const fixedTotal = fixed.reduce((sum, [, size]) => sum + size, 0);

  const root: Node = node();
  for (const label of TOP_ROWS) {
    root.children.set(label, node());
  }
  const add = (route: string[], inLast: boolean, input: number, output: number): void => {
    let at = root;
    for (const label of route) {
      at = at.children.get(label) ?? at.children.set(label, node()).get(label)!;
      at.allIn += input;
      at.allOut += output;
      if (inLast) {
        at.lastIn += input;
        at.lastOut += output;
      }
    }
  };

  let lastPrompt = 0;
  entries.forEach((entry, index) => {
    if (isPrompt(entry)) {
      lastPrompt = index;
    }
  });
  const present: Item[] = [];
  // What arrived since the last call started, still weighed by length alone.
  const fresh: Item[] = [];
  const arrive = (item: Item): void => {
    present.push(item);
    fresh.push(item);
  };
  // Tool call id -> the row its result lands on.
  const toolRows = new Map<string, string[]>();
  const lastToolUses = new Set<string>();
  const seen = new Set<string>();
  const seenSidechain = new Set<string>();
  const calls = { last: 0, all: 0 };
  let open: Call | null = null;

  // A call's output is only whole once its last line is in, so it is shared out when the next
  // call starts (or the transcript ends), and then joins what every later call carries.
  const settle = (call: Call | null): void => {
    if (!call) {
      return;
    }
    const pool = call.blocks.filter((block) => call.thinking === 0 || block.path[0] !== "Thinking");
    const chars = pool.reduce((sum, block) => sum + block.chars, 0);
    const rest = Math.max(0, call.output - call.thinking);
    if (call.thinking > 0) {
      add(["Thinking"], call.inLast, 0, call.thinking);
      present.push({ path: ["Thinking"], weight: call.thinking });
    }
    if (chars > 0) {
      for (const block of pool) {
        const share = (rest * block.chars) / chars;
        add(block.path, call.inLast, 0, share);
        present.push({ path: block.path, weight: share });
      }
    } else if (rest > 0) {
      add(["Claude's text"], call.inLast, 0, rest);
      present.push({ path: ["Claude's text"], weight: rest });
    }
  };

  entries.forEach((entry, index) => {
    const inLast = index >= lastPrompt;
    const type = stringOf(entry.type);
    const message = recordOf(entry.message);
    const content = message?.content;
    if (type === "assistant") {
      const id = stringOf(message?.id);
      const callUsage = recordOf(message?.usage);
      if (!id || !callUsage || stringOf(message?.model) === "<synthetic>") {
        return;
      }
      // Older transcripts keep subagent traffic inline, marked as a side chain.
      if (entry.isSidechain === true) {
        if (!seenSidechain.has(id)) {
          seenSidechain.add(id);
          add(["Subagents", "subagent"], inLast, inputOf(callUsage), numberOf(callUsage.output_tokens));
        }
        return;
      }
      if (open?.id !== id) {
        // A streamed reply writes one line per block, all carrying the same usage.
        if (seen.has(id)) {
          return;
        }
        seen.add(id);
        settle(open);
        open = { id, output: 0, thinking: 0, inLast, blocks: [] };
        calls.all += 1;
        calls.last += inLast ? 1 : 0;
        const input = inputOf(callUsage);
        // Estimates can overshoot a small call; the parts outside the messages never exceed it.
        const scale = fixedTotal > input ? input / fixedTotal : 1;
        for (const [label, size] of fixed) {
          add([label], inLast, size * scale, 0);
        }
        const budget = input - fixedTotal * scale;
        // Whatever this input holds beyond what the last call carried and wrote is what arrived
        // since, and that measured amount is shared out among the new pieces by length.
        const freshWeight = fresh.reduce((sum, item) => sum + item.weight, 0);
        const grew = budget - (present.reduce((sum, item) => sum + item.weight, 0) - freshWeight);
        if (freshWeight > 0 && grew > 0) {
          for (const item of fresh) {
            item.weight *= grew / freshWeight;
          }
        }
        fresh.length = 0;
        const weight = present.reduce((sum, item) => sum + item.weight, 0);
        if (weight > 0) {
          for (const item of present) {
            add(item.path, inLast, (budget * item.weight) / weight, 0);
          }
        } else {
          add(["Other messages"], inLast, budget, 0);
        }
      }
      const call: Call = open!;
      call.output = Math.max(call.output, numberOf(callUsage.output_tokens));
      call.thinking = Math.max(call.thinking, numberOf(recordOf(callUsage.output_tokens_details)?.thinking_tokens));
      for (const value of Array.isArray(content) ? content : []) {
        const block = recordOf(value);
        const blockType = stringOf(block?.type);
        if (!block) {
          continue;
        }
        if (blockType === "thinking" || blockType === "redacted_thinking") {
          call.blocks.push({ path: ["Thinking"], chars: stringOf(block.thinking).length + stringOf(block.data).length });
        } else if (blockType === "text") {
          call.blocks.push({ path: ["Claude's text"], chars: stringOf(block.text).length });
        } else if (blockType === "tool_use" || blockType === "server_tool_use") {
          const input = recordOf(block.input);
          const route = toolRoute(stringOf(block.name) || "tool", input, workspacePath);
          toolRows.set(stringOf(block.id), route);
          if (inLast) {
            lastToolUses.add(stringOf(block.id));
          }
          call.blocks.push({ path: route, chars: JSON.stringify(input ?? {}).length });
        } else {
          // A server tool's result (the advisor's answer) is written into the reply, but it is
          // the API's text, not Claude's output: it only weighs in on later calls.
          arrive({ path: ["Tools", blockType.includes("advisor") ? "advisor" : blockType], weight: weightOf(block) });
        }
      }
      return;
    }
    if (entry.isSidechain === true) {
      return;
    }
    if (type === "user") {
      // A tool can add a message of its own beside its result: the Skill tool's is the skill itself.
      const fromTool = toolRows.get(stringOf(entry.sourceToolUseID));
      if (isPrompt(entry)) {
        arrive({ path: ["Your prompts"], weight: weightOf(content) });
      } else if (entry.isCompactSummary === true) {
        arrive({ path: ["Compaction summary"], weight: weightOf(content) });
      } else if (Array.isArray(content)) {
        for (const value of content) {
          const block = recordOf(value);
          if (stringOf(block?.type) === "tool_result") {
            arrive({ path: toolRows.get(stringOf(block?.tool_use_id)) ?? ["Tools", "unknown"], weight: weightOf(block?.content) });
          } else {
            arrive({ path: fromTool ?? ["Other messages"], weight: weightOf(block) });
          }
        }
      } else {
        arrive({ path: fromTool ?? ["Other messages"], weight: weightOf(content) });
      }
    } else if (type === "attachment") {
      const attachment = recordOf(entry.attachment);
      const kind = stringOf(attachment?.type);
      const weight = Array.isArray(entry.rendered) ? entry.rendered.reduce((sum: number, part) => sum + weightOf(recordOf(part)?.content), 0) : 0;
      const files = Array.isArray(attachment?.files) ? attachment.files.map(recordOf).filter((one): one is Record<string, unknown> => one !== undefined) : [];
      const fileChars = files.reduce((sum, one) => sum + stringOf(one.content).length, 0);
      if (weight <= 0) {
        // Bookkeeping the CLI keeps for itself; nothing of it is sent.
      } else if (kind === "instructions" && fileChars > 0) {
        for (const one of files) {
          arrive({ path: ["Memory files", shownPath(stringOf(one.path), workspacePath)], weight: (weight * stringOf(one.content).length) / fileChars });
        }
      } else if (kind === "skill_listing") {
        arrive({ path: ["Skills list"], weight });
      } else {
        arrive({ path: ["Reminders & hooks", ATTACHMENT_LABELS[kind] ?? kind.replace(/_/g, " ")], weight });
      }
    } else if (type === "system" && stringOf(entry.subtype) === "compact_boundary") {
      // The summary that follows stands in for everything before it.
      settle(open);
      open = null;
      present.length = 0;
      fresh.length = 0;
    }
  });
  settle(open);
  await addSubagents(path.join(path.dirname(file), sessionId, "subagents"), lastToolUses, add);

  const rows: ContextRow[] = [];
  const total: ContextRow = { label: "Total", depth: 0, lastIn: 0, lastOut: 0, allIn: 0, allOut: 0 };
  for (const [label, top] of root.children) {
    total.lastIn += top.lastIn;
    total.lastOut += top.lastOut;
    total.allIn += top.allIn;
    total.allOut += top.allOut;
    flatten(label, top, 0, rows);
  }
  rows.push(rounded(total));
  const used = numberOf(usage?.totalTokens);
  const max = numberOf(usage?.maxTokens);
  return { rows, calls, contextNow: used > 0 && max > 0 ? { used, max } : null, measured: measuredFixed !== null };
}

// The CLI's counts for what every request carries outside its messages. Memory files, skills
// and MCP instructions are left to the transcript, which holds them as messages.
function fixedFromUsage(usage: Record<string, unknown>): [string, number][] | null {
  const categories = Array.isArray(usage.categories) ? usage.categories.map(recordOf) : [];
  const size = (id: string): number => numberOf(categories.find((category) => stringOf(category?.id) === id)?.tokens);
  const fixed: [string, number][] = [["System prompt", size("system_prompt")], ["Built-in tools", size("system_tools")], ["MCP tools", size("mcp_tools")]];
  return fixed.some(([, tokens]) => tokens > 0) ? fixed : null;
}

// Without the CLI's counts, the newest request shape in the transcript gives the same parts by length.
function fixedFromShape(entries: Record<string, unknown>[]): [string, number][] {
  let shape: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (stringOf(entry.type) === "api-request-shape") {
      shape = recordOf(entry.shape) ?? shape;
    }
  }
  const tools = Array.isArray(shape?.tools) ? shape.tools.map(recordOf) : [];
  const toolWeight = (mcp: boolean): number => tools.filter((tool) => stringOf(tool?.name).startsWith("mcp__") === mcp).reduce((sum, tool) => sum + JSON.stringify(tool).length / 4, 0);
  return [["System prompt", weightOf(shape?.system)], ["Built-in tools", toolWeight(false)], ["MCP tools", toolWeight(true)]];
}

// Each subagent is a conversation of its own, in a file of its own beside the session's; its
// meta file names the agent type and the tool call that started it.
async function addSubagents(dir: string, lastToolUses: Set<string>, add: (route: string[], inLast: boolean, input: number, output: number) => void): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((one) => one.endsWith(".jsonl"))) {
    const meta = recordOf(parseLine(await fs.readFile(path.join(dir, name.replace(/\.jsonl$/, ".meta.json")), "utf8").catch(() => "")));
    const route = ["Subagents", stringOf(meta?.agentType) || "agent"];
    const inLast = lastToolUses.has(stringOf(meta?.toolUseId));
    const seen = new Set<string>();
    for (const line of (await fs.readFile(path.join(dir, name), "utf8").catch(() => "")).split("\n")) {
      const message = recordOf(parseLine(line)?.message);
      const callUsage = recordOf(message?.usage);
      const id = stringOf(message?.id);
      if (callUsage && id && !seen.has(id) && stringOf(message?.model) !== "<synthetic>") {
        seen.add(id);
        add(route, inLast, inputOf(callUsage), numberOf(callUsage.output_tokens));
      }
    }
  }
}

// A Read is about the file it read, and a Skill call about the skill it loaded, so each of
// those gets a row under the tool.
function toolRoute(name: string, input: Record<string, unknown> | undefined, workspacePath: string): string[] {
  const file = stringOf(input?.file_path);
  if (name === "Read" && file) {
    return ["Tools", "Read", shownPath(file, workspacePath)];
  }
  return name === "Skill" && stringOf(input?.skill) ? ["Tools", "Skill", stringOf(input?.skill)] : ["Tools", name];
}

function flatten(label: string, at: Node, depth: number, rows: ContextRow[]): void {
  const row = rounded({ label, depth, lastIn: at.lastIn, lastOut: at.lastOut, allIn: at.allIn, allOut: at.allOut });
  if (!row.lastIn && !row.lastOut && !row.allIn && !row.allOut) {
    return;
  }
  rows.push(row);
  const children = [...at.children].sort(([, left], [, right]) => right.allIn + right.allOut - (left.allIn + left.allOut));
  // One row of "1 more" would only stand where that row could.
  const shown = children.length > CHILD_ROWS + 1 ? CHILD_ROWS : children.length;
  for (const [childLabel, child] of children.slice(0, shown)) {
    flatten(childLabel, child, depth + 1, rows);
  }
  if (children.length > shown) {
    const rest = children.slice(CHILD_ROWS).reduce((sum, [, child]) => {
      sum.lastIn += child.lastIn;
      sum.lastOut += child.lastOut;
      sum.allIn += child.allIn;
      sum.allOut += child.allOut;
      return sum;
    }, node());
    flatten(`${children.length - shown} more`, rest, depth + 1, rows);
  }
}

function rounded(row: ContextRow): ContextRow {
  return { ...row, lastIn: Math.round(row.lastIn), lastOut: Math.round(row.lastOut), allIn: Math.round(row.allIn), allOut: Math.round(row.allOut) };
}

function node(): Node {
  return { lastIn: 0, lastOut: 0, allIn: 0, allOut: 0, children: new Map() };
}

// A prompt the user sent, as opposed to the tool results and notices that are user entries too.
function isPrompt(entry: Record<string, unknown>): boolean {
  return stringOf(entry.type) === "user" && entry.isSidechain !== true && !!entry.promptSource;
}

// The whole of a call's input: the uncached part plus what was read from and written to the cache.
function inputOf(usage: Record<string, unknown>): number {
  return numberOf(usage.input_tokens) + numberOf(usage.cache_read_input_tokens) + numberOf(usage.cache_creation_input_tokens);
}

// Rough tokens in a piece of message content: four characters to a token, a flat rate per picture.
function weightOf(value: unknown): number {
  if (typeof value === "string") {
    return value.length / 4;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum: number, part) => sum + weightOf(part), 0);
  }
  const block = recordOf(value);
  if (!block) {
    return 0;
  }
  if (stringOf(block.type) === "image") {
    return IMAGE_TOKENS;
  }
  if (typeof block.text === "string") {
    return block.text.length / 4;
  }
  return block.content !== undefined ? weightOf(block.content) : JSON.stringify(block).length / 4;
}

// Workspace files by their relative path, the rest from ~; a long path keeps its last two parts.
function shownPath(file: string, workspacePath: string): string {
  const relative = path.relative(workspacePath, file);
  const home = os.homedir();
  const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
  return shown.length > 50 ? `…/${shown.split(/[\\/]/).slice(-2).join("/")}` : shown;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    return recordOf(JSON.parse(line));
  } catch {
    // A line cut off mid-write by a running session.
    return undefined;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
