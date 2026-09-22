



???????
too many bars above block
show path to folder this is running in
show time since last response output

======================

# set the turns limit from models pane
- i want to be able to set the turns limit from the ui
  - set it in only one place in the ui
    - it can be entered in any install in any host type
      - only needs to be entered once
    - it can be a text input box that is limited to numbers from 50 to 250
    - the input box should be in the models pane
      - saved by existing save button
  - it should be used in all 3 host types 
    - it can be loaded on just a window reload
      - it doesn't need to be live
    - so it needs some centralized storage like server or globalstorage

  in the footer remove the double arrow scroll to bottom button

in the sidebar header:
  - reduce the margin between the + button and the clean button by 20%
  - reduce the margin between the clean button and the trash button by 20%
  - reduce the horiz padding in the trash button by 1px on each side
  - reduce the margin between the trash button and the sessions count by 20%


in the sidebar header:
  - move the fork button to between mngmnt and close
  - add a button `Clean` to between the + and trash buttons
    - clean should move all sessions to the trash

in the tooltip over a prompt bar add the date/time the prompt was submitted to the right of the model/effort with a 20px margin between

in the quota pane the graph axis labels are too big, the should match rest of text in pane

# models pane changes
- remove the presets boxes
- in each model row of the model list:
  - add a checkbox to the right of the show checkbox
    - this is the preset checkbox and selects the row to be one of the presets
  - add an effort selector to the right of the alias text inputs
    - the selector should have the possible efforts for that model
    - the selection assings an effort to the alias
      - everywhere an alias is used it has to have that effort
- in the models box use a table instead of rows
  - this instruction assumes the row changes are taken into account before now
  - the table should be flipped so the possible models are the columns
    - the table rows should be all the elements that were listed in a model row
    - the first row should be the list of possible efforts for the model

# changes to conversation boxes
- in all boxes at any time the raw response text should never be shown 
- always show markup in every box
  - a click in the box should toggle showing the tool groups
  - hidden tool groups should be the default except for a box actively streaming
- when a box is actively streaming:
  - it should always show markdown with tool groups visible
  - a click should do nothing
  - scrolling should be allowed
- when streaming finishes:
  - the box should not automatically scroll to the top
  - a flag `wasStreaming` should be set for that box
    - while wasStreaming is set:
      - the box should still show tool groups
      - the box should still not respond to clicks
- when a box with wasStreaming is set and is closed for any reason:
  - the wasStreaming flag should be cleared
  - the box should become a standard box
  - the box should be scrolled to the top when opened the first time
    - this is true for all boxes
- all boxes should have their scrolling position persisted until install is reloaded

# centralize quota history
- currently quota history is stored separately for each host type
  - graphs have missing data
- suggest how to centralize quota history

default model

implement your suggestion for installs to query the quota and share the readings through the server -- what fixes the 429 problem? an arbitrary number of vscode instances can be running

- in models pane for each model in the list add a checkbox and an text input
- the checkbox enables the model to be in the model selector in the footer
  - if unchecked it is hidden everywhere
- text in the input box is an alias for the model to be used instead of the actual model name in the ui
  - it is for display only
  - i think it is just used in model selector and in prompt bar tooltip
- this model data is saved along with the preset data
  - it shares one save button for both
- the presets choices and the model choices might conflict
  - the model selected for a preset must be an enabled model
  - disable any presets that have a disabled or missing model

# updated management pane and new model updates
- this replaces the current logic for claude updates, MODEL_OPTIONS, and EFFORT_OPTIONS 

## new management pane contents
- the management pane now has a new design with multiple subpanes
  - A new button `Mngmnt` is in the left side of the top button row in the sidebar
    - the Mngmnt button opens the new management pane
- create a new header row at the top of the management pane, put 4 tab buttons at the left side of that row
  - they act like radio buttons but the are styled like other buttons in the extension
  - three of the header buttons are moved from the sidebar top row of buttons and one is new:
    - `Quotas` is the old $ button 
    - `Instructions` is the old Instr button
    - `Stats` is the old stats button
    - `Models` is a new button
  - when clicked, a header tab button is selected and highlighted with a light-gray background
    - this overrides the rule against gray colors
  - each one has it's own subpane below the header
    - the three old buttons have the same subpane they used to have that filled the management pane
      - the subpanes don't need a header, their name is known by the selected radio button
    - the new Models button opens a Models subpane
  - every time the management pane is opened the quotas pane is selected
- the management pane closes three ways
  - a close button is in the right of top tab buttons row
    - same as old close button in management pane
  - the mngmnt button toggles it closed
  - the close button in the top row of the sidebar can close it
    - it only closes it after all conversation panes are closed

