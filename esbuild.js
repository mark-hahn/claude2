const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  });
  // The conversation pane's prompt editor: Monaco with every editor feature but only the markdown
  // language, loaded by the webview as a plain script that leaves `monaco` on the window. Its
  // web worker is a second script the webview starts from a blob.
  const browser = {
    bundle: true,
    format: "iife",
    minify: production,
    platform: "browser",
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  };
  const editorCtx = await esbuild.context({
    ...browser,
    stdin: {
      contents: [
        "export * from 'monaco-editor/editor/editor.api';",
        "import 'monaco-editor/features/register.all';",
        "import 'monaco-editor/editor/browser/coreCommands';",
        "import 'monaco-editor/languages/definitions/markdown/register';",
      ].join("\n"),
      resolveDir: __dirname,
      sourcefile: "promptEditor.js",
    },
    globalName: "monaco",
    outfile: "dist/promptEditor.js",
    loader: { ".ttf": "file" },
  });
  const workerCtx = await esbuild.context({
    ...browser,
    entryPoints: ["monaco-editor/editor/editor.worker"],
    outfile: "dist/editorWorker.js",
  });
  for (const each of [ctx, editorCtx, workerCtx]) {
    if (watch) {
      await each.watch();
    } else {
      await each.rebuild();
      await each.dispose();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
