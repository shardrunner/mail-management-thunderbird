---
summary: Automated Thunderbird smoke test and the remaining manual checks.
read_when:
  - Installing the XPIs or verifying behavior in a real Thunderbird
---

# Verification

## Automated

- `npm test`: unit tests with fake Thunderbird APIs and a fake provider, plus real archive
  packaging checks (needs Node.js 22+, `zip` and `unzip`; no npm install). GitHub Actions
  runs these tests and `npm run build` on Node.js 22 and 24 for pushes and pull requests.
  The isolated Thunderbird smoke test below is run separately, not in CI.
- `npm run build && npm run test:thunderbird -- --run`: installs both built XPIs into a new
  headless Thunderbird profile inside a network-isolated `bwrap` sandbox (needs `zip`,
  `unzip`, `bwrap`, `/usr/bin/thunderbird`). A test-only probe extension runs the packaged
  modules against synthetic Local Folders messages: folder eligibility, favorites/recent
  destination metadata and ordering, inline move banner injection in the 3-pane reading
  pane, MIME extraction, native HTML conversion (entities, malformed markup, hidden
  content and attachments over 1 MiB), quoted history, in-place compose replacement in
  both HTML (`isPlainText: false`) and plain-text (`isPlainText: true`) composers, inline
  compose banner isolation, stale Apply/undo/redo/refinement, saved MIME body, safe
  Capture/Apply refusal after native draft reopening, and an event-confirmed move.

## Manual checks

Use a separate profile (`thunderbird --no-remote --profile <dir>`) with test mail.

1. Settings: save endpoint/model/key; the endpoint access prompt appears; the key is gone
   after a Thunderbird restart.
2. Compose: write instructions above the quote in a reply (HTML or plain-text composer)
   and press `Alt+Shift+C`; the inline banner shows `Generating reply…`, then the
   instructions are replaced in place by the generated reply; quotes, signature,
   recipients, subject and attachments stay unchanged. Press `Ctrl+Z` to verify undo
   restores your instructions. Add a refinement instruction in the reply area and press
   `Alt+Shift+C` again.
3. Compose: type in the composer while a request is in flight → replacement refuses and
   shows the error in the inline banner without overwriting your edits. Empty reply area
   or unusual quote layouts also show an inline error banner at the top of the composer.
4. Move: select one message and press `Alt+Shift+M` (or click Move Suggest in the message
   header toolbar) → the inline bar appears at the top of the message reading pane,
   fetches the suggestion, pre-selects it, and `Enter` moves the message and clears the
   bar. Reopen on another message, type in the filter box (or press `ArrowDown`) and press
   `Enter` to move manually without an API key; excluded folders do not appear.
5. Provider errors (wrong key, wrong model) show a readable error in the inline bar at the
   top of the message reading pane or composer.
6. Favorites/recent: mark a filing folder as Favorite in Thunderbird, move a test message
   to another folder, then trigger Move Suggest. Check the labels/order, search, and
   manual selection without an API key. Special folders and their subfolders remain
   excluded.
7. Shortcuts: `Alt+Shift+C` in a composer runs in-place Compose Assist; `Alt+Shift+M` in
   the main window opens the inline Move Suggest bar. Reassign both in Manage Extension
   Shortcuts and check the new keys.
