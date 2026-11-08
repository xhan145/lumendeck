# Contributing to LumenDeck

Thanks for your interest in making LumenDeck better. Contributions of every size are welcome:
bug reports, docs fixes, presets, features, and polish all count.

Donations are entirely optional and are never required to contribute, get help, or have your
issues and pull requests taken seriously.

## Getting set up

```bash
npm install
npm run dev -- --host 127.0.0.1
```

Open `http://127.0.0.1:14200/`. The Vite server auto-starts the local Python
render bridge on port 8787, so a separate backend terminal is not required.

For the native Windows desktop app, use a Visual Studio C++ developer shell
(with the Windows SDK installed) and run:

```bash
npm run tauri:dev
```

The `tauri:dev` script uses `src-tauri/tauri.dev.conf.json` to skip the
frozen Python sidecar during development; Vite already runs `bridge/server.py`.
For a distributable `tauri build`, first create the packaged sidecar with
`python -m pip install pyinstaller` and `python bridge/build_sidecar.py`.
The production configuration still requires that binary.

Validate your changes before opening a PR:

```bash
npm run typecheck   # tsc --noEmit, must be clean
npm test            # vitest, must be all green
```

## Reporting bugs

Open a GitHub issue and include:

- What you did, what you expected, and what happened instead.
- Your platform (Windows version, GPU) and the LumenDeck version (shown in the top bar).
- The Diagnostics report when relevant: open **Diagnostics** in the app and copy the report.
  It captures backend/bridge/CUDA state and saves a lot of back-and-forth.

## Proposing features

Open an issue describing the problem you want solved (not just the solution) and how it fits
LumenDeck's local-first, no-telemetry direction. Small, focused proposals land faster.
Check [ROADMAP.md](ROADMAP.md) first — your idea may already be planned, and a +1 with your
use case helps prioritize it.

## Submitting code

1. Fork and branch from `main`.
2. Keep changes focused; match the existing code style and patterns of neighboring files.
3. Add or update tests for behavior you change (`tests/*.test.ts`).
4. Make sure `npm run typecheck` and `npm test` pass.
5. Open a pull request explaining what changed and why.

## Presets and docs

Not a coder? Two of the most valuable contributions are:

- **Presets**: well-tuned prompt/sampler presets or `.lumen` workflow templates worth bundling.
  Open an issue or PR with the preset and a sample render.
- **Documentation**: tutorials, clarifications, and fixes under `docs/` or in the README.
  If something confused you, it will confuse others — a docs PR is the fix.

## Conduct

Be kind and constructive. Assume good faith. Harassment or personal attacks are not tolerated.
