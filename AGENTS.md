# AGENTS.md

Agent guidance for this repository.

## Purpose

Two small, independent Thunderbird 158.0+ (Linux, MV3) extensions for personal use:
**Compose Assist** (draft or refine a reply in place from plain text written above the
quote, with an inline status/error banner) and **Move Suggest** (inline bar at the top of
the message reading pane in the main window that suggests a folder and moves one message).
Vanilla JavaScript, no dependencies, no build step beyond zipping.

## Read first

1. `README.md`: install, configure, use.
2. `docs/ai/design.md`: scope, architecture, the safeguards that must stay, limits.

If this file conflicts with `docs/ai/design.md`, follow `design.md` and fix this file.

## Commands

```sh
npm test                           # unit + packaging tests; zip/unzip, no npm install
npm run build                      # dist/compose.xpi, dist/move.xpi (needs zip)
npm run test:thunderbird -- --run  # after build: isolated headless Thunderbird smoke test
npm run evaluate -- --run           # live model evaluation on synthetic mail (billed)
npm run judge -- --run --in=FILE    # blind two-judge quality rating of evaluated drafts (billed)
```

`npm run evaluate` reads `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `GEMINI_API_KEY` from
the gitignored `.env` in the repository root (`--runs=N`, `--only=regex`, `--out=file`;
`--summarize=file` rebuilds the tables offline; `npm run judge` works the same way).
Cases and checks are in `scripts/eval-cases.mjs`; results are in
`docs/ai/model-evaluation.md`. Both make real, billed provider requests with synthetic mail
only; run them only with the user's approval.

Run the smoke test after changing `extensions/compose/editor.js`, `extensions/move/banner.js`,
either `core.js`, or anything Thunderbird API-related; unit tests only use fakes.

## Layout

- `shared/`: settings and options page, provider request, MIME text extraction, limits.
  Copied into both XPIs; there is no runtime link between the extensions.
- `extensions/compose/`: `manifest.json`, `background.js` (registers compose action and
  command listeners), `core.js` (in-place capture, generation and replacement), `policy.js`
  (prompt), `editor.js` (injected into the composer for capture/apply/banner).
- `extensions/move/`: `manifest.json`, `background.js` (registers toolbar, message header,
  command and menu listeners), `core.js` (selection, folder eligibility, suggestion and
  move), `policy.js` (prompt), `banner.js` (inline bar injected into the
  message reading pane).
- `scripts/package.mjs`: each XPI = LICENSE + `shared/` + `extensions/<name>/`, with the
  manifest at the archive root. Any file added there is shipped; `*.md` is excluded.
- `tests/integration/`: sandboxed smoke runner and a test-only probe extension.

## Priorities

- **Keep it simple, keyboard-driven and focused.** Personal use: no separate review
  windows, no handling for extreme edge cases, cross-context races or defense-in-depth.
  Prefer removing code over adding options.
- **Keep the safeguards in `docs/ai/design.md`:** never decrypt mail, the synchronous
  editor snapshot check before in-place replacement, filing-folder exclusions, move outcome
  only from Thunderbird events, session-only key by default (opt-in persistence), bound to
  its endpoint.

## Thunderbird pitfalls

- `background.js` files are **classic scripts**: no `import`/`export` declarations. They
  must register listeners synchronously at top level.
- `editor.js` and `banner.js` are serialized by `scripting.executeScript`: keep them
  self-contained, with no imports or outer variables.
- Read mail with `messages.getFull(id, { decrypt: false })`.
- Follow the reopened-draft boundary restriction in `docs/ai/design.md`; the smoke checks
  both HTML and plain-text composers as well as reopened drafts.
- `messages.move` can copy instead of moving, and its promise is not proof of success.

## Safety for agents

- Never use the user's real Thunderbird profile or mailbox, and never make a live provider
  request, without explicit approval. Use synthetic data and the sandboxed smoke test.
- Do not commit secrets or `dist/`.
