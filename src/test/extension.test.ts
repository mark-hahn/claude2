import * as assert from "assert";
import * as vscode from "vscode";

suite("Claude2 extension", () => {
  test("registers Claude2 commands", async () => {
    const ext = vscode.extensions.getExtension("hahnca.claude2");
    assert.ok(ext, "extension not found");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("claude2.newSession"));
    assert.ok(commands.includes("claude2.openInstructions"));
    assert.ok(commands.includes("claude2.openQuota"));
  });
});
