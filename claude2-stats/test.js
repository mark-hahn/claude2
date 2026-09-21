#!/usr/bin/env node
// Smallest check that fails if the server logic breaks: boot on an ephemeral port with a
// scratch data dir, push an install twice (second push lower — max must hold), toggle a flag,
// read it all back.
const { spawn } = require("node:child_process");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2stats-"));
const child = spawn("node", [path.join(__dirname, "server.js")], {
  env: { ...process.env, PORT: "0", CLAUDE2_STATS_DIR: dir },
  stdio: ["ignore", "pipe", "inherit"],
});

child.stdout.setEncoding("utf8");
child.stdout.once("data", (line) => {
  const port = Number(/listening on (\d+)/.exec(line)[1]);
  void run(`http://127.0.0.1:${port}`).then(
    () => { console.log("claude2-stats test ok"); cleanup(0); },
    (error) => { console.error(error); cleanup(1); },
  );
});

function cleanup(code) {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

async function run(base) {
  const post = (p, body) => fetch(base + p, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
  const get = (p) => fetch(base + p).then((r) => r.json());

  await post("/install/wsl__-root-apps-claude2", { host: "wsl", project: "claude2", path: "/root/apps/claude2", sessions: 5, turns: 40, costUsd: 12.5, ponyCeilings: 3, srcLines: 5000 });
  await post("/install/wsl__-root-apps-claude2", { host: "wsl", project: "claude2", path: "/root/apps/claude2", sessions: 3, turns: 41, costUsd: 12.5, ponyCeilings: 2, turnsPonyOn: 7 });
  await post("/flags/claude2", { graft: false });
  const turns = await post("/turns", { events: [{ id: "a", turns: 1 }, { id: "b", turns: 1 }, "junk"] });
  assert.deepStrictEqual(turns, { ok: true, count: 2 }, "turn events append, non-objects dropped");
  const lines = fs.readFileSync(path.join(dir, "turns.jsonl"), "utf8").trim().split("\n");
  assert.strictEqual(lines.length, 2, "one jsonl line per event");
  assert.strictEqual(JSON.parse(lines[0]).id, "a", "events land verbatim");

  const stats = await get("/stats");
  const record = stats.installs["wsl__-root-apps-claude2"];
  assert.strictEqual(record.sessions, 5, "counters merge with max");
  assert.strictEqual(record.turns, 41, "newer counter wins when higher");
  assert.strictEqual(record.turnsPonyOn, 7, "split on/off counters merge like the rest");
  assert.strictEqual(record.ponyCeilings, 2, "ceilings gauge replaces");
  assert.strictEqual(record.srcLines, 5000, "an absent gauge keeps its last reading");
  const days = Object.values(stats.days["wsl__-root-apps-claude2"] || {});
  assert.strictEqual(days.length, 1, "one dated bucket");
  assert.deepStrictEqual(days[0], { turns: 1, turnsPonyOn: 7 }, "only the second push's growth is dated; the first sets the baseline");
  const flags = await get("/flags/claude2");
  assert.deepStrictEqual(flags, { graft: false, ponytail: true }, "flag merge and defaults");
  assert.strictEqual((await get("/flags/other")).graft, true, "unknown project defaults on");
}
