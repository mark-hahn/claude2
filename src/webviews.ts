import * as vscode from "vscode";
import { CLAUDE2_COMPACT_RESERVE, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_OPTIONS, MODEL_OPTIONS, TOOL_LINE_MARK } from "./types";

export type ManagementPane = "instructions" | "quota" | "graft" | "markdown" | "cap";

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
    .top { display: flex; flex-direction: column; gap: 7px; flex: none; }
    .row { display: flex; flex-wrap: wrap; gap: 7px; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; min-height: 31px; cursor: pointer; }
    .top button { height: 25px; min-height: 0; flex: none; padding: 0; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    #new, #quota { width: 21px; }
    #instructions { width: 52px; }
    #graft { width: 52px; }
    #markdown { width: 30px; }
    #close { width: 56px; }
    #trash { width: 56px; }
    #trash.active { background: #fbd9d9; border-color: #e4a7a7; }
    #trash.active:hover { background: #f5c7c7; }
    .search-row { display: flex; gap: 7px; }
    #searchBox { flex: 1; min-width: 0; box-sizing: border-box; height: 25px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; }
    #searchBox::placeholder { color: var(--ink); }
    #searchBox.searching { background: #cfe8ff; }
    #searchClear { width: 25px; }
    .sessions { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
    .card { position: relative; box-sizing: border-box; width: 100%; text-align: left; white-space: normal; min-height: 42px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; user-select: none; }
    .card:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .card.selected { background: #fbf3c4; border-color: #ddd08a; }
    .card.selected:hover { background: linear-gradient(var(--wash), var(--wash)), #fbf3c4; }
    .card-actions { position: absolute; right: 6px; bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .card-trash { display: none; border: none; background: transparent; min-height: 0; padding: 2px 4px; font-size: 14px; line-height: 1; border-radius: 6px; }
    .card:hover .card-trash { display: block; }
    .card-trash:hover { background: #fbd9d9; }
    .card-restore { display: none; min-height: 0; padding: 3px 8px; font-size: 14px; border-radius: 6px; }
    .card:hover .card-restore { display: block; }
    .card.trashed { padding-bottom: 34px; }
    .card-name { display: block; font-weight: 600; overflow-wrap: anywhere; }
    .card-rename { box-sizing: border-box; display: block; width: 100%; font: inherit; font-weight: 600; color: var(--ink); background: #fff; border: 1px solid #9a9a93; border-radius: 6px; padding: 1px 4px; }
    .card-meta { display: block; color: var(--muted); font-size: 14px; margin-top: 3px; }
    .card-hits { display: block; color: #0b5ed7; font-size: 14px; margin-top: 3px; }
    .empty { border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); padding: 14px 10px; text-align: center; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div class="row">
        <button id="quota" title="Quota">$</button>
        <button id="instructions" title="Instructions">Instr</button>
        <button id="graft" title="Graft graph">Graft</button>
        <button id="cap" title="Show the latest screen capture">Cap</button>
        <button id="markdown" title="Show the selected response as markdown">md</button>
      </div>
      <div class="row">
        <button id="new" title="New Claude2 session">+</button>
        <button id="close" title="Close every session tab but the current one">Close</button>
        <button id="trash" title="Show trashed sessions">Trash</button>
      </div>
      <div class="search-row">
        <input id="searchBox" type="text" placeholder="Search" spellcheck="false">
        <button id="searchClear" title="Clear search">&#x2715;</button>
      </div>
    </div>
    <div id="sessions" class="sessions"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let sessions = [];
    let selectedId = '';
    let scrolledId = '';
    let showTrash = false;
    // An inline rename owns its card until it commits, so a background refresh waits
    // rather than yanking the input out from under the typing.
    let editingId = '';
    let pendingRender = false;
    const list = document.getElementById('sessions');
    const trashButton = document.getElementById('trash');
    const searchBox = document.getElementById('searchBox');
    // Search mode is on while this is non-empty. Enter in the box starts it; the X, an
    // empty Enter, or any top button ends it. Card clicks leave it alone on purpose, so
    // the opened editors can show their highlighted lines.
    let searchText = '';

    document.getElementById('new').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'newSession' }); });
    document.getElementById('instructions').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'instructions' }); });
    document.getElementById('quota').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'quota' }); });
    document.getElementById('graft').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'graft' }); });
    document.getElementById('markdown').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'markdown' }); });
    document.getElementById('cap').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'cap' }); });
    document.getElementById('close').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'closeOtherSessions' }); });
    trashButton.addEventListener('click', () => {
      clearSearch();
      vscode.postMessage({ type: 'discardEmpty' });
      showTrash = !showTrash;
      trashButton.classList.toggle('active', showTrash);
      trashButton.title = showTrash ? 'Show active sessions' : 'Show trashed sessions';
      render();
    });
    searchBox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        setSearch(searchBox.value.trim());
      }
    });
    document.getElementById('searchClear').addEventListener('click', () => {
      searchBox.value = '';
      if (searchText) setSearch('');
    });

    // The extension mirrors the search into every conversation pane, so it hears
    // about every change here, including the empty text that ends search mode.
    function setSearch(text) {
      searchText = text;
      searchBox.classList.toggle('searching', searchText !== '');
      vscode.postMessage({ type: 'searchChanged', text: searchText });
      render();
    }

    function clearSearch() {
      if (!searchText) return;
      searchBox.value = '';
      setSearch('');
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'sessions') {
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        selectedId = typeof message.selectedId === 'string' ? message.selectedId : '';
        if (editingId) {
          pendingRender = true;
          return;
        }
        render();
      }
    });

    function render() {
      list.replaceChildren();
      let selectedCard = null;
      let visible;
      const counts = new Map();
      if (searchText) {
        // Every session competes, trash included; a name-only match carries a zero count.
        visible = sessions.filter((session) => {
          const count = matchCount(session);
          if (!count && !(session.name || '').toLowerCase().includes(searchText.toLowerCase())) return false;
          counts.set(session.id, count);
          return true;
        });
        // Stable sort: trashed cards sink below active ones, each group keeping its recency order.
        visible.sort((left, right) => (left.trashed === true ? 1 : 0) - (right.trashed === true ? 1 : 0));
      } else {
        visible = sessions.filter((session) => (session.trashed === true) === showTrash);
      }
      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = searchText ? 'No matches' : (showTrash ? 'Trash is empty' : 'No sessions yet');
        list.appendChild(empty);
        return;
      }
      for (const session of visible) {
        const trashed = searchText ? session.trashed === true : showTrash;
        const card = document.createElement('div');
        card.className = trashed ? 'card trashed' : 'card';
        if (session.id === selectedId) {
          card.classList.add('selected');
          selectedCard = card;
        }
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        const name = document.createElement('span');
        name.className = 'card-name';
        name.textContent = session.name || 'New session';
        const meta = document.createElement('span');
        meta.className = 'card-meta';
        meta.textContent = timeLabel(session.updatedAt);
        card.append(name, meta);
        const hitCount = counts.get(session.id) || 0;
        if (hitCount > 0) {
          const hits = document.createElement('span');
          hits.className = 'card-hits';
          hits.textContent = hitCount + (hitCount === 1 ? ' match' : ' matches');
          card.appendChild(hits);
        }

        const actions = document.createElement('div');
        actions.className = 'card-actions';

        const trash = document.createElement('button');
        trash.className = 'card-trash';
        trash.textContent = '\u{1F5D1}';
        // Same icon, two meanings: one hop to the trash, then gone for good.
        trash.title = trashed ? 'Delete this session permanently' : 'Move this session to the trash';
        trash.addEventListener('pointerdown', (event) => event.stopPropagation());
        trash.addEventListener('click', (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: trashed ? 'deleteSession' : 'trashSession', sessionId: session.id });
        });
        if (trashed) {
          const restore = document.createElement('button');
          restore.className = 'card-restore';
          restore.textContent = 'Restore';
          restore.title = 'Move this session out of the trash';
          restore.addEventListener('pointerdown', (event) => event.stopPropagation());
          restore.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'restoreSession', sessionId: session.id });
          });
          actions.appendChild(restore);
        }
        actions.appendChild(trash);
        card.appendChild(actions);

        let timer = 0;
        let renamed = false;
        card.addEventListener('pointerdown', () => {
          // Clicking the card that is mid-rename only dismisses the editor (blur commits it);
          // it must not also open the session, and must not arm a second long press.
          renamed = editingId === session.id;
          if (renamed) {
            return;
          }
          timer = window.setTimeout(() => {
            renamed = true;
            startRename(name, session);
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
      // Only chase the selection when it actually moves: a refresh mid-stream must not
      // yank the list back while the user is scrolling through other cards.
      if (selectedCard && selectedId !== scrolledId) {
        scrolledId = selectedId;
        selectedCard.scrollIntoView({ block: 'nearest' });
      }
    }

    function startRename(nameEl, session) {
      if (editingId) {
        return;
      }
      editingId = session.id;
      const input = document.createElement('input');
      input.className = 'card-rename';
      input.type = 'text';
      input.value = session.name || 'New session';
      for (const eventName of ['pointerdown', 'pointerup', 'click', 'dblclick']) {
        input.addEventListener(eventName, (event) => event.stopPropagation());
      }
      let closed = false;
      const finish = (commit) => {
        if (closed) return;
        closed = true;
        const value = input.value.trim();
        editingId = '';
        input.replaceWith(nameEl);
        if (commit && value && value !== session.name) {
          session.name = value;
          nameEl.textContent = value;
          vscode.postMessage({ type: 'renameSession', sessionId: session.id, name: value });
        }
        if (pendingRender) {
          pendingRender = false;
          render();
        }
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      });
      input.addEventListener('blur', () => finish(true));
      nameEl.replaceWith(input);
      input.focus();
      input.select();
    }

    function timeLabel(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms)) return '';
      return new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // Occurrences of the search text across the session's prompts and responses,
    // case-insensitive. The name is deliberately not counted: a name-only match
    // shows the card with no tally.
    function matchCount(session) {
      const needle = searchText.toLowerCase();
      const turns = Array.isArray(session.turns) ? session.turns : [];
      let count = 0;
      for (const turn of turns) {
        count += occurrences(turn.prompt, needle) + occurrences(turn.response, needle);
      }
      return count;
    }

    function occurrences(text, needle) {
      if (!text || !needle) return 0;
      const lower = String(text).toLowerCase();
      let count = 0;
      let index = lower.indexOf(needle);
      while (index !== -1) {
        count += 1;
        index = lower.indexOf(needle, index + needle.length);
      }
      return count;
    }

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

export function conversationHtml(webview: vscode.Webview, sessionId: string, defaults: ConversationDefaults, zoom = 1): string {
  const nonce = getNonce();
  const z = zoomFactor(zoom);
  const models = JSON.stringify(MODEL_OPTIONS);
  const efforts = JSON.stringify(EFFORT_OPTIONS);
  const safeSessionId = JSON.stringify(sessionId);
  const defaultModel = JSON.stringify(defaults.model || DEFAULT_MODEL);
  const defaultEffort = JSON.stringify(defaults.effort || DEFAULT_EFFORT);
  const contextWindow = JSON.stringify(defaults.contextWindow);
  const compactReserve = JSON.stringify(CLAUDE2_COMPACT_RESERVE);
  const maxTurns = JSON.stringify(defaults.maxTurns);
  // Emitted as an escape, not the raw character: the mark is invisible, and a literal one in the
  // generated script would be an unreadable blank in any view of this page's source.
  const toolLineMark = `'\\u${TOOL_LINE_MARK.codePointAt(0)?.toString(16).padStart(4, "0")}'`;
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d9d8d1; --yellow: #fff7bf; --wash: rgba(0,0,0,0.07); --done: #0c6b32; --z: 1; --edh: calc(63px * var(--z) + 22px); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(14px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .shell { height: 100vh; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
    /* Prompt editor and every control sit on one bottom dock, so the editor's bottom edge is the
       window's bottom edge; the controls stack to its right instead of below it. */
    .dock { display: flex; align-items: stretch; gap: 10px; border-top: 1px solid var(--border); background: var(--page); padding: 8px 12px; }
    .dock-controls { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end; gap: 4px; flex: 0 1 auto; min-width: 0; margin-left: auto; min-height: var(--edh); font-size: max(14px, calc(14px * var(--z) * 0.85)); }
    .dock-controls button, .dock-controls select { min-height: 0; padding: 3px 8px; }
    .dock-controls .indicator { padding: 2px 8px; }
    .history { overflow: auto; min-height: 0; padding: 10px 12px 4px; }
    .empty { color: var(--muted); height: 100%; display: grid; place-items: center; }
    .turn { margin-bottom: 4px; }
    .turn.selected .prompt-bar { outline: 1px solid #6d6527; outline-offset: -1px; }
    .prompt-bar { width: 100%; height: 1.65em; border: 1px solid #eadf90; background: var(--yellow); color: #14120a; display: block; text-align: left; padding: 1px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; cursor: pointer; }
    .prompt-bar.prompt-expanded { height: auto; min-height: 1.65em; overflow: visible; text-overflow: clip; white-space: pre-wrap; }
    .response { margin: 4px 0 8px; border-left: 3px solid var(--border); padding: 8px 10px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: calc(14px * var(--z)); background: var(--surface); overflow-wrap: anywhere; }
    .response.error { border-left-color: #c62828; }
    .error-note { margin-top: 10px; background: #fdecec; border: 1px solid #f0bcbc; border-radius: 6px; padding: 8px 10px; color: #731b1b; }
    .response .search-line { background: #cfe8ff; }
    .prompt-bar.search-hit { background: #cfe8ff; border-color: #9cc4e8; }
    .bottom-spacer { flex: none; height: 0; }
    textarea { resize: none; flex: 1 1 260px; min-width: 180px; height: auto; min-height: var(--edh); border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 10px 11px; font: calc(14px * var(--z))/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
    textarea:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
    .bar { display: flex; gap: 8px; align-items: center; }
    .stats { display: flex; gap: 12px; align-items: center; }
    .sep { color: var(--muted); }
    .group { display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap; }
    button, select { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); min-height: 31px; padding: 5px 10px; font: inherit; }
    button { cursor: pointer; }
    button:hover:not(:disabled), select:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .status { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .indicator { border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-weight: 700; white-space: nowrap; }
    .indicator.done { color: var(--done); border-color: rgba(12,107,50,0.45); background: #ecf7ef; }
    .indicator.active { color: #785b00; border-color: #d6b642; background: #fff8d8; }
    .footer { display: flex; gap: 8px; align-items: center; }
    #cap.armed { background: var(--yellow); border-color: #d6b642; font-weight: 700; }
    @media (max-width: 760px) { .stats { flex-wrap: wrap; } .status { white-space: normal; } }
  </style>
</head>
<body>
  <div class="shell">
    <div id="history" class="history"><div class="empty"></div></div>
    <div class="dock">
      <textarea id="prompt" spellcheck="true"></textarea>
      <div class="dock-controls">
        <div class="stats"><div class="status" id="turns"></div><span class="sep">|</span><div class="status" id="context"></div><span class="sep">|</span><div class="status" id="cost"></div><span class="sep">|</span><div class="status" id="duration"></div></div>
        <div class="bar">
          <div class="group"><select id="model"></select><select id="effort"></select><button id="send">Send</button><button id="stop">Stop</button></div>
        </div>
        <div class="footer">
          <div id="finish" class="indicator">Ready</div>
          <div class="group"><button id="top">Top</button><button id="bottom">Bottom</button><button id="prev">Prev</button><button id="next">Next</button><button id="load">Load</button><button id="cap">Cap</button></div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
    const sessionId = ${safeSessionId};
    const models = ${models};
    const efforts = ${efforts};
    const defaultModel = ${defaultModel};
    const defaultEffort = ${defaultEffort};
    const contextWindow = ${contextWindow};
    const compactAt = Math.max(1000, contextWindow - ${compactReserve});
    const maxTurns = ${maxTurns};
    const TOOL_LINE_MARK = ${toolLineMark};
    let session = { id: sessionId, name: 'New session', turns: [] };
    let status = null;
    // When the last status arrived, so the elapsed time it carries can be run forward locally
    // between messages instead of sitting still through a long tool call.
    let statusAt = 0;
    // Sidebar search text; while non-empty, every line holding it gets a light-blue wash.
    let searchText = '';
    let expanded = new Set();
    let expandedPrompts = new Set();
    let toolGroupsVisible = true;
    let shownActiveTurn = null;
    let anchorIndex = 0;
    let selectedResponseToBottom = false;
    let selectedResponseToTop = false;
    let keepScroll = false;
    let initializedSelection = false;
    let pendingTurnCount = 0;
    let programmaticScroll = false;
    let scrollTimer = 0;
    let resizeTimer = 0;
    let draftSent = '';
    let draftTimer = 0;
    let selectionSent = -1;
    const historyBox = document.getElementById('history');
    const promptBox = document.getElementById('prompt');
    const modelSelect = document.getElementById('model');
    const effortSelect = document.getElementById('effort');
    const stopButton = document.getElementById('stop');
    const capButton = document.getElementById('cap');
    const finish = document.getElementById('finish');

    fillSelect(modelSelect, models, defaultModel);
    fillSelect(effortSelect, efforts, defaultEffort);
    // The pickers belong to the session, not the panel: every change is written back so
    // reopening this session later comes up on the same model and effort.
    modelSelect.addEventListener('change', sendPicks);
    effortSelect.addEventListener('change', sendPicks);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'sessionState') {
        session = message.session || session;
        status = message.status || null;
        statusAt = Date.now();
        if (typeof message.draft === 'string' && message.draft && !promptBox.value) {
          promptBox.value = message.draft;
          draftSent = message.draft;
        }
        if (typeof message.search === 'string') searchText = message.search;
        document.title = session.name || 'Claude2';
        render();
      } else if (message.type === 'turnDelta') {
        applyTurnDelta(message);
      } else if (message.type === 'searchState') {
        searchText = typeof message.text === 'string' ? message.text : '';
        render();
      } else if (message.type === 'focusPrompt') {
        promptBox.focus();
      } else if (message.type === 'capState') {
        capButton.disabled = false;
        capButton.classList.toggle('armed', !!message.armed);
      }
    });

    promptBox.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        submitPrompt();
      }
    });
    promptBox.addEventListener('input', () => {
      window.clearTimeout(draftTimer);
      draftTimer = window.setTimeout(() => sendDraft('draftChanged'), 250);
    });
    // Losing focus is the cue to name the session after an unsent draft.
    promptBox.addEventListener('blur', () => {
      window.clearTimeout(draftTimer);
      sendDraft('draftBlur');
    });
    document.getElementById('send').addEventListener('click', submitPrompt);
    stopButton.addEventListener('click', () => vscode.postMessage({ type: 'stopPrompt', sessionId }));
    document.getElementById('top').addEventListener('click', () => selectBlock(0));
    document.getElementById('bottom').addEventListener('click', () => selectBlock(session.turns.length - 1));
    document.getElementById('prev').addEventListener('click', () => selectBlock(anchorIndex - 1));
    document.getElementById('next').addEventListener('click', () => selectBlock(anchorIndex + 1));
    document.getElementById('load').addEventListener('click', loadSelectedPrompt);
    document.getElementById('cap').addEventListener('click', () => {
      // Armed means a screenshot is waiting to ride with the next Send; a second click discards it.
      capButton.disabled = true;
      vscode.postMessage({ type: capButton.classList.contains('armed') ? 'discardCapture' : 'captureScreen', sessionId });
    });
    historyBox.addEventListener('scroll', () => {
      if (programmaticScroll || !session.turns.length) return;
      window.clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(selectTopVisibleBlock, 80);
    });
    // The selected response's clamp and the bottom spacer are sized from the pane height,
    // so a pane resize has to re-derive them or the old clamp sticks.
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const response = historyBox.querySelector('[data-index="' + anchorIndex + '"] .response');
        const atBottom = response ? response.scrollHeight - response.scrollTop - response.clientHeight < 18 : false;
        syncSelectedBlock(false, atBottom, response ? response.scrollTop : 0);
      }, 80);
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

    function sendPicks() {
      vscode.postMessage({ type: 'picksChanged', sessionId, model: modelSelect.value, effort: effortSelect.value });
    }

    function sendDraft(type) {
      const draft = promptBox.value;
      if (type === 'draftChanged' && draft === draftSent) return;
      draftSent = draft;
      vscode.postMessage({ type, sessionId, draft });
    }

    function submitPrompt() {
      const prompt = promptBox.value;
      if (!prompt.trim() || (status && status.active)) return;
      vscode.postMessage({ type: 'submitPrompt', sessionId, prompt, model: modelSelect.value, effort: effortSelect.value });
      promptBox.value = '';
      draftSent = '';
      window.clearTimeout(draftTimer);
      // Older responses hide when a new prompt goes in; the new one shows while streaming and stays
      // open when finished until the next prompt, so the answer never vanishes the moment it lands.
      expanded = new Set();
      pendingTurnCount = session.turns.length + 1;
      selectedResponseToBottom = true;
    }

    function loadSelectedPrompt() {
      if (!session.turns.length) return;
      const turn = session.turns[Math.max(0, Math.min(session.turns.length - 1, anchorIndex))];
      if (!turn) return;
      promptBox.value = turn.prompt + (promptBox.value ? '\\n\\n' + promptBox.value : '');
      sendDraft('draftChanged');
      promptBox.focus();
    }

    // Response text is plain, except for a leading **bold** run on a line, used for a tool name and by
    // the model's own prose alike. Built as text nodes so nothing else in the response is treated as markup.
    // A toggle re-renders every response, so hiding tool groups drops those lines at build time:
    // no leading blanks, and runs of blank lines collapse to a single one. The streaming response
    // keeps its tool lines either way, since they are how the run's progress reads.
    function fillResponse(box, text, showTools) {
      let lines = text.split('\\n');
      if (!showTools) {
        const kept = [];
        for (const line of lines) {
          if (isToolLine(line)) continue;
          if (!line.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue;
          kept.push(line);
        }
        while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
        lines = kept;
      }
      lines.forEach((line, index) => {
        if (index) box.appendChild(document.createTextNode('\\n'));
        appendFormattedLine(box, line);
      });
    }

    function appendFormattedLine(box, line) {
        if (isToolLine(line)) line = line.slice(TOOL_LINE_MARK.length);
        // Search mode: a line holding the search text builds inside a washed span,
        // so the light blue covers exactly that line, wrapped continuations included.
        let target = box;
        if (matchesSearch(line)) {
          target = document.createElement('span');
          target.className = 'search-line';
          box.appendChild(target);
        }
        const bold = /^\\*\\*([^*]+)\\*\\*/.exec(line);
        if (!bold) {
          target.appendChild(document.createTextNode(line));
          return;
        }
        const name = document.createElement('b');
        name.textContent = bold[1];
        target.appendChild(name);
        target.appendChild(document.createTextNode(line.slice(bold[0].length)));
    }

    function matchesSearch(text) {
      return searchText !== '' && (text || '').toLowerCase().includes(searchText.toLowerCase());
    }

    // Tool lines carry an invisible marker from the runner. Bold alone is not the tell: the model
    // opens its own prose with **bold** runs too, and those are answer text that must never hide.
    function isToolLine(line) {
      return line.startsWith(TOOL_LINE_MARK);
    }

    function render() {
      const active = status && status.active;
      stopButton.disabled = !active;
      const turns = Array.isArray(session.turns) ? session.turns : [];
      anchorIndex = Math.max(0, Math.min(turns.length - 1, anchorIndex));
      // First non-empty state after the webview opens: land on the newest block, response open.
      if (!initializedSelection && turns.length) {
        initializedSelection = true;
        anchorIndex = turns.length - 1;
        expanded.add(turns[anchorIndex].id);
        selectedResponseToBottom = true;
      }
      if (pendingTurnCount && turns.length >= pendingTurnCount) {
        anchorIndex = pendingTurnCount - 1;
        selectedResponseToBottom = true;
        pendingTurnCount = 0;
      }
      const selectedResponse = historyBox.querySelector('[data-index="' + anchorIndex + '"] .response');
      const selectedResponseTop = selectedResponse ? selectedResponse.scrollTop : 0;
      const selectedResponseAtBottom = selectedResponse ? selectedResponse.scrollHeight - selectedResponse.scrollTop - selectedResponse.clientHeight < 18 : false;
      let newActiveTurn = false;
      if (active && status.turnId !== shownActiveTurn) {
        shownActiveTurn = status.turnId;
        expanded.add(status.turnId);
        const activeIndex = turns.findIndex((turn) => turn.id === status.turnId);
        if (activeIndex >= 0) {
          selectedResponseToBottom = selectedResponseToBottom || activeIndex !== anchorIndex;
          anchorIndex = activeIndex;
        }
        newActiveTurn = true;
      }
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
          bar.className = 'prompt-bar' + (expandedPrompts.has(turn.id) ? ' prompt-expanded' : '');
          if (matchesSearch(turn.prompt) || matchesSearch(turn.response)) bar.classList.add('search-hit');
          bar.title = turn.prompt;
          bar.textContent = turn.prompt || '(empty prompt)';
          bar.addEventListener('click', (event) => {
            if (event.ctrlKey) {
              if (expandedPrompts.has(turn.id)) expandedPrompts.delete(turn.id); else expandedPrompts.add(turn.id);
              selectBlock(index);
              return;
            }
            if (expanded.has(turn.id)) expanded.delete(turn.id); else expanded.add(turn.id);
            // A bar other than the selected one opens where it sits: selection and scroll stay put.
            if (index !== anchorIndex) {
              keepScroll = true;
              render();
              return;
            }
            selectBlock(index);
          });
          wrapper.appendChild(bar);
          const isActiveTurn = active && status.turnId === turn.id;
          if (expanded.has(turn.id) || isActiveTurn) {
            const response = document.createElement('div');
            response.className = 'response' + (turn.error ? ' error' : '');
            // A run that failed part way still wrote everything up to that point, so the text stays
            // and the reason goes underneath it rather than in its place.
            fillResponse(response, turn.response || '', toolGroupsVisible || isActiveTurn);
            if (turn.error) {
              const note = document.createElement('div');
              note.className = 'error-note';
              note.textContent = turn.error;
              response.appendChild(note);
            }
            response.addEventListener('click', () => {
              // A click that ends a text-selection drag is a copy, not a toggle.
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed) return;
              toolGroupsVisible = !toolGroupsVisible;
              // Hiding shrinks the text, so a kept scroll offset lands nowhere useful:
              // start the condensed prose from its first line.
              if (!toolGroupsVisible) selectedResponseToTop = true;
              render();
            });
            wrapper.appendChild(response);
          }
          historyBox.appendChild(wrapper);
        });
        const spacer = document.createElement('div');
        spacer.className = 'bottom-spacer';
        historyBox.appendChild(spacer);
      }
      const responseToTop = selectedResponseToTop;
      selectedResponseToTop = false;
      const responseToBottom = !responseToTop && (selectedResponseToBottom || selectedResponseAtBottom || newActiveTurn);
      selectedResponseToBottom = false;
      const align = !keepScroll;
      keepScroll = false;
      requestAnimationFrame(() => syncSelectedBlock(align, responseToBottom, responseToTop ? 0 : selectedResponseTop));
      noteSelection();
      renderStatus();
    }

    function renderStatus() {
      const active = status && status.active;
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const latest = turns[turns.length - 1];
      // Context is a level, so it holds at wherever the conversation last sat. Turns that errored
      // before an API call carry no level, hence the scan back rather than reading only the latest.
      const used = active ? status.contextTokens : turns.reduce((level, turn) => turn.contextUsed || level, 0);
      // Against the compaction point, not the window: the conversation is summarised there, so that
      // is the ceiling the level is really climbing towards. Only the denominator carries the K.
      document.getElementById('context').textContent = 'ctx ' + Math.round((used || 0) / 1000) + '/' + inK(compactAt);
      const turnsSoFar = active ? status.turns || 0 : (latest ? latest.turns || 0 : 0);
      const turnLimit = active ? status.maxTurns || maxTurns : ((latest && latest.maxTurns) || maxTurns);
      document.getElementById('turns').textContent = 'turns ' + turnsSoFar + '/' + turnLimit;
      // Cost and time are flows, so every turn of the conversation adds in. The running turn has
      // neither recorded yet, so its elapsed time is carried separately and its cost lands at the end.
      const cost = turns.reduce((sum, turn) => sum + (turn.costUsd || 0), 0);
      const saved = turns.reduce((sum, turn) => sum + (turn.graftSaved || 0), 0) + (active ? status.graftSaved || 0 : 0);
      // What the run would have cost had graft not held those tokens back, priced at what this
      // conversation actually paid per token sent. A floor: tokens graft kept out of the prompt
      // would have been re-sent on every later call too, which this does not try to model.
      const sent = turns.reduce((sum, turn) => sum + (turn.tokensIn || 0) + (turn.tokensOut || 0), 0);
      const wouldHave = sent > 0 ? cost + saved * (cost / sent) : cost;
      document.getElementById('cost').textContent = '$' + cost.toFixed(2) + '/' + wouldHave.toFixed(2);
      const spent = turns.reduce((sum, turn) => sum + (turn.durationMs || 0), 0);
      document.getElementById('duration').textContent = shortTime(spent + (active ? liveElapsed() : 0));
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

    function inK(tokens) {
      return Math.round((tokens || 0) / 1000) + 'K';
    }

    // m:ss, with the minutes free to run past 60 rather than rolling over into hours.
    function shortTime(ms) {
      const total = Math.max(0, Math.round((ms || 0) / 1000));
      return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
    }

    // The running turn's elapsed time, run forward from the last status so it still counts up
    // while a long tool call keeps the stream quiet.
    function liveElapsed() {
      return (status.elapsedMs || 0) + Math.max(0, Date.now() - statusAt);
    }

    // Nothing arrives from the extension between API calls, so the clock ticks on its own.
    window.setInterval(() => {
      if (status && status.active) renderStatus();
    }, 250);

    // A streaming delta refills only the one growing response box. The full render, with its
    // whole-history rebuild, is kept for structure: the first delta of a run (which anchors and
    // opens the new block), a box not in the DOM, or a reopened webview that lost the session
    // and has to ask for all of it again.
    function applyTurnDelta(message) {
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const turn = turns.find((entry) => entry.id === message.turnId);
      if (!turn) {
        vscode.postMessage({ type: 'conversationReady', sessionId });
        return;
      }
      status = message.status || status;
      statusAt = Date.now();
      if (message.delta) turn.response = (turn.response || '') + message.delta;
      const node = historyBox.querySelector('[data-turn-id="' + message.turnId + '"]');
      const response = node ? node.querySelector('.response') : null;
      if (!response || (status && status.active && status.turnId !== shownActiveTurn)) {
        render();
        return;
      }
      if (message.delta) {
        const atBottom = response.scrollHeight - response.scrollTop - response.clientHeight < 18;
        const savedTop = response.scrollTop;
        response.replaceChildren();
        fillResponse(response, turn.response || '', true);
        if (Number(node.dataset.index) === anchorIndex) {
          requestAnimationFrame(() => syncSelectedBlock(false, atBottom, savedTop));
        }
      }
      renderStatus();
    }

    // The md pane renders whichever response box is selected here, so every move of the
    // selection is reported; the extension holds the index until that pane asks for it.
    function noteSelection() {
      if (!session.turns.length || anchorIndex === selectionSent) return;
      selectionSent = anchorIndex;
      vscode.postMessage({ type: 'selectionChanged', sessionId, index: anchorIndex });
    }

    function selectBlock(index) {
      if (!session.turns.length) return;
      const nextIndex = Math.max(0, Math.min(session.turns.length - 1, index));
      selectedResponseToBottom = selectedResponseToBottom || nextIndex !== anchorIndex;
      // Deliberate navigation outranks a submit's queued jump to the not-yet-arrived turn.
      pendingTurnCount = 0;
      anchorIndex = nextIndex;
      render();
    }

    function selectTopVisibleBlock() {
      const nodes = Array.from(historyBox.querySelectorAll('.turn'));
      if (!nodes.length) return;
      const historyTop = historyBox.getBoundingClientRect().top;
      let bestIndex = anchorIndex;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom < historyTop) continue;
        const distance = Math.abs(rect.top - historyTop);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = Number(node.dataset.index) || 0;
        }
      }
      if (bestIndex !== anchorIndex) {
        anchorIndex = bestIndex;
        syncSelectedBlock(true, true, 0);
        noteSelection();
      }
    }

    function syncSelectedBlock(align, responseToBottom, responseTop) {
      const spacer = historyBox.querySelector('.bottom-spacer');
      if (spacer) spacer.style.height = '0px';
      // Only the selected block is clamped; scrub leftover clamps so a block deselected by
      // manual scrolling (no re-render) returns to its natural size, and so the measurements
      // below see this block's natural height.
      historyBox.querySelectorAll('.turn').forEach((turn) => {
        turn.classList.remove('selected');
        turn.querySelectorAll('.prompt-bar, .response').forEach((part) => {
          part.style.maxHeight = '';
          part.style.overflowY = '';
        });
      });
      const node = historyBox.querySelector('[data-index="' + anchorIndex + '"]');
      if (!node) return;
      node.classList.add('selected');
      const bar = node.querySelector('.prompt-bar');
      const response = node.querySelector('.response');
      if (bar && bar.classList.contains('prompt-expanded') && node.offsetHeight > historyBox.clientHeight) {
        const lineHeight = parseFloat(getComputedStyle(bar).lineHeight) || 20;
        bar.style.maxHeight = Math.ceil(lineHeight * 3 + 4) + 'px';
        bar.style.overflowY = 'auto';
      }
      if (response && node.offsetHeight > historyBox.clientHeight) {
        const available = Math.max(48, historyBox.clientHeight - (bar ? bar.offsetHeight : 0) - 16);
        response.style.maxHeight = available + 'px';
        response.style.overflowY = 'auto';
      }
      // Pad only enough for the selected block to reach the top: pane height minus everything
      // from the selected block down. Sizing from the block alone bloats the pane whenever a
      // short block is selected above taller ones.
      if (spacer) spacer.style.height = Math.max(0, historyBox.clientHeight - (spacer.offsetTop - node.offsetTop)) + 'px';
      if (align) {
        programmaticScroll = true;
        window.clearTimeout(scrollTimer);
        node.scrollIntoView({ block: 'start' });
        window.setTimeout(() => { programmaticScroll = false; }, 80);
      }
      if (response) {
        if (responseToBottom && response.scrollHeight > response.clientHeight) response.scrollTop = response.scrollHeight;
        else response.scrollTop = responseTop || 0;
      }
    }

    vscode.postMessage({ type: 'conversationReady', sessionId });
  </script>
