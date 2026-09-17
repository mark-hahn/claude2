import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

// Captures the client's desktop and returns the path of a PNG readable from this extension host.
// Three hosts, three routes: on Windows the extension host can run PowerShell directly; in WSL it
// crosses interop to the same PowerShell through /mnt/c; on a remote server nothing local can see
// the client's screen, so it asks the claude2-cap UI extension on the client for the pixels.
// hideWindow minimizes the VS Code window for the length of the shot, for a picture of what it
// was covering. All three routes end in the same PowerShell, so all three can hide.
export async function captureScreen(hideWindow = false): Promise<string> {
  const name = `claude2-cap-${Date.now()}.png`;
  if (process.platform === "win32") {
    const file = path.join(os.tmpdir(), name);
    await runPowershell("powershell.exe", file, hideWindow);
    return file;
  }
  if (isWsl()) {
    // PowerShell writes on the Windows side of the mount; the same file reads back through /mnt/c.
    await runPowershell("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", `C:\\Windows\\Temp\\${name}`, hideWindow);
    return `/mnt/c/Windows/Temp/${name}`;
  }
  const base64 = await remoteCapture(hideWindow);
  const file = path.join(os.tmpdir(), name);
  await fs.promises.writeFile(file, Buffer.from(base64, "base64"));
  return file;
}

async function remoteCapture(hideWindow: boolean): Promise<string> {
  try {
    const base64 = await vscode.commands.executeCommand<string>("claude2-cap.capture", hideWindow);
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

// How long the desktop gets to itself once the window is minimized: the minimize animation has to
// finish and whatever was behind it has to repaint before the screen is worth copying.
const hideSettleMs = 700;
// ShowWindow commands, from winuser.h.
const swMinimize = 6;
const swRestore = 9;

// user32 is doing three unrelated jobs here, so one interop class carries all of them: DPI
// awareness for the capture, and minimize/restore for hiding the window that asked for it.
const winApi =
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Claude2Win { " +
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); ' +
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); ' +
  '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }\'';

function captureScript(target: string, hideWindow: boolean): string[] {
  const shot = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ];
  // Without DPI awareness Windows reports the screen in scaled (logical) pixels — at 150%
  // scale that captured only the top-left two thirds of the desktop. Must run before any
  // screen metric is read.
  const lines = [winApi, "[void][Claude2Win]::SetProcessDPIAware()"];
  if (!hideWindow) {
    return [...lines, ...shot];
  }
  // The foreground window is the one the user just clicked Cap in. Restoring happens in a finally
  // so a capture that throws still gives the window back rather than leaving it in the taskbar.
  return [
    ...lines,
    "$hwnd = [Claude2Win]::GetForegroundWindow()",
    `[void][Claude2Win]::ShowWindow($hwnd, ${swMinimize})`,
    `try { Start-Sleep -Milliseconds ${hideSettleMs}; ${shot.join("; ")} } ` +
      `finally { [void][Claude2Win]::ShowWindow($hwnd, ${swRestore}); [void][Claude2Win]::SetForegroundWindow($hwnd) }`,
  ];
}

function runPowershell(exe: string, target: string, hideWindow: boolean): Promise<void> {
  const script = captureScript(target, hideWindow).join("; ");
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
