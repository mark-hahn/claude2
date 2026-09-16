# Workspace Instructions (Read First)

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