</body>
</html>`;
}

export function managementHtml(webview: vscode.Webview, pane: ManagementPane, timezone: string, graftPage: string | null = null, zoom = 1): string {
  if (pane === "graft") {
    return graftPage ?? graftFailedHtml();
  }
  if (pane === "markdown") {
    return markdownHtml(webview, zoom);
  }
  if (pane === "cap") {
    return capHtml(webview, zoom);
  }
  return pane === "instructions" ? instructionsHtml(webview, zoom) : quotaHtml(webview, timezone, zoom);
}

// The Cap pane shows the most recent desktop capture. The image arrives as a data URI in the
// loadCapture reply: the PNG lives in a temp dir outside any localResourceRoots, so a file URI
// could not load, and this also keeps working when the capture was taken on another machine.
function capHtml(webview: vscode.Webview, zoom: number): string {
  const nonce = getNonce();
  const z = zoomFactor(zoom);
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --wash: rgba(0,0,0,0.08); --z: 1; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(16px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 20px 24px; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; margin-bottom: 12px; min-width: 0; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; margin: 0; flex: none; }
    .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; font: calc(14px * var(--z))/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .actions { margin-left: auto; display: flex; gap: 12px; flex: none; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 14px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .frame { flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); display: grid; place-items: center; overflow: auto; padding: 8px; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <div class="pane">
    <div class="title"><h1>Capture</h1><span id="path" class="path"></span><div class="actions"><button id="reload">Reload</button><button id="close">Close</button></div></div>
    <div class="frame"><img id="shot" hidden><div id="empty" hidden></div></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
    const img = document.getElementById('shot');
    const empty = document.getElementById('empty');
    const pathLabel = document.getElementById('path');
    const pending = new Map();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        pending.get(message.requestId)(message);
        pending.delete(message.requestId);
      } else if (message.type === 'captureChanged') {
        void load();
      }
    });
    document.getElementById('reload').addEventListener('click', () => void load());
    document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'closeManagement' }));
    void load();

    function request(type, payload) {
      const requestId = String(Date.now()) + Math.random();
      return new Promise((resolve) => { pending.set(requestId, resolve); vscode.postMessage(Object.assign({ type, requestId }, payload)); });
    }

    async function load() {
      const reply = await request('loadCapture', {});
      const payload = reply.ok ? reply.payload : null;
      if (payload && payload.dataUri) {
        img.src = payload.dataUri;
        img.hidden = false;
        empty.hidden = true;
        pathLabel.textContent = payload.path || '';
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        empty.hidden = false;
        empty.textContent = reply.ok ? 'No capture to show yet — click Cap in a conversation.' : 'Could not load the capture: ' + (reply.error || 'unknown error');
        pathLabel.textContent = '';
      }
    }
  </script>
</body>
</html>`;
}

