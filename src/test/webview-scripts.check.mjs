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
  conversation: conversationHtml(webview, 'session-id', defaults, 1),
  instructions: managementHtml(webview, 'instructions', 'UTC', 1),
  quota: managementHtml(webview, 'quota', 'UTC', 1),
  plugins: managementHtml(webview, 'plugins', 'UTC', 1),
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

console.log('ok: every webview script parses');
