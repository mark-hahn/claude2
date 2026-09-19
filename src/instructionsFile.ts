import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";

export interface InstructionsReadResult {
  text: string;
  version: string;
  path: string;
  mirrors: string[];
}

export interface InstructionsWriteResult {
  ok: true;
  version: string;
  stale: boolean;
  mirrorError: string | null;
}

const defaultMirrors = [".github/copilot-instructions.md"];

export class InstructionsFile {
  public constructor(
    private readonly filename = "CLAUDE.md",
    private readonly mirrorNames: readonly string[] = defaultMirrors,
  ) {}

  public get mirrors(): string[] {
    return [...this.mirrorNames];
  }

  public async read(): Promise<InstructionsReadResult> {
    const filePath = this.resolvePath(this.filename);
    const version = await this.versionOf(filePath);
    const text = (await readFileOrNull(filePath)) ?? "";
    return { text: text.trimEnd(), version, path: this.filename, mirrors: this.mirrors };
  }

  public async write(text: string, version: string | null): Promise<InstructionsWriteResult> {
    const filePath = this.resolvePath(this.filename);
    const currentVersion = await this.versionOf(filePath);
    const stale = typeof version === "string" && version !== "" && version !== currentVersion;
    const markdown = normalizeMarkdown(text);
    await writeFileMakingDirs(filePath, markdown);
    const mirrorError = await this.mirror(markdown);
    return { ok: true, version: await this.versionOf(filePath), stale, mirrorError };
  }

  // CLAUDE.md is the authority and every mirror is a byte-for-byte copy of it. A mirror that cannot
  // be written must not cost the save that already landed in CLAUDE.md, so the failure is handed
  // back to the caller rather than thrown. Mirrors already holding the text are left untouched, so
  // an unchanged copy keeps its mtime and wakes no file watcher.
  private async mirror(markdown: string): Promise<string | null> {
    for (const name of this.mirrorNames) {
      try {
        const mirrorPath = this.resolvePath(name);
        if ((await readFileOrNull(mirrorPath)) === markdown) {
          continue;
        }
        await writeFileMakingDirs(mirrorPath, markdown);
      } catch (error) {
        return `${name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  }

  // Brings the mirrors back in line after CLAUDE.md changes outside the pane: another editor, a git
  // checkout, or a Claude edit. A missing CLAUDE.md leaves the mirrors alone rather than emptying
  // them, since a deleted authority is far likelier to be in-flight than intended.
  public async syncMirrors(): Promise<string | null> {
    const markdown = await readFileOrNull(this.resolvePath(this.filename));
    return markdown === null ? null : await this.mirror(markdown);
  }

  private resolvePath(name: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("Open a workspace before editing CLAUDE.md.");
    }
    return path.join(workspaceFolder.uri.fsPath, name);
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

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

async function writeFileMakingDirs(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

function normalizeMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?|\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}