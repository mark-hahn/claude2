import * as vscode from "vscode";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

// Model id -> the effort levels the CLI accepts for it (empty: the model takes no --effort).
export type ModelMap = Record<string, string[]>;

// One row of the Models pane's presets box; the footer's M button steps through the enabled ones.
export interface Preset {
  enabled: boolean;
  model: string;
  effort: string;
}

// Per-model UI choices from the Models pane: `on` false hides the model everywhere, `alias`
// is a display-only name shown instead of the model id, and `effort` is the level the model's
// preset runs at. A model with no entry is on, unaliased.
export interface ModelPref {
  on: boolean;
  alias: string;
  effort: string;
}
export type ModelPrefs = Record<string, ModelPref>;

// What the CLI offers on this host, the presets picked from it, when the model list last
// changed, and the last change anyone looked at in the Models pane. `date > seenDate` is the
// update notification.
export interface ModelInfo {
  models: ModelMap;
  // Model value -> its Anthropic name from the CLI's list (the description up to " · "), e.g.
  // "Sonnet 5"; the Models pane's Descr row.
  names: Record<string, string>;
  presets: Preset[];
  prefs: ModelPrefs;
  // Index into `presets` of the one new sessions start on; see defaultPresetOf.
  defaultPreset: number;
  date: number;
  seenDate: number;
}

// Every window on a host shares one record, and each host type -- windows, wsl, ssh server --
// keeps its own. Keyed by host type because globalState may be stored on the client side.
const infoKey = `modelInfo.${vscode.env.remoteName ?? "local"}`;

// The one-time preload: the list claude 2.1.278 reported on 2026-09-22, stamped as already seen
// so a host whose CLI still says the same raises no notification. The presets are the two the
// footer had hard-wired before.
const allEfforts = ["low", "medium", "high", "xhigh", "max"];
const seedDate = Date.parse("2026-09-22T00:00:00Z");
const seed: ModelInfo = {
  models: { "opus[1m]": allEfforts, "claude-fable-5-1[1m]": allEfforts, sonnet: allEfforts, haiku: [] },
  names: { "opus[1m]": "Opus 5.5 with 1M context", "claude-fable-5-1[1m]": "Fable 5.1", sonnet: "Sonnet 5", haiku: "Haiku 4.5" },
  presets: [
    { enabled: true, model: "claude-opus-5", effort: "high" },
    { enabled: true, model: "claude-fable-5", effort: "xhigh" },
    { enabled: false, model: "sonnet", effort: "high" },
    { enabled: false, model: "haiku", effort: "" },
  ],
  prefs: {},
  defaultPreset: 0,
  date: seedDate,
  seenDate: seedDate,
};

export function readModelInfo(state: vscode.Memento): ModelInfo {
  const info = state.get<ModelInfo>(infoKey) ?? seed;
  // Records written before the Models pane had these fields carry none.
  return { ...info, names: info.names ?? {}, prefs: info.prefs ?? {}, defaultPreset: info.defaultPreset ?? 0 };
}

export async function writeModelInfo(state: vscode.Memento, info: ModelInfo): Promise<void> {
  await state.update(infoKey, info);
}

export function sameModels(a: ModelMap, b: ModelMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Each field forced to a string or boolean.
export function presetsOf(value: unknown): Preset[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return { enabled: record.enabled === true, model: String(record.model ?? ""), effort: String(record.effort ?? "") };
  });
}

// A preset can only stay on while its model is still listed and still enabled; the pane and
// the CLI's list both change under it, so both writers run this.
export function prunePresets(presets: Preset[], prefs: ModelPrefs, models: ModelMap): Preset[] {
  return presets.map((preset) => (preset.model in models && prefs[preset.model]?.on !== false ? preset : { ...preset, enabled: false }));
}

// The preset new sessions start on: the chosen one while it is on, else none -- a new session
// then starts with a blank model, and nothing runs until one is picked.
export function defaultPresetOf(info: ModelInfo): Preset | undefined {
  const chosen = info.presets[info.defaultPreset];
  return chosen?.enabled ? chosen : undefined;
}

// ponytail: the CLI's model list carries no prices, so cheapness is ranked by family name;
// a new family lands here or it is never picked.
const cheapestFirst = ["haiku", "sonnet", "opus", "fable"];

// The cheapest model the CLI lists, for background calls (titles, the quota probe) that need
// no more. Nothing matching is an error, not a fallback.
export function cheapestModel(models: ModelMap): string {
  for (const family of cheapestFirst) {
    const model = Object.keys(models).find((id) => id.includes(family));
    if (model) {
      return model;
    }
  }
  throw new Error(`no known model family in the CLI's list (${Object.keys(models).join(", ")}).`);
}

// Only entries for models the CLI still lists, each field forced to a boolean or string.
export function prefsOf(value: unknown, models: ModelMap): ModelPrefs {
  const rows = Object.entries((value ?? {}) as Record<string, unknown>).filter(([model]) => model in models);
  return Object.fromEntries(
    rows.map(([model, pref]) => {
      const record = (pref ?? {}) as Record<string, unknown>;
      return [model, { on: record.on !== false, alias: String(record.alias ?? ""), effort: String(record.effort ?? "") }];
    }),
  );
}

const lockFile = path.join(os.tmpdir(), "claude2-update.lock");
// Longer than `claude update`'s own timeout: a lock this old was left by a window that died.
const staleMs = 200000;

// One `claude update` per host at a time. A window that finds the lock held waits it out and
// skips its own update -- the holder's covers this host.
export async function withUpdateLock(run: () => Promise<void>): Promise<void> {
  const held = await fs.open(lockFile, "wx").then(
    async (handle) => (await handle.close(), true),
    () => false,
  );
  if (held) {
    try {
      await run();
    } finally {
      await fs.rm(lockFile, { force: true });
    }
    return;
  }
  for (;;) {
    const stat = await fs.stat(lockFile).catch(() => null);
    if (!stat) {
      return;
    }
    if (Date.now() - stat.mtimeMs > staleMs) {
      // ponytail: stale-lock removal can race a window that just took a fresh lock; worst case two updates overlap once
      await fs.rm(lockFile, { force: true });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
