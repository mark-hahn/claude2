import * as vscode from "vscode";
import { spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { captureScreen } from "./capture";
import { ClaudeCliRunner, copySessionTranscript, truncateSessionTranscript, type RunLimits } from "./claudeCli";
import { InstructionsFile } from "./instructionsFile";
import { PluginStats, type StatsDelta } from "./pluginStats";
import { QuotaService } from "./quota";
import { SessionStore } from "./sessionStore";
import { CLAUDE2_CONTEXT_WINDOW, DEFAULT_EFFORT, DEFAULT_MODEL, MODEL_OPTIONS, type ClaudeSession, type ClaudeTurn, type InstallStats, type PluginFlags, type PonySkip, type PromptImage } from "./types";
import { conversationHtml, managementHtml, sidebarHtml, zoomFactor, type ConversationDefaults, type ManagementPane } from "./webviews";

let output: vscode.OutputChannel | undefined;
let controller: Claude2Controller | undefined;

// What the Image pane is shown: the picture, where it lives, how many crops it is deep, whether
// it may still be cropped at all (a submitted prompt's pictures are read-only), and the line
// naming it -- there is no other way to tell one identical 🖼️ char from the next.
type ImageView = { path: string | null; dataUri: string | null; depth: number; editable: boolean; label: string };

// One picture waiting on a session's next prompt. `hash` is what a second copy of the same
// picture is recognised by, from any source; `stack` is this picture's crop history, oldest
// first, so a click in the pane pops one crop back.
type PendingImage = { kind: "cap" | "paste"; path: string; hash: string; stack: string[] };

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
  // Each box's scroll position per session, keyed by turn id ('bottom' pins to the end).
  // Deliberately not persisted to disk: the memory outlives any one webview but resets
  // when the extension reloads.
  private readonly boxScrolls = new Map<string, Record<string, unknown>>();
  // Pictures waiting on each session's next prompt, in the order their 🖼️ chars read. Every
  // Cap click and every image pasted into the prompt box adds one; submitting takes the lot.
  private readonly pendingImages = new Map<string, PendingImage[]>();
  // Files attached to each session's next prompt, keyed by the <name> tag standing for them in the
  // prompt box. Unlike pictures these are never copied or persisted: the file stays where it is and
  // the CLI reads it from the path, so nothing survives a window reload but the tag in the draft.
  private readonly pendingFiles = new Map<string, { name: string; path: string }[]>();
  // Which picture the Image pane is showing: an entry of `pendingImages` when turnId is null,
  // otherwise one already submitted with that turn -- those are shown but never edited.
  private paneImage: { sessionId: string; turnId: string | null; index: number } | null = null;
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
  // Last reading of the workspace's ponytail ceiling comments, retaken after every turn.
  private ceilings = 0;
  private instructionsWatcher: vscode.FileSystemWatcher | null = null;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly channel: vscode.OutputChannel) {
    this.store = new SessionStore(context);
    this.runner = new ClaudeCliRunner((line) => this.channel.appendLine(line));
    this.quota = new QuotaService(context, this.workspacePath(), (line) => this.channel.appendLine(line), () => this.postAllConversationStates());
    this.stats = new PluginStats(context, this.workspacePath(), (line) => this.channel.appendLine(line));
    void this.stats.seed(this.store.all());
    // turn events queued while the stats server was unreachable drain on activation
    void this.stats.flushTurns();
    this.authNeeded = context.globalState.get<boolean>(authNeededKey, false);
    // The footer's ponytail stat needs a ceiling count before the window's first turn takes one.
    void this.ponyCeilingCount().then((count) => { this.ceilings = count; });
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
    } else if (type === "forkActive") {
      // The pane holds the selection, so it decides which block the fork cuts at.
      void this.conversationPanels.get(requestedSessionId)?.webview.postMessage({ type: "forkSelected" });
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
    void this.refreshModels();
  }

  // Runs behind the new session so the + click never waits on npm; open panels get the list
  // when it lands. Silent unless the CLI fails.
  private async refreshModels(): Promise<void> {
    try {
      const models = await this.runner.refreshModels(this.workspacePath());
      MODEL_OPTIONS.splice(0, MODEL_OPTIONS.length, ...models);
      for (const panel of this.conversationPanels.values()) {
        void panel.webview.postMessage({ type: "models", models });
      }
    } catch (error) {
      void vscode.window.showWarningMessage(`Claude2: CLI update/model check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Forget every session with nothing in it -- no turn, no unsent draft, no waiting picture --
  // except `exceptId`. A picture counts the same as typed text: it is content waiting to be sent.
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
          !this.pendingImages.has(session.id),
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
    // The pictures of every prompt in it go too: permanent deletion is what they were kept until.
    await this.dropImages(sessionId);
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
      this.postImages(sessionId);
      if (this.pendingPromptFocus.delete(sessionId)) {
        void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "focusPrompt" });
      }
    } else if (type === "captureScreen") {
      await this.captureForSession(sessionId, record?.hideWindow === true);
    } else if (type === "pasteImage") {
      await this.pasteImage(sessionId, stringOf(record?.dataUri));
    } else if (type === "showImage") {
      await this.showImage(sessionId, stringOf(record?.turnId) || null, numberOf(record?.index));
    } else if (type === "pickFile") {
      await this.pickFile(sessionId);
    } else if (type === "deleteImage") {
      await this.deleteImage(sessionId, numberOf(record?.index));
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
    } else if (type === "clearQuotaAlert") {
      this.quota.clearAlert();
      this.postAllConversationStates();
    } else if (type === "copyText") {
      await this.copyToClipboard(stringOf(record?.text));
    } else if (type === "forkTurn") {
      await this.forkTurn(sessionId, stringOf(record?.turnId));
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
    if (!session || index < 0) {
      return;
    }
    if (this.runner.isRunning(sessionId)) {
      void vscode.window.showWarningMessage("Claude is still responding in this session; stop it before forking.");
      return;
    }
    // Forking the last block drops nothing, so it is only the copy half: two identical sessions.
    const count = session.turns.length - index - 1;
    const answer = await vscode.window.showWarningMessage(
      count === 0 ? "Copy this session?" : `Fork the conversation here, dropping the ${count} run${count === 1 ? "" : "s"} after this one?`,
      {
        modal: true,
        detail:
          count === 0
            ? "The copy is a session of its own, holding the whole conversation."
            : "Claude forgets them too. The whole conversation is kept as a new session beside this one.",
      },
      count === 0 ? "Copy" : "Fork",
    );
    if (answer !== "Fork" && answer !== "Copy") {
      return;
    }
    // The copy comes first: it has to be taken while the source still has every run.
    const copy = await this.store.clone(sessionId);
    if (copy && !copySessionTranscript(this.workspacePath(), sessionId, copy.id)) {
      this.channel.appendLine(`Fork: no CLI transcript copied for session ${copy.id}; the clone starts without Claude's context.`);
    }
    if (count === 0) {
      this.refreshSidebar();
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
    this.postConversationState(sessionId);
    this.refreshSidebar();
  }

  private async copyToClipboard(text: string): Promise<void> {
    if (!text) {
      return;
    }
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage("Copied to clipboard", 1500);
  }

  // hideWindow is a plain Cap click: minimize this VS Code window for the length of the shot so the
  // picture shows what it was covering. It comes back by itself, and the extension host never goes
  // away. Ctrl-Cap is the opposite -- the window stays up and is in the picture. Every click takes
  // another picture; the ones already waiting stay where they are.
  private async captureForSession(sessionId: string, hideWindow = false): Promise<void> {
    try {
      await this.addImage(sessionId, "cap", await captureScreen(hideWindow));
    } catch (error) {
      void vscode.window.showErrorMessage(`Screen capture failed: ${errorMessage(error)}`);
      // The Cap button greys itself out for the length of the shot and comes back on this.
      this.postImages(sessionId);
    }
  }

  // An image pasted into the prompt box. It arrives as a data URI because the clipboard picture
  // never was a file; it is landed in the same temp dir a capture uses, so everything downstream
  // -- crop, copy on submit, the path the CLI reads -- treats the two the same.
  private async pasteImage(sessionId: string, dataUri: string): Promise<void> {
    const parsed = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.exec(dataUri);
    if (!parsed) {
      return;
    }
    const extension = parsed[1] === "jpeg" ? "jpg" : parsed[1];
    const file = path.join(os.tmpdir(), `claude2-paste-${Date.now()}.${extension}`);
    try {
      await fs.writeFile(file, Buffer.from(dataUri.slice(parsed[0].length), "base64"));
      await this.addImage(sessionId, "paste", file);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not read the pasted image: ${errorMessage(error)}`);
      this.postImages(sessionId);
    }
  }

  // The File button's picker: the workspace's own files in a quick pick, with one entry that falls
  // through to the file dialog for anything outside it. Both list whatever filesystem the extension
  // host runs on -- the WSL or SSH side -- which is the side the CLI reads the path from too.
  private async pickFile(sessionId: string): Promise<void> {
    const browse = "Browse…";
    const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git}/**", 5000);
    const paths = new Map(uris.map((uri) => [vscode.workspace.asRelativePath(uri, false), uri.fsPath]));
    const picked = await vscode.window.showQuickPick([browse, ...[...paths.keys()].sort()], {
      placeHolder: "File to attach to the prompt",
    });
    if (!picked) {
      return;
    }
    let file = paths.get(picked);
    if (picked === browse) {
      // Deliberately not a recursive listing of anywhere outside the workspace: over WSL a glob
      // across /mnt/c crawls, so the dialog browses a directory at a time instead.
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Attach" });
      file = chosen?.[0]?.fsPath;
    }
    if (!file) {
      return;
    }
    // A picture picked here is a picture, not a file reference: it goes the way a pasted one does,
    // so it gets a 🖼️ char, the Image pane, and a place in the turn's record. The tag route would
    // reach the model just the same, and leave none of that behind.
    if (IMAGE_FILES.test(file)) {
      await this.addImage(sessionId, "paste", file);
      return;
    }
    const files = this.pendingFiles.get(sessionId) ?? [];
    const base = path.basename(file, path.extname(file));
    let name = base;
    // Two files can share a base name, and a tag has to name exactly one path, so the second
    // one attached under a name already spoken for gets counted instead.
    for (let n = 2; files.some((entry) => entry.name === name && entry.path !== file); n += 1) {
      name = `${base} ${n}`;
    }
    if (!files.some((entry) => entry.name === name)) {
      files.push({ name, path: file });
      this.pendingFiles.set(sessionId, files);
    }
    void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "insertFile", name });
  }

  // A picture from either source joins the end of the session's list and is shown at once. The
  // same picture arriving twice -- a Cap of an unchanged screen, a second paste of one clipboard
  // -- is not added again; the pane shows the copy already in the list, so the click still lands
  // somewhere rather than looking like it did nothing.
  private async addImage(sessionId: string, kind: "cap" | "paste", file: string): Promise<void> {
    const hash = createHash("sha1").update(await fs.readFile(file)).digest("hex");
    const images = this.pendingImages.get(sessionId) ?? [];
    let index = images.findIndex((image) => image.hash === hash);
    if (index < 0) {
      index = images.length;
      images.push({ kind, path: file, hash, stack: [] });
      this.pendingImages.set(sessionId, images);
    }
    this.postImages(sessionId);
    await this.showImage(sessionId, null, index);
  }

  // The prompt box carries one 🖼️ char per waiting picture, so the count is all it needs.
  private postImages(sessionId: string): void {
    void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "imagesState", count: (this.pendingImages.get(sessionId) ?? []).length });
  }

  // Clicking a 🖼️ char, in the prompt box or on a prompt bar: that picture goes up in the Image
  // pane. turnId is null for one still waiting to be sent, and the turn's id for one already sent.
  private async showImage(sessionId: string, turnId: string | null, index: number): Promise<void> {
    this.paneImage = { sessionId, turnId, index };
    if (this.managementPane === "cap" && this.managementPanel) {
      this.managementPanel.reveal(vscode.ViewColumn.One);
      void this.managementPanel.webview.postMessage({ type: "captureChanged" });
      return;
    }
    await this.openManagement("cap");
  }

  // Ctrl-clicking a 🖼️ char in the prompt box. Only a picture still waiting can go: once a prompt
  // has been sent, what it was sent with is part of the record.
  private async deleteImage(sessionId: string, index: number): Promise<void> {
    const images = this.pendingImages.get(sessionId);
    const image = images?.[index];
    if (!images || !image) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Remove image ${index + 1} of ${images.length} from this prompt?`,
      { modal: true, detail: `${image.kind === "cap" ? "Screen capture" : "Pasted image"}\n${image.path}` },
      "Remove",
    );
    if (answer !== "Remove") {
      return;
    }
    images.splice(index, 1);
    if (images.length === 0) {
      this.pendingImages.delete(sessionId);
    }
    // The pane may have been showing the one that just went, or one now at a lower index.
    if (this.paneImage?.sessionId === sessionId && this.paneImage.turnId === null) {
      this.paneImage = images.length === 0 ? null : { sessionId, turnId: null, index: Math.min(this.paneImage.index, images.length - 1) };
      void this.managementPanel?.webview.postMessage({ type: "captureChanged" });
    }
    this.postImages(sessionId);
  }

  // Where a submitted prompt's pictures live. Temp dirs are swept by the OS and a sent prompt has
  // to keep showing what it was sent with, so each one is copied here and only leaves when the
  // session it belongs to is permanently deleted.
  private imagesRoot(): string {
    return path.join(this.context.globalStorageUri.fsPath, "images");
  }

  private async keepImages(sessionId: string, turnId: string, images: readonly PendingImage[]): Promise<PromptImage[]> {
    const directory = path.join(this.imagesRoot(), sessionId);
    const kept: PromptImage[] = [];
    for (const [index, image] of images.entries()) {
      const file = path.join(directory, `${turnId}-${index}${path.extname(image.path) || ".png"}`);
      try {
        await fs.mkdir(directory, { recursive: true });
        await fs.copyFile(image.path, file);
        kept.push({ kind: image.kind, path: file });
      } catch (error) {
        // The copy is only about outliving the temp dir. Failing it must not cost the prompt
        // the picture, so the turn goes out pointing at the temp file after all.
        this.channel.appendLine(`Could not keep image ${file}: ${errorMessage(error)}`);
        kept.push({ kind: image.kind, path: image.path });
      }
    }
    return kept;
  }

  private async dropImages(sessionId: string): Promise<void> {
    this.pendingImages.delete(sessionId);
    if (this.paneImage?.sessionId === sessionId) {
      this.paneImage = null;
    }
    try {
      await fs.rm(path.join(this.imagesRoot(), sessionId), { recursive: true, force: true });
    } catch (error) {
      this.channel.appendLine(`Could not remove the images of session ${sessionId}: ${errorMessage(error)}`);
    }
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
    const turnId = randomUUID();
    // Every waiting picture rides with this prompt and the session starts empty again. Each one
    // adds the sentence that gets the CLI to read it; the 🖼️ chars the prompt bar shows are built
    // from `images`, so the sentences are the only trace of them in the text itself.
    const pending = this.pendingImages.get(sessionId) ?? [];
    let images: PromptImage[] = [];
    if (pending.length) {
      this.pendingImages.delete(sessionId);
      this.postImages(sessionId);
      images = await this.keepImages(sessionId, turnId, pending);
      prompt = `${prompt}\n\n${images.map((image) => imageNote(image)).join("\n\n")}`;
      // A pane left showing one of those pictures follows it into the turn, where it is read-only.
      if (this.paneImage?.sessionId === sessionId && this.paneImage.turnId === null) {
        this.paneImage = { sessionId, turnId, index: Math.min(this.paneImage.index, images.length - 1) };
        void this.managementPanel?.webview.postMessage({ type: "captureChanged" });
      }
    }
    // Attached files leave with this prompt too, but only the ones whose tag is still in the text:
    // taking a tag back off the box is the whole of how a file is unattached, so a tag that is
    // gone means the file is not coming. The tags themselves stay in, and read in the prompt bar.
    const attached = this.pendingFiles.get(sessionId) ?? [];
    if (attached.length) {
      this.pendingFiles.delete(sessionId);
      const sent = attached.filter((file) => prompt.includes(`<${file.name}>`));
      if (sent.length) {
        prompt = `${prompt}\n\n${sent.map((file) => fileNote(file)).join("\n\n")}`;
      }
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
      id: turnId,
      prompt,
      images,
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
    this.managementPanel.title = pane === "instructions" ? "Claude2 Instructions" : pane === "quota" ? "Claude2 Quota" : pane === "cap" ? "Claude2 Image" : "Claude2 Stats";
    this.managementPanel.webview.html = managementHtml(this.managementPanel.webview, pane, this.timezone(), this.zoomOf("management"));
    this.managementPanel.reveal(vscode.ViewColumn.One);
    this.refreshSidebar();
  }

  // A settled turn's numbers, folded into the shared record along with what graft banked for
  // the session meanwhile and a fresh reading of the workspace's ceiling comments. The turn
  // and its cost are also credited to the on or off side of each plugin, per the flags the
  // run actually carried, and the whole turn ships as one raw event to the server's log —
  // the extensive record future stats get computed from.
  // Workspace size barely moves within one conversation and the full-tree grep is the costly
  // part, so it is measured once per session and remembered for the session's later turns.
  private readonly sizeBySession = new Map<string, { srcFiles: number; srcLines: number }>();

  private async noteTurnStats(sessionId: string, delta: StatsDelta, info: { plugins: PluginFlags } & Record<string, unknown>): Promise<void> {
    const graft = await this.stats.graftDelta(sessionId);
    const ceilings = await this.ponyCeilingCount();
    this.ceilings = ceilings;
    let size = this.sizeBySession.get(sessionId);
    if (!size) {
      size = await this.workspaceSize();
      this.sizeBySession.set(sessionId, size);
    }
    const split: StatsDelta = {};
    split[info.plugins.ponytail ? "turnsPonyOn" : "turnsPonyOff"] = 1;
    split[info.plugins.ponytail ? "costPonyOn" : "costPonyOff"] = delta.costUsd ?? 0;
    split[info.plugins.graft ? "turnsGraftOn" : "turnsGraftOff"] = 1;
    split[info.plugins.graft ? "costGraftOn" : "costGraftOff"] = delta.costUsd ?? 0;
    await this.stats.add({ ...delta, ...graft, ...split }, { ponyCeilings: ceilings, ...size });
    void this.stats.logTurn({ sessionId, ...info, ...delta, ...graft, ponyCeilings: ceilings, ...size });
    // The turn ends before this grep does, so the footer posted then carried the old count.
    this.postConversationState(sessionId);
  }

  // The Plugins pane's table, rebuilt on every load: every install's record off the stats
  // server folded into one column per project. The local record rides over its own pushed
  // copy — it is never behind, and it carries a just-taken ceilings count.
  private async pluginsReport(): Promise<PluginsReport> {
    const remote = await this.stats.fetchAll();
    const installs: Record<string, Partial<InstallStats>> = { ...(remote?.installs ?? {}) };
    const local = this.stats.local();
    const [ceilings, size] = await Promise.all([this.ponyCeilingCount(), this.workspaceSize()]);
    local.ponyCeilings = ceilings;
    local.srcFiles = size.srcFiles;
    local.srcLines = size.srcLines;
    // and push it, so every other window's pane sees this reading on its next reload rather
    // than waiting for a turn to finish here. Not awaited — the table does not need the POST.
    void this.stats.add({}, { ponyCeilings: ceilings, srcFiles: size.srcFiles, srcLines: size.srcLines });
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
        srcFiles: 0,
        srcLines: 0,
        graft: flags.graft !== false,
        ponytail: flags.ponytail !== false,
      };
      for (const field of counterFields) {
        column[field] += Number(record[field]) || 0;
      }
      // the same repo checked out on two hosts keeps its bigger reading, not the sum
      column.ponyCeilings = Math.max(column.ponyCeilings, Number(record.ponyCeilings) || 0);
      column.srcFiles = Math.max(column.srcFiles, Number(record.srcFiles) || 0);
      column.srcLines = Math.max(column.srcLines, Number(record.srcLines) || 0);
      const host = typeof record.host === "string" ? record.host : "";
      column.hosts = column.hosts.includes(host) ? column.hosts : [column.hosts, host].filter(Boolean).join(" ");
      const recordPath = typeof record.path === "string" ? record.path : "";
      column.paths = column.paths.includes(recordPath) ? column.paths : [column.paths, recordPath].filter(Boolean).join("\n");
      projects.set(name, column);
    }
    // columns group by host — wsl, then windows, then server; a project on several hosts
    // sorts with the earliest of them — and alphabetically within a host
    const hostRank = (hosts: string): number => (hosts.includes("wsl") ? 0 : hosts.includes("windows") ? 1 : 2);
    return {
      projects: [...projects.values()].sort((left, right) => hostRank(left.hosts) - hostRank(right.hosts) || left.project.localeCompare(right.project)),
      offline: remote === null,
    };
  }

  // The workspace's current size: non-binary files and their lines, for judging whether the
  // plugins pay off more on big codebases. Same exclusions as the ceilings grep, plus graft's
  // own generated cards — counting those would inflate exactly the workspaces graft runs in.
  // grep -c with an empty pattern counts every line, and -I makes binaries report 0, so they
  // drop out below (ponytail: along with genuinely empty files — close enough for a gauge).
  private workspaceSize(): Promise<{ srcFiles: number; srcLines: number }> {
    return new Promise((resolve) => {
      const args = ["-rIc", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=out", "--exclude-dir=dist", "--exclude-dir=graft", "--exclude-dir=.vscode-test", "", "."];
      const child = spawn("grep", args, { cwd: this.workspacePath(), stdio: ["ignore", "pipe", "ignore"] });
      let outputText = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputText += chunk;
      });
      child.on("error", () => resolve({ srcFiles: 0, srcLines: 0 }));
      child.on("close", () => {
        let srcFiles = 0;
        let srcLines = 0;
        for (const line of outputText.split("\n")) {
          const count = Number(line.slice(line.lastIndexOf(":") + 1));
          if (count > 0) {
            srcFiles += 1;
            srcLines += count;
          }
        }
        resolve({ srcFiles, srcLines });
      });
    });
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
    if (type === "loadInstructions") {
      await this.reply(requestId, async () => await this.instructions.read());
    } else if (type === "saveInstructions") {
      await this.reply(requestId, async () => await this.instructions.write(stringOf(record?.text), stringOrNull(record?.version)));
    } else if (type === "loadQuotaHistory") {
      await this.reply(requestId, async () => await this.quota.history(false));
    } else if (type === "forceQuotaHistory") {
      await this.reply(requestId, async () => await this.quota.history(true));
    } else if (type === "loadPluginsReport") {
      await this.reply(requestId, async () => await this.pluginsReport());
    } else if (type === "setPluginFlag") {
      await this.reply(requestId, async () => await this.stats.setFlag(stringOf(record?.project), stringOf(record?.plugin), record?.enabled === true));
    } else if (type === "loadCapture") {
      await this.reply(requestId, async () => await this.imageView());
    } else if (type === "cropCapture") {
      await this.reply(requestId, async () => await this.cropCapture(stringOf(record?.dataUri)));
    } else if (type === "undoCrop") {
      await this.reply(requestId, async () => await this.undoCrop());
    }
  }

  // The picture the Image pane is pointed at, or null when that pointer no longer resolves --
  // the image was deleted, or its session went. A submitted one is never editable, so the pane
  // greys out its crop; a waiting one carries the depth of its own crop stack.
  private currentImage(): { kind: "cap" | "paste"; path: string; depth: number; editable: boolean; index: number; count: number } | null {
    const target = this.paneImage;
    if (!target) {
      return null;
    }
    if (target.turnId !== null) {
      const images = this.store.get(target.sessionId)?.turns.find((turn) => turn.id === target.turnId)?.images ?? [];
      const image = images[target.index];
      return image ? { kind: image.kind, path: image.path, depth: 0, editable: false, index: target.index, count: images.length } : null;
    }
    const images = this.pendingImages.get(target.sessionId) ?? [];
    const image = images[target.index];
    return image ? { kind: image.kind, path: image.path, depth: image.stack.length, editable: true, index: target.index, count: images.length } : null;
  }

  // The Image pane's picture, as a data URI: the file sits in a temp dir or in extension storage,
  // outside any root the webview may load file URIs from, and this also works when the picture
  // was taken on another machine. The 🖼️ chars are deliberately identical, so `label` is the
  // only thing that says which of them this is.
  private async imageView(): Promise<ImageView> {
    const current = this.currentImage();
    if (!current) {
      return { path: null, dataUri: null, depth: 0, editable: false, label: "" };
    }
    const bytes = await fs.readFile(current.path);
    return {
      path: current.path,
      dataUri: `data:${mediaTypeOf(current.path)};base64,${bytes.toString("base64")}`,
      depth: current.depth,
      editable: current.editable,
      label: `${current.kind === "cap" ? "Screen capture" : "Pasted image"} ${current.index + 1} of ${current.count}`,
    };
  }

  // The picture the pane is pointed at, but only while it is still waiting on a prompt: cropping
  // and undoing both edit it in place, and a submitted prompt's pictures are part of the record.
  private editableImage(): PendingImage | undefined {
    const target = this.paneImage;
    return target && target.turnId === null ? this.pendingImages.get(target.sessionId)?.[target.index] : undefined;
  }

  // A drag in the Image pane. The webview cut the rectangle out on a canvas, so all that is left
  // is to land the PNG beside the picture it came from -- same directory, so the CLI reads it
  // exactly the way it reads a capture -- and remember what it replaced. The crop is the picture
  // now, hash included, so a later copy of the cropped image still counts as a duplicate.
  private async cropCapture(dataUri: string): Promise<ImageView> {
    const base64 = dataUri.startsWith(PNG_DATA_URI) ? dataUri.slice(PNG_DATA_URI.length) : "";
    const image = this.editableImage();
    if (!image || !base64) {
      return await this.imageView();
    }
    const bytes = Buffer.from(base64, "base64");
    const file = path.join(path.dirname(image.path), `claude2-crop-${Date.now()}.png`);
    await fs.writeFile(file, bytes);
    image.stack.push(image.path);
    image.path = file;
    image.hash = createHash("sha1").update(bytes).digest("hex");
    return await this.imageView();
  }

  private async undoCrop(): Promise<ImageView> {
    const image = this.editableImage();
    const previous = image?.stack.pop();
    if (image && previous) {
      image.path = previous;
      image.hash = createHash("sha1").update(await fs.readFile(previous)).digest("hex");
    }
    return await this.imageView();
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

  private postAllConversationStates(): void {
    for (const sessionId of this.conversationPanels.keys()) {
      this.postConversationState(sessionId);
    }
  }

  private postConversationState(sessionId: string): void {
    const session = this.store.get(sessionId);
    const panel = this.conversationPanels.get(sessionId);
    if (!session || !panel) {
      return;
    }
    panel.title = session.name;
    // Which plugin stat the footer shows, and the numbers only this side can read: graft's
    // savings for the session and the workspace's ceiling count.
    const footer = { ...this.stats.cachedFlags(), graftSavedUsd: this.stats.graftSavedUsd(sessionId), ceilings: this.ceilings, quotaAlert: this.quota.alerting() };
    void panel.webview.postMessage({ type: "sessionState", session, status: this.runner.status(sessionId), draft: this.drafts.get(sessionId) ?? "", search: this.searchText, boxScrolls: this.boxScrolls.get(sessionId) ?? {}, footer });
    this.refreshSidebar();
  }

  // Streaming update: only the new text and the run status cross to the webview, and the
  // sidebar (whose cards show nothing live) is left alone until the run ends.
  private postTurnDelta(sessionId: string, turnId: string, delta: string): void {
    void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "turnDelta", turnId, delta, status: this.runner.status(sessionId) });
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
    });
  }
}

function paneOf(value: unknown): ManagementPane | null {
  return value === "instructions" || value === "quota" || value === "plugins" || value === "cap" ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : -1;
}

// The sentence appended for one attached picture. It is the whole of how the picture reaches the
// model: the CLI reads the path with its own Read tool, so the path has to be in the text.
function imageNote(image: PromptImage): string {
  return image.kind === "cap"
    ? `[A screenshot of the user's desktop is attached. Read the image file ${image.path} to view it.]`
    : `[An image is attached. Read the image file ${image.path} to view it.]`;
}

// The sentence appended for one attached file, the counterpart of imageNote: the <name> tag in the
// prompt is only a label, and this is what tells the CLI which path it stands for.
function fileNote(file: { name: string; path: string }): string {
  return `[<${file.name}> is the file ${file.path}. Read that file to see it.]`;
}

// The extensions mediaTypeOf knows how to name. Anything else picked with the File button is
// attached as a file rather than as a picture.
const IMAGE_FILES = /\.(png|jpe?g|gif|webp)$/i;

function mediaTypeOf(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".gif" ? "image/gif" : extension === ".webp" ? "image/webp" : "image/png";
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
