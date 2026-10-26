# Thunderbird Compose Assist

[![CI](https://github.com/shardrunner/mail-management-thunderbird/actions/workflows/ci.yml/badge.svg)](https://github.com/shardrunner/mail-management-thunderbird/actions/workflows/ci.yml)

> **Disclaimer:** This project is vibe coded for personal use. Use at your own risk.

A small, keyboard-first extension for **Thunderbird 158.0 or newer on Linux**:

- **Compose Assist** drafts or refines a reply in place from the plain text written above the quote (in both standard HTML and plain-text composers), using the quoted context and message metadata (`Subject`, `From`, `To`, `Date`, and attachment filenames).

## Model evaluation

The default model and settings were chosen by a reproducible evaluation. It used six
synthetic emails, scored by automated checks (facts, register, language, placeholders,
prompt injection) and by a blind quality rating from two judge models of different vendors.

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
- Time to first token (≈ 0.7 s) is the limit.

Method, all reasoning levels, time-to-first-token analysis and limitations are in the
[full model evaluation](docs/ai/model-evaluation.md).

## Install

```sh
npm test                           # Node.js 22+, zip + unzip; no npm install needed
npm run build                      # dist/compose.xpi (needs zip)
npm run test:thunderbird -- --run  # optional: isolated headless Thunderbird smoke test
npm run evaluate -- --run          # optional: live model evaluation (keys in .env, billed)
```

Thunderbird → Add-ons and Themes → gear → **Install Add-on From File**.

## Configure

On install, update, or startup (or when triggered without an API key), Compose Assist
opens its **Quick Start & Settings** tab automatically with a short overview of its workflow
and shortcut. Enter the model (default `gpt-6.1-terra`, chosen by a [model evaluation](docs/ai/model-evaluation.md)), an HTTPS endpoint ending in
`/v1/responses` (default `https://api.openai.com/v1/responses`) and an API key. Saving
asks for access to that endpoint. By default the key is kept only for the current Thunderbird
session; tick **Remember key across restarts** to keep it persistently instead. Either way it
is used only with the endpoint it was saved with.

## Privacy and data flow

- When you trigger generation, Compose Assist sends the text above the quote, quoted
  context (including quoted message history), subject, sender and recipient addresses,
  date, and attachment filenames to your configured HTTPS provider endpoint.
- Attachment contents are not sent. Encrypted originals are rejected without decryption;
  text you paste into the composer cannot be identified as previously encrypted.
- By default your API key is kept in Thunderbird session storage and cleared on restart.
  If you opt in to remembering it, it is stored **unencrypted** in your Thunderbird profile
  (extension local storage), readable by anything with access to that profile, including
  backups. Either way it is used only with the endpoint it was saved for. Saving settings does not
  send a provider request.
- Requests set `store: false`, but your provider's own processing and retention policies
  still apply. Email content leaves your computer; only use a provider you trust with it.
- Compose Assist never sends email automatically. Review generated replies before sending.

## Use

In a reply composer, write your plain-text instructions or draft notes above the quote and
press **Alt+Shift+C** (or click Compose Assist):
- An inline banner at the top of the composer shows while the reply is being generated
  (and shows any error message clearly if a problem occurs).
- When ready, the text above the quote is replaced in place with the generated reply;
  quotes and your Thunderbird signature stay untouched.
- Press **Ctrl+Z** in the composer at any time to undo and restore your previous text.
- Edit or add follow-up instructions in the reply area and press **Alt+Shift+C** again to
  refine.
- Press **Alt+Shift+C** (or click **Cancel** on the inline banner) while a request is
  running to cancel it.
- If you edit the composer while a request is in flight, replacement is refused so your
  edits are never overwritten.
- Refine before closing the composer: reopened drafts may refuse replacement
  ([known limitation](docs/ai/design.md#limits)). Edit those drafts manually in Thunderbird.

Change the shortcut in Thunderbird → Add-ons and Themes → gear → **Manage Extension
Shortcuts**.

GitHub Actions runs the unit and packaging tests and builds the XPI on Node.js 22 and 24.
The isolated Thunderbird smoke test is run separately, not in CI.

See the [model evaluation](docs/ai/model-evaluation.md) for how the model and settings were
chosen, [design notes](docs/ai/design.md) for decisions and limits, and
[manual checks](docs/ai/manual-test.md) for what is not automated.

Licensed under [MIT](LICENSE).
