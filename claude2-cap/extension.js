// UI-side half of Claude2's screen capture. This extension is extensionKind "ui", so it always
// runs on the client machine; the workspace-side Claude2 extension on a remote server reaches it
// with executeCommand('claude2-cap.capture'), which VS Code proxies across extension hosts. The
// return value crosses that proxy, so it is a base64 string rather than a Buffer.
const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claude2-cap.capture", (hideWindow) => captureDesktop(hideWindow === true)),
  );
}

function captureDesktop(hideWindow) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("claude2-cap can only capture on a Windows client."));
      return;
    }
    const file = path.join(os.tmpdir(), `claude2-cap-${Date.now()}.png`);
    const script = captureScript(file, hideWindow).join("; ");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || "").trim() || error.message));
        return;
      }
      fs.readFile(file, (readError, data) => {
        fs.unlink(file, () => undefined);
        if (readError) {
          reject(new Error(`Could not read the capture file: ${readError.message}`));
          return;
        }
        resolve(data.toString("base64"));
      });
    });
  });
}

// Kept in step with the same script in the workspace extension's capture.ts: the remote route runs
// here instead of there, and a capture that differed between routes would be a bug nobody sees.
function captureScript(target, hideWindow) {
  const shot = [
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    `$bmp.Save('${target}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ];
  // Without DPI awareness Windows reports the screen in scaled (logical) pixels, cropping
  // the capture at high-DPI scale factors. Must run before any screen metric is read.
  const lines = [winApi, "[void][Claude2Win]::SetProcessDPIAware()"];
  if (!hideWindow) {
    return lines.concat(shot);
  }
  // The foreground window is the one the user just clicked Cap in. Restoring happens in a finally
  // so a capture that throws still gives the window back rather than leaving it in the taskbar.
  return lines.concat([
    "$hwnd = [Claude2Win]::GetForegroundWindow()",
    `[void][Claude2Win]::ShowWindow($hwnd, ${swMinimize})`,
    `try { Start-Sleep -Milliseconds ${hideSettleMs}; ${shot.join("; ")} } ` +
      `finally { [void][Claude2Win]::ShowWindow($hwnd, ${swRestore}); [void][Claude2Win]::SetForegroundWindow($hwnd) }`,
  ]);
}

function deactivate() {}

module.exports = { activate, deactivate };
