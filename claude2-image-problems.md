# Multiple images in a prompt — problems with the spec

**RESOLVED — this is now a record, not a question.** Answers given: (1) keep the old
appended sentence, path and all; (2) `<N>` is therefore not needed anywhere, since each
sentence carries its own path; (3) the stated default for persistence. Every "assumption"
below was taken as written. Pastes needed a sentence of their own, since the old one says
"a screenshot of the user's desktop" — they get `[An image is attached. Read the image file
<path> to view it.]`. Implemented.

---

## Blocking

### 1. "The final text should be shorter" contradicts how the image reaches Claude

> the final text appended to the end of the prompt text should be shorter
> - do this only if it doesn't affect context storage of the image
> - a screen cap should have the text `[Screen Capture <N>]` appended

Today the only thing that puts the picture in Claude's context is the **file path** in the
appended text (`src/extension.ts:850`):

```
[A screenshot of the user's desktop is attached. Read the image file /tmp/claude2-cap-… to view it.]
```

Claude then calls Read on that path. Replace it with a bare `[Screen Capture 1]` and the
image is gone from context — so the "only if" guard fails and, read literally, the whole
shortening is skipped. But then the rule asks for nothing, which can't be what you meant.

The three ways out are materially different amounts of work:

- **(a) Keep the path, shorten the wording.** e.g. `[Screen Capture 1: /tmp/claude2-cap-…png]`.
  Small diff, zero risk, works exactly as today. Not the literal text you asked for.
- **(b) Send the image as a real image block.** The CLI is already fed stream-json on stdin
  (`src/claudeCli.ts:194`), so `{type:"image", source:{type:"base64",…}}` can ride in the
  same user message and the appended text can then be exactly `[Screen Capture 1]`. This is
  the only branch that gives you both halves of what you asked for. Bigger change, and it
  needs verifying against this CLI version (image blocks on stdin, and what `--resume`
  writes into the transcript for a forked session).
- **(c) Drop the appended text entirely** and rely on (b) alone. Then nothing marks which
  image is which in the prompt text.

**Which?** My recommendation is (b), with (a) as the fallback if the CLI rejects image
blocks — but it's your call, because (b) touches the CLI plumbing and (a) doesn't.

### 2. `<N>` — numbered how?

`[Screen Capture <N>]` / `[Image <N>]` doesn't say what N counts. For a prompt holding
cap, paste, cap:

- per kind → `[Screen Capture 1] [Image 1] [Screen Capture 2]`
- by position in the prompt → `[Screen Capture 1] [Image 2] [Screen Capture 3]`

Position matters because the 🖼️ chars are deliberately identical, so the Nth char is the
only handle the user has on the Nth image. **Default if you don't answer: by position.**

### 3. Persistence has no home

> the images should be available to be shown persistently until the session is permanently
> deleted

Captures live in OS temp (`/tmp`, `C:\Windows\Temp` — `src/capture.ts:13-29`), which the OS
clears. "Persistent" means copying them somewhere the extension owns, and deleting them in
`SessionStore.remove` (`src/sessionStore.ts:103`). Not stated, and it decides whether a
reopened month-old session still shows its pictures.

**Default: copy into `context.globalStorageUri/images/<sessionId>/`, delete that directory
on permanent delete.** Note this leaves pre-existing sessions' old captures unrecoverable —
nothing was saved for them.

Related and unstated: **trashing** a session is not permanent deletion, so trashed sessions
keep their images. Confirm.

---

## Assumptions I'll take unless you say otherwise

1. **Scope is per session.** Cap and paste both happen inside one conversation, so the
   pending image list belongs to that session. Today `lastCapture`/`cropStack`
   (`src/extension.ts:82-85`) are window-global and shared across sessions; that goes away.
2. **Dupes** are matched on the image bytes, and only against the *pending* images of the
   same session — a picture identical to one in an already-submitted prompt is still added.
3. **The 🖼️ prefix is owned by the extension, not the typist.** The prompt box is a plain
   `<textarea>` (`src/webviews.ts:513`), so the chars are real text in it. If you type into
   or delete part of the prefix, it gets rewritten to match the actual image list on the
   next keystroke. Clicks are resolved by caret offset, so a click inside the prefix picks
   image N; ctrl-click there deletes it after a confirm.
4. **Ctrl-click delete** shows a modal naming the image's kind, its position, and its pixel
   size. Only pending images; submitted ones ignore the ctrl.
5. **The Cap pane keeps existing** but is only reachable by clicking a 🖼️ char, since the
   sidebar's Image button is going (`src/webviews.ts:75`, `115`, `170`). Its "Send Again"
   button goes too — it exists only to re-arm the old toggle.
6. **Cropping replaces the image in place**, keeping its position in the list and its 🖼️
   char; each image carries its own undo stack.
7. **Submitted images are read-only in the pane**: no crop, no undo, no delete — the hint
   line and the drag handler are disabled for them.
