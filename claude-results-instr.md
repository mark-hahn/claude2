
# new conversation results pane specs
- the results pane has prompt/response block displays
  - i'll call prompt/response blocks just blocks in these instructions
  - prompt/response pane with no prompt yet is empty
  - a block contains a prompt bar and results box below the bar
    - clicking the prompt bar toggles visibility of results box below it
      - same as current behavior
    - ctrl-clicking the prompt bar expands/contracts the prompt bar
      - it is a toggle
      - when expanded it shows the entire prompt text in prompt bar
      - when contracted it goes back to showing only one line
    - clicking anywhere in the results box toggles the visibility of all tool groups
      - it toggles all tool groups visibility in the entire results pane

- a non-empty results pane always has a block aligned with the top of the results pane
  - that top block is called the selected block
  - the prev/next buttons in footer scrolls results pane so prev/next block is selected
  - if the block height is smaller than the results pane height then:
    - more blocks will be shown below if there are any
  - if the block height is taller than the results pane height then:
    - if the prompt bar is expanded then it shows a maximum of 3 lines
      - the prompt text scrolls inside that bar
    - if the results box is displayed then it only shows the number of lines to fit in results pane
      - it scrolls within it's own box
      - when the selected block changes and results box is scrolling then results box scrolls to the bottom of the box

- remove the close all and open all buttons

- the old logic to move prompt bar contents to prompt edit box is replaced
  - now a button call `Load` is placed to the right of the next button
  - the load button prepends the text contents of the prompt editor with the top bar contents
    - it only prepends, not replaces
    - the prepended text has a blank line between it and the old text

## actions
- if these instructions are ambiguous, incomplete or contradictory then:
  - add the problem to claude2-results-pane.md and continue
  - do not stop -- see below
  - if you wrote questions to doc then when totally finished stop

- otherwise implement these instructions

- do not stop until totally finished 
  - when you document problems continue until all problems are found
  - when implementing keep going until all needed changes are written
  - do not worry about token cost
    - the budget is unlimited
  - take as long as necessary
    - use max effort for max thinking
  - if you have a question while impementing use your own judgement
    - do not stop
    - document any judgements you aren't sure about in claude2-results-judgements.md
    - we can change implemention later if a judgement is overriden
