# The Instructions editor pane

A description of how the finance app's Instructions pane looks and behaves,
written so the same pane can be built in another project. Source of truth in
this repo: `web/src/components/InstructionsEditor.vue`, the hosting code in
`web/src/App.vue`, the two routes in `server/src/routes.js`, the file helpers
in `server/src/rules.js`, and the styles in `web/src/style.css`.

## What it is

A single-file text editor that edits one markdown file on the server's disk.
In the finance app the file is `docs/ledger-rules.md`, about 200 lines of
markdown with SQL in it. The pane is not a copy of the file kept in sync with
it. It *is* the file: opening the pane reads the file off disk, pressing Save
writes it back. There is no second store (no database column, no cache) that
could hold a different answer.

Nothing reaches disk until Save is pressed. This is deliberate and differs
from the app's prompt box, which saves as you type. A rules file is not a
draft: an edit landing on disk mid-sentence would be what the next checker run
and the next LLM turn read.

## Where it lives in the app

The app shell is three regions left to right, all the height of the window,
and the page itself never scrolls:

1. A 300px button column on the left.
2. A 450px conversation column.
3. The pane: everything to the right, which takes whatever is left.

The top of the button column is a row of five workspace buttons: `$`, an
import arrow glyph, `Instr`, `Cat`, `Alias`. The two glyph buttons keep their
natural width; the three word buttons share the rest in equal thirds
(`flex: 1 1 0; min-width: 0`) with 5px side padding so "Instr" fits.

Pressing `Instr` opens the Instructions editor in the pane region. While any
workspace pane is open, the conversation column is greyed
(`opacity: 0.38; filter: grayscale(1)`) and gets the HTML `inert` attribute so
it takes no clicks or focus. Pressing `Instr` again while the pane is open
closes it, the same as its own Close button. Pressing a different workspace
button switches panes.

The component is mounted with `v-if`, so it is destroyed when closed. It has
no KeepAlive. That is why it has to guard every exit: unsaved text does not
survive a close. (The category and alias editors in the same app are the
opposite: kept alive, never block a close, and their column button turns light
red while they hold unsaved work.)

## Layout of the pane

The pane region has `padding: 28px 32px` and is a column flexbox. Inside it,
the editor is a column flexbox with `flex: 1; min-height: 0` and
`max-width: 900px`. (Other editors in the app cap at 760px. This one is wider
so the file's own roughly 80-column wrapping is not re-wrapped into something
that looks nothing like what a diff will show.)

Top to bottom:

**Title row** (`flex: none`, `margin-bottom: 16px`, `gap: 12px`,
`align-items: center`):

- Left: an `<h1>` reading **Instructions**. 24px, weight 600, letter-spacing
  -0.01em, no margin.
- Right, pushed hard right with `margin-left: auto` on a wrapper div, in
  this order with 12px gaps:
  1. A status hint (see below), muted colour, 14.4px. Hidden when empty.
  2. **Save** button. Disabled unless there are unsaved changes and no save
     is in flight. Reads `Saving…` while a write is in flight.
  3. A **⇊** glyph button, title and aria-label "Scroll to bottom", weight
     600, padding 7px 12px. Disabled while loading.
  4. **Close** button.

  The right group is one wrapper, not two auto margins. With the hint hidden
  the buttons still have to stay hard right, and two auto margins would split
  the free space between them.

**The field** (a `<label>` that is a column flexbox with `gap: 5px`,
`flex: 1; min-height: 140px` so it takes all remaining height):

- A small label above the box showing the file path, `docs/ledger-rules.md`,
  in 14.4px uppercase, weight 600, letter-spacing 0.04em, muted colour.
