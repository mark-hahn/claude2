import * as vscode from "vscode";
import { CLAUDE2_COMPACT_RESERVE, DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_OPTIONS, GRAFT_TALLY_MARK, MODEL_OPTIONS, TOOL_LINE_MARK } from "./types";

export type ManagementPane = "instructions" | "quota" | "plugins" | "cap";

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
    button:hover:not(:disabled) { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    /* The same grey-out the footer's dock controls use: label and border fade together, so the
       two never disagree about whether the button does anything. */
    button:disabled { color: #bfbfbf; border-color: #bfbfbf; cursor: default; }
    #new, #quota { width: 21px; }
    #instructions { width: 52px; }
    #plugins { width: 54px; }
    #cap { width: 55px; }
    #login { width: 64px; display: none; }
    #login.needed { display: block; background: #fbd9d9; border-color: #e4a7a7; }
    #login.needed:hover { background: #f5c7c7; }
    #close { width: 56px; }
    #trash { width: 56px; }
    #trash.active { background: #fbd9d9; border-color: #e4a7a7; }
    #trash.active:hover { background: #f5c7c7; }
    #sessionCounts { margin-left: 10px; align-self: center; font-size: 15.12px; color: var(--ink); }
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
    .card-actions { position: absolute; right: 6px; bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .card-trash { display: none; border: none; background: transparent; min-height: 0; padding: 2px 4px; font-size: 14px; line-height: 1; border-radius: 6px; }
    .card:hover .card-trash { display: block; }
    .card-trash:hover { background: #fbd9d9; }
    .card-restore { display: none; min-height: 0; padding: 3px 8px; font-size: 14px; border-radius: 6px; }
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
        <button id="quota" title="Quota">$</button>
        <button id="instructions" title="Instructions">Instr</button>
        <button id="plugins" title="Plugin stats and controls for every project">Stats</button>
        <button id="cap" title="Show the latest screen capture" disabled>Screen</button>
        <button id="login" title="Authorization expired: sign in to your Anthropic account again">Re-Auth</button>
      </div>
      <div class="row">
        <button id="new" title="New Claude2 session">+</button>
        <button id="close" title="Close every session tab but the current one; again to close the last one, then the management pane" disabled>Close</button>
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
    let scrolledId = '';
    let showTrash = false;
    // An inline rename owns its card until it commits, so a background refresh waits
    // rather than yanking the input out from under the typing.
    let editingId = '';
    let pendingRender = false;
    const list = document.getElementById('sessions');
    const trashButton = document.getElementById('trash');
    const sessionCounts = document.getElementById('sessionCounts');
    const searchBox = document.getElementById('searchBox');
    // Search mode is on while this is non-empty. Enter in the box starts it; the X, an
    // empty Enter, or any top button ends it. Card clicks leave it alone on purpose, so
    // the opened editors can show their highlighted lines.
    let searchText = '';

    document.getElementById('new').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'newSession' }); });
    document.getElementById('instructions').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'instructions' }); });
    document.getElementById('quota').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'quota' }); });
    document.getElementById('plugins').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'plugins' }); });
    document.getElementById('cap').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'openPane', pane: 'cap' }); });
    document.getElementById('login').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'login' }); });
    document.getElementById('close').addEventListener('click', () => { clearSearch(); vscode.postMessage({ type: 'closeOtherSessions' }); });
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
      showTrash = !showTrash;
      trashButton.classList.toggle('active', showTrash);
      trashButton.title = showTrash ? 'Show active sessions (ctrl-click to permanently delete every trashed session)' : 'Show trashed sessions (ctrl-click to trash every session)';
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
        document.getElementById('login').classList.toggle('needed', message.authNeeded === true);
        // Close has nothing to close with no Claude2 pane up, and Cap nothing to show
        // until a screenshot has been taken.
        document.getElementById('close').disabled = message.panesOpen !== true;
        document.getElementById('cap').disabled = message.hasCapture !== true;
        if (editingId) {
          pendingRender = true;
          return;
        }
        render();
      }
    });

    function render() {
      list.replaceChildren();
      // Header tally: active sessions over trashed ones, whichever list is showing.
      const trashCount = sessions.filter((session) => session.trashed === true).length;
      sessionCounts.textContent = (sessions.length - trashCount) + '/' + trashCount;
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
      visible.forEach((session, index) => {
        const trashed = searchText ? session.trashed === true : showTrash;
        // Everything the trash list shows below this card, oldest end first: the ctrl-click sweep.
        const olderIds = trashed ? visible.slice(index + 1).filter((other) => other.trashed === true).map((other) => other.id) : [];
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
        trash.title = trashed
          ? (olderIds.length > 0
            ? 'Delete this session permanently (ctrl-click to delete the ' + olderIds.length + ' older session' + (olderIds.length === 1 ? '' : 's') + ' below it instead)'
            : 'Delete this session permanently')
          : 'Move this session to the trash';
        trash.addEventListener('pointerdown', (event) => event.stopPropagation());
        trash.addEventListener('click', (event) => {
          event.stopPropagation();
          if (trashed) {
            // Ctrl-click sweeps the older half of the trash: every card below this one goes,
            // this one stays. Either way the extension asks before anything is forgotten.
            if (event.ctrlKey) {
              if (olderIds.length > 0) {
                vscode.postMessage({ type: 'deleteSessions', sessionIds: olderIds });
              }
              return;
            }
            vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
            return;
          }
          vscode.postMessage({ type: 'trashSession', sessionId: session.id });
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
          timer = window.setTimeout(() => {
            renamed = true;
            startRename(name, session);
          }, 650);
        });
        for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
          card.addEventListener(eventName, () => window.clearTimeout(timer));
        }
        card.addEventListener('click', (event) => {
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
  // Emitted as an escape, not the raw character: the mark is invisible, and a literal one in the
  // generated script would be an unreadable blank in any view of this page's source.
  const toolLineMark = `'\\u${TOOL_LINE_MARK.codePointAt(0)?.toString(16).padStart(4, "0")}'`;
  const graftTallyMark = JSON.stringify(GRAFT_TALLY_MARK);
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
    /* Three pixels narrower than the rest of the model row, taken off the side padding. */
    #model, #effort { padding-left: 6.5px; padding-right: 6.5px; }
    .history { overflow-y: auto; overflow-x: hidden; min-height: 0; padding: 10px 12px 4px; }
    .empty { color: var(--muted); height: 100%; display: grid; place-items: center; }
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
    .response.markdown a { color: #0b4f9c; }
    .response.markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: calc(14px * var(--z)); background: rgba(0,0,0,0.05); border-radius: 4px; padding: 1px 4px; }
    .response.markdown pre { background: #f2f1ec; border: 1px solid var(--border); border-radius: 8px; margin: 0 0 10px; padding: 8px 10px; overflow: auto; }
    .response.markdown pre code { background: none; padding: 0; white-space: pre; }
    .response.markdown table { border-collapse: collapse; margin: 0 0 10px; font-size: calc(14px * var(--z)); }
    .response.markdown th, .response.markdown td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
    .response.markdown th { background: rgba(0,0,0,0.05); }
    .error-note { margin-top: 10px; background: #fdecec; border: 1px solid #f0bcbc; border-radius: 6px; padding: 8px 10px; color: #731b1b; }
    .response .search-line { background: #cfe8ff; }
    .prompt-bar.search-hit { background: #cfe8ff; border-color: #9cc4e8; }
    textarea { resize: none; flex: 1 1 260px; min-width: 180px; height: auto; min-height: var(--edh); border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 10px 11px; font: calc(14px * var(--z))/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 2; }
    textarea:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: transparent; }
    .bar { display: flex; gap: 8px; align-items: center; }
    .stats { display: flex; gap: 12px; align-items: center; margin-right: 2px; }
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
    .status { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The context gauge flags a just-finished compaction: the level it shows dropped because the
       conversation was summarised, not because the run shrank. Clears itself, or on a click. */
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
    /* Hovering spells the letter out. Absolutely positioned so the pill itself never resizes. */
    #finish:hover::after { content: attr(data-status); position: absolute; right: 0; bottom: calc(100% + 6px); padding: 3px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--ink); font-size: max(11.2px, calc(14px * var(--z) * 0.68)); font-weight: 400; white-space: nowrap; z-index: 5; }
    .indicator.done { background: #fff; }
    .indicator.active { color: #7a1616; border-color: #e2a3a3; background: #fde0e0; }
    .footer { display: flex; gap: 8px; align-items: center; }
    #cap.armed { background: var(--yellow); border-color: #d6b642; font-weight: 700; }
    @media (max-width: 760px) { .stats { flex-wrap: wrap; } .status { white-space: normal; } }
${tooltipStyle()}  </style>
</head>
<body>
  <div class="shell">
    <div id="history" class="history"><div class="empty"></div></div>
    <div class="dock">
      <textarea id="prompt" spellcheck="true"></textarea>
      <div class="dock-controls">
        <div class="stats"><div class="status" id="turns"></div><span class="sep">|</span><div class="status" id="context"></div><span class="sep">|</span><div class="status" id="cost"></div><span class="sep" id="pony-sep">|</span><div class="status" id="pony" title="Ponytail skips this session : ceiling comments in the workspace"></div><span class="sep">|</span><div class="status" id="duration"></div></div>
        <div class="bar">
          <div class="group"><button id="cycle" class="indicator">M</button><select id="model"></select><select id="effort"></select></div>
        </div>
        <div class="footer">
          <div id="finish" class="indicator" data-status="Ready">R</div>
          <div class="group"><button id="stop" title="Stop" aria-label="Stop">&#x25AA;</button><button id="bottom" title="Last response">▼▼</button><button id="fork" title="Fork here: copy the session, then drop every block below the selected one">Fork</button><button id="load">Load</button><button id="cap" title="Attach a screen capture to the next Send — hides this window for the shot; Ctrl-click leaves it up">Cap</button></div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
${tooltipScript()}
    const sessionId = ${safeSessionId};
    const models = ${models};
    const efforts = ${efforts};
    const defaultModel = ${defaultModel};
    const defaultEffort = ${defaultEffort};
    const contextWindow = ${contextWindow};
    const compactAt = Math.max(1000, contextWindow - ${compactReserve});
    const TOOL_LINE_MARK = ${toolLineMark};
    const GRAFT_TALLY_MARK = ${graftTallyMark};
    let session = { id: sessionId, name: 'New session', turns: [] };
    let status = null;
    // Which plugins this workspace runs with and the numbers only the extension can read:
    // graft's savings for this session, and the workspace's ponytail ceiling count.
    let footer = { graft: false, ponytail: false, graftSavedUsd: 0, ceilings: 0, quotaAlert: false };
    // When the last status arrived, so the elapsed time it carries can be run forward locally
    // between messages instead of sitting still through a long tool call.
    let statusAt = 0;
    // Sidebar search text; while non-empty, every line holding it gets a light-blue wash.
    let searchText = '';
    let expandedPrompts = new Set();
    // The one open box's view: markdown by default, raw text with tool groups after a ctrl-click.
    // The streaming box answers to neither — it always shows raw text with tool lines, and
    // becomes a markdown box when its run ends.
    let rawBox = false;
    // Each box's scroll position by turn id: a pixel offset, or 'bottom' to pin to the end.
    // Mirrored to the extension so the memory outlives this webview; a reopened box restores
    // from here and falls back to the bottom when no position is remembered.
    let boxScrolls = {};
    let boxScrollsLoaded = false;
    // Turn ids whose markdown box has been shown since this webview loaded: the first showing
    // starts at the top, every one after that comes back where it was left.
    const markdownSeen = new Set();
    let boxScrollTimer = 0;
    let shownActiveTurn = null;
    let anchorIndex = 0;
    // At most one box is ever open: the selected block's, and only while this is true.
    let boxOpen = true;
    // Where the box contents land on the next render: 'bottom' after an open, 'top' after
    // hiding tool groups, null to keep the current position.
    let boxScrollNext = null;
    let initializedSelection = false;
    let pendingTurnCount = 0;
    let programmaticScroll = false;
    let resizeTimer = 0;
    let draftSent = '';
    const historyBox = document.getElementById('history');
    const promptBox = document.getElementById('prompt');
    const modelSelect = document.getElementById('model');
    const effortSelect = document.getElementById('effort');
    const stopButton = document.getElementById('stop');
    const forkButton = document.getElementById('fork');
    const bottomButton = document.getElementById('bottom');
    const loadButton = document.getElementById('load');
    const capButton = document.getElementById('cap');
    const finish = document.getElementById('finish');
    const cycleButton = document.getElementById('cycle');

    // The two pairings worth a one-click switch. The pickers themselves stay free: this only steps
    // between these, and lands back on the first from anything else.
    const PICK_PRESETS = [
      { model: 'claude-opus-5', effort: 'high' },
      { model: 'claude-fable-5', effort: 'xhigh' },
    ];

    fillSelect(modelSelect, models, defaultModel);
    fillSelect(effortSelect, efforts, defaultEffort);
    // The pickers belong to the session, not the panel: every change is written back so
    // reopening this session later comes up on the same model and effort.
    modelSelect.addEventListener('change', sendPicks);
    effortSelect.addEventListener('change', sendPicks);
    cycleButton.addEventListener('click', cyclePicks);
    describePicks();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'sessionState') {
        session = message.session || session;
        status = message.status || null;
        footer = message.footer || footer;
        statusAt = Date.now();
        if (typeof message.draft === 'string' && message.draft && !promptBox.value) {
          promptBox.value = message.draft;
          draftSent = message.draft;
        }
        if (typeof message.search === 'string') searchText = message.search;
        // The extension's copy of the scroll memory is the persistent one; it is taken once,
        // at load, so a position noted here is never clobbered by a state echo.
        if (!boxScrollsLoaded && message.boxScrolls && typeof message.boxScrolls === 'object') {
          boxScrollsLoaded = true;
          boxScrolls = message.boxScrolls;
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
    // Every keystroke crosses, undelayed: the extension holds the only copy that survives this
    // webview, and a debounce here is a window in which typing exists nowhere else. The message
    // is small and the receiving end only writes a map entry; the disk write is coalesced there.
    promptBox.addEventListener('input', () => sendDraft('draftChanged'));
    // Losing focus is the cue to name the session after an unsent draft.
    promptBox.addEventListener('blur', () => sendDraft('draftBlur'));
    stopButton.addEventListener('click', () => {
      markStopping();
      vscode.postMessage({ type: 'stopPrompt', sessionId });
    });
    document.getElementById('bottom').addEventListener('click', () => selectBlock(session.turns.length - 1));
    forkButton.addEventListener('click', forkSelectedBlock);
    document.getElementById('load').addEventListener('click', loadSelectedPrompt);
    document.getElementById('cap').addEventListener('click', (event) => {
      // Armed means a screenshot is waiting to ride with the next Send; a second click discards it.
      capButton.disabled = true;
      if (capButton.classList.contains('armed')) {
        vscode.postMessage({ type: 'discardCapture', sessionId });
        return;
      }
      // A plain click minimizes this VS Code window for the shot, so it shows what was behind it.
      // Ctrl-click leaves the window up, for a picture of the window itself.
      vscode.postMessage({ type: 'captureScreen', sessionId, hideWindow: event.ctrlKey !== true });
    });
    // Manual scrolling never changes the selection; it is free only inside the window the
    // auto-scrolling rules allow (bordering bars and selected bar visible), so the scroll
    // position is clamped rather than the selection moved.
    historyBox.addEventListener('scroll', () => {
      if (programmaticScroll || !session.turns.length) return;
      const bounds = scrollBounds();
      if (!bounds) return;
      const clamped = Math.min(bounds.max, Math.max(bounds.min, historyBox.scrollTop));
      if (clamped !== historyBox.scrollTop) historyBox.scrollTop = clamped;
    });
    // The open box's clamp is sized from the pane height, so a pane resize has to
    // re-derive it or the old clamp sticks.
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const response = historyBox.querySelector('[data-index="' + anchorIndex + '"] .response');
        const atBottom = response ? response.scrollHeight - response.scrollTop - response.clientHeight < 18 : false;
        syncSelectedBlock(atBottom ? 'bottom' : response ? response.scrollTop : 0);
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
      describePicks();
      vscode.postMessage({ type: 'picksChanged', sessionId, model: modelSelect.value, effort: effortSelect.value });
    }

    // Step to the next preset. A pairing set by hand through the pickers matches none of them, so
    // findIndex gives -1 and the first preset is where the next click lands.
    function cyclePicks() {
      const at = PICK_PRESETS.findIndex((preset) => preset.model === modelSelect.value && preset.effort === effortSelect.value);
      const next = PICK_PRESETS[(at + 1) % PICK_PRESETS.length];
      modelSelect.value = next.model;
      effortSelect.value = next.effort;
      sendPicks();
    }

    // The letter says nothing about what is selected, so the hover does.
    function describePicks() {
      cycleButton.title = modelSelect.value + ' / ' + effortSelect.value + ' — click for the next preset';
    }

    function sendDraft(type) {
      const draft = promptBox.value;
      if (type === 'draftChanged' && draft === draftSent) return;
      draftSent = draft;
      vscode.postMessage({ type, sessionId, draft });
    }

    // The turn a stop has been asked for, so the Stop button can show that the request is in
    // flight. Cleared by the first render where that turn is no longer the running one.
    let stoppingTurn = null;

    function markStopping() {
      if (!status || !status.active) return;
      stoppingTurn = status.turnId;
      stopButton.classList.add('stopping');
    }

    function submitPrompt() {
      const prompt = promptBox.value;
      // Sending during a run is allowed: the extension stops the running turn and takes this
      // prompt instead, so Ctrl-Enter never has to wait for an answer that is no longer wanted.
      if (!prompt.trim()) return;
      markStopping();
      vscode.postMessage({ type: 'submitPrompt', sessionId, prompt, model: modelSelect.value, effort: effortSelect.value });
      promptBox.value = '';
      draftSent = '';
      // The new turn's block is selected and opened when it arrives; every other box closes
      // with it, since only one box is ever open.
      pendingTurnCount = session.turns.length + 1;
    }

    function loadSelectedPrompt() {
      if (!session.turns.length) return;
      const turn = session.turns[Math.max(0, Math.min(session.turns.length - 1, anchorIndex))];
      if (!turn) return;
      promptBox.value = turn.prompt + (promptBox.value ? '\\n\\n' + promptBox.value : '');
      sendDraft('draftChanged');
      promptBox.focus();
    }

    // Raw and streaming boxes: text is plain, except for a leading **bold** run on a line, used
    // for a tool name and by the model's own prose alike. Built as text nodes so nothing else
    // in the response is treated as markup.
    function fillResponse(box, text) {
      // Graft (since removed) closed responses with a tally line; old stored responses still
      // carry those lines, so no box ever shows them.
      const lines = text.split('\\n').filter((line) => !line.startsWith(GRAFT_TALLY_MARK));
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

    // Forks at the selected block: every block below it is dropped. On the last block nothing is
    // below it, so the fork is just the copy. The extension asks for confirmation either way.
    function forkSelectedBlock() {
      const turn = session.turns[anchorIndex];
      if (!turn) return;
      vscode.postMessage({ type: 'forkTurn', sessionId, turnId: turn.id });
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
        rawBox = false;
      }
      if (pendingTurnCount && turns.length >= pendingTurnCount) {
        anchorIndex = pendingTurnCount - 1;
        boxOpen = true;
        boxScrollNext = 'restore';
        rawBox = false;
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
      // The stopped turn has ended (or a Ctrl-Enter replacement has started in its place).
      if (stoppingTurn && (!active || status.turnId !== stoppingTurn)) {
        stoppingTurn = null;
        stopButton.classList.remove('stopping');
      }
      bottomButton.disabled = turns.length < 2 || anchorIndex === turns.length - 1;
      forkButton.disabled = !turns.length;
      loadButton.disabled = !turns.length;
      // Rebuilding throws the open box's scroll away, so it is measured first and restored,
      // still pinned to the bottom when it was there (how a streaming box follows its text).
      const selectedResponse = historyBox.querySelector('[data-index="' + anchorIndex + '"] .response');
      const selectedResponseTop = selectedResponse ? selectedResponse.scrollTop : 0;
      const selectedResponseAtBottom = selectedResponse ? selectedResponse.scrollHeight - selectedResponse.scrollTop - selectedResponse.clientHeight < 18 : false;
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
          const ranAs = [turn.model, turn.effort].filter(Boolean).join(' / ');
          bar.title = ranAs ? ranAs + '\\n' + turn.prompt : turn.prompt;
          bar.textContent = turn.prompt || '(empty prompt)';
          bar.addEventListener('click', (event) => {
            if (event.altKey) {
              vscode.postMessage({ type: 'copyText', sessionId, text: turn.prompt || '' });
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
              // Every fresh open starts as a markdown box.
              rawBox = false;
            }
            render();
          });
          wrapper.appendChild(bar);
          const isActiveTurn = active && status.turnId === turn.id;
          // Only the selected block's box exists, and only while open. A streaming turn is no
          // exception: moved away from or closed, its text keeps arriving invisibly.
          if (index === anchorIndex && boxOpen) {
            // The streaming box is always raw — its tool lines are the run's progress display —
            // and turns into a markdown box on the render that follows the run's end.
            const raw = isActiveTurn || rawBox;
            const response = document.createElement('div');
            response.className = 'response' + (raw ? '' : ' markdown') + (turn.error ? ' error' : '');
            // A run that failed part way still wrote everything up to that point, so the text stays
            // and the reason goes underneath it rather than in its place.
            if (raw) fillResponse(response, turn.response || '');
            else {
              response.innerHTML = renderMarkdown(strippedText(turn.response || ''));
              // finished gates the pre-stream render: a just-sent turn flashes as an empty
              // markdown box before its run goes active, and must not count as seen.
              if (turn.finished && !markdownSeen.has(turn.id)) {
                markdownSeen.add(turn.id);
                boxScrollNext = 'top';
              }
            }
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
                vscode.postMessage({ type: 'copyText', sessionId, text: raw ? body : strippedText(body) });
                response.animate([{ backgroundColor: '#ffc9c9' }, { backgroundColor: '#ffc9c9' }], 200);
                return;
              }
              // Only ctrl-click toggles the view; a plain click is left to text selection.
              if (!event.ctrlKey) return;
              // A click on a rendered link is the link, not the toggle.
              if (event.target.closest && event.target.closest('a')) return;
              // The streaming box does not answer the toggle; its tool lines stay up.
              if (status && status.active && status.turnId === turn.id) return;
              rawBox = !rawBox;
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
      // A selection that moved for any other reason (a fork shrank the list) still lands
      // its box on its remembered position, the same as every other fresh open.
      if (boxScrollNext === null && anchorIndex !== wasAnchor) boxScrollNext = 'restore';
      let boxScroll = boxScrollNext !== null ? boxScrollNext : selectedResponseAtBottom ? 'bottom' : selectedResponseTop;
      if (boxScroll === 'restore') {
        const saved = turns[anchorIndex] ? boxScrolls[turns[anchorIndex].id] : undefined;
        boxScroll = saved === undefined ? 'bottom' : saved;
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
      compactTimer = window.setTimeout(clearCompaction, 15000);
    }

    function clearCompaction() {
      if (compactTimer !== null) {
        window.clearTimeout(compactTimer);
        compactTimer = null;
      }
      document.getElementById('context').classList.remove('compacted');
    }

    document.getElementById('context').addEventListener('click', clearCompaction);

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
      const used = active ? status.contextTokens : turns.reduce((level, turn) => turn.contextUsed || level, 0);
      // Against the compaction point, not the window: the conversation is summarised there, so that
      // is the ceiling the level is really climbing towards. Only the denominator carries the K.
      const contextBox = document.getElementById('context');
      contextBox.textContent = Math.round((used || 0) / 1000) + '/' + inK(compactAt);
      // Latched locally the moment a new compaction is reported: the run's status stops being
      // posted once the turn ends, so the flag can't hang off it for its whole 15 seconds.
      if (active && status.compactedAt && status.compactedAt !== compactSeen) {
        compactSeen = status.compactedAt;
        flagCompaction();
      }
      // Every agentic turn the CLI has taken in this conversation, summed over all its prompts —
      // a flow like cost and time. It used to show the latest prompt's count alone, which read as
      // the conversation being shorter than the bars above plainly showed it was. The running
      // prompt's count rides on the status until it lands on the turn at completion.
      const agentic = turns.reduce((sum, turn) => sum + (turn.turns || 0), 0) + (active ? status.turns || 0 : 0);
      document.getElementById('turns').textContent = agentic;
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
      document.getElementById('pony').style.display = footer.ponytail ? '' : 'none';
      document.getElementById('pony-sep').style.display = footer.ponytail ? '' : 'none';
      const spent = turns.reduce((sum, turn) => sum + (turn.durationMs || 0), 0);
      document.getElementById('duration').textContent = shortTime(spent + (active ? liveElapsed() : 0));
      // One uppercase letter, with the full word on hover: T/W/Q/W/C while streaming,
      // F or S once the turn lands, R when idle.
      const label = active
        ? (status.phase || 'working')
        : latest && latest.finished
          ? (latest.stopped ? 'stopped' : 'finished')
          : 'ready';
      finish.className = 'indicator' + (active ? ' active' : latest && latest.finished ? ' done' : '');
      finish.textContent = label.charAt(0).toUpperCase();
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
        response.replaceChildren();
        fillResponse(response, turn.response || '');
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
      rawBox = false;
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
      // A ctrl-expanded prompt gives way first, down to three lines, before the box does.
      if (bar && bar.classList.contains('prompt-expanded') && spanHeight() > paneHeight) {
        const lineHeight = parseFloat(getComputedStyle(bar).lineHeight) || 20;
        bar.style.maxHeight = Math.ceil(lineHeight * 3 + 4) + 'px';
        bar.style.overflowY = 'auto';
      }
      if (response) {
        const excess = spanHeight() - paneHeight;
        if (excess > 0) {
          const lineHeight = parseFloat(getComputedStyle(response).lineHeight) || 20;
          response.style.maxHeight = Math.max(Math.ceil(lineHeight + 18), response.offsetHeight - excess) + 'px';
          response.style.overflowY = 'auto';
        }
      }
      const bounds = scrollBounds();
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

export function managementHtml(webview: vscode.Webview, pane: ManagementPane, timezone: string, zoom = 1): string {
  if (pane === "plugins") {
    return pluginsHtml(webview, zoom);
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
    .hint { flex: none; font-size: calc(14px * var(--z)); }
    /* position: relative so the crop rectangle can be laid over the picture; the image stays a
       direct grid item, which is what lets its max-height resolve against the frame. */
    .frame { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); display: grid; place-items: center; overflow: auto; padding: 8px; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; cursor: crosshair; user-select: none; -webkit-user-drag: none; touch-action: none; }
    .sel { position: absolute; border: 2px solid #1a6fd4; background: rgba(26,111,212,0.16); pointer-events: none; }
${tooltipStyle()}  </style>
</head>
<body>
  <div class="pane">
    <div class="title"><h1>Capture</h1><span id="path" class="path"></span><span id="hint" class="hint"></span><div class="actions"><button id="again" hidden>Send Again</button><button id="reload">Reload</button><button id="close">Close</button></div></div>
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
    const again = document.getElementById('again');
    const pending = new Map();
    // How many crops deep the shown picture is; a plain click can only undo when that is above 0.
    let depth = 0;
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
    // Send Again hands the picture back to the conversation's Cap button and closes this pane,
    // so the next prompt typed there carries it.
    again.addEventListener('click', () => vscode.postMessage({ type: 'sendCaptureAgain' }));
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
      if (payload && payload.dataUri) {
        img.src = payload.dataUri;
        img.hidden = false;
        empty.hidden = true;
        pathLabel.textContent = payload.path || '';
        hint.textContent = depth > 0 ? 'drag to crop · click to undo a crop' : 'drag to crop';
        // Already sent (or the Cap button was turned off): offer to arm it for another prompt.
        again.hidden = payload.armed === true;
      } else {
        img.removeAttribute('src');
        img.hidden = true;
        empty.hidden = false;
        empty.textContent = reply.ok ? 'No capture to show yet — click Cap in a conversation.' : 'Could not load the capture: ' + (reply.error || 'unknown error');
        pathLabel.textContent = '';
        hint.textContent = '';
        again.hidden = true;
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
    // coming to the image no matter where the pointer ends up.
    img.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !img.getAttribute('src')) return;
      event.preventDefault();
      img.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, moved: false };
      sel.hidden = true;
    });
    img.addEventListener('pointermove', (event) => {
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
    img.addEventListener('pointerup', (event) => void finish(event));
    img.addEventListener('pointercancel', () => {
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
function pluginsHtml(webview: vscode.Webview, zoom: number): string {
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
    .pane { display: flex; flex-direction: column; height: 100vh; padding: 20px 24px; }
    .title { display: flex; align-items: baseline; gap: 12px; flex: none; margin-bottom: 8px; }
    h1 { font-size: calc(18px * var(--z)); font-weight: 600; margin: 0; }
    #note { font-size: calc(14px * var(--z)); }
    .actions { margin-left: auto; display: flex; gap: 12px; flex: none; }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 14px; min-height: 35px; font: inherit; cursor: pointer; }
    button:hover { background: linear-gradient(var(--wash), var(--wash)), var(--surface); }
    .scroll { flex: 1; min-height: 0; overflow: auto; padding-right: 4px; }
    table { border-collapse: collapse; background: var(--surface); font-size: calc(14px * var(--z)); }
    th, td { border: 1px solid var(--border); padding: 5px 12px; text-align: right; white-space: nowrap; color: var(--ink); }
    th { text-align: center; font-weight: 600; }
    td:first-child { text-align: left; font-weight: 600; }
    td:last-child, th:last-child { font-weight: 600; }
    td.mid { text-align: center; }
    input[type=checkbox] { width: calc(15px * var(--z)); height: calc(15px * var(--z)); margin: 0; }
  </style>
</head>
<body>
  <div class="pane">
    <div class="title"><h1>Plugins</h1><span id="note"></span><div class="actions"><button id="reload">Reload</button><button id="close">Close</button></div></div>
    <div class="scroll"><table id="table"></table></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
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
        for (const project of projects) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = project[plugin] !== false;
          // a flag the server cannot hear about would silently not stick
          box.disabled = report.offline === true;
          box.addEventListener('change', () => void toggle(box, project.project, plugin));
          const holder = cell('td', '');
          holder.className = 'mid';
          holder.appendChild(box);
          row.appendChild(holder);
        }
        row.appendChild(cell('td', ''));
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
${tooltipStyle()}  </style>
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
    // Each write also copies CLAUDE.md to .github/copilot-instructions.md.
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
    .credits { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: calc(14px * var(--z)); font-variant-numeric: tabular-nums; }
    .credits .bar { display: block; width: min(340px, 40%); height: calc(12px * var(--z)); border: 1px solid var(--border); border-radius: 6px; background: #fff; overflow: hidden; }
    .credits .fill { display: block; height: 100%; background: var(--blue); }
    button { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--ink); padding: 7px 13px; min-height: 34px; font: inherit; cursor: pointer; }
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
    .period button { min-height: 26px; padding: 2px 8px; }
    .plot { position: relative; width: 100%; aspect-ratio: 256 / 140; border: 1px solid var(--border); cursor: pointer; background: #fff; }
    .graphs.single .plot { flex: none; }
    svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    svg text { font-size: calc(14px * var(--z)); fill: var(--muted); text-anchor: end; }
    .figures { margin-top: 8px; color: var(--muted); font-size: calc(14px * var(--z)); font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
    .empty, .error { border: 1px dashed var(--border); border-radius: 8px; padding: 18px; color: var(--muted); }
    .error { background: #fdecec; color: #731b1b; border-style: solid; }
    @media (max-width: 900px) { .graphs { grid-template-columns: 1fr; } .title, .actions { align-items: flex-start; flex-wrap: wrap; } }
${tooltipStyle()}  </style>
</head>
<body>
  <div id="pane" class="pane">
    <div class="title"><h1>Plan quota over time</h1><div id="credits" class="credits"></div><div class="actions"><span id="readTime"></span><span id="age"></span><button id="update">Update</button><button id="close">Close</button></div></div>
    <div id="error" class="error" hidden></div>
    <div id="graphs" class="graphs"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${zoomScript(z)}
    const timeZone = ${safeTimezone};
    const pending = new Map();
    const backs = { five: 0, seven: 0 };
    let payload = { readAt: null, rows: [], state: { error: null } };
    let expanded = null;
    let loading = true;
    let updating = false;
    let measured = { width: 256, height: 140 };
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
      renderCredits();
      const graphsNode = document.getElementById('graphs');
      const pane = document.getElementById('pane');
      const five = buildWindowGraph('five', '5h', 5 * 60 * 60 * 1000, [{ field: 'five_pct', reset: 'five_resets', name: '5h', color: '#000' }], rows);
      const seven = buildWindowGraph('seven', '7d', 7 * 24 * 60 * 60 * 1000, [{ field: 'seven_pct', reset: 'seven_resets', name: '7d', color: '#2457d6' }, { field: 'fable_pct', reset: 'fable_resets', name: modelLabel(), color: '#c62828' }], rows);
      // Row 1 is the raw graphs, row 2 the against-target deltas sitting under their match.
      const graphs = [five, seven, deltaGraph(five, 'fiveDelta', 'Δ5h'), deltaGraph(seven, 'sevenDelta', 'Δ7d')];
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

    // Live reading first; if this reading had no credits block, fall back to the newest row that did.
    function renderCredits() {
      const node = document.getElementById('credits');
      const live = payload.state && payload.state.credits;
      let spent = live ? numeric(live.spentUsd) : null;
      let limit = live ? numeric(live.limitUsd) : null;
      if (spent === null || limit === null) {
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (numeric(rows[index].spent_usd) !== null && numeric(rows[index].limit_usd) !== null) {
            spent = numeric(rows[index].spent_usd);
            limit = numeric(rows[index].limit_usd);
            break;
          }
        }
      }
      if (spent === null || limit === null || limit <= 0) {
        node.replaceChildren();
        return;
      }
      const pct = Math.max(0, Math.min(100, (spent / limit) * 100));
      const fill = pct <= 50 ? '#8f8' : (pct <= 75 ? '#ff8' : '#f88');
      node.innerHTML = '<span>' + escapeHtml(money(spent)) + '</span><span class="bar"><span class="fill" style="width:' + pct.toFixed(1) + '%;background:' + fill + '"></span></span><span>' + escapeHtml(money(limit)) + '</span>';
    }

    function money(value) { return '$' + Number(value).toFixed(2); }

    function graphElement(graph) {
      const graphNode = document.createElement('section');
      graphNode.className = 'graph';
      const periods = graph.periods;
      const backKey = graph.backKey || graph.key;
      const back = Math.min(backs[backKey] || 0, Math.max(0, periods.length - 1));
      backs[backKey] = back;
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
      periodBar.innerHTML = '<button data-page="older" data-key="' + backKey + '" ' + (back >= periods.length - 1 ? 'disabled' : '') + '>‹</button><span>' + escapeHtml(period.label) + '</span><button data-page="newer" data-key="' + backKey + '" ' + (back === 0 ? 'disabled' : '') + '>›</button>';
      const plot = document.createElement('div');
      plot.className = 'plot';
      plot.dataset.expand = graph.key;
      const size = expanded === graph.key ? measured : { width: 256, height: 140 };
      plot.innerHTML = drawSvg(period, size.width, size.height, graph.delta);
      const figures = document.createElement('div');
      figures.className = 'figures';
      figures.innerHTML = figuresHtml(period, graph.delta);
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
          measured = { width: 256, height: 140 };
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
      const height = Math.round(width * (140 / 256));
      card.style.width = (width + frameX) + 'px';
      if (Math.abs(width - measured.width) > 1 || Math.abs(height - measured.height) > 1) {
        measured = { width, height };
        render();
      }
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

    // Same periods as its parent graph (shared backKey keeps paging in lockstep), but each point
    // becomes used% minus the target% the diagonal above shows: the share of the period elapsed.
    function deltaGraph(graph, key, title) {
      const periods = graph.periods.map((period) => Object.assign({}, period, {
        key,
        delta: true,
        series: period.series.map((series) => ({
          name: series.name,
          color: series.color,
          points: series.points.map((point) => ({ t: point.t, v: point.v - targetPct(period, point.t) })),
        })),
      }));
      return { key, backKey: graph.key, title, delta: true, periods };
    }

    function targetPct(period, time) {
      return 100 * Math.min(1, Math.max(0, (time - period.start) / (period.end - period.start)));
    }

    function drawSvg(period, width, height, delta) {
      // "-20%" is exactly as wide as "100%", so the delta card's gutter matches its parent's and
      // the two x-axes line up without any cross-card measurement.
      const yMax = delta ? 20 : 100;
      const yMin = delta ? -20 : 0;
      const fractions = delta ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
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
      if (delta) {
        const rule = (value, dash) => '<line x1="' + margin.left + '" x2="' + (width - margin.right) + '" y1="' + y(value) + '" y2="' + y(value) + '" stroke="rgba(0,0,0,0.45)" stroke-width="1"' + dash + ' />';
        svg += rule(0, '');
        svg += rule(-10, ' stroke-dasharray="5 4"') + rule(10, ' stroke-dasharray="5 4"');
        // Unreachable bounds: used% <= 100 caps delta at 100-elapsed% (visible over the last 20%
        // of the period), used% >= 0 floors it at -elapsed% (visible over the first 20%).
        const atFrac = (fraction) => margin.left + fraction * plotWidth;
        const bound = (f1, v1, f2, v2) => '<line x1="' + atFrac(f1) + '" y1="' + y(v1) + '" x2="' + atFrac(f2) + '" y2="' + y(v2) + '" stroke="rgba(0,0,0,0.45)" stroke-dasharray="5 4" stroke-width="1" />';
        svg += bound(0.8, yMax, 1, 0) + bound(0, 0, 0.2, yMin);
      } else {
        svg += '<line x1="' + margin.left + '" y1="' + y(0) + '" x2="' + (width - margin.right) + '" y2="' + y(yMax) + '" stroke="rgba(0,0,0,0.45)" stroke-dasharray="5 4" stroke-width="1" />';
      }
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
      // A delta series carried forward is not flat: usage holds but the target keeps climbing.
      if (last.t < knownTo) sorted.push({ t: knownTo, v: period.delta ? last.v - (targetPct(period, knownTo) - targetPct(period, last.t)) : last.v });
      return sorted;
    }

    function figuresHtml(period, delta) {
      const parts = [];
      for (const series of period.series) {
        const points = carriedPoints(series.points, period);
        if (points.length) {
          const value = points[points.length - 1].v;
          const label = axisLabel(value);
          parts.push('<span style="color:' + series.color + '">' + escapeHtml(series.name + ' ' + (delta && value > 0 ? '+' + label : label)) + '</span>');
        }
      }
      if (!delta) {
        const elapsed = Math.max(0, Math.min(1, (Date.now() - period.start) / (period.end - period.start)));
        parts.push('<span>' + Math.round(elapsed * 100) + '%</span>');
        parts.push('<span>' + escapeHtml(timeLeft(period.end - Date.now())) + '</span>');
      }
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
      if (graph.key !== 'seven' && graph.key !== 'sevenDelta') return '';
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

// Tooltips are drawn by the pane, not by the browser: a native `title` bubble renders at a fixed
// OS size that no stylesheet can reach, and these have to read at the pane's own (larger) size.
// Paired with tooltipScript(), which is what actually harvests the `title` attributes.
function tooltipStyle(): string {
  return `
    #tip { position: fixed; left: 0; top: 0; z-index: 9999; display: none; max-width: 60ch; padding: 4px 9px; border: 1px solid var(--border, #d9d8d1); border-radius: 6px; background: var(--surface, #fcfcfb); color: var(--ink, #000); font-size: calc(12.32px * var(--z, 1)); line-height: 1.35; white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 2px 8px rgba(0,0,0,0.18); pointer-events: none; }
    #tip.shown { display: block; }
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
    let tipX = 0;

    function hideTip() {
      clearTimeout(tipTimer);
      tipHost = null;
      tipNode.classList.remove('shown');
    }

    // Anchored to the hovered element's box, not to the cursor: a cursor-anchored bubble that has to
    // flip upward for room lands back on top of the element it describes, hiding whatever is drawn
    // there.
    function showTip(text, node, x) {
      tipNode.textContent = text;
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
      tipTimer = setTimeout(() => { if (node.isConnected) showTip(text, node, x); }, TIP_DELAY);
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
      showTip(tipNode.textContent || '', tipHost, tipX);
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