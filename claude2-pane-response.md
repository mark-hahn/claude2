
# response to claude2-pane-problems.md
- i'm not going to answer specific problems from the problems doc
  - instead i'm going to list changes to claude2-pane-instr.md
    - make the minimum spec changes to add these new changes
  - integrate the changes and then restart the process of looking for problems
  - write the new list of problems in claude2-pane-problems2.md
  - if no problems go straight to implementation

## pane behavior changes
- only one block at a time has an open box
- when a block selection changes the newly selected block is opened
  - so old selection is closed
- clicking on a bar selects it's block
  - clicking the selected bar again will toggle the box open/closed
  - when the selected block is closed then all blocks will be closed 
  - when a block is opened or closed the scrolling should be the minimum possible
- at least 1 bar is shown above the selected block and at least 1 below 
  - only if the bars exist
  - there may be more than one above/below bar if block is short
  - clicking a above/below bar will move the selection up and down
    - this is a natural consequence of the other rules
  - the open block will follow the existing rules inside the bordering bars
    - an example is the selected bar is always visible
- when a box was closed and is opened then it should be scrolled to the bottom

## streaming rules
  - when a new prompt is entered and streaming starts then the new block is selected
    - selection can still change while streaming
  - if streaming block is closed then streaming is invisible
