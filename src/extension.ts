import * as vscode from "vscode";

let output: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Claude2");
  context.subscriptions.push(output);
  output.appendLine("Claude2 activated");

  context.subscriptions.push(
    vscode.commands.registerCommand("claude2.helloWorld", () => {
      const enabled = vscode.workspace.getConfiguration("claude2").get<boolean>("enabled", true);
      if (!enabled) {
        void vscode.window.showWarningMessage("Claude2 is disabled in settings.");
        return;
      }
      void vscode.window.showInformationMessage("Hello from Claude2!");
    })
  );
}

export function deactivate(): void {
  output?.appendLine("Claude2 deactivated");
}
