import * as vscode from "vscode";
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_OPTIONS, MODEL_OPTIONS } from "./types";

export type ManagementPane = "instructions" | "quota";

export interface ConversationDefaults {
  model: string;
  effort: string;
  contextWindow: number;
  maxTurns: number;
}

export function sidebarHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --wash: rgba(0,0,0,0.07); }
    body { margin: 0; min-height: 100vh; background: var(--page); color: var(--ink); font: 14px/1.35 Aptos, "Segoe UI", sans-serif; }
    .shell { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; height: 100vh; padding: 10px; }
    .top { display: flex; flex-wrap: wrap; gap: 7px; flex: none; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; min-height: 31px; cursor: pointer; }
    .top button { height: 25px; min-height: 0; flex: none; padding: 0; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    #new, #quota { width: 21px; }
    #instructions { width: 52px; }
    #trash { width: 56px; }
    #trash.active { background: #fbd9d9; border-color: #e4a7a7; }
    #trash.active:hover { background: #f5c7c7; }
    .sessions { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
    .card { position: relative; box-sizing: border-box; width: 100%; text-align: left; white-space: normal; min-height: 42px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; user-select: none; }
    .card:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .card-trash { position: absolute; right: 6px; bottom: 6px; display: none; border: none; background: transparent; min-height: 0; padding: 2px 4px; font-size: 14px; line-height: 1; border-radius: 6px; }
    .card:hover .card-trash { display: block; }
    .card-trash:hover { background: #fbd9d9; }
    .card-restore { position: absolute; right: 6px; bottom: 6px; min-height: 0; padding: 3px 8px; font-size: 14px; border-radius: 6px; }
    .card.trashed { padding-bottom: 34px; }
    .card-name { display: block; font-weight: 600; overflow-wrap: anywhere; }
    .card-meta { display: block; color: var(--muted); font-size: 14px; margin-top: 3px; }
    .empty { border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); padding: 14px 10px; text-align: center; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <button id="new" title="New Claude2 session">+</button>
      <button id="instructions" title="Instructions">Instr</button>
      <button id="quota" title="Quota">$</button>
      <button id="trash" title="Show trashed sessions">Trash</button>
    </div>
    <div id="sessions" class="sessions"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let sessions = [];
    let showTrash = false;
    const list = document.getElementById('sessions');
    const trashButton = document.getElementById('trash');

    document.getElementById('new').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    document.getElementById('instructions').addEventListener('click', () => vscode.postMessage({ type: 'openPane', pane: 'instructions' }));
    document.getElementById('quota').addEventListener('click', () => vscode.postMessage({ type: 'openPane', pane: 'quota' }));
    trashButton.addEventListener('click', () => {
      showTrash = !showTrash;
      trashButton.classList.toggle('active', showTrash);
      trashButton.title = showTrash ? 'Show active sessions' : 'Show trashed sessions';
      render();
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'sessions') {
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        render();
      }
    });

    function render() {
      list.replaceChildren();
      const visible = sessions.filter((session) => (session.trashed === true) === showTrash);
      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = showTrash ? 'Trash is empty' : 'No sessions yet';
        list.appendChild(empty);
        return;
      }
      for (const session of visible) {
        const card = document.createElement('div');
        card.className = showTrash ? 'card trashed' : 'card';
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        const name = document.createElement('span');
        name.className = 'card-name';
        name.textContent = session.name || 'New session';
        const meta = document.createElement('span');
        meta.className = 'card-meta';
        const count = Array.isArray(session.turns) ? session.turns.length : 0;
        meta.textContent = count + (count === 1 ? ' prompt' : ' prompts') + ' · ' + timeLabel(session.updatedAt);
        card.append(name, meta);

        if (showTrash) {
          const restore = document.createElement('button');
          restore.className = 'card-restore';
          restore.textContent = 'Restore';
          restore.title = 'Move this session out of the trash';
          restore.addEventListener('pointerdown', (event) => event.stopPropagation());
          restore.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'restoreSession', sessionId: session.id });
          });
          card.appendChild(restore);
        } else {
          const trash = document.createElement('button');
          trash.className = 'card-trash';
          trash.textContent = '\u{1F5D1}';
          trash.title = 'Move this session to the trash';
          trash.addEventListener('pointerdown', (event) => event.stopPropagation());
          trash.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'trashSession', sessionId: session.id });
          });
          card.appendChild(trash);
        }

        let timer = 0;
        let renamed = false;
        card.addEventListener('pointerdown', () => {
          renamed = false;
          timer = window.setTimeout(() => {
            renamed = true;
            vscode.postMessage({ type: 'renameSession', sessionId: session.id });
          }, 650);
        });
        for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
          card.addEventListener(eventName, () => window.clearTimeout(timer));
        }
        card.addEventListener('click', (event) => {
          if (renamed) {
            event.preventDefault();
            return;
          }
          vscode.postMessage({ type: 'openSession', sessionId: session.id });
        });
        list.appendChild(card);
      }
    }

    function timeLabel(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms)) return '';
      return new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

