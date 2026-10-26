# Thunderbird Compose Assist

[![CI](https://github.com/shardrunner/mail-management-thunderbird/actions/workflows/ci.yml/badge.svg)](https://github.com/shardrunner/mail-management-thunderbird/actions/workflows/ci.yml)

> **Disclaimer:** This project is vibe coded for personal use. Use at your own risk.

A small, keyboard-first extension for **Thunderbird 158.0 or newer on Linux**:

- **Compose Assist** drafts or refines a reply in place from the plain text written above the quote (in both standard HTML and plain-text composers), using the quoted context and message metadata (`Subject`, `From`, `To`, `Date`, and attachment filenames).

## Install

```sh
npm test                           # Node.js 22+, zip + unzip; no npm install needed
npm run build                      # dist/compose.xpi (needs zip)
npm run test:thunderbird -- --run  # optional: isolated headless Thunderbird smoke test
```

Thunderbird → Add-ons and Themes → gear → **Install Add-on From File**.

## Configure

On install, update, or startup (or when triggered without a session API key), Compose Assist
opens its **Quick Start & Settings** tab automatically with a short overview of its workflow
and shortcut. Enter the model (default `gpt-6-luna`), an HTTPS endpoint ending in
`/v1/responses` (default `https://api.openai.com/v1/responses`) and an API key. Saving
asks for access to that endpoint. The key is kept only for the current Thunderbird session
and only for the endpoint it was saved with.

## Privacy and data flow

- When you trigger generation, Compose Assist sends the text above the quote, quoted
  context (including quoted message history), subject, sender and recipient addresses,
  date, and attachment filenames to your configured HTTPS provider endpoint.
- Attachment contents are not sent. Encrypted originals are rejected without decryption;
  text you paste into the composer cannot be identified as previously encrypted.
- Your API key is kept in Thunderbird session storage, not in persistent extension
  settings, and is used only with the endpoint it was saved for. Saving settings does not
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

See [design notes](docs/ai/design.md) for decisions and limits and
[manual checks](docs/ai/manual-test.md) for what is not automated.

Licensed under [MIT](LICENSE).
