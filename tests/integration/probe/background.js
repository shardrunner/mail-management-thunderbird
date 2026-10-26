// Test extension only. No provider code, keys, remote mailbox, or send API.
(async () => {
  const checks = {};
  function assert(condition, message) { if (!condition) throw new Error(message); }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(fn, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  }
  async function list(folderId) {
    let page = await browser.messages.list(folderId);
    const messages = [...page.messages];
    while (page.id) { page = await browser.messages.continueList(page.id); messages.push(...page.messages); }
    return messages;
  }
  let result;
  try {
    const accounts = await browser.accounts.list(true);
    assert(accounts.length === 1 && accounts[0].type === 'local', 'Expected one synthetic Local Folders account');
    function flatten(folder) { return [folder, ...(folder.subFolders || []).flatMap(flatten)]; }
    const folders = flatten(accounts[0].rootFolder);
    const source = folders.find(folder => folder.name === 'SmokeSource');
    const destination = folders.find(folder => folder.name === 'SmokeDestination');
    assert(source && destination, 'Missing synthetic folders');
    const sourceFresh = await browser.folders.get(source.id, false);
    const destinationFresh = await browser.folders.get(destination.id, false);
    const sourceCaps = await browser.folders.getFolderCapabilities(source.id);
    const destinationCaps = await browser.folders.getFolderCapabilities(destination.id);
    assert(sourceCaps.canDeleteMessages === true && destinationCaps.canAddMessages === true, 'Folder capabilities not affirmative');
    assert(sourceFresh.accountId === destinationFresh.accountId, 'Different accounts');
    checks.foldersGet = { idType: typeof source.id, sourceDelete: sourceCaps.canDeleteMessages, destinationAdd: destinationCaps.canAddMessages };
    const messages = await until(async () => { const items = await list(source.id); return items.length ? items : null; }, 'local message indexing');
    assert(messages.length === 1 && messages[0].headerMessageId === 'smoke-fixture@example.invalid', 'Unexpected synthetic message');
    const captured = await browser.messages.get(messages[0].id);
    const htmlFolder = folders.find(folder => folder.name === 'SmokeHtml');
    assert(htmlFolder, 'Missing synthetic HTML folder');
    const htmlMessages = await until(async () => {
      const items = await list(htmlFolder.id); return items.length ? items : null;
    }, 'HTML message indexing');
    assert(htmlMessages.length === 1, 'Unexpected HTML message count');
    const full = await browser.messages.getFull(captured.id, { decrypt: false });
    assert(full && captured.folder.id === source.id, 'Message get/getFull source mismatch');
    checks.messageRead = true;

    let moved = null, copied = false;
    browser.messages.onMoved.addListener((original, updated) => {
      if (original.messages.some(message => message.id === captured.id)) moved = { original, updated };
    });
    browser.messages.onCopied.addListener(original => {
      if (original.messages.some(message => message.id === captured.id)) copied = true;
    });
    const {productionChecks}=await import('./production.js');
    checks.production=await productionChecks({accounts,captured,destination,htmlMessage:htmlMessages[0]});
    await until(() => moved, 'messages.onMoved');
    const remaining = await list(source.id), filed = await list(destination.id);
    assert(!copied && remaining.length === 0 && filed.length === 1, 'Move did not remove source exactly once');
    assert(filed[0].headerMessageId === captured.headerMessageId && filed[0].folder.id === destination.id, 'Moved wrong message');
    assert(moved.updated.messages.some(message => message.folder.id === destination.id), 'Move event destination mismatch');
    checks.move = { event: true, copyEvent: copied, sourceCount: remaining.length, destinationCount: filed.length };
    result = { ok: true, checks };
  } catch (error) { result = { ok: false, checks, error: error.message }; }
  // This is loopback inside an isolated network namespace, never a provider request.
  await fetch('http://127.0.0.1:8765/result', { method: 'POST', body: JSON.stringify(result) });
})();
