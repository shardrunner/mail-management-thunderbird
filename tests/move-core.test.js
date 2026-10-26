import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedMessageId, loadMessage, eligibleFolders, readMessageText, suggestedFolder, orderedFolders, moveMessage } from '../extensions/move/core.js';

function event() {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn),
    removeListener: fn => listeners.delete(fn),
    emit: (...args) => listeners.forEach(fn => fn(...args)),
    count: () => listeners.size,
  };
}

const flatten = folder => [folder, ...(folder.subFolders ?? []).flatMap(flatten)];

function fixture() {
  const folder = (id, path, extra = {}) => ({ id, path, name: path.split('/').pop(), accountId: 'a', specialUse: [], ...extra });
  const source = folder('src', '/Inbox', { specialUse: ['inbox'], subFolders: [folder('inboxChild', '/Inbox/Sub')] });
  const projects = folder('p', '/Projects', { subFolders: [folder('c', '/Projects/Work')] });
  const trash = folder('trash', '/Trash', { specialUse: ['trash'], subFolders: [folder('deep', '/Trash/Old')] });
  const folders = [source, projects, trash, folder('archive', '/Archive', { specialUse: ['archives'] }), folder('virtual', '/Search', { isVirtual: true })];
  const message = { id: 7, folder: source, subject: 'Subject' };
  const moves = [];
  const api = {
    accounts: { get: async () => ({ id: 'a', name: 'Local', rootFolder: folder('root', '/', { isRoot: true, subFolders: folders }) }) },
    // Every folder of the requested account is writable unless a test says otherwise.
    folders: { query: async q => q.canAddMessages ? flatten((await api.accounts.get(q.accountId, true)).rootFolder) : [], getFolderCapabilities: async () => ({ canDeleteMessages: true }) },
    messages: {
      get: async () => structuredClone(message),
      getFull: async () => ({ contentType: 'text/plain', body: 'body' }),
      move: async (...args) => { moves.push(args); },
      onMoved: event(),
      onCopied: event(),
    },
  };
  return { api, message, moves };
}

test('selectedMessageId checks paginated selection pages and aborts unused lists', async () => {
  const aborted = [];
  const firstPage = { id: 'selection', messages: [{ id: 3 }] };
  let next = { id: 'selection', messages: [{ id: 4 }] };
  const api = {
    mailTabs: { getSelectedMessages: async () => firstPage },
    messages: {
      continueList: async id => { assert.equal(id, 'selection'); return next; },
      abortList: async id => { aborted.push(id); },
    },
  };
  await assert.rejects(selectedMessageId(api), /exactly one message/);
  assert.deepEqual(aborted, ['selection']);
  next = { id: null, messages: [] };
  assert.equal(await selectedMessageId(api), 3);
  assert.equal(aborted.length, 1);
});

test('loadMessage requires a stored message whose folder allows removal', async () => {
  const f = fixture();
  assert.equal((await loadMessage(f.api, 7)).id, 7);
  f.api.folders.getFolderCapabilities = async () => ({});
  await assert.rejects(loadMessage(f.api, 7), /cannot be moved/);
  f.api.messages.get = async () => ({ id: 7, external: true });
  await assert.rejects(loadMessage(f.api, 7), /stored in a folder/);
});

test('eligible folders include parents and archive, exclude source, special subtrees and virtual', async () => {
  const f = fixture();
  const rows = await eligibleFolders(f.api, f.message.folder);
  assert.deepEqual(rows.map(r => r.label).sort(), ['Local/Archive', 'Local/Projects', 'Local/Projects/Work']);
});

