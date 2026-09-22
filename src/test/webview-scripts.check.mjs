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
  conversation: conversationHtml(webview, 'session-id', defaults, { models: { sonnet: ['low', 'high'], haiku: [] }, presets: [{ enabled: true, model: 'sonnet', effort: 'high' }], prefs: { haiku: { on: false, alias: '' } }, date: 0, seenDate: 0 }, 1),
  instructions: managementHtml(webview, 'instructions', 'UTC', 1),
  quota: managementHtml(webview, 'quota', 'UTC', 1),
  plugins: managementHtml(webview, 'plugins', 'UTC', 1),
  models: managementHtml(webview, 'models', 'UTC', 1, true),
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

// A file tag is cut out of the prompt box by hand rather than by a prefix rule, so the one piece
// with edges worth pinning -- where the caret counts as inside a tag -- is run here against a
// stand-in box. The function is lifted out of the generated script; nothing else in it is needed.
{
  const source = pages.conversation.match(/function removeFileTag\(caret\)[\s\S]*?\n {4}\}/);
  assert.ok(source, 'conversation pane lost removeFileTag');
  const box = {
    value: '',
    selectionStart: 0,
    setSelectionRange(at) {
      this.selectionStart = at;
    },
  };
  const removeFileTag = new Function('promptBox', 'sendDraft', source[0] + '\nreturn removeFileTag;')(box, () => {});
  const cut = (value, caret) => {
    box.value = value;
    removeFileTag(caret);
    return box.value;
  };
  assert.strictEqual(cut('<book> summarize this', 3), 'summarize this', 'caret inside the tag');
  assert.strictEqual(cut('<book> summarize this', 5), 'summarize this', "caret on the tag's '>'");
  assert.strictEqual(cut('hi <book> there', 6), 'hi there', 'a tag after some typing');
  assert.strictEqual(cut('<book> summarize this', 9), '<book> summarize this', 'caret past the tag');
  assert.strictEqual(cut('nothing to cut', 4), 'nothing to cut', 'no tag at all');
  assert.strictEqual(cut('a < b\nc > d', 3), 'a < b\nc > d', 'brackets spanning a newline');
  console.log('ok: file tags come back out of the prompt box');
}

console.log('ok: every webview script parses');
