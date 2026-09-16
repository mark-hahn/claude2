import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { ClaudeCliRunner, type RunLimits } from "./claudeCli";
import { InstructionsFile } from "./instructionsFile";
import { QuotaService } from "./quota";
import { SessionStore } from "./sessionStore";
import { CLAUDE2_CONTEXT_WINDOW, DEFAULT_EFFORT, DEFAULT_MODEL, type ClaudeTurn } from "./types";
import { conversationHtml, managementHtml, sidebarHtml, type ConversationDefaults, type ManagementPane } from "./webviews";

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
  private sidebarProvider: ClaudeSidebarProvider | null = null;
  private managementPanel: vscode.WebviewPanel | null = null;
  private managementPane: ManagementPane | null = null;
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

  public async handleSidebarMessage(message: unknown): Promise<void> {
    const record = recordOf(message);
    const type = stringOf(record?.type);
    if (type === "ready") {
      this.refreshSidebar();
    } else if (type === "newSession") {
      await this.newSession();
    } else if (type === "openSession") {
      await this.openConversation(stringOf(record?.sessionId));
    } else if (type === "renameSession") {
      await this.renameSession(stringOf(record?.sessionId));
    } else if (type === "trashSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), true);
      this.refreshSidebar();
    } else if (type === "restoreSession") {
      await this.store.setTrashed(stringOf(record?.sessionId), false);
      this.refreshSidebar();
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
    const session = await this.store.create();
    this.refreshSidebar();
    await this.openConversation(session.id);
  }

  private async renameSession(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) {
      return;
    }
    const name = await vscode.window.showInputBox({ title: "Rename Claude2 session", value: session.name, prompt: "Session name" });
    if (name === undefined) {
      return;
    }
    await this.store.rename(sessionId, name);
    this.postConversationState(sessionId);
    this.refreshSidebar();
  }

  private async openConversation(sessionId: string): Promise<void> {
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
      panel.webview.html = conversationHtml(panel.webview, sessionId, this.conversationDefaults());
      panel.webview.onDidReceiveMessage((message) => void this.handleConversationMessage(message));
      panel.onDidDispose(() => this.conversationPanels.delete(sessionId));
      this.conversationPanels.set(sessionId, panel);
    }
    panel.title = session.name;
    panel.reveal(vscode.ViewColumn.One);
    this.postConversationState(sessionId);
  }

  private async handleConversationMessage(message: unknown): Promise<void> {
    const record = recordOf(message);
    const type = stringOf(record?.type);
    const sessionId = stringOf(record?.sessionId);
    if (type === "conversationReady") {
      this.postConversationState(sessionId);
    } else if (type === "submitPrompt") {
      await this.submitPrompt(sessionId, stringOf(record?.prompt), stringOf(record?.model), stringOf(record?.effort));
    } else if (type === "stopPrompt") {
      this.runner.stop(sessionId);
      this.postConversationState(sessionId);
    }
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
    };
    await this.store.appendTurn(sessionId, turn);
    this.postConversationState(sessionId);
    if (wasFirstPrompt) {
      void this.nameSessionFromPrompt(sessionId, prompt, selectedModel);
    }

    let streamedResponse = "";
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
          this.postConversationState(sessionId);
        },
        onStatus: () => this.postConversationState(sessionId),
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
      this.postConversationState(sessionId);
      this.refreshSidebar();
      void this.quota.history(false);
    }
  }

  private async nameSessionFromPrompt(sessionId: string, prompt: string, model: string): Promise<void> {
    try {
      const title = await this.runner.generateTitle(prompt, model, this.workspacePath());
      const session = this.store.get(sessionId);
      if (session && session.name === "New session") {
        await this.store.rename(sessionId, title);
        this.postConversationState(sessionId);
        this.refreshSidebar();
      }
    } catch (error) {
      this.channel.appendLine(`Claude session naming failed: ${errorMessage(error)}`);
    }
  }

  private async openManagement(pane: ManagementPane): Promise<void> {
    if (!(await this.ensureEnabled()) || !(await this.mayLeaveManagement())) {
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
    this.managementPanel.title = pane === "instructions" ? "Claude2 Instructions" : "Claude2 Quota";
    this.managementPanel.webview.html = managementHtml(this.managementPanel.webview, pane, this.timezone());
    this.managementPanel.reveal(vscode.ViewColumn.One);
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
    void panel.webview.postMessage({ type: "sessionState", session, status: this.runner.status(sessionId) });
    this.refreshSidebar();
  }

  private refreshSidebar(): void {
    this.sidebarProvider?.refresh();
  }

  private conversationDefaults(): ConversationDefaults {
    const config = vscode.workspace.getConfiguration("claude2");
    return {
      model: config.get<string>("model", DEFAULT_MODEL),
      effort: config.get<string>("effort", DEFAULT_EFFORT),
      contextWindow: config.get<number>("contextWindowTokens", CLAUDE2_CONTEXT_WINDOW),
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
    void this.view?.webview.postMessage({ type: "sessions", sessions: this.controller.sessions() });
  }
}

function paneOf(value: unknown): ManagementPane | null {
  return value === "instructions" || value === "quota" ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