// The Graft pane shows the self-contained page from `graft viz --export`, run by
// the extension at open time; this fallback appears only when that export fails.
function graftFailedHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { margin: 0; height: 100vh; display: grid; place-items: center; background: #f9f9f7; color: #000; font: 14px/1.45 Aptos, "Segoe UI", sans-serif; }
  </style>
</head>
<body><div>graft viz export failed — see the Claude2 output channel. Click Graft again to retry.</div></body>
</html>`;
}

function instructionsHtml(webview: vscode.Webview, zoom: number): string {
  const nonce = getNonce();
  const z = zoomFactor(zoom);
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --error: #fdecec; --wash: rgba(0,0,0,0.08); --z: 1; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(16.8px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 28px 32px; max-width: 900px; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; margin-bottom: 16px; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; letter-spacing: 0; margin: 0; }
    .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    .hint { color: var(--muted); font-size: calc(14.4px * var(--z)); }
    label { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 140px; }
    .path { color: var(--muted); font-size: calc(14.4px * var(--z)); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    textarea { flex: 1; resize: none; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 9px 11px; font: calc(14px * var(--z))/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
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
${zoomScript(z)}
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

// The md pane renders the conversation's selected response box as markdown. The text is whatever
// that box holds, so the renderer is deliberately small: the blocks Claude actually emits
// (headings, fences, lists, quotes, tables, rules) and the inline runs inside them.
function markdownHtml(webview: vscode.Webview, zoom: number): string {
  const nonce = getNonce();
  const z = zoomFactor(zoom);
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --wash: rgba(0,0,0,0.08); --z: 1; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(16px * var(--z))/1.55 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 20px 28px 24px; max-width: 980px; }
    .title { display: flex; align-items: baseline; gap: 12px; flex: none; margin-bottom: 12px; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; margin: 0; }
    .prompt { flex: 1; min-width: 0; font-size: calc(14px * var(--z)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 14px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .doc { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 16px 20px; }
    .doc > :first-child { margin-top: 0; }
    .doc h1, .doc h2 { font-size: calc(18px * var(--z)); font-weight: 700; margin: 20px 0 8px; padding-bottom: 3px; border-bottom: 1px solid var(--border); }
    .doc h3, .doc h4, .doc h5, .doc h6 { font-size: calc(16px * var(--z)); font-weight: 700; margin: 16px 0 6px; }
    .doc p { margin: 0 0 10px; }
    .doc ul, .doc ol { margin: 0 0 10px; padding-left: 26px; }
    .doc li { margin: 3px 0; }
    .doc li > ul, .doc li > ol { margin: 3px 0 0; }
    .doc blockquote { margin: 0 0 10px; border-left: 3px solid var(--border); padding: 2px 12px; }
    .doc hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
    .doc a { color: #0b4f9c; }
    .doc code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: calc(14px * var(--z)); background: rgba(0,0,0,0.05); border-radius: 4px; padding: 1px 4px; }
    .doc pre { background: #f2f1ec; border: 1px solid var(--border); border-radius: 8px; margin: 0 0 12px; padding: 10px 12px; overflow: auto; }
    .doc pre code { background: none; padding: 0; white-space: pre; }
    .doc table { border-collapse: collapse; margin: 0 0 12px; font-size: calc(14px * var(--z)); }
    .doc th, .doc td { border: 1px solid var(--border); padding: 5px 10px; text-align: left; }
    .doc th { background: rgba(0,0,0,0.05); }
    .empty { font-size: calc(16px * var(--z)); }
  </style>
</head>
<body>
  <div class="pane">
    <div class="title"><h1>Markdown</h1><span id="prompt" class="prompt"></span><button id="close">Close</button></div>
    <div id="doc" class="doc"><p class="empty">No response selected.</p></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
    const docBox = document.getElementById('doc');
    const promptLabel = document.getElementById('prompt');
    const pending = new Map();
    let shownTurnId = null;
    let shownText = null;

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        const resolve = pending.get(message.requestId);
        pending.delete(message.requestId);
        resolve(message);
      } else if (message.type === 'selectedResponse') {
        show(message.payload);
      }
    });
    document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'closeManagement' }));

    function request(type, payload) {
      const requestId = String(Date.now()) + '-' + String(Math.random()).slice(2);
      return new Promise((resolve) => { pending.set(requestId, resolve); vscode.postMessage(Object.assign({ type, requestId }, payload)); });
    }

    // Called on every selection move and on every streaming delta, so the same text arriving twice
    // must not repaint: a rebuilt doc drops the reader's place. A response growing under the same
    // turn keeps its scroll (sticking to the tail if it was already there); a different turn starts
    // at the top.
    function show(payload) {
      promptLabel.textContent = payload && payload.prompt ? payload.prompt.split('\\n')[0] : '';
      if (!payload) {
        if (shownTurnId === null && shownText === null) return;
        shownTurnId = null;
        shownText = null;
        docBox.innerHTML = '<p class="empty">No response selected.</p>';
        return;
      }
      const text = payload.text || '';
      const sameTurn = payload.turnId === shownTurnId;
      if (sameTurn && text === shownText) return;
      const atBottom = docBox.scrollHeight - docBox.scrollTop - docBox.clientHeight < 18;
      const savedTop = docBox.scrollTop;
      shownTurnId = payload.turnId;
      shownText = text;
      docBox.innerHTML = text.trim() ? renderMarkdown(text) : '<p class="empty">The selected response is empty.</p>';
      if (!sameTurn) docBox.scrollTop = 0;
      else if (atBottom) docBox.scrollTop = docBox.scrollHeight;
      else docBox.scrollTop = savedTop;
    }

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Inline runs. Code spans are lifted out first so nothing inside them is treated as markup,
    // and only http(s) links are kept as links.
    function inline(text) {
      const codes = [];
      let out = escapeHtml(text).replace(/\\\`([^\\\`]+)\\\`/g, (match, code) => {
        codes.push(code);
        return '\\u0000' + (codes.length - 1) + '\\u0000';
      });
      out = out.replace(/!\\[([^\\]]*)\\]\\([^)]*\\)/g, '$1');
      out = out.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2">$1</a>');
      out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      out = out.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
      out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      return out.replace(/\\u0000(\\d+)\\u0000/g, (match, index) => '<code>' + codes[Number(index)] + '</code>');
    }

    // The offset is where the item's text starts, which is how far a continuation line under it
    // is indented; the indent is the marker's own column, which is what nesting goes by.
    function listItemOf(line) {
      const bullet = /^(\\s*)[-*+]\\s+(.*)$/.exec(line);
      if (bullet) return { indent: bullet[1].length, offset: line.length - bullet[2].length, ordered: false, text: bullet[2] };
      const numbered = /^(\\s*)\\d+[.)]\\s+(.*)$/.exec(line);
      if (numbered) return { indent: numbered[1].length, offset: line.length - numbered[2].length, ordered: true, text: numbered[2] };
      return null;
    }

    function buildList(items) {
      const parts = [];
      let index = 0;
      while (index < items.length) {
        const item = items[index];
        const nested = [];
        let next = index + 1;
        while (next < items.length && items[next].indent > item.indent) { nested.push(items[next]); next++; }
        const body = item.lines.join('\\n');
        let inner = item.lines.length > 1 ? renderMarkdown(body) : inline(body);
        if (nested.length) inner += buildList(nested);
        parts.push('<li>' + inner + '</li>');
        index = next;
      }
      return '<' + (items[0].ordered ? 'ol' : 'ul') + '>' + parts.join('') + '</' + (items[0].ordered ? 'ol' : 'ul') + '>';
    }

    function tableRow(line) {
      const trimmed = line.trim().replace(/^\\|/, '').replace(/\\|$/, '');
      return trimmed.split('|').map((cell) => cell.trim());
    }

    function renderMarkdown(text) {
      const lines = String(text).replace(/\\r\\n/g, '\\n').split('\\n');
      const out = [];
      let paragraph = [];
      const flush = () => {
        if (!paragraph.length) return;
        out.push('<p>' + inline(paragraph.join('\\n')).replace(/\\n/g, '<br>') + '</p>');
        paragraph = [];
      };
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        const fence = /^\\s*(\\\`{3,}|~{3,})/.exec(line);
        if (fence) {
          flush();
          const marker = fence[1].charAt(0);
          const body = [];
          index++;
          while (index < lines.length && !new RegExp('^\\\\s*' + marker + '{3,}\\\\s*$').test(lines[index])) { body.push(lines[index]); index++; }
          index++;
          out.push('<pre><code>' + escapeHtml(body.join('\\n')) + '</code></pre>');
          continue;
        }
        if (!line.trim()) { flush(); index++; continue; }
        const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
        if (heading) {
          flush();
          const level = heading[1].length;
          out.push('<h' + level + '>' + inline(heading[2].replace(/\\s+#+\\s*$/, '')) + '</h' + level + '>');
          index++;
          continue;
        }
        if (/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) { flush(); out.push('<hr>'); index++; continue; }
        if (/^\\s*>/.test(line)) {
          flush();
          const quoted = [];
          while (index < lines.length && (/^\\s*>/.test(lines[index]) || (quoted.length && lines[index].trim()))) {
            quoted.push(lines[index].replace(/^\\s*>\\s?/, ''));
            index++;
          }
          out.push('<blockquote>' + renderMarkdown(quoted.join('\\n')) + '</blockquote>');
          continue;
        }
        if (line.indexOf('|') >= 0 && index + 1 < lines.length && /^\\s*\\|?[\\s:-]*-[\\s|:-]*$/.test(lines[index + 1]) && lines[index + 1].indexOf('-') >= 0) {
          flush();
          const head = tableRow(line);
          index += 2;
          const rows = [];
          while (index < lines.length && lines[index].indexOf('|') >= 0 && lines[index].trim()) { rows.push(tableRow(lines[index])); index++; }
          const headHtml = '<tr>' + head.map((cell) => '<th>' + inline(cell) + '</th>').join('') + '</tr>';
          const bodyHtml = rows.map((row) => '<tr>' + row.map((cell) => '<td>' + inline(cell) + '</td>').join('') + '</tr>').join('');
          out.push('<table>' + headHtml + bodyHtml + '</table>');
          continue;
        }
        if (listItemOf(line)) {
          flush();
          const items = [];
          while (index < lines.length) {
            const item = listItemOf(lines[index]);
            // Bullets switching to numbers (or back) at the top level start a new list rather
            // than joining this one, which would take the tag of whichever came first.
            if (item && items.length && item.indent <= items[0].indent && item.ordered !== items[0].ordered) break;
            if (item) { items.push({ indent: item.indent, offset: item.offset, ordered: item.ordered, lines: [item.text] }); index++; continue; }
            const owner = items[items.length - 1];
            // A blank line inside a list is kept only when a list line or an indented
            // continuation follows it; an indented line that is not a new item continues
            // the item above, keeping any indentation past the item's own.
            const after = lines[index + 1] || '';
            if (!lines[index].trim() && owner && (listItemOf(after) || /^\\s{2,}\\S/.test(after))) { owner.lines.push(''); index++; continue; }
            if (owner && /^\\s{2,}\\S/.test(lines[index])) {
              const lead = lines[index].length - lines[index].replace(/^\\s+/, '').length;
              owner.lines.push(lines[index].slice(Math.min(lead, owner.offset)));
              index++;
              continue;
            }
            break;
          }
          out.push(buildList(items));
          continue;
        }
        paragraph.push(line);
        index++;
      }
      flush();
      return out.join('');
    }

    void request('loadSelectedResponse', {}).then((reply) => show(reply.ok ? reply.payload : null));
  </script>
</body>
</html>`;
}

