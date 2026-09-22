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
// is a display-only name shown instead of the model id. A model with no entry is on, unaliased.
export interface ModelPref {
  on: boolean;
  alias: string;
}
export type ModelPrefs = Record<string, ModelPref>;

// What the CLI offers on this host, the presets picked from it, when the model list last
// changed, and the last change anyone looked at in the Models pane. `date > seenDate` is the
// update notification.
export interface ModelInfo {
  models: ModelMap;
  presets: Preset[];
  prefs: ModelPrefs;
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
  presets: [
    { enabled: true, model: "claude-opus-5", effort: "high" },
    { enabled: true, model: "claude-fable-5", effort: "xhigh" },
    { enabled: false, model: "sonnet", effort: "high" },
    { enabled: false, model: "haiku", effort: "" },
  ],
  prefs: {},
  date: seedDate,
  seenDate: seedDate,
};

export function readModelInfo(state: vscode.Memento): ModelInfo {
  const info = state.get<ModelInfo>(infoKey) ?? seed;
  // Records written before the Models pane had per-model choices carry no `prefs`.
  return info.prefs ? info : { ...info, prefs: {} };
}

export async function writeModelInfo(state: vscode.Memento, info: ModelInfo): Promise<void> {
  await state.update(infoKey, info);
}

export function sameModels(a: ModelMap, b: ModelMap): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Only the four rows the pane shows, each field forced to a string or boolean.
export function presetsOf(value: unknown): Preset[] {
  const rows = Array.isArray(value) ? value.slice(0, 4) : [];
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

// Only entries for models the CLI still lists, each field forced to a boolean or string.
export function prefsOf(value: unknown, models: ModelMap): ModelPrefs {
  const rows = Object.entries((value ?? {}) as Record<string, unknown>).filter(([model]) => model in models);
  return Object.fromEntries(
    rows.map(([model, pref]) => {
      const record = (pref ?? {}) as Record<string, unknown>;
      return [model, { on: record.on !== false, alias: String(record.alias ?? "") }];
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
