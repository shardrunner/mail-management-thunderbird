import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMoveBackground } from '../extensions/move/core.js';
import { moveBannerOperation } from '../extensions/move/banner.js';
import { waitFor } from './helpers.js';

function setupDom() {
  const nodes = new Map();
  let appended = null;
  function makeEl(tag = 'div') {
    return {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      value: '',
      textContent: '',
      disabled: false,
      hidden: false,
      dataset: {},
      style: {},
      children: [],
      listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      replaceChildren(...children) { this.children = children; },
      focus() { this.focused = true; },
      click() { this.listeners.click?.({ preventDefault() {} }); },
      remove() { if (appended === this) appended = null; },
      set innerHTML(_) {
        for (const id of ['bar', 'status', 'error', 'controls', 'search', 'folders', 'move', 'settings', 'close']) {
          const el = makeEl(id);
          el.id = id;
          nodes.set(id, el);
        }
      },
      querySelector: sel => nodes.get(sel.replace(/^#/, '')),
    };
  }
  globalThis.document = {
    body: { style: {} },
    documentElement: { appendChild(el) { appended = el; } },
    getElementById: id => (appended?.id === id ? appended : null),
    createElement: makeEl,
  };
  return { nodes, getHost: () => appended };
}

async function setupMove({
  selected = [{ id: 7 }],
  reply = 'Local/Projects\nproject keywords',
  onFetch,
  favorite = false,
  recent = [],
  senderTabId = -1,
  messagePaneVisible = true,
  apiKey = { key: 'session-key', endpoint: 'https://api.openai.com/v1/responses' },
} = {}) {
  const dom = setupDom();
  const requests = [], moves = [], banners = [], paneUpdates = [];
  let moved = null, optionsOpened = 0, paneVisible = messagePaneVisible;
  const folder = { id: 'src', accountId: 'a', path: '/Inbox', specialUse: ['inbox'] };
  const message = { id: 7, folder, subject: 'Captured subject', author: 'sender', size: 10, date: new Date(0) };
  const storage = { local: {}, session: apiKey ? { apiKey } : {} };
  const area = name => ({
    get: async () => structuredClone(storage[name]),
    set: async v => Object.assign(storage[name], v),
  });
  let bg;
  globalThis.fetch = async (url, init) => {
    requests.push(init.body);
    if (onFetch) await onFetch(init);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] }] }));
  };
  const api = {
    runtime: {
      openOptionsPage: async () => { optionsOpened++; },
      sendMessage: msg => bg.onMessage(msg, { tab: { id: senderTabId } }),
    },
    action: { setBadgeText: async () => {}, setTitle: async () => {} },
    messageDisplayAction: { setBadgeText: async () => {}, setTitle: async () => {} },
    messageDisplay: { getDisplayedMessage: async () => message },
    mailTabs: {
      getSelectedMessages: async () => ({ messages: selected }),
      setSelectedMessages: async () => {},
      get: async () => ({ messagePaneVisible: paneVisible }),
      update: async (_tabId, props) => {
        if (typeof props.messagePaneVisible === 'boolean') {
          paneVisible = props.messagePaneVisible;
          paneUpdates.push(paneVisible);
        }
      },
    },
    storage: { local: area('local'), session: area('session') },
    accounts: { get: async () => ({ id: 'a', name: 'Local', rootFolder: { subFolders: [folder, { id: 'p', path: '/Projects', isFavorite: favorite }, { id: 'o', path: '/Other' }] } }) },
    folders: { query: async () => recent.map(id => ({ id })), getFolderCapabilities: async () => ({ canAddMessages: true, canDeleteMessages: true }) },
    messages: {
      get: async () => message,
      getFull: async () => ({ contentType: 'text/plain', body: 'SELECTED MESSAGE ONLY' }),
      move: async (...args) => { moves.push(args); moved?.({ messages: [message] }, { messages: [{ folder: { id: args[1] } }] }); },
      onMoved: { addListener(fn) { moved = fn; }, removeListener() { moved = null; } },
      onCopied: { addListener() {}, removeListener() {} },
    },
    scripting: {
      executeScript: async ({ args: [payload] }) => {
        banners.push(payload);
        return [{ result: moveBannerOperation(payload) }];
      },
    },
  };
  globalThis.browser = api;
  bg = registerMoveBackground(api);
  return { api, bg, dom, requests, moves, banners, paneUpdates, optionsOpened: () => optionsOpened };
}