## models subpane
- the models subpane has 2 boxes
  - the models box lists the current models and the efforts for each model
    - it also shows a modification date for the last time those changed
  - the presets box lets you choose the presets for models and efforts
    - these are the presets the M button in the footer cycles through
    - the presets box has 4 rows for 4 presets, each row has:
      - a checkbox to enable the preset
      - a selector drop-down with all the model choices
      - a selector drop-down of all efforts for that model

## info storage in server
- the models/efforts/presets info is shared across all extensions so models subpanes always match
- the centralized claude2-stats pm2 task in the server stores the info
  - it is just simple persistent storage of the info and a modification date
- there are 2 endpoints to read and write the info
  - one endpoint is called to save the info
    - when the info to be saved doesn't match the current stored info then a modification date is updated
  - another endpoint is called to read the info and date

## info handling by extension
- the models, efforts, and presets are not hard-wired in the code anymore
- keep a local vscode persistent store of the info and mod date for each of windows, wsl, and server 
- every time an extension is loaded:
  - run `claude update` with a lock
  - fetch the model and effort lists from cli and save for use below as info
  - delay starting any session until upodate is finished
    - this should only be a few seconds delay
    - show a toast saying waiting for claude update  
  - if the info from the cli doesn't match the local info then:
    - send that new info to the server
    - don't change local info or date
  - then always read the info and date from the server:
    - save the info but not the date to the local copy
    - if the server date is newer than the local date set an update notification flag
  - when the notification flag is set:
    - the mngmnt button in sidebar has a light-red background
    - the models tab button in the management pane has a light-red background 
- every time the models subpane is opened:
  - it gets the latest info and date from the server and displays it
  - it clears the notification flag and updates the local copy of the mod date
- the presets, models, and effort selections in the model row of the footer should always use live local stored info

## actions
- if these instructions are ambiguous, incomplete, contradictory, or you think there is a better way to do this then:
  - write the problems to claude2-mngmnt-problems.md and stop
  - make no changes other than writing to claude2-mngmnt-problems.md
- otherwise implement these instructions immediately

if i select an image file will that be treated like an image pasted into prompt editor

# adding files to a prompt
- i want to add files to a prompt just like images
- add a `File` button to the nav row to the right of the cap button
  - when clicked use the split choosing suggested above to choose file
- file is added to the prompt with `<filename> ` prepended to the prompt text
  - `<filename> ` is the final part of the file path without the extension surrounded by angle brackets
    - like "/mnt/book.txt" -> "<book>" where < and > are included chars
  - <filename> in the prompt box is similar to the image char for images
    - but you can't click it to view it
    - you can ctrl-click it to remove it from the prompt
- prompt text added to the prompt bar is the same as what was in the edit box like text with images
- file does not need to be persisted like images

change cursor to pointer over image char in prompt editor box
move fork button to sidebar after the + button
move the close button in the sidebar to the right of the stats button

# multiple images in a prompt
- i want to be able to submit multiple images in a prompt
- remove the image button from the sidebar
- the cap button in the nav row is now different
  - it should be able to be used more than once to create multiple images
  - the cap button should not be a toggle any more and not highlighted
  - each cap button click should create a new image stack while keeping the old ones
- when an image is in the clipboard and then pasted into the prompt editor:
  - each paste should create a new image stack while keeping the old ones
- when an image is added from any source:
  -  it should be shown immediately in the image management pane
    - this is the same action that used to be done by clicking on the image button in the sidebar
  - the image should be in a stack and can be cropped as usual
  - dupes from any source should be ignored
- when a prompt has attached images there should be a 🖼️ char for each image 
  - the chars should be prepended to the text in the prompt box
  - the chars should all look the same with no labels or other differentiator
  - when a 🖼️ char is clicked the corresponding image should be shown 
    - it should be shown immediately in the image management pane 
    - this is how you identify the image for a char
  - when a 🖼️ char is ctrl-clicked the image should be deleted 
    - use confirmation with the image information in the confirmation dialog
- when a prompt with images is submitted:
  - the images should be available to be shown persistently until the session is permanently deleted
    - the persistent images don't have a stack, just the final image
    - the images cannot be deleted
  - the image chars should be in the new prompt bar
    - the text should have the prepended image chars the same as in the prompt edit box
  - the chars can be clicked to show in the image pane but pane image can't be cropped
  - the final text appended to the end of the prompt text should be shorter
    - do this only if it doesn't affect context storage of the image
    - a screen cap should have the text `[Screen Capture <N>]` appended
    - a pasted image should have the text `[Image <N>]`
