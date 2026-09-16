
# claude code extension for vscode rewrite
- i want a vscode extension called Claude2 that mimics the claude code vscode extension

## the sidebar
- it opens new claude webview editors for conversation sessions
  - a `+` button at the top of the sidebar opens a new claude editor
    - the editor always opens in the default vscode tab group
    - this is the first of 3 buttons in the top button row of the sidebar
      - the 3 buttons are `+`, `Instr`, and `$` (see below)
  - it manages stored claude sessions with a list under the button row
    - the list scrolls
    - each session is the list has one card in the list
      - the card can be more than one line so entire name is shown
    - clicking on a card reopens it's conversation editor
      - it always opens in the default vscode tab group
    - sessions have names
      - the session is named by claude when first prompt is entered
      - names can be edited by long-pressing the card
- it opens management panes in a shared webview editor:
  - the management panes occupy one editor tab and replace each other, the panes are:
    - claude quota plan usage pane
      - top of sidebar has a `$` button to open this pane
      - see quota-plan-monitor.md for details on the pane
    - claude.md editing pane
      - top of sidebar has a `Instr` button to open this pane
      - see instruction-editor.md  for details on the editor

## the conversation editors
- it has multiple claude2 editors that are shown in vscode editor tabs
- it should have a scrolling prompt/response display above the prompt box
  - it shows each prompt in a single bar the width of the window
    - the bar should have a light-yellow background
    - the bar should be one char tall
    - the prompt text in the bar should be cropped to one line with possible `...`
  - all the historical prompt bars in a conversation should be stacked at the top
    - when a prompt is submitted a new bar is created 
        it is added below the bar stack
        - it starts closed
    - when navigation controls are used different bars scroll to top (see below for nav)
      - before first prompt is entered the response pane is empty
      - after a prompt is entered there is always a bar at the top of the scrolling box
  - the responses for old prompts are usually hidden
    - an active reponse being streamed is shown below the bottom bar
    - a response for an old prompt can be displayed
      - it is displayed below the prompt bar that generated it
      - it is shown when the prompt bar is clicked
        - the click is a toggle the shows/hides the response
  - the can be multiple responses showing at once

  - a prompt editor input box is below the prompt/conversation text box
    - the prompt is edited in the box
      - it submits the prompt when focused and ctrl-return is pressed
      - regular returns just add eol chars
    - you can load old prompts into the prompt editor box
      - nav button `Prev` load boxes with old prompts one at a time
        - nav button `Next` goes down to newer prompts
      - if an old prompt is edited in the box that text becomes new prompt text
        - old prompts never change
        - when an old prompt is edited the prompt/response list scrolls to bottom

  - a status/control bar is below the prompt input box, it has:
    - claude conversation controls:
      - it selects a claude model in a selector input
      - it selects an effort level in a selector input
      - it has a button `Stop` to interrupt response
    - claude conversation status:
      - it shows tokens in/out total for the conversation
      - it has the total context window size for the session
      - it has the context window size used
      - a prominent indicator should show when a response is finished
        - an existing ui like claude code has no way to easily tell when a response is finished
    - claude prompt/response navigation:
      - `Top` button scrolls to top
      - `Up` button scrolls up one prompt
      - `Down` button scrolls down one prompt
      - `Bottom` button scrolls to bottom

## claude communications
- it should use graft
  - this is already installed and you shouldn't have to do anything
- prompts and responses flow through a cli interface, not the api
  - see using-cli-for-claude.md -- it is from another working project
  - increase max tokens to 256K

## actions
- if these instructions are ambiguous, incomplete or contradictory then:
  - add the problem to claude2-problems.md and continue
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
    - document any judgements you aren't sure about in claude2-judgements.md
    - we can change implemention later is a judgement is overriden
