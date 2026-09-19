
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
- only one block at a time has an open box
- when the block selection changes the newly selected block is opened
  - so the previously selected block is closed
- clicking on a bar selects its block
  - clicking the selected bar again will toggle the box open/closed
  - when the selected block is closed then all blocks are closed
- when a block is opened or closed the scrolling should be the minimum possible
- clicking anywhere in the box toggles the visibility of the tool groups in its own text
  - this is the same as it is now except only in the one box
  - when a closed box is opened its tool groups are always hidden
  - the streaming box is the exception: it always shows tool groups, even when the box is clicked
    - when streaming finishes the box responds to clicks again and follows the rule of
      having tool groups hidden when the box is opened

## auto-scrolling rules:
- scrolling amount should be the minimum amount to follow these rules
- the pane contents should scroll so the selected bar is always visible
- at least 1 bar is shown above the selected block and at least 1 below
  - only if the bars exist
  - there may be more than one above/below bar if the block is short
  - clicking a above/below bar will move the selection up and down
    - this is a natural consequence of the other rules
  - the open block follows the rules below inside the region between the bordering bars
    - the region is the pane area between the bordering bars, or the pane edge on a side with no bar
- if the box in the selected block is open then:
  - the block should be scrolled high enough that:
    - the entire box is visible when possible
    - at least one line of the box is showing
  - if the box does not fit in its region then:
    - the box is clamped to the space remaining in the region and its contents are scrollable
  - when a box was closed and is opened then it should be scrolled to the bottom

## manual scrolling rules:
- manual scrolling must always obey the auto-scrolling rules
- manual scrolling never changes the block selection
  - the selection changes only through bar clicks and the nav buttons
  - this is a natural consequence of the other rules
- when hovering of a partially visible box the scroll wheel should scroll the box contents
  - when the box is scrolled as far as it can go the wheel should scroll the entire pane instead
- when hovering over the pane and not scrolling a box contents:
  - the mouse scroll wheel should scroll all contents of the pane

## streaming rules
- when a new prompt is entered and streaming starts then the new block is selected
  - selection can still change while streaming
- if the streaming block is closed then streaming is invisible

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
  - write the problems to claude2-pane-problems2.md and stop
  - make no changes other than writing to claude2-pane-problems2.md
- otherwise implement these instructions immediately
