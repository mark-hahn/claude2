# New prompt box: open questions

Each item has a suggested default. Reply "use the defaults" and I'll implement.

## 1. Load / Cap / File in read-only mode: what happens to the sent text?

The spec says these buttons switch the box to edit mode. It doesn't say whether the text is cleared (Ctrl-Enter clears it).

- **Keep the text:**
  - Load always inserts at the top of the box, so the loaded prompt lands *above* the sent one with a blank line between them. The box then holds two prompts.
  - File puts its `<name>` tag at the start of the sent text.
  - A Cap picture goes out with the old text if you send it again.
- **Clear the text:** the button acts as if Ctrl-Enter had been pressed first, then does its own job. Load gives you just the loaded prompt, and File and Cap start a fresh prompt.
- **Box size:** should these buttons also shrink a big box the way Ctrl-Enter does, or leave the size alone?
- **File:** should the switch happen on the click, or only after a file is picked? Cancelling the picker would otherwise still clear the box.

**Default:** clear the text and leave the size alone. File switches only once a file is picked.

## 2. A send that doesn't go through

If you press Ctrl-Enter during a run, a dialog asks "Interrupt Claude's unfinished response?". Answering No leaves the prompt unsent. An expired login or a bad model pick does the same. Today the extension puts the text back into the box, which Send had emptied. Under the new behavior the box was never emptied, so it would stay read-only on a prompt that never ran.

**Default:** switch back to edit mode with the text still there and the size unchanged.

## 3. Closed tab or VS Code restart

Switching between session tabs that are already open keeps everything, because each tab keeps its page alive. A session whose tab was closed starts a fresh page, and so does every session after a VS Code restart. The session saves only the box size today, so read-only mode would be lost and the box would come back empty in edit mode.

**Default:** save read-only mode with the session, the same way box size is saved. When the session reopens in read-only mode, show its last prompt read-only.

## 4. Pasting a picture (Ctrl-V) in read-only mode

This is the keyboard version of Cap, but it is also a paste into a box that "cannot be modified".

**Default:** ignore it in read-only mode. Press Ctrl-Enter first.

## Notes (no answer needed)

- New sessions start in big-box mode today (`bigPrompt: true` in `sessionStore.create`). I'll change that to small.
- Ctrl-click lost its big-box toggle when the box moved to Monaco, where Ctrl-click now adds a cursor. Ctrl-Alt-click will be new wiring, and it will block Monaco's own handling of that click.
