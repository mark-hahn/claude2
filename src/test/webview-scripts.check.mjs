// The webviews are generated as HTML strings, so their JavaScript is invisible to tsc and to
// eslint alike: a typo inside one only shows up as a dead pane at runtime. This parses every
// <script> of every pane. Run: node src/test/webview-scripts.check.mjs (see the header of the
// file for the commands that build the bundles it reads).
//
//   echo 'module.exports = { env: {} };' > /tmp/vscode-stub.cjs
//   npx esbuild src/webviews.ts --bundle --platform=node --format=cjs \
//     --alias:vscode=/tmp/vscode-stub.cjs --outfile=/tmp/webviews.cjs
//   npx esbuild src/modelInfo.ts --bundle --platform=node --format=cjs \
//     --alias:vscode=/tmp/vscode-stub.cjs --outfile=/tmp/modelInfo.cjs
import assert from 'assert';
import { createRequire } from 'module';

const { sidebarHtml, conversationHtml, managementHtml, snipsHtml } = createRequire(import.meta.url)('/tmp/webviews.cjs');
const webview = { cspSource: 'vscode-resource:' };
const defaults = { model: 'claude-opus-5', effort: 'high', useAdvisor: true, contextWindow: 256000, maxTurns: 10 };
const pages = {
  sidebar: sidebarHtml(webview),
  snips: snipsHtml(webview, 'vscode-resource:/dist', 1),
  conversation: conversationHtml(webview, 'vscode-resource:/dist', 'session-id', defaults, { models: { sonnet: ['low', 'high'], haiku: [] }, presets: [{ enabled: true, model: 'sonnet', effort: 'high' }], prefs: { haiku: { on: false, alias: '' } }, defaultPreset: 0, date: 0, seenDate: 0 }, 1),
  instructions: managementHtml(webview, 'instructions', 'UTC', 1),
  quota: managementHtml(webview, 'quota', 'UTC', 1),
  plugins: managementHtml(webview, 'plugins', 'UTC', 1),
  models: managementHtml(webview, 'models', 'UTC', 1, true),
  settings: managementHtml(webview, 'settings', 'UTC', 1),
  cap: managementHtml(webview, 'cap', 'UTC', 1),
};

for (const [name, html] of Object.entries(pages)) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0, name + ' has no script');
  for (const script of scripts) {
    // Parsing is the whole point here; the function is never called.
    assert.doesNotThrow(() => new Function(script), name + ' script does not parse');
  }
}

// The 🖼️ prefix is the one piece of prompt-box logic with no other check on it: the conversation
// pane must carry the char itself, and the pane that shows a clicked one must be reachable.
assert.ok(/const IMG = '\\u\{1F5BC\}\\uFE0F'/.test(pages.conversation), 'conversation pane lost the image char');
assert.ok(pages.cap.includes('loadCapture'), 'image pane lost its loader');

// Tab turns a line into a list item one step in; tabLine says what replaces the line's start.
{
  const source = pages.conversation.match(/function tabLine\(line\)[\s\S]*?\n {4}\}/);
  assert.ok(source, 'conversation pane lost tabLine');
  const tabLine = new Function(source[0] + '\nreturn tabLine;')();
  const tab = (line) => {
    const { old, prefix } = tabLine(line);
    return prefix + line.slice(old);
  };
  assert.strictEqual(tab('text'), '- text', 'text with no dash gains one at the left edge');
  assert.strictEqual(tab('  text'), '- text', 'even when it was indented');
  assert.strictEqual(tab('  - text'), '    - text', 'an item steps in two, keeping its dash');
  assert.strictEqual(tab(' - text'), '  - text', 'an odd margin steps one');
  assert.strictEqual(tab('   - text'), '    - text', 'an odd margin of three steps one');
  assert.strictEqual(tab('-text'), '  - text', 'one space after the dash');
  assert.strictEqual(tab('-    text'), '  - text', 'only one space after the dash');
  assert.strictEqual(tab(''), '- ', 'an empty line becomes an empty item at the left edge');
  assert.strictEqual(tab('- '), '  - ', 'more tabbing steps it in as usual');
  assert.strictEqual(tab('  '), '  - ', 'a blank line keeps its margin, undoing Backspace after a dash');
  console.log('ok: tab makes list items');
}