export function conversationHtml(webview: vscode.Webview, sessionId: string, defaults: ConversationDefaults): string {
  const nonce = getNonce();
  const models = JSON.stringify(MODEL_OPTIONS);
  const efforts = JSON.stringify(EFFORT_OPTIONS);
  const safeSessionId = JSON.stringify(sessionId);
  const defaultModel = JSON.stringify(defaults.model || DEFAULT_MODEL);
  const defaultEffort = JSON.stringify(defaults.effort || DEFAULT_EFFORT);
  const contextWindow = JSON.stringify(defaults.contextWindow);
  const maxTurns = JSON.stringify(defaults.maxTurns);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d9d8d1; --yellow: #fff7bf; --wash: rgba(0,0,0,0.07); --done: #0c6b32; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: 14px/1.45 Aptos, "Segoe UI", sans-serif; }
    .shell { height: 100vh; display: grid; grid-template-rows: minmax(0, 1fr) minmax(96px, 25vh) auto auto; }
    .history { overflow: auto; min-height: 0; padding: 10px 12px 4px; }
    .empty { color: var(--muted); height: 100%; display: grid; place-items: center; }
    .turn { margin-bottom: 4px; }
    .prompt-bar { width: 100%; height: 1.65em; border: 1px solid #eadf90; background: var(--yellow); color: #14120a; display: block; text-align: left; padding: 1px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; cursor: pointer; }
    .response { margin: 4px 0 8px; border-left: 3px solid var(--border); padding: 8px 10px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; background: var(--surface); overflow-wrap: anywhere; }
    .response.error { border-left-color: #c62828; background: #fdecec; }
    textarea { resize: none; width: calc(100% - 24px); margin: 8px 12px; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 10px 11px; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
    textarea:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
    .bar { display: flex; gap: 8px; align-items: center; border-top: 1px solid var(--border); padding: 8px 12px; background: var(--page); }
    .bar .spacer { flex: 1; min-width: 8px; }
    .bar .stats { display: flex; gap: 12px; align-items: center; flex: none; margin-left: auto; }
    .bar .sep { color: var(--muted); }
    .group { display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap; }
    button, select { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); min-height: 31px; padding: 5px 10px; font: inherit; }
    button { cursor: pointer; }
    button:hover:not(:disabled), select:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .status { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .indicator { border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-weight: 700; white-space: nowrap; }
    .indicator.done { color: var(--done); border-color: rgba(12,107,50,0.45); background: #ecf7ef; }
    .indicator.active { color: #785b00; border-color: #d6b642; background: #fff8d8; }
    .footer { display: flex; gap: 8px; align-items: center; border-top: 1px solid var(--border); padding: 6px 12px 8px; background: var(--page); }
    @media (max-width: 760px) { .bar { flex-wrap: wrap; } .bar .stats { flex-wrap: wrap; } .status { white-space: normal; } }
  </style>
</head>
<body>
  <div class="shell">
    <div id="history" class="history"><div class="empty"></div></div>
    <textarea id="prompt" spellcheck="true"></textarea>
    <div class="bar">
      <div class="group"><select id="model"></select><select id="effort"></select><button id="send">Send</button><button id="stop">Stop</button></div>
      <div class="spacer"></div>
      <div class="stats"><div class="status" id="tokens"></div><span class="sep">|</span><div class="status" id="context"></div><span class="sep">|</span><div class="status" id="turns"></div></div>
    </div>
    <div class="footer">
      <div id="finish" class="indicator">Ready</div>
      <div class="group"><button id="top">Top</button><button id="up">Up</button><button id="down">Down</button><button id="bottom">Bottom</button><button id="prev">Prev</button><button id="next">Next</button><button id="closeAll">Close All</button><button id="openAll">Open All</button></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sessionId = ${safeSessionId};
    const models = ${models};
    const efforts = ${efforts};
    const defaultModel = ${defaultModel};
    const defaultEffort = ${defaultEffort};
    const contextWindow = ${contextWindow};
    const maxTurns = ${maxTurns};
    let session = { id: sessionId, name: 'New session', turns: [] };
    let status = null;
    let expanded = new Set();
    let shownActiveTurn = null;
    let navIndex = null;
    let anchorIndex = 0;
    const historyBox = document.getElementById('history');
    const promptBox = document.getElementById('prompt');
    const modelSelect = document.getElementById('model');
    const effortSelect = document.getElementById('effort');
    const stopButton = document.getElementById('stop');
    const finish = document.getElementById('finish');

    fillSelect(modelSelect, models, defaultModel);
    fillSelect(effortSelect, efforts, defaultEffort);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'sessionState') {
        session = message.session || session;
        status = message.status || null;
        document.title = session.name || 'Claude2';
        render();
      }
    });

    promptBox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        submitPrompt();
      }
    });
    promptBox.addEventListener('input', () => {
      if (navIndex !== null && session.turns[navIndex] && promptBox.value !== session.turns[navIndex].prompt) {
        navIndex = null;
        scrollBottom();
      }
    });
    document.getElementById('send').addEventListener('click', submitPrompt);
    stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stopPrompt', sessionId }));
    document.getElementById('top').addEventListener('click', () => scrollToIndex(0));
    document.getElementById('up').addEventListener('click', () => scrollToIndex(Math.max(0, anchorIndex - 1)));
    document.getElementById('down').addEventListener('click', () => scrollToIndex(Math.min(session.turns.length - 1, anchorIndex + 1)));
    document.getElementById('bottom').addEventListener('click', scrollBottom);
    document.getElementById('prev').addEventListener('click', () => loadPrompt(-1));
    document.getElementById('next').addEventListener('click', () => loadPrompt(1));
    document.getElementById('closeAll').addEventListener('click', () => { expanded = new Set(); render(); });
    document.getElementById('openAll').addEventListener('click', () => {
      expanded = new Set(session.turns.map((turn) => turn.id));
      render();
      requestAnimationFrame(() => scrollToIndex(anchorIndex));
    });

    function fillSelect(select, values, selected) {
      select.replaceChildren();
      for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        option.selected = value === selected;
        select.appendChild(option);
      }
    }

    function submitPrompt() {
      const prompt = promptBox.value;
      if (!prompt.trim() || (status && status.active)) return;
      vscode.postMessage({ type: 'submitPrompt', sessionId, prompt, model: modelSelect.value, effort: effortSelect.value });
      promptBox.value = '';
      navIndex = null;
      // Older responses hide when a new prompt goes in; the new one shows while streaming and stays
      // open when finished until the next prompt, so the answer never vanishes the moment it lands.
      expanded = new Set();
      scrollBottom();
    }

    function loadPrompt(direction) {
      if (!session.turns.length) return;
      if (navIndex === null) navIndex = direction < 0 ? session.turns.length : session.turns.length - 1;
      navIndex = Math.max(0, Math.min(session.turns.length - 1, navIndex + direction));
      promptBox.value = session.turns[navIndex].prompt;
      scrollToIndex(navIndex);
      promptBox.focus();
    }

    function render() {
      const active = status && status.active;
      stopButton.disabled = !active;
      const turns = Array.isArray(session.turns) ? session.turns : [];
      if (active && status.turnId !== shownActiveTurn) {
        shownActiveTurn = status.turnId;
        expanded.add(status.turnId);
      }
      const nearBottom = historyBox.scrollHeight - historyBox.scrollTop - historyBox.clientHeight < 18;
      historyBox.replaceChildren();
      if (!turns.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '';
        historyBox.appendChild(empty);
      } else {
        turns.forEach((turn, index) => {
          const wrapper = document.createElement('div');
          wrapper.className = 'turn';
          wrapper.dataset.index = String(index);
          wrapper.dataset.turnId = turn.id;
          const bar = document.createElement('button');
          bar.className = 'prompt-bar';
          bar.title = turn.prompt;
          bar.textContent = turn.prompt || '(empty prompt)';
          bar.addEventListener('click', () => {
            const opening = !expanded.has(turn.id);
            if (opening) expanded.add(turn.id); else expanded.delete(turn.id);
            render();
            // Queue after render's own scrollBottom frame so the opened bar lands at the top.
            if (opening) requestAnimationFrame(() => scrollToIndex(index));
          });
          wrapper.appendChild(bar);
          const isActiveTurn = active && status.turnId === turn.id;
          if (expanded.has(turn.id) || isActiveTurn) {
            const response = document.createElement('div');
            response.className = 'response' + (turn.error ? ' error' : '');
            response.textContent = turn.error || turn.response || '';
            wrapper.appendChild(response);
          }
          historyBox.appendChild(wrapper);
        });
      }
      if (nearBottom || active) scrollBottom();
      const latest = turns[turns.length - 1];
      // Totals for the whole conversation, not just the latest prompt.
      const inTokens = turns.reduce((sum, turn) => sum + (turn.tokensIn || 0), 0);
      const outTokens = turns.reduce((sum, turn) => sum + (turn.tokensOut || 0), 0);
      document.getElementById('tokens').textContent = 'tokens ' + inTokens.toLocaleString() + ' in / ' + outTokens.toLocaleString() + ' out';
      const used = active ? status.contextTokens : (latest ? latest.contextUsed || 0 : 0);
      document.getElementById('context').textContent = 'context ' + used.toLocaleString() + ' / ' + contextWindow.toLocaleString();
      const turnsSoFar = active ? status.turns || 0 : (latest ? latest.turns || 0 : 0);
      const turnLimit = active ? status.maxTurns || maxTurns : ((latest && latest.maxTurns) || maxTurns);
      document.getElementById('turns').textContent = 'turns ' + turnsSoFar + '/' + turnLimit;
      if (active) {
        finish.className = 'indicator active';
        finish.textContent = status.phase || 'working';
      } else if (latest && latest.finished) {
        finish.className = 'indicator done';
        finish.textContent = latest.stopped ? 'Stopped' : 'Finished';
      } else {
        finish.className = 'indicator';
        finish.textContent = 'Ready';
      }
    }

    function scrollToIndex(index) {
      if (!session.turns.length) return;
      anchorIndex = Math.max(0, Math.min(session.turns.length - 1, index));
      const node = historyBox.querySelector('[data-index="' + anchorIndex + '"]');
      if (node) node.scrollIntoView({ block: 'start' });
    }

    function scrollBottom() {
      anchorIndex = Math.max(0, session.turns.length - 1);
      requestAnimationFrame(() => { historyBox.scrollTop = historyBox.scrollHeight; });
    }

    vscode.postMessage({ type: 'conversationReady', sessionId });
  </script>
