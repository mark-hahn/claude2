import * as vscode from "vscode";
import type { ModelInfo } from "./modelInfo";
import { permissionModes } from "./settings";
import { ANSWER_MARK, CLAUDE2_COMPACT_RESERVE, DEFAULT_EFFORT, GRAFT_TALLY_MARK, TOOL_LINE_MARK } from "./types";

export type ManagementPane = "instructions" | "quota" | "plugins" | "models" | "settings" | "cap";

export interface ConversationDefaults {
  model: string;
  effort: string;
  advisor: string;
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
    .row.sessions-row { gap: 5.6px; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; min-height: 31px; cursor: pointer; }
    .top button { height: 25px; min-height: 0; flex: none; padding: 0; }
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    /* The same grey-out the footer's dock controls use: label and border fade together, so the
       two never disagree about whether the button does anything. */
    button:disabled { color: #bfbfbf; border-color: #bfbfbf; cursor: default; }
    #new { width: 42px; }
    /* Drawn rather than typed: font glyphs stay thin even bold, and the + sits low. currentColor keeps the grey-out. */
    #new svg, #export svg { display: block; margin: 0 auto; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    /* Icon buttons hug their glyph. */
    #mngmnt, #export { padding: 0 6px; }
    #mngmnt { font-size: 16px; }
    #mngmnt.alert { background: #fbd9d9; border-color: #e4a7a7; }
    #login { width: 64px; display: none; }
    #login.needed { display: block; background: #fbd9d9; border-color: #e4a7a7; }
    #login.needed:hover { background: #f5c7c7; }
    #close { width: 56px; }
    /* Grows past its Clean width for the "🗑 12" of a trash-list selection. */
    #clean { min-width: 52px; padding: 0 6px; }
    #trash { width: 54px; }
    #trash.active { background: #fbd9d9; border-color: #e4a7a7; }
    #trash.active:hover { background: #f5c7c7; }
    #sessionCounts { margin-left: 8px; margin-right: 2px; align-self: center; font-size: 15.12px; color: var(--ink); }
    .search-row { display: flex; gap: 7px; }
    #searchBox { flex: 1; min-width: 0; box-sizing: border-box; height: 25px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); font: inherit; }
    #searchBox::placeholder { color: var(--ink); }
    #searchBox.searching { background: #cfe8ff; }
    #searchClear { width: 25px; }
    .sessions { overflow: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding-right: 2px; }
    .card { position: relative; box-sizing: border-box; flex: none; width: 100%; text-align: left; white-space: normal; min-height: 42px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); cursor: pointer; user-select: none; }
    .card:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .card.selected { background: #fbf3c4; border-color: #ddd08a; }
    .card.selected:hover { background: linear-gradient(var(--wash), var(--wash)), #fbf3c4; }
    .card.trashed.selected { background: #fce4ec; border-color: #eab3c6; }
    .card.trashed.selected:hover { background: linear-gradient(var(--wash), var(--wash)), #fce4ec; }
    .card-actions { position: absolute; right: 6px; bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .card-trash { display: none; border: none; background: transparent; min-height: 0; padding: 2px 4px; font-size: 14px; line-height: 1; border-radius: 6px; }
    .card:hover .card-trash { display: block; }
    .card-trash:hover { background: #fbd9d9; }
    .card-turns { font-size: 14px; color: var(--ink); }
    .card-clock { display: flex; }
    .card-clock.running { color: #1a8f2e; }
    .card-clock.background { color: #d11a1a; }
    .card-restore { display: none; min-height: 0; padding: 3px 8px; font-size: 14px; border-radius: 6px; background: rgba(252,252,251,0.5); }
    .card .card-restore:hover { background: linear-gradient(var(--wash), var(--wash)), rgba(252,252,251,0.5); }
    .card:hover .card-restore { display: block; }
    .card-name { display: block; font-weight: 600; overflow-wrap: anywhere; }
    .card-rename { box-sizing: border-box; display: block; width: 100%; font: inherit; font-weight: 600; color: var(--ink); background: #fff; border: 1px solid #9a9a93; border-radius: 6px; padding: 1px 4px; }
    .card-meta { display: block; color: var(--muted); font-size: 14px; margin-top: 3px; }
    .card-hits { display: block; color: #0b5ed7; font-size: 14px; margin-top: 3px; }
    .empty { border: 1px dashed var(--border); border-radius: 8px; color: var(--muted); padding: 14px 10px; text-align: center; }
${tooltipStyle()}  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div class="row">
        <button id="mngmnt" title="Quotas, instructions, stats, and models">&#x2699;&#xFE0E;</button>
        <button id="new" title="New Claude2 session"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>
        <button id="export" title="Export the session up front to a markdown file in the project root" disabled><svg viewBox="0 0 16 16"><path d="M3 8h10M9.2 4.2 13 8l-3.8 3.8"/></svg></button>
        <button id="close" title="Close every session tab but the current one; again to close the last one, then the management pane" disabled>Close</button>
        <button id="login" title="Authorization expired: sign in to your Anthropic account again">Re-Auth</button>
      </div>
      <div class="row sessions-row">
        <button id="clean" title="Move every session to the trash">Clean</button>
        <button id="trash" title="Show trashed sessions (ctrl-click to trash every session)">Trash</button>
        <span id="sessionCounts" title="Active sessions / trashed sessions"></span>
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
${tooltipScript()}
    let sessions = [];
    let selectedId = '';
    // Session id -> 'running' (only sent for a session with its pane closed) or 'background'.
    let busy = {};
    let scrolledId = '';
    let showTrash = false;
    // Trashed cards picked for deletion, and the card a shift-click runs from. Trashed sessions
    // have no pane, so picking is all a click on one does.
    let picked = new Set();
    let pickAnchor = '';
    // An inline rename owns its card until it commits, so a background refresh waits
    // rather than yanking the input out from under the typing.
    let editingId = '';
    let pendingRender = false;
    // The one armed long press. render() replaces every card, so the press it belongs to ends
    // there: a timer left armed would start a rename on a card no longer in the page, one whose
    // input can't take focus and so never blurs, and editingId would hold off every render after.
    let pressTimer = 0;
    const list = document.getElementById('sessions');
    const trashButton = document.getElementById('trash');
    // Clean on the active list; on the trash list it turns into the delete for the picked cards.
    const cleanButton = document.getElementById('clean');
    const sessionCounts = document.getElementById('sessionCounts');
    const searchBox = document.getElementById('searchBox');
    // Search mode is on while this is non-empty. Enter in the box starts it; the X, an
    // empty Enter, or any top button ends it. Card clicks leave it alone on purpose, so
    // the opened editors can show their highlighted lines.
    let searchText = '';

    document.getElementById('new').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'newSession' }); });
    document.getElementById('mngmnt').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'toggleManagement' }); });
    document.getElementById('login').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'login' }); });
    cleanButton.addEventListener('click', () => {
      const sessionIds = [...picked];
      clearSearch();
      if (showTrash) {
        vscode.postMessage({ type: 'deleteSessions', sessionIds });
        return;
      }
      vscode.postMessage({ type: 'discardEmpty' });
      vscode.postMessage({ type: 'trashAllSessions' });
    });
    document.getElementById('close').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'closeOtherSessions' }); });
    // The pane up front builds the markdown, since it is what knows how its boxes read.
    document.getElementById('export').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'exportActive', sessionId: selectedId }); });
    trashButton.addEventListener('click', (event) => {
      // Ctrl-click is the bulk action for whichever list is showing: on the active list
      // everything goes to the trash at once, on the trash list everything in it is
      // deleted for good (the extension asks first).
      if (event.ctrlKey) {
        clearSearch();
        vscode.postMessage({ type: 'discardEmpty' });
        vscode.postMessage({ type: showTrash ? 'deleteAllTrashed' : 'trashAllSessions' });
        return;
      }
      clearSearch();
      vscode.postMessage({ type: 'discardEmpty' });
      setShowTrash(!showTrash);
    });

    function setShowTrash(on) {
      showTrash = on;
      trashButton.classList.toggle('active', showTrash);
      trashButton.title = showTrash ? 'Show active sessions (ctrl-click to permanently delete every trashed session)' : 'Show trashed sessions (ctrl-click to trash every session)';
      render();
    }
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
    // about every change here, including the empty text that ends search mode. A search
    // of the trash list has no panes to tint: trashed sessions never have one.
    function setSearch(text) {
      searchText = text;
      searchBox.classList.toggle('searching', searchText !== '');
      vscode.postMessage({ type: 'searchChanged', text: showTrash ? '' : searchText });
      render();
    }

    function clearSearch() {
      if (!searchText) return;
      searchBox.value = '';
      setSearch('');
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      // A new session lives on the active list, so opening one leaves the trash list.
      if (message.type === 'showActive') {
        if (showTrash) setShowTrash(false);
        return;
      }
      if (message.type === 'sessions') {
        sessions = Array.isArray(message.sessions) ? message.sessions : [];
        selectedId = typeof message.selectedId === 'string' ? message.selectedId : '';
        busy = message.busy || {};
        document.getElementById('login').classList.toggle('needed', message.authNeeded === true);
        // Close has nothing to close with no Claude2 pane up.
        document.getElementById('close').disabled = message.panesOpen !== true;
        // The CLI's model list changed since the Models tab was last opened.
        document.getElementById('mngmnt').classList.toggle('alert', message.modelsAlert === true);
        // Nothing to export without a pane up front showing a session with runs in it.
        const selected = sessions.find((session) => session.id === selectedId);
        document.getElementById('export').disabled = !selected || !(selected.turns || []).length;
        if (editingId) {
          pendingRender = true;
          return;
        }
        render();
      }
    });

    function render() {
      window.clearTimeout(pressTimer);
      list.replaceChildren();
      // Header tally: active sessions over trashed ones, whichever list is showing.
      const trashCount = sessions.filter((session) => session.trashed === true).length;
      sessionCounts.textContent = (sessions.length - trashCount) + '/' + trashCount;
      let selectedCard = null;
      const counts = new Map();
      // Search narrows whichever list is showing; a name-only match carries a zero count.
      const visible = sessions.filter((session) => {
        if ((session.trashed === true) !== showTrash) return false;
        if (!searchText) return true;
        const count = matchCount(session);
        if (!count && !(session.name || '').toLowerCase().includes(searchText.toLowerCase())) return false;
        counts.set(session.id, count);
        return true;
      });
      // Only a trashed card on show can stay picked, so the delete button never reaches one out of sight.
      const pickable = showTrash ? visible.map((session) => session.id) : [];
      picked = new Set(pickable.filter((id) => picked.has(id)));
      cleanButton.textContent = showTrash ? '\u{1F5D1}' + (picked.size ? ' ' + picked.size : '') : 'Clean';
      cleanButton.title = showTrash ? 'Permanently delete the selected trashed sessions' : 'Move every session to the trash';
      cleanButton.disabled = showTrash && picked.size === 0;
      if (visible.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = searchText ? 'No matches' : (showTrash ? 'Trash is empty' : 'No sessions yet');
        list.appendChild(empty);
        return;
      }
      visible.forEach((session) => {
        const trashed = showTrash;
        const card = document.createElement('div');
        card.className = trashed ? 'card trashed' : 'card';
        if (trashed ? picked.has(session.id) : session.id === selectedId) {
          card.classList.add('selected');
          if (!trashed) selectedCard = card;
        }
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        // The first prompt, which the name was made from; capped so a long one can't fill the pane.
        const prompt = ((session.turns || [])[0] || {}).prompt || 'No prompt.';
        card.dataset.tip = prompt.length > 800 ? prompt.slice(0, 800) + '…' : prompt;
        card.dataset.tipDelay = '1200';
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

        if (busy[session.id]) {
          const clock = document.createElement('span');
          clock.className = 'card-clock ' + busy[session.id];
          clock.title = busy[session.id] === 'background' ? 'Waiting on a background task (Stop ends it)' : 'Responding';
          clock.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
          actions.appendChild(clock);
        }

        // A trashed card is deleted for good only from the top delete button, by picking it.
        if (!trashed) {
          const trash = document.createElement('button');
          trash.className = 'card-trash';
          trash.textContent = '\u{1F5D1}';
          trash.title = 'Move this session to the trash';
          trash.addEventListener('pointerdown', (event) => event.stopPropagation());
          trash.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'trashSession', sessionId: session.id });
          });
          actions.appendChild(trash);
        } else {
          const restore = document.createElement('button');
          restore.className = 'card-restore';
          restore.textContent = 'R';
          restore.title = 'Move this session out of the trash';
          restore.addEventListener('pointerdown', (event) => event.stopPropagation());
          restore.addEventListener('click', (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: 'restoreSession', sessionId: session.id });
          });
          actions.appendChild(restore);
        }
        const turnCount = document.createElement('span');
        turnCount.className = 'card-turns';
        turnCount.textContent = String((session.turns || []).length);
        turnCount.title = 'Prompt turns';
        actions.appendChild(turnCount);
        card.appendChild(actions);

        let renamed = false;
        card.addEventListener('pointerdown', (event) => {
          // Alt-click is a copy, so it must not arm the long-press rename.
          if (event.altKey) {
            return;
          }
          // Clicking the card that is mid-rename only dismisses the editor (blur commits it);
          // it must not also open the session, and must not arm a second long press.
          renamed = editingId === session.id;
          if (renamed) {
            return;
          }
          window.clearTimeout(pressTimer);
          pressTimer = window.setTimeout(() => {
            renamed = true;
            startRename(name, session);
          }, 650);
        });
        for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
          card.addEventListener(eventName, () => window.clearTimeout(pressTimer));
        }
        card.addEventListener('click', (event) => {
          if (event.altKey && event.ctrlKey) {
            event.preventDefault();
            vscode.postMessage({ type: 'moveSessionToTop', sessionId: session.id });
            return;
          }
          if (event.altKey) {
            event.preventDefault();
            vscode.postMessage({ type: 'copyText', text: session.name || '' });
            card.animate([{ backgroundColor: '#ffc9c9' }, { backgroundColor: '#ffc9c9' }], 200);
            return;
          }
          if (renamed) {
            event.preventDefault();
            return;
          }
          if (trashed) {
            pick(session.id, event, pickable);
            render();
            return;
          }
          vscode.postMessage({ type: 'openSession', sessionId: session.id });
        });
        list.appendChild(card);
      });
      // Only chase the selection when it actually moves: a refresh mid-stream must not
      // yank the list back while the user is scrolling through other cards.
      if (selectedCard && selectedId !== scrolledId) {
        scrolledId = selectedId;
        selectedCard.scrollIntoView({ block: 'nearest' });
      }
    }

    // List selection over the trashed cards on show: a click picks just that card, ctrl-click
    // toggles it, shift-click adds the run from the anchor to whatever is already picked.
    function pick(id, event, ids) {
      if (event.shiftKey && ids.includes(pickAnchor)) {
        const from = ids.indexOf(pickAnchor), to = ids.indexOf(id);
        for (const run of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(run);
        return;
      }
      if (!event.ctrlKey) picked = new Set();
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      pickAnchor = id;
    }

    function startRename(nameEl, session) {
      if (editingId) {
        return;
      }
      // DEBUG: render() clears the press timer, so this should never trip. If the sidebar freezes
      // again, this line in the Claude2 output says whether a replaced card is still the cause.
      if (!nameEl.isConnected) {
        vscode.postMessage({ type: 'debugLog', text: 'long press fired on a replaced card ' + session.id.slice(0, 8) });
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

// `dist` is the extension's dist folder as a webview URI: the prompt editor's Monaco bundle,
// built there by esbuild.js, loads from it.
export function conversationHtml(webview: vscode.Webview, dist: string, sessionId: string, defaults: ConversationDefaults, info: ModelInfo, zoom = 1): string {
  const nonce = getNonce();
  const editorWorkerUrl = JSON.stringify(`${dist}/editorWorker.js`);
  const z = zoomFactor(zoom);
  const models = JSON.stringify(info.models);
  const presets = JSON.stringify(info.presets);
  const prefs = JSON.stringify(info.prefs);
  const safeSessionId = JSON.stringify(sessionId);
  const defaultModel = JSON.stringify(defaults.model);
  const defaultEffort = JSON.stringify(defaults.effort);
  const defaultAdvisor = JSON.stringify(defaults.advisor);
  const contextWindow = JSON.stringify(defaults.contextWindow);
  const compactReserve = JSON.stringify(CLAUDE2_COMPACT_RESERVE);
  const maxTurns = JSON.stringify(defaults.maxTurns);
  // Emitted as an escape, not the raw character: the mark is invisible, and a literal one in the
  // generated script would be an unreadable blank in any view of this page's source.
  const toolLineMark = `'\\u${TOOL_LINE_MARK.codePointAt(0)?.toString(16).padStart(4, "0")}'`;
  const answerMark = `'\\u${ANSWER_MARK.codePointAt(0)?.toString(16).padStart(4, "0")}'`;
  const graftTallyMark = JSON.stringify(GRAFT_TALLY_MARK);
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src blob:;">
  <link rel="stylesheet" href="${dist}/promptEditor.css">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d9d8d1; --yellow: #fff7bf; --wash: rgba(0,0,0,0.07); --done: #0c6b32; --z: 1; --edh: calc(42px * var(--z) + 22px); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(14px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .shell { height: 100vh; display: grid; grid-template-rows: minmax(0, 1fr) auto; }
    /* Prompt editor and every control sit on one bottom dock, so the editor's bottom edge is the
       window's bottom edge; the controls stack to its right instead of below it. */
    .dock { display: flex; align-items: stretch; gap: 10px; border-top: 1px solid var(--border); background: var(--page); padding: 8px 12px; }
    .dock-controls { display: flex; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 4px; flex: 0 1 auto; min-width: 0; margin-left: auto; min-height: var(--edh); font-size: max(14px, calc(14px * var(--z) * 0.85)); }
    .dock-controls button, .dock-controls select { min-height: 0; padding: 3px 8px; }
    .dock-controls .indicator { padding: 2px 8px; }
    /* Three pixels narrower than the rest of the model row, taken off the side padding. */
    #model, #effort, #advisor { padding-left: 6.5px; padding-right: 6.5px; width: calc((11.5ch - 2px) * 0.8); flex: 1 0 auto; }
    /* bigPromptEditor: the editor runs the window's full height on the left, and the pane and the
       controls share the column to its right, the controls at their own two-row height. The dock
       dissolves so its two children can sit in the shell's grid beside the pane. */
    .shell.big-prompt-editor { grid-template-columns: minmax(0, 1fr) auto; }
    .shell.big-prompt-editor .dock { display: contents; }
    .shell.big-prompt-editor #prompt { grid-column: 1; grid-row: 1 / 3; align-self: stretch; max-height: none; margin: 8px 0 8px 12px; }
    /* Sized by the column, never by its own content, or a long line would widen the column. */
    .shell.big-prompt-editor #history { grid-column: 2; grid-row: 1; contain: inline-size; }
    .shell.big-prompt-editor .dock-controls { grid-column: 2; grid-row: 2; min-height: 0; margin: 0; padding: 8px 12px; border-top: 1px solid var(--border); }
    .history { overflow-y: auto; overflow-x: hidden; min-height: 0; padding: 10px 12px 4px; }
    /* Snips: a pad of prompt snippets laid over the pane, in the pane's own grid cell, so it
       follows the pane between the two layouts. The pane stays rendered underneath. */
    #history { grid-row: 1; grid-column: 1; }
    /* Sized by the cell, never by its own content, like the pane. */
    #snips-pad { grid-row: 1; grid-column: 1; display: none; flex-direction: column; gap: 6px; min-height: 0; contain: inline-size; padding: 10px 12px 8px; background: var(--page); }
    .shell.snips-open #snips-pad { display: flex; }
    .shell.big-prompt-editor #snips-pad { grid-column: 2; }
    .snips-head { display: flex; align-items: center; justify-content: space-between; font-weight: 700; }
    .snips-head button { font-weight: 400; }
    .snips-edit { flex: 1 1 0; min-height: 0; position: relative; border: 1px solid var(--border); }
    .snips-edit > div { position: absolute; inset: 0; }
    /* Monaco's button labels ("Close (Escape)" on the find box's X) pop up over the pad's header,
       and would take the click meant for whatever is under them. Sized to the text: Monaco places a
       label above its button by the height it measured, and one squeezed against the editor's
       right edge wrapped after that and grew down over the button. */
    .context-view:has(.workbench-hover), .context-view:has(.workbench-hover) * { pointer-events: none; }
    .context-view:has(.workbench-hover) { width: max-content !important; }
    /* The sent prompt's yellow theme is page-wide; the pad keeps the plain background. */
    #snips-pad .monaco-editor { --vscode-editor-background: #fcfcfb; --vscode-editorGutter-background: #fcfcfb; --vscode-editorStickyScroll-background: #fcfcfb; --vscode-editorStickyScrollGutter-background: #fcfcfb; }
    /* Scoped: Monaco puts an "empty" class on its find box input. */
    .history > .empty { color: var(--muted); height: 100%; display: grid; place-items: center; }
    .turn { margin-bottom: 4px; }
    .turn.selected .prompt-bar { outline: 2px solid #f28b82; outline-offset: -2px; }
    .prompt-bar { width: 100%; height: 1.65em; border: 1px solid #eadf90; background: var(--yellow); color: #14120a; display: block; text-align: left; padding: 1px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 4px; cursor: pointer; }
    .prompt-bar.prompt-expanded { height: auto; min-height: 1.65em; overflow: visible; text-overflow: clip; white-space: pre-wrap; }
    .response { margin: 4px 0 8px; border-left: 3px solid var(--border); padding: 8px 10px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: calc(14px * var(--z)); background: var(--surface); overflow-wrap: anywhere; overflow-x: hidden; }
    .response.error { border-left-color: #c62828; }
    /* The markdown box: the same block, prose-rendered. Sizes stay inside the pane's 14-18px band. */
    .response.markdown { font: calc(14px * var(--z))/1.5 Aptos, "Segoe UI", sans-serif; white-space: normal; }
    .response.markdown > :first-child { margin-top: 0; }
    .response.markdown h1, .response.markdown h2 { font-size: calc(16px * var(--z)); font-weight: 700; margin: 14px 0 6px; padding-bottom: 3px; border-bottom: 1px solid var(--border); }
    .response.markdown h3, .response.markdown h4, .response.markdown h5, .response.markdown h6 { font-size: calc(14px * var(--z)); font-weight: 700; margin: 12px 0 5px; }
    .response.markdown p { margin: 0 0 8px; }
    .response.markdown ul, .response.markdown ol { margin: 0 0 8px; padding-left: 24px; }
    .response.markdown li { margin: 2px 0; }
    .response.markdown li > ul, .response.markdown li > ol { margin: 2px 0 0; }
    .response.markdown blockquote { margin: 0 0 8px; border-left: 3px solid var(--border); padding: 2px 10px; }
    .response.markdown hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
    /* Above the closing answer: heavier than a markdown rule so the two never get confused. */
    .response.markdown hr.answer-rule { border-top: 2px solid #000; }
    .response.markdown a { color: #0b4f9c; }
    .response.markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: calc(14px * var(--z)); background: rgba(0,0,0,0.05); border-radius: 4px; padding: 1px 4px; }
    .response.markdown pre { background: #f2f1ec; border: 1px solid var(--border); border-radius: 8px; margin: 0 0 10px; padding: 8px 10px; overflow: auto; }
    .response.markdown pre code { background: none; padding: 0; white-space: pre; }
    .response.markdown table { border-collapse: collapse; margin: 0 0 10px; font-size: calc(14px * var(--z)); }
    .response.markdown th, .response.markdown td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
    .response.markdown th { background: rgba(0,0,0,0.05); }
    /* A run of tool lines between the prose, shown only while the box's tool groups are. */
    .response.markdown .tool-group { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; margin: 0 0 8px; }
    .error-note { margin-top: 10px; background: #fdecec; border: 1px solid #f0bcbc; border-radius: 6px; padding: 8px 10px; color: #731b1b; }
    .response .search-line { background: #cfe8ff; }
    .prompt-bar.search-hit { background: #cfe8ff; border-color: #9cc4e8; }
    .run-arrow { font-weight: 700; margin-right: 6px; animation: run-blink 0.6s steps(1) infinite; }
    @keyframes run-blink { 50% { visibility: hidden; } }
    /* The fork mark leading every bar. A span, since a bar is a button and can't hold buttons. */
    .bar-icon { display: inline-block; width: 1em; height: 1em; vertical-align: -0.15em; margin-right: 6px; border-radius: 3px; cursor: pointer; }
    .bar-icon:hover { background: var(--wash); }
    .bar-icon svg { display: block; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
    /* The prompt box: a frame around a Monaco editor. It grows with the text (--content-h, set by
       the script) from three lines to six, and still stretches to the controls' height beside it. */
    #prompt { position: relative; flex: 1 1 260px; min-width: 180px; min-height: max(var(--edh), min(var(--content-h, 0px), calc(126px * var(--z) + 18px))); max-height: calc(126px * var(--z) + 18px); border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    #prompt:focus-within { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
    /* promptSent: the prompt just sent, read-only, on the prompt bar's yellow. The editor's own
       background is the claude2-sent theme's. */
    #prompt.sent { background: var(--yellow); }
    /* Inset just past the rounded corners, so the editor's square ones stay inside the border. */
    #prompt > div { position: absolute; inset: 3px; }
    /* Monaco draws its widgets' text at 11-13px; these are the ones the prompt box can show. */
    .monaco-editor .find-widget > .find-part, .monaco-editor .find-widget > .replace-part, .monaco-editor .find-widget .monaco-findInput .input, .monaco-findInput .monaco-inputbox,
    .quick-input-widget, .context-view.fixed, .monaco-hover, .hover-row.status-bar, .monaco-keybinding > .monaco-keybinding-key, .monaco-editor-overlaymessage .message { font-size: calc(14px * var(--z)) !important; }
    .bar { display: flex; gap: 8px; align-items: center; }
    /* Every digit one width, so a ticking stat does not resize the column and slide the pill sideways. */
    .stats { display: flex; gap: 6px; align-items: center; margin-right: 2px; font-variant-numeric: tabular-nums; }
    /* Both rows stretch to the wider one, so M and F line up on the left and the stats on the
       right. Top-row slack widens the model and effort selects; bottom-row slack sits before the stats. */
    .bar .group { flex: 1 0 auto; }
    .footer .stats { margin-left: auto; }
    .sep { color: var(--muted); }
    .group { display: flex; gap: 6px; align-items: center; min-width: 0; flex-wrap: wrap; }
    button, select { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); min-height: 31px; padding: 5px 10px; font: inherit; }
    button { cursor: pointer; }
    button:hover:not(:disabled), select:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    /* Every dock control keeps a white fill at all times -- enabled, hovered or disabled -- and says
       "unavailable" by greying glyph, label and border together, so the two never disagree. */
    .dock-controls button { background: #fff; }
    .dock-controls button:hover:not(:disabled) { background: #fff; border-color: #000; }
    .dock-controls button:disabled { background: #fff; color: #bfbfbf; border-color: #bfbfbf; }
    #stop { display: inline-flex; align-items: center; justify-content: center; font-size: calc(16px * var(--z)); line-height: 1; }
    /* Scoped to the enabled state on purpose: an id beats the .dock-controls disabled rule, so a
       plain "#stop { color: #000 }" would keep the glyph black while the button is dead. */
    #stop:not(:disabled) { color: #000; border-color: #000; }
    /* Stop asks the CLI to finish the message it is on rather than killing it, so the run keeps
       streaming for a moment after the click. Red says "heard you, still winding down". */
    #stop.stopping:not(:disabled), #stop.stopping:hover:not(:disabled) { background: #ffd4d4; }
    .status { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    /* Room for each stat's usual widest value, so gaining a digit (9 to 10 turns) does not widen the column and slide the pill. */
    #quiet, #duration, #projected { min-width: 5ch; }
    #pony { min-width: 6ch; }
    #turns, #cost { min-width: 6ch; }
    #context { min-width: 8ch; }
    /* The context gauge flags a just-finished compaction: the level it shows dropped because the
       conversation was summarised, not because the run shrank. Clears itself, or on a click. */
    #context { cursor: pointer; }
    #context.compacted { background: var(--yellow); border-radius: 4px; padding: 0 5px; margin: 0 -5px; cursor: pointer; }
    /* A plan window has crossed 95% since this was last acknowledged. Stays red until clicked. */
    #cost.quota-alert { background: #fbd9d9; border-radius: 4px; padding: 0 5px; margin: 0 -5px; cursor: pointer; }
    .indicator { border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-weight: 700; white-space: nowrap; }
    /* One uppercase letter only, at a fixed width, so the pill never resizes as the phase
       changes and pushes the prompt editor around. */
    /* A fifth larger than the rest of the dock: one letter has to carry the whole run state. */
    #finish, #cycle { width: calc(2ch + 16px); flex: none; text-align: center; overflow: visible; position: relative; font-size: max(16.8px, calc(14px * var(--z) * 0.85 * 1.2)); }
    /* Same pill, but the letter reads as a control rather than as state, so it stays at dock weight. */
    #cycle { font-size: inherit; font-weight: 400; }
    /* Height pinned too, and the letter centred even when a wide one overflows, so no letter can move the pill's edges. */
    #finish { display: flex; align-items: center; justify-content: center; height: calc(1.45em + 6px); }
    /* Hovering spells the letter out. Absolutely positioned so the pill itself never resizes. */
    #finish:hover::after { content: attr(data-status); position: absolute; right: 0; bottom: calc(100% + 6px); padding: 3px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--ink); font-size: max(11.2px, calc(14px * var(--z) * 0.68)); font-weight: 400; white-space: nowrap; z-index: 5; }
    .indicator.done { background: #fff; }
    .indicator.active { border-color: #e2a3a3; background: #fde0e0; }
    /* Waiting between blocks: still running, but nothing is being produced, so it stays out of the red. */
    .indicator.active.waiting { border-color: #a5d6a7; background: #e3f6e4; }
    .footer { display: flex; gap: 8px; align-items: center; }
    /* The 🖼️ chars leading a prompt bar. One per attached picture, all alike on purpose: which
       one is which is answered by clicking it, not by reading it. */
    .img-char { cursor: pointer; }
    /* The prompt box's and snips pad's line dots, in Monaco's line gutter on the first row of each real line. */
    .line-dot { cursor: pointer; }
    .line-dot::after { content: ''; position: absolute; left: 2px; top: 50%; width: 4px; height: 4px; margin-top: -2px; border-radius: 50%; background: #000; }
    @media (max-width: 760px) { .stats { flex-wrap: wrap; } .status { white-space: normal; } }
${tooltipStyle()}  </style>
</head>
<body>
  <div class="shell">
    <div id="history" class="history"><div class="empty"></div></div>
    <div id="snips-pad"><div class="snips-head"><span>Snips</span><button id="snips-close">Close</button></div><div class="snips-edit"><div></div></div></div>
    <div class="dock">
      <div id="prompt"><div></div></div>
      <div class="dock-controls">
        <div class="bar">
          <div class="group"><button id="cycle" class="indicator">M</button><select id="model"></select><select id="effort"></select><select id="advisor" title="Advisor: a stronger model Claude can consult mid-task"></select></div>
          <div class="stats"><div class="status" id="turns"></div><span class="sep">|</span><div class="status" id="context"></div><span class="sep" id="projected-sep">|</span><div class="status" id="projected" data-tip="Worst plan window (5h, 7d, model) projected to its reset at the recent burn rate"></div></div>
        </div>
        <div class="footer">
          <div id="finish" class="indicator" data-status="Ready">R</div>
          <div class="group"><button id="stop" title="Stop" aria-label="Stop">&#x25AA;</button><button id="clr" title="Clear Claude&#39;s context, as /clear does: later prompts start a fresh conversation. The blocks stay.">Clr</button><button id="snips" title="Snippets of prompt text, one copy shared by every window">Snips</button><button id="cap" title="Attach another screen capture to the next Send — hides this window for the shot; Ctrl-click leaves it up">Cap</button><button id="file" title="Attach a file to the next Send — puts a &lt;name&gt; tag in the box; Ctrl-click the tag to take it off">File</button></div>
          <div class="stats"><div class="status" id="cost"></div><span class="sep" id="pony-sep">|</span><div class="status" id="pony" title="Ponytail skips this session : ceiling comments in the workspace"></div><span class="sep" id="quiet-sep">|</span><div class="status" id="quiet" title="Time since anything new showed in the pane"></div><span class="sep">|</span><div class="status" id="duration"></div></div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${dist}/promptEditor.js"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
${tooltipScript()}
    const sessionId = ${safeSessionId};
    // VS Code hands this back to the panel serializer, which reopens the tab after a reload.
    vscode.setState({ sessionId });
    // Model id -> its effort levels, and the M button's presets: the host's stored model info,
    // replaced whenever the extension posts a newer copy.
    let models = ${models};
    let presets = ${presets};
    // Per-model choices from the Models pane: a model switched off is left out of the picker,
    // and an alias is shown in its place wherever a model id would read.
    let prefs = ${prefs};
    const modelLabel = (model) => (prefs[model] || {}).alias || model;
    const pickableModels = () => Object.keys(models).filter((model) => (prefs[model] || {}).on !== false);
    const fallbackEffort = ${JSON.stringify(DEFAULT_EFFORT)};
    const defaultModel = ${defaultModel};
    const defaultEffort = ${defaultEffort};
    const defaultAdvisor = ${defaultAdvisor};
    const contextWindow = ${contextWindow};
    const compactAt = Math.max(1000, contextWindow - ${compactReserve});
    const maxTurns = ${maxTurns};
    const TOOL_LINE_MARK = ${toolLineMark};
    const ANSWER_MARK = ${answerMark};
    const GRAFT_TALLY_MARK = ${graftTallyMark};
    let session = { id: sessionId, name: 'New session', turns: [] };
    let status = null;
    // Which plugins this workspace runs with and the numbers only the extension can read:
    // graft's savings for this session, and the workspace's ponytail ceiling count.
    let footer = { graft: false, ponytail: false, graftSavedUsd: 0, ceilings: 0, quotaAlert: false, quotaProjected: null };
    // When the last status arrived, so the elapsed time it carries can be run forward locally
    // between messages instead of sitting still through a long tool call.
    let statusAt = 0;
    // Sidebar search text; while non-empty, every line holding it gets a light-blue wash.
    let searchText = '';
    let expandedPrompts = new Set();
    // Every box is markdown. The one open box hides its tool groups by default and a ctrl-click
    // toggles them. The streaming box always shows them and ignores clicks.
    let toolsBox = false;
    // The turn streaming at the last render, and the one whose run ended while its box was
    // open: that box loses its tool groups when the run ends, and its scroll memory is
    // dropped when it closes, so its next open is a first open.
    let streamingTurn = null;
    let wasStreaming = null;
    // Each box's scroll position by turn id: a pixel offset, or 'bottom' to pin to the end.
    // Mirrored to the extension so the memory outlives this webview; a box with no remembered
    // position is on its first open and starts at the top (the streaming box at the bottom).
    let boxScrolls = {};
    let boxScrollsLoaded = false;
    let boxScrollTimer = 0;
    let shownActiveTurn = null;
    let anchorIndex = 0;
    // At most one box is ever open: the selected block's, and only while this is true. allOpen
    // (below) is the exception.
    let boxOpen = true;
    // Where the box contents land on the next render: 'bottom' after an open, 'top' after
    // hiding tool groups, null to keep the current position.
    let boxScrollNext = null;
    let initializedSelection = false;
    let pendingTurnCount = 0;
    let programmaticScroll = false;
    let resizeTimer = 0;
    // frozenPane: a wheel over the pane (not over a scrolling box) suspends every auto-scrolling
    // rule so the pane scrolls freely and keeps its position through renders. Any mouse press
    // anywhere in the webview thaws it; the press still does its normal job.
    let frozenPane = false;
    // allOpen: plain up/down arrows, with the pane focused and no text field or footer control
    // holding focus, freeze the pane with every box open and scroll it. The thaw closes every
    // box but the selected one, which is left open.
    let allOpen = false;
    let draftSent = '';
    // U+1F5BC U+FE0F, one per picture attached to this prompt. The run of them leads the prompt
    // box (drawn there, not typed) and every prompt bar built from a turn that carried pictures.
    const IMG = '\\u{1F5BC}\\uFE0F';
    // How many pictures are waiting on this session's next prompt. The extension owns the list;
    // this is only what the box's 🖼️ chars are drawn from.
    let imageCount = 0;
    const historyBox = document.getElementById('history');
    // The prompt box is a Monaco editor: VS Code's own editing (multi-cursor, find/replace, line
    // moves, its undo) on a markdown model. A webview can't start a worker from a resource URL,
    // which is a different origin, so the worker is a blob that imports the bundled one.
    self.MonacoEnvironment = { getWorker: () => new Worker(URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(${editorWorkerUrl}) + ')'], { type: 'text/javascript' }))) };
    const themeColors = { 'editor.background': '#fcfcfb', foreground: '#000000', descriptionForeground: '#000000', 'input.placeholderForeground': '#000000', 'keybindingLabel.foreground': '#000000' };
    monaco.editor.defineTheme('claude2', {
      base: 'vs',
      inherit: true,
      // Black wherever the stock light theme greys text: html delimiters, widget text, placeholders.
      rules: [{ token: 'delimiter.html', foreground: '000000' }],
      colors: themeColors,
    });
    // promptSent's: the same, on the prompt bar's yellow. A theme is page-wide, but this page has one editor.
    monaco.editor.defineTheme('claude2-sent', {
      base: 'vs',
      inherit: true,
      rules: [{ token: 'delimiter.html', foreground: '000000' }],
      colors: { ...themeColors, 'editor.background': '#fff7bf' },
    });
    // F1 belongs to VS Code, not to Monaco's own command palette. Unbound here, for both editors,
    // the key goes on through the webview to the workbench's keybindings.
    monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: '-editor.action.quickCommand' });
    // The user's own VS Code editing keys, which Monaco in a webview never sees. Ctrl-D is otherwise
    // Monaco's add-next-match, and shift-alt-left/right its smart select.
    const { KeyMod, KeyCode } = monaco;
    const writable = 'textInputFocus && !editorReadonly';
    monaco.editor.addKeybindingRules([
      { keybinding: KeyMod.CtrlCmd | KeyCode.KeyD, command: 'editor.action.deleteLines', when: writable },
      { keybinding: KeyMod.CtrlCmd | KeyCode.KeyJ, command: 'editor.action.joinLines', when: writable },
      { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyD, command: 'editor.action.duplicateSelection', when: writable },
      { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyU, command: 'editor.action.transformToUppercase', when: writable },
      { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyL, command: 'editor.action.transformToLowercase', when: writable },
      { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.LeftArrow, command: 'cursorUndo', when: 'textInputFocus' },
      { keybinding: KeyMod.Shift | KeyMod.Alt | KeyCode.RightArrow, command: 'cursorRedo', when: 'textInputFocus' },
    ]);
    const promptHost = document.getElementById('prompt');
    // Shared with the Snips pad's editor.
    const editorOptions = {
      language: 'markdown',
      theme: 'claude2',
      automaticLayout: true,
      wordWrap: 'on',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14 * zoom,
      lineHeight: 1.5,
      tabSize: 2,
      // Ctrl-click adds and removes cursors (Monaco's default is alt), so alt-click follows links.
      multiCursorModifier: 'ctrlCmd',
      // With the frame's 3px inset and 1px border: the old textarea's gap on top, a small one below.
      padding: { top: 7, bottom: 3 },
      // Room for the line dot and a clear gap after it before the text.
      lineDecorationsWidth: 14,
      lineNumbers: 'off',
      glyphMargin: false,
      folding: false,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      scrollBeyondLastLine: false,
      // Popups may overhang the box's frame instead of being clipped by it.
      fixedOverflowWidgets: true,
      // VS Code's own markdown defaults: no completion popups while typing, no boxes on curly quotes.
      quickSuggestions: false,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      // The textarea input path: VS Code's webview host forwards copy and paste as execCommand,
      // which lands on a focused textarea.
      editContext: false,
      // What typing into a sent prompt says.
      readOnlyMessage: { value: 'Already sent. Ctrl-Enter clears the box for the next prompt.' },
    };
    // Monaco places the caret on an all-ASCII line by counting columns instead of measuring, and it
    // judges ASCII by the text alone: the injected 🖼️ chars are wider than the columns they count
    // as, so with them in front every caret and click lands to the right. Measuring is always right.
    const promptBox = monaco.editor.create(promptHost.firstElementChild, { ...editorOptions, disableMonospaceOptimizations: true });
    const promptModel = promptBox.getModel();
    // The frame grows with the text, never below three lines, and the CSS caps it at six. The floor
    // is Monaco's own rounded line height, so a zoom level never leaves the third line cut off.
    function fitPrompt() {
      const threeLines = 3 * promptBox.getOption(monaco.editor.EditorOption.lineHeight) + 10;
      promptHost.style.setProperty('--content-h', (Math.max(promptBox.getContentHeight(), threeLines) + 8) + 'px');
    }
    promptBox.onDidContentSizeChange(fitPrompt);
    fitPrompt();
    // A dot in the gutter on the first row of each real line, so a wrapped line reads as one.
    // Clicking a dot selects that line with its line break, like a line number in VS Code, and
    // dragging from it selects every line passed over. Monaco leaves gutter clicks alone and keeps
    // focus where it was, so the editor takes it here.
    function addLineDots(editor) {
      const model = editor.getModel();
      const dots = editor.createDecorationsCollection();
      const show = () => dots.set(Array.from({ length: model.getLineCount() }, (_, i) => ({
        range: new monaco.Range(i + 1, 1, i + 1, 1),
        options: { isWholeLine: true, firstLineDecorationClassName: 'line-dot' },
      })));
      model.onDidChangeContent(show);
      show();
      const selectLines = (from, to) => {
        const top = Math.min(from, to), bottom = Math.max(from, to);
        editor.setSelection(bottom < model.getLineCount() ? new monaco.Range(top, 1, bottom + 1, 1) : new monaco.Range(top, 1, bottom, model.getLineMaxColumn(bottom)));
      };
      // The line the drag started on and the pointer's height, while the button is down. Past the
      // box's top or bottom edge it scrolls, faster the further out the pointer is, and the line
      // taken is the one at that edge. Half a line in from the edge clears the padding.
      let dragFrom = 0, dragY = 0;
      const drag = () => {
        if (!dragFrom) return;
        const rect = editor.getDomNode().getBoundingClientRect();
        const past = dragY < rect.top ? dragY - rect.top : dragY > rect.bottom ? dragY - rect.bottom : 0;
        if (past) editor.setScrollTop(editor.getScrollTop() + past / 4);
        const inset = editor.getOption(monaco.editor.EditorOption.lineHeight) / 2;
        const target = editor.getTargetAtClientPoint(rect.left + rect.width / 2, Math.min(Math.max(dragY, rect.top + inset), rect.bottom - inset));
        if (target && target.position) selectLines(dragFrom, target.position.lineNumber);
        requestAnimationFrame(drag);
      };
      editor.onMouseDown((event) => {
        if (!event.target.element || !event.target.element.closest('.line-dot')) return;
        dragFrom = event.target.position.lineNumber;
        dragY = event.event.browserEvent.clientY;
        selectLines(dragFrom, dragFrom);
        editor.focus();
        requestAnimationFrame(drag);
      });
      window.addEventListener('pointermove', (event) => { dragY = event.clientY; });
      window.addEventListener('pointerup', () => { dragFrom = 0; });
    }
    addLineDots(promptBox);
    // DEBUG: why the box runs taller than its text inside VS Code. Logs to the Claude2 output.
    new ResizeObserver(() => {
      const h = (el) => el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : -1;
      const style = getComputedStyle(promptHost);
      vscode.postMessage({ type: 'debugLog', sessionId, text: 'promptBox ' + JSON.stringify({
        lines: promptModel.getLineCount(), viewLines: promptBox._getViewModel ? promptBox._getViewModel().getLineCount() : -1,
        lh: promptBox.getOption(monaco.editor.EditorOption.lineHeight), content: promptBox.getContentHeight(), layoutH: promptBox.getLayoutInfo().height,
        contentVar: promptHost.style.getPropertyValue('--content-h'), edh: getComputedStyle(document.documentElement).getPropertyValue('--edh'),
        minH: style.minHeight, maxH: style.maxHeight, box: h(promptHost), inner: h(promptHost.firstElementChild),
        dock: h(document.querySelector('.dock')), controls: h(dockControls), bar: h(dockControls.querySelector('.bar')), footer: h(dockControls.querySelector('.footer')),
        big: bigPromptEditor, dpr: devicePixelRatio, zoom,
      }) });
    }).observe(promptHost);
    // The Snips pad: one Monaco editor over the pane, its text kept by the extension in globalState
    // so every window shares it. Built on the first open, from the stored text, so nothing typed
    // before the text arrives can overwrite it. Every keystroke is saved, like the draft.
    const shell = document.querySelector('.shell');
    const snipsHost = document.getElementById('snips-pad');
    let snipsBox = null;
    // The pad's version when the text was last asked for: a reply that lands after more typing is stale.
    let snipsAsked = 0;
    function askSnips() {
      snipsAsked = snipsBox ? snipsBox.getModel().getVersionId() : 0;
      vscode.postMessage({ type: 'snipsLoad', sessionId });
    }
    function showSnips(text) {
      if (!snipsBox) {
        snipsBox = monaco.editor.create(snipsHost.querySelector('.snips-edit > div'), { ...editorOptions, fontSize: 14 * zoom, value: text });
        addLineDots(snipsBox);
        snipsBox.onDidChangeModelContent(() => vscode.postMessage({ type: 'snipsChanged', sessionId, text: snipsBox.getValue() }));
        snipsBox.addAction({ id: 'claude2.closeSnips', label: 'Close Snips', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => setSnipsOpen(false) });
        snipsBox.focus();
        return;
      }
      if (snipsBox.getModel().getVersionId() !== snipsAsked || snipsBox.getValue() === text) return;
      const view = snipsBox.saveViewState();
      snipsBox.setValue(text);
      snipsBox.restoreViewState(view);
    }
    function setSnipsOpen(open) {
      shell.classList.toggle('snips-open', open);
      if (!open) return promptBox.focus();
      askSnips();
      if (snipsBox) snipsBox.focus();
    }
    // Clr: /clear, sent like the gauge's /compact so the draft in the box stays.
    const clrButton = document.getElementById('clr');
    clrButton.addEventListener('click', () => vscode.postMessage({ type: 'submitPrompt', sessionId, prompt: '/clear', model: modelSelect.value, effort: effortSelect.value, advisor: advisorSelect.value, keepDraft: true }));
    document.getElementById('snips').addEventListener('click', () => setSnipsOpen(!shell.classList.contains('snips-open')));
    document.getElementById('snips-close').addEventListener('click', () => setSnipsOpen(false));
    // Another window may have changed the text since: coming back to this one picks that up.
    window.addEventListener('focus', () => {
      if (snipsBox && shell.classList.contains('snips-open')) askSnips();
    });
    // Monaco sizes its own text, so a zoom step reaches it here rather than through --z.
    new MutationObserver(() => {
      promptBox.updateOptions({ fontSize: 14 * zoom });
      if (snipsBox) snipsBox.updateOptions({ fontSize: 14 * zoom });
    }).observe(document.documentElement, { attributeFilter: ['style'] });
    const modelSelect = document.getElementById('model');
    const effortSelect = document.getElementById('effort');
    const advisorSelect = document.getElementById('advisor');
    const stopButton = document.getElementById('stop');
    const capButton = document.getElementById('cap');
    const finish = document.getElementById('finish');
    const cycleButton = document.getElementById('cycle');

    fillSelect(modelSelect, pickableModels(), defaultModel, modelLabel);
    fillEfforts(defaultEffort);
    fillAdvisors(defaultAdvisor);
    // None picked by hand is sticky through presets. A none forced by a model nothing outranks
    // (fable) is not, so the next preset brings an advisor back.
    let advisorOff = defaultAdvisor === '';
    // The pickers belong to the session, not the panel: every change is written back so
    // reopening this session later comes up on the same model, effort and advisor.
    modelSelect.addEventListener('change', () => { fillEfforts(effortSelect.value); fillAdvisors(advisorSelect.value); sendPicks(); });
    effortSelect.addEventListener('change', sendPicks);
    advisorSelect.addEventListener('change', () => { advisorOff = advisorSelect.value === ''; sendPicks(); });
    cycleButton.addEventListener('click', cyclePicks);
    describePicks();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'sessionState') {
        session = message.session || session;
        status = message.status || null;
        footer = message.footer || footer;
        statusAt = Date.now();
        // draftSent first, so the change event this fires has nothing new to send back.
        if (typeof message.draft === 'string' && message.draft && !promptModel.getValueLength()) {
          draftSent = untab(message.draft);
          promptModel.setValue(draftSent);
        }
        if (typeof message.search === 'string') searchText = message.search;
        // The extension's copy of the scroll memory is the persistent one; it is taken once,
        // at load, so a position noted here is never clobbered by a state echo.
        if (!boxScrollsLoaded && message.boxScrolls && typeof message.boxScrolls === 'object') {
          boxScrollsLoaded = true;
          boxScrolls = message.boxScrolls;
        }
        // Taken once, at load, like boxScrolls: a state echo must not undo a toggle still in flight.
        if (!bigPromptLoaded) {
          bigPromptLoaded = true;
          bigPromptEditor = session.bigPrompt === true;
          document.querySelector('.shell').classList.toggle('big-prompt-editor', bigPromptEditor);
          // A sent prompt comes back as the session's last one; a draft already in the box outranks it.
          const last = session.turns[session.turns.length - 1];
          if (session.sentPrompt === true) {
            setPromptSent(!!last && !promptModel.getValueLength());
            if (promptSent) promptModel.setValue(untab(typedText(last)));
          }
        }
        document.title = session.name || 'Claude2';
        render();
      } else if (message.type === 'turnDelta') {
        applyTurnDelta(message);
      } else if (message.type === 'searchState') {
        searchText = typeof message.text === 'string' ? message.text : '';
        render();
      } else if (message.type === 'focusPrompt') {
        promptBox.focus();
      } else if (message.type === 'snips') {
        showSnips(String(message.text || ''));
      } else if (message.type === 'closeSnips') {
        shell.classList.remove('snips-open');
      } else if (message.type === 'stopDeclined') {
        stoppingTurn = null;
        stopButton.classList.remove('stopping');
      } else if (message.type === 'exportSelected') {
        vscode.postMessage({ type: 'exportSession', sessionId, markdown: exportMarkdown() });
      } else if (message.type === 'imagesState') {
        imageCount = typeof message.count === 'number' ? message.count : 0;
        capButton.disabled = false;
        showImageChars();
      } else if (message.type === 'insertFile') {
        insertFileTag(message.name);
      } else if (message.type === 'removeFile') {
        // The ctrl-clicked tag, still where it was: the extension's dialog was modal.
        const tag = fileTagAt(message.start);
        if (tag && tag.start === message.start && tag.name === message.name) replaceText(tag.start, tag.end, '');
      } else if (message.type === 'filePicked') {
        leaveSent();
      } else if (message.type === 'promptReturned' && promptSent) {
        // The prompt never ran, so the box goes back to the edit mode it was sent from, with
        // the extension's copy of the text. Size untouched.
        draftSent = untab(String(message.prompt || ''));
        setPromptSent(false);
        if (promptModel.getValue() !== draftSent) promptModel.setValue(draftSent);
      } else if (message.type === 'promptSuggestion' && typeof message.suggestion === 'string') {
        // The Prompt suggestions setting: the CLI's guess at the next prompt takes the box only
        // while nothing has been typed since the send -- it still shows the sent prompt, or it was
        // cleared and left empty. Typing wins and the guess is dropped. An edit, so ctrl-z brings
        // back the sent prompt, and the change event hands the text on as the draft.
        if (promptSent || !promptModel.getValueLength()) {
          if (promptSent) setPromptSent(false);
          replaceText(0, promptModel.getValueLength(), untab(message.suggestion));
        }
      } else if (message.type === 'models' && message.models && typeof message.models === 'object') {
        models = message.models;
        presets = Array.isArray(message.presets) ? message.presets : presets;
        prefs = message.prefs && typeof message.prefs === 'object' ? message.prefs : prefs;
        fillSelect(modelSelect, pickableModels(), modelSelect.value, modelLabel);
        fillEfforts(effortSelect.value);
        fillAdvisors(advisorSelect.value);
      }
    });

    // Ctrl-Enter sends, in place of Monaco's insert-line-below. On a sent prompt it clears the box
    // instead, and on an empty one it toggles bigPromptEditor. Actions, not addCommand: Monaco's
    // addCommand keys are page-wide, so they would fire in the Snips pad too.
    promptBox.addAction({ id: 'claude2.submitPrompt', label: 'Send Prompt', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => submitPrompt() });
    // Ctrl-Alt-click anywhere in the box toggles bigPromptEditor, in either mode, and focuses the
    // box. Capture phase, so Monaco never sees the press (its ctrl-click adds a cursor), which also
    // means the click itself gives no focus. Monaco listens for pointer events; the mouse ones are
    // only blocked, so a browser that still fires them can't toggle twice.
    promptHost.addEventListener('pointerdown', (event) => {
      if (!event.ctrlKey || !event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      setBigPromptEditor(!bigPromptEditor);
      promptBox.focus();
    }, true);
    promptHost.addEventListener('mousedown', (event) => {
      if (!event.ctrlKey || !event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    // Tab makes list items (tabLines) instead of inserting anything. Left to Monaco while a
    // completion list or a snippet is up, where Tab means something else.
    promptBox.addAction({ id: 'claude2.tabLines', label: 'Make List Items', keybindings: [monaco.KeyCode.Tab], keybindingContext: 'editorTextFocus && !suggestWidgetVisible && !inSnippetMode', run: () => tabLines() });
    // Up from the top line leaves the box for the pane's arrow scroll. Wrapped lines leave no
    // newline to count, so the top line is the one where the caret's own Up didn't move it.
    promptBox.onKeyDown((event) => {
      if (event.keyCode !== monaco.KeyCode.UpArrow || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const before = promptBox.getSelection();
      if (!before.isEmpty() || before.startLineNumber !== 1) return;
      window.setTimeout(() => {
        if (!promptBox.hasTextFocus() || !promptBox.getSelection().equalsSelection(before)) return;
        document.activeElement.blur();
        arrowScroll(true);
      });
    });
    // Ctrl-up/down step the selected bar and open its box. A webview only sees keys while its
    // tab has focus, so this is live only in the focused claude2 tab.
    window.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      // Kept from the prompt box, where Monaco would scroll a line.
      event.stopPropagation();
      // A frozen pane thaws first, so the step below lands under the normal rules.
      const reapply = frozenPane ? thaw() : null;
      const before = anchorIndex;
      selectBlock(anchorIndex + (event.key === 'ArrowUp' ? -1 : 1));
      // At either end the selection stays put; the box still opens.
      if (anchorIndex === before && !boxOpen) {
        boxOpen = true;
        boxScrollNext = 'restore';
        toolsBox = false;
        render();
      }
      if (reapply) requestAnimationFrame(reapply);
    }, true);
    // Every keystroke crosses, undelayed: the extension holds the only copy that survives this
    // webview, and a debounce here is a window in which typing exists nowhere else. The message
    // is small and the receiving end only writes a map entry; the disk write is coalesced there.
    promptModel.onDidChangeContent(() => {
      showImageChars();
      sendDraft('draftChanged');
    });
    // Losing focus is the cue to name the session after an unsent draft.
    promptBox.onDidBlurEditorWidget(() => sendDraft('draftBlur'));
    // An image on the clipboard becomes another attached picture rather than pasted text. Each
    // paste adds one; the pictures already waiting stay. The extension ignores a second copy
    // of one already in the list. Capture phase, so Monaco never sees the paste.
    promptHost.addEventListener('paste', (event) => {
      // A sent prompt takes no paste, a picture included; Monaco's read-only drops the text.
      if (promptSent) return;
      const items = event.clipboardData ? Array.from(event.clipboardData.items) : [];
      const item = items.find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'));
      const file = item ? item.getAsFile() : null;
      if (!file) {
        // Pasted text loses its tab chars, through Monaco's own paste so it stays one undo step.
        // The find box's own pastes are left alone.
        const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (!promptBox.hasTextFocus() || !text.includes('\\t')) return;
        event.preventDefault();
        event.stopPropagation();
        promptBox.trigger('keyboard', 'paste', { text: untab(text) });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      capButton.disabled = true;
      const reader = new FileReader();
      reader.onload = () => vscode.postMessage({ type: 'pasteImage', sessionId, dataUri: String(reader.result) });
      reader.onerror = () => { capButton.disabled = false; };
      reader.readAsDataURL(file);
    }, true);
    // A click on one of the leading 🖼️ chars is about that picture, not about the caret: plain
    // shows it in the Image pane, ctrl deletes it (the extension asks first). The chars' own
    // CSS gives them the pointer. A ctrl-click on a <file> tag in the text takes the tag off, once
    // the extension has asked too (removeFile). These presses are kept from Monaco, which would
    // move the caret or add a cursor; a ctrl-click anywhere else still does. This has to be the
    // mousedown: Monaco pointer-captures its lines on mousedown, so the mouseup's target is never
    // the 🖼️ span.
    promptHost.addEventListener('mousedown', (event) => {
      if (event.button) return;
      const index = imageCharAt(event.target, event.clientX);
      if (index >= 0) {
        vscode.postMessage(event.ctrlKey ? { type: 'deleteImage', sessionId, index } : { type: 'showImage', sessionId, turnId: '', index });
      } else {
        if (!event.ctrlKey) return;
        const target = promptBox.getTargetAtClientPoint(event.clientX, event.clientY);
        const tag = target && target.type === monaco.editor.MouseTargetType.CONTENT_TEXT ? fileTagAt(promptModel.getOffsetAt(target.position)) : null;
        if (!tag) return;
        vscode.postMessage({ type: 'deleteFile', sessionId, name: tag.name, start: tag.start });
      }
      event.preventDefault();
      event.stopPropagation();
    }, true);
    stopButton.addEventListener('click', () => {
      markStopping();
      vscode.postMessage({ type: 'stopPrompt', sessionId });
    });
    document.getElementById('cap').addEventListener('click', (event) => {
      leaveSent();
      // Every click takes another picture and adds it to the ones already waiting. The button
      // greys out only for the length of the shot; the picture list is shown by the 🖼️ chars.
      capButton.disabled = true;
      // A plain click minimizes this VS Code window for the shot, so it shows what was behind it.
      // Ctrl-click leaves the window up, for a picture of the window itself.
      vscode.postMessage({ type: 'captureScreen', sessionId, hideWindow: event.ctrlKey !== true });
    });
    document.getElementById('file').addEventListener('click', () => vscode.postMessage({ type: 'pickFile', sessionId }));
    // Manual scrolling never changes the selection; it is free only inside the window the
    // auto-scrolling rules allow (bordering bars and selected bar visible), so the scroll
    // position is clamped rather than the selection moved.
    historyBox.addEventListener('scroll', () => {
      if (frozenPane) return;
      if (programmaticScroll || !session.turns.length) return;
      const bounds = scrollBounds();
      if (!bounds) return;
      const clamped = Math.min(bounds.max, Math.max(bounds.min, historyBox.scrollTop));
      if (clamped !== historyBox.scrollTop) historyBox.scrollTop = clamped;
    });
    // A wheel over a box that can scroll stays the box's; anywhere else in the pane it freezes it.
    // An unfocused webview never freezes: nothing short of a click here could thaw it.
    historyBox.addEventListener('wheel', (event) => {
      if (!document.hasFocus()) return;
      for (let el = event.target; el && el !== historyBox; el = el.parentElement) {
        const overflowY = getComputedStyle(el).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return;
      }
      frozenPane = true;
    }, { passive: true });
    // Capture phase, so the thaw lands before the press's own handlers run. The rules are
    // re-applied only after the release, so nothing moves under the pointer mid-click.
    let thawing = null;
    window.addEventListener('pointerdown', () => {
      if (!frozenPane) return;
      thawing = thaw();
    }, true);
    window.addEventListener('pointerup', () => {
      if (!thawing) return;
      requestAnimationFrame(thawing);
      thawing = null;
    }, true);
    function thawPane() {
      if (!frozenPane) return;
      requestAnimationFrame(thaw());
    }
    // Ends a freeze and returns what re-applies the rules: a rebuild when every box was open, so
    // the others close; otherwise just the resync, which keeps a text selection in the box.
    function thaw() {
      frozenPane = false;
      if (!allOpen) return resyncSelectedBlock;
      allOpen = false;
      boxOpen = true;
      return render;
    }
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Enter') return;
      if (event.target.closest && event.target.closest('textarea, input, select, .dock-controls')) return;
      event.preventDefault();
      if (event.key === 'Enter') selectBottomBlock(); else arrowScroll(event.key === 'ArrowUp');
    });
    // Enter lands on the last block (thawing the pane first if it was frozen), with its bar as
    // high as the rules allow (the bar above it at the top of the pane) rather than at the
    // nearest edge of the allowed window. Already there, unfrozen, it toggles that box, so a
    // second Enter leaves every box closed and a third opens the last one again.
    function selectBottomBlock() {
      const toggle = !frozenPane && session.turns.length - 1 === anchorIndex;
      if (frozenPane) thaw();
      if (session.turns.length - 1 !== anchorIndex) selectBlock(session.turns.length - 1);
      else {
        boxOpen = toggle ? !boxOpen : true;
        if (boxOpen) {
          boxScrollNext = 'restore';
          toolsBox = false;
        }
        render();
      }
      // After the render's own sync has set the clamps, so the bounds see the final layout.
      requestAnimationFrame(() => {
        const bounds = scrollBounds();
        if (bounds) historyBox.scrollTop = bounds.max;
      });
    }
    function arrowScroll(up) {
      if (!allOpen) {
        // Opening every box reflows the pane; the selected bar is held where it sits on screen.
        const before = historyBox.querySelector('[data-index="' + anchorIndex + '"]');
        const offset = before ? before.offsetTop - historyBox.scrollTop : 0;
        frozenPane = true;
        allOpen = true;
        render();
        const after = historyBox.querySelector('[data-index="' + anchorIndex + '"]');
        if (after) historyBox.scrollTop = after.offsetTop - offset;
      }
      historyBox.scrollTop += up ? -40 : 40;
    }
    // A press elsewhere in VS Code, or switching away from it, never reaches this webview;
    // losing focus stands in for both.
    window.addEventListener('blur', thawPane);
    // Any footer action thaws, keyboard included (mouse presses are already covered above).
    const dockControls = document.querySelector('.dock-controls');
    for (const type of ['keydown', 'click', 'change']) dockControls.addEventListener(type, thawPane, true);
    // The open box's clamp is sized from the pane height, so a pane resize has to
    // re-derive it or the old clamp sticks.
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resyncSelectedBlock, 80);
    });

    // Re-applies the rules to the selected block, keeping its box where it currently sits.
    function resyncSelectedBlock() {
      const response = historyBox.querySelector('[data-index="' + anchorIndex + '"] .response');
      const atBottom = response ? response.scrollHeight - response.scrollTop - response.clientHeight < 18 : false;
      syncSelectedBlock(atBottom ? 'bottom' : response ? response.scrollTop : 0);
    }

    function fillSelect(select, values, selected, label) {
      select.replaceChildren();
      // A session's saved pick stays selectable even when the current list no longer has it.
      for (const value of values.includes(selected) ? values : [...values, selected]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label ? label(value) : value;
        option.selected = value === selected;
        select.appendChild(option);
      }
    }

    // The effort picker offers only what the selected model takes. A model the list no longer
    // has gets every level any listed model takes; one with none (haiku) gets an empty picker,
    // and runs without --effort.
    function fillEfforts(selected) {
      const list = models[modelSelect.value] || [...new Set(Object.values(models).flat())];
      if (list.length === 0) {
        effortSelect.replaceChildren();
        return;
      }
      fillSelect(effortSelect, list, list.includes(selected) ? selected : list.includes(fallbackEffort) ? fallbackEffort : list[0]);
    }

    // Each family stronger than the selected model's that the CLI lists, strongest first. A model
    // in none of them (haiku) is the weakest and gets all three.
    function advisorChoices() {
      const families = ['fable', 'opus', 'sonnet'];
      const own = families.findIndex((family) => modelSelect.value.includes(family));
      return families.slice(0, own === -1 ? families.length : own).filter((family) => Object.keys(models).some((model) => model.includes(family)));
    }

    // The advisor picker offers none, then advisorChoices. A pick the new model outranks falls
    // back to none.
    function fillAdvisors(selected) {
      const offered = advisorChoices();
      fillSelect(advisorSelect, ['', ...offered], offered.includes(selected) ? selected : '', (family) => (family ? family[0].toUpperCase() + family.slice(1) : 'none'));
    }

    function sendPicks() {
      describePicks();
      vscode.postMessage({ type: 'picksChanged', sessionId, model: modelSelect.value, effort: effortSelect.value, advisor: advisorSelect.value });
    }

    // Step to the next enabled preset (set in the Models pane). A pairing set by hand through the
    // pickers matches none of them, so findIndex gives -1 and the first is where the click lands.
    function cyclePicks() {
      const enabled = presets.filter((preset) => preset.enabled && pickableModels().includes(preset.model));
      if (enabled.length === 0) return;
      const at = enabled.findIndex((preset) => preset.model === modelSelect.value && preset.effort === effortSelect.value);
      const next = enabled[(at + 1) % enabled.length];
      fillSelect(modelSelect, pickableModels(), next.model, modelLabel);
      fillEfforts(next.effort);
      // The advisor moves to the next family up from the preset's model, unless none is sticky.
      fillAdvisors(advisorOff ? '' : advisorChoices().pop());
      sendPicks();
    }

    // The letter says nothing about what is selected, so the hover does.
    function describePicks() {
      cycleButton.title = modelLabel(modelSelect.value) + ' / ' + effortSelect.value + ' — click for the next preset';
    }

    function sendDraft(type) {
      // A sent prompt is not a draft: as far as the extension knows, the box is empty.
      const draft = promptSent ? '' : promptModel.getValue();
      if (type === 'draftChanged' && draft === draftSent) return;
      draftSent = draft;
      vscode.postMessage({ type, sessionId, draft });
    }

    // The 🖼️ chars lead the box's first line as injected text: drawn there but not part of the
    // text, so typing, the caret and the draft never touch them. Set again on every edit, or one
    // at the very start would carry them along with the text it moved.
    const imageChars = promptBox.createDecorationsCollection();
    function showImageChars() {
      imageChars.set(imageCount ? [{
        range: new monaco.Range(1, 1, 1, 1),
        // An empty range: without showIfCollapsed Monaco keeps the decoration but never draws it.
        options: { showIfCollapsed: true, before: { content: IMG.repeat(imageCount), inlineClassName: 'img-char', cursorStops: monaco.editor.InjectedTextCursorStops.Right } },
      }] : []);
    }

    // An edit through Monaco, so ctrl-z takes it back. Offsets are into the box's text; the caret
    // lands at caret in the text after the edit, by default just past the new text.
    function replaceText(start, end, text, caret = start + text.length) {
      const range = monaco.Range.fromPositions(promptModel.getPositionAt(start), promptModel.getPositionAt(end));
      promptBox.pushUndoStop();
      promptBox.executeEdits('claude2', [{ range, text }]);
      promptBox.pushUndoStop();
      promptBox.setPosition(promptModel.getPositionAt(caret));
    }

    // No tab char ever goes in the box: Tab itself makes list items, and text arriving with tabs
    // (a paste, a draft, Load) has each one turned into two spaces.
    function untab(text) {
      return text.replace(/\\t/g, '  ');
    }

    // Tab on each line a caret or selection touches: the margin steps right to the next even count
    // (an odd one by 1, an even one by 2) and the text becomes a "- " item, exactly one space after
    // the dash. A run of lines leaves its blank ones alone; a lone blank line becomes an empty item.
    function tabLines() {
      const lines = new Set();
      for (const s of promptBox.getSelections()) {
        // A selection ending at the very start of a line does not take that line in.
        const last = s.endLineNumber > s.startLineNumber && s.endColumn === 1 ? s.endLineNumber - 1 : s.endLineNumber;
        for (let n = s.startLineNumber; n <= last; n++) lines.add(n);
      }
      const edits = [];
      const tabbed = new Map();
      for (const n of lines) {
        const line = promptModel.getLineContent(n);
        if (lines.size > 1 && !line.trim()) continue;
        const start = tabLine(line);
        edits.push({ range: new monaco.Range(n, 1, n, start.old + 1), text: start.prefix });
        tabbed.set(n, start);
      }
      // A caret keeps its place in its line's text; one that was in the margin or on the dash
      // lands at the start of the text.
      const move = (n, col) => {
        const start = tabbed.get(n);
        return !start ? col : col > start.old ? col + start.prefix.length - start.old : start.prefix.length + 1;
      };
      const selections = promptBox.getSelections().map((s) => new monaco.Selection(
        s.selectionStartLineNumber, move(s.selectionStartLineNumber, s.selectionStartColumn), s.positionLineNumber, move(s.positionLineNumber, s.positionColumn)));
      promptBox.pushUndoStop();
      promptBox.executeEdits('claude2', edits, selections);
      promptBox.pushUndoStop();
    }

    // What Tab puts at the start of a line: prefix replaces the line's first old chars, its
    // margin and any dash with the spaces after it.
    function tabLine(line) {
      const margin = line.match(/^ */)[0].length;
      const dash = line.slice(margin).match(/^- */);
      return { old: margin + (dash ? dash[0].length : 0), prefix: ' '.repeat(margin + 2 - margin % 2) + '- ' };
    }

    // An attached file rides in the text as a <name> tag rather than in a prefix of its own: the
    // draft carries it for free, and the extension turns each tag back into a path on the way out.
    // New tags lead the typing, the way another picture would.
    function insertFileTag(name) {
      if (!name) return;
      const tag = '<' + name + '> ';
      replaceText(0, 0, tag, promptModel.getValueLength() + tag.length);
      promptBox.focus();
    }

    // The tag the caret sits in, or null: its name, and the span to cut, with the space that
    // follows it. A '<' the user typed is only ever a tag to the extension if it matches an
    // attached file, so cutting one here that turns out to be plain typing costs nothing beyond
    // the retype.
    function fileTagAt(caret) {
      const text = promptModel.getValue();
      const start = text.lastIndexOf('<', caret);
      if (start < 0) return null;
      const end = text.indexOf('>', start);
      // The caret has to be inside the tag -- ending on its '>' counts -- and a newline in
      // between means these two brackets were never one tag.
      if (end < 0 || end < caret - 1 || text.slice(start, end).includes('\\n')) return null;
      return { start, end: text[end + 1] === ' ' ? end + 2 : end + 1, name: text.slice(start + 1, end) };
    }

    // bigPromptEditor: the prompt box takes the window's full height and the pane narrows to the
    // column above the controls. The pane changed size without a window resize, so the open
    // box's clamp is redone here.
    // The session keeps the flag, so a reload comes back in the same layout.
    let bigPromptEditor = false;
    let bigPromptLoaded = false;
    function setBigPromptEditor(on) {
      if (on === bigPromptEditor) return;
      bigPromptEditor = on;
      document.querySelector('.shell').classList.toggle('big-prompt-editor', on);
      resyncSelectedBlock();
      vscode.postMessage({ type: 'bigPromptChanged', sessionId, on });
    }

    // promptSent: after a send the box keeps the prompt, read-only and yellow, to be read against
    // the answer. Ctrl-Enter clears it and leaves big-box mode; Load, Cap and a File pick clear it
    // and keep the size. The session keeps the flag, like bigPromptEditor.
    let promptSent = false;
    function setPromptSent(on) {
      promptSent = on;
      promptBox.updateOptions({ readOnly: on });
      monaco.editor.setTheme(on ? 'claude2-sent' : 'claude2');
      promptHost.classList.toggle('sent', on);
      vscode.postMessage({ type: 'sentPromptChanged', sessionId, on });
    }
    // Back to edit mode on an empty box. An edit, so ctrl-z brings the sent text back to edit.
    function leaveSent() {
      if (!promptSent) return;
      setPromptSent(false);
      replaceText(0, promptModel.getValueLength(), '');
    }

    // Which 🖼️ char a mouse event on element at clientX is on, or -1 for anywhere else. The chars
    // are one injected span, all the same width, so the x offset into the span decides.
    function imageCharAt(element, clientX) {
      const span = imageCount && element && element.closest ? element.closest('.img-char') : null;
      if (!span) return -1;
      const box = span.getBoundingClientRect();
      const index = Math.floor((clientX - box.left) / (box.width / imageCount));
      return index >= 0 && index < imageCount ? index : -1;
    }

    // A stored prompt without the sentences the attached pictures added to it. Those sentences are
    // how the CLI reads each picture, so they stay in what was sent; they are just not what the
    // user typed, and a prompt bar shows the typing with 🖼️ chars in front of it.
    function typedText(turn) {
      return (turn.prompt || '')
        .replace(/\\n\\n\\[(?:A screenshot of the user's desktop|An image) is attached\\. Read the image file [^\\]]* to view it\\.\\]/g, '')
        .replace(/\\n\\n\\[<[^>\\n]*> is the file [^\\]]*\\]/g, '');
    }

    // The turn a stop has been asked for, so the Stop button can show that the request is in
    // flight. Cleared by the first render where that turn is no longer the running one.
    let stoppingTurn = null;

    function markStopping() {
      // A prompt sent during a background wait usually joins the run rather than stopping it.
      if (!status || !status.active || status.phase === 'background') return;
      stoppingTurn = status.turnId;
      stopButton.classList.add('stopping');
    }

    function submitPrompt() {
      if (promptSent) {
        leaveSent();
        setBigPromptEditor(false);
        return;
      }
      // The 🖼️ chars are this pane's way of showing the attached pictures, not part of the
      // prompt: the extension has the list, and appends a sentence per picture to the text.
      const prompt = promptModel.getValue();
      // Sending during a run is allowed: the extension stops the running turn and takes this
      // prompt instead, so Ctrl-Enter never has to wait for an answer that is no longer wanted.
      if (!prompt.trim() && !imageCount) return setBigPromptEditor(!bigPromptEditor);
      shell.classList.remove('snips-open');
      markStopping();
      vscode.postMessage({ type: 'submitPrompt', sessionId, prompt, model: modelSelect.value, effort: effortSelect.value, advisor: advisorSelect.value });
      // The text stays, read-only, and the extension drops its draft copy on its own.
      draftSent = '';
      imageCount = 0;
      showImageChars();
      setPromptSent(true);
      // The new turn's block is selected and opened when it arrives; every other box closes
      // with it, since only one box is ever open.
      pendingTurnCount = session.turns.length + 1;
      // A keyboard submit is the one selection change with no mouse press to thaw the pane.
      if (frozenPane) thaw();
    }

    // Fills a box with the response. Where the run marked the start of its closing answer, the
    // answer sits under a rule of its own.
    function fillBox(box, text, tools) {
      box.replaceChildren();
      const parts = text.split('\\n' + ANSWER_MARK + '\\n');
      appendResponse(box, parts[0], tools);
      if (parts.length > 1) {
        // With tools hidden, a run whose work was all tool calls leaves nothing above the rule.
        if (box.textContent.trim()) {
          const rule = document.createElement('hr');
          rule.className = 'answer-rule';
          box.appendChild(rule);
        }
        appendResponse(box, parts.slice(1).join('\\n'), tools);
      }
    }

    // Adds response text to a box as markdown. With tools, each run of tool lines sits
    // between the prose around it as a monospace group; tool lines are plain text except
    // for a leading **bold** tool name. Blank lines do not end a group.
    function appendResponse(box, text, tools) {
      if (!tools) {
        box.insertAdjacentHTML('beforeend', renderMarkdown(strippedText(text)));
        return;
      }
      let prose = [];
      let group = null;
      const flushProse = () => {
        const kept = strippedText(prose.join('\\n'));
        if (kept) box.insertAdjacentHTML('beforeend', renderMarkdown(kept));
        prose = [];
      };
      for (const line of text.split('\\n')) {
        if (!isToolLine(line)) {
          prose.push(line);
          if (line.trim() && !line.startsWith(GRAFT_TALLY_MARK)) group = null;
          continue;
        }
        flushProse();
        if (group) group.appendChild(document.createTextNode('\\n'));
        else {
          group = document.createElement('div');
          group.className = 'tool-group';
          box.appendChild(group);
        }
        appendFormattedLine(group, line);
      }
      flushProse();
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
        // Tool lines open with an "hh:mm:ss " timestamp ahead of the bold name; older saved ones don't.
        const bold = /^(\\d\\d:\\d\\d:\\d\\d )?\\*\\*([^*]+)\\*\\*/.exec(line);
        if (!bold) {
          target.appendChild(document.createTextNode(line));
          return;
        }
        if (bold[1]) target.appendChild(document.createTextNode(bold[1]));
        const name = document.createElement('b');
        name.textContent = bold[2];
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

    // What the markdown box renders: the response without its tool lines — no leading blanks,
    // runs of blank lines collapsed to one so the paragraph breaks survive.
    function strippedText(text) {
      const kept = [];
      for (const line of text.split('\\n')) {
        if (isToolLine(line) || line.startsWith(GRAFT_TALLY_MARK)) continue;
        if (!line.trim() && (!kept.length || !kept[kept.length - 1].trim())) continue;
        kept.push(line);
      }
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      return kept.join('\\n');
    }

    // The markdown renderer, deliberately small: the blocks Claude actually emits (headings,
    // fences, lists, quotes, tables, rules) and the inline runs inside them.
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

    // The session as the pane shows it with every box open and tool groups hidden: each prompt
    // as a quote, then its box the way fillBox splits it, answer rule included. Blocks are
    // separated by a rule of their own.
    function exportMarkdown() {
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const blocks = turns.map((turn) => {
        const images = Array.isArray(turn.images) ? turn.images : [];
        const prompt = IMG.repeat(images.length) + (typedText(turn) || (images.length ? '' : '(empty prompt)'));
        const out = [prompt.split('\\n').map((line) => '> ' + line).join('\\n')];
        const [head, ...rest] = (turn.response || '').split('\\n' + ANSWER_MARK + '\\n');
        const work = strippedText(head);
        const answer = rest.length ? strippedText(rest.join('\\n')) : '';
        if (work) out.push(work);
        if (work && answer) out.push('***');
        if (answer) out.push(answer);
        if (turn.error) out.push('**Error:** ' + turn.error);
        return out.join('\\n\\n');
      });
      return '# ' + (session.name || 'New session') + '\\n\\n' + blocks.join('\\n\\n---\\n\\n') + '\\n';
    }

    function render() {
      const active = status && status.active;
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const wasAnchor = anchorIndex;
      anchorIndex = Math.max(0, Math.min(turns.length - 1, anchorIndex));
      // First non-empty state after the webview opens: land on the newest block, box open.
      if (!initializedSelection && turns.length) {
        initializedSelection = true;
        anchorIndex = turns.length - 1;
        boxOpen = true;
        boxScrollNext = 'restore';
        toolsBox = false;
      }
      if (pendingTurnCount && turns.length >= pendingTurnCount) {
        anchorIndex = pendingTurnCount - 1;
        boxOpen = true;
        boxScrollNext = 'restore';
        toolsBox = false;
        pendingTurnCount = 0;
      }
      // A run that just started selects and opens its new block. The user is free to move
      // the selection or close the box afterwards, leaving the run to stream invisibly.
      if (active && status.turnId !== shownActiveTurn) {
        shownActiveTurn = status.turnId;
        const activeIndex = turns.findIndex((turn) => turn.id === status.turnId);
        if (activeIndex >= 0) {
          anchorIndex = activeIndex;
          boxOpen = true;
          boxScrollNext = 'restore';
        }
      }
      // Nav row enablement, once the selection has settled: each button greys out when the move
      // it offers would do nothing. Cap is the exception -- it is always live.
      stopButton.disabled = !active;
      // Clr sends /clear, which would stop a running turn, and has nothing to clear before one.
      clrButton.disabled = active || !session.turns.length;
      // The stopped turn has ended (or a Ctrl-Enter replacement has started in its place).
      if (stoppingTurn && (!active || status.turnId !== stoppingTurn)) {
        stoppingTurn = null;
        stopButton.classList.remove('stopping');
      }
      // A run that ended (or gave way to a new one) leaves its box as the wasStreaming box. That
      // box closing, for any reason, makes it standard, and its next open is a first open.
      if (streamingTurn && (!active || status.turnId !== streamingTurn)) {
        wasStreaming = streamingTurn;
        // A finished run's box drops its tool groups, the same as a fresh open.
        if (turns[anchorIndex] && turns[anchorIndex].id === streamingTurn) toolsBox = false;
      }
      streamingTurn = active ? status.turnId : null;
      const openTurn = boxOpen && turns[anchorIndex] ? turns[anchorIndex].id : null;
      if (wasStreaming && wasStreaming !== openTurn) {
        delete boxScrolls[wasStreaming];
        saveBoxScrolls();
        wasStreaming = null;
      }
      // Rebuilding throws the open box's scroll away, so it is measured first and restored,
      // still pinned to the bottom when it was there (how a streaming box follows its text).
      const selectedResponse = historyBox.querySelector('[data-index="' + anchorIndex + '"] .response');
      const selectedResponseTop = selectedResponse ? selectedResponse.scrollTop : 0;
      const selectedResponseAtBottom = selectedResponse ? selectedResponse.scrollHeight - selectedResponse.scrollTop - selectedResponse.clientHeight < 18 : false;
      const paneTop = historyBox.scrollTop;
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
          // The hover leads with the model and effort this prompt actually ran under, which is not
          // necessarily what the dock is set to now.
          // modelId is what actually answered, which an alias like opus[1m] does not say.
          const ranAs = [turn.model && modelLabel(turn.model), turn.effort, turn.modelId].filter(Boolean).join(' / ');
          const typed = typedText(turn);
          // When it was sent rides at the right end of the model/effort line (tip-aside), or takes
          // that line itself when the turn predates recording what it ran as.
          const sent = turn.createdAt ? new Date(turn.createdAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
          bar.title = [ranAs || sent, typed].filter(Boolean).join('\\n');
          if (ranAs && sent) bar.dataset.tipAside = sent;
          // One 🖼️ char per picture this prompt was sent with, reading the same as the prompt
          // box did before it went. They are spans so a click can say which one it hit; the
          // pictures themselves are part of the record now, so a ctrl-click only shows them too.
          const images = Array.isArray(turn.images) ? turn.images : [];
          bar.textContent = '';
          // A running turn whose box is closed says so with a blinking arrow; the delay is set from
          // the clock so the rebuild on every streamed chunk doesn't restart the blink.
          const boxShown = allOpen || (index === anchorIndex && boxOpen);
          if (active && status.turnId === turn.id && !boxShown) {
            const arrow = document.createElement('span');
            arrow.className = 'run-arrow';
            arrow.textContent = '\u2193';
            arrow.style.animationDelay = -(Date.now() % 600) + 'ms';
            bar.appendChild(arrow);
          }
          const forkIcon = document.createElement('span');
          forkIcon.className = 'bar-icon';
          forkIcon.title = 'Fork here: copy the session, then drop every block below this one';
          forkIcon.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 1v5l-4 4v5M8 6l4 4v5M2 12.5 4 15l2-2.5M10 12.5 12 15l2-2.5"/></svg>';
          bar.appendChild(forkIcon);
          images.forEach((image, imageIndex) => {
            const char = document.createElement('span');
            char.className = 'img-char';
            char.dataset.image = String(imageIndex);
            char.textContent = IMG;
            bar.appendChild(char);
          });
          bar.appendChild(document.createTextNode(typed || (images.length ? '' : '(empty prompt)')));
          bar.addEventListener('click', (event) => {
            if (event.target && event.target.closest && event.target.closest('.bar-icon')) {
              // The extension asks before a fork, and refuses one while this session is running.
              vscode.postMessage({ type: 'forkTurn', sessionId, turnId: turn.id });
              return;
            }
            const char = event.target && event.target.closest ? event.target.closest('.img-char') : null;
            if (char) {
              vscode.postMessage({ type: 'showImage', sessionId, turnId: turn.id, index: Number(char.dataset.image) });
              return;
            }
            if (event.altKey) {
              vscode.postMessage({ type: 'copyText', sessionId, text: typed });
              bar.animate([{ backgroundColor: '#ffc9c9' }, { backgroundColor: '#ffc9c9' }], 200);
              return;
            }
            if (event.ctrlKey) {
              if (expandedPrompts.has(turn.id)) expandedPrompts.delete(turn.id); else expandedPrompts.add(turn.id);
              if (index === anchorIndex) render(); else selectBlock(index);
              return;
            }
            // A click selects the block, which opens it; on the already-selected bar it is
            // the open/close toggle instead, and closing it leaves every box closed.
            if (index !== anchorIndex) {
              selectBlock(index);
              return;
            }
            boxOpen = !boxOpen;
            if (boxOpen) {
              boxScrollNext = 'restore';
              // Every fresh open starts with its tool groups hidden.
              toolsBox = false;
            }
            render();
          });
          wrapper.appendChild(bar);
          const isActiveTurn = active && status.turnId === turn.id;
          // Only the selected block's box exists, and only while open (allOpen shows them all).
          // A streaming turn is no exception: moved away from or closed, its text keeps
          // arriving invisibly.
          if (boxShown) {
            // The streaming box keeps its tool groups up — they are the run's progress
            // display — and does not answer clicks.
            const locked = isActiveTurn;
            const tools = locked || (index === anchorIndex && toolsBox);
            const response = document.createElement('div');
            response.className = 'response markdown' + (turn.error ? ' error' : '');
            // A run that failed part way still wrote everything up to that point, so the text stays
            // and the reason goes underneath it rather than in its place.
            fillBox(response, turn.response || '', tools);
            if (turn.error) {
              const note = document.createElement('div');
              note.className = 'error-note';
              note.textContent = turn.error;
              response.appendChild(note);
            }
            response.addEventListener('click', (event) => {
              if (event.altKey) {
                // The whole box, as shown: a failed turn keeps its partial text and gains the reason.
                const body = turn.error ? (turn.response || '') + ((turn.response || '') ? '\\n\\n' : '') + turn.error : (turn.response || '');
                vscode.postMessage({ type: 'copyText', sessionId, text: tools ? body : strippedText(body) });
                response.animate([{ backgroundColor: '#ffc9c9' }, { backgroundColor: '#ffc9c9' }], 200);
                return;
              }
              // A plain click is left to text selection; only a ctrl-click toggles.
              // toolsBox is the selected box's view, so a box shown only by allOpen has no toggle.
              if (locked || !event.ctrlKey || index !== anchorIndex) return;
              // A click on a rendered link is the link, not the toggle; a drag that selected
              // text is a selection.
              if (event.target.closest && event.target.closest('a')) return;
              if (!window.getSelection().isCollapsed) return;
              toolsBox = !toolsBox;
              // The two views shape the text differently, so a kept scroll offset lands
              // nowhere useful: every toggle starts from the top.
              boxScrollNext = 'top';
              render();
            });
            // Every scroll — the user's, a restore, or streaming's pin to the end — lands in
            // the memory, so wherever the box is left is where it comes back.
            response.addEventListener('scroll', () => noteBoxScroll(turn.id, response));
            wrapper.appendChild(response);
          }
          historyBox.appendChild(wrapper);
        });
      }
      // A frozen pane keeps its spot through the rebuild instead of following the selection.
      if (frozenPane) historyBox.scrollTop = paneTop;
      // A selection that moved for any other reason (a fork shrank the list) still lands
      // its box on its remembered position, the same as every other fresh open.
      if (boxScrollNext === null && anchorIndex !== wasAnchor) boxScrollNext = 'restore';
      let boxScroll = boxScrollNext !== null ? boxScrollNext : selectedResponseAtBottom ? 'bottom' : selectedResponseTop;
      if (boxScroll === 'restore') {
        const turn = turns[anchorIndex];
        const saved = turn ? boxScrolls[turn.id] : undefined;
        boxScroll = saved !== undefined ? saved : active && turn && status.turnId === turn.id ? 'bottom' : 'top';
      }
      boxScrollNext = null;
      requestAnimationFrame(() => syncSelectedBlock(boxScroll));
      renderStatus();
    }

    // Which compaction the gauge has already flagged, and the timer that takes the flag back off.
    let compactSeen = 0;
    let compactTimer = null;

    function flagCompaction() {
      document.getElementById('context').classList.add('compacted');
      if (compactTimer !== null) window.clearTimeout(compactTimer);
      compactTimer = window.setTimeout(clearCompaction, 60000);
    }

    function clearCompaction() {
      if (compactTimer !== null) {
        window.clearTimeout(compactTimer);
        compactTimer = null;
      }
      document.getElementById('context').classList.remove('compacted');
    }

    // A flagged gauge takes the click as "seen"; an unflagged one as "compact now". Never while a
    // run is going: a send then would stop that run, and a click on a number shouldn't do that.
    document.getElementById('context').addEventListener('click', (event) => {
      if (event.currentTarget.classList.contains('compacted')) return clearCompaction();
      if ((status && status.active) || !session.turns.length) return;
      vscode.postMessage({ type: 'submitPrompt', sessionId, prompt: '/compact', model: modelSelect.value, effort: effortSelect.value, advisor: advisorSelect.value, keepDraft: true });
    });

    // Acknowledging the quota warning is durable: the extension clears the stored flag and
    // pushes the cleared footer back, so every pane and every reload agrees it is gone.
    document.getElementById('cost').addEventListener('click', () => {
      if (footer.quotaAlert) vscode.postMessage({ type: 'clearQuotaAlert' });
    });

    function renderStatus() {
      const active = status && status.active;
      const turns = Array.isArray(session.turns) ? session.turns : [];
      const latest = turns[turns.length - 1];
      // Context is a level, so it holds at wherever the conversation last sat. Turns that errored
      // before an API call carry no level, hence the scan back rather than reading only the latest.
      const used = active ? status.contextTokens : turns.reduce((level, turn) => turn.contextUsed || (turn.cleared ? 0 : level), 0);
      // Against the compaction point, not the window: the conversation is summarised there, so that
      // is the ceiling the level is really climbing towards. Only the denominator carries the K.
      const contextBox = document.getElementById('context');
      contextBox.textContent = Math.round((used || 0) / 1000) + '/' + inK(compactAt);
      // Latched locally the moment a new compaction is reported: the run's status stops being
      // posted once the turn ends, so the flag can't hang off it for its whole minute.
      if (active && status.compactedAt && status.compactedAt !== compactSeen) {
        compactSeen = status.compactedAt;
        flagCompaction();
      }
      // Per prompt, not cumulative: the limit below is a per-prompt ceiling, so the numerator has to
      // be the count that ceiling actually bounds. The running prompt's count rides on the status
      // until it lands on the turn at completion.
      const agentic = active ? status.turns || 0 : (latest ? latest.turns || 0 : 0);
      const turnLimit = active ? status.maxTurns || maxTurns : ((latest && latest.maxTurns) || maxTurns);
      document.getElementById('turns').textContent = agentic + '/' + turnLimit;
      // Cost and time are flows, so every turn of the conversation adds in. The running turn has
      // neither recorded yet, so its elapsed time is carried separately and its cost lands at the end.
      const cost = turns.reduce((sum, turn) => sum + (turn.costUsd || 0), 0);
      // With graft on, what the session would have cost without it sits alongside what it did
      // cost — but only once they differ by a nickel, below which the second figure says nothing.
      const saved = footer.graft ? footer.graftSavedUsd || 0 : 0;
      const costBox = document.getElementById('cost');
      costBox.textContent = saved >= 0.05
        ? '$' + cost.toFixed(2) + '/' + (cost + saved).toFixed(2)
        : '$' + cost.toFixed(2);
      costBox.classList.toggle('quota-alert', !!footer.quotaAlert);
      // dataset.tip, not title: the tooltip helper moves title into it on first hover and reads
      // only that afterwards, so a later title change would never be seen.
      costBox.dataset.tip = footer.quotaAlert ? 'A plan window passed 95% — click to clear' : '';
      // Cumulative ponytail skips: stored turns carry theirs, and the running turn's live ones
      // ride on the status until they land on the turn at completion — never both at once.
      // Against the workspace's ceiling comments, the other half of what ponytail leaves behind.
      let skips = turns.reduce((sum, turn) => sum + ((turn.ponySkips || []).length), 0);
      if (active) {
        skips += (status.ponySkips || []).length;
      }
      document.getElementById('pony').textContent = skips + ':' + (footer.ceilings || 0);
      const projected = typeof footer.quotaProjected === 'number' ? footer.quotaProjected : null;
      document.getElementById('projected').textContent = projected === null ? '--' : projected + '%';
      const spent = turns.reduce((sum, turn) => sum + (turn.durationMs || 0), 0);
      document.getElementById('duration').textContent = shortTime(spent + (active ? liveElapsed() : 0));
      // Time since the CLI last sent anything while streaming; zero when idle.
      document.getElementById('quiet').textContent = shortTime(active ? liveQuiet() : 0);
      // One letter, with the full word on hover: T/W/Q/w/C/B while streaming (working, the wait
      // between blocks, is lower-case so it reads apart from writing), F or S once the turn lands, R when idle.
      const label = active
        ? (status.phase || 'working')
        : latest && latest.finished
          ? (latest.stopped ? 'stopped' : 'finished')
          : 'ready';
      finish.className = 'indicator' + (active ? ' active' : latest && latest.finished ? ' done' : '') + (label === 'working' ? ' waiting' : '');
      finish.textContent = label === 'working' ? 'w' : label.charAt(0).toUpperCase();
      finish.dataset.status = label.charAt(0).toUpperCase() + label.slice(1);
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

    // Time since the CLI last sent anything, run forward the same way.
    function liveQuiet() {
      return (status.sinceEventMs || 0) + Math.max(0, Date.now() - statusAt);
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
      // Spliced at its offset, not appended: a sessionState that landed first may already hold it.
      if (message.delta) turn.response = (turn.response || '').slice(0, message.at) + message.delta;
      // A turn this webview has not anchored yet: the full render selects and opens it.
      if (status && status.active && status.turnId !== shownActiveTurn) {
        render();
        return;
      }
      const node = historyBox.querySelector('[data-turn-id="' + message.turnId + '"]');
      const response = node ? node.querySelector('.response') : null;
      // No box in the DOM means the streaming block is closed or unselected: the text keeps
      // arriving in the session data, invisibly.
      if (!response) {
        renderStatus();
        return;
      }
      if (message.delta) {
        const atBottom = response.scrollHeight - response.scrollTop - response.clientHeight < 18;
        const savedTop = response.scrollTop;
        fillBox(response, turn.response || '', true);
        if (Number(node.dataset.index) === anchorIndex) {
          requestAnimationFrame(() => syncSelectedBlock(atBottom ? 'bottom' : savedTop));
        }
      }
      renderStatus();
    }

    // Remember where a box sits, as 'bottom' when it is pinned there so it stays pinned even
    // after the text grows. The debounced echo keeps the extension's copy — the one that
    // outlives this webview — current without spamming it during a streaming run.
    function noteBoxScroll(turnId, response) {
      const atBottom = response.scrollHeight - response.scrollTop - response.clientHeight < 18;
      boxScrolls[turnId] = atBottom ? 'bottom' : response.scrollTop;
      saveBoxScrolls();
    }

    function saveBoxScrolls() {
      window.clearTimeout(boxScrollTimer);
      boxScrollTimer = window.setTimeout(() => {
        vscode.postMessage({ type: 'boxScrollsChanged', sessionId, boxScrolls });
      }, 250);
    }

    function selectBlock(index) {
      if (!session.turns.length) return;
      const nextIndex = Math.max(0, Math.min(session.turns.length - 1, index));
      // Deliberate navigation outranks a submit's queued jump to the not-yet-arrived turn.
      pendingTurnCount = 0;
      if (nextIndex === anchorIndex) return;
      anchorIndex = nextIndex;
      // A selection change always opens the newly selected block, on its remembered scroll
      // position and as a markdown box.
      boxOpen = true;
      boxScrollNext = 'restore';
      toolsBox = false;
      render();
    }

    // The window the pane's scrollTop must stay in so the bar above the selected block, the
    // whole selected block, and the bar below all sit inside the pane at once. min > max can
    // only happen in a pane too short for that span; the bottom bar is given up first.
    function scrollBounds() {
      const node = historyBox.querySelector('[data-index="' + anchorIndex + '"]');
      if (!node) return null;
      const above = historyBox.querySelector('[data-index="' + (anchorIndex - 1) + '"]');
      const below = historyBox.querySelector('[data-index="' + (anchorIndex + 1) + '"]');
      const end = below || node;
      // The turns' offsetParent is the body, not the history box, so its own offset is
      // subtracted to land in the box's scroll coordinates.
      const base = historyBox.offsetTop;
      const max = Math.max(0, (above || node).offsetTop - base);
      const min = Math.max(0, end.offsetTop + end.offsetHeight - base - historyBox.clientHeight);
      return { min: Math.min(min, max), max };
    }

    // Applies the auto-scrolling rules: clamp the open box so its whole region (bordering
    // bars included) fits the pane, then move the pane scroll the minimum distance into the
    // allowed window. boxScroll positions the box contents afterwards: 'bottom', 'top', or
    // a number restoring a kept offset.
    function syncSelectedBlock(boxScroll) {
      // Scrub old clamps first so the measurements below see natural heights.
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
      const above = historyBox.querySelector('[data-index="' + (anchorIndex - 1) + '"]');
      const below = historyBox.querySelector('[data-index="' + (anchorIndex + 1) + '"]');
      const paneHeight = historyBox.clientHeight;
      const spanHeight = () => {
        const end = below || node;
        return end.offsetTop + end.offsetHeight - (above || node).offsetTop;
      };
      // With every box open the neighbours' boxes fill the span, which would squeeze this one
      // to a line; the pane scrolls over them all at their natural heights instead.
      // A ctrl-expanded prompt gives way first, down to three lines, before the box does.
      if (!allOpen && bar && bar.classList.contains('prompt-expanded') && spanHeight() > paneHeight) {
        const lineHeight = parseFloat(getComputedStyle(bar).lineHeight) || 20;
        bar.style.maxHeight = Math.ceil(lineHeight * 3 + 4) + 'px';
        bar.style.overflowY = 'auto';
      }
      if (response && !allOpen) {
        const excess = spanHeight() - paneHeight;
        if (excess > 0) {
          const lineHeight = parseFloat(getComputedStyle(response).lineHeight) || 20;
          response.style.maxHeight = Math.max(Math.ceil(lineHeight + 18), response.offsetHeight - excess) + 'px';
          response.style.overflowY = 'auto';
        }
      }
      const bounds = frozenPane ? null : scrollBounds();
      if (bounds) {
        const target = Math.min(bounds.max, Math.max(bounds.min, historyBox.scrollTop));
        if (target !== historyBox.scrollTop) {
          programmaticScroll = true;
          historyBox.scrollTop = target;
          window.setTimeout(() => { programmaticScroll = false; }, 80);
        }
      }
      if (response) {
        if (boxScroll === 'bottom') response.scrollTop = response.scrollHeight;
        else if (boxScroll === 'top') response.scrollTop = 0;
        else response.scrollTop = boxScroll || 0;
      }
    }

    vscode.postMessage({ type: 'conversationReady', sessionId });
  </script>
</body>
</html>`;
}

// Every management pane but Image opens under the same row of tabs; `alert` turns the Models
// tab light red until a changed model list has been looked at.
export function managementHtml(webview: vscode.Webview, pane: ManagementPane, timezone: string, zoom = 1, alert = false): string {
  if (pane === "plugins") {
    return pluginsHtml(webview, zoom, alert);
  }
  if (pane === "models") {
    return modelsHtml(webview, zoom, alert);
  }
  if (pane === "settings") {
    return settingsHtml(webview, zoom, alert);
  }
  if (pane === "cap") {
    return capHtml(webview, zoom);
  }
  return pane === "instructions" ? instructionsHtml(webview, zoom, alert) : quotaHtml(webview, timezone, zoom, alert);
}

const gearIcon = '<svg viewBox="0 0 16 16"><path d="M6.74 2.54L6.83 0.59L9.17 0.59L9.26 2.54A5.6 5.6 0 0 1 10.97 3.25L12.41 1.93L14.07 3.59L12.75 5.03A5.6 5.6 0 0 1 13.46 6.74L15.41 6.83L15.41 9.17L13.46 9.26A5.6 5.6 0 0 1 12.75 10.97L14.07 12.41L12.41 14.07L10.97 12.75A5.6 5.6 0 0 1 9.26 13.46L9.17 15.41L6.83 15.41L6.74 13.46A5.6 5.6 0 0 1 5.03 12.75L3.59 14.07L1.93 12.41L3.25 10.97A5.6 5.6 0 0 1 2.54 9.26L0.59 9.17L0.59 6.83L2.54 6.74A5.6 5.6 0 0 1 3.25 5.03L1.93 3.59L3.59 1.93L5.03 3.25A5.6 5.6 0 0 1 6.74 2.54ZM10.3 8A2.3 2.3 0 1 0 5.7 8A2.3 2.3 0 1 0 10.3 8Z"/></svg>';

// An icon tab carries its name as a tooltip instead.
const managementTabs: [ManagementPane, string, string?][] = [
  ["quota", "Quotas"],
  ["instructions", "Rules"],
  ["plugins", "Stats"],
  ["models", "Models"],
  ["settings", gearIcon, "Settings"],
];

// The tabs lead each pane's title row, where the pane's own heading used to be; they act as
// radio buttons, the extension swapping the whole pane on a click.
function tabsHtml(pane: ManagementPane, alert: boolean): string {
  const tabs = managementTabs.map(([id, label, name]) => `<button class="tab${id === pane ? " selected" : ""}${id === "models" && alert ? " alert" : ""}" data-pane="${id}"${name ? ` title="${name}" aria-label="${name}"` : ""}>${label}</button>`);
  return `<div class="tabs">${tabs.join("")}</div>`;
}

function tabsStyle(): string {
  return `    .tabs { display: flex; gap: 6px; flex: none; }
    .tabs .tab.selected { background: #e2e2e2; }
    .tabs .tab.alert { background: #fbd9d9; border-color: #e4a7a7; }
    /* position: static undoes the Quotas pane's chart svg rule. */
    .tabs svg { position: static; display: block; width: calc(16px * var(--z)); height: calc(16px * var(--z)); fill: currentColor; fill-rule: evenodd; }
`;
}

function tabsScript(): string {
  return `
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => { if (!tab.classList.contains('selected')) vscode.postMessage({ type: 'openTab', pane: tab.dataset.pane }); });
    }
    window.addEventListener('message', (event) => {
      if (event.data.type === 'modelsAlert') document.querySelector('.tab[data-pane="models"]').classList.toggle('alert', event.data.on === true);
    });
`;
}

// The Models pane: what this host's CLI offers (every window on the host sees the same), one
// column per model, and which of them are the presets the footer's M button steps through.
// Opening it is what clears the update alert.
function modelsHtml(webview: vscode.Webview, zoom: number, alert: boolean): string {
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
    body { margin: 0; background: var(--page); color: var(--ink); font: calc(16px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; gap: 16px; padding: 4px 24px 20px; }
    .title { display: flex; align-items: center; gap: 12px; }
    .actions { margin-left: auto; display: flex; gap: 12px; align-items: center; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 8px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .box { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 12px 16px; }
    h2 { font-size: calc(17px * var(--z)); font-weight: 600; margin: 0 0 8px; }
    table { border-collapse: collapse; margin-bottom: 8px; }
    #models td, #models th { padding: 3px 20px 3px 0; text-align: left; vertical-align: top; }
    #models th { font-weight: 600; }
    /* The model and Descr columns never wrap; they grow to fit. */
    #models td:nth-child(-n+2) { white-space: nowrap; }
    #models input[type=checkbox] { width: 18px; height: 18px; margin: 0; }
    #models input[type=text] { font: inherit; color: var(--ink); width: 9em; padding: 2px 6px; }
    #models select { min-width: 6em; }
    #old td, #old th { padding: 3px 20px 3px 0; text-align: left; white-space: nowrap; }
    #old th { font-weight: 600; }
    .change-head { display: flex; align-items: center; margin-bottom: 8px; }
    .change-head h2 { margin: 0; }
    #dismiss { margin-left: auto; min-height: 0; padding: 2px 6px; }
    #usage td, #usage th { padding: 3px 0 3px 24px; text-align: right; }
    #usage td:first-child, #usage th:first-child { padding-left: 0; text-align: left; }
    #usage th { font-weight: 600; }
    .usage-head { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
    .usage-head h2 { margin: 0; }
    #usageMode { min-width: 0; }
    select { font: inherit; color: var(--ink); min-width: 14em; }
    .save-row { display: flex; gap: 12px; align-items: center; margin-top: 10px; }
${tabsStyle()}  </style>
</head>
<body>
  <div class="pane">
    <div class="title">${tabsHtml("models", alert)}<div class="actions"><button id="close">Close</button></div></div>
    <div class="box"><h2>Models By Value</h2><table id="models"></table><div id="changed"></div><div class="save-row">New sessions start on <select id="default"></select></div><div class="save-row"><button id="save">Save</button><span id="note"></span></div></div>
    <div class="box" id="change" hidden><div class="change-head"><h2 id="changeTitle"></h2><button id="dismiss" title="Hide until the list changes again" aria-label="Dismiss">✕</button></div><table id="old"></table></div>
    <div class="box"><div class="usage-head"><h2>Messages Per Model ID</h2><select id="usageMode"><option>Past</option><option>Days</option></select></div><table id="usage"><tr><td>Counting…</td></tr></table><div id="machines"></div></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${tabsScript()}
${zoomScript(z)}
    const pending = new Map();
    let models = {};
    let names = {};
    let prefs = {};
    // Models whose Preset box is checked, and the one new sessions start on.
    let presetModels = new Set();
    let defaultModel = '';

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        pending.get(message.requestId)(message);
        pending.delete(message.requestId);
      }
    });
    document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'closeManagement' }));
    document.getElementById('save').addEventListener('click', () => void save());
    document.getElementById('dismiss').addEventListener('click', () => {
      document.getElementById('change').hidden = true;
      void request('dismissModelChange', {});
    });
    document.getElementById('default').addEventListener('change', (event) => { defaultModel = event.target.value; unsaved(); });
    void load();
    void loadUsage();
    document.getElementById('usageMode').addEventListener('change', renderUsage);

    function request(type, payload) {
      const requestId = String(Date.now()) + Math.random();
      return new Promise((resolve) => { pending.set(requestId, resolve); vscode.postMessage(Object.assign({ type, requestId }, payload)); });
    }

    async function load() {
      const reply = await request('loadModels', {});
      if (!reply.ok) {
        document.getElementById('changed').textContent = 'Could not load the model info: ' + (reply.error || 'unknown error');
        return;
      }
      const info = reply.payload;
      models = info.models || {};
      names = info.names || {};
      prefs = info.prefs || {};
      const presets = (info.presets || []).filter((preset) => preset.enabled);
      presetModels = new Set(presets.map((preset) => preset.model));
      // Records saved before the pane had a per-model effort keep it on their preset instead.
      for (const preset of presets) {
        if (preset.model in models && !pref(preset.model).effort) pref(preset.model).effort = preset.effort;
      }
      const chosen = (info.presets || [])[info.defaultPreset || 0];
      defaultModel = chosen && chosen.enabled ? chosen.model : '';
      renderModels();
      renderChange(info);
      document.getElementById('changed').textContent = 'Last changed ' + new Date(info.date).toLocaleString();
      note('');
    }

    // The list from before the last change, one row per model in either list, each marked with
    // what happened to it: gone, added, or changed (an old name or id differs). Old values shown.
    function renderChange(info) {
      const previous = info.previous;
      document.getElementById('change').hidden = !previous;
      if (!previous) return;
      document.getElementById('changeTitle').textContent = 'Models before the change on ' + new Date(info.date).toLocaleString();
      const table = document.getElementById('old');
      table.replaceChildren();
      const head = table.insertRow();
      for (const text of ['Change', 'Model', 'Descr', 'ID']) {
        const th = document.createElement('th');
        th.textContent = text;
        head.appendChild(th);
      }
      const all = [...new Set(Object.keys(previous.models).concat(Object.keys(info.models)))].sort((a, b) => a.localeCompare(b));
      for (const model of all) {
        const old = model in previous.models;
        const now = model in info.models;
        const changed = old && now && ((previous.names[model] || '') !== (info.names[model] || '') || (previous.ids[model] && previous.ids[model] !== info.ids[model]));
        const source = old ? previous : info;
        const row = table.insertRow();
        for (const text of [!now ? 'gone' : !old ? 'added' : changed ? 'changed' : '', model, source.names[model] || '', (source.ids || {})[model] || '']) {
          row.insertCell().textContent = text;
        }
      }
    }

    // Every model any machine's transcripts used, busiest of all time first.
    // Per-hour counts for every model, as the extension summed them; null until they arrive.
    let usageHours = null;

    async function loadUsage() {
      const reply = await request('loadModelUsage', {});
      if (!reply.ok) {
        const table = document.getElementById('usage');
        table.replaceChildren();
        table.insertRow().insertCell().textContent = 'Could not count messages: ' + (reply.error || 'unknown error');
        return;
      }
      usageHours = reply.payload.hours || {};
      const machines = Object.entries(reply.payload.machines || {});
      document.getElementById('machines').textContent = machines.length
        ? 'Counted from ' + machines.map(([name, at]) => name + ' (' + new Date(at).toLocaleString() + ')').join(', ')
        : 'This machine only: the stats server could not be reached';
      renderUsage();
    }

    // Past: trailing windows ending now. Days: the last seven local calendar days, oldest first.
    function usageColumns() {
      const hour = 3600000;
      if (document.getElementById('usageMode').value === 'Past') {
        const hourNow = Math.floor(Date.now() / hour);
        return [['24 hours', 24], ['3 days', 72], ['Week', 168], ['All time', Infinity]]
          .map(([label, age]) => ({ label, has: (h) => hourNow - h < age }));
      }
      const columns = [];
      for (let back = 6; back >= 0; back--) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - back);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const label = start.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
        columns.push({ label, has: (h) => h * hour >= start.getTime() && h * hour < end.getTime() });
      }
      return columns;
    }

    function renderUsage() {
      if (!usageHours) return;
      const table = document.getElementById('usage');
      table.replaceChildren();
      const columns = usageColumns();
      const head = table.insertRow();
      for (const text of ['Model', ...columns.map((column) => column.label)]) {
        const th = document.createElement('th');
        th.textContent = text;
        head.appendChild(th);
      }
      const sum = (model, has) => Object.entries(usageHours[model]).reduce((total, [h, count]) => total + (has(Number(h)) ? count : 0), 0);
      const total = (model) => sum(model, () => true);
      for (const model of Object.keys(usageHours).sort((a, b) => total(b) - total(a))) {
        const tr = table.insertRow();
        tr.insertCell().textContent = model;
        for (const column of columns) tr.insertCell().textContent = sum(model, column.has).toLocaleString();
      }
    }

    function pref(model) {
      return (prefs[model] = prefs[model] || { on: true, alias: '', effort: '' });
    }

    // One row per model the CLI offers, led by the value sent with --model. Across each row:
    // the CLI's name for it, whether it shows up in the footer's picker at all, whether it is a
    // preset, the display name to use instead of the id, and the effort its preset runs at. A
    // hidden model cannot be a preset.
    function renderModels() {
      const table = document.getElementById('models');
      table.replaceChildren();
      const columns = [];
      const column = (label, cell) => columns.push({ label, cell });
      column('Model', (model) => model);
      // The CLI's name for what the value runs on now: its description up to " · ".
      column('Descr', (model) => names[model] || '');
      column('Show', (model) => {
        const check = checkbox(pref(model).on !== false);
        check.addEventListener('change', () => { pref(model).on = check.checked; renderModels(); unsaved(); });
        return check;
      });
      column('Preset', (model) => {
        const check = checkbox(presetModels.has(model) && pref(model).on !== false);
        check.disabled = pref(model).on === false;
        check.addEventListener('change', () => {
          if (check.checked) presetModels.add(model); else presetModels.delete(model);
          renderDefault();
          unsaved();
        });
        return check;
      });
      column('Alias', (model) => {
        const alias = document.createElement('input');
        alias.type = 'text';
        alias.value = pref(model).alias || '';
        alias.placeholder = model;
        alias.addEventListener('input', () => { pref(model).alias = alias.value; renderDefault(); unsaved(); });
        return alias;
      });
      column('Effort', (model, efforts) => {
        const effort = document.createElement('select');
        effort.disabled = efforts.length === 0;
        pref(model).effort = efforts.includes(pref(model).effort) ? pref(model).effort : efforts[0] || '';
        for (const value of efforts) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          option.selected = value === pref(model).effort;
          effort.appendChild(option);
        }
        effort.addEventListener('change', () => { pref(model).effort = effort.value; renderDefault(); unsaved(); });
        return effort;
      });
      const head = table.insertRow();
      for (const { label } of columns) {
        const th = document.createElement('th');
        th.textContent = label;
        head.appendChild(th);
      }
      for (const [model, efforts] of Object.entries(models).sort(([a], [b]) => a.localeCompare(b))) {
        const tr = table.insertRow();
        for (const { cell } of columns) {
          const content = cell(model, efforts);
          const td = tr.insertCell();
          if (typeof content === 'string') td.textContent = content; else td.appendChild(content);
        }
      }
      renderDefault();
    }

    function checkbox(checked) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = checked;
      return check;
    }

    // The presets as saved: every shown model with its Preset box checked, at its own effort.
    function presetList() {
      return Object.keys(models)
        .filter((model) => presetModels.has(model) && pref(model).on !== false)
        .map((model) => ({ enabled: true, model, effort: pref(model).effort || '' }));
    }

    function label(model) {
      return (prefs[model] || {}).alias || model;
    }

    // Only presets can be the new-session default. One that got switched off hands the job to
    // the first preset left.
    function renderDefault() {
      const select = document.getElementById('default');
      select.replaceChildren();
      const presets = presetList();
      if (!presets.some((preset) => preset.model === defaultModel)) defaultModel = presets.length ? presets[0].model : '';
      for (const preset of presets) {
        const option = document.createElement('option');
        option.value = preset.model;
        option.textContent = [label(preset.model), preset.effort].filter(Boolean).join(' / ');
        option.selected = preset.model === defaultModel;
        select.appendChild(option);
      }
    }

    // The one Save writes the per-model choices and the presets picked from them.
    async function save() {
      const presets = presetList();
      const defaultPreset = presets.findIndex((preset) => preset.model === defaultModel);
      const reply = await request('savePresets', { presets, prefs, defaultPreset });
      note(reply.ok ? 'Saved' : 'Save failed: ' + (reply.error || 'unknown error'));
    }

    function unsaved() {
      note('Not saved');
    }

    function note(text) {
      document.getElementById('note').textContent = text;
    }
  </script>
</body>
</html>`;
}

// The Settings pane: every Claude2 setting, one copy on the stats server shared by every host
// type. Other windows pick a save up when they reload.
function settingsHtml(webview: vscode.Webview, zoom: number, alert: boolean): string {
  const nonce = getNonce();
  const z = zoomFactor(zoom);
  const modes = permissionModes.map((mode) => `<option>${mode}</option>`).join("");
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --wash: rgba(0,0,0,0.08); --z: 1; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page); color: var(--ink); font: calc(16px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; gap: 16px; padding: 4px 24px 20px; }
    .title { display: flex; align-items: center; gap: 12px; }
    .actions { margin-left: auto; display: flex; gap: 12px; align-items: center; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 8px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .box { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 12px 16px; }
    #fields td { padding: 4px 16px 4px 0; }
    input, select { font: inherit; color: var(--ink); padding: 2px 6px; }
    input[type=number] { width: 8em; }
    input[type=text] { width: 14em; }
    .save-row { display: flex; gap: 12px; align-items: center; margin-top: 10px; }
${tabsStyle()}  </style>
</head>
<body>
  <div class="pane">
    <div class="title">${tabsHtml("settings", alert)}<div class="actions"><button id="close">Close</button></div></div>
    <div class="box">
      <table id="fields">
        <tr><td>Turn limit per prompt</td><td><input id="maxTurns" type="number" min="50" max="250" step="1"></td></tr>
        <tr><td>Max context tokens</td><td><input id="contextWindowTokens" type="number" min="100000" max="1000000" step="1000"></td></tr>
        <tr><td>Max budget per prompt in USD (0 = no limit)</td><td><input id="maxBudgetUsd" type="number" min="0" step="0.01"></td></tr>
        <tr><td>Permission mode</td><td><select id="permissionMode">${modes}</select></td></tr>
        <tr><td>Quota pane timezone (IANA)</td><td><input id="timezone" type="text"></td></tr>
        <tr><td>Long tool display</td><td><input id="longToolDisplay" type="checkbox"></td></tr>
        <tr><td>Fast mode ($)</td><td><input id="fastMode" type="checkbox"></td></tr>
        <tr><td>Prompt suggestions</td><td><input id="promptSuggestions" type="checkbox"></td></tr>
      </table>
      <div class="save-row"><button id="save">Save</button><span id="note"></span></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${tabsScript()}
${zoomScript(z)}
    const pending = new Map();
    const numbers = ['maxTurns', 'contextWindowTokens', 'maxBudgetUsd'];
    const fields = numbers.concat(['permissionMode', 'timezone']);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        pending.get(message.requestId)(message);
        pending.delete(message.requestId);
      }
    });
    document.getElementById('close').addEventListener('click', () => vscode.postMessage({ type: 'closeManagement' }));
    document.getElementById('save').addEventListener('click', () => void save());
    for (const id of fields.concat(['longToolDisplay', 'fastMode', 'promptSuggestions'])) document.getElementById(id).addEventListener('input', () => note('Not saved'));
    void load();

    function request(type, payload) {
      const requestId = String(Date.now()) + Math.random();
      return new Promise((resolve) => { pending.set(requestId, resolve); vscode.postMessage(Object.assign({ type, requestId }, payload)); });
    }

    async function load() {
      const reply = await request('loadSettings', {});
      if (!reply.ok) {
        note('Could not load the settings: ' + (reply.error || 'unknown error'));
        return;
      }
      for (const id of fields) document.getElementById(id).value = String(reply.payload[id]);
      document.getElementById('longToolDisplay').checked = reply.payload.longToolDisplay === true;
      document.getElementById('fastMode').checked = reply.payload.fastMode === true;
      document.getElementById('promptSuggestions').checked = reply.payload.promptSuggestions === true;
      note('');
    }

    async function save() {
      const settings = {};
      for (const id of fields) {
        const value = document.getElementById(id).value;
        settings[id] = numbers.includes(id) ? Number(value) : value;
      }
      settings.longToolDisplay = document.getElementById('longToolDisplay').checked;
      settings.fastMode = document.getElementById('fastMode').checked;
      settings.promptSuggestions = document.getElementById('promptSuggestions').checked;
      const reply = await request('saveSettings', { settings });
      note(reply.ok ? 'Saved. Other windows use it after they reload.' : 'Save failed: ' + (reply.error || 'unknown error'));
    }

    function note(text) {
      document.getElementById('note').textContent = text;
    }
  </script>
</body>
</html>`;
}

// The Image pane shows whichever attached picture was last asked for -- by adding it, or by
// clicking its 🖼️ char. The image arrives as a data URI in the loadCapture reply: the file lives
// outside any localResourceRoots, so a file URI could not load, and this also keeps working when
// the picture was taken on another machine. A picture already sent with a prompt is shown but
// never edited, so the pane's crop is live only while `editable` is true.
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
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 8px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .hint { flex: none; font-size: calc(14px * var(--z)); }
    /* position: relative so the crop rectangle can be laid over the picture; the image stays a
       direct grid item, which is what lets its max-height resolve against the frame. */
    .frame { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); display: grid; place-items: center; overflow: auto; padding: 8px; cursor: crosshair; user-select: none; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; touch-action: none; }
    /* A sent prompt's picture: shown, not worked on, so it drops the crop cursor too. */
    .frame.readonly { cursor: default; }
    .sel { position: absolute; border: 2px solid #1a6fd4; background: rgba(26,111,212,0.16); pointer-events: none; }
${tooltipStyle()}  </style>
</head>
<body>
  <div class="pane">
    <div class="title"><h1 id="label">Image</h1><span id="path" class="path"></span><span id="hint" class="hint"></span><div class="actions"><button id="reload">Reload</button><button id="close">Close</button></div></div>
    <div class="frame" id="frame"><img id="shot" hidden><div id="sel" class="sel" hidden></div><div id="empty" hidden></div></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
${tooltipScript()}
    const img = document.getElementById('shot');
    const frame = document.getElementById('frame');
    const sel = document.getElementById('sel');
    const empty = document.getElementById('empty');
    const pathLabel = document.getElementById('path');
    const hint = document.getElementById('hint');
    const label = document.getElementById('label');
    const pending = new Map();
    // How many crops deep the shown picture is; a plain click can only undo when that is above 0.
    let depth = 0;
    // False for a picture already sent with a prompt: it is shown and nothing more.
    let editable = false;
    let drag = null;

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
      show(await request('loadCapture', {}));
    }

    function show(reply) {
      const payload = reply.ok ? reply.payload : null;
      depth = payload && typeof payload.depth === 'number' ? payload.depth : 0;
      editable = !!(payload && payload.editable);
      frame.classList.toggle('readonly', !editable);
      if (payload && payload.dataUri) {
        img.src = payload.dataUri;
        img.hidden = false;
        empty.hidden = true;
        label.textContent = payload.label || 'Image';
        pathLabel.textContent = payload.path || '';
        hint.textContent = !editable ? 'already sent — shown only' : depth > 0 ? 'drag to crop · click to undo a crop' : 'drag to crop';
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        empty.hidden = false;
        empty.textContent = reply.ok ? 'No image to show — click Cap in a conversation, or paste one into its prompt box.' : 'Could not load the image: ' + (reply.error || 'unknown error');
        label.textContent = 'Image';
        pathLabel.textContent = '';
        hint.textContent = '';
      }
      sel.hidden = true;
    }

    // Where the picture actually sits inside the img box, and how many of its own pixels one
    // screen pixel covers: object-fit letterboxes it, so the box alone does not say.
    function geometry() {
      const box = img.getBoundingClientRect();
      const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
      const width = img.naturalWidth * scale;
      const height = img.naturalHeight * scale;
      return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height, scale };
    }

    function clamp(value, low, high) {
      return Math.min(high, Math.max(low, value));
    }

    // The rectangle from the drag's start to the pointer, in the picture's own pixels,
    // however it was dragged.
    function dragRect(from, to) {
      const g = geometry();
      const x1 = (clamp(from.x, g.left, g.left + g.width) - g.left) / g.scale;
      const y1 = (clamp(from.y, g.top, g.top + g.height) - g.top) / g.scale;
      const x2 = (clamp(to.clientX, g.left, g.left + g.width) - g.left) / g.scale;
      const y2 = (clamp(to.clientY, g.top, g.top + g.height) - g.top) / g.scale;
      return { g, x: Math.round(Math.min(x1, x2)), y: Math.round(Math.min(y1, y2)), w: Math.round(Math.abs(x2 - x1)), h: Math.round(Math.abs(y2 - y1)) };
    }

    // Pointer events with capture, not mouse events: this pane is an iframe, and a drag that
    // leaves it stops delivering mousemove/mouseup here -- the rectangle freezes at the edge it
    // was clamped to and the release is never seen. Capture keeps every move and the release
    // coming to the frame no matter where the pointer ends up. The frame, not the image, so a
    // drag can also start off the picture; dragRect clamps both ends onto it.
    frame.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !editable || !img.getAttribute('src')) return;
      event.preventDefault();
      frame.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, moved: false };
      sel.hidden = true;
    });
    frame.addEventListener('pointermove', (event) => {
      if (!drag) return;
      // The button is already up: a release went somewhere that swallowed it, so end the drag
      // on this move rather than leaving it stuck armed.
      if ((event.buttons & 1) === 0) {
        void finish(event);
        return;
      }
      if (!drag.moved && Math.abs(event.clientX - drag.x) < 4 && Math.abs(event.clientY - drag.y) < 4) return;
      drag.moved = true;
      const rect = dragRect(drag, event);
      // The rectangle is placed against the frame's padding box, which is what it scrolls within.
      const frameBox = frame.getBoundingClientRect();
      sel.style.left = (rect.g.left - frameBox.left + frame.scrollLeft + rect.x * rect.g.scale) + 'px';
      sel.style.top = (rect.g.top - frameBox.top + frame.scrollTop + rect.y * rect.g.scale) + 'px';
      sel.style.width = (rect.w * rect.g.scale) + 'px';
      sel.style.height = (rect.h * rect.g.scale) + 'px';
      sel.hidden = false;
    });
    frame.addEventListener('pointerup', (event) => void finish(event));
    frame.addEventListener('pointercancel', () => {
      drag = null;
      sel.hidden = true;
    });

    async function finish(event) {
      if (!drag) return;
      const started = drag;
      drag = null;
      sel.hidden = true;
      if (!img.getAttribute('src')) return;
      // A click that never moved undoes the last crop instead of making one.
      if (!started.moved) {
        if (depth > 0) show(await request('undoCrop', {}));
        return;
      }
      const rect = dragRect(started, event);
      if (rect.w < 2 || rect.h < 2) return;
      // Cutting the rectangle out here rather than in the extension keeps the picture in one
      // place: the extension only ever writes the PNG this hands it.
      const canvas = document.createElement('canvas');
      canvas.width = rect.w;
      canvas.height = rect.h;
      canvas.getContext('2d').drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      show(await request('cropCapture', { dataUri: canvas.toDataURL('image/png') }));
    }
  </script>
</body>
</html>`;
}

// The Plugins pane: one table over every project the stats server knows — a column per
// project plus an All column, stat rows above two checkbox rows that switch graft and
// ponytail per project. Data arrives from the extension in the loadPluginsReport reply.
function pluginsHtml(webview: vscode.Webview, zoom: number, alert: boolean): string {
  const nonce = getNonce();
  const z = zoomFactor(zoom);
  return `<!doctype html>
<html lang="en" style="--z: ${z}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <style>
    :root { color-scheme: light; --ink: #000; --muted: #000; --surface: #fcfcfb; --page: #f9f9f7; --border: #d8d8d2; --wash: rgba(0,0,0,0.08); --z: 1; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; overflow: hidden; background: var(--page); color: var(--ink); font: calc(16px * var(--z))/1.45 Aptos, "Segoe UI", sans-serif; }
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 4px 24px 20px; }
    .title { display: flex; align-items: baseline; gap: 12px; flex: none; margin-bottom: 8px; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; margin: 0; }
    #note { font-size: calc(14px * var(--z)); }
    .actions { margin-left: auto; display: flex; gap: 12px; flex: none; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 8px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .scroll { flex: 1; min-height: 0; overflow: auto; padding-right: 4px; }
    table { border-collapse: collapse; background: var(--surface); font-size: calc(14px * var(--z)); }
    th, td { border: 1px solid var(--border); padding: 5px 12px; text-align: right; white-space: nowrap; color: var(--ink); }
    th { text-align: center; font-weight: 600; }
    td:first-child { text-align: left; font-weight: 600; }
    td:last-child, th:last-child { font-weight: 600; }
    td.mid { text-align: center; }
    input[type=checkbox] { width: calc(15px * var(--z)); height: calc(15px * var(--z)); margin: 0; }
${tabsStyle()}  </style>
</head>
<body>
  <div class="pane">
    <div class="title">${tabsHtml("plugins", alert)}<span id="note"></span><div class="actions"><button id="reload">Reload</button><button id="close">Close</button></div></div>
    <div class="scroll"><table id="table"></table></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${tabsScript()}
${zoomScript(z)}
    const pending = new Map();
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'reply' && pending.has(message.requestId)) {
        pending.get(message.requestId)(message);
        pending.delete(message.requestId);
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
      const reply = await request('loadPluginsReport', {});
      render(reply.ok && reply.payload ? reply.payload : { projects: [], offline: true });
    }

    function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)); }
    function fmtUsd(n) { return '$' + n.toFixed(2); }
    // ponytail: 20-turn floor before a $/turn shows; below that a couple of cheap turns would read as a finding
    function perTurn(cost, turns) { return turns >= 20 ? '$' + (cost / turns).toFixed(2) : '—'; }
    function fmtWall(ms) {
      const minutes = Math.round(ms / 60000);
      return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
    }

    function render(report) {
      const projects = Array.isArray(report.projects) ? report.projects : [];
      document.getElementById('note').textContent = report.offline ? 'stats server unreachable — showing this workspace only' : '';
      const table = document.getElementById('table');
      table.textContent = '';
      if (!projects.length) {
        document.getElementById('note').textContent = 'No stats yet — they collect as prompts run.';
        return;
      }
      const sum = (field) => projects.reduce((total, project) => total + (project[field] || 0), 0);
      const header = document.createElement('tr');
      header.appendChild(cell('th', ''));
      for (const project of projects) {
        // display alias only — the project keeps its real name everywhere else
        const th = cell('th', project.project === 'graft-ponytail-exp' ? 'plugin-exp' : project.project);
        th.title = project.paths || '';
        header.appendChild(th);
      }
      header.appendChild(cell('th', 'All'));
      table.appendChild(header);
      const rows = [
        ['Host', (project) => project.hosts, ''],
        ['Source files', (project) => fmtTok(project.srcFiles), fmtTok(sum('srcFiles'))],
        ['Source lines', (project) => fmtTok(project.srcLines), fmtTok(sum('srcLines'))],
        ['Sessions', (project) => project.sessions, sum('sessions')],
        ['Turns', (project) => project.turns, sum('turns')],
        ['Wall time', (project) => fmtWall(project.wallMs), fmtWall(sum('wallMs'))],
        ['Total $', (project) => fmtUsd(project.costUsd), fmtUsd(sum('costUsd'))],
        ['Tokens in', (project) => fmtTok(project.tokensIn), fmtTok(sum('tokensIn'))],
        ['Tokens out', (project) => fmtTok(project.tokensOut), fmtTok(sum('tokensOut'))],
        ['Graft $ savings', (project) => fmtUsd(project.graftUsdSaved), fmtUsd(sum('graftUsdSaved'))],
        ['Graft tokens saved', (project) => fmtTok(project.graftTokensSaved), fmtTok(sum('graftTokensSaved'))],
        ['Graft tool calls', (project) => project.graftCalls, sum('graftCalls')],
        ['Graft $/turn on', (project) => perTurn(project.costGraftOn, project.turnsGraftOn), perTurn(sum('costGraftOn'), sum('turnsGraftOn'))],
        ['Graft $/turn off', (project) => perTurn(project.costGraftOff, project.turnsGraftOff), perTurn(sum('costGraftOff'), sum('turnsGraftOff'))],
        ['Ponytail skips', (project) => project.ponySkips, sum('ponySkips')],
        ['Ponytail ceilings', (project) => project.ponyCeilings, sum('ponyCeilings')],
        ['Ponytail $/turn on', (project) => perTurn(project.costPonyOn, project.turnsPonyOn), perTurn(sum('costPonyOn'), sum('turnsPonyOn'))],
        ['Ponytail $/turn off', (project) => perTurn(project.costPonyOff, project.turnsPonyOff), perTurn(sum('costPonyOff'), sum('turnsPonyOff'))],
      ];
      for (const [label, valueOf, total] of rows) {
        const row = document.createElement('tr');
        row.appendChild(cell('td', label));
        for (const project of projects) {
          row.appendChild(cell('td', String(valueOf(project))));
        }
        row.appendChild(cell('td', String(total)));
        table.appendChild(row);
      }
      for (const plugin of ['graft', 'ponytail']) {
        const row = document.createElement('tr');
        row.appendChild(cell('td', 'Enable ' + plugin));
        // The All box reads checked while every project is on, and sets every project when clicked.
        const all = document.createElement('input');
        all.type = 'checkbox';
        all.disabled = report.offline === true;
        const boxes = [];
        const syncAll = () => { all.checked = boxes.every(({ box }) => box.checked); };
        for (const project of projects) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = project[plugin] !== false;
          // a flag the server cannot hear about would silently not stick
          box.disabled = report.offline === true;
          box.addEventListener('change', () => void toggle(box, project.project, plugin).then(syncAll));
          boxes.push({ box, name: project.project });
          const holder = cell('td', '');
          holder.className = 'mid';
          holder.appendChild(box);
          row.appendChild(holder);
        }
        syncAll();
        all.addEventListener('change', async () => {
          all.disabled = true;
          const wanted = all.checked;
          await Promise.all(boxes.filter(({ box }) => box.checked !== wanted).map(({ box, name }) => {
            box.checked = wanted;
            return toggle(box, name, plugin);
          }));
          syncAll();
          all.disabled = false;
        });
        const allHolder = cell('td', '');
        allHolder.className = 'mid';
        allHolder.appendChild(all);
        row.appendChild(allHolder);
        table.appendChild(row);
      }
    }

    async function toggle(box, project, plugin) {
      box.disabled = true;
      const reply = await request('setPluginFlag', { project, plugin, enabled: box.checked });
      if (!reply.ok || reply.payload !== true) {
        box.checked = !box.checked;
      }
      box.disabled = false;
    }

    function cell(tag, text) {
      const el = document.createElement(tag);
      el.textContent = text;
      return el;
    }
  </script>
</body>
</html>`;
}

function instructionsHtml(webview: vscode.Webview, zoom: number, alert: boolean): string {
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
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 4px 32px 28px; max-width: 900px; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; margin-bottom: 16px; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; letter-spacing: 0; margin: 0; }
    .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    .hint { color: var(--muted); font-size: calc(14.4px * var(--z)); }
    label { display: flex; flex-direction: column; gap: 5px; flex: 1; min-height: 140px; }
    .path { color: var(--muted); font-size: calc(14.4px * var(--z)); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
    textarea { flex: 1; resize: none; width: 100%; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 9px 11px; font: calc(14px * var(--z))/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
    textarea:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 8px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .error { background: var(--error); border: 1px solid var(--border); border-left: 3px solid #c62828; border-radius: 8px; margin: 16px 0 0; padding: 10px 14px; }
${tooltipStyle()}${tabsStyle()}  </style>
</head>
<body>
  <div class="pane">
    <div class="title">${tabsHtml("instructions", alert)}<div class="actions"><span id="hint" class="hint"></span><button id="bottom" title="Scroll to bottom" aria-label="Scroll to bottom">⇊</button><button id="close">Close</button></div></div>
    <label><span id="path" class="path">CLAUDE.md</span><textarea id="text" spellcheck="true" disabled></textarea></label>
    <p id="error" class="error" hidden></p>
  </div>
  <script nonce="${nonce}">
    // The pane saves as you type, like a VS Code editor with auto save: every edit is written to
    // CLAUDE.md after a short pause, Ctrl-S writes at once, and leaving the pane flushes first.
    // Each write also copies CLAUDE.md to .github/copilot-instructions.md.
    const vscode = acquireVsCodeApi();
${tabsScript()}
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
    let mirrorPaths = [];
    let loading = true;
    let saving = false;
    let error = null;
    let savedAt = null;
    let overwrote = false;
    let mirrorError = null;
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
        mirrorPaths = reply.payload.mirrors || [];
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
      mirrorError = null;
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
        mirrorError = reply.payload.mirrorError || null;
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
      // CLAUDE.md is the file being edited; the mirrors are copies of it, and the label names them
      // all so it is plain that one save writes every one.
      pathLabel.textContent = [filePath].concat(mirrorPaths).join(' + ');
      if (loading) hint.textContent = ''; else if (saving) hint.textContent = 'Saving...'; else if (dirty()) hint.textContent = 'Unsaved changes'; else if (mirrorError) hint.textContent = 'Saved to ' + filePath + ', but the copy failed: ' + mirrorError; else if (overwrote) hint.textContent = 'Saved over a change made on disk'; else if (savedAt) hint.textContent = 'Saved'; else hint.textContent = '';
      errorNode.hidden = !error;
      errorNode.textContent = error || '';
    }
  </script>
</body>
</html>`;
}

function quotaHtml(webview: vscode.Webview, timezone: string, zoom: number, alert: boolean): string {
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
    .pane { height: 100vh; display: flex; flex-direction: column; gap: 16px; padding: 4px 32px 28px; }
    .pane.expanded { max-width: none; }
    .title { display: flex; align-items: center; gap: 12px; flex: none; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; margin: 0; letter-spacing: 0; }
    .actions { margin-left: auto; display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: calc(14px * var(--z)); }
    .credits { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: calc(14px * var(--z)); font-variant-numeric: tabular-nums; }
    .credits button { min-height: 26px; padding: 2px 5px; }
    .credits .bar { display: block; width: min(170px, 20%); height: calc(12px * var(--z)); border: 1px solid var(--border); border-radius: 6px; background: #fff; overflow: hidden; }
    .credits .fill { display: block; height: 100%; background: var(--blue); }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 8px; min-height: 34px; font: inherit; cursor: pointer; }
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    button:disabled { background: var(--wash); cursor: default; }
    .graphs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; min-height: 0; overflow: auto; }
    .graphs.single { display: flex; flex: 1; min-height: 0; justify-content: center; align-items: flex-start; }
    .graph { width: 80%; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); padding: 11px; min-width: 0; }
    .graphs.single .graph { flex: none; display: flex; flex-direction: column; min-height: 0; max-width: 100%; }
    .graph-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .graph-name { font-weight: 700; }
    .legend { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: calc(14px * var(--z)); }
    .swatch { width: 12px; height: 2px; display: inline-block; background: var(--ink); vertical-align: middle; }
    .swatch.blue { background: var(--blue); } .swatch.red { background: var(--red); }
    .period { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
    .period button { min-height: 26px; padding: 2px 5px; }
    .plot { position: relative; width: 100%; aspect-ratio: 256 / 140; border: 1px solid var(--border); cursor: pointer; background: #fff; }
    .graphs.single .plot { flex: none; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    svg text { font-size: calc(14px * var(--z)); fill: var(--muted); text-anchor: end; }
    .figures { margin-top: 8px; color: var(--muted); font-size: calc(14px * var(--z)); font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
    .empty, .error { border: 1px dashed var(--border); border-radius: 8px; padding: 18px; color: var(--muted); }
    .error { background: #fdecec; color: #731b1b; border-style: solid; }
    @media (max-width: 900px) { .graphs { grid-template-columns: 1fr; } .title, .actions { align-items: flex-start; flex-wrap: wrap; } }
${tooltipStyle()}${tabsStyle()}  </style>
</head>
<body>
  <div id="pane" class="pane">
    <div class="title">${tabsHtml("quota", alert)}<div id="credits" class="credits"></div><div class="actions"><span id="readTime"></span><span id="age"></span><button id="update">Update</button><button id="close">Close</button></div></div>
    <div id="error" class="error" hidden></div>
    <div id="graphs" class="graphs"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${tabsScript()}
${zoomScript(z)}
    const timeZone = ${safeTimezone};
    const pending = new Map();
    const backs = { five: 0, seven: 0 };
    // Months back from the current one that the credits bar shows.
    let creditMonth = 0;
    let payload = { readAt: null, rows: [], state: { error: null } };
    let expanded = null;
    let loading = true;
    let updating = false;
    let resizeObserver = null;
    // Plots are drawn at their real pixel size so the axis text stays at the pane's CSS size
    // instead of scaling up with the viewBox.
    const plotObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      for (const entry of entries) {
        const plot = entry.target;
        if (plot.clientWidth > 0 && plot.clientHeight > 0) plot.innerHTML = plot.draw(plot.clientWidth, plot.clientHeight);
      }
    });

    document.getElementById('update').addEventListener('click', () => void load(true));
    document.getElementById('credits').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      creditMonth += button.dataset.month === 'older' ? 1 : -1;
      renderCredits();
    });
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
      renderCredits();
      const graphsNode = document.getElementById('graphs');
      const pane = document.getElementById('pane');
      const five = buildWindowGraph('five', '5h', 5 * 60 * 60 * 1000, [{ field: 'five_pct', reset: 'five_resets', name: '5h', color: '#000' }], rows);
      const seven = buildWindowGraph('seven', '7d', 7 * 24 * 60 * 60 * 1000, [{ field: 'seven_pct', reset: 'seven_resets', name: '7d', color: '#2457d6' }, { field: 'fable_pct', reset: 'fable_resets', name: modelLabel(), color: '#c62828' }], rows);
      const graphs = [five, seven];
      const visibleGraphs = expanded ? graphs.filter((graph) => graph.key === expanded) : graphs;
      pane.className = 'pane' + (expanded ? ' expanded' : '');
      graphsNode.className = 'graphs' + (expanded ? ' single' : '');
      if (plotObserver) plotObserver.disconnect();
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

    // The current month takes the live reading first; otherwise, and for past months, the newest
    // row in that month with a credits block. Months are UTC: credits reset at 00:00 UTC on the 1st.
    function renderCredits() {
      const node = document.getElementById('credits');
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const now = new Date();
      const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - creditMonth, 1);
      const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - creditMonth + 1, 1);
      const label = new Date(start).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      const nav = '<button data-month="older"' + (rows.length === 0 || rows[0].at >= start ? ' disabled' : '') + '>‹</button><span>' + label + '</span><button data-month="newer"' + (creditMonth === 0 ? ' disabled' : '') + '>›</button>';
      const live = creditMonth === 0 && payload.state && payload.state.credits;
      let spent = live ? numeric(live.spentUsd) : null;
      let limit = live ? numeric(live.limitUsd) : null;
      if (spent === null || limit === null) {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index].at >= start && rows[index].at < end && numeric(rows[index].spent_usd) !== null && numeric(rows[index].limit_usd) !== null) {
            spent = numeric(rows[index].spent_usd);
            limit = numeric(rows[index].limit_usd);
            break;
          }
        }
      }
      if (spent === null || limit === null || limit <= 0) {
        node.innerHTML = nav;
        return;
      }
      const pct = Math.max(0, Math.min(100, (spent / limit) * 100));
      const fill = pct <= 50 ? '#8f8' : (pct <= 75 ? '#ff8' : '#f88');
      node.innerHTML = nav + '<span>' + escapeHtml(money(spent)) + '</span><span class="bar"><span class="fill" style="width:' + pct.toFixed(1) + '%;background:' + fill + '"></span></span><span>' + escapeHtml(money(limit)) + '</span>';
    }

    function money(value) { return '$' + Number(value).toFixed(2); }

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
      plot.draw = (width, height) => drawSvg(period, width, height);
      plot.innerHTML = plot.draw(256, 140);
      if (plotObserver) plotObserver.observe(plot);
      const figures = document.createElement('div');
      figures.className = 'figures';
      figures.innerHTML = figuresHtml(period);
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
          render();
        });
      });
    }

    function measureExpandedPlot() {
      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = null;
      if (!expanded) return;
      fitExpanded();
      const container = document.getElementById('graphs');
      if (!container || typeof ResizeObserver === 'undefined') return;
      resizeObserver = new ResizeObserver(() => fitExpanded());
      resizeObserver.observe(container);
    }

    // The expanded card keeps the small graphs' 256x140 plot shape, so its width is whatever
    // the leftover height allows (capped by the pane width); the flex row then centres it.
    function fitExpanded() {
      const container = document.getElementById('graphs');
      const card = container && container.querySelector('.graph');
      const plot = card && card.querySelector('.plot');
      if (!card || !plot) return;
      const styles = getComputedStyle(card);
      const frameX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight) + parseFloat(styles.borderLeftWidth) + parseFloat(styles.borderRightWidth);
      const chromeY = card.getBoundingClientRect().height - plot.getBoundingClientRect().height;
      const roomWidth = container.clientWidth - frameX;
      const roomHeight = container.clientHeight - chromeY;
      const width = Math.max(256, Math.floor(Math.min(roomWidth, roomHeight * (256 / 140))));
      card.style.width = (width + frameX) + 'px';
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
      return { key, title, periods: periods.filter((period) => period.series.some((series) => series.points.length > 0)).sort((left, right) => left.end - right.end) };
    }

    function drawSvg(period, width, height) {
      const yMax = 100;
      const yMin = 0;
      const fractions = [0, 0.5, 1];
      const labels = fractions.map((fraction) => axisLabel(yMin + (yMax - yMin) * fraction));
      // Axis text renders in user units at the CSS size, so the gutter has to grow with zoom
      // and with the widest label or the labels run off the left edge of the viewBox.
      const fontSize = 14 * zoom;
      const labelWidth = Math.max(...labels.map((label) => label.length)) * 0.62 * fontSize;
      const margin = { left: Math.ceil(labelWidth) + 8, right: 6, top: Math.ceil(fontSize * 0.6), bottom: Math.ceil(fontSize * 0.6) + 12 };
      const plotWidth = Math.max(1, width - margin.left - margin.right);
      const plotHeight = Math.max(1, height - margin.top - margin.bottom);
      const x = (time) => margin.left + ((time - period.start) / (period.end - period.start)) * plotWidth;
      const y = (value) => margin.top + (1 - (Math.min(yMax, Math.max(yMin, value)) - yMin) / (yMax - yMin)) * plotHeight;
      let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img">';
      fractions.forEach((fraction, index) => {
        const yValue = y(yMin + (yMax - yMin) * fraction);
        svg += '<line x1="' + margin.left + '" x2="' + (width - margin.right) + '" y1="' + yValue + '" y2="' + yValue + '" stroke="rgba(0,0,0,0.15)" />';
        svg += '<text x="' + (margin.left - 5) + '" y="' + (yValue + fontSize * 0.35) + '">' + escapeHtml(labels[index]) + '</text>';
      });
      for (const time of gridTimes(period)) {
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

    function figuresHtml(period) {
      const parts = [];
      for (const series of period.series) {
        const points = carriedPoints(series.points, period);
        if (points.length) {
          parts.push('<span style="color:' + series.color + '">' + escapeHtml(series.name + ' ' + axisLabel(points[points.length - 1].v)) + '</span>');
        }
      }
      const elapsed = Math.max(0, Math.min(1, (Date.now() - period.start) / (period.end - period.start)));
      parts.push('<span>' + Math.round(elapsed * 100) + '%</span>');
      parts.push('<span>' + escapeHtml(timeLeft(period.end - Date.now())) + '</span>');
      return parts.join('');
    }

    function gridTimes(period) {
      const times = [];
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

    function axisLabel(value) { return Math.round(value) + '%'; }
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

    // Capture phase, so it lands ahead of anything that consumes the wheel itself (the prompt
    // box's Monaco editor); the preventDefault then tells that one to leave this wheel alone.
    window.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (event.deltaY) applyZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }, { passive: false, capture: true });

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

// Tooltips are drawn by the pane, not by the browser: a native `title` bubble renders at a fixed
// OS size that no stylesheet can reach, and these have to read at the pane's own (larger) size.
// Paired with tooltipScript(), which is what actually harvests the `title` attributes.
function tooltipStyle(): string {
  return `
    #tip { position: fixed; left: 0; top: 0; z-index: 9999; display: none; max-width: 60ch; padding: 4px 9px; border: 1px solid var(--border, #d9d8d1); border-radius: 6px; background: var(--surface, #fcfcfb); color: var(--ink, #000); font-size: calc(12.32px * var(--z, 1)); line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 2px 8px rgba(0,0,0,0.18); pointer-events: none; }
    #tip.shown { display: block; }
    #tip .tip-aside { margin-left: 20px; }
`;
}

// Any element carrying `title` gets the styled bubble instead of the native one. The attribute is
// only moved aside at hover time, so code that keeps assigning `.title` later still works: a fresh
// attribute simply overwrites the stashed copy on the next hover.
function tooltipScript(): string {
  return `
    const TIP_DELAY = 400;
    const tipNode = document.createElement('div');
    tipNode.id = 'tip';
    document.body.appendChild(tipNode);
    let tipTimer = 0;
    let tipHost = null;
    let tipPending = null;
    let tipWarmUntil = 0;
    let tipX = 0;
    let tipText = '';

    function hideTip() {
      clearTimeout(tipTimer);
      tipPending = null;
      tipHost = null;
      tipNode.classList.remove('shown');
    }

    // Anchored to the hovered element's box, not to the cursor: a cursor-anchored bubble that has to
    // flip upward for room lands back on top of the element it describes, hiding whatever is drawn
    // there.
    // A host's data-tip-aside is set off to the right of the tip's first line.
    function showTip(text, node, x) {
      tipText = text;
      const aside = node.dataset.tipAside;
      const cut = text.indexOf('\\n');
      if (aside && cut > 0) {
        const tag = document.createElement('span');
        tag.className = 'tip-aside';
        tag.textContent = aside;
        tipNode.replaceChildren(text.slice(0, cut), tag, text.slice(cut));
      } else {
        tipNode.textContent = text;
      }
      tipNode.classList.add('shown');
      tipHost = node;
      tipX = x;
      const box = tipNode.getBoundingClientRect();
      const host = node.getBoundingClientRect();
      let left = x + 4;
      let top = host.bottom + 6;
      if (left + box.width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - 6 - box.width);
      if (top + box.height > window.innerHeight - 6) top = Math.max(6, host.top - 6 - box.height);
      tipNode.style.left = left + 'px';
      tipNode.style.top = top + 'px';
    }

    document.addEventListener('mouseover', (event) => {
      const node = event.target && event.target.closest ? event.target.closest('[title], [data-tip]') : null;
      // Moving between a host's own children must not restart a long delay or drop a shown tip.
      if (node && (node === tipPending || node === tipHost)) return;
      // A tip that is up hands straight over to the next host, gap or not, the way native ones do.
      if (tipHost) tipWarmUntil = Date.now() + 500;
      if (!node) {
        hideTip();
        return;
      }
      if (node.hasAttribute('title')) {
        node.dataset.tip = node.getAttribute('title');
        node.removeAttribute('title');
      }
      const text = node.dataset.tip || '';
      hideTip();
      if (!text) return;
      const x = event.clientX;
      tipPending = node;
      const delay = Date.now() < tipWarmUntil ? 0 : Number(node.dataset.tipDelay) || TIP_DELAY;
      tipTimer = setTimeout(() => { tipPending = null; if (node.isConnected) showTip(text, node, x); }, delay);
    });

    document.addEventListener('mouseout', (event) => { if (!event.relatedTarget) hideTip(); });
    document.addEventListener('mousedown', hideTip, true);
    document.addEventListener('keydown', hideTip, true);
    // A scroll under the cursor is not a reason to drop the tip -- only the mouse leaving is. The
    // bubble is anchored to the host's box, so it has to be re-placed as that box moves.
    window.addEventListener('scroll', () => {
      if (!tipHost) return;
      if (!tipHost.isConnected) {
        hideTip();
        return;
      }
      showTip(tipText, tipHost, tipX);
    }, true);
    window.addEventListener('blur', hideTip);
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