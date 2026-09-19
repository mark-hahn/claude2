
# change to conversation pane behavior

## terminology in these instructions
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
  - the model row is the second row with stop button and model/effort selectors
  - the nav row is the third bottom row with status indicator, nav buttons, and load and cap buttons

## the current pane/block/bar/box/prompt editor/footer appearance/behavior is confusing
- i want to make it deterministic and unambiguous

## behavior/appearance not specified here should match the current behavior/appearance
- an example is bar hovering

## block rules:
- the bars always have a light-yellow background
  - same as it is now
- when the pane is non-empty there is always one selected block
  - the nav buttons ▲/▼/▲▲/▼▼ move the block selection up/down/top/bottom
  - the bar in the selected block has a light-red 2px border

## expanding/closing rules:
- clicking the bar toggles visibility of the box below it
  - same as current behavior
- clicking anywhere in the box toggles the visibility of the tool groups in its own text
  - this is the same as it is now except only in the one box
  - the default initial state is tool groups visible
  - the state of the tool visibility in the box is persistant until the extension is reloaded

## auto-scrolling rules:
- scrolling amount should be the minimum amount to follow these rules
- the pane contents should scroll so the selected bar is always visible
- if the box in the selected block is open then:
  - the block should be scrolled high enough that:
    - the entire box is visible when possible
    - at least one line of the box is showing
  - if the bar is at the top of the pane and it's box is partially hidden then:
    - the box contents should be scrollable
  - when box is opened the contents should always be scrolled to top

## manual scrolling rules:
- manual scrolling must always obey the auto-scrolling rules
- when hovering of a partially visible box the scroll wheel should scroll the box contents
  - when the box is scrolled as far as it can go the wheel should scroll the entire pane instead
- when hovering over the pane and not scrolling a box contents:
  - the mouse scroll wheel should scroll all contents of the pane

## there is a box visibilty exception when the selected bar is below line 1 of the pane:
- all boxes above the selected block are closed
  - this will show a list of bars above it to make is easy to see the bar to scroll to
- this is temporary and the box open state in each block is remembered
- blocks below the selected block are not affected by this exception
  - they will show the box based on their remembered open state

## scroll bars
- there should be no horizontal scroll bar anywhere
- the pane may contain a vertical scroll bar when needed
- a scrolling box may contain a vertical scroll bar when needed
  - this means there can be nested scroll bars
- the entire pane must always fit between the top of the editor window and the prompt editor below
  - this means the editor window should never have a scroll bar
  
## behavior/appearance not specified here should match the current behavior
- an example is bar hovering

## actions
- if these instructions are ambiguous, incomplete or contradictory then:
  - write the problems to claude2-pane-problems.md and stop
  - make no changes other than writing to claude2-pane-problems.md
- otherwise implement these instructions immediately
