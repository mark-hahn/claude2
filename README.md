# Claude2

Claude Code VS Code extension rewrite with extra features.

## Development

```sh
npm install
npm run watch      # rebuild on change (esbuild + tsc type-check)
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.
Run the **Claude2: Hello World** command from the command palette to confirm it works.

## Scripts

| Script            | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `npm run compile` | Type-check, lint, and bundle to `dist/`        |
| `npm run watch`   | Incremental rebuild while editing              |
| `npm run lint`    | ESLint over `src/`                             |
| `npm test`        | Run integration tests in a VS Code instance    |
| `npm run package` | Production bundle (minified)                   |
| `npm run vsix`    | Build a `.vsix` for local install or publishing|

## Layout

- `src/extension.ts` — activation entry point
- `src/test/` — Mocha tests run by `@vscode/test-cli`
- `esbuild.js` — bundler config (CommonJS output to `dist/extension.js`)
- `.vscode/` — launch and task configs for F5 debugging