</body>
</html>`;
}

export function managementHtml(webview: vscode.Webview, pane: ManagementPane, timezone: string): string {
  return pane === "instructions" ? instructionsHtml(webview) : quotaHtml(webview, timezone);
}

function instructionsHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --error: #fdecec; --wash: rgba(0,0,0,0.08); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: 16.8px/1.45 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 28px 32px; max-width: 900px; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; margin-bottom: 16px; }
    h1 { font-size: 18px; font-weight: 600; letter-spacing: 0; margin: 0; }
    .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    .hint { color: var(--muted); font-size: 14.4px; }
    label { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 140px; }
    .path { color: var(--muted); font-size: 14.4px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    textarea { flex: 1; resize: none; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 9px 11px; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
    textarea:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 14px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .error { background: var(--error); border: 1px solid var(--border); border-left: 3px solid #c62828; border-radius: 8px; margin: 16px 0 0; padding: 10px 14px; }
  </style>
</head>
<body>
  <div class="pane">
    <div class="title"><h1>Instructions</h1><div class="actions"><span id="hint" class="hint"></span><button id="bottom" title="Scroll to bottom" aria-label="Scroll to bottom">⇊</button><button id="close">Close</button></div></div>
    <label><span id="path" class="path">CLAUDE.md</span><textarea id="text" spellcheck="true" disabled></textarea></label>
    <p id="error" class="error" hidden></p>
  </div>
  <script nonce="${nonce}">
    // The pane saves as you type, like a VS Code editor with auto save: every edit is written to
    // CLAUDE.md after a short pause, Ctrl-S writes at once, and leaving the pane flushes first.
    const vscode = acquireVsCodeApi();
    const textBox = document.getElementById('text');
    const pathLabel = document.getElementById('path');
    const hint = document.getElementById('hint');
    const errorNode = document.getElementById('error');
    const pending = new Map();
    const saveDelayMs = 400;
    let text = '';
    let settled = '';
    let version = '';
    let filePath = 'CLAUDE.md';
    let loading = true;
    let saving = false;
    let error = null;
    let savedAt = null;
    let overwrote = false;
    let saveTimer = 0;

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        const resolve = pending.get(message.requestId);
        pending.delete(message.requestId);
        resolve(message);
      } else if (message.type === 'requestLeave') {
        flush().then((ok) => vscode.postMessage({ type: 'leaveResponse', requestId: message.requestId, go: ok }));
      } else if (message.type === 'instructionsChanged') {
        void reloadIfClean();
      }
    });
    textBox.addEventListener('input', () => {
      text = textBox.value;
      scheduleSave();
      render();
    });
    textBox.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void flush();
      }
    });
    document.getElementById('bottom').addEventListener('click', scrollBottom);
    document.getElementById('close').addEventListener('click', () => { flush().then((ok) => { if (ok) vscode.postMessage({ type: 'closeManagement' }); }); });

    load();

    async function load() {
      loading = true;
      render();
      const reply = await request('loadInstructions', {});
      loading = false;
      if (reply.ok) {
        text = reply.payload.text || '';
        settled = text;
        version = reply.payload.version || '';
        filePath = reply.payload.path || 'CLAUDE.md';
        error = null;
        textBox.value = text;
        requestAnimationFrame(scrollBottom);
      } else {
        error = reply.error || 'Could not load instructions.';
      }
      render();
    }

    // An outside edit (another editor, a git checkout) replaces the text unless there is unsaved
    // typing here, which is what a VS Code editor does with a clean document.
    async function reloadIfClean() {
      if (loading || saving || dirty()) return;
      const reply = await request('loadInstructions', {});
      if (!reply.ok || dirty() || saving) return;
      if ((reply.payload.version || '') === version) return;
      const selectionStart = textBox.selectionStart;
      const selectionEnd = textBox.selectionEnd;
      const scrollTop = textBox.scrollTop;
      text = reply.payload.text || '';
      settled = text;
      version = reply.payload.version || '';
      textBox.value = text;
      textBox.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length));
      textBox.scrollTop = scrollTop;
      overwrote = false;
      render();
    }

    function scheduleSave() {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => { void save(); }, saveDelayMs);
    }

    // Writes now, waits for any write in flight, and writes again if typing continued meanwhile.
    async function flush() {
      window.clearTimeout(saveTimer);
      while (dirty()) {
        const ok = await save();
        if (!ok && !saving) return false;
      }
      return !error;
    }

    async function save() {
      if (!dirty()) return true;
      if (saving) return false;
      const sending = text;
      saving = true;
      render();
      const reply = await request('saveInstructions', { text: sending, version });
      saving = false;
      if (reply.ok) {
        version = reply.payload.version || '';
        settled = sending;
        savedAt = new Date();
        overwrote = reply.payload.stale === true;
        error = null;
        render();
        if (dirty()) scheduleSave();
        return true;
      }
      error = 'Could not save: ' + (reply.error || 'unknown error');
      render();
      return false;
    }

    function dirty() { return !loading && text !== settled; }
    function scrollBottom() { textBox.scrollTop = textBox.scrollHeight; }
    function request(type, payload) {
      const requestId = String(Date.now()) + '-' + String(Math.random()).slice(2);
      return new Promise((resolve) => { pending.set(requestId, resolve); vscode.postMessage(Object.assign({ type, requestId }, payload)); });
    }
    function render() {
      textBox.disabled = loading;
      pathLabel.textContent = filePath;
      if (loading) hint.textContent = ''; else if (saving) hint.textContent = 'Saving...'; else if (dirty()) hint.textContent = 'Unsaved changes'; else if (overwrote) hint.textContent = 'Saved over a change made on disk'; else if (savedAt) hint.textContent = 'Saved to ' + filePath; else hint.textContent = '';
      errorNode.hidden = !error;
      errorNode.textContent = error || '';
    }
  </script>
</body>
</html>`;
}

