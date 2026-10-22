import * as vscode from "vscode";
import { httpJson } from "./pluginStats";

// Everything the Settings pane sets. One copy lives on the stats server (hahnca.com), so a save
// from any window on any host type -- windows, wsl, ssh -- reaches every other window at its
// next prompt. The globalState copy only covers a window that opens while the server is down.

export interface Settings {
  maxTurns: number;
  contextWindowTokens: number;
  maxBudgetUsd: number;
  permissionMode: string;
  timezone: string;
  // Tool lines in the official extension's fuller form: header detail plus the call's input.
  longToolDisplay: boolean;
  // Passed to each run's --settings, the only way a -p run gets fast mode. Opus only; bills usage credits.
  fastMode: boolean;
  // After each turn the CLI's guess at the next prompt replaces the prompt box. Costs a little plan usage per turn.
  promptSuggestions: boolean;
  // Before a new session's first prompt, warn when it looks unrelated to the uncommitted changes.
  // The verdict is an Opus fast-mode API call billed to claudeApiKey's account.
  gitChangesCheck: boolean;
  // Anthropic API key for one-shot API calls outside the subscription. Lives here so every host
  // type reads the one copy on the stats server; never put it in the environment, where it would
  // move terminal claude runs off the subscription. The real values are never in the repo; empty
  // means no key. The key is not scoped to a workspace, so each request also names this one.
  claudeApiKey: string;
  claudeWorkspaceId: string;
}

export const permissionModes = ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];
const defaults: Settings = { maxTurns: 50, contextWindowTokens: 0, maxBudgetUsd: 0, permissionMode: "auto", timezone: "America/Los_Angeles", longToolDisplay: false, fastMode: false, promptSuggestions: false, gitChangesCheck: false, claudeApiKey: "", claudeWorkspaceId: "" };
const settingsKey = "settings";

// Throws on the first bad field, worded for the Settings pane's note.
export function checkSettings(value: unknown): Settings {
  const record = { ...defaults, ...(typeof value === "object" && value !== null ? value : {}) } as Record<string, unknown>;
  const whole = (key: string, label: string, min: number, max: number): number => {
    const number = Number(record[key]);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    }
    return number;
  };
  const maxBudgetUsd = Number(record.maxBudgetUsd);
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0) {
    throw new Error("Max budget per prompt must be 0 or more.");
  }
  const permissionMode = String(record.permissionMode);
  if (!permissionModes.includes(permissionMode)) {
    throw new Error(`Permission mode must be one of ${permissionModes.join(", ")}.`);
  }
  const timezone = String(record.timezone);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`"${timezone}" is not an IANA timezone.`);
  }
  // A pasted key often carries a trailing newline; anything else that can't go in a header is a typo.
  const claudeApiKey = String(record.claudeApiKey).trim();
  if (claudeApiKey && !/^sk-ant-[\x21-\x7e]+$/.test(claudeApiKey)) {
    throw new Error("The API key must be empty or start with sk-ant- and have no spaces.");
  }
  const claudeWorkspaceId = String(record.claudeWorkspaceId).trim();
  if (claudeWorkspaceId && !/^wrkspc_[A-Za-z0-9]+$/.test(claudeWorkspaceId)) {
    throw new Error("The workspace ID must be empty or start with wrkspc_.");
  }
  return {
    maxTurns: whole("maxTurns", "The turn limit", 50, 250),
    // The CLI's auto-compact window takes 100k-1M; 0 uses each model's own window.
    contextWindowTokens: Number(record.contextWindowTokens) === 0 ? 0 : whole("contextWindowTokens", "Max context tokens (or 0)", 100000, 1000000),
    maxBudgetUsd,
    permissionMode,
    timezone,
    longToolDisplay: record.longToolDisplay === true,
    fastMode: record.fastMode === true,
    promptSuggestions: record.promptSuggestions === true,
    gitChangesCheck: record.gitChangesCheck === true,
    claudeApiKey,
    claudeWorkspaceId,
  };
}

export function cachedSettings(state: vscode.Memento): Settings {
  try {
    return checkSettings(state.get(settingsKey));
  } catch {
    return defaults;
  }
}

export async function fetchSettings(state: vscode.Memento, log: (line: string) => void): Promise<Settings> {
  const reply = await httpJson("GET", "/settings", undefined, 5000, log);
  if (reply === null) {
    return cachedSettings(state);
  }
  try {
    const settings = checkSettings(reply);
    await state.update(settingsKey, settings);
    return settings;
  } catch (error) {
    log(`settings: the server's copy is bad (${error instanceof Error ? error.message : String(error)}); using this host's last good copy.`);
    return cachedSettings(state);
  }
}

export async function saveSettings(state: vscode.Memento, settings: Settings, log: (line: string) => void): Promise<void> {
  if (await httpJson("POST", "/settings", settings, 5000, log) === null) {
    throw new Error("The stats server on hahnca.com could not be reached, so nothing was saved.");
  }
  await state.update(settingsKey, settings);
}