// Shift-Tab undoes Tab one step; untabLine says what replaces the line's start.
{
  const source = pages.snips.match(/function untabLine\(line\)[\s\S]*?\n {4}\}/);
  assert.ok(source, 'snips pane lost untabLine');
  const untabLine = new Function(source[0] + '\nreturn untabLine;')();
  const untab = (line) => {
    const { old, prefix } = untabLine(line);
    return prefix + line.slice(old);
  };
  assert.strictEqual(untab('- text'), 'text', 'an item at the left edge loses its dash');
  assert.strictEqual(untab('- '), '', 'so does an empty one');
  assert.strictEqual(untab('-    text'), 'text', 'with every space after the dash');
  assert.strictEqual(untab('    - text'), '  - text', 'an indented item steps left');
  assert.strictEqual(untab('  - text'), '- text', 'to the left edge, keeping its dash');
  assert.strictEqual(untab('   - text'), '  - text', 'an odd margin steps one');
  assert.strictEqual(untab('  text'), 'text', 'plain text steps left too');
  assert.strictEqual(untab('text'), 'text', 'and stays at the left edge');
  assert.strictEqual(untab('-text'), '-text', 'a dash needs its space');
  console.log('ok: shift-tab steps list items back');
}

// Enter starts the next list item; enterStart says what follows the line break.
{
  const source = pages.snips.match(/function enterStart\(line, rest\)[\s\S]*?\n {4}\}/);
  assert.ok(source, 'snips pane lost enterStart');
  const enterStart = new Function(source[0] + '\nreturn enterStart;')();
  assert.strictEqual(enterStart('- text', ''), '- ', 'next item');
  assert.strictEqual(enterStart('plain', ''), '', 'a line that is no item gets no dash');
  assert.strictEqual(enterStart('', ''), '', 'nor does an empty one');
  assert.strictEqual(enterStart('  plain', ''), '  ', 'it just keeps its margin');
  assert.strictEqual(enterStart('-text', ''), '', 'a dash needs its space');
  assert.strictEqual(enterStart('plain', 'tail'), '', 'nor when it is split');
  assert.strictEqual(enterStart('  plain', 'tail'), '  ', 'keeping its margin there too');
  assert.strictEqual(enterStart('    - text', ''), '    - ', 'dashes line up');
  assert.strictEqual(enterStart('  - text', 'tail'), '  - ', 'text taken along gets the dash');
  assert.strictEqual(enterStart('  - text', '- text'), '  ', 'text that has a dash keeps just that one');
  assert.strictEqual(enterStart('## heading', ''), '- ', 'a heading is followed by an item');
  assert.strictEqual(enterStart('  # heading', ''), '  - ', 'under its own margin');
  assert.strictEqual(enterStart('## heading', 'tail'), '- ', 'and when it is split');
  assert.strictEqual(enterStart('## heading', '## heading'), '', 'a heading pushed down stays one');
  assert.strictEqual(enterStart('#tag', ''), '', 'a hash with no heading space is no heading');
  console.log('ok: enter starts list items');
}

