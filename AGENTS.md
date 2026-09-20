# AGENTS.md

Agent guidance for this repository.

## Purpose

A small Thunderbird 158.0+ (Linux, MV3) extension for personal use:
**Compose Assist** (draft or refine a reply in place from plain text written above the
quote, with an inline status/error banner).
Vanilla JavaScript, no dependencies, no build step beyond zipping.
(Work on **Move Suggest** is tracked separately on the `feat/move-suggest` branch.)

## Read first

1. `README.md`: install, configure, use.
2. `docs/ai/design.md`: scope, architecture, the safeguards that must stay, limits.

If this file conflicts with `docs/ai/design.md`, follow `design.md` and fix this file.

## Commands

```sh
npm test                           # unit + packaging tests; zip/unzip, no npm install
npm run build                      # dist/compose.xpi (needs zip)
npm run test:thunderbird -- --run  # after build: isolated headless Thunderbird smoke test
```

Run the smoke test after changing `extensions/compose/editor.js`, `extensions/compose/core.js`,
or anything Thunderbird API-related; unit tests only use fakes.

## Layout

- `shared/`: settings and options page, provider request, MIME text extraction, limits.
- `extensions/compose/`: `manifest.json`, `background.js` (registers compose action,
  command, install/startup listeners), `core.js` (in-place capture, generation and
  replacement), `policy.js` (prompt and schema), `editor.js` (injected into the composer for
  capture/apply/banner).
- `scripts/package.mjs`: `dist/compose.xpi` = LICENSE + `shared/` + `extensions/compose/`,
  with the manifest at the archive root. Any file added there is shipped; `*.md` is excluded.
- `tests/integration/`: sandboxed smoke runner and a test-only probe extension.

## Priorities

- **Keep it simple, keyboard-driven and focused.** Personal use: no separate review
  windows, no handling for extreme edge cases, cross-context races or defense-in-depth.
  Prefer removing code over adding options.
- **Keep the safeguards in `docs/ai/design.md`:** never decrypt mail, the synchronous
  editor snapshot check before in-place replacement, session-only key bound to its endpoint.

## Thunderbird pitfalls

- `background.js` is a **classic script**: no `import`/`export` declarations. It must
  register listeners synchronously at top level.
- `editor.js` is serialized by `scripting.executeScript`: keep it self-contained, with no
  imports or outer variables.
- Read mail with `messages.getFull(id, { decrypt: false })`.
- Follow the reopened-draft boundary restriction in `docs/ai/design.md`; the smoke checks
  both HTML and plain-text composers as well as reopened drafts.

## Safety for agents

- Never use the user's real Thunderbird profile or mailbox, and never make a live provider
  request, without explicit approval. Use synthetic data and the sandboxed smoke test.
- Do not commit secrets or `dist/`.
