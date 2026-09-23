#!/usr/bin/env node
// claude2-stats — the centralized plugin-stats task for the claude2 extension. Every install
// (host + workspace) of the extension owns one record of running totals and is its only writer;
// this task holds all the records plus the per-project plugin flags, so every workspace's
// Plugins pane shows the same table. Runs under pm2 as "claude2-stats".
//
//   GET  /stats                          -> { installs, flags }
//   POST /install/<key>    body: record  -> merge the install's record (counters take max)
//   GET  /flags/<project>                -> { graft, ponytail } (defaults true)
//   POST /flags/<project>  body: flags   -> merge { graft?, ponytail? }
//   POST /turns   body: { events: [..] } -> append raw per-turn events to turns.jsonl
//   GET  /quota                          -> { rows, readAt, pausedUntil, state }
//   POST /quota   body: { rows?, readAt?, pausedUntil?, state? } -> merge a reading
//   POST /quota/claim                    -> { poll } : the right to call the usage endpoint
//   GET  /models                         -> { machines: { <host>: { updatedAt, hours } } }
//   POST /models/<host>  body: { hours } -> merge { <model>: { <hour since epoch>: messages } }
//   GET  /settings                       -> the Settings pane's values ({} until first saved)
//   POST /settings  body: settings       -> replace them (the extension validates)
//
// The quota block is the account's one reading history. Anthropic's usage endpoint rate-limits
// per account, not per machine, so with a window open on three boxes the fleet would spend its
// whole budget on itself. /quota/claim leases the right to poll: the check-and-set in it is
// atomic because node handles one request at a time, so any number of windows asking at once
// still yields exactly one poller per cycle. Everyone else reads the answer from GET /quota.
//
// turns.jsonl is the extensive record: every settled turn of every install, one JSON line
// each, kept for stats nobody has thought of yet. Nothing serves it — analyze it on the box.
// Clients may redeliver a batch whose reply was lost, so analysis dedupes by event id.
//
// Counters only ever grow, so merging with max() makes pushes idempotent: a backfilled record,
// a replayed push, or an install whose local state was wiped can never drag a total back down.
// ponytail: no auth — personal server, low-value data; add a token header check if that changes.

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const port = process.env.PORT === undefined ? 7301 : Number(process.env.PORT);
const dataDir = process.env.CLAUDE2_STATS_DIR || path.join(os.homedir(), ".claude2-stats");
const dataPath = path.join(dataDir, "data.json");
const namePattern = /^[A-Za-z0-9._-]{1,200}$/;
const counterFields = ["sessions", "turns", "wallMs", "costUsd", "tokensIn", "tokensOut", "ponySkips", "graftCalls", "graftTokensSaved", "graftUsdSaved",
  "turnsPonyOn", "turnsPonyOff", "costPonyOn", "costPonyOff", "turnsGraftOn", "turnsGraftOff", "costGraftOn", "costGraftOff"];
const turnsPath = path.join(dataDir, "turns.jsonl");

// Freshness the lease counts from — a touch under the extension's five-minute timer, so a tick
// that lands a hair early still defers. claimedAt expires on its own: a window that claims and
// then dies mid-read costs one skipped cycle, not a stuck fleet.
const quotaFreshMs = 4.5 * 60 * 1000;
const quotaClaimMs = 30 * 1000;
const emptyQuota = { rows: [], readAt: 0, pausedUntil: 0, claimedAt: 0, state: null };

let data = { installs: {}, flags: {}, days: {}, quota: { ...emptyQuota }, models: {}, settings: {} };
try {
  const saved = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  data = { installs: saved.installs || {}, flags: saved.flags || {}, days: saved.days || {}, quota: { ...emptyQuota, ...(saved.quota || {}) }, models: saved.models || {}, settings: saved.settings || {} };
} catch {
  // first run, or an unreadable file: start empty; the next pushes rebuild it
}

function save() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dataPath + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(dataPath + ".tmp", dataPath);
}

function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function mergeInstall(key, body) {
  const known = data.installs[key];
  const old = known || {};
  const record = {
    host: typeof body.host === "string" ? body.host.slice(0, 20) : old.host || "",
    project: typeof body.project === "string" ? body.project.slice(0, 100) : old.project || "",
    path: typeof body.path === "string" ? body.path.slice(0, 300) : old.path || "",
    updatedAt: Date.now(),
  };
  // gauges of the workspace right now, not counters: the newest reading wins
  for (const field of ["ponyCeilings", "srcFiles", "srcLines"]) {
    record[field] = body[field] === undefined ? numberOf(old[field]) : numberOf(body[field]);
  }
  for (const field of counterFields) {
    record[field] = Math.max(numberOf(old[field]), numberOf(body[field]));
  }
  // Dated deltas, so a report can be filtered by period: each push's counter growth is
  // credited to today's bucket. An install's very first push only sets its baseline — it
  // usually carries seeded or backfilled history that belongs to no single day.
  // ponytail: growth pushed after time offline lands on the day it arrives, not the days it happened
  if (known) {
    const today = new Date().toISOString().slice(0, 10);
    const days = data.days[key] || (data.days[key] = {});
    for (const field of counterFields) {
      const grown = record[field] - numberOf(old[field]);
      if (grown > 0) {
        const bucket = days[today] || (days[today] = {});
        bucket[field] = (bucket[field] || 0) + grown;
      }
    }
  }
  data.installs[key] = record;
}