// Typing # on an empty item makes it a heading; hashStart says what replaces the item.
{
  const source = pages.snips.match(/function hashStart\(line, column, above\)[\s\S]*?\n {4}\}/);
  assert.ok(source, 'snips pane lost hashStart');
  const hashStart = new Function(source[0] + '\nreturn hashStart;')();
  assert.deepStrictEqual(hashStart('- ', 3, 'text'), { old: 2, text: '\n# ' }, 'a heading, with a blank line before it');
  assert.deepStrictEqual(hashStart('  - ', 5, 'text'), { old: 4, text: '\n# ' }, 'the indent goes');
  assert.deepStrictEqual(hashStart('- ', 3, ''), { old: 2, text: '# ' }, 'no second blank line, nor one at the top');
  assert.deepStrictEqual(hashStart('- ', 3, '  '), { old: 2, text: '# ' }, 'spaces count as blank');
  assert.strictEqual(hashStart('- ', 1, 'text'), null, 'only at the end of the line');
  assert.strictEqual(hashStart('- text', 7, 'text'), null, 'only on an empty item');
  assert.strictEqual(hashStart('', 1, 'text'), null, 'an empty line is no item');
  for (const [line, column] of [['# ', 3], ['## ', 4], ['# text', 3], ['see # ', 7]]) {
    assert.deepStrictEqual(hashStart(line, column, 'text'), { old: 1, text: '# ' }, 'joins the hash in ' + line);
  }
  assert.strictEqual(hashStart('# text', 7, 'text'), null, 'not further along the line');
  assert.strictEqual(hashStart('#', 2, 'text'), null, 'no space to step over');
  console.log('ok: hash makes headings');
}

// The export has to drop tool lines, the graft tally and the work above the answer the way a
// box with tools hidden does.
{
  const lift = (name) => {
    const source = pages.conversation.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n {4}\\}'));
    assert.ok(source, 'conversation pane lost ' + name);
    return source[0];
  };
  const body = ['exportMarkdown', 'typedText', 'strippedText', 'answerText', 'isToolLine'].map(lift).join('\n');
  const T = '⁣';
  const A = '⁤';
  const session = { name: 'Demo', turns: [
    { prompt: 'first\nsecond', response: 'work\n' + T + '**Read** x\n\n\nmore\n' + A + '\nthe answer\n🌱 graft saved' },
    { prompt: 'only tools', response: T + '**Bash** ls\n' + A + '\ndone', images: [{}], error: 'boom' },
  ] };
  const exportMarkdown = new Function('session', 'IMG', 'ANSWER_MARK', 'TOOL_LINE_MARK', 'GRAFT_TALLY_MARK', body + '\nreturn exportMarkdown;')(session, '🖼️', A, T, '🌱');
  assert.strictEqual(exportMarkdown(),
    '# Demo\n\n> first\n> second\n\nthe answer\n\n---\n\n> 🖼️only tools\n\ndone\n\n**Error:** boom\n');
  console.log('ok: session export matches the open boxes');
}

