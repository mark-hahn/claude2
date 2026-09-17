# Claude2 Cap

Client-side companion to the Claude2 extension. It runs on the local VS Code
(extensionKind `ui`) and exposes one command, `claude2-cap.capture`, which
screenshots the Windows desktop with PowerShell and returns the PNG as base64.

The Claude2 extension calls this command when it is running in a remote
extension host (e.g. SSH to a Linux server) and therefore cannot see the
client's screen itself. Install this VSIX on the local (Windows) VS Code; the
deploy script at the repo root does this automatically.
