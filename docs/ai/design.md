---
summary: Scope, architecture, decisions and known limits of the two Thunderbird extensions.
read_when:
  - Changing either extension or deciding whether a behavior is intended
---

# Design notes

Goal: small, keyboard-driven, fluff-free personal-use tools integrated directly into the
main Thunderbird workflow. No handling for extreme edge cases or hostile environments
beyond the safeguards listed below.

## Scope

- Thunderbird 158.0 or newer on Linux, matching the installed local version as the
  minimum. Both manifests enforce that minimum without an upper version bound;
  older Thunderbird versions are unsupported.
- Focused on in-place compose reply drafting and quick folder suggestion and filing inside
  Thunderbird. No external mail indexer, thread expansion, batch triage, attachment
  contents, cross-account moves, automatic sending or automatic filing.
- One provider type: an HTTPS OpenAI-style Responses endpoint. Requests use plain-text
  output, `reasoning.effort: none` and `service_tier: fast`; the default model is
  `gpt-6.1-terra`. This is the fastest setting without loss of quality in the
  [model evaluation](model-evaluation.md) (Compose Assist only; Move Suggest was not
  evaluated). Move Suggest asks for the folder label on the first line and keywords on the
  second; a label that is not exactly one eligible folder is an error. Models or endpoints
  that reject these values fail loudly.
- Plain-text reply drafting in both standard HTML (`isPlainText: false`) and plain-text
  (`isPlainText: true`) composers. Thunderbird owns the signature/name; the model writes
  the closing formula. Compose Assist reads whatever plain text is currently written above
  the quote (instructions, notes, or a draft with edits/notes) plus the quoted context and
  replaces the text above the quote in place.

## Architecture

```text
shared/               settings (+ options page), provider request, MIME text extraction, limits
extensions/compose/   background handles composeAction/shortcut triggers; core.js holds the
                      adapter and in-place reply flow; editor.js is injected into the composer
extensions/move/      background handles toolbar/header/shortcut/menu triggers; core.js holds
                      selection, folder eligibility and the move; banner.js renders the inline
                      bar at the top of the message reading pane
scripts/package.mjs   zips LICENSE + shared/ + extensions/<name>/ with the manifest at the root
tests/                node:test unit tests; tests/integration is the isolated Thunderbird smoke
```

- **Compose Assist** operates in place inside the composer window. Pressing `Alt+Shift+C`
  (or clicking the compose toolbar button) captures the plain text written above the quote
  and the quoted context, shows a Shadow DOM status banner on `document.documentElement`
  (outside `document.body`, so `document.body.innerHTML` and `isModified` are untouched),
  sends the request to the model, and replaces the text above the quote in place. If an
  error occurs, the inline banner displays the error right at the top of the composer (and
  dismisses automatically when typing or clicking). If no API key is set, the Settings tab
  opens automatically.
- **Move Suggest** injects a Shadow DOM inline bar (`banner.js`) at the top of the message
  reading pane in the main window when triggered via `Alt+Shift+M` (`commands.onCommand`),
  the message header button (`message_display_action`), the main toolbar button (`action`),
  or the message-list context menu (`menus`). Because Thunderbird's message list
  (`about:3pane`) is a privileged system-principal document where WebExtensions cannot
  inject DOM nodes, the bar renders inside `#messagepane` (temporarily opening
  `messagePaneVisible` if the reading pane was hidden and restoring it when moved or
  closed). It immediately shows `Suggesting folder…` with the folder filter and eligible
  folder list, updates in place with the suggested folder and rationale (or error message)
  when ready, and moves the message on `Enter`. Both extensions automatically open their
  Settings page (with a short quick-start guide) on first install or when triggered without
  an API key.
- Move Suggest reads favorites from `MailFolder.isFavorite` and queries the source
  account's `lastUsedAsDestination` history. This metadata only annotates the existing
  eligible-folder tree walk. No separate history store, new permissions, or history sent
  to the provider; destination values remain the original folder labels. Folder queries
  cannot replace ancestor checks for excluded subtrees.
- Toolbar and menu selections are paginated
  [`MessageList`s](https://webextension-api.thunderbird.net/en/mv3/guides/messageLists.html).
  Read until the list ends or a second message is found, then abort any remaining list.
  A first page containing one message does not prove a single selection.

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
- **Filing folders only:** special-use folders and their subtrees, virtual/tag/unified
  folders and the source are never offered. `messages.move` could otherwise move to Trash.
- **Move outcome from events:** the first matching `onMoved` or `onCopied` event determines
  the outcome. Without one, the result is uncertain 15 s after issuing `messages.move`,
  even if its promise is still pending. The deadline does not cancel Thunderbird's move;
  it may finish later. An API rejection before an event/deadline is shown as an error.
  Moves are never retried automatically, and each session permits only one attempt.
- **Session-only key by default**, bound to the endpoint it was saved with. An opt-in
  "Remember key" checkbox moves it to `storage.local` (unencrypted in the profile, since
  Thunderbird offers extensions no secret store); the key is only ever in one area, and
  the endpoint binding still applies.

## Latency

A draft takes about 1.1 s (median; p90 1.8 s), of which 0.7–0.8 s is the time to the first
token on the provider side. Local Thunderbird work is negligible. Streaming into the editor
would hide most of the wait, but conflicts with the single synchronous snapshot-checked
insertion above. Measurements and alternatives are in the [model evaluation](model-evaluation.md).

## Limits

Request 64 KiB, MIME depth 16 / 200 parts, request timeout 120 s
(`shared/limits.js`). Total message size (including attachments) does not prevent
suggestions. Thunderbird 158's decoded `getFull` omits attachment bodies; our MIME reader
also excludes attachment parts. Quoted message history stays in the body; separate thread
fetching is out of scope.

The smoke checks that inserted reply text, quote and signature survive MIME saving
(with Thunderbird's normal blank-line normalization), then closes and natively reopens
the draft. Thunderbird 158 can flatten signature/attribution boundaries on reopening;
refinement is unsupported in that layout. Capture and Apply must both reject it without
changing the editor, even with a current snapshot. Do not infer boundaries from plain text.
Header persistence and native shortcut routing are left to Thunderbird; interactive
checks remain in [verification](manual-test.md).
