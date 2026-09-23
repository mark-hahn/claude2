import * as vscode from "vscode";
import { httpJson } from "./pluginStats";
import { CLAUDE2_CONTEXT_WINDOW } from "./types";

// Everything the Settings pane sets. One copy lives on the stats server (hahnca.com), so a save
// from any window on any host type -- windows, wsl, ssh -- reaches every other window at its
// next reload. The globalState copy only covers a window that opens while the server is down.

export interface Settings {
  maxTurns: number;
  contextWindowTokens: number;
  maxBudgetUsd: number;
  permissionMode: string;
  timezone: string;
}

export const permissionModes = ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"];
const defaults: Settings = { maxTurns: 50, contextWindowTokens: CLAUDE2_CONTEXT_WINDOW, maxBudgetUsd: 0, permissionMode: "auto", timezone: "America/Los_Angeles" };
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
  return {
    maxTurns: whole("maxTurns", "The turn limit", 50, 250),
    // The CLI's auto-compact window takes 100k-1M.
    contextWindowTokens: whole("contextWindowTokens", "Max context tokens", 100000, 1000000),
    maxBudgetUsd,
    permissionMode,
    timezone,
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