// Rows are identified by their timestamp, so a replayed push or a backfill of a machine's whole
// file is idempotent. readAt and pausedUntil only ever move forward: a client with a slow clock
// can neither re-arm a spent lease nor cut short someone else's 429 pause.
function mergeQuota(body) {
  const quota = data.quota;
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  if (incoming.length) {
    const byAt = new Map(quota.rows.map((row) => [row.at, row]));
    for (const row of incoming) {
      if (row && typeof row === "object" && typeof row.at === "number" && Number.isFinite(row.at)) {
        byAt.set(row.at, row);
      }
    }
    quota.rows = [...byAt.values()].sort((left, right) => left.at - right.at);
  }
  quota.pausedUntil = Math.max(numberOf(quota.pausedUntil), numberOf(body.pausedUntil));
  const readAt = numberOf(body.readAt);
  if (readAt > numberOf(quota.readAt)) {
    quota.readAt = readAt;
    // The state travels with the reading that produced it: a row carries percentages, but not the
    // subscription or window labels the pane needs before its first local reading lands.
    if (body.state && typeof body.state === "object") {
      quota.state = body.state;
    }
  }
}

// Assistant messages per model per hour, one block per machine, each counted from that machine's
// own transcripts. Every push is the machine's whole history, and an hour's count only grows, so
// max() keeps it idempotent -- and keeps hours whose transcripts Claude Code has since cleaned up.
function mergeModels(host, body) {
  const machine = data.models[host] || (data.models[host] = { updatedAt: 0, hours: {} });
  const incoming = body.hours && typeof body.hours === "object" ? body.hours : {};
  for (const [model, hours] of Object.entries(incoming)) {
    if (!namePattern.test(model) || !hours || typeof hours !== "object") continue;
    const known = machine.hours[model] || (machine.hours[model] = {});
    for (const [hour, count] of Object.entries(hours)) {
      if (/^\d+$/.test(hour)) known[hour] = Math.max(numberOf(known[hour]), numberOf(count));
    }
  }
  machine.updatedAt = Date.now();
}

function readBody(request, limit = 32768) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      text += chunk;
      if (text.length > limit) {
        reject(new Error("body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}

const server = http.createServer((request, response) => {
  void handle(request, response).catch((error) => {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String(error.message || error) }));
  });
});

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const json = (code, body) => {
    response.writeHead(code, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };

  if (request.method === "GET" && url.pathname === "/stats") {
    return json(200, data);
  }
  if (request.method === "GET" && parts[0] === "flags" && namePattern.test(parts[1] || "")) {
    const flags = data.flags[parts[1]] || {};
    return json(200, { graft: flags.graft !== false, ponytail: flags.ponytail !== false });
  }
  if (request.method === "POST" && url.pathname === "/turns") {
    // a full 2000-event client backlog at a few hundred bytes each needs the bigger cap
    const body = JSON.parse((await readBody(request, 2 * 1024 * 1024)) || "{}");
    const events = Array.isArray(body.events) ? body.events.filter((event) => typeof event === "object" && event !== null).slice(0, 2000) : [];
    if (events.length) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(turnsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    }
    return json(200, { ok: true, count: events.length });
  }
  if (request.method === "GET" && url.pathname === "/quota") {
    const { rows, readAt, pausedUntil, state } = data.quota;
    return json(200, { rows, readAt, pausedUntil, state });
  }
  if (request.method === "POST" && url.pathname === "/quota/claim") {
    const now = Date.now();
    const quota = data.quota;
    if (now < quota.pausedUntil) {
      return json(200, { poll: false, pausedUntil: quota.pausedUntil });
    }
    if (now - quota.claimedAt < quotaClaimMs || now - quota.readAt < quotaFreshMs) {
      return json(200, { poll: false });
    }
    quota.claimedAt = now;
    save();
    return json(200, { poll: true });
  }
  if (request.method === "POST" && url.pathname === "/quota") {
    // a backfill pushes a machine's whole history in one body, so the bigger cap applies here too
    const body = JSON.parse((await readBody(request, 2 * 1024 * 1024)) || "{}");
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "expected a JSON object" });
    }
    mergeQuota(body);
    save();
    return json(200, { ok: true, rows: data.quota.rows.length });
  }
  if (request.method === "GET" && url.pathname === "/settings") {
    return json(200, data.settings);
  }
  if (request.method === "POST" && url.pathname === "/settings") {
    const body = JSON.parse((await readBody(request)) || "{}");
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json(400, { error: "expected a JSON object" });
    }
    data.settings = body;
    save();
    return json(200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/models") {
    return json(200, { machines: data.models });
  }
  if (request.method === "POST" && parts[0] === "models" && parts.length === 2 && namePattern.test(parts[1])) {
    const body = JSON.parse((await readBody(request, 2 * 1024 * 1024)) || "{}");
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "expected a JSON object" });
    }
    mergeModels(parts[1], body);
    save();
    return json(200, { ok: true });
  }
  if (request.method === "POST" && parts.length === 2 && namePattern.test(parts[1])) {
    const body = JSON.parse((await readBody(request)) || "{}");
    if (typeof body !== "object" || body === null) {
      return json(400, { error: "expected a JSON object" });
    }
    if (parts[0] === "install") {
      mergeInstall(parts[1], body);
    } else if (parts[0] === "flags") {
      const flags = data.flags[parts[1]] || {};
      if (typeof body.graft === "boolean") flags.graft = body.graft;
      if (typeof body.ponytail === "boolean") flags.ponytail = body.ponytail;
      data.flags[parts[1]] = flags;
    } else {
      return json(404, { error: "not found" });
    }
    save();
    return json(200, { ok: true });
  }
  json(404, { error: "not found" });
}

server.listen(port, () => {
  console.log(`claude2-stats listening on ${server.address().port}, data in ${dataPath}`);
});
