import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { startPopup } from '../extensions/move/popup.js';
import { waitFor } from './helpers.js';

// Just enough DOM for popup.html: a select's value must name one of its options.
function fakeDocument() {
  const listeners = {};
  const element = tag => ({
    tag, textContent: '', disabled: false, children: [], listeners: {}, _value: '',
    get value() { return this._value; },
    set value(v) { this._value = this.tag !== 'select' || this.children.some(o => o.value === v) ? v : ''; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    replaceChildren(...children) { this.children = children; if (!children.some(o => o.value === this._value)) this._value = ''; },
  });
  const nodes = Object.fromEntries(['status', 'error', 'search', 'move', 'settings'].map(id => [id, element('input')]));
  nodes.folders = element('select');
  const doc = {
    closed: false,
    getElementById: id => nodes[id],
    createElement: () => ({ value: '', textContent: '' }),
    addEventListener(name, fn) { listeners[name] = fn; },
    key(key, target = nodes.search) { listeners.keydown({ key, target, preventDefault() {} }); },
  };
  doc.defaultView = { close() { doc.closed = true; } };
  return { doc, $: id => nodes[id] };
}

function setup({
  reply = 'Local/Projects\nproject keywords',
  onFetch,
  tabType = 'mail',
  selected = [{ id: 7 }],
  apiKey = { key: 'session-key', endpoint: 'https://api.openai.com/v1/responses' },
  moveEvent = 'onMoved',
} = {}) {
  const { doc, $ } = fakeDocument();
  const moves = [];
  let optionsOpened = 0;
  const listeners = {};
  const folder = { id: 'src', accountId: 'a', path: '/Inbox', specialUse: ['inbox'] };
  const message = { id: 7, folder, subject: 'Captured subject', author: 'sender', date: new Date(0) };
  const storage = { local: {}, session: apiKey ? { apiKey } : {} };
  globalThis.fetch = async () => {
    await onFetch?.();
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] }));
  };
  const api = {
    runtime: { openOptionsPage: async () => { optionsOpened++; } },
    tabs: { query: async () => [{ id: 1, type: tabType }] },
    mailTabs: { getSelectedMessages: async () => ({ messages: selected }) },
    messageDisplay: { getDisplayedMessage: async () => message },
    storage: { local: { get: async () => storage.local }, session: { get: async () => storage.session } },
    accounts: { get: async () => ({ id: 'a', name: 'Local', rootFolder: { subFolders: [folder, { id: 'p', path: '/Projects' }, { id: 'o', path: '/Other', isFavorite: true }] } }) },
    folders: { query: async () => [], getFolderCapabilities: async () => ({ canAddMessages: true, canDeleteMessages: true }) },
    messages: {
      get: async () => message,
      getFull: async () => ({ contentType: 'text/plain', body: 'body' }),
      move: async (...args) => { moves.push(args); listeners[moveEvent]?.({ messages: [message] }, { messages: [{ folder: { id: args[1] } }] }); },
      onMoved: { addListener(fn) { listeners.onMoved = fn; }, removeListener() {} },
      onCopied: { addListener(fn) { listeners.onCopied = fn; }, removeListener() {} },
    },
  };
  return { api, doc, $, moves, started: startPopup(api, doc), optionsOpened: () => optionsOpened };
}

test('popup shows the suggestion preselected and Enter moves and closes it', async () => {
  let release;
  const p = setup({ onFetch: () => new Promise(r => { release = r; }) });
  await waitFor(() => release, 'request sent');
  assert.equal(p.$('status').textContent, 'Suggesting folder…');
  assert.equal(p.$('move').disabled, true);
  release();
  await p.started;
  assert.equal(p.$('status').textContent, 'Suggested: Local/Projects — project keywords');
  assert.equal(p.$('folders').value, 'Local/Projects');
  assert.equal(p.$('folders').children[0].textContent, 'Suggested: Local/Projects');
  p.doc.key('Enter');
  await waitFor(() => p.doc.closed, 'popup closed after confirmed move');
  assert.deepEqual(p.moves, [[[7], 'p', { isUserAction: true }]]);
});