- A `<textarea>` bound to the text. `flex: 1`, `resize: none`, `width: 100%`,
  `spellcheck="true"`, disabled while loading. Monospace
  (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`), 14px,
  line-height 1.6, `tab-size: 2`. Surface background, 1px border, 8px radius,
  padding 9px 11px. On focus the border goes transparent and a 2px accent
  outline with -1px offset takes its place.

**Error note**, only when an error is set: a `<p>` under the box with a
surface background, 1px border, a 3px left border, 8px radius, padding
10px 14px, 16.8px text, `margin: 16px 0 0`. In the error variant the
background is the app's error wash (`#fdecec`).

**The leave dialog**, only when asking: a fixed full-window backdrop
(`rgba(0,0,0,0.4)`, `display: grid; place-items: center; padding: 24px`)
holding a card (`max-width: 380px`, page background, 1px border, 12px radius,
padding 22px 24px, shadow `0 12px 40px rgba(0,0,0,0.25)`). The card holds one
paragraph and a right-aligned button row with 10px gaps:

> **docs/ledger-rules.md** has unsaved changes. Save them, or throw them away?
>
> `Cancel`  `Discard`  `Save`

`Discard` carries the `danger` class, which only changes its hover wash from
8% ink to 18% ink. `Save` reads `Saving…` and is disabled while a write is in
flight.

The whole app is monochrome: every ink, border and accent token is black on a
near-white page (`#f9f9f7`) and surface (`#fcfcfb`). Buttons are 16.8px,
surface background, 1px border, 8px radius, padding 7px 14px. Hover is an 8%
ink wash over the surface. Disabled is `opacity: 0.4`. Light mode is pinned
regardless of the system setting.

## State

| name | type | meaning |
|---|---|---|
| `text` | string | what the textarea shows |
| `settled` | string | what the server last confirmed the file holds |
| `dirty` | computed | `!loading && text !== settled` |
| `version` | plain variable, not reactive | the server's `mtime:size` string as of `settled` |
| `loading` | bool | true until the first read returns |
| `saving` | bool | a write is in flight |
| `error` | string or null | shown under the box |
| `savedAt` | Date or null | set on each successful save |
| `overwrote` | bool | the last save landed on top of an outside edit |
| `path` | string | file path shown as the field label and in the dialog; defaults to `docs/ledger-rules.md`, overridden by what the server sends |
| `asking` | bool | the leave dialog is up |
| `answer` | plain variable | the resolve function of the promise `leave()` handed out |

`dirty` is the one signal that matters: text here that the file has not got
yet. Everything else (Save enabled, the hint, the dialog, the unload guard)
hangs off it.

The status hint, in priority order:

1. loading: nothing
2. dirty: `Unsaved changes`
3. `overwrote`: `Saved over a change made on disk`
4. `savedAt` set: `Saved to docs/ledger-rules.md`
5. otherwise nothing

## Behaviour

### On mount

1. `GET api/instructions`. Set `text` and `settled` to the returned text,
   `version` to the returned version, `path` if one is returned. On failure,
   set `error` to the message. Either way clear `loading`.
2. After the next render tick (the textarea has no height to scroll until the
   text is in it, and the disabled flag has to clear in the same flush), scroll
   the textarea to the bottom. The file is long and new rules go at the end of
   a section, so the bottom is where most edits start.
3. Add a `beforeunload` listener on window (the unsaved-text guard) and a
   `keydown` listener on window (Escape for the dialog).

### On unmount

Remove both window listeners, then call `decide(false)`. Anyone still waiting
on the dialog is told to stay: the pane is going away regardless, and a late
yes must not set off a second departure.

### Save

Triggered by the Save button, by Ctrl-S or Cmd-S inside the textarea (default
prevented, because the browser would otherwise offer to save the page), and
by the dialog's Save.

```
save():
  if not dirty  -> return true      (nothing to write)
  if saving     -> return false     (one write at a time; the button is disabled too)
  sending = text                    (captured, in case typing continues during the write)
  saving = true
  try
    res = PUT api/instructions { text: sending, version }
    version  = res.version
    settled  = sending
    savedAt  = now
    overwrote = (res.stale === true)
    error = null
    return true
  catch e
    error = "Could not save: " + e.message
    return false
  finally
    saving = false
```

Capturing `sending` matters: if the person keeps typing while the write is in
flight, `settled` becomes what was actually written, so the pane goes dirty
again for the keystrokes that came after.

### Scroll to bottom

Sets `scrollTop = scrollHeight` on the textarea. Only the scroll: caret and
focus stay where they were.

### Leaving with unsaved text

Every way out of the pane goes through one function, `leave()`, which returns
a promise of a boolean: true means go, false means stay. The component exposes
it (`defineExpose({ leave })`) and the host calls it through a template ref
before doing anything that would take the pane down.

```
leave():
  if not dirty -> resolve true immediately
  decide(false)          (a second ask supersedes the first: the earlier caller
                          is told to stay and the later one gets the answer.
                          The backdrop stops the mouse doing this; a keyboard can.)
  asking = true
  return new Promise(resolve => answer = resolve)

decide(go):
  asking = false
  resolve = answer; answer = null
  resolve?.(go)

discard():                (dialog's Discard)
  text = settled          (thrown away here, not left for unmount: whoever asked
                           may ask again on the way out, and with the text back to
                           what the file holds there is nothing left to ask about)
  decide(true)

saveAndLeave():           (dialog's Save)
  decide(await save())    (a failed save keeps the pane: the error is under the
                           box and the text is still there to try again with)

close():                  (the pane's own Close button)
  if await leave() -> emit('close')

dialogKeys(e):            (window keydown)
  if asking and e.key === 'Escape' -> preventDefault; decide(false)

backdrop click (on the backdrop itself, not the card) -> decide(false)
```

The Cancel button, Escape, clicking the backdrop and the pane unmounting all
resolve false. Discard resolves true after restoring the text. Save resolves
true only if the write succeeded.

### Browser reload or tab close

The `beforeunload` handler: if dirty, `preventDefault()` and set
`returnValue = ''`. The browser puts up its own "leave site?" prompt. The
wording is the browser's; only the fact that it asks is ours.

## The host's side (App.vue)

```
const instrPane = ref(null)
async function mayLeave() {
  return instrPane.value ? instrPane.value.leave() : true
}
```

`mayLeave()` is awaited, and a false return aborts the action, at the start of
every action that would replace or remove the pane:

- `openWorkspace(pane)`: the Instr button itself and the other four workspace
  buttons.
- selecting a prompt button in the column
- the `+` (new prompt) button, before the row is created, so a refusal does not
  leave a button behind
- the copy (duplicate prompt) button
- the JS (show code) button, when a workspace pane is open
- the import report asking the alias editor to open on a payee

The component is rendered as:

```
<InstructionsEditor v-if="workspace === 'instructions'" ref="instrPane" @close="workspace = null" />
```

The `close` event needs no guard of its own because the component only emits
it after its own `leave()` said yes.

## The API

**`GET api/instructions`** returns

```json
{ "text": "<file contents, trimmed>", "version": "1757900000000:8123", "path": "docs/ledger-rules.md" }
```

`version` is `Math.floor(mtimeMs) + ':' + size` from a stat of the file. It
is cheap to compute and moves for any edit, including one made outside the app
by a text editor or a git checkout, which is the whole point. It is `''` when
the file is absent, so a first write still registers as a change. An absent
file is not an error on read: `text` is `''`.

**`PUT api/instructions`** with body `{ text, version }` returns

```json
{ "ok": true, "version": "<new mtime:size>", "stale": false }
```

Server logic:

```
had   = current version from stat
stale = typeof sent === 'string' && sent !== '' && sent !== had
write the file
respond { ok: true, version: new version from stat, stale }
```

Writing: newlines are forced to LF (`replace(/\r\n?|\n/g, '\n')`) because a
textarea round trip can hand back CRLF and the file is LF in git; writing CRLF
would show every line rewritten in a diff. A trailing newline is added if
missing so the file stays POSIX-shaped.

`version` is advisory and optional. When the page sends one that is no longer
current the write still lands. A person watching the box they are typing in
is the better authority on what belongs there. But the reply says so
(`stale: true`) and the page shows `Saved over a change made on disk` rather
than letting an outside edit vanish unmentioned. Nothing else is invalidated
or re-checked on save.

The API path is relative (`api/instructions`, no leading slash) so the same
build works mounted at `/` and under a sub-path behind a reverse proxy. The
client throws `new Error(payload.error ?? <status description>)` on a non-2xx
response, which is what the `Could not save:` message carries.

## Things a reimplementation should keep

- One store: the file. Read on open, write on Save, nothing in between.
- `dirty = text !== settled`, where `settled` is what the server confirmed.
  Do not track dirty with a flag set on input; compare the strings.
- Capture the text being sent before the await, and set `settled` to that,
  not to the current text.
- A single `leave()` promise that every exit path awaits, including the
  host's, with a superseding ask resolving the earlier one false.
- Discard restores the text before resolving, so a second ask on the way out
  has nothing to ask about.
- Save failure keeps the pane open with the error shown; the text is intact.
- Ctrl-S / Cmd-S in the box saves and does not reach the browser.
- Open scrolled to the bottom; the ⇊ button gets back there without moving
  the caret.
- Version as `mtime:size`, advisory: never refuse a write, only report
  staleness.
- LF normalisation and trailing newline on write.
- `beforeunload` guard while dirty.
