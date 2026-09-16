import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export interface InstructionsReadResult {
  text: string;
  version: string;
  path: string;
}

export interface InstructionsWriteResult {
  ok: true;
  version: string;
  stale: boolean;
}

export class InstructionsFile {
  public constructor(private readonly filename = "CLAUDE.md") {}

  public async read(): Promise<InstructionsReadResult> {
    const filePath = this.resolvePath();
    const version = await this.versionOf(filePath);
    let text = "";
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    return { text: text.trimEnd(), version, path: this.filename };
  }

  public async write(text: string, version: string | null): Promise<InstructionsWriteResult> {
    const filePath = this.resolvePath();
    const currentVersion = await this.versionOf(filePath);
    const stale = typeof version === "string" && version !== "" && version !== currentVersion;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, normalizeMarkdown(text), "utf8");
    return { ok: true, version: await this.versionOf(filePath), stale };
  }

  private resolvePath(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("Open a workspace before editing CLAUDE.md.");
    }
    return path.join(workspaceFolder.uri.fsPath, this.filename);
  }

  private async versionOf(filePath: string): Promise<string> {
    try {
      const stat = await fs.stat(filePath);
      return `${Math.floor(stat.mtimeMs)}:${stat.size}`;
    } catch (error) {
      if (isMissingFileError(error)) {
        return "";
      }
      throw error;
    }
  }
}

function normalizeMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?|\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}