- actions
  - if these instructions are ambiguous, incomplete or contradictory then:
    - write the problems to claude2-image-problems.md and stop
    - make no changes other than writing to claude2-image-problems.md
  - otherwise implement these instructions immediately

# response
1. keep the required old final text
2. <N> isn't needed anymore because of answer above -- correct me if i'm wrong
3. use stated default

- if you need to correct me because i'm wrong stop and let me know

change the label of the plugins button to `Stats`

# real forking
- when the fork button is clicked then first clone the entire session into a new session with a session card
- the new session name should be the same as the source session except for an appended version number
  - if there is already an existing matching session name then append ` (2)`
  - if there is already an existing matching session name with (n) then increment n: ` (n+1)`
  - the name of the source extension should be unchanged
- after cloning, trim turns from the end of the source session exactly as fork button does now

remove the credits graph from the quota pane -- expand the other 4 graphs with the same aspect ratio to fill the width of the pane with a small margin - add a credits progress indicator at middle of header.  it should have a progress bar to indicate how much of the credit limit has been spent -- put no axes -- place credits spent so far, $x.yy, to the left of the bar and the limit to the right

in each of the Δ5h and Δ7D graphs add 2 dashed lines. one line should start at x == 80% of period and a Y of the top +20%. It should end at 0 on far right.  the second line should start with x == 80% and y at bottom of -20% at y == 0. It should also end at 0 on far right. the same two lines should be shown on both graphs.  It is impossible for a quota value to cross either of these lines. check my logic.

how long can it take for a turn to finish?  if more than a few seconds then highlight the background of the stop button with light-red while waiting for the turn to finish

# markdown in conversation pane
- in the conversation pane a box in a block can be in 3 states:
  - it can be streaming raw text with tool groups
    - call this a streaming box
    - this can only be the bottom box
    - clicks in a box in this box state are ignored
    - this is what a streaming box currently does
  - it can be showing non-streaming raw text with tool groups
    - call this a raw box
    - this can only ever be seen after manually clicking in the box
    - this is also one of the current states
  - it can be showing markdown like that shown with the md button in sidebar
    - call this a markdown box
    - it is never streaming
    - it scrolls like raw boxes do
    - it doesn't show tool groups in markdown
- when streaming finishes the streaming box should switch to a markdown box
- clicking in a non-streaming box should toggle between a markdown box and a raw box
- all non-streaming boxes should start as a markdown box until manually toggled with a click
- any box in any state can be toggled between shown and hidden by clicking on the prompt bar like now

when 5H, 7D, or fable usage goes from < 95% to >= 95% then highlight $x/y status in the footer with a background of light-red -- if the highlighted $x/y status is clicked then clear the highlighting until another usage goes from  < 95% to >= 95% -- keep this persistant across reloading

- add 2 new graphs to quota pane
- they match the 5h and 7d graphs
  - they should be placed under their matched graph
  - they should align exactly so their x-axises line up
  - they should have y-axis from -20% to +20%
  - there should be a horizontal line at 0%
    - there should be dashed lines at -10% and +10%
  - there should be one value plotted forming a single line
    - it should be the actual used % minus the target %
      - the target % is shown on the diagonal line in graph above
      - the target % is the percent of time passed per quota period

# graft and ponytail stats in footer
- remove current ponytail stat from footer stats
- when graft is enabled for the workspace show old `$X/Y` using graft info
  - see code from before switch to ponytail
  - if not enabled show old `$Z`
- when ponytail is enabled for the workspace show `<skips>:<ceilings>`
- in both cases show them to the right of the context stats
- separate them with pipes | as usual

- i'm just curious about why the dev extension host at /root/wsl-apps/test gives this error:
`Plugins
stats server unreachable — showing this workspace only`
- this is not a big problem since it is just for testing

- for report use `plugin-exp` column header instead of graft-ponytail-exp -- don't change name anywhere else
- store dates so we can filter report by period selector
- change label for plugins button in sidebar to `Plug`
- when hovering over project name in report show tooltip with complete path to project

# graft and ponytail agent extensions
- i want to have the option of using the graft and/or ponytail agent extensions in this claude2 vscode extension
  - for these instructions call them plugins
  - graft should be re-enbled
    - but there should be no graft UI like $ or graft pane
  - i want to be able to control them and report their stats for individual projects
    - their should be an on/off flag for each plugin in each workspace
    - stats should be collected individually for each workspace but accesible to all

