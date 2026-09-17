import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// Captures the client's desktop and returns the path of a PNG readable from this extension host.
// Three hosts, three routes: on Windows the extension host can run PowerShell directly; in WSL it
// crosses interop to the same PowerShell through /mnt/c; on a remote server nothing local can see
// the client's screen, so it asks the claude2-cap UI extension on the client for the pixels.
export async function captureScreen(): Promise<string> {
  const name = `claude2-cap-${Date.now()}.png`;
  if (process.platform === "win32") {
    const file = path.join(os.tmpdir(), name);
    await runPowershell("powershell.exe", file);
    return file;
  }
  if (isWsl()) {
    // PowerShell writes on the Windows side of the mount; the same file reads back through /mnt/c.
    await runPowershell("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", `C:\\Windows\\Temp\\${name}`);
    return `/mnt/c/Windows/Temp/${name}`;
  }
  const base64 = await remoteCapture();
  const file = path.join(os.tmpdir(), name);
  await fs.promises.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

async function remoteCapture(): Promise<string> {
  try {
    const base64 = await vscode.commands.executeCommand<string>("claude2-cap.capture");
    if (typeof base64 !== "string" || !base64) {
      throw new Error("claude2-cap returned no image data.");
    }
    return base64;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(text)) {
      throw new Error("Screen capture from a remote window needs the claude2-cap extension installed in the local VS Code.");
    }
    throw error instanceof Error ? error : new Error(text);
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function runPowershell(exe: string, target: string): Promise<void> {
  const script = [
    // Without DPI awareness Windows reports the screen in scaled (logical) pixels — at 150%
    // scale that captured only the top-left two thirds of the desktop. Must run before any
    // screen metric is read.
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Claude2Dpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
    "[void][Claude2Dpi]::SetProcessDPIAware()",
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join("; ");
  return new Promise((resolve, reject) => {
    execFile(exe, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
      } else {
        resolve();
      }
    });
  });
}
