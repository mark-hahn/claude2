import * as vscode from "vscode";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { captureScreen } from "./capture";
import { ClaudeCliRunner, truncateSessionTranscript, type RunLimits } from "./claudeCli";
import { InstructionsFile } from "./instructionsFile";
import { PluginStats, type StatsDelta } from "./pluginStats";
import { QuotaService } from "./quota";
import { SessionStore } from "./sessionStore";
import { CLAUDE2_CONTEXT_WINDOW, DEFAULT_EFFORT, DEFAULT_MODEL, GRAFT_TALLY_MARK, TOOL_LINE_MARK, type ClaudeSession, type ClaudeTurn, type InstallStats, type PluginFlags, type PonySkip } from "./types";
import { conversationHtml, managementHtml, sidebarHtml, zoomFactor, type ConversationDefaults, type ManagementPane } from "./webviews";

let output: vscode.OutputChannel | undefined;
let controller: Claude2Controller | undefined;

// What the Cap pane is shown: the picture, where it lives, how many crops it is deep, and
// whether it is still armed to ride with the next prompt (if not, the pane offers Send Again).
type CaptureView = { path: string | null; dataUri: string | null; depth: number; armed: boolean };

// The Plugins pane's table: one column per project rolled up from every install's record on
// the stats server, with that project's plugin switches folded in. `offline` marks a table
// built from the local record alone because the server could not be reached.
type ProjectColumn = Omit<InstallStats, "host" | "path" | "updatedAt"> & { hosts: string; paths: string; graft: boolean; ponytail: boolean };
type PluginsReport = { projects: ProjectColumn[]; offline: boolean };

const PNG_DATA_URI = "data:image/png;base64,";

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Claude2");
  context.subscriptions.push(output);
  output.appendLine("Claude2 activated");
  controller = new Claude2Controller(context, output);
  controller.activate();
  context.subscriptions.push(controller);
}

// Awaited by VS Code, which is the last chance to get unsent prompt text to disk: the
// controller is in context.subscriptions and `dispose` is too late to await anything.
export async function deactivate(): Promise<void> {
  await controller?.flush();
  output?.appendLine("Claude2 deactivated");
}

