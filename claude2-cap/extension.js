// UI-side half of Claude2's screen capture. This extension is extensionKind "ui", so it always
// runs on the client machine; the workspace-side Claude2 extension on a remote server reaches it
// with executeCommand('claude2-cap.capture'), which VS Code proxies across extension hosts. The
// return value crosses that proxy, so it is a base64 string rather than a Buffer.
const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claude2-cap.capture", () => captureDesktop()),
  );
}

function captureDesktop() {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("claude2-cap can only capture on a Windows client."));
      return;
    }
    const file = path.join(os.tmpdir(), `claude2-cap-${Date.now()}.png`);
    const script = [
      // Without DPI awareness Windows reports the screen in scaled (logical) pixels, cropping
      // the capture at high-DPI scale factors. Must run before any screen metric is read.
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Claude2Dpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
      "[void][Claude2Dpi]::SetProcessDPIAware()",
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
      "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
      `$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join("; ");
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

function deactivate() {}

module.exports = { activate, deactivate };
