
fork prompt

compaction indicator

change prompt bar to 2 lines if needed.

never lose prompt typing

show model in prompt bar

compacting indicator

stack prompt blocks when room

======================

# new editor page footer
- change top buttons row
  - remove send button
  - move stop to left of model selector
- change bottom buttons row
  - replace top, bottom, prev, and next buttons
    -the new should be ▲ (was prev), ▼ (was next), ▲▲ (was top), and ▼▼ (was bottom)

- add a model change button `M` to the right of stop button
  - style should match status letter button
  - it should cycle through these fixed model/effort settings:
    - claude-opus-5 and high
    - claude-fable-5 and xhigh
- normal selectors of model/effort should be unchanged
- default should be the same claude-opus-5 and high

remove diag line from credits graph

which of these do our stats use: usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, and usage.cache_creation_input_tokens

change current stats:
`tokens 79 in / 28,974 out | context 100,107 / 256,000 | turns 8/200`.
Shorten text, remove tokens, add total_cost_usd summed over conversation, duration_ms live summed over conversation: 
`ctx 100K/256K | turns 11/50 | $1.32 | 0.3 secs`.
note the ctx is now in K

- add a button `Cap` to the right of the load button.
- when clicked:
  - take screen shot of the windows destop
  - include it in next prompt submitted
  - the button should toggle to remove it from submit
- use methods you just described for screenshot
  - for windows use simple screenshot
  - for wsl use /mnt/c
  - for remote linux use second extension
    - put extension code in this workspace
    - create a monorepo for these 2 extensions

move everything in the footer lines below the prompt editor to the right of that editor so the editor bottom is at the bottom of the window

the results scrolling container height isn't responsive to editor size changes

when the model or effort is changed in session then that should be persistant for every opening of the session later

# search input box
- add a text input box searchBox below the 2 button rows in sidebar
  - but an X button to the right of it
    - X should clear the searchBox
- when text is entered and enter key is pressed then enter search mode:
  - the searchBox background should be light-blue when in search mode
  - show session card for each session with a search match:
    - a search match is when the search text matches:
      - text in the session name
      - text in the results text of the session
        - search both the prompts and the results
        - when results text matches then show the number of matches in the card
          - don't show the match count message when there is no match in a response
            - this indicates match must be in the name
          - the match count message should have blue text
    - show matching sessions from trash also
      - trash cards should sort below the non-trash cards
  - in search mode the editor pane should show a light-blue background on every line with matching text
- there are several ways to exit search mode:
  - when searchBox is cleared with X button 
  - when searchBox is cleared by manually editing and return key
  - when any button in sidebar is used
  - after exiting search mode everything in UI should return to normal
  - clicking on a session card should not clear search mode
    - session editors should open as normal
    - you need to be able to see highlighted lines in responses

show results as markdown live while streaming

session card stays highlighted when no editor selected

i might be wrong but generating the results seems slower than in the claude extension

scrolling is not sticky in results scrolling box

when an editor pane is focused move the matching selected session card into view

highlight session card with light-yellow background for currently selected session editor

add a button `md` between + and close
-- when clicked display the selected response box text formatted as markdown in the management pane

describe status variables available from response, like turns, context, etc, and whether they are for the entire conversation or just the last response. which would be useful for display and whether they should be total or last response?

- always show tool groups in active streaming results for latest prompt even if tools are hidden in old results.
  - this is to follow the session resultstreaming better
- when clicking on a bar that isn't the selected bar then expand it in-place without changing selection.

when removing the tool groups show the first line of text at the top of the results box and then only show single blank linesin text, not multiple lines

i gave the instructions in claude-results-instr.md to another llm and it made the changes detailed in claude2-results-changes.md
-- check the work it did for correctness in following the instructions and look for bugs it created

remove up/down buttons

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

trash mode when hovering over session card add trash icon to session card that totally deletes that session -- now all session cards have trash icons when hovered

remember font size for management and conversation panes

management buttons should toggle between management pane and conversation pane

when session has no submitted prompts (is empty) and the name is not `New session` and the prompt editor had a draft and the draft was cleared then delete the session

when + button is clicked focus the prompt editor

when a session card is long-pressed the edit session name inline

# sidebar button changes
- organize the buttons into 2 rows at top of sidebar:
  - the top row is the management row, it has $, instr, and graft buttons in that order
  - the second row is the session row, it hs + and trash buttons in that order
- add a new button `Close` that closes all session tabs other than current
  - put it to between the + and trash buttons

show tool names at beginning of tool line like `Bash:` in bold
-- remove blank lines between tool lines but keep blank lines around batches of tool lines

what is the file count and line count of source files in this workspace

cut the height of the prompt editor input box in half - remove the prompts count in the prompt card in sidebar

add a button to top footer row `Graft` that opens a management pane with the graft viz html -- it should be live like a normal browser

when i click $ and the `Plan quota over time` pane is opened i get:
`Parse Error: JS Exception
Nothing recorded yet...`

response scrolling should be sticky -- only scroll when at the bottom

when hovering over a prompt card show a trash can icon in bottom right -- it should move that conversation into persistent trash storage -- add a button to the right of the $ called `Trash` that shows only sessions in the trash -- the trash button should toggle -- it should have a light-red background when trash is showing --  in each trash card show a button `Restore` in bottom right that moves that session out of trash 

add `Close All` and `Open All`buttons to the right of the next button that close and open text for all bars

when you click on a prompt bar and open it's response text then scroll window so the bar is at the top

add a new footer row in editor pane -- move the navigation controls to that row -- put the thinking, working, finished, etc. indicator at the far left of the row


# major change to this extension
- a different claude ai implemented a claude-like vscode extension in this project.
  - it overwrote the sample scaffolding

- see these files to follow that conversation:
  - claude2-instructions.md
  - claude2-problems.md
  - claude2-judgements.md
  - claude2-response.md

- scan this entire project workspace and check to make sure it follows the instructions
  - and check for any bugs anywhere

## current bugs
- perform the entire workspace scan above before working on these problems
  - your scan fixes may fix this

- when i opened the extension development host and opened the sidebar i got: `There is no data provider registered that can provide view data.`

- i submitted the prompt `testing -- is this conversation working` and got this response `error: unknown option '--autocompact'`


