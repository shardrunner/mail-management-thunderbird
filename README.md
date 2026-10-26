# Thunderbird Compose Assist & Move Suggest

[![CI](https://github.com/shardrunner/mail-management-thunderbird/actions/workflows/ci.yml/badge.svg)](https://github.com/shardrunner/mail-management-thunderbird/actions/workflows/ci.yml)
![Thunderbird 158+](https://img.shields.io/badge/Thunderbird-158%2B-0a84ff?logo=thunderbird&logoColor=white)
![Manifest V3](https://img.shields.io/badge/WebExtension-Manifest%20V3-555)
![Dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Two small, independent, keyboard-first Thunderbird extensions.

**Compose Assist** turns rough notes into a draft reply directly inside the composer. Write
a few lines above the quote and press **Ctrl+Alt+C**: the notes are replaced in place by a
draft, typically in just over a second (1.14 s median in the [model
evaluation](#model-evaluation)). The quote and your signature stay untouched, and
**Ctrl+Z** restores your notes.

**Move Suggest** files the selected message: press **Ctrl+Alt+M** and a popup below its
toolbar button suggests a folder with a short rationale. Press **Enter** to move the
message, or type to pick another folder without waiting.

> **Disclaimer:** These extensions are vibe coded for personal use. Use at your own risk.

## Highlights

- **In-place, keyboard-driven workflow:** Compose Assist drafts and refines in the normal
  reply composer (HTML and plain text), with no pop-ups or review windows. The reply is
  inserted only if the composer still matches the snapshot taken at the start, so your
  edits are never overwritten.
- **Quick filing:** Move Suggest offers only same-account filing folders (never Inbox,
  Sent, Drafts, Templates, Outbox, Junk, Trash or their subfolders) and lists the
  suggestion first, then favorites and recently used folders. A move only counts as done
  when Thunderbird reports it.
- **Privacy safeguards:** encrypted mail is rejected without being decrypted, attachment
  contents are never sent, and the API key is kept for the current session only by default.
- **Evaluated and tested:** the default model was chosen by a reproducible evaluation of
  accuracy, writing quality, latency and cost. Unit tests run in CI, and a smoke test runs
  the packaged extensions in an isolated, headless Thunderbird.
- **Small and dependency-free:** vanilla JavaScript, no npm packages, and a build that only
  zips the extensions.

## How it works

```text
Your notes above the quote
        │
        ▼
Capture notes + editor snapshot ──▶ Read original mail (never decrypted)
                                            │
                                            ▼
                                    Build prompt ──▶ OpenAI-style Responses API
                                                              │
        ┌─────────────────────────────────────────────────────┘
        ▼
Snapshot unchanged? ── yes ──▶ Replace notes with the draft (Ctrl+Z to undo)
        │
        no ──▶ Refuse and show an error; your edits stay
```

The model sees the text above the quote (instructions, notes, or a draft with inline
edits), the quoted conversation and the message metadata (`Subject`, `From`, `To`, `Date`,
attachment filenames). An inline status banner reports progress and errors without
touching the message body.

Move Suggest reads the selected message the same way (never decrypted), sends it with the
list of eligible folder names, and expects the folder name on the first line of the answer
and a few keywords on the second. An answer that is not exactly one eligible folder is shown
as an error; you can still pick a folder yourself.

```text
Select message ──▶ Ctrl+Alt+M ──▶ Popup below the toolbar button
                                          │
             Eligible folders + message ──┴──▶ Suggested folder + keywords
                                                         │
                                                         ▼
                              Enter ──▶ Move ──▶ Thunderbird confirms ──▶ done
```

## Model evaluation

Six synthetic emails cover the failure modes that matter for this tool: English and German,
formal and informal register, missing facts, prompt injection hidden in the quoted mail,
and refining an existing draft. Across the six cases, 54 case-specific automated checks
assessed 540 drafts, and two judge models from different vendors rated 288 of them blind
for writing quality.

| Model and setting | Checks passed | Quality (1–5) | Median latency | USD / 1k drafts |
|---|---:|---:|---:|---:|
| **gpt-6.1-terra, no reasoning, Fast (default)** | **100 %** | **4.94** | **1.14 s** | **1.32** |
| gpt-6-luna, no reasoning, Fast | 100 % | 4.84 | 0.96 s | 0.13 |
| gpt-6-luna, medium reasoning, JSON (previous default) | 100 % | 4.90 | 1.85 s | 0.10 |
| gpt-6.1-sol, low reasoning, Ultrafast | 100 % | 4.79 | 1.08 s | 9.67 |
| gemini-3.8-flash, low thinking | 100 % | 4.89 | 2.24 s | 0.61 |
| Claude Haiku 5.5 via local `claude -p`, medium | 99.3 % | 4.63 | 4.37 s | 0.40 |

Key findings:

- Plain-text output instead of a JSON schema cut latency by 15–27 %.
- Higher reasoning effort added latency without improving the drafts.
- Time to first token (≈ 0.7 s) on the provider side is now the limiting factor.

The evaluation covers Compose Assist only. Move Suggest uses the same model and request
settings but has not been evaluated.

The method, all reasoning levels, the time-to-first-token analysis and the limitations are
in the [full model evaluation](docs/ai/model-evaluation.md).

## Getting started

**Requirements:** Thunderbird 158.0 or newer, Node.js 22+, `zip` and `unzip`, and
an API key for an OpenAI-style Responses endpoint.

```sh
npm test                           # unit and packaging tests (no npm install needed)
npm run build                      # creates dist/compose.xpi and dist/move.xpi
```

Install either or both builds in Thunderbird under **Add-ons and Themes → gear icon →
Install Add-on From File**.

### Configure

Each extension has its own **Quick Start & Settings** tab and its own key. Compose Assist
opens it on install, update and Thunderbird startup, and whenever a request fails because
of the API key; Move Suggest opens it on install and update and otherwise shows key errors
in its popup. Enter:

| Setting | Default |
|---|---|
| Model | `gpt-6.1-terra` |
| Endpoint (HTTPS, ending in `/v1/responses`) | `https://api.openai.com/v1/responses` |
| API key | kept for the current session only |

Saving asks Thunderbird for permission to access that endpoint. Tick **Remember key across
restarts** to store the key persistently instead. In both cases the key is only ever sent
to the endpoint it was saved with.

## Usage

### Compose Assist

| Action | How |
|---|---|
| Draft a reply | Write notes above the quote, press **Ctrl+Alt+C** or click **Compose Assist** |
| Refine the reply | Edit the text or add follow-up instructions, press **Ctrl+Alt+C** again |
| Cancel a running request | Press **Ctrl+Alt+C** again or click **Cancel** in the banner |
| Undo | **Ctrl+Z** restores the previous text |

- If you type in the composer while a request is running, the reply is not inserted, so
  your edits are never overwritten.
- Refine before closing the composer. Reopened drafts may refuse replacement
  ([known limitation](docs/ai/design.md#limits)).

### Move Suggest

| Action | How |
|---|---|
| Suggest a folder | Select one message, press **Ctrl+Alt+M** or click **Move Suggest** (main toolbar, message header or message-list context menu) |
| Move to the suggestion | **Enter** or click **Move**; the popup closes once Thunderbird confirms the move |
| Pick another folder | Type in the filter box or use **Up/Down**, then **Enter**; no need to wait for the model, and no API key needed |
| Close | **Esc** or click elsewhere; a running request is dropped |

- The popup works with the reading pane hidden (`F8`). In message tabs and windows it opens
  below the message header button.
- Keep the **Move Suggest** button in the main toolbar: the shortcut and the context menu
  open the popup from it.

Change either shortcut under **Add-ons and Themes → gear icon → Manage Extension
Shortcuts**.

## Privacy and data flow

- **Sent on request only:** Compose Assist sends the text above the quote, the quoted
  conversation, subject, sender and recipient addresses, date and attachment filenames to
  your configured HTTPS endpoint. Move Suggest sends the selected message's subject,
  author, recipients, CC, date, body text and attachment filenames together with the
  eligible folder names. Nothing is sent when you save the settings.
- **Not sent:** attachment contents. Encrypted originals are rejected without decryption.
  Text you paste into the composer cannot be recognised as previously encrypted.
- **API key:** kept in session storage by default and cleared on restart. If you opt in to
  remembering it, it is stored **unencrypted** in your Thunderbird profile, readable by
  anything with access to that profile, including backups.
- **Provider retention:** requests set `store: false`, but your provider's own processing
  and retention policies still apply. Only use a provider you trust with your email.
- **No automatic sending or filing:** Compose Assist never sends email, and Move Suggest
  only moves a message when you confirm. Review each reply before sending it.

## Testing and quality

| Layer | Command | Runs in CI |
|---|---|:---:|
| Unit and packaging tests (`node:test`, fakes for Thunderbird APIs) | `npm test` | ✓ |
| Extension builds | `npm run build` | ✓ |
| Headless smoke test in an isolated Thunderbird (after build; needs `bwrap`) | `npm run test:thunderbird -- --run` | |
| Live model evaluation on synthetic mail (billed) | `npm run evaluate -- --run` | |
| Blind two-judge quality rating (billed) | `npm run judge -- --run --in=FILE` | |

CI runs on GitHub Actions with Node.js 22 and 24. The smoke test runs the packaged
extension's compose logic inside a network-isolated Thunderbird with synthetic mail and a
fake provider. It checks capture and replacement in HTML and plain-text composers, that
quote and signature stay intact, and undo, redo and draft reopening in the plain-text
composer. It also runs the packaged Move Suggest logic (folder eligibility, favorites and
recent destinations) and opens the real popup through its shortcut, where a typed filter
and **Enter** must produce an event-confirmed move. UI and shortcut checks that are not
automated are listed in the [manual test plan](docs/ai/manual-test.md).

## Project structure

```text
extensions/compose/   manifest, background triggers, in-place reply flow, injected editor script, prompt
extensions/move/      manifest, triggers, folder eligibility, suggestion and move, popup, prompt
shared/               (copied into both) settings page, provider request, MIME text extraction, limits
scripts/              packaging, Thunderbird smoke runner, model evaluation and judging
tests/                unit tests; tests/integration holds the smoke-test harness
docs/ai/              design notes, model evaluation, manual test plan
```

## Documentation

- [Design notes](docs/ai/design.md): scope, architecture, safeguards and limits
- [Model evaluation](docs/ai/model-evaluation.md): method, results and trade-offs
- [Manual test plan](docs/ai/manual-test.md): checks that are not automated

## License

[MIT](LICENSE)