test('typing or arrows pick a folder before the suggestion, which then does not override it', async () => {
  let release;
  const p = setup({ onFetch: () => new Promise(r => { release = r; }) });
  await waitFor(() => release, 'request sent');
  p.$('search').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(p.$('folders').value, 'Local/Other'); // favorite first
  p.$('search').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(p.$('folders').value, 'Local/Projects');
  p.$('search').value = 'oth';
  p.$('search').listeners.input();
  assert.equal(p.$('folders').value, 'Local/Other');
  release();
  await p.started;
  assert.equal(p.$('folders').value, 'Local/Other');
  assert.equal(p.$('move').disabled, false);
});

test('a message tab uses the displayed message instead of a selection', async () => {
  const p = setup({ tabType: 'messageDisplay', selected: [] });
  await p.started;
  assert.equal(p.$('folders').value, 'Local/Projects');
});

test('an invalid suggestion is shown as an error and manual move still works', async () => {
  const p = setup({ reply: 'Nope\nx' });
  await p.started;
  assert.match(p.$('error').textContent, /invalid folder/);
  assert.equal(p.$('move').disabled, true);
  p.$('folders').value = 'Local/Other';
  p.$('folders').listeners.change();
  p.$('move').listeners.click();
  await waitFor(() => p.doc.closed, 'popup closed');
  assert.deepEqual(p.moves, [[[7], 'o', { isUserAction: true }]]);
});

test('a copy outcome keeps the popup open and locked', async () => {
  const p = setup({ moveEvent: 'onCopied' });
  await p.started;
  p.doc.key('Enter');
  await waitFor(() => /copy, not a move/.test(p.$('status').textContent), 'copy outcome shown');
  assert.equal(p.doc.closed, false);
  assert.equal(p.$('move').disabled, true);
  p.doc.key('Enter');
  assert.equal(p.moves.length, 1);
});

test('without an API key the popup stays for manual filing; a multi-selection is rejected', async () => {
  const noKey = setup({ apiKey: null });
  await noKey.started;
  assert.match(noKey.$('error').textContent, /API key/);
  assert.equal(noKey.optionsOpened(), 0);
  noKey.$('search').value = 'proj';
  noKey.$('search').listeners.input();
  noKey.doc.key('Enter');
  await waitFor(() => noKey.doc.closed, 'manual move without key');
  noKey.$('settings').listeners.click();
  assert.equal(noKey.optionsOpened(), 1);

  const multi = setup({ selected: [{ id: 1 }, { id: 2 }] });
  await multi.started;
  assert.match(multi.$('error').textContent, /exactly one message/);
  assert.equal(multi.$('move').disabled, true);
});

async function loadBackground({ actionOpens = true } = {}) {
  const calls = [], on = {};
  const event = name => ({ addListener: fn => { on[name] = fn; } });
  const browser = {
    action: { openPopup: async options => { calls.push(['action', { ...options }]); return actionOpens; } },
    messageDisplayAction: { openPopup: async options => { calls.push(['messageDisplayAction', { ...options }]); return true; } },
    mailTabs: { setSelectedMessages: async (tabId, ids) => { calls.push(['select', tabId, [...ids]]); } },
    commands: { onCommand: event('command') },
    menus: { onClicked: event('menu'), create: () => {} },
    runtime: { onInstalled: event('installed'), openOptionsPage: () => {} },
  };
  vm.runInNewContext(await readFile(new URL('../extensions/move/background.js', import.meta.url), 'utf8'), { browser });
  return { calls, on };
}

test('shortcut opens the toolbar popup in the main window, else the message header popup', async () => {
  const main = await loadBackground();
  await main.on.command('move-suggest', { id: 1, type: 'mail', windowId: 3 });
  assert.deepEqual(main.calls, [['action', { windowId: 3 }]]);

  const noButton = await loadBackground({ actionOpens: false });
  await noButton.on.command('move-suggest', { id: 1, type: 'mail', windowId: 3 });
  await noButton.on.command('move-suggest', { id: 2, type: 'messageDisplay', windowId: 4 });
  assert.deepEqual(noButton.calls, [['action', { windowId: 3 }], ['messageDisplayAction', { windowId: 3 }], ['messageDisplayAction', { windowId: 4 }]]);
});

test('context menu selects the clicked messages before opening the popup', async () => {
  const bg = await loadBackground();
  await bg.on.menu({ menuItemId: 'move-suggest', selectedMessages: { messages: [{ id: 9 }] } }, { id: 1, type: 'mail', windowId: 3 });
  assert.deepEqual(bg.calls, [['select', 1, [9]], ['action', { windowId: 3 }]]);
});
