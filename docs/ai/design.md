---
summary: Scope, architecture, decisions and known limits of the Compose Assist Thunderbird extension.
read_when:
  - Changing the extension or deciding whether a behavior is intended
---

# Design notes

Goal: a small, keyboard-driven, fluff-free personal-use tool integrated directly into the
main Thunderbird compose workflow. No handling for extreme edge cases or hostile environments
beyond the safeguards listed below.

## Scope

- Thunderbird 158.0 or newer on Linux, matching the installed local version as the
  minimum. The manifest enforces that minimum without an upper version bound;
  older Thunderbird versions are unsupported.
- Focused on in-place compose reply drafting inside Thunderbird. No external mail indexer,
  thread expansion, attachment contents, or automatic sending.
- One provider type: an HTTPS OpenAI-style Responses endpoint with strict JSON schema output.
- Plain-text reply drafting in both standard HTML (`isPlainText: false`) and plain-text
  (`isPlainText: true`) composers. Thunderbird owns the signature/name; the model writes
  the closing formula. Compose Assist reads whatever plain text is currently written above
  the quote (instructions, notes, or a draft with edits/notes), the quoted context, and
  message metadata (`Subject`, `From`, `To`, `Date`, and attachment filenames), and
  replaces the text above the quote in place.

## Architecture

```text
shared/               settings (+ options page), provider request, MIME text extraction, limits
extensions/compose/   background handles composeAction/shortcut/install/startup triggers;
                      core.js holds the adapter and in-place reply flow; editor.js is injected
                      into the composer
scripts/package.mjs   zips LICENSE + shared/ + extensions/compose/ with the manifest at the root
tests/                node:test unit tests; tests/integration is the isolated Thunderbird smoke
```

- **Compose Assist** operates in place inside the composer window. Pressing `Alt+Shift+C`
  (or clicking the compose toolbar button) captures the plain text written above the quote
  and the quoted context, shows a Shadow DOM status banner on `document.documentElement`
  (outside `document.body`, so `document.body.innerHTML` and `isModified` are untouched),
  sends the request to the model, and replaces the text above the quote in place. If an
  error occurs, the inline banner displays the error right at the top of the composer (and
  dismisses automatically when typing or clicking). On install, update, startup, or when no
  API key is set, the Quick Start & Settings tab opens automatically.

## Safeguards kept on purpose

- **Encrypted mail:** originals are read with `getFull(id, {decrypt:false})`; the entire
  MIME tree, including attachment subtrees, is checked for encryption and depth/part
  limits before use. Encrypted messages are rejected, never decrypted. Attachment
  contents are not extracted. HTML bodies use Thunderbird's native
  [`messengerUtilities.convertToPlainText`](https://webextension-api.thunderbird.net/en/mv3/messengerUtilities.html#converttoplaintext-body-options)
  with `flowed: false` after that check; plain-text alternatives remain preferred. This
  avoids bespoke HTML/entity parsing. `listInlineTextParts` is not a substitute because
  it automatically decrypts mail. Pasted decrypted text cannot be detected.
- **Safe in-place replacement:** `editor.js` compares the captured editor snapshot and
  inserts the reply with a native `insertText` in one synchronous step, so typing while the
  model is generating makes replacement fail instead of overwriting edits. Quotes/signature
  are never touched; unknown layouts are rejected. Both Thunderbird 158's styled plaintext
  quote span and HTML reply `blockquote[type=cite]` (preceded by `.moz-cite-prefix`) are
  recognized. `compose.setComposeDetails` cannot replace the synchronous editor operation:
  it offers neither an atomic snapshot check nor selective reply insertion. The smoke
  verifies protected nodes and native undo/redo (`Ctrl+Z`).
- **Session-only key**, bound to the endpoint it was saved with.

## Limits

Request 64 KiB, MIME depth 16 / 200 parts, request timeout 120 s
(`shared/limits.js`). Total message size (including attachments) does not prevent
drafting. Thunderbird 158's decoded `getFull` omits attachment bodies; our MIME reader
also excludes attachment parts. Quoted message history stays in the body; separate thread
fetching is out of scope.

The smoke checks that inserted reply text, quote and signature survive MIME saving
(with Thunderbird's normal blank-line normalization), then closes and natively reopens
the draft. Thunderbird 158 can flatten signature/attribution boundaries on reopening;
refinement is unsupported in that layout. Capture and Apply must both reject it without
changing the editor, even with a current snapshot. Do not infer boundaries from plain text.
Header persistence and native shortcut routing are left to Thunderbird; interactive
checks remain in [verification](manual-test.md).

Not verified: a live provider call with `gpt-6-luna`, the full interactive UI in
Thunderbird, IMAP accounts.
