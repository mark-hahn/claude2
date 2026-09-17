import * as vscode from "vscode";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { ClaudeCliRunner, type RunLimits } from "./claudeCli";
import { InstructionsFile } from "./instructionsFile";
import { QuotaService } from "./quota";
import { SessionStore } from "./sessionStore";
import { CLAUDE2_CONTEXT_WINDOW, DEFAULT_EFFORT, DEFAULT_MODEL, type ClaudeSession, type ClaudeTurn } from "./types";
import { conversationHtml, managementHtml, sidebarHtml, zoomFactor, type ConversationDefaults, type ManagementPane } from "./webviews";

let output: vscode.OutputChannel | undefined;
let controller: Claude2Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Claude2");
  context.subscriptions.push(output);
  output.appendLine("Claude2 activated");
  controller = new Claude2Controller(context, output);
  controller.activate();
  context.subscriptions.push(controller);
}

export function deactivate(): void {
  // The controller is in context.subscriptions, so VS Code disposes it; only log here.
  output?.appendLine("Claude2 deactivated");
}

class Claude2Controller implements vscode.Disposable {
  private readonly store: SessionStore;
  private readonly runner: ClaudeCliRunner;
  private readonly instructions = new InstructionsFile();
  private readonly quota: QuotaService;
  private readonly conversationPanels = new Map<string, vscode.WebviewPanel>();
  private readonly leaveResolvers = new Map<string, (go: boolean) => void>();
  // Unsent prompt text per session, and the draft each auto-generated name was built from.
  private readonly drafts = new Map<string, string>();
  private readonly draftNames = new Map<string, string>();
  // Sessions whose panel should put the caret in the prompt box once its webview loads.
  private readonly pendingPromptFocus = new Set<string>();
  // Index of the response box each conversation has selected; the md pane renders that one.
  private readonly selectedTurns = new Map<string, number>();
  private sidebarProvider: ClaudeSidebarProvider | null = null;
  private managementPanel: vscode.WebviewPanel | null = null;
  private managementPane: ManagementPane | null = null;
  // The conversation a management button toggles back to; the panels themselves are all
  // inactive while a management pane is up front, so remember the last one focused.
  private lastConversationId = "";
  private instructionsWatcher: vscode.FileSystemWatcher | null = null;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly channel: vscode.OutputChannel) {
    this.store = new SessionStore(context);
    this.runner = new ClaudeCliRunner((line) => this.channel.appendLine(line));
    this.quota = new QuotaService(context, this.workspacePath(), (line) => this.channel.appendLine(line));
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
    // A session created by "+" that never got a prompt is scratch: drop it as soon as
    // attention moves to any other sidebar control or session card. "Close" keeps the
    // current tab, so its session survives the sweep even when it is still empty.
    const requestedSessionId = stringOf(record?.sessionId);
    const keepId = requestedSessionId || (type === "closeOtherSessions" ? this.activeConversationId() : "");
    await this.discardEmptySessions(keepId);
    if (type === "closeOtherSessions") {
      this.closeOtherSessions(keepId);
    } else if (type === "newSession") {
      await this.newSession();
    } else if (type === "openSession") {
      await this.openConversation(requestedSessionId);
    } else if (type === "renameSession") {
      await this.renameSession(stringOf(record?.sessionId), stringOf(record?.name));
    } else if (type === "trashSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), true);
      this.refreshSidebar();
    } else if (type === "restoreSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), false);
      this.refreshSidebar();
    } else if (type === "deleteSession") {
      await this.deleteSession(stringOf(record?.sessionId));
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

  // Forget every session with neither a turn nor an unsent draft, except `exceptId`.
  private async discardEmptySessions(exceptId = ""): Promise<void> {
    // The sidebar click and the prompt box's blur race each other across two webviews;
    // let the blur's draft message land first so a typed draft is never dropped.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const stale = this.store
      .all()
      .filter((session) => session.id !== exceptId && session.turns.length === 0 && !this.drafts.get(session.id));
    if (stale.length === 0) {
      return;
    }
    for (const session of stale) {
      this.conversationPanels.get(session.id)?.dispose();
      this.draftNames.delete(session.id);
      await this.store.remove(session.id);
    }
    this.refreshSidebar();
  }

  // The trash icon on a trashed card is the permanent one: the session is forgotten
  // outright, not just hidden, so its tab and any draft go with it.
  private async deleteSession(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    this.conversationPanels.get(sessionId)?.dispose();
    this.conversationPanels.delete(sessionId);
    this.draftNames.delete(sessionId);
    this.drafts.delete(sessionId);
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
      panel.webview.html = conversationHtml(panel.webview, sessionId, this.conversationDefaults(), this.zoomOf("conversation"));
      panel.webview.onDidReceiveMessage((message) => void this.handleConversationMessage(message));
      panel.onDidChangeViewState(() => {
        if (panel?.active) {
          this.lastConversationId = sessionId;
        }
        // Losing visibility has to refresh too, otherwise the card keeps its tint.
        this.refreshSidebar();
      });
      panel.onDidDispose(() => {
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

  private closeOtherSessions(keepId: string): void {
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
      if (this.pendingPromptFocus.delete(sessionId)) {
        void this.conversationPanels.get(sessionId)?.webview.postMessage({ type: "focusPrompt" });
      }
    } else if (type === "submitPrompt") {
      await this.submitPrompt(sessionId, stringOf(record?.prompt), stringOf(record?.model), stringOf(record?.effort));
    } else if (type === "draftChanged") {
      this.noteDraft(sessionId, stringOf(record?.draft));
    } else if (type === "draftBlur") {
      this.noteDraft(sessionId, stringOf(record?.draft));
      await this.nameSessionFromDraft(sessionId);
    } else if (type === "stopPrompt") {
      this.runner.stop(sessionId);
      this.postConversationState(sessionId);
    } else if (type === "selectionChanged") {
      const index = record?.index;
      this.selectedTurns.set(sessionId, typeof index === "number" ? index : 0);
      if (sessionId === this.lastConversationId) {
        this.postSelectedResponse();
      }
    }
  }

  // The response box the conversation has selected, as the md pane wants it. The pane opens from
  // the sidebar, so the conversation it reads from is the last one focused. The turn id rides
  // along so the pane can tell a growing response apart from a different one and keep its scroll.
  private selectedResponse(): { turnId: string; prompt: string; text: string } | null {
    const session = this.store.get(this.lastConversationId);
    if (!session || !session.turns.length) {
      return null;
    }
    const index = Math.max(0, Math.min(session.turns.length - 1, this.selectedTurns.get(session.id) ?? session.turns.length - 1));
    const turn = session.turns[index];
    return { turnId: turn.id, prompt: turn.prompt, text: turn.error ?? turn.response };
  }

  private postSelectedResponse(): void {
    if (this.managementPane !== "markdown") {
      return;
    }
    void this.managementPanel?.webview.postMessage({ type: "selectedResponse", payload: this.selectedResponse() });
  }

  private async submitPrompt(sessionId: string, prompt: string, model: string, effort: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || !prompt.trim()) {
      return;
    }
    if (this.runner.isRunning(sessionId)) {
      void vscode.window.showWarningMessage("Claude is already responding in this session.");
      return;
    }
    const defaults = this.conversationDefaults();
    const selectedModel = model || defaults.model;
    const selectedEffort = effort || defaults.effort;
    const wasFirstPrompt = session.turns.length === 0;
    this.drafts.delete(sessionId);
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
      contextUsed: 0,
      finished: false,
      stopped: false,
      error: null,
      costUsd: null,
      stopReason: null,
      turns: 0,
      maxTurns: this.runLimits().maxTurns,
    };
    await this.store.appendTurn(sessionId, turn);
    this.postConversationState(sessionId);
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
        limits: this.runLimits(),
        onText: (text) => {
          streamedResponse += text;
          this.store.patchTurn(sessionId, turn.id, { response: streamedResponse }, false);
          pendingDelta += text;
          queueStream();
        },
        onStatus: queueStream,
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
      }, true);
      await this.store.flush();
    } catch (error) {
      this.store.patchTurn(sessionId, turn.id, {
        error: errorMessage(error),
        completedAt: Date.now(),
        finished: true,
        stopped: false,
      }, true);
      await this.store.flush();
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

  private noteDraft(sessionId: string, draft: string): void {
    const text = draft.trim();
    if (text) {
      this.drafts.set(sessionId, text);
    } else {
      this.drafts.delete(sessionId);
    }
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
      });
    }
    this.managementPane = pane;
    const graftPage = pane === "graft" ? await this.exportedGraftViz() : null;
    // The panel can close (or switch panes) while the export runs.
    if (!this.managementPanel || this.managementPane !== pane) {
      return;
    }
    this.managementPanel.title = pane === "instructions" ? "Claude2 Instructions" : pane === "quota" ? "Claude2 Quota" : pane === "markdown" ? "Claude2 Markdown" : "Graft";
    this.managementPanel.webview.html = managementHtml(this.managementPanel.webview, pane, this.timezone(), graftPage, this.zoomOf("management"));
    this.managementPanel.reveal(vscode.ViewColumn.One);
  }

  // `graft viz --export` packages the graph into one self-contained html page; no
  // server or port is involved, so re-export on every open to stay current.
  private async exportedGraftViz(): Promise<string | null> {
    const storage = this.context.storageUri ?? this.context.globalStorageUri;
    const dir = path.join(storage.fsPath, "graft-viz");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("graft", ["viz", "--export", dir], { cwd: this.workspacePath(), stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`graft viz --export exited with code ${code}`))));
      });
      return await fs.readFile(path.join(dir, "index.html"), "utf8");
    } catch (error) {
      this.channel.appendLine(`graft viz export failed: ${errorMessage(error)}`);
      return null;
    }
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
    this.instructionsWatcher.onDidChange(notify);
    this.instructionsWatcher.onDidCreate(notify);
    this.instructionsWatcher.onDidDelete(notify);
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
    } else if (type === "loadSelectedResponse") {
      await this.reply(requestId, async () => this.selectedResponse());
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

  private postConversationState(sessionId: string): void {
    const session = this.store.get(sessionId);
    const panel = this.conversationPanels.get(sessionId);
    if (!session || !panel) {
      return;
    }
    panel.title = session.name;
    void panel.webview.postMessage({ type: "sessionState", session, status: this.runner.status(sessionId), draft: this.drafts.get(sessionId) ?? "" });
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

  private conversationDefaults(): ConversationDefaults {
    const config = vscode.workspace.getConfiguration("claude2");
    return {
      model: config.get<string>("model", DEFAULT_MODEL),
      effort: config.get<string>("effort", DEFAULT_EFFORT),
      contextWindow: config.get<number>("contextWindowTokens", CLAUDE2_CONTEXT_WINDOW),
      maxTurns: config.get<number>("maxTurns", 200),
    };
  }

  private runLimits(): RunLimits {
    const config = vscode.workspace.getConfiguration("claude2");
    return {
      maxTurns: config.get<number>("maxTurns", 200),
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
    });
  }
}

function paneOf(value: unknown): ManagementPane | null {
  return value === "instructions" || value === "quota" || value === "graft" || value === "markdown" ? value : null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