- change the pony button label to `Plugins`
  - it should open a `Plugin pane` in the management editor
  - the pane should not include detailed data like individual Session skips or Repo ceilings
  - the plugin pane should contain a table of stats and controls
    - each cell should be a simple number or short text
    - rows should be stats/info/control for the project, like these rows:
      - host: windows, wsl, or server
      - session count
      - turn count
      - wall time total
      - $ total for all sessions
      - graft 
        - $ savings
        - tool call count
      - ponytail 
        - shortcut comments
        - ceilings?
      - all other stats that can be expressed in simple numbers or short text
      - there should be 2 control rows at bottom labeled `Enable graft` and `Enable ponytail`
        - each cell in those rows should have a checkbox to enable the plugin for the project
    - columns should be projects/workspaces, like claude2, tv, ...
      - the names should be the final part of their folder path
        - e.g. /root/apps/claude2 would be claude2
      - there should be a summary column on the right with totals for all projects

- stats should be managed using a centralized task on the server
  - this is necessary for all projects to be able to show the same thing in the plugins pane
  - each project should use server endpoints to send and receive stats
  - the task should be in pm2 as claude2-stats
  - claude2-stats should be a project maintained in the claude2 monorepo like claude2-cap

- do a one-time backfill of stats obtainable from existing session storage

- actions
  - if these instructions are ambiguous, incomplete or contradictory then:
    - write the problems to claude2-plugin-problems.md and stop
    - make no changes other than writing to claude2-plugin-problems.md
  - otherwise implement these instructions immediately

# switch to ponytail
- replace graft completely with ponytail.
- I want to show the session's cumulative skip count in `$1.23 | <x> | m:ss`
- design an implement the "pony pane" to replace the graft pane. we can fine-tune it later.

# switching to ponytail tool
- i want to explore the possibility of switching from the graft tool to ponytail.  
- i know they do different things but a series of tests i ran showed ponytail by itself beat the performance of graft by itself and graft with ponytail. 
- so i would like to switch to ponytail by itself.
- what do you think of this idea?
- are there any references on the web to these tools performance and in particular them combined?
- what parts of the ui are dependent on graft and would have to be changed if graft was removed?
- how hard would it be to switch?

don't show graft status line and end of response -- it starts with 🌱

when i open an empty session and do a capture and open the capture pane and close the pane the editor pane is gone so i can't add a prompt text to send with the image -- what conditions close an empty editor pane?

# screen capture cropping
- when cap button in sidebar is clicked the pending image is shown
- we want to be able to crop the image before sending it with a prompt
- the steps to crop are:
  - open image
  - click and drag a rectangle on the image
    - it can be dragged in any direction
  - when released then crop the image so only the image in the rectangle is preserved
- a cropped image may be cropped again to shrink it more
  - on each crop put the previous image before the crop on a stack cropStack
  - on a non-drag click in a cropped image undo the last crop by popping cropStack
- a prompt send includes the top cropped image
- toggling off the cap button in the footer disables sending the image and clears cropStack

when in trash mode and trash button in sidebar is ctrl-clicked then all sessions in the trash should be permanently deleted after a confirmation dialog

# footer cleanup
- remove ▲,, ▼, and ▲▲ buttons.
- move stop button to the right of the status indicator.
 - add new `Fork` button to the right of the stop button.
  - the fork button should fork the selected block
    - this removes all blocks below the selected block
  - this is the same as the old fork button in the bar
    - remove the fork button in the bar
- the nav row should now be status, stop, ▼▼, Fork, Load, and Cap.

## disabled button logic in the nav row
- the stop button should be disabled when the bottom block is not streaming
- the ▼▼ button should be disabled when the pane has less than 2 blocks or the bottom block is selected
- the fork button should be disabled when there is no block below the selected block
- the load button should be disabled when there are no blocks
- the cap button is never disabled
- button appearance
  - the background of all buttons should always be white
  - when disabled all of button should be 50% gray
    - this overrides the instruction that there are no grays

don't close a tool tip when pane scrolls -- only close it when mouse leaves

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

when hovering over prompt bar and tooltip shows the prompt text then prepend the prompt text with the model/effort set when that prompt was posted -- make tool tip text everywhere 20% larger 

shen session is streaming and prompt text is ctrl-entered then stop and post prompt and then clear prompt editor

fork prompt

when a compaction is done show indicator by changing background of context 

# never lose prompt typing
- make in-memory `Map` persistant across reload
  - when the map text is submitted clear Map
    - so it still matches editor contents
- in any of the actions you mentioned above happen:
  - set a flag promptTextLost which is also persistent
  - when promptTextLost is set and a new session is created then load map into editor
    - and clear flag but keep map
- typing Ctrl+Enter while a run is active should stop the run and enter the new prompt

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