test('labels are built from display names, not raw IMAP paths', async () => {
  const f = fixture();
  const sub = { id: 'u', path: '/INBOX.&AMQ-rger & Co.Unter &ANw-', name: 'Unter Ü', specialUse: [] };
  const umlaut = { id: 'x', path: '/INBOX.&AMQ-rger & Co', name: 'Ärger & Co', specialUse: [], subFolders: [sub] };
  f.api.accounts.get = async () => ({ id: 'a', name: 'Mail', rootFolder: { subFolders: [umlaut] } });
  assert.deepEqual((await eligibleFolders(f.api, f.message.folder)).map(r => r.label), ['Mail/Ärger & Co', 'Mail/Ärger & Co/Unter Ü']);
});

test('eligible folders fetch only the source account and reject a missing account', async () => {
  const f = fixture();
  const account = await f.api.accounts.get('a', true);
  f.api.accounts = { get: async (id, includeSubFolders) => {
    assert.equal(id, f.message.folder.accountId);
    assert.equal(includeSubFolders, true);
    return account;
  } };
  assert.ok((await eligibleFolders(f.api, f.message.folder)).length);
  f.api.accounts.get = async () => null;
  await assert.rejects(eligibleFolders(f.api, f.message.folder), /Source account not found/);
});

test('eligible folders require add capability', async () => {
  const f = fixture();
  const query = f.api.folders.query;
  f.api.folders.query = async q => (await query(q)).filter(folder => folder.id !== 'p');
  assert.ok(!(await eligibleFolders(f.api, f.message.folder)).some(r => r.id === 'p'));
});

test('favorites and recent history annotate only eligible folders', async () => {
  const f = fixture();
  const account = await f.api.accounts.get();
  for (const folder of account.rootFolder.subFolders) folder.isFavorite = true;
  f.api.accounts.get = async () => account;
  const query = f.api.folders.query;
  f.api.folders.query = async q => {
    if (q.canAddMessages) return query(q);
    assert.deepEqual(q, { accountId: 'a', lastUsedAsDestination: { recent: true }, sort: 'lastUsedAsDestination' });
    return ['trash', 'deep', 'src', 'inboxChild', 'virtual', 'other-account', 'archive', 'p'].map(id => ({ id }));
  };
  const rows = await eligibleFolders(f.api, f.message.folder);
  assert.deepEqual(rows.map(r => r.id).sort(), ['archive', 'c', 'p']);
  assert.equal(rows.find(r => r.id === 'archive').isFavorite, true);
  assert.ok(rows.find(r => r.id === 'archive').recentIndex < rows.find(r => r.id === 'p').recentIndex);
  assert.equal(rows.find(r => r.id === 'c').recentIndex, null);
});

