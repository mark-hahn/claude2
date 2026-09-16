
when session has no submitted prompts (is empty) and the name is not `New session` and the prompt editor had a draft and the draft was cleared then delete the session

when + button is clicked focus the prompt editor

add `Del all` button -- add trash can to session cards in trash that deletes that session

# sidebar button changes
- organize the buttons into 2 rows at top of sidebar:
  - the top row is the management row, it has $, instr, and graft buttons in that order
  - the second row is the session row, it hs + and trash buttons in that order
- add a new button `Close` that closes all session tabs other than current
  - put it to between the + and trash buttons

edit session name

expand prompt bar in-place

show response scrolling in a pane below it's prompt bar

======================

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