function quotaHtml(webview: vscode.Webview, timezone: string): string {
  const nonce = getNonce();
  const safeTimezone = JSON.stringify(timezone);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --grid: rgba(0,0,0,0.15); --wash: rgba(0,0,0,0.08); --blue: #2457d6; --red: #c62828; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: 16px/1.4 Aptos, "Segoe UI", sans-serif; }
    .pane { height: 100vh; display: flex; flex-direction: column; gap: 16px; padding: 28px 32px; }
    .pane.expanded { max-width: none; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0; }
    .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 14px; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 13px; min-height: 34px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .graphs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; min-height: 0; overflow: auto; }
    .graphs.single { display: flex; flex: 1; min-height: 0; }
    .graph { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 11px; min-width: 0; }
    .graphs.single .graph { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .graph-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .graph-name { font-weight: 700; }
    .legend { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 14px; }
    .swatch { width: 12px; height: 2px; display: inline-block; background: var(--ink); vertical-align: middle; }
    .swatch.blue { background: var(--blue); } .swatch.red { background: var(--red); }
    .period { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
    .period button { min-height: 26px; padding: 2px 8px; }
    .plot { position: relative; width: 100%; aspect-ratio: 320 / 200; border: 1px solid var(--border); cursor: pointer; background: #fff; }
    .graphs.single .plot { flex: 1; min-height: 260px; aspect-ratio: auto; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    svg text { font-size: 14px; fill: var(--muted); text-anchor: end; }
    .figures { margin-top: 8px; color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
    .empty, .error { border: 1px dashed var(--border); border-radius: 8px; padding: 18px; color: var(--muted); }
    .error { background: #fdecec; color: #731b1b; border-style: solid; }
    @media (max-width: 900px) { .graphs { grid-template-columns: 1fr; } .title, .actions { align-items: flex-start; flex-wrap: wrap; } }
  </style>
</head>
<body>
  <div id="pane" class="pane">
    <div class="title"><h1>Plan quota over time</h1><div class="actions"><span id="readTime"></span><span id="age"></span><button id="update">Update</button><button id="close">Close</button></div></div>
    <div id="error" class="error" hidden></div>
    <div id="graphs" class="graphs"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timeZone = ${safeTimezone};
    const pending = new Map();
    const backs = { five: 0, seven: 0, credits: 0 };
    let payload = { readAt: null, rows: [], state: { error: null } };
    let expanded = null;
    let loading = true;
    let updating = false;
    let measured = { width: 320, height: 200 };
    let resizeObserver = null;

    document.getElementById('update').addEventListener('click', () => void load(true));
    document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'closeManagement' }));
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        const resolve = pending.get(message.requestId);
        pending.delete(message.requestId);
        resolve(message);
      }
    });
    window.addEventListener('focus', renderAge);
    document.addEventListener('visibilitychange', renderAge);
    document.addEventListener('click', renderAge);
    setInterval(() => void load(false), 5 * 60 * 1000);
    setInterval(renderAge, 10 * 1000);
    setInterval(render, 30 * 1000);
    void load(false);

    async function load(force) {
      updating = force;
      render();
      const reply = await request(force ? 'forceQuotaHistory' : 'loadQuotaHistory', {});
      loading = false;
      updating = false;
      if (reply.ok) payload = reply.payload;
      else payload.state = Object.assign({}, payload.state, { error: reply.error || 'Could not load quota history.' });
      render();
    }

    function request(type, data) {
      const requestId = String(Date.now()) + '-' + String(Math.random()).slice(2);
      return new Promise((resolve) => { pending.set(requestId, resolve); vscode.postMessage(Object.assign({ type, requestId }, data)); });
    }

    function render() {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      document.getElementById('update').disabled = updating;
      document.getElementById('update').textContent = updating ? 'Updating...' : 'Update';
      const errorNode = document.getElementById('error');
      const error = payload.state && payload.state.error ? payload.state.error : null;
      errorNode.hidden = !error;
      errorNode.textContent = error || '';
      renderAge();
      const graphsNode = document.getElementById('graphs');
      const pane = document.getElementById('pane');
      const graphs = [buildWindowGraph('five', '5h', 5 * 60 * 60 * 1000, [{ field: 'five_pct', reset: 'five_resets', name: '5h', color: '#000' }], rows), buildWindowGraph('seven', '7d', 7 * 24 * 60 * 60 * 1000, [{ field: 'seven_pct', reset: 'seven_resets', name: '7d', color: '#2457d6' }, { field: 'fable_pct', reset: 'fable_resets', name: modelLabel(), color: '#c62828' }], rows), buildCreditsGraph(rows)];
      const visibleGraphs = expanded ? graphs.filter((graph) => graph.key === expanded) : graphs;
      pane.className = 'pane' + (expanded ? ' expanded' : '');
      graphsNode.className = 'graphs' + (expanded ? ' single' : '');
      graphsNode.replaceChildren();
      if (loading && rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Taking a reading...';
        graphsNode.appendChild(empty);
        return;
      }
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Nothing recorded yet...';
        graphsNode.appendChild(empty);
        return;
      }
      for (const graph of visibleGraphs) {
        graphsNode.appendChild(graphElement(graph));
      }
      bindGraphControls(graphsNode);
      measureExpandedPlot();
    }

    function renderAge() {
      const readTime = document.getElementById('readTime');
      const age = document.getElementById('age');
      if (!payload.readAt) {
        readTime.textContent = '';
        age.textContent = '';
        return;
      }
      readTime.textContent = new Date(payload.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone });
      const ageMs = Math.max(0, Date.now() - payload.readAt);
      const minutes = Math.floor(ageMs / 60000);
      const seconds = Math.floor((ageMs % 60000) / 1000);
      age.textContent = minutes + ':' + String(seconds).padStart(2, '0');
    }

    function graphElement(graph) {
      const graphNode = document.createElement('section');
      graphNode.className = 'graph';
      const periods = graph.periods;
      const back = Math.min(backs[graph.key] || 0, Math.max(0, periods.length - 1));
      backs[graph.key] = back;
      const period = periods[periods.length - 1 - back];
      graphNode.innerHTML = '<div class="graph-head"><span class="graph-name">' + escapeHtml(graph.title) + '</span>' + legendHtml(graph) + '</div>';
      if (!period) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Nothing recorded yet...';
        graphNode.appendChild(empty);
        return graphNode;
      }
      const periodBar = document.createElement('div');
      periodBar.className = 'period';
      periodBar.innerHTML = '<button data-page="older" data-key="' + graph.key + '" ' + (back >= periods.length - 1 ? 'disabled' : '') + '>‹</button><span>' + escapeHtml(period.label) + '</span><button data-page="newer" data-key="' + graph.key + '" ' + (back === 0 ? 'disabled' : '') + '>›</button>';
      const plot = document.createElement('div');
      plot.className = 'plot';
      plot.dataset.expand = graph.key;
      const size = expanded === graph.key ? measured : { width: 320, height: 200 };
      plot.innerHTML = drawSvg(period, graph.money, size.width, size.height);
      const figures = document.createElement('div');
      figures.className = 'figures';
      figures.innerHTML = figuresHtml(period, graph.money);
      graphNode.append(periodBar, plot, figures);
      return graphNode;
    }

    function bindGraphControls(root) {
      root.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const key = button.dataset.key;
          backs[key] = Math.max(0, (backs[key] || 0) + (button.dataset.page === 'older' ? 1 : -1));
          render();
        });
      });
      root.querySelectorAll('[data-expand]').forEach((plot) => {
        plot.addEventListener('click', () => {
          expanded = expanded === plot.dataset.expand ? null : plot.dataset.expand;
          measured = { width: 320, height: 200 };
          render();
        });
      });
    }

    function measureExpandedPlot() {
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = null;
      if (!expanded) return;
      const plot = document.querySelector('.plot');
      if (!plot || typeof ResizeObserver === 'undefined') return;
      resizeObserver = new ResizeObserver((entries) => {
        const rect = entries[0].contentRect;
        const width = Math.max(320, Math.floor(rect.width));
        const height = Math.max(200, Math.floor(rect.height));
        if (width !== measured.width || height !== measured.height) {
          measured = { width, height };
          render();
        }
      });
      resizeObserver.observe(plot);
    }

    function buildWindowGraph(key, title, lengthMs, seriesDefs, rows) {
      const periods = [];
      function findPeriod(end) {
        let existing = periods.find((period) => Math.abs(period.end - end) <= 600000);
        if (!existing) {
          existing = { key, start: end - lengthMs, end, label: title === '5h' ? stamp(end) : dayStamp(end), series: seriesDefs.map((def) => ({ name: def.name, color: def.color, points: [] })) };
          periods.push(existing);
        }
        return existing;
      }
      for (const row of rows) {
        seriesDefs.forEach((def, index) => {
          const value = numeric(row[def.field]);
          const resetSeconds = numeric(row[def.reset]) || (key === 'seven' ? numeric(row.seven_resets) : null);
          if (value === null || resetSeconds === null) return;
          const end = resetSeconds * 1000;
          if (row.at <= end || (value > 0 && row.at - end < 600000)) {
            findPeriod(end).series[index].points.push({ t: Math.min(row.at, end), v: value });
          }
        });
      }
      return { key, title, money: false, periods: periods.filter((period) => period.series.some((series) => series.points.length > 0)).sort((left, right) => left.end - right.end) };
    }

    function buildCreditsGraph(rows) {
      const byMonth = new Map();
      for (const row of rows) {
        const spent = numeric(row.spent_usd);
        if (spent === null) continue;
        const parts = localParts(row.at);
        const key = parts.year + '-' + String(parts.month).padStart(2, '0');
        if (!byMonth.has(key)) {
          const start = zonedTime(parts.year, parts.month, 1, 0, 0, 0);
          const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
          const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
          const end = zonedTime(nextYear, nextMonth, 1, 0, 0, 0);
          byMonth.set(key, { key: 'credits', start, end, label: new Date(start).toLocaleString([], { month: 'long', year: 'numeric', timeZone }), series: [{ name: 'credits', color: '#000', points: [] }], limit: 1 });
        }
        const period = byMonth.get(key);
        period.series[0].points.push({ t: row.at, v: spent });
        const limit = numeric(row.limit_usd);
        if (limit !== null) period.limit = limit;
      }
      const periods = Array.from(byMonth.values()).map((period) => {
        if (!period.limit) period.limit = Math.max(1, ...period.series[0].points.map((point) => point.v));
        return period;
      }).sort((left, right) => left.end - right.end);
      return { key: 'credits', title: 'credits', money: true, periods };
    }

    function drawSvg(period, money, width, height) {
      const margin = { left: 40, right: 6, top: 6, bottom: 18 };
      const plotWidth = Math.max(1, width - margin.left - margin.right);
      const plotHeight = Math.max(1, height - margin.top - margin.bottom);
      const yMax = money ? Math.max(1, period.limit || 1) : 100;
      const x = (time) => margin.left + ((time - period.start) / (period.end - period.start)) * plotWidth;
      const y = (value) => margin.top + (1 - Math.min(yMax, Math.max(0, value)) / yMax) * plotHeight;
      let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img">';
      for (const fraction of [0, 0.5, 1]) {
        const yValue = y(yMax * fraction);
        svg += '<line x1="' + margin.left + '" x2="' + (width - margin.right) + '" y1="' + yValue + '" y2="' + yValue + '" stroke="rgba(0,0,0,0.15)" />';
        svg += '<text x="' + (margin.left - 5) + '" y="' + (yValue + 4) + '">' + escapeHtml(axisLabel(yMax * fraction, money)) + '</text>';
      }
      for (const time of gridTimes(period, money)) {
        const xValue = x(time);
        svg += '<line x1="' + xValue + '" x2="' + xValue + '" y1="' + margin.top + '" y2="' + (height - margin.bottom) + '" stroke="rgba(0,0,0,0.15)" />';
      }
      svg += '<line x1="' + margin.left + '" y1="' + y(0) + '" x2="' + (width - margin.right) + '" y2="' + y(yMax) + '" stroke="rgba(0,0,0,0.45)" stroke-dasharray="5 4" stroke-width="1" />';
      for (const series of period.series) {
        const points = carriedPoints(series.points, period).sort((left, right) => left.t - right.t);
        if (points.length === 1) {
          svg += '<circle cx="' + x(points[0].t) + '" cy="' + y(points[0].v) + '" r="2.4" fill="' + series.color + '" />';
        } else if (points.length > 1) {
          svg += '<polyline points="' + points.map((point) => x(point.t) + ',' + y(point.v)).join(' ') + '" fill="none" stroke="' + series.color + '" stroke-width="1.6" />';
        }
      }
      svg += '</svg>';
      return svg;
    }

    function carriedPoints(points, period) {
      const sorted = points.slice().sort((left, right) => left.t - right.t);
      if (sorted.length === 0) return sorted;
      const knownTo = Math.min(period.end, payload.readAt || Date.now());
      const last = sorted[sorted.length - 1];
      if (last.t < knownTo) sorted.push({ t: knownTo, v: last.v });
      return sorted;
    }

    function figuresHtml(period, money) {
      const parts = [];
      for (const series of period.series) {
        const points = carriedPoints(series.points, period);
        if (points.length) {
          const value = points[points.length - 1].v;
          parts.push('<span style="color:' + series.color + '">' + escapeHtml(series.name + ' ' + axisLabel(value, money)) + '</span>');
        }
      }
      if (!money) {
        const elapsed = Math.max(0, Math.min(1, (Date.now() - period.start) / (period.end - period.start)));
        parts.push('<span>' + Math.round(elapsed * 100) + '%</span>');
        parts.push('<span>' + escapeHtml(timeLeft(period.end - Date.now())) + '</span>');
      }
      return parts.join('');
    }

    function gridTimes(period, money) {
      const times = [];
      if (money) {
        let cursor = period.start;
        while (cursor < period.end) {
          if (new Date(cursor).getUTCDay() === 0 && cursor > period.start) times.push(cursor);
          cursor += 24 * 60 * 60 * 1000;
        }
        return times;
      }
      const step = period.end - period.start <= 6 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      let cursor = Math.ceil(period.start / step) * step;
      while (cursor < period.end) {
        if (cursor > period.start) times.push(cursor);
        cursor += step;
      }
      return times;
    }

    function modelLabel() {
      const windows = payload.state && Array.isArray(payload.state.windows) ? payload.state.windows : [];
      const model = windows.find((windowState) => windowState.key === 'model');
      return model && model.label ? model.label : 'Fable';
    }

    function legendHtml(graph) {
      if (graph.key !== 'seven') return '';
      return '<span class="legend"><span class="swatch blue"></span>7d <span class="swatch red"></span>' + escapeHtml(modelLabel()) + '</span>';
    }

    function axisLabel(value, money) { return money ? '$' + Number(value).toFixed(value >= 10 ? 0 : 2) : Math.round(value) + '%'; }
    function timeLeft(ms) {
      if (ms <= 0) return 'period over';
      const minutes = Math.floor(ms / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      if (days > 0) return days + 'd ' + (hours % 24) + 'h left';
      if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm left';
      return minutes + 'm left';
    }
    function stamp(ms) { return new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }); }
    function dayStamp(ms) { return new Date(ms).toLocaleString([], { weekday: 'short', month: 'numeric', day: 'numeric', timeZone }); }
    function localParts(ms) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false }).formatToParts(new Date(ms));
      const out = {};
      for (const part of parts) if (part.type !== 'literal') out[part.type] = Number(part.value);
      return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
    }
    function zonedTime(year, month, day, hour, minute, second) {
      const guess = Date.UTC(year, month - 1, day, hour, minute, second);
      return guess - offsetMinutes(guess) * 60000;
    }
    function offsetMinutes(ms) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
      const zone = (parts.find((part) => part.type === 'timeZoneName') || {}).value || 'GMT+0';
      const match = zone.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      if (!match) return 0;
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
    }
    function numeric(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}