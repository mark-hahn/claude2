// The webviews are generated as HTML strings, so their JavaScript is invisible to tsc and to
// eslint alike: a typo inside one only shows up as a dead pane at runtime. This parses every
// <script> of every pane. Run: node src/test/webview-scripts.check.mjs (see the header of the
// file for the two commands that build the bundle it reads).
//
//   echo 'module.exports = {};' > /tmp/vscode-stub.cjs
//   npx esbuild src/webviews.ts --bundle --platform=node --format=cjs \
//     --alias:vscode=/tmp/vscode-stub.cjs --outfile=/tmp/webviews.cjs
import assert from 'assert';
import { createRequire } from 'module';

const { sidebarHtml, conversationHtml, managementHtml } = createRequire(import.meta.url)('/tmp/webviews.cjs');
const webview = { cspSource: 'vscode-resource:' };
const defaults = { model: 'claude-opus-5', effort: 'high', contextWindow: 256000, maxTurns: 10 };
const pages = {
  sidebar: sidebarHtml(webview),
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
  assert.strictEqual(tab('text'), '  - text', 'even margin (none) steps two and gains a dash');
  assert.strictEqual(tab(' text'), '  - text', 'odd margin steps one');
  assert.strictEqual(tab('   text'), '    - text', 'odd margin of three steps one');
  assert.strictEqual(tab('  - text'), '    - text', 'an item steps in two, keeping its dash');
  assert.strictEqual(tab('-text'), '  - text', 'one space after the dash');
  assert.strictEqual(tab('-    text'), '  - text', 'only one space after the dash');
  assert.strictEqual(tab(''), '  - ', 'an empty line becomes an empty item');
  console.log('ok: tab makes list items');
}

// The export has to drop tool lines and the graft tally the way the box does, and keep the
// answer rule only where the box would draw it.
{
  const lift = (name) => {
    const source = pages.conversation.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n {4}\\}'));
    assert.ok(source, 'conversation pane lost ' + name);
    return source[0];
  };
  const body = ['exportMarkdown', 'typedText', 'strippedText', 'isToolLine'].map(lift).join('\n');
  const T = '⁣';
  const A = '⁤';
  const session = { name: 'Demo', turns: [
    { prompt: 'first\nsecond', response: 'work\n' + T + '**Read** x\n\n\nmore\n' + A + '\nthe answer\n🌱 graft saved' },
    { prompt: 'only tools', response: T + '**Bash** ls\n' + A + '\ndone', images: [{}], error: 'boom' },
  ] };
  const exportMarkdown = new Function('session', 'IMG', 'ANSWER_MARK', 'TOOL_LINE_MARK', 'GRAFT_TALLY_MARK', body + '\nreturn exportMarkdown;')(session, '🖼️', A, T, '🌱');
  assert.strictEqual(exportMarkdown(),
    '# Demo\n\n> first\n> second\n\nwork\n\nmore\n\n***\n\nthe answer\n\n---\n\n> 🖼️only tools\n\ndone\n\n**Error:** boom\n');
  console.log('ok: session export matches the open boxes');
}

console.log('ok: every webview script parses');
