#!/usr/bin/env node
// One-shot: push every quota reading this account has ever recorded into the shared history on
// claude2-stats. Until the lease existed each machine kept its own quota-history.json, so the
// graphs showed gaps wherever that machine's windows were closed; this unions them.
//
//   node backfill-quota.js [--dry] [extra-history.json ...]
//
// Scans this machine's VS Code global storage for quota-history.json and pushes what it finds,
// plus any files named on the command line — that is how the other machines' copies get in:
//   ssh hahnca.com cat .vscode-server/data/User/globalStorage/hahnca.claude2/quota-history.json > /tmp/server-quota.json
//
// Rows are keyed by timestamp and the server merges by that key, so running this twice, or on
// every machine, or after the histories have already been shared, changes nothing.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const host = process.env.CLAUDE2_STATS_HOST || "hahnca.com";
const port = process.env.CLAUDE2_STATS_PORT || 7301;
const extensionId = "hahnca.claude2";
const dry = process.argv.includes("--dry");
const named = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

// Every place a VS Code profile parks global storage on the three machines: Linux desktop,
// the remote/WSL server install, and the Windows side reached through /mnt/c.
function candidates() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".config", "Code", "User", "globalStorage"),
    path.join(home, ".vscode-server", "data", "User", "globalStorage"),
    path.join(home, "AppData", "Roaming", "Code", "User", "globalStorage"),
  ];
  try {
    for (const user of fs.readdirSync("/mnt/c/Users")) {
      roots.push(path.join("/mnt/c/Users", user, "AppData", "Roaming", "Code", "User", "globalStorage"));
    }
  } catch {
    // not a WSL box, or no Windows side mounted: the other roots stand on their own
  }
  return roots.map((root) => path.join(root, extensionId, "quota-history.json"));
}

function rowsOf(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((row) => row && Number.isFinite(row.at)) : [];
  } catch {
    return [];
  }
}

async function main() {
  const merged = new Map();
  for (const file of [...candidates(), ...named]) {
    const rows = rowsOf(file);
    if (rows.length) {
      console.log(`${rows.length} rows  ${file}`);
      for (const row of rows) {
        merged.set(row.at, row);
      }
    }
  }
  const rows = [...merged.values()].sort((left, right) => left.at - right.at);
  if (rows.length === 0) {
    console.log("no history found — nothing to push");
    return;
  }
  const span = `${new Date(rows[0].at).toISOString()} .. ${new Date(rows[rows.length - 1].at).toISOString()}`;
  console.log(`\n${rows.length} distinct readings, ${span}`);
  if (dry) {
    console.log("--dry: not pushed");
    return;
  }
  const response = await fetch(`http://${host}:${port}/quota`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows }),
  });
  console.log(`${response.status} ${await response.text()}`);
}

void main();
