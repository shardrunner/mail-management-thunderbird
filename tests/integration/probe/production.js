// Runs the exact modules extracted from the two built XPIs against synthetic mail only.
export async function productionChecks({ accounts, captured, destination, htmlMessage }) {
  const [{ createAdapter, composeReply }, { editorOperation }, { selectedMessageId, loadMessage, eligibleFolders, readMessageText, moveMessage }, { moveBannerOperation }] = await Promise.all([
    import('./extensions/compose/core.js'),
    import('./extensions/compose/editor.js'),
    import('./extensions/move/core.js'),
    import('./extensions/move/banner.js'),
  ]);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const inEditor = async func => (await browser.scripting.executeScript({ target: { tabId: tab.id }, func }))[0].result;
  const protectedNodes = () => inEditor(() => [...document.body.querySelectorAll('[mozquote],blockquote,.moz-cite-prefix,.moz-signature,span[style]')].map(n => n.outerHTML));
  const checks = {};

  // Move: message, folders, inline reading-pane banner and context.
  const [mailTab] = await browser.tabs.query({ type: 'mail' });
  assert(mailTab?.id, 'Expected a mail tab');
  assert(await selectedMessageId(browser, mailTab.id) === captured.id, 'selectedMessageId did not match displayed message');
  const message = await loadMessage(browser, captured.id);
  const rows = await eligibleFolders(browser, message.folder);
  const target = rows.find(row => row.id === destination.id);
  assert(target, 'Folder eligibility rejected the synthetic destination');
  const bannerLoading = (await browser.scripting.executeScript({
    target: { tabId: mailTab.id },
    func: moveBannerOperation,
    args: [{ state: 'loading', messageId: message.id, rows, status: 'Move Suggest: Suggesting folder…' }],
  }))[0]?.result;
  assert(bannerLoading?.ok, `Move loading banner failed: ${JSON.stringify(bannerLoading)}`);
  const bannerReady = (await browser.scripting.executeScript({
    target: { tabId: mailTab.id },
    func: moveBannerOperation,
    args: [{ state: 'ready', messageId: message.id, rows, suggestion: { label: target.label, rationale: 'smoke' }, status: `Suggested: ${target.label}` }],
  }))[0]?.result;
  assert(bannerReady?.ok && bannerReady.selected === target.label, `Move inline banner failed in message pane: ${JSON.stringify(bannerReady)}`);
  await browser.scripting.executeScript({ target: { tabId: mailTab.id }, func: moveBannerOperation, args: [{ state: 'clear' }] });
  assert(target.isFavorite, 'Thunderbird favorite flag was not reflected');
  const older = rows.find(row => row.id === htmlMessage.folder.id);
  assert(target.recentIndex != null && older?.recentIndex != null && target.recentIndex < older.recentIndex,
    'Thunderbird recent destination order was not reflected');
  assert(!rows.some(row => row.id === message.folder.id), 'Recent favorite source became eligible');
  const text = (await readMessageText(browser, message)).text;
  assert(text.includes('Synthetic local-only body.') && text.includes('> Earlier message history.'), 'MIME extraction omitted body or history');
  checks.context = { eligibleFolders: rows.length, favorite: true, recentOrder: true, sourceExcluded: true };
  assert(htmlMessage.size > 1024 * 1024, 'Expected a message with a large attachment');
  const html = await readMessageText(browser, htmlMessage);
  assert(html.text.includes('Price € — ©'), `Native HTML entity conversion failed: ${html.text}`);
  assert(/Next\s+line/.test(html.text) && html.text.includes('Malformed bold'), 'HTML text/layout lost');
  assert(!/HIDDEN_|ATTACHED_SECRET|<script|<img/.test(html.text), 'HTML leaked hidden or attached content');
  assert(html.attachmentNames.includes('attached.html') && html.attachmentNames.includes('large.pdf'), 'Attachment name lost');
  checks.html = { nativeConversion: true, entities: true, attachmentsExcluded: true, largeAttachment: true };

  // Compose in default HTML mode (isPlainText: false) on an HTML email reply.
  const htmlReplyTab = await browser.compose.beginReply(htmlMessage.id, 'replyToSender', {
    identityId: accounts[0].identities[0].id, isPlainText: false,
  });
  const htmlAdapter = createAdapter(browser, htmlReplyTab.id);
  const htmlInitial = await htmlAdapter.capture();
  assert(htmlInitial.context.includes('Price € — ©'), `HTML reply capture missed quoted text: ${htmlInitial.context}`);
  await htmlAdapter.apply(htmlInitial.snapshot, 'Write a polite reply.\nMention the price.');
  const htmlWithNotes = await htmlAdapter.capture();
  assert(htmlWithNotes.draft.includes('Write a polite reply.') && htmlWithNotes.draft.includes('Mention the price.'),
    `HTML multi-line capture failed: ${JSON.stringify(htmlWithNotes.draft)}`);
  await htmlAdapter.apply(htmlWithNotes.snapshot, 'Hi,\n\nThanks for the update.\n\nBest regards');
  const htmlAfter = await htmlAdapter.capture();
  assert(htmlAfter.draft.includes('Thanks for the update.') && htmlAfter.context.includes('Price € — ©'),
    `HTML composer multi-paragraph apply/recapture failed: ${JSON.stringify(htmlAfter)}`);
  await browser.tabs.remove(htmlReplyTab.id);
  checks.htmlCompose = true;

  // Compose: capture, Apply, stale Apply, undo/redo and in-place refinement on a plain-text reply.
  let tab = await browser.compose.beginReply(captured.id, 'replyToSender', {
    identityId: accounts[0].identities[0].id, isPlainText: true,
    cc: ['cc@example.invalid'], bcc: ['bcc@example.invalid'],
  });
  const adapter = createAdapter(browser, tab.id);
  let snapshot;
  try {
    snapshot = await adapter.capture();
  } catch (error) {
    throw new Error(`Initial reply capture: ${error.message} DOM=${await inEditor(() => document.body.innerHTML)}`);
  }
  assert(snapshot.context.includes('Synthetic local-only body.') && snapshot.context.includes('Earlier message history.'), 'Capture omitted the quoted original or history');
  const styledQuote = await inEditor(() => !document.querySelector('blockquote,[mozquote]')
    && [...document.body.childNodes].some(n => n.tagName === 'SPAN'
      && n.style.whiteSpace === 'pre-wrap' && n.style.display === 'block'));
  assert(styledQuote, 'Expected the supported Thunderbird 158 styled quote span');
  const protectedBefore = JSON.stringify(await protectedNodes());
  assert(protectedBefore !== '[]', 'No Thunderbird quote/signature DOM');
  const before = await browser.compose.getComposeDetails(tab.id);
  assert(before.isModified === false, 'Reply did not start clean');

  // Inline error/loading banner does not dirty the composer or alter document.body.
  await adapter.banner({ state: 'error', message: 'Write instructions above the quote first.' });
  assert((await browser.compose.getComposeDetails(tab.id)).isModified === false, 'Banner dirtied composer');
  await adapter.banner({ state: 'clear' });

  // Empty instructions above the quote are rejected before any provider call.
  let emptyRejected = false;
  try { await composeReply(adapter); } catch (error) { emptyRejected = /Write instructions/.test(error.message); }
  assert(emptyRejected, 'Expected empty instructions above the quote to be rejected');

  // Write instructions above the quote, then replace in place with generated reply.
  await adapter.apply(snapshot.snapshot, 'Synthetic instructions written in composer.');
  const withInstructions = await adapter.capture();
  assert(withInstructions.draft.includes('Synthetic instructions written in composer.'), 'Failed to write synthetic instructions');
  await composeReply({
    ...adapter,
    prepare: async req => req,
    request: async req => {
      const parsed = JSON.parse(req.prompt);
      assert(parsed.current_text.includes('Synthetic instructions written in composer.'), 'Prompt omitted composer instructions');
      assert(parsed.subject === 'Re: Synthetic smoke fixture', `Prompt omitted subject: ${parsed.subject}`);
      assert(parsed.from === 'Synthetic <synthetic@example.invalid>', `Prompt omitted from: ${parsed.from}`);
      assert(parsed.to === 'receiver@example.invalid', `Prompt omitted to: ${parsed.to}`);
      assert(parsed.date === 'Sat, 1 Jan 2022 00:00:00 +0000', `Prompt omitted date: ${parsed.date}`);
      return 'Synthetic generated reply.';
    },
  });
  assert((await adapter.capture()).draft.includes('Synthetic generated reply.'), 'In-place composeReply did not replace instructions');
  assert(JSON.stringify(await protectedNodes()) === protectedBefore, 'Apply changed quote/signature');
  const after = await browser.compose.getComposeDetails(tab.id);
  assert(after.isModified === true, 'Apply did not mark the composer modified');
  for (const field of ['to', 'cc', 'bcc', 'subject', 'identityId']) {
    assert(JSON.stringify(before[field]) === JSON.stringify(after[field]), `Apply changed ${field}`);
  }
  const stale = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: editorOperation, args: [{ action: 'apply', snapshot: snapshot.snapshot, draft: 'Must not apply.' }] });
  assert(stale[0].result?.ok === false, 'Stale Apply was accepted');

  assert(await inEditor(() => document.execCommand('undo')) === true, 'Undo rejected');
  assert((await adapter.capture()).draft.includes('Synthetic instructions written in composer.'), 'Undo did not restore the written instructions');
  assert(JSON.stringify(await protectedNodes()) === protectedBefore, 'Undo changed quote/signature');
  assert(await inEditor(() => document.execCommand('redo')) === true, 'Redo rejected');
  const redone = await adapter.capture();
  assert(redone.draft.includes('Synthetic generated reply.'), 'Redo failed');
  await adapter.apply(redone.snapshot, 'Synthetic refined reply.');
  assert((await adapter.capture()).draft.includes('Synthetic refined reply.'), 'Repeated Apply failed');
  assert(JSON.stringify(await protectedNodes()) === protectedBefore, 'Repeated Apply changed quote/signature');
  checks.compose = { quoteLayout: 'styled-span', apply: true, cleanStart: true, dirty: true, staleRejected: true, undo: true, redo: true, refine: true };

  // Exercise actual draft persistence, not Edit As New or an in-memory body copy.
  // Serialization normalizes editor boundary BRs; retain paragraph breaks and all text.
  const normalize = text => text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const beforeSave = await browser.compose.getComposeDetails(tab.id);
  const saved = await browser.compose.saveMessage(tab.id, { mode: 'draft' });
  assert(saved.mode === 'draft' && saved.messages.length === 1, 'Expected one saved draft');
  const persisted = await browser.messages.get(saved.messages[0].id);
  assert(persisted.folder.specialUse.includes('drafts'), 'Draft saved outside the synthetic Drafts folder');
  const savedText = (await readMessageText(browser, persisted)).text;
  assert(normalize(savedText) === normalize(beforeSave.plainTextBody),
    `Saved MIME body differs: ${JSON.stringify({ expected: beforeSave.plainTextBody, actual: savedText })}`);
  const originalTabId = tab.id;
  await browser.tabs.remove(originalTabId);
  // No public API reopens a draft as a draft; the isolated worker uses Thunderbird's native command.
  const response = await fetch('http://127.0.0.1:8765/reopen-draft', {
    method: 'POST', body: JSON.stringify({ messageId: persisted.id }),
  });
  const reopened = await response.json();
  assert(response.ok, `Reopen draft failed: ${reopened.error}`);
  tab = { id: reopened.tabId };
  assert(tab.id !== originalTabId, 'Draft reused the original composer');
  const details = await browser.compose.getComposeDetails(tab.id);
  assert(details.isPlainText && !details.isModified, 'Not a clean reopened plaintext draft');
  // TB158 flattens signature/attribution boundaries on reopen. Keep the safe refusal;
  // even Apply with the current snapshot must not overwrite an ambiguous editor.
  const reopenedAdapter = createAdapter(browser, tab.id);
  const reopenedDOM = await inEditor(() => document.body.innerHTML);
  for (const [action, attempt] of [
    ['Capture', () => reopenedAdapter.capture()],
    ['Apply', () => reopenedAdapter.apply(reopenedDOM, 'Must not overwrite the reopened draft.')],
  ]) {
    let rejected;
    try { await attempt(); } catch (error) { rejected = error; }
    assert(rejected?.message.includes('Unsupported composer layout'), `${action} did not safely reject the reopened layout`);
    assert(await inEditor(() => document.body.innerHTML) === reopenedDOM, `${action} changed the reopened draft`);
  }
  assert((await browser.compose.getComposeDetails(tab.id)).isModified === false, 'Rejected operations dirtied the reopened draft');
  checks.compose.draftRoundTrip = {
    saved: true, persistedBody: true, reopened: true,
    captureRejected: true, applyRejected: true, unchanged: true,
  };

  // Move last: it removes the message the reply was based on.
  checks.move = { outcome: await moveMessage(browser, message, target, 10000) };
  assert(checks.move.outcome === 'confirmed', `Move did not confirm: ${checks.move.outcome}`);
  return checks;
}