class Claude2Controller implements vscode.Disposable {
  private readonly store: SessionStore;
  private readonly runner: ClaudeCliRunner;
  private readonly instructions = new InstructionsFile();
  private readonly quota: QuotaService;
  private readonly stats: PluginStats;
  private readonly conversationPanels = new Map<string, vscode.WebviewPanel>();
  private readonly leaveResolvers = new Map<string, (go: boolean) => void>();
  // Unsent prompt text per session, and the draft each auto-generated name was built from.
  // Drafts live in workspaceState next to the sessions, so a reload puts every unsent prompt
  // back in its box; an entry is dropped only once its text has been submitted, emptied by hand,
  // or permanently deleted along with the trashed session holding it. Every
  // entry is keyed by a session that exists -- a draft left without one is given a session of
  // its own (see `rescueDraft`), since the box of its session is the only way back to the text.
  private readonly drafts = new Map<string, string>();
  // The turn currently running in each session, settled once its bookkeeping is written. A
  // prompt sent mid-run awaits this, so the stopped turn is complete before the next one starts.
  private readonly runs = new Map<string, Promise<void>>();
  private readonly draftNames = new Map<string, string>();
  // Sessions permanently deleted in this window. Their drafts went with them, so late typing
  // from a panel already torn down is dropped instead of being rescued into a new session.
  private readonly discarded = new Set<string>();
  // The pending coalesced write of `drafts`, and the last one handed to workspaceState.
  private draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private draftSave: Thenable<unknown> = Promise.resolve();
  // Sessions whose panel should put the caret in the prompt box once its webview loads.
  private readonly pendingPromptFocus = new Set<string>();
  // Index of the response box each conversation has selected; the md pane renders that one.
  private readonly selectedTurns = new Map<string, number>();
  // Each box's scroll position per session, keyed by turn id ('bottom' pins to the end).
  // Deliberately not persisted to disk: the memory outlives any one webview but resets
  // when the extension reloads.
  private readonly boxScrolls = new Map<string, Record<string, unknown>>();
  // Screenshot armed by the Cap button, per session: the PNG path rides along with the next
  // prompt submitted, then the entry clears. Toggling Cap off clears it without sending.
  private readonly pendingCaptures = new Map<string, string>();
  // Most recent capture taken, kept after submit or discard so the Cap pane can still show it.
  private lastCapture: string | null = null;
  // The pictures each crop in the Cap pane started from, oldest first: a plain click in a cropped
  // image pops one back. A fresh capture, or toggling Cap off, empties it.
  private readonly cropStack: string[] = [];
  private sidebarProvider: ClaudeSidebarProvider | null = null;
  private managementPanel: vscode.WebviewPanel | null = null;
  private managementPane: ManagementPane | null = null;
  // The conversation a management button toggles back to; the panels themselves are all
  // inactive while a management pane is up front, so remember the last one focused.
  private lastConversationId = "";
  // Sidebar search text; non-empty means search mode, and every conversation pane tints matching lines.
  private searchText = "";
  // The Login button drives one "claude auth login" at a time.
  private loginInFlight = false;
  // Set when a turn died on expired OAuth; the sidebar shows a red Re-Auth button until a
  // sign-in succeeds. It lives in globalState so the button survives reloads and reboots,
  // and so every window on this machine shows it — the credentials it reflects are shared.
  private authNeeded = false;
  private instructionsWatcher: vscode.FileSystemWatcher | null = null;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly channel: vscode.OutputChannel) {
    this.store = new SessionStore(context);
    this.runner = new ClaudeCliRunner((line) => this.channel.appendLine(line));
    this.quota = new QuotaService(context, this.workspacePath(), (line) => this.channel.appendLine(line));
    this.stats = new PluginStats(context, this.workspacePath(), (line) => this.channel.appendLine(line));
    void this.stats.seed(this.store.all());
    // turn events queued while the stats server was unreachable drain on activation
    void this.stats.flushTurns();
    this.authNeeded = context.globalState.get<boolean>(authNeededKey, false);
    this.loadDrafts();
  }

  // Drafts saved by an earlier window come back keyed by session. An entry whose session is
  // gone is orphaned typing: it is kept for now and `rescueOrphanDrafts` gives it a session of
  // its own once the window is up, since a draft with no session can never be reached.
  private loadDrafts(): void {
    const saved = this.context.workspaceState.get<Record<string, string>>(draftsKey, {});
    for (const [sessionId, text] of Object.entries(saved)) {
      if (typeof text === "string" && text) {
        this.drafts.set(sessionId, text);
      }
    }
    // Written by an older build that parked one draft outside the sessions; the entry it points
    // at is now an orphan like any other, so the key itself has nothing left to say.
    void this.context.workspaceState.update(promptTextLostKey, undefined);
    this.saveDrafts();
  }

  // The map is the live copy and takes every keystroke; the write behind it is coalesced, since
  // a memento write per character would be exactly that. Nothing is at risk in the gap -- a
  // reopened panel is filled from the map, and blur, panel close and shutdown all flush -- so
  // only an extension host killed outright inside the window can cost anything.
  private saveDrafts(): void {
    if (this.draftSaveTimer) {
      return;
    }
    this.draftSaveTimer = setTimeout(() => this.flushDrafts(), 250);
  }

  private flushDrafts(): Thenable<unknown> {
    if (this.draftSaveTimer) {
      clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    this.draftSave = this.context.workspaceState.update(draftsKey, Object.fromEntries(this.drafts));
    return this.draftSave;
  }

  // Awaited by `deactivate`, so a window closing on unsent text still writes it out.
  public async flush(): Promise<void> {
    await this.flushDrafts();
    await this.store.flush();
  }

  // The one rule that keeps typing reachable: every draft belongs to a session that exists. A
  // draft whose session is going away is moved into a session created for it here -- an ordinary
  // session in every respect, named from the text and sitting in the list with the others. It is
  // opened like any other session, and the text is waiting in its prompt box.
  private async rescueDraft(sessionId: string): Promise<void> {
    const text = this.drafts.get(sessionId) ?? "";
    if (!text.trim()) {
      return;
    }
    this.drafts.delete(sessionId);
    const session = await this.store.create();
    this.drafts.set(session.id, text);
    this.saveDrafts();
    this.refreshSidebar();
    await this.nameSessionFromDraft(session.id);
  }

  // Drafts left stranded by an earlier window -- its session deleted while the text was in
  // flight, or parked by the old lost-draft key -- get their sessions on the way up.
  private async rescueOrphanDrafts(): Promise<void> {
    for (const sessionId of [...this.drafts.keys()]) {
      if (!this.store.get(sessionId)) {
        await this.rescueDraft(sessionId);
      }
    }
  }

  public activate(): void {
    this.sidebarProvider = new ClaudeSidebarProvider(this.context, this);
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("claude2.sidebar", this.sidebarProvider),
      vscode.commands.registerCommand("claude2.newSession", () => void this.newSession()),
      vscode.commands.registerCommand("claude2.openInstructions", () => void this.openManagement("instructions")),
      vscode.commands.registerCommand("claude2.openQuota", () => void this.openManagement("quota")),
    );
    this.quota.start();
    this.watchInstructions();
    void this.rescueOrphanDrafts();
  }

  public dispose(): void {
    this.runner.dispose();
    this.quota.dispose();
    this.instructionsWatcher?.dispose();
    for (const panel of this.conversationPanels.values()) {
      panel.dispose();
    }
    this.managementPanel?.dispose();
  }

  public sessions() {
    return this.store.all();
  }

  // The session whose editor is up front; the sidebar tints that card. Visibility decides
  // it rather than `lastConversationId`, which stays put once another editor takes over
  // the column and would leave a card tinted with no session showing.
  public selectedSessionId(): string {
    if (this.conversationPanels.get(this.lastConversationId)?.visible) {
      return this.lastConversationId;
    }
    for (const [sessionId, panel] of this.conversationPanels) {
      if (panel.visible) {
        return sessionId;
      }
    }
    return "";
  }

  public async handleSidebarMessage(message: unknown): Promise<void> {
    const record = recordOf(message);
    const type = stringOf(record?.type);
    if (type === "ready") {
      this.refreshSidebar();
      return;
    }
    // Alt-click copies; it must not disturb the selection or sweep away an empty session.
    if (type === "copyText") {
      await this.copyToClipboard(stringOf(record?.text));
      return;
    }
    // A session created by "+" that never got a prompt is scratch: drop it as soon as
    // attention moves to any other sidebar control or session card. "Close" keeps the
    // current tab, so its session survives the sweep even when it is still empty --
    // unless it is the last one, where "Close" takes it down with the rest.
    const requestedSessionId = stringOf(record?.sessionId);
    const sessionPaneCount = this.conversationPanels.size;
    const keepId = requestedSessionId || (type === "closeOtherSessions" && sessionPaneCount > 1 ? this.activeConversationId() : "");
    await this.discardEmptySessions(keepId);
    if (type === "closeOtherSessions") {
      this.closeSessionPanes(keepId, sessionPaneCount);
    } else if (type === "newSession") {
      await this.newSession();
    } else if (type === "openSession") {
      await this.openConversation(requestedSessionId);
    } else if (type === "renameSession") {
      await this.renameSession(stringOf(record?.sessionId), stringOf(record?.name));
    } else if (type === "trashSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), true);
      this.refreshSidebar();
    } else if (type === "trashAllSessions") {
      for (const session of this.store.all()) {
        if (!session.trashed) {
          await this.store.setTrashed(session.id, true);
        }
      }
      this.refreshSidebar();
    } else if (type === "deleteAllTrashed") {
      await this.deleteAllTrashed();
    } else if (type === "deleteSessions") {
      const ids = Array.isArray(record?.sessionIds) ? record.sessionIds.map(stringOf).filter((id) => id !== "") : [];
      await this.deleteTrashedSessions(ids, `Permanently delete the ${ids.length} older session${ids.length === 1 ? "" : "s"} below this one?`);
    } else if (type === "restoreSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), false);
      this.refreshSidebar();
    } else if (type === "deleteSession") {
      const sessionId = stringOf(record?.sessionId);
      if (!(await this.confirmDelete(sessionId))) {
        return;
      }
      await this.deleteSession(sessionId);
    } else if (type === "searchChanged") {
      this.setSearch(stringOf(record?.text));
    } else if (type === "login") {
      await this.loginToAnthropic();
    } else if (type === "openPane") {
      const pane = paneOf(record?.pane);
      if (pane) {
        await this.openManagement(pane);
      }
    }
  }

  private async newSession(): Promise<void> {
    if (!(await this.ensureEnabled())) {
      return;
    }
    await this.discardEmptySessions();
    const session = await this.store.create();
    this.refreshSidebar();
    await this.openConversation(session.id, true);
  }

  // Forget every session with nothing in it -- no turn, no unsent draft, no armed capture --
  // except `exceptId`. An armed screenshot counts the same as typed text: it is content waiting
  // to be sent, and the Cap pane is reached through the sidebar, which is what runs this sweep.
  private async discardEmptySessions(exceptId = ""): Promise<void> {
    // The sidebar click and the prompt box's blur race each other across two webviews;
    // let the blur's draft message land first so a typed draft is never dropped.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stale = this.store
      .all()
      .filter(
        (session) =>
          session.id !== exceptId &&
          session.turns.length === 0 &&
          !this.drafts.get(session.id) &&
          !this.pendingCaptures.has(session.id),
      );
    if (stale.length === 0) {
      return;
    }
    for (const session of stale) {
      this.conversationPanels.get(session.id)?.dispose();
      this.draftNames.delete(session.id);
      // Belt and braces with the filter above: typing that arrived in the same instant gets a
      // session of its own rather than being swept out with this one.
      await this.rescueDraft(session.id);
      await this.store.remove(session.id);
    }
    this.refreshSidebar();
  }

  // The trash icon on a trashed card is the permanent one: the session is forgotten outright,
  // not just hidden, so its tab and its unsent draft go with it. Deleting from the trash is the
  // one deliberate way to throw typing away, alongside emptying the box.
  private async confirmDelete(sessionId: string): Promise<boolean> {
    const name = this.store.get(sessionId)?.name || "this session";
    const answer = await vscode.window.showWarningMessage(
      `Permanently delete "${name}"?`,
      { modal: true, detail: "This cannot be undone." },
      "Delete",
    );
    return answer === "Delete";
  }

  // Ctrl-click on the trash button while the trash list is showing empties it for good.
  private async deleteAllTrashed(): Promise<void> {
    const ids = this.store.all().filter((session) => session.trashed).map((session) => session.id);
    await this.deleteTrashedSessions(ids, `Permanently delete ${ids.length} trashed session${ids.length === 1 ? "" : "s"}?`);
  }

  // The bulk sweeps of the trash. One prompt covers the whole run, and each session then goes
  // the same way as a single permanent delete: forgotten outright, tab and all. Only trashed
  // sessions are ever taken, so a stale id list from the sidebar cannot reach a live session.
  private async deleteTrashedSessions(sessionIds: readonly string[], question: string): Promise<void> {
    const ids = sessionIds.filter((id) => this.store.get(id)?.trashed === true);
    if (ids.length === 0) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      question,
      { modal: true, detail: "This cannot be undone." },
      "Delete",
    );
    if (answer !== "Delete") {
      return;
    }
    for (const id of ids) {
      await this.deleteSession(id);
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    this.conversationPanels.get(sessionId)?.dispose();
    this.conversationPanels.delete(sessionId);
    this.draftNames.delete(sessionId);
    // Both ways in are the permanent delete of a trashed session, which is as deliberate as
    // clearing the box: the unsent text goes with the session rather than into one of its own.
    this.discarded.add(sessionId);
    if (this.drafts.delete(sessionId)) {
      this.saveDrafts();
    }
    await this.store.remove(sessionId);
    this.refreshSidebar();
  }

  // The sidebar card edits the name in place, so the new text arrives with the message.
  private async renameSession(sessionId: string, name: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || !name.trim() || name === session.name) {
      return;
    }
    // A hand-picked name outranks anything auto-naming would put there later.
    this.draftNames.delete(sessionId);
    await this.store.rename(sessionId, name);
    this.postConversationState(sessionId);
    this.refreshSidebar();
  }

  private async openConversation(sessionId: string, focusPrompt = false): Promise<void> {
    if (!sessionId || !(await this.ensureEnabled())) {
      return;
    }
    const session = this.store.get(sessionId);
    if (!session) {
      return;
    }
    let panel = this.conversationPanels.get(sessionId);
    if (!panel) {
      panel = vscode.window.createWebviewPanel("claude2.conversation", session.name, vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.webview.html = conversationHtml(panel.webview, sessionId, this.conversationDefaults(sessionId), this.zoomOf("conversation"));
      panel.webview.onDidReceiveMessage((message) => void this.handleConversationMessage(message));
      panel.onDidChangeViewState(() => {
        if (panel?.active) {
          this.lastConversationId = sessionId;
        }
        // Losing visibility has to refresh too, otherwise the card keeps its tint.
        this.refreshSidebar();
      });
      panel.onDidDispose(() => {
        // The box that held the text is gone; what it last sent goes to disk now.
        void this.flushDrafts();
        this.conversationPanels.delete(sessionId);
        this.selectedTurns.delete(sessionId);
        if (this.lastConversationId === sessionId) {
          this.lastConversationId = "";
        }
        this.refreshSidebar();
      });
      this.conversationPanels.set(sessionId, panel);
    }
    this.lastConversationId = sessionId;
    panel.title = session.name;
    panel.reveal(vscode.ViewColumn.One);
    this.postConversationState(sessionId);
    this.refreshSidebar();
    if (focusPrompt) {
      // A brand-new panel's webview has not loaded yet, so the message would be dropped;
      // `conversationReady` replays it. Posting now covers a panel that is already up.
      this.pendingPromptFocus.add(sessionId);
      void panel.webview.postMessage({ type: "focusPrompt" });
    }
  }

  // Only a conversation panel VS Code currently has focused counts as current; if focus
  // sits anywhere else, "Close" leaves no session tab open.
  private activeConversationId(): string {
    for (const [sessionId, panel] of this.conversationPanels) {
      if (panel.active) {
        return sessionId;
      }
    }
    return "";
  }

  // Bring the conversation back up front. False when there is no conversation tab to show,
  // which leaves the management pane where it is rather than toggling to nothing.
  private revealConversation(): boolean {
    const panel = this.conversationPanels.get(this.lastConversationId) ?? [...this.conversationPanels.values()].pop();
    if (!panel) {
      return false;
    }
    panel.reveal(vscode.ViewColumn.One);
    return true;
  }

  // "Close" works down a ladder: with several session tabs open it keeps the current one,
  // with a single one left it closes that too, and once no session tab remains the click
  // closes the management pane. `paneCount` is the count from before empty sessions were
  // swept, so the sweep itself cannot promote a close into a management-pane close.
  private closeSessionPanes(keepId: string, paneCount: number): void {
    if (paneCount === 0) {
      this.managementPanel?.dispose();
      return;
    }
    for (const [sessionId, panel] of [...this.conversationPanels]) {
      if (sessionId !== keepId) {
        panel.dispose();
      }
    }
  }

  private async handleConversationMessage(message: unknown): Promise<void> {
    const record = recordOf(message);
    const type = stringOf(record?.type);
    const sessionId = stringOf(record?.sessionId);
    if (type === "zoom") {
      await this.noteZoom("conversation", record?.zoom);
    } else if (type === "conversationReady") {
      this.postConversationState(sessionId);
      this.postCapState(sessionId);
      if (this.pendingPromptFocus.delete(sessionId)) {
        void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "focusPrompt" });
      }
    } else if (type === "captureScreen") {
      await this.captureForSession(sessionId, record?.hideWindow === true);
    } else if (type === "discardCapture") {
      this.pendingCaptures.delete(sessionId);
      this.cropStack.length = 0;
      this.postCapState(sessionId);
    } else if (type === "submitPrompt") {
      await this.submitPrompt(sessionId, stringOf(record?.prompt), stringOf(record?.model), stringOf(record?.effort));
    } else if (type === "picksChanged") {
      await this.store.setPicks(sessionId, stringOf(record?.model), stringOf(record?.effort));
    } else if (type === "draftChanged") {
      this.noteDraft(sessionId, stringOf(record?.draft));
    } else if (type === "draftBlur") {
      this.noteDraft(sessionId, stringOf(record?.draft));
      void this.flushDrafts();
      await this.nameSessionFromDraft(sessionId);
    } else if (type === "stopPrompt") {
      this.runner.stop(sessionId);
      this.postConversationState(sessionId);
    } else if (type === "copyText") {
      await this.copyToClipboard(stringOf(record?.text));
    } else if (type === "forkTurn") {
      await this.forkTurn(sessionId, stringOf(record?.turnId));
    } else if (type === "selectionChanged") {
      const index = record?.index;
      this.selectedTurns.set(sessionId, typeof index === "number" ? index : 0);
      if (sessionId === this.lastConversationId) {
        this.postSelectedResponse();
      }
    } else if (type === "boxScrollsChanged") {
      const scrolls = recordOf(record?.boxScrolls);
      if (scrolls) {
        this.boxScrolls.set(sessionId, scrolls);
      }
    }
  }

  // The ⟲ mark on a prompt bar: the conversation goes back to just after that run, here and in the
  // CLI's own transcript, so the next prompt continues as if the dropped runs never happened.
  private async forkTurn(sessionId: string, turnId: string): Promise<void> {
    const session = this.store.get(sessionId);
    const index = session?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
    if (!session || index < 0 || index === session.turns.length - 1) {
      return;
    }
    if (this.runner.isRunning(sessionId)) {
      void vscode.window.showWarningMessage("Claude is still responding in this session; stop it before forking.");
      return;
    }
    const count = session.turns.length - index - 1;
    const answer = await vscode.window.showWarningMessage(
      `Fork the conversation here, dropping the ${count} run${count === 1 ? "" : "s"} after this one?`,
      { modal: true, detail: "Claude forgets them too. The previous transcript is kept as a .bak file beside it." },
      "Fork",
    );
    if (answer !== "Fork") {
      return;
    }
    const droppedPrompt = session.turns[index + 1].prompt;
    const result = await this.store.keepThrough(sessionId, turnId);
    if (!result) {
      return;
    }
    if (!truncateSessionTranscript(this.workspacePath(), sessionId, result.kept, droppedPrompt)) {
      this.channel.appendLine(`Fork: no CLI transcript cut for session ${sessionId}; the dropped runs may still be in Claude's context.`);
    }
    this.selectedTurns.set(sessionId, index);
    this.postConversationState(sessionId);
    this.refreshSidebar();
    this.postSelectedResponse();
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (!text) {
      return;
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage("Copied to clipboard", 1500);
  }

  // The response box the conversation has selected, as the md pane wants it. The pane opens from
  // the sidebar, so the conversation it reads from is the last one focused. The turn id rides
  // along so the pane can tell a growing response apart from a different one and keep its scroll.
  // Tool groups never reach the pane: their lines drop here the same way the conversation hides
  // them — no leading blanks, and runs of blank lines collapse to a single one.
  private selectedResponse(): { turnId: string; prompt: string; text: string } | null {
    const session = this.store.get(this.lastConversationId);
    if (!session || !session.turns.length) {
      return null;
    }
    const index = Math.max(0, Math.min(session.turns.length - 1, this.selectedTurns.get(session.id) ?? session.turns.length - 1));
    const turn = session.turns[index];
    // Same as the conversation pane: a failed turn keeps its partial text and gains the reason.
    const text = turn.error ? `${turn.response}${turn.response ? "\n\n" : ""}${turn.error}` : turn.response;
    return { turnId: turn.id, prompt: turn.prompt, text: stripToolLines(text) };
  }

  private postSelectedResponse(): void {
    if (this.managementPane !== "markdown") {
      return;
    }
    void this.managementPanel?.webview.postMessage({ type: "selectedResponse", payload: this.selectedResponse() });
  }

  // hideWindow is a plain Cap click: minimize this VS Code window for the length of the shot so the
  // picture shows what it was covering. It comes back by itself, and the extension host never goes
  // away. Ctrl-Cap is the opposite -- the window stays up and is in the picture.
  private async captureForSession(sessionId: string, hideWindow = false): Promise<void> {
    try {
      const file = await captureScreen(hideWindow);
      this.pendingCaptures.set(sessionId, file);
      this.lastCapture = file;
      // A new picture starts its own crop history; the old stack's files are not in it.
      this.cropStack.length = 0;
      if (this.managementPane === "cap") {
        void this.managementPanel?.webview.postMessage({ type: "captureChanged" });
      }
      // The first picture of the session turns the sidebar's Cap button on.
      this.refreshSidebar();
    } catch (error) {
      this.pendingCaptures.delete(sessionId);
      void vscode.window.showErrorMessage(`Screen capture failed: ${errorMessage(error)}`);
    }
    this.postCapState(sessionId);
  }

  private postCapState(sessionId: string): void {
    void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "capState", armed: this.pendingCaptures.has(sessionId) });
  }

  // The Login button re-runs the CLI's OAuth sign-in without a terminal. "claude auth login"
  // needs no TTY: it prints the sign-in URL on stdout and reads the one-time code on stdin, and
  // the browser redirect ends on an Anthropic-hosted page that shows the code (never localhost),
  // so the identical flow works on Windows, in WSL, and over Remote-SSH. Turns already running
  // are unaffected; each turn spawns a fresh CLI process that re-reads the credentials file.
  private async loginToAnthropic(): Promise<boolean> {
    if (this.loginInFlight) {
      void vscode.window.showWarningMessage("A Claude sign-in is already in progress.");
      return false;
    }
    this.loginInFlight = true;
    try {
      const account = await this.runLoginFlow();
      if (account !== null) {
        this.setAuthNeeded(false);
        void vscode.window.showInformationMessage(`Signed in to Claude as ${account}.`);
        return true;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Claude sign-in failed: ${errorMessage(error)}`);
    } finally {
      this.loginInFlight = false;
    }
    return false;
  }

  // A turn just died on expired OAuth: say so once and raise the red Re-Auth button, which
  // stays up until a sign-in succeeds. The notification carries no buttons because the button
  // in the sidebar is the durable version of the same offer.
  private noteAuthFailure(): void {
    if (this.authNeeded) {
      return;
    }
    this.setAuthNeeded(true);
    // showWarningMessage stays up until clicked away; a progress notification can close itself.
    // Ten seconds to be read, then gone — the red Re-Auth button is the durable signal.
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Authorization expired. Click Re-Auth in the Claude2 sidebar to sign in again." },
      () => new Promise<void>((resolve) => setTimeout(resolve, 10000)),
    );
  }

  private setAuthNeeded(value: boolean): void {
    if (this.authNeeded === value) {
      return;
    }
    this.authNeeded = value;
    void this.context.globalState.update(authNeededKey, value ? true : undefined);
    this.refreshSidebar();
  }

  public isAuthNeeded(): boolean {
    return this.authNeeded;
  }

  // What the sidebar's Close button works down: a session tab, or the management pane once
  // none are left. With neither up there is nothing to close and the button greys out.
  public hasOpenPanes(): boolean {
    return this.conversationPanels.size > 0 || this.managementPanel !== null;
  }

  // The Cap pane has no picture to show until a capture has been taken this session.
  public hasCapture(): boolean {
    return this.lastCapture !== null;
  }

  // The md pane shows the selected response, so an editor pane with no turn in it leaves
  // the sidebar's md button with nothing to open.
  public hasSelectedResponse(): boolean {
    return this.selectedResponse() !== null;
  }

  // Resolves to the signed-in account summary, or null when the user cancelled the code box.
  private async runLoginFlow(): Promise<string | null> {
    const child = spawn("claude", ["auth", "login"], { cwd: this.workspacePath(), env: cliEnv(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => undefined);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdoutText = "";
    let stderrText = "";
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    let exitCode: number | null | undefined;
    const exited = new Promise<void>((resolve) => {
      child.on("close", (code) => {
        exitCode = code;
        resolve();
      });
      child.on("error", () => resolve());
    });

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("The claude CLI did not print a sign-in URL within 30 seconds."));
      }, 30000);
      child.stdout.on("data", (chunk: string) => {
        stdoutText += chunk;
        const match = stdoutText.match(/https:\/\/\S+/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", () => {
        clearTimeout(timeout);
        reject(new Error(stderrText.trim() || "The claude CLI exited before printing a sign-in URL."));
      });
    });

    // The CLI tries to open a browser itself; over Remote-SSH only this openExternal reaches one.
    if (!(await vscode.env.openExternal(vscode.Uri.parse(url)))) {
      void vscode.window.showWarningMessage("No browser could be opened for the sign-in URL.", "Copy URL").then((pick) => {
        if (pick === "Copy URL") {
          void vscode.env.clipboard.writeText(url);
        }
      });
    }
    const code = await vscode.window.showInputBox({
      title: "Claude sign-in",
      prompt: "Approve in the browser, then paste the code it shows.",
      placeHolder: "authorization code",
      ignoreFocusOut: true,
    });
    if (!code?.trim()) {
      child.kill("SIGTERM");
      return null;
    }
    child.stdin.write(code.trim() + "\n");
    child.stdin.end();

    const timelyExit = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30000))]);
    if (!timelyExit) {
      child.kill("SIGTERM");
      throw new Error("The claude CLI did not finish within 30 seconds of the code being entered.");
    }
    if (exitCode !== 0) {
      throw new Error(stderrText.trim() || `claude auth login exited with code ${exitCode ?? "unknown"}.`);
    }
    return await this.signedInAccount();
  }

  private signedInAccount(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", ["auth", "status"], { cwd: this.workspacePath(), env: cliEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let stdoutText = "";
      let stderrText = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("claude auth status timed out."));
      }, 15000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutText += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderrText += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderrText.trim() || `claude auth status exited with code ${code ?? "unknown"}.`));
          return;
        }
        try {
          const status = JSON.parse(stdoutText) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
          if (status.loggedIn !== true) {
            reject(new Error("claude auth status still reports logged out."));
            return;
          }
          resolve(`${status.email ?? "unknown account"} (${status.subscriptionType ?? "unknown"} plan)`);
        } catch {
          reject(new Error(`claude auth status returned unexpected output: ${stdoutText.trim().slice(0, 120)}`));
        }
      });
    });
  }

  // Sending mid-run means "drop that answer and take this prompt instead": the running turn is
  // cut short exactly as Stop does, and the new prompt waits for its bookkeeping to land so the
  // stopped turn is fully recorded before this one is appended.
  private async submitPrompt(sessionId: string, prompt: string, model: string, effort: string): Promise<void> {
    if (!prompt.trim()) {
      return;
    }
    // The box emptied itself the moment Send was pressed, so every way out of this method short
    // of running the prompt has to put the text back somewhere it can be recovered from.
    if (!this.store.get(sessionId)) {
      this.noteDraft(sessionId, prompt);
      return;
    }
    // The saved draft goes now, not when the turn starts: stopping a run below makes that run
    // repost session state, and a draft still stored at that moment lands back in the empty box.
    if (this.drafts.delete(sessionId)) {
      this.saveDrafts();
    }
    const pending = this.runs.get(sessionId);
    if (pending || this.runner.isRunning(sessionId)) {
      // Ctrl-Enter during a run means "drop that answer, take this one instead".
      this.runner.stop(sessionId);
      if (pending) {
        await pending;
      }
    }
    if (this.runner.isRunning(sessionId)) {
      void vscode.window.showWarningMessage("Claude is already responding in this session.");
      this.noteDraft(sessionId, prompt);
      this.postConversationState(sessionId);
      return;
    }
    const run = this.runTurn(sessionId, prompt, model, effort).catch((error) => {
      this.channel.appendLine(`Claude turn failed: ${errorMessage(error)}`);
    });
    this.runs.set(sessionId, run);
    await run;
    if (this.runs.get(sessionId) === run) {
      this.runs.delete(sessionId);
    }
  }

  private async runTurn(sessionId: string, prompt: string, model: string, effort: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) {
      return;
    }
    const capturePath = this.pendingCaptures.get(sessionId);
    if (capturePath) {
      this.pendingCaptures.delete(sessionId);
      this.postCapState(sessionId);
      prompt = `${prompt}\n\n[A screenshot of the user's desktop is attached. Read the image file ${capturePath} to view it.]`;
    }
    const defaults = this.conversationDefaults(sessionId);
    const selectedModel = model || defaults.model;
    const selectedEffort = effort || defaults.effort;
    // Belt and braces with the picker's own change event: whatever a prompt actually ran
    // with is what the session reopens on.
    await this.store.setPicks(sessionId, selectedModel, selectedEffort);
    const wasFirstPrompt = session.turns.length === 0;
    // Where the conversation already sits in the window. A turn that errored never recorded a
    // level, so the newest turn that did is the one to carry forward.
    const priorContext = session.turns.reduce((level, prior) => prior.contextUsed || level, 0);
    // The text is on its way to the CLI, so the saved draft goes now: what is stored has to
    // match what the box shows, and the box cleared itself when Send was pressed.
    if (this.drafts.delete(sessionId)) {
      this.saveDrafts();
    }
    const turn: ClaudeTurn = {
      id: randomUUID(),
      prompt,
      response: "",
      createdAt: Date.now(),
      completedAt: null,
      model: selectedModel,
      effort: selectedEffort,
      tokensIn: 0,
      tokensOut: 0,
      contextWindow: defaults.contextWindow,
      contextUsed: priorContext,
      finished: false,
      stopped: false,
      error: null,
      costUsd: null,
      stopReason: null,
      turns: 0,
      maxTurns: this.runLimits().maxTurns,
      durationMs: 0,
      ponySkips: [],
    };
    await this.store.appendTurn(sessionId, turn);
    // Counted at the start so a stopped or crashed run still counts; the money and time land
    // in a second bump when the run settles.
    void this.stats.add({ sessions: wasFirstPrompt ? 1 : 0, turns: 1 });
    this.postConversationState(sessionId);
    // The first turn gives the sidebar's md button something to show.
    this.refreshSidebar();
    if (wasFirstPrompt) {
      void this.nameSessionFromPrompt(sessionId, prompt, selectedModel);
    }

    let streamedResponse = "";
    // Streaming is throttled: deltas collect for one short window and go out as a single small
    // turnDelta message, instead of a full-session post per token. The full post per token is
    // what made long responses render slower and slower as they grew.
    let pendingDelta = "";
    let streamDirty = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastContext = priorContext;
    let lastPonySkips: PonySkip[] = [];
    let lastTurns = 0;
    const flushStream = (): void => {
      flushTimer = null;
      if (!streamDirty) {
        return;
      }
      streamDirty = false;
      const delta = pendingDelta;
      pendingDelta = "";
      this.postTurnDelta(sessionId, turn.id, delta);
    };
    const queueStream = (): void => {
      streamDirty = true;
      if (flushTimer === null) {
        flushTimer = setTimeout(flushStream, 80);
      }
    };
    const plugins = await this.stats.flags();
    try {
      const result = await this.runner.runPrompt({
        sessionId,
        turnId: turn.id,
        prompt,
        model: selectedModel,
        effort: selectedEffort,
        contextWindow: defaults.contextWindow,
        workspacePath: this.workspacePath(),
        hasPriorTurns: !wasFirstPrompt,
        priorContextTokens: priorContext,
        limits: this.runLimits(),
        plugins,
        onText: (text) => {
          streamedResponse += text;
          this.store.patchTurn(sessionId, turn.id, { response: streamedResponse }, false);
          pendingDelta += text;
          queueStream();
        },
        onStatus: (status) => {
          lastContext = status.contextTokens || lastContext;
          lastPonySkips = status.ponySkips.length ? status.ponySkips : lastPonySkips;
          lastTurns = status.turns || lastTurns;
          queueStream();
        },
      });
      this.store.patchTurn(sessionId, turn.id, {
        response: streamedResponse || result.text,
        completedAt: Date.now(),
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        contextUsed: result.contextTokens,
        finished: true,
        stopped: result.stopped,
        costUsd: result.costUsd,
        stopReason: result.stopReason,
        turns: result.turns,
        durationMs: result.durationMs,
        ponySkips: result.ponySkips,
      }, true);
      await this.store.flush();
      void this.noteTurnStats(sessionId, {
        wallMs: result.durationMs,
        costUsd: result.costUsd ?? 0,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        ponySkips: result.ponySkips.length,
      }, {
        plugins,
        turnId: turn.id,
        model: selectedModel,
        effort: selectedEffort,
        contextWindow: defaults.contextWindow,
        contextTokens: result.contextTokens,
        cliTurns: result.turns,
        stopped: result.stopped,
        stopReason: result.stopReason,
        skips: result.ponySkips,
      });
    } catch (error) {
      const text = errorMessage(error);
      if (/failed to authenticate|oauth session expired/i.test(text)) {
        // An auth-failed turn is noise: drop it and put the prompt back in the box, so the
        // conversation reads as if it was never sent. The Re-Auth flow owns the messaging,
        // and the finally below reposts the restored state, draft included.
        await this.store.removeTurn(sessionId, turn.id);
        this.noteDraft(sessionId, prompt);
        this.noteAuthFailure();
      } else {
        this.store.patchTurn(sessionId, turn.id, {
          error: text,
          completedAt: Date.now(),
          contextUsed: lastContext,
          durationMs: Math.max(0, Date.now() - turn.createdAt),
          ponySkips: lastPonySkips,
          turns: lastTurns,
          finished: true,
          stopped: false,
        }, true);
        await this.store.flush();
        void this.noteTurnStats(sessionId, {
          wallMs: Math.max(0, Date.now() - turn.createdAt),
          ponySkips: lastPonySkips.length,
        }, {
          plugins,
          turnId: turn.id,
          model: selectedModel,
          effort: selectedEffort,
          contextWindow: defaults.contextWindow,
          contextTokens: lastContext,
          cliTurns: lastTurns,
          error: text.slice(0, 500),
          skips: lastPonySkips,
        });
      }
    } finally {
      // A delta still in flight after the closing full post would re-append text the
      // webview already has, so the throttle is drained before that post goes out.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      streamDirty = false;
      pendingDelta = "";
      this.postConversationState(sessionId);
      this.refreshSidebar();
      void this.quota.history(false);
    }
  }

  private async nameSessionFromPrompt(sessionId: string, prompt: string, model: string): Promise<void> {
    try {
      const title = await this.runner.generateTitle(prompt, model, this.workspacePath());
      const session = this.store.get(sessionId);
      if (session && this.ownsName(session)) {
        this.draftNames.delete(sessionId);
        await this.store.rename(sessionId, title);
        this.postConversationState(sessionId);
        this.refreshSidebar();
      }
    } catch (error) {
      this.channel.appendLine(`Claude session naming failed: ${errorMessage(error)}`);
    }
  }

  // Stored verbatim — only whether it is blank is judged on the trimmed text — so a restored
  // draft comes back exactly as it was typed.
  private noteDraft(sessionId: string, draft: string): void {
    if (draft.trim()) {
      // A message still in flight from the panel of a session deleted on purpose: the text was
      // discarded with it, so it is not typing that has lost its home.
      if (this.discarded.has(sessionId)) {
        return;
      }
      this.drafts.set(sessionId, draft);
      // Typing that lands after its session was swept away has nowhere to go back to, so it
      // gets a session of its own rather than sitting in the store unreachable.
      if (!this.store.get(sessionId)) {
        void this.rescueDraft(sessionId);
        return;
      }
    } else if (!this.drafts.delete(sessionId)) {
      return;
    }
    this.saveDrafts();
  }

  // A draft the user typed but never sent still deserves a name, so the sidebar card is
  // recognisable. Short drafts are named from their own first words; longer ones are worth
  // a real title from the CLI.
  private async nameSessionFromDraft(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || session.turns.length > 0 || !this.ownsName(session)) {
      return;
    }
    const draft = (this.drafts.get(sessionId) ?? "").replace(/\s+/g, " ").trim();
    if (!draft) {
      // The draft was cleared: hand the name back to the placeholder so the session can be discarded.
      if (this.draftNames.delete(sessionId) && session.name !== "New session") {
        await this.store.rename(sessionId, "New session");
        this.postConversationState(sessionId);
      }
      return;
    }
    if (this.draftNames.get(sessionId) === draft) {
      return;
    }
    this.draftNames.set(sessionId, draft);
    let name = firstWords(draft);
    if (draft.split(" ").length >= 6) {
      try {
        name = await this.runner.generateTitle(draft, this.conversationDefaults().model, this.workspacePath());
      } catch (error) {
        this.channel.appendLine(`Claude draft naming failed: ${errorMessage(error)}`);
      }
    }
    const current = this.store.get(sessionId);
    if (!current || current.turns.length > 0 || this.draftNames.get(sessionId) !== draft) {
      return;
    }
    await this.store.rename(sessionId, name);
    this.postConversationState(sessionId);
    this.refreshSidebar();
  }

  // Auto-naming may only overwrite the placeholder or a name it produced itself from a draft.
  private ownsName(session: ClaudeSession): boolean {
    return session.name === "New session" || this.draftNames.has(session.id);
  }

  private async openManagement(pane: ManagementPane): Promise<void> {
    if (!(await this.ensureEnabled()) || !(await this.mayLeaveManagement())) {
      return;
    }
    // The button that opened the pane showing up front closes it again: back to the conversation.
    if (this.managementPanel?.visible && this.managementPane === pane && this.revealConversation()) {
      return;
    }
    if (!this.managementPanel) {
      this.managementPanel = vscode.window.createWebviewPanel("claude2.management", "Claude2", vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      this.managementPanel.webview.onDidReceiveMessage((message) => void this.handleManagementMessage(message));
      this.managementPanel.onDidDispose(() => {
        this.managementPanel = null;
        this.managementPane = null;
        for (const resolver of this.leaveResolvers.values()) {
          resolver(false);
        }
        this.leaveResolvers.clear();
        // Closing the last pane leaves the sidebar's Close button with nothing to do.
        this.refreshSidebar();
      });
    }
    this.managementPane = pane;
    this.managementPanel.title = pane === "instructions" ? "Claude2 Instructions" : pane === "quota" ? "Claude2 Quota" : pane === "markdown" ? "Claude2 Markdown" : pane === "cap" ? "Claude2 Capture" : "Claude2 Plugins";
    this.managementPanel.webview.html = managementHtml(this.managementPanel.webview, pane, this.timezone(), this.zoomOf("management"));
    this.managementPanel.reveal(vscode.ViewColumn.One);
    this.refreshSidebar();
  }

  // A settled turn's numbers, folded into the shared record along with what graft banked for
  // the session meanwhile and a fresh reading of the workspace's ceiling comments. The turn
  // and its cost are also credited to the on or off side of each plugin, per the flags the
  // run actually carried, and the whole turn ships as one raw event to the server's log —
  // the extensive record future stats get computed from.
  private async noteTurnStats(sessionId: string, delta: StatsDelta, info: { plugins: PluginFlags } & Record<string, unknown>): Promise<void> {
    const graft = await this.stats.graftDelta(sessionId);
    const ceilings = await this.ponyCeilingCount();
    const split: StatsDelta = {};
    split[info.plugins.ponytail ? "turnsPonyOn" : "turnsPonyOff"] = 1;
    split[info.plugins.ponytail ? "costPonyOn" : "costPonyOff"] = delta.costUsd ?? 0;
    split[info.plugins.graft ? "turnsGraftOn" : "turnsGraftOff"] = 1;
    split[info.plugins.graft ? "costGraftOn" : "costGraftOff"] = delta.costUsd ?? 0;
    await this.stats.add({ ...delta, ...graft, ...split }, ceilings);
    void this.stats.logTurn({ sessionId, ...info, ...delta, ...graft, ponyCeilings: ceilings });
  }

  // The Plugins pane's table, rebuilt on every load: every install's record off the stats
  // server folded into one column per project. The local record rides over its own pushed
  // copy — it is never behind, and it carries a just-taken ceilings count.
  private async pluginsReport(): Promise<PluginsReport> {
    const remote = await this.stats.fetchAll();
    const installs: Record<string, Partial<InstallStats>> = { ...(remote?.installs ?? {}) };
    const local = this.stats.local();
    local.ponyCeilings = await this.ponyCeilingCount();
    installs[this.stats.installKey()] = local;
    const counterFields = ["sessions", "turns", "wallMs", "costUsd", "tokensIn", "tokensOut", "ponySkips", "graftCalls", "graftTokensSaved", "graftUsdSaved",
      "turnsPonyOn", "turnsPonyOff", "costPonyOn", "costPonyOff", "turnsGraftOn", "turnsGraftOff", "costGraftOn", "costGraftOff"] as const;
    const projects = new Map<string, ProjectColumn>();
    for (const record of Object.values(installs)) {
      const name = typeof record.project === "string" ? record.project : "";
      if (!name) {
        continue;
      }
      const flags = remote?.flags?.[name] ?? {};
      const column = projects.get(name) ?? {
        project: name,
        hosts: "",
        paths: "",
        sessions: 0,
        turns: 0,
        wallMs: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        ponySkips: 0,
        ponyCeilings: 0,
        graftCalls: 0,
        graftTokensSaved: 0,
        graftUsdSaved: 0,
        turnsPonyOn: 0,
        turnsPonyOff: 0,
        costPonyOn: 0,
        costPonyOff: 0,
        turnsGraftOn: 0,
        turnsGraftOff: 0,
        costGraftOn: 0,
        costGraftOff: 0,
        graft: flags.graft !== false,
        ponytail: flags.ponytail !== false,
      };
      for (const field of counterFields) {
        column[field] += Number(record[field]) || 0;
      }
      // the same repo checked out on two hosts keeps its bigger reading, not the sum
      column.ponyCeilings = Math.max(column.ponyCeilings, Number(record.ponyCeilings) || 0);
      const host = typeof record.host === "string" ? record.host : "";
      column.hosts = column.hosts.includes(host) ? column.hosts : [column.hosts, host].filter(Boolean).join(" ");
      const recordPath = typeof record.path === "string" ? record.path : "";
      column.paths = column.paths.includes(recordPath) ? column.paths : [column.paths, recordPath].filter(Boolean).join("\n");
      projects.set(name, column);
    }
    return { projects: [...projects.values()].sort((left, right) => left.project.localeCompare(right.project)), offline: remote === null };
  }

  // Ponytail marks a deliberate corner cut in code with a "ponytail:" comment naming the ceiling
  // and the upgrade path. grep exits 1 for "no matches", so any failure just reads as none found.
  private ponyCeilingCount(): Promise<number> {
    return new Promise((resolve) => {
      const pattern = "(//|#|;|<!--|/\\*)[[:space:]]*ponytail:";
      const args = ["-rnIE", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=out", "--exclude-dir=dist", pattern, "."];
      const child = spawn("grep", args, { cwd: this.workspacePath(), stdio: ["ignore", "pipe", "ignore"] });
      let outputText = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputText += chunk;
      });
      child.on("error", () => resolve(0));
      child.on("close", () => resolve(outputText.split("\n").filter((line) => line.trim()).length));
    });
  }

  // The Instructions pane saves as you type, like a VS Code editor with auto save. When the file
  // changes on disk the pane is told, and reloads unless it holds text not yet written.
  private watchInstructions(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    this.instructionsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "CLAUDE.md"));
    const notify = (): void => {
      if (this.managementPanel && this.managementPane === "instructions") {
        void this.managementPanel.webview.postMessage({ type: "instructionsChanged" });
      }
    };
    // The pane's own save mirrors as it writes; this covers every other way CLAUDE.md moves —
    // another editor, a git checkout, a Claude edit — so the copies never drift from the authority.
    const mirror = (): void => {
      void this.instructions.syncMirrors().then((error) => {
        if (error) {
          this.channel.appendLine(`Instructions mirror failed: ${error}`);
        }
      });
    };
    this.instructionsWatcher.onDidChange(() => {
      notify();
      mirror();
    });
    this.instructionsWatcher.onDidCreate(() => {
      notify();
      mirror();
    });
    this.instructionsWatcher.onDidDelete(notify);
    mirror(); // CLAUDE.md may have moved while the extension was not running.
  }

  private async mayLeaveManagement(): Promise<boolean> {
    if (!this.managementPanel || this.managementPane !== "instructions") {
      return true;
    }
    const requestId = randomUUID();
    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.leaveResolvers.delete(requestId);
        resolve(false);
      }, 60000);
      this.leaveResolvers.set(requestId, (go) => {
        clearTimeout(timeout);
        this.leaveResolvers.delete(requestId);
        resolve(go);
      });
      void this.managementPanel?.webview.postMessage({ type: "requestLeave", requestId }).then((sent) => {
        if (!sent) {
          clearTimeout(timeout);
          this.leaveResolvers.delete(requestId);
          resolve(false);
        }
      });
    });
  }

  private async handleManagementMessage(message: unknown): Promise<void> {
    const record = recordOf(message);
    const type = stringOf(record?.type);
    const requestId = stringOf(record?.requestId);
    if (type === "zoom") {
      await this.noteZoom("management", record?.zoom);
      return;
    }
    if (type === "leaveResponse") {
      this.leaveResolvers.get(requestId)?.(record?.go === true);
      return;
    }
    if (type === "closeManagement") {
      this.managementPanel?.dispose();
      return;
    }
    if (type === "sendCaptureAgain") {
      this.sendCaptureAgain();
      return;
    }
    if (type === "loadInstructions") {
      await this.reply(requestId, async () => await this.instructions.read());
    } else if (type === "saveInstructions") {
      await this.reply(requestId, async () => await this.instructions.write(stringOf(record?.text), stringOrNull(record?.version)));
    } else if (type === "loadQuotaHistory") {
      await this.reply(requestId, async () => await this.quota.history(false));
    } else if (type === "forceQuotaHistory") {
      await this.reply(requestId, async () => await this.quota.history(true));
    } else if (type === "loadSelectedResponse") {
      await this.reply(requestId, async () => this.selectedResponse());
    } else if (type === "loadPluginsReport") {
      await this.reply(requestId, async () => await this.pluginsReport());
    } else if (type === "setPluginFlag") {
      await this.reply(requestId, async () => await this.stats.setFlag(stringOf(record?.project), stringOf(record?.plugin), record?.enabled === true));
    } else if (type === "loadCapture") {
      await this.reply(requestId, async () => await this.captureView());
    } else if (type === "cropCapture") {
      await this.reply(requestId, async () => await this.cropCapture(stringOf(record?.dataUri)));
    } else if (type === "undoCrop") {
      await this.reply(requestId, async () => await this.undoCrop());
    }
  }

  // The Cap pane's image, as a data URI: the PNG sits in a temp dir outside any root the
  // webview may load file URIs from, and this also works when it was taken on another machine.
  // depth is how many crops deep the picture is, so the pane knows whether a click can undo one.
  private async captureView(): Promise<CaptureView> {
    if (!this.lastCapture) {
      return { path: null, dataUri: null, depth: 0, armed: false };
    }
    const bytes = await fs.readFile(this.lastCapture);
    return {
      path: this.lastCapture,
      dataUri: `data:image/png;base64,${bytes.toString("base64")}`,
      depth: this.cropStack.length,
      armed: this.pendingCaptures.get(this.capTargetId()) === this.lastCapture,
    };
  }

  // The conversation the Cap pane steps back to, and so the one its picture arms.
  private capTargetId(): string {
    return this.conversationPanels.has(this.lastConversationId)
      ? this.lastConversationId
      : [...this.conversationPanels.keys()].pop() ?? "";
  }

  // "Send Again": the picture already went out with a prompt, which left its Cap button off.
  // Arming it again and stepping back to the conversation puts the cursor where the next
  // prompt is typed, and that one carries the same picture -- crops and all.
  private sendCaptureAgain(): void {
    const sessionId = this.capTargetId();
    if (!this.lastCapture || !sessionId) {
      return;
    }
    this.pendingCaptures.set(sessionId, this.lastCapture);
    this.postCapState(sessionId);
    this.managementPanel?.dispose();
    this.revealConversation();
    void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "focusPrompt" });
  }

  // A drag in the Cap pane. The webview cut the rectangle out on a canvas, so all that is left is
  // to land the PNG beside the picture it came from -- same temp dir, so the CLI reads it exactly
  // the way it reads a capture -- and remember what it replaced.
  private async cropCapture(dataUri: string): Promise<CaptureView> {
    const base64 = dataUri.startsWith(PNG_DATA_URI) ? dataUri.slice(PNG_DATA_URI.length) : "";
    if (!this.lastCapture || !base64) {
      return await this.captureView();
    }
    const file = path.join(path.dirname(this.lastCapture), `claude2-crop-${Date.now()}.png`);
    await fs.writeFile(file, Buffer.from(base64, "base64"));
    this.cropStack.push(this.lastCapture);
    this.showCapture(file);
    return await this.captureView();
  }

  private async undoCrop(): Promise<CaptureView> {
    const previous = this.cropStack.pop();
    if (previous) {
      this.showCapture(previous);
    }
    return await this.captureView();
  }

  // The picture on top takes the old one's place everywhere: the pane shows it, and a session
  // holding the old one armed now sends this one with its next prompt.
  private showCapture(file: string): void {
    const previous = this.lastCapture;
    this.lastCapture = file;
    for (const [sessionId, armed] of this.pendingCaptures) {
      if (armed === previous) {
        this.pendingCaptures.set(sessionId, file);
      }
    }
  }

  private async reply(requestId: string, work: () => Promise<unknown>): Promise<void> {
    if (!requestId || !this.managementPanel) {
      return;
    }
    try {
      const payload = await work();
      void this.managementPanel.webview.postMessage({ type: "reply", requestId, ok: true, payload });
    } catch (error) {
      void this.managementPanel.webview.postMessage({ type: "reply", requestId, ok: false, error: errorMessage(error) });
    }
  }

  private setSearch(text: string): void {
    if (text === this.searchText) {
      return;
    }
    this.searchText = text;
    for (const panel of this.conversationPanels.values()) {
      void panel.webview.postMessage({ type: "searchState", text });
    }
  }

  private postConversationState(sessionId: string): void {
    const session = this.store.get(sessionId);
    const panel = this.conversationPanels.get(sessionId);
    if (!session || !panel) {
      return;
    }
    panel.title = session.name;
    void panel.webview.postMessage({ type: "sessionState", session, status: this.runner.status(sessionId), draft: this.drafts.get(sessionId) ?? "", search: this.searchText, boxScrolls: this.boxScrolls.get(sessionId) ?? {} });
    if (sessionId === this.lastConversationId) {
      this.postSelectedResponse();
    }
    this.refreshSidebar();
  }

  // Streaming update: only the new text and the run status cross to the webview, and the
  // sidebar (whose cards show nothing live) is left alone until the run ends. The md pane
  // rides the same throttle so it renders the response as markdown while it grows.
  private postTurnDelta(sessionId: string, turnId: string, delta: string): void {
    void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "turnDelta", turnId, delta, status: this.runner.status(sessionId) });
    if (sessionId === this.lastConversationId) {
      this.postSelectedResponse();
    }
  }

  private refreshSidebar(): void {
    this.sidebarProvider?.refresh();
  }

  // Ctrl-wheel / Ctrl-+ zoom is kept here rather than in webview state: nothing serializes these
  // panels, so a window reload builds a fresh webview whose own state is empty. Conversation and
  // management panes start from different font sizes, so each remembers its own factor.
  private zoomOf(kind: "conversation" | "management"): number {
    return zoomFactor(this.context.globalState.get<number>(`zoom.${kind}`, 1));
  }

  private async noteZoom(kind: "conversation" | "management", value: unknown): Promise<void> {
    await this.context.globalState.update(`zoom.${kind}`, zoomFactor(value));
  }

  // A session that has picked a model/effort keeps it across reopens; the configured
  // default only fills in for a session that never picked.
  private conversationDefaults(sessionId = ""): ConversationDefaults {
    const config = vscode.workspace.getConfiguration("claude2");
    const session = sessionId ? this.store.get(sessionId) : undefined;
    return {
      model: session?.model || config.get<string>("model", DEFAULT_MODEL),
      effort: session?.effort || config.get<string>("effort", DEFAULT_EFFORT),
      contextWindow: config.get<number>("contextWindowTokens", CLAUDE2_CONTEXT_WINDOW),
      maxTurns: config.get<number>("maxTurns", 50),
    };
  }

  private runLimits(): RunLimits {
    const config = vscode.workspace.getConfiguration("claude2");
    return {
      maxTurns: config.get<number>("maxTurns", 50),
      maxBudgetUsd: config.get<number>("maxBudgetUsd", 0),
      permissionMode: config.get<string>("permissionMode", "auto"),
    };
  }

  private timezone(): string {
    return vscode.workspace.getConfiguration("claude2").get<string>("timezone", "America/Los_Angeles");
  }

  private workspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private async ensureEnabled(): Promise<boolean> {
    const enabled = vscode.workspace.getConfiguration("claude2").get<boolean>("enabled", true);
    if (!enabled) {
      await vscode.window.showWarningMessage("Claude2 is disabled in settings.");
    }
    return enabled;
  }
}

class ClaudeSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly controller: Claude2Controller) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = sidebarHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => void this.controller.handleSidebarMessage(message), undefined, this.context.subscriptions);
    this.refresh();
  }

  public refresh(): void {
    void this.view?.webview.postMessage({
      type: "sessions",
      sessions: this.controller.sessions(),
      selectedId: this.controller.selectedSessionId(),
      authNeeded: this.controller.isAuthNeeded(),
      panesOpen: this.controller.hasOpenPanes(),
      hasCapture: this.controller.hasCapture(),
      hasResponse: this.controller.hasSelectedResponse(),
    });
  }
}

// Drops the runner's marked tool lines and the tally line graft (since removed) left in old
// stored responses, keeping the blank-line
// shape the conversation pane produces when tool groups are hidden.
function stripToolLines(text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(TOOL_LINE_MARK) || line.startsWith(GRAFT_TALLY_MARK)) {
      continue;
    }
    if (!line.trim() && (!kept.length || !kept[kept.length - 1].trim())) {
      continue;
    }
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) {
    kept.pop();
  }
  return kept.join("\n");
}

function paneOf(value: unknown): ManagementPane | null {
  return value === "instructions" || value === "quota" || value === "plugins" || value === "markdown" || value === "cap" ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Fallback name for a draft too short to be worth a generated title.
function firstWords(text: string): string {
  const words = text.split(" ").filter(Boolean).slice(0, 5).join(" ").replace(/[.,;:!?]+$/, "");
  return (words.length > 42 ? `${words.slice(0, 42).trimEnd()}…` : words) || "New session";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const authNeededKey = "authNeeded";
// Unsent prompt text, kept per workspace alongside the sessions it belongs to.
const draftsKey = "drafts";
// Retired: an older build parked one draft here when its session went away. Cleared on load.
const promptTextLostKey = "promptTextLost";

// A stray key would send the CLI to API-key auth instead of the subscription OAuth flow.
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