// Search counts what bars and boxes show, in the sidebar and the pane alike, and a pane steps
// through its hits top to bottom, a bar's ahead of its box's, then hands over to the sidebar.
{
  const lift = (page, name) => {
    const source = page.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n {4}\\}'));
    assert.ok(source, 'pane lost ' + name);
    return source[0];
  };
  const shared = ['typedText', 'isToolLine', 'strippedText', 'answerText', 'shownText', 'occurrences'];
  const T = '\u2063';
  const A = '\u2064';
  const D = T + '\u2062';
  const turns = [
    { id: 'a', prompt: 'find me twice, find\n\n[An image is attached. Read the image file find.png to view it.]', response: 'nothing here' },
    { id: 'b', prompt: 'other', response: T + '**Read** find.ts\n' + D + 'find\nthe find\n🌱 find saved' },
    { id: 'c', prompt: 'other', response: 'plain', error: 'could not find it' },
    { id: 'd', prompt: 'other', response: 'find in the work\n' + A + '\nthe answer' },
  ];

  const matchCount = new Function('searchText', 'TOOL_LINE_MARK', 'GRAFT_TALLY_MARK', 'ANSWER_MARK',
    [...shared, 'matchCount'].map((name) => lift(pages.sidebar, name)).join('\n') + '\nreturn matchCount;')('FIND', T, '🌱', A);
  assert.strictEqual(matchCount({ turns }), 4, 'prompt typing, box text, and a failure; no tool line, detail, tally, picture sentence, or work above the answer');

  const body = [...shared, 'searchHits', 'stepSearch'].map((name) => lift(pages.conversation, name)).join('\n');
  const fake = new Function('session', 'searchText', 'TOOL_LINE_MARK', 'GRAFT_TALLY_MARK', 'vscode', `
    let searchHit = null, searchHitMoved = false, anchorIndex = 0, boxOpen = true, toolsBox = true, boxScrollNext = null;
    let frozenPane = false, allOpen = false, initializedSelection = false, pendingTurnCount = 0, shownActiveTurn = null;
    const status = null, sessionId = 's', render = () => {}, ANSWER_MARK = '${A}';
    const document = { createElement: () => ({}) };
    const fillResponse = (box, turn) => { box.text = shownText(turn); };
    const textHits = (box, needle) => Array(occurrences(box.text, needle));
    ${body}
    return { stepSearch, state: () => ({ searchHit, anchorIndex, boxOpen }) };
  `);
  const posted = [];
  const pane = fake({ turns }, 'find', T, '🌱', { postMessage: (message) => posted.push(message.type) });
  const walk = [];
  pane.stepSearch(true);
  for (let step = 0; step < 4; step += 1) {
    const { searchHit, anchorIndex, boxOpen } = pane.state();
    walk.push([searchHit.turnId, searchHit.bar, searchHit.nth, anchorIndex, boxOpen].join());
    pane.stepSearch(false);
  }
  assert.deepStrictEqual(walk, ['a,true,0,0,false', 'a,true,1,0,false', 'b,false,0,1,true', 'c,false,0,2,true'], 'bar hits close the boxes, box hits open theirs');
  assert.deepStrictEqual(posted, ['searchEnd'], 'after the last hit the sidebar moves on');
  assert.strictEqual(pane.state().searchHit.turnId, 'c', 'and the selection stays until it does');
  pane.stepSearch(true);
  assert.strictEqual(pane.state().searchHit.turnId, 'a', 'first starts over, which is how a lone session wraps');

  const none = fake({ turns: [{ id: 'a', prompt: 'x', response: 'y' }] }, 'find', T, '🌱', { postMessage: (message) => posted.push(message.type) });
  none.stepSearch(true);
  assert.strictEqual(posted.length, 1, 'a name-only card opens and stays');
  none.stepSearch(false);
  assert.strictEqual(posted.length, 2, 'its next click moves on');
  console.log('ok: search counts shown text and steps through hits');
}

// The advisor display shows the next listed family up from the model, None when nothing outranks
// it or Use advisor is off, and agrees with the extension's advisorFor.
{
  const lift = (name) => {
    const source = pages.conversation.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n {4}\\}'));
    assert.ok(source, 'conversation pane lost ' + name);
    return source[0];
  };
  const body = ['advisorFor', 'showAdvisor'].map(lift).join('\n');
  const { advisorFor } = createRequire(import.meta.url)('/tmp/modelInfo.cjs');
  const all = { 'opus[1m]': [], 'claude-fable-5-1[1m]': [], sonnet: [], haiku: [] };
  const shown = (model, models = all, useAdvisor = true) => {
    const advisorBox = {};
    new Function('modelSelect', 'advisorBox', 'models', 'useAdvisor', body + '\nshowAdvisor();')({ value: model }, advisorBox, models, useAdvisor);
    const family = useAdvisor ? advisorFor(model, models) : '';
    assert.strictEqual(advisorBox.textContent, family ? family[0].toUpperCase() + family.slice(1) : 'None', 'footer and run disagree on ' + model);
    return advisorBox.textContent;
  };
  assert.strictEqual(shown('haiku'), 'Sonnet');
  assert.strictEqual(shown('sonnet'), 'Opus');
  assert.strictEqual(shown('opus[1m]'), 'Fable');
  assert.strictEqual(shown('claude-fable-5-1[1m]'), 'None', 'nothing outranks fable');
  assert.strictEqual(shown('sonnet', { sonnet: [], haiku: [] }), 'None', 'unlisted families are left out');
  assert.strictEqual(shown('opus[1m]', { sonnet: [], 'opus[1m]': [] }), 'None');
  assert.strictEqual(shown('haiku', { haiku: [], 'opus[1m]': [] }), 'Opus', 'an unlisted family is stepped over');
  assert.strictEqual(shown('sonnet', all, false), 'None', 'Use advisor off');
  console.log('ok: advisor display');
}

console.log('ok: every webview script parses');
