#!/usr/bin/env node
// One-time backfill: reads every workspace's claude2 extension state out of VS Code's
// client-side storage and pushes an install record per workspace to the claude2-stats server.
// VS Code keeps extension mementos on the client machine even for remote workspaces, so the
// Windows-side workspaceStorage seen from WSL covers the windows, wsl, and server hosts alike.
// Safe to re-run: the server merges counters with max(), so a replay changes nothing.
//
//   node backfill.js [workspaceStorageDir] [serverBase]
//
// Needs node >= 22.5 for node:sqlite. Run from WSL:
//   node backfill.js /mnt/c/Users/mark/AppData/Roaming/Code/User/workspaceStorage http://hahnca.com:7301

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const storageRoot = process.argv[2] || "/mnt/c/Users/mark/AppData/Roaming/Code/User/workspaceStorage";
const serverBase = process.argv[3] || "http://hahnca.com:7301";

// host + key derivation must match src/pluginStats.ts, where the live records come from.
function hostOf(folderUri) {
  if (folderUri.startsWith("file:")) return "windows";
  if (folderUri.includes("wsl")) return "wsl";
  return "server";
}

function pathOf(folderUri) {
  const decoded = decodeURIComponent(folderUri);
  if (decoded.startsWith("file:///")) return decoded.slice(8);
  return decoded.replace(/^vscode-remote:\/\/[^/]+/, "");
}

const sanitize = (text) => text.replace(/[^A-Za-z0-9._-]+/g, "-");

function recordOf(folderUri, value) {
  const sessions = value["claude2.sessions.v1"] || [];
  const tally = value["pony.tally"] || {};
  const record = {
    host: hostOf(folderUri),
    project: sanitize(path.basename(pathOf(folderUri))),
    path: pathOf(folderUri),
    sessions: 0, turns: 0, wallMs: 0, costUsd: 0, tokensIn: 0, tokensOut: 0,
    ponySkips: 0, graftCalls: 0, graftTokensSaved: 0, graftUsdSaved: 0,
  };
  for (const session of sessions) {
    const turns = Array.isArray(session.turns) ? session.turns : [];
    if (!turns.length) continue;
    record.sessions += 1;
    for (const turn of turns) {
      record.turns += 1;
      record.wallMs += turn.durationMs || (turn.completedAt ? Math.max(0, turn.completedAt - turn.createdAt) : 0);
      record.costUsd += turn.costUsd || 0;
      record.tokensIn += turn.tokensIn || 0;
      record.tokensOut += turn.tokensOut || 0;
      record.ponySkips += (turn.ponySkips || []).length;
      // the short-lived graft stat era stored tokens saved on the raw turn
      record.graftTokensSaved += turn.graftSaved || 0;
    }
  }
  record.sessions = Math.max(record.sessions, Number(tally.sessions) || 0);
  record.turns = Math.max(record.turns, Number(tally.turns) || 0);
  return record;
}

async function main() {
  const records = new Map();
  for (const dir of fs.readdirSync(storageRoot)) {
    const dbPath = path.join(storageRoot, dir, "state.vscdb");
    const wsPath = path.join(storageRoot, dir, "workspace.json");
    if (!fs.existsSync(dbPath) || !fs.existsSync(wsPath)) continue;
    const folderUri = JSON.parse(fs.readFileSync(wsPath, "utf8")).folder;
    if (!folderUri) continue;
    // copy first: VS Code holds the live db open
    const tmp = path.join(os.tmpdir(), `c2backfill-${dir}.vscdb`);
    let row;
    try {
      fs.copyFileSync(dbPath, tmp);
      const db = new DatabaseSync(tmp, { readOnly: true });
      row = db.prepare("select value from ItemTable where key='hahnca.claude2'").get();
      db.close();
    } catch (error) {
      console.log(`skip ${dir}: ${error.message}`);
      continue;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (!row) continue;
    const record = recordOf(folderUri, JSON.parse(row.value));
    if (record.turns === 0) continue;
    const key = sanitize(`${record.host}__${record.path}`).toLowerCase();
    // duplicate storage dirs (profiles) mirror the same workspace: keep the bigger reading
    const known = records.get(key);
    if (!known || record.turns > known.turns) records.set(key, record);
  }
  for (const [key, record] of records) {
    const response = await fetch(`${serverBase}/install/${key}`, { method: "POST", body: JSON.stringify(record) });
    console.log(`${response.ok ? "pushed" : "FAILED"} ${key}: ${record.sessions} sessions, ${record.turns} turns, $${record.costUsd.toFixed(2)}`);
  }
  console.log(`${records.size} installs backfilled to ${serverBase}`);
}

void main();