function quotaHtml(webview: vscode.Webview, timezone: string, zoom: number): string {
  const nonce = getNonce();
  const safeTimezone = JSON.stringify(timezone);
  const z = zoomFactor(zoom);
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --grid: rgba(0,0,0,0.15); --wash: rgba(0,0,0,0.08); --blue: #2457d6; --red: #c62828; --z: 1; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(16px * var(--z))/1.4 Aptos, "Segoe UI", sans-serif; }
    .pane { height: 100vh; display: flex; flex-direction: column; gap: 16px; padding: 28px 32px; }
    .pane.expanded { max-width: none; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; margin: 0; letter-spacing: 0; }
    .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: calc(14px * var(--z)); }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 13px; min-height: 34px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .graphs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; align-items: start; min-height: 0; overflow: auto; }
    .graphs.single { display: flex; flex: 1; min-height: 0; }
    .graph { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 11px; min-width: 0; }
    .graphs.single .graph { flex: 1; display: flex; flex-direction: column; min-height: 0; }
    .graph-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .graph-name { font-weight: 700; }
    .legend { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: calc(14px * var(--z)); }
    .swatch { width: 12px; height: 2px; display: inline-block; background: var(--ink); vertical-align: middle; }
    .swatch.blue { background: var(--blue); } .swatch.red { background: var(--red); }
    .period { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
    .period button { min-height: 26px; padding: 2px 8px; }
    .plot { position: relative; width: 100%; aspect-ratio: 320 / 200; border: 1px solid var(--border); cursor: pointer; background: #fff; }
    .graphs.single .plot { flex: 1; min-height: 260px; aspect-ratio: auto; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    svg text { font-size: calc(14px * var(--z)); fill: var(--muted); text-anchor: end; }
    .figures { margin-top: 8px; color: var(--muted); font-size: calc(14px * var(--z)); font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
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
${zoomScript(z)}
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

// Text zoom, shared by every pane that scripts its own HTML. Each pane multiplies its authored font
// sizes by the --z factor this sets, so stepping the one value scales the whole pane. The level is
// reported to the extension, which stores it and seeds `initial` here when the pane is rebuilt --
// webview state alone would not survive a window reload, since the panels are not serialized.
// Requires the pane's script to have already declared `vscode`; drop it in right after acquireVsCodeApi().
function zoomScript(initial: number): string {
  return `
    const MIN_ZOOM = 0.8;
    const MAX_ZOOM = 2;
    const ZOOM_STEP = 0.1;
    let zoom = ${zoomFactor(initial)};

    function applyZoom(next) {
      zoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)) * 100) / 100;
      document.documentElement.style.setProperty('--z', String(zoom));
      vscode.postMessage({ type: 'zoom', zoom });
    }

    window.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (event.deltaY) applyZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }, { passive: false });

    window.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const step = event.key === '-' || event.key === '_' ? -ZOOM_STEP : event.key === '=' || event.key === '+' ? ZOOM_STEP : 0;
      if (!step && event.key !== '0') return;
      event.preventDefault();
      event.stopPropagation();
      applyZoom(step ? zoom + step : 1);
    });

    applyZoom(zoom);
`;
}

// The stored level reaches the pane twice: as the `--z` seed on <html> (so the pane paints at the
// right size instead of flashing at 1) and as the zoomScript starting value.
export function zoomFactor(value: unknown): number {
  const zoom = typeof value === "number" ? value : Number(value);
  return Number.isFinite(zoom) && zoom >= 0.8 && zoom <= 2 ? Math.round(zoom * 100) / 100 : 1;
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}