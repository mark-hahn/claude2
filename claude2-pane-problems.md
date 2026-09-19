# Problems found in claude2-pane-instr.md

Two blocking problems and two minor clarifications. Everything else in the
instructions is implementable as written. Assumptions I would adopt are listed
at the end so you can veto any of them.

## 1. Clicking a bar above the selected block contradicts the box-visibility exception (blocker)

- "clicking the bar toggles visibility of the box below it — same as current behavior"
  (expanding/closing rules). Current behavior: clicking a NON-selected bar toggles its
  box in place and does NOT move the selection.
- The exception says all boxes above the selected block are closed.

These collide: after moving the selection with ▲/▼, bars above the selected block stay
visible and clickable, but their boxes can never show while they are above the
selection. A click on such a bar would silently toggle the remembered open state with
no visible effect — a dead click.

Possible resolutions (pick one):
- (a) Clicking a bar also selects its block. The clicked box then opens normally.
  Side effect: clicking a bar BELOW the selection also moves the selection down, which
  closes every box above it — including the box you may have just been reading.
- (b) Clicking a bar above the selection selects it; clicking a bar at/below the
  selection keeps current behavior (toggle in place, selection unchanged). No dead
  clicks, and reading-context below is never collapsed by a click above.
- (c) A click overrides the exception for that one box (it shows even though it is
  above the selection).
- (d) Keep the dead toggle (click only flips remembered state).

## 2. "Below line 1 of the pane" is undefined (blocker)

The terminology section defines bar/block/box/pane but not "line 1 of the pane".
Two readings:

- Reading A — document position: the exception applies whenever any block exists above
  the selected block, i.e. always except when the first block is selected.
  Consequence: whenever the NEWEST block is selected (the normal resting state, and
  always during a run), every older box is forcibly hidden. You can never see an older
  box and the newest box at the same time; opening an older box requires moving the
  selection up to it first. (Blocks below the selection are unaffected, per the spec.)
- Reading B — viewport position: the exception applies when the selected bar is not the
  top visible line of the pane. This is circular — closing the boxes above changes the
  layout, which changes what is on line 1 — and it fights the current
  scroll-selects-the-top-visible-block behavior: during a manual scroll the selected
  bar is always at line 1, so the exception would keep switching off and on with large
  layout jumps each flip.

Recommendation: Reading A. Please confirm (or define the trigger differently).

## 3. Minor: "when box is opened the contents should always be scrolled to top" vs. navigation

Currently, navigating the selection to another block scrolls that block's open box to
the BOTTOM. Under the exception, moving the selection UP reveals a box that was
suppressed — that arguably counts as "opened", so it scrolls to top. Moving the
selection DOWN lands on a box that was already visible — not an "open", so the
unspecified-means-current rule keeps the scroll-to-bottom. Result: ▲ lands at the top
of a box, ▼ lands at the bottom. Say which you want:
- (a) that direction-dependent behavior is fine
- (b) navigation always lands a box scrolled to top
- (c) navigation keeps each box's previous scroll position

## 4. Minor: "hovering over a partially visible box" — which boxes?

Only the selected block's box ever gets an inner scrollbar (when the bar is at the top
of the pane and the box does not fit). A non-selected box that is merely cut off by the
viewport edge has no scrollable contents. I read the manual-scrolling rule as applying
only to boxes that actually have an inner scrollbar; wheel over any other box scrolls
the pane. Making EVERY partially visible box inner-scrollable would force height clamps
onto non-selected blocks, contradicting "blocks below the selected block ... show the
box based on their remembered open state". Confirm the narrow reading.

## Assumptions I will implement unless corrected

- Manual scrolling keeps the current behavior of re-selecting the top visible block;
  that is what makes "manual scrolling must obey the auto-scrolling rules" satisfiable
  (the selected bar can never leave the viewport because the selection follows it).
- When the selected block (bar + open box) fits in the pane, auto-scroll moves the
  minimum distance to bring the whole block into view. When it does not fit, the bar is
  scrolled to the top of the pane and the box is clamped to the remaining height with
  its own vertical scrollbar.
- "Light-red 2px border" on the selected bar will be drawn as an inset outline so bars
  do not change size when selected.
- Per-box tool-group visibility state lives in the extension process (keyed by session
  and turn), so it survives closing/reopening the conversation tab and resets only when
  the extension reloads.
- A streaming (active) turn keeps the current behavior: its box opens scrolled to top
  (it is empty at that moment) and then follows the bottom while new text arrives.