test('inline banner shows loading, then preselects suggestion when ready, and Enter moves and clears even when sender.tab.id is -1', async () => {
  const m = await setupMove({ senderTabId: -1 });
  await m.bg.onTriggered({ id: 1 });
  assert.equal(m.banners[0].state, 'loading');
  assert.equal(m.banners[1].state, 'ready');
  assert.match(m.dom.nodes.get('status').textContent, /Suggested: Local\/Projects — project keywords/);
  assert.equal(m.dom.nodes.get('folders').value, 'Local/Projects');
  assert.equal(m.dom.nodes.get('move').disabled, false);

  m.dom.getHost().listeners.keydown({ key: 'Enter', target: m.dom.nodes.get('search'), preventDefault() {} });
  await waitFor(() => m.moves.length === 1, 'move dispatched');
  assert.deepEqual(m.moves, [[[7], 'p', { isUserAction: true }]]);
  await waitFor(() => m.dom.getHost() === null, 'banner cleared after confirmed move');
});

test('move-confirm still succeeds if background event page restarted and lost in-memory sessions', async () => {
  const m = await setupMove({ senderTabId: -1 });
  await m.bg.onTriggered({ id: 1 });
  // Simulate MV3 background event-page restart by creating a fresh background instance.
  const freshBg = registerMoveBackground(m.api);
  m.api.runtime.sendMessage = msg => freshBg.onMessage(msg, { tab: { id: -1 } });

  m.dom.getHost().listeners.keydown({ key: 'Enter', target: m.dom.nodes.get('search'), preventDefault() {} });
  await waitFor(() => m.moves.length === 1, 'stateless move dispatched');
  assert.deepEqual(m.moves, [[[7], 'p', { isUserAction: true }]]);
  await waitFor(() => m.dom.getHost() === null, 'banner cleared after stateless move');
});

test('when triggered from message list with hidden message pane, temporarily opens pane and restores it after move', async () => {
  const m = await setupMove({ messagePaneVisible: false });
  await m.bg.onTriggered({ id: 1 });
  assert.deepEqual(m.paneUpdates, [true]);

  m.dom.getHost().listeners.keydown({ key: 'Enter', target: m.dom.nodes.get('search'), preventDefault() {} });
  await waitFor(() => m.moves.length === 1, 'move dispatched');
  await waitFor(() => m.paneUpdates.length === 2, 'message pane restored');
  assert.deepEqual(m.paneUpdates, [true, false]);
});

test('typing or arrows in inline banner selects a folder without waiting for AI', async () => {
  let release;
  const m = await setupMove({
    favorite: true,
    recent: ['p', 'o'],
    onFetch: () => new Promise(r => { release = r; }),
  });
  const pending = m.bg.onTriggered({ id: 1 });
  await waitFor(() => m.banners.length === 1, 'loading banner rendered');
  const $ = id => m.dom.nodes.get(id);
  assert.equal($('folders').value, '');
  assert.equal($('move').disabled, true);

  $('search').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal($('folders').value, 'Local/Projects');
  $('search').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal($('folders').value, 'Local/Other');

  // Late AI suggestion does not overwrite manual choice.
  release();
  await pending;
  assert.equal($('folders').value, 'Local/Other');

  // Typing filters and auto-selects top match.
  $('search').value = 'Projects';
  $('search').listeners.input();
  assert.equal($('folders').value, 'Local/Projects');
});

test('AI error is displayed in the inline banner while keeping manual move working', async () => {
  const m = await setupMove({ reply: 'Nope\nx' });
  await m.bg.onTriggered({ id: 1 });
  const $ = id => m.dom.nodes.get(id);
  assert.match($('error').textContent, /invalid folder/);
  assert.equal($('folders').value, '');
  assert.equal($('move').disabled, true);

  $('folders').value = 'Local/Other';
  $('folders').listeners.change();
  $('move').listeners.click();
  await waitFor(() => m.moves.length === 1, 'manual move dispatched');
  assert.deepEqual(m.moves, [[[7], 'o', { isUserAction: true }]]);
});

test('missing API key or invalid selection shows error in the inline banner', async () => {
  const noKey = await setupMove({ apiKey: null });
  await noKey.bg.onTriggered({ id: 1 });
  assert.match(noKey.dom.nodes.get('error').textContent, /API key/);
  assert.equal(noKey.optionsOpened(), 1);

  const multi = await setupMove({ selected: [{ id: 1 }, { id: 2 }] });
  await multi.bg.onTriggered({ id: 1 });
  assert.match(multi.dom.nodes.get('error').textContent, /exactly one message/);
  assert.equal(multi.dom.nodes.get('move').disabled, true);
});
