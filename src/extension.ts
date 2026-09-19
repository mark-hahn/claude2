import * as vscode from "vscode";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { captureScreen } from "./capture";
import { ClaudeCliRunner, truncateSessionTranscript, type RunLimits } from "./claudeCli";
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
  // Drafts live in workspaceState next to the sessions, so a reload puts every unsent prompt
  // back in its box; an entry is dropped only once its text has actually been submitted.
  private readonly drafts = new Map<string, string>();
  // The turn currently running in each session, settled once its bookkeeping is written. A
  // prompt sent mid-run awaits this, so the stopped turn is complete before the next one starts.
  private readonly runs = new Map<string, Promise<void>>();
  // Set when a draft went down with its session — deleted, or swept away before the typing
  // arrived. The text stays in `drafts`, and the next new session opens with it in the box.
  private promptTextLost = "";
  private readonly draftNames = new Map<string, string>();
  // Sessions whose panel should put the caret in the prompt box once its webview loads.
  private readonly pendingPromptFocus = new Set<string>();
  // Index of the response box each conversation has selected; the md pane renders that one.
  private readonly selectedTurns = new Map<string, number>();
  // Turn ids whose tool groups are hidden, per session. Deliberately not persisted to disk:
  // the setting outlives any one webview but resets when the extension reloads.
  private readonly toolsHidden = new Map<string, string[]>();
  // Screenshot armed by the Cap button, per session: the PNG path rides along with the next
  // prompt submitted, then the entry clears. Toggling Cap off clears it without sending.
  private readonly pendingCaptures = new Map<string, string>();
  // Most recent capture taken, kept after submit or discard so the Cap pane can still show it.
  private lastCapture: string | null = null;
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
    this.authNeeded = context.globalState.get<boolean>(authNeededKey, false);
    this.loadDrafts();
  }

  // Drafts saved by an earlier window come back keyed by session. An entry whose session is
  // gone is kept only when it is the lost one waiting to be recovered; the rest are dropped so
  // the store does not grow a tail of dead sessions' typing.
  private loadDrafts(): void {
    const saved = this.context.workspaceState.get<Record<string, string>>(draftsKey, {});
    this.promptTextLost = this.context.workspaceState.get<string>(promptTextLostKey, "");
    for (const [sessionId, text] of Object.entries(saved)) {
      if (typeof text === "string" && text && (this.store.get(sessionId) || sessionId === this.promptTextLost)) {
        this.drafts.set(sessionId, text);
      }
    }
    if (this.promptTextLost && !this.drafts.has(this.promptTextLost)) {
      this.promptTextLost = "";
    }
    this.saveDrafts();
  }

  private saveDrafts(): void {
    void this.context.workspaceState.update(draftsKey, Object.fromEntries(this.drafts));
    void this.context.workspaceState.update(promptTextLostKey, this.promptTextLost || undefined);
  }

  // A draft whose session is going away: the text stays put and the flag marks it for the next
  // new session, so typing is never lost to a click that removed the session under it.
  private noteDraftLost(sessionId: string): void {
    if (this.drafts.has(sessionId)) {
      this.promptTextLost = sessionId;
      this.saveDrafts();
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
    } else if (type === "restoreSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), false);
      this.refreshSidebar();
    } else if (type === "deleteSession") {
      const sessionId = stringOf(record?.sessionId);
      if (record?.confirm !== false && !(await this.confirmDelete(sessionId))) {
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
    this.recoverLostDraft(session.id);
    this.refreshSidebar();
    await this.openConversation(session.id, true);
  }

  // A draft that went down with its session comes back in the next new session's box. The flag
  // clears so it is handed over once, while the original entry stays in the store: if this
  // session is itself swept away, the same text is still there to recover.
  private recoverLostDraft(sessionId: string): void {
    const lost = this.promptTextLost ? this.drafts.get(this.promptTextLost) : "";
    this.promptTextLost = "";
    if (lost) {
      this.drafts.set(sessionId, lost);
    }
    this.saveDrafts();
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
      // Belt and braces with the filter above: typing that arrived in the same instant is
      // marked lost rather than swept out with the session.
      this.noteDraftLost(session.id);
      await this.store.remove(session.id);
    }
    this.refreshSidebar();
  }

  // The trash icon on a trashed card is the permanent one: the session is forgotten outright,
  // not just hidden, so its tab goes with it. Its unsent draft does not: it is held as the lost
  // one, and the next new session opens with that text already in the box.
  private async confirmDelete(sessionId: string): Promise<boolean> {
    const name = this.store.get(sessionId)?.name || "this session";
    const answer = await vscode.window.showWarningMessage(
      `Permanently delete "${name}"?`,
      { modal: true, detail: "This cannot be undone. Ctrl-click the trash icon to skip this prompt." },
      "Delete",
    );
    return answer === "Delete";
  }

  private async deleteSession(sessionId: string): Promise<void> {
    if (!sessionId) {
      return;
    }
    this.conversationPanels.get(sessionId)?.dispose();
    this.conversationPanels.delete(sessionId);
    this.draftNames.delete(sessionId);
    this.noteDraftLost(sessionId);
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
      this.postCapState(sessionId);
    } else if (type === "submitPrompt") {
      await this.submitPrompt(sessionId, stringOf(record?.prompt), stringOf(record?.model), stringOf(record?.effort));
    } else if (type === "picksChanged") {
      await this.store.setPicks(sessionId, stringOf(record?.model), stringOf(record?.effort));
    } else if (type === "draftChanged") {
      this.noteDraft(sessionId, stringOf(record?.draft));
    } else if (type === "draftBlur") {
      this.noteDraft(sessionId, stringOf(record?.draft));
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
    } else if (type === "toolsHiddenChanged") {
      const turnIds = record?.turnIds;
      this.toolsHidden.set(sessionId, Array.isArray(turnIds) ? turnIds.filter((id): id is string => typeof id === "string") : []);
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
  private selectedResponse(): { turnId: string; prompt: string; text: string } | null {
    const session = this.store.get(this.lastConversationId);
    if (!session || !session.turns.length) {
      return null;
    }
    const index = Math.max(0, Math.min(session.turns.length - 1, this.selectedTurns.get(session.id) ?? session.turns.length - 1));
    const turn = session.turns[index];
    // Same as the conversation pane: a failed turn keeps its partial text and gains the reason.
    const text = turn.error ? `${turn.response}${turn.response ? "\n\n" : ""}${turn.error}` : turn.response;
    return { turnId: turn.id, prompt: turn.prompt, text };
  }

  private postSelectedResponse(): void {
    if (this.managementPane !== "markdown") {
      return;
    }
    void this.managementPanel?.webview.postMessage({ type: "selectedResponse", payload: this.selectedResponse() });
  }

  // hideWindow is Ctrl-Cap: minimize this VS Code window for the length of the shot so the picture
  // shows what it was covering. It comes back by itself, and the extension host never goes away.
  private async captureForSession(sessionId: string, hideWindow = false): Promise<void> {
    try {
      const file = await captureScreen(hideWindow);
      this.pendingCaptures.set(sessionId, file);
      this.lastCapture = file;
      if (this.managementPane === "cap") {
        void this.managementPanel?.webview.postMessage({ type: "captureChanged" });
      }
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
      graftSaved: 0,
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
    let lastContext = priorContext;
    let lastGraftSaved = 0;
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
        onText: (text) => {
          streamedResponse += text;
          this.store.patchTurn(sessionId, turn.id, { response: streamedResponse }, false);
          pendingDelta += text;
          queueStream();
        },
        onStatus: (status) => {
          lastContext = status.contextTokens || lastContext;
          lastGraftSaved = status.graftSaved || lastGraftSaved;
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
        graftSaved: result.graftSaved,
      }, true);
      await this.store.flush();
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
          graftSaved: lastGraftSaved,
          turns: lastTurns,
          finished: true,
          stopped: false,
        }, true);
        await this.store.flush();
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
      this.drafts.set(sessionId, draft);
      // Typing that lands after its session was swept away has nowhere to go back to, so it
      // becomes the lost draft instead of sitting in the store unreachable.
      if (!this.store.get(sessionId)) {
        this.promptTextLost = sessionId;
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
      });
    }
    this.managementPane = pane;
    const graftPage = pane === "graft" ? await this.exportedGraftViz() : null;
    // The panel can close (or switch panes) while the export runs.
    if (!this.managementPanel || this.managementPane !== pane) {
      return;
    }
    this.managementPanel.title = pane === "instructions" ? "Claude2 Instructions" : pane === "quota" ? "Claude2 Quota" : pane === "markdown" ? "Claude2 Markdown" : pane === "cap" ? "Claude2 Capture" : "Graft";
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
    } else if (type === "loadCapture") {
      await this.reply(requestId, async () => await this.captureView());
    }
  }

  // The Cap pane's image, as a data URI: the PNG sits in a temp dir outside any root the
  // webview may load file URIs from, and this also works when it was taken on another machine.
  private async captureView(): Promise<{ path: string | null; dataUri: string | null }> {
    if (!this.lastCapture) {
      return { path: null, dataUri: null };
    }
    const bytes = await fs.readFile(this.lastCapture);
    return { path: this.lastCapture, dataUri: `data:image/png;base64,${bytes.toString("base64")}` };
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
    void panel.webview.postMessage({ type: "sessionState", session, status: this.runner.status(sessionId), draft: this.drafts.get(sessionId) ?? "", search: this.searchText, toolsHidden: this.toolsHidden.get(sessionId) ?? [] });
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
    });
  }
}

function paneOf(value: unknown): ManagementPane | null {
  return value === "instructions" || value === "quota" || value === "graft" || value === "markdown" || value === "cap" ? value : null;
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
