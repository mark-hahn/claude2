# Claude2 Results Pane Judgements

- Treated each contiguous run of bold tool-call lines in a response as one tool group, because responses currently store tool calls as formatted text lines rather than structured blocks.

## From the bug-fix pass (2026-09-16)

- Opening a non-empty conversation selects the newest block (response open, scrolled to bottom); the instructions don't say which block starts selected.
- A click in a response box that ends a text-selection drag does not toggle tool groups, so response text stays copyable.
- Selecting a block manually right after submitting a prompt cancels the queued auto-jump to the not-yet-arrived turn; the arriving turn still gets selected when streaming starts.
- Up/Down were left identical to Prev/Next (both move the selection one block); the instructions only redefine Prev/Next, and nothing distinct is specified for Up/Down.