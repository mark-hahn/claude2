# Workspace Instructions (Read First)

## display rules
- **only use Font sizes between 14px and 18px inclusive.** Both bounds are real: smaller
  is unreadable on this screen, larger breaks the column.
- **only use Solid black text, never gray.** Gray for de-emphasis fails against these
  backgrounds. Colour other than gray is fine — it is the washed-out grays that
  are the problem, not colour as such.

## Response style

- When asked to do a simple one-off action (generate a file, run a command), just do it and report completion in 1-2 lines.
- Don't produce research/investigation reports, format/byte-level breakdowns, or step-by-step narration of what you checked unless something went wrong or the user asked to see it.
- Save deep technical detail for when the user explicitly asks to understand or explain something.

## Documentation

- never modify CLAUDE.md or .github/copilot-instructions.md unless told to modify
  - exception: when i say to save a rule, add it to CLAUDE.md (and mirror it here)

## Remote server

- The remote server is **hahnca.com**.
- Use **SSH** to access the remote server (SSH keys are already available/configured).

## Where things run

## Button background colors in client panes

- when modifying files use local changes and don't replace entire files because another copilot conversation might be changing the same file

- don't read doc files in ./doc unless i tell you to

- never do a `find / ...`, it is too slow

- when a claude or copilot chat is in ask mode instead of agent mode and i give you instructions that include writing or changing something that means i made a mistake -- stop and tell me to use agent mode

- don't clean up debug logging until i tell you to

- never do git commit, push, pop, or anything else that modifies git repo unless i tell you to
- you can do git reads without permission

# more rules
- don't deploy anything -- i will deploy before i test

# conversation pane terminology
- the editor window is the entire vscode editor pane below the editor tabs
- the bar is the single line of prompt text in the conversation pane
- a block is the combination of a bar with the results below it
- a box is the text results in a block below the bar
- a pane is the conversation pane containing nothing but blocks
  - a pane does not include the prompt text editor or the stats/buttons to the right
  - a pane is always the full width of the editor window
- the prompt box is the text editor where prompt text is entered
- the footer is the stats/buttons to the right of the prompt box
  - the stats row is the top row in the footer with stats and no buttons
  - the model row is the second row with presets button and model/effort selectors
  - the nav row is the third bottom row with status indicator, stop, fork, load, and cap buttons

# claude.md instructions are authorative and copilot-instructions.md should always be a copy of claude.md
