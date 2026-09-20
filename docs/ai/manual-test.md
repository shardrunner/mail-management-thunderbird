---
summary: Automated Thunderbird smoke test and the remaining manual checks.
read_when:
  - Installing the XPI or verifying behavior in a real Thunderbird
---

# Verification

## Automated

- `npm test`: unit tests with fake Thunderbird APIs and a fake provider, plus real archive
  packaging checks (needs Node.js 22+, `zip` and `unzip`; no npm install).
- `npm run build && npm run test:thunderbird -- --run`: installs `dist/compose.xpi` into a
  new headless Thunderbird profile inside a network-isolated `bwrap` sandbox (needs `zip`,
  `unzip`, `bwrap`, `/usr/bin/thunderbird`). Verifies that the Welcome / Quick Start &
  Settings tab opens automatically on install, and a test-only probe extension runs the
  packaged modules against synthetic Local Folders messages: MIME extraction, native HTML
  conversion (entities, malformed markup, hidden content and attachments over 1 MiB),
  quoted history, in-place compose replacement in both HTML (`isPlainText: false`) and
  plain-text (`isPlainText: true`) composers, inline compose banner isolation, stale
  Apply/undo/redo/refinement, saved MIME body, and safe Capture/Apply refusal after native
  draft reopening.

## Manual checks

Use a separate profile (`thunderbird --no-remote --profile <dir>`) with test mail.

1. Welcome & Settings: on install, update, or Thunderbird startup, the Quick Start &
   Settings tab opens automatically. Save endpoint/model/key; the endpoint access prompt
   appears; the key is gone after a Thunderbird restart.
2. Compose: write instructions above the quote in a reply (HTML or plain-text composer)
   and press `Alt+Shift+C`; the inline banner shows `Generating reply…`, then the
   instructions are replaced in place by the generated reply; quotes, signature,
   recipients, subject and attachments stay unchanged. Press `Ctrl+Z` to verify undo
   restores your instructions. Add a refinement instruction in the reply area and press
   `Alt+Shift+C` again.
3. Compose: type in the composer while a request is in flight → replacement refuses and
   shows the error in the inline banner without overwriting your edits. Empty reply area
   or unusual quote layouts also show an inline error banner at the top of the composer.
4. Provider errors (wrong key, wrong model) show a readable error in the inline bar at the
   top of the composer.
5. Shortcuts: `Alt+Shift+C` in a composer runs in-place Compose Assist. Reassign it in
   Manage Extension Shortcuts and check the new key.
