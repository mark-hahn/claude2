import { spawn } from "node:child_process";
import * as os from "node:os";
import * as vscode from "vscode";

// One shared tally kept on hahnca.com, so the Ponytail pane shows the same lifetime numbers
// from every workspace on every machine. Each install (host + workspace) owns one file and is
// the only writer of it: no read-modify-write race, nothing to lose when two windows run at
// once. The file holds running totals rather than deltas, so a push that fails offline costs
// nothing -- the next one carries everything the local counter has accumulated since.

const remoteHost = "hahnca.com";
const remoteDir = ".pony-tally";
const tallyKey = "pony.tally";

export interface PonyTally {
  sessions: number;
  turns: number;
}

function ssh(command: string, stdin = ""): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", remoteHost, command], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    // An unreachable server is not worth a dialog: the pane falls back to local counts.
    child.stdin.on("error", () => resolve(""));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
    child.stdin.end(stdin);
  });
}

export class PonyLedger {
  private readonly fileName: string;

  public constructor(private readonly context: vscode.ExtensionContext, workspacePath: string) {
    this.fileName = `${os.hostname()}__${workspacePath}`.replace(/[^A-Za-z0-9._-]+/g, "-") + ".json";
  }

  private local(): PonyTally {
    const saved = this.context.workspaceState.get<Partial<PonyTally>>(tallyKey, {});
    return { sessions: Number(saved.sessions) || 0, turns: Number(saved.turns) || 0 };
  }

  // Counts the turn, and the session with it when this is the session's first. Kept locally
  // first so the number survives a deleted session, a trashed one, or an offline server.
  public async note(firstTurnOfSession: boolean): Promise<void> {
    const tally = this.local();
    const next = { sessions: tally.sessions + (firstTurnOfSession ? 1 : 0), turns: tally.turns + 1 };
    await this.context.workspaceState.update(tallyKey, next);
    await this.push(next);
  }

  // First run in a workspace adopts whatever the stored sessions still show, so the history
  // that predates the ledger is not thrown away. Later runs leave the counter alone -- by then
  // it counts turns the sessions themselves no longer remember.
  public async seed(tally: PonyTally): Promise<void> {
    if (this.context.workspaceState.get(tallyKey) !== undefined) {
      return;
    }
    await this.context.workspaceState.update(tallyKey, tally);
    await this.push(tally);
  }

  private push(tally: PonyTally): Promise<string> {
    return ssh(`mkdir -p ~/${remoteDir} && cat > ~/${remoteDir}/${this.fileName}`, JSON.stringify(tally) + "\n");
  }

  // Every install's file, summed. This one is pushed first so the pane still reflects turns
  // whose own push was offline at the time.
  public async total(): Promise<PonyTally> {
    const local = this.local();
    await this.push(local);
    const text = await ssh(`cat ~/${remoteDir}/*.json 2>/dev/null`);
    const total = { sessions: 0, turns: 0 };
    let found = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const tally = JSON.parse(line) as Partial<PonyTally>;
        total.sessions += Number(tally.sessions) || 0;
        total.turns += Number(tally.turns) || 0;
        found = true;
      } catch {
        // a half-written file from a killed push; the next one replaces it
      }
    }
    return found ? total : local;
  }
}
