#!/usr/bin/env node
// The one check behind the quota lease: it is what stops an arbitrary number of VS Code windows
// from spending the account's whole rate-limit budget on reading the rate limit. Run: node test-quota.js
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude2-quota-test-"));
const child = spawn("node", [path.join(__dirname, "server.js")], { env: { ...process.env, PORT: "0", CLAUDE2_STATS_DIR: dir } });

const port = new Promise((resolve) => {
  child.stdout.on("data", (chunk) => {
    const found = /listening on (\d+)/.exec(String(chunk));
    if (found) resolve(Number(found[1]));
  });
});

async function call(method, urlPath, body) {
  const response = await fetch(`http://127.0.0.1:${await port}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await response.json();
}

async function main() {
  const claim = () => call("POST", "/quota/claim");

  assert.equal((await claim()).poll, true, "an idle fleet lets the first asker poll");
  assert.equal((await claim()).poll, false, "a claim in flight blocks every other window");

  const now = Date.now();
  await call("POST", "/quota", { rows: [{ at: now, five_pct: 12 }], readAt: now, state: { windows: [{ key: "five" }] } });
  assert.equal((await claim()).poll, false, "a fresh reading blocks the next cycle");

  const stored = await call("GET", "/quota");
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.readAt, now);
  assert.equal(stored.state.windows[0].key, "five", "state rides along with the reading");

  await call("POST", "/quota", { rows: [{ at: now, five_pct: 12 }], readAt: now - 1000 });
  const replayed = await call("GET", "/quota");
  assert.equal(replayed.rows.length, 1, "a replayed row merges on its timestamp");
  assert.equal(replayed.readAt, now, "an older readAt never drags the lease backwards");

  const paused = now + 60_000;
  await call("POST", "/quota", { pausedUntil: paused });
  assert.deepEqual(await claim(), { poll: false, pausedUntil: paused }, "one machine's 429 quiets them all");
  await call("POST", "/quota", { pausedUntil: now });
  assert.equal((await claim()).pausedUntil, paused, "nobody can cut another machine's pause short");

  console.log("quota lease ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