test('folder order is suggested, favorites, recent newest first, then alphabetical; search preserves it', () => {
  const rows = [
    { label: 'Plain Z' }, { label: 'Recent old', recentIndex: 2 },
    { label: 'Favorite Z', isFavorite: true }, { label: 'Plain A' },
    { label: 'Favorite B-old', isFavorite: true, recentIndex: 3 },
    { label: 'Recent new', recentIndex: 1 }, { label: 'Favorite A', isFavorite: true },
    { label: 'Favorite Z-new', isFavorite: true, recentIndex: 0 },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(orderedFolders(rows, 'Plain Z').map(r => r.label),
    ['Plain Z', 'Favorite Z-new', 'Favorite B-old', 'Favorite A', 'Favorite Z', 'Recent new', 'Recent old', 'Plain A']);
  assert.deepEqual(orderedFolders(rows, null, 'RECENT').map(r => r.label), ['Recent new', 'Recent old']);
  assert.deepEqual(rows, before);
});

test('HTML message text uses Thunderbird conversion without decrypting or reading attachments', async () => {
  const f = fixture();
  f.api.messages.getFull = async (id, options) => {
    assert.equal(id, f.message.id);
    assert.deepEqual(options, { decrypt: false });
    return { contentType: 'multipart/mixed', parts: [
      { contentType: 'text/html', body: '<p>&euro;</p>' },
      { contentType: 'text/html', name: 'attached.html', body: 'ATTACHED' },
    ] };
  };
  f.api.messengerUtilities = { convertToPlainText: async (html, options) => {
    assert.equal(html, '<p>&euro;</p>');
    assert.deepEqual(options, { flowed: false });
    return '€';
  } };
  assert.deepEqual(await readMessageText(f.api, f.message), { text: '€', attachmentNames: ['attached.html'] });
});

test('suggestion must be an allowed folder label; suggested folder is listed first', () => {
  const rows = [{ label: 'Zulu' }, { label: 'Alpha' }];
  assert.throws(() => suggestedFolder('Other\nx', rows), /invalid folder/);
  assert.throws(() => suggestedFolder('', rows), /invalid folder/);
  assert.deepEqual(suggestedFolder('Zulu\nkw', rows), { label: 'Zulu', rationale: 'kw' });
  assert.deepEqual(suggestedFolder(' Zulu \n\n kw, more \n', rows), { label: 'Zulu', rationale: 'kw, more' });
  assert.deepEqual(suggestedFolder('Zulu', rows), { label: 'Zulu', rationale: '' });
  assert.deepEqual(orderedFolders(rows, 'Zulu').map(r => r.label), ['Zulu', 'Alpha']);
  assert.deepEqual(orderedFolders(rows, null, 'alp').map(r => r.label), ['Alpha']);
});

for (const [kind, expected] of [['onMoved', 'confirmed'], ['onCopied', 'copied']]) {
  test(`${kind} event determines the outcome without waiting for the API promise`, { timeout: 1000 }, async () => {
    const f = fixture();
    const target = { id: 'p' };
    f.api.messages.move = () => {
      f.api.messages[kind].emit({ messages: [f.message] }, { messages: [{ id: 99, folder: target }] });
      return new Promise(() => {}); // The event is authoritative even while the API promise is pending.
    };
    assert.equal(await moveMessage(f.api, f.message, target, 50), expected);
    assert.equal(f.api.messages.onMoved.count() + f.api.messages.onCopied.count(), 0);
  });
}

test('missing or unrelated events leave the outcome uncertain', async () => {
  const f = fixture();
  f.api.messages.move = async () => f.api.messages.onMoved.emit({ messages: [{ id: 1 }] }, { messages: [{ folder: { id: 'p' } }] });
  assert.equal(await moveMessage(f.api, f.message, { id: 'p' }, 5), 'uncertain');
});

test('the move deadline runs even while the API promise is pending; late rejection is handled', { timeout: 2000 }, async t => {
  const f = fixture();
  let rejectMove, notifyMove;
  const dispatched = new Promise(resolve => { notifyMove = resolve; });
  f.api.messages.move = (...args) => {
    f.moves.push(args);
    return new Promise((_, reject) => { rejectMove = reject; notifyMove(); });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const moving = moveMessage(f.api, f.message, { id: 'p' }, 15000);
  await dispatched;
  t.mock.timers.tick(15000);
  assert.equal(await moving, 'uncertain');
  assert.equal(f.moves.length, 1);
  assert.equal(f.api.messages.onMoved.count() + f.api.messages.onCopied.count(), 0);
  rejectMove(new Error('Late API failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('a move API failure is reported and listeners are removed', async () => {
  const f = fixture();
  f.api.messages.move = async () => { throw new Error('Move unavailable'); };
  await assert.rejects(moveMessage(f.api, f.message, { id: 'p' }), /Move unavailable/);
  assert.equal(f.api.messages.onMoved.count() + f.api.messages.onCopied.count(), 0);
});

test('the first matching event determines the outcome', async () => {
  const f = fixture();
  f.api.messages.move = async () => {
    const result = { messages: [{ folder: { id: 'p' } }] };
    f.api.messages.onCopied.emit({ messages: [f.message] }, result);
    f.api.messages.onMoved.emit({ messages: [f.message] }, result);
  };
  assert.equal(await moveMessage(f.api, f.message, { id: 'p' }), 'copied');
});
