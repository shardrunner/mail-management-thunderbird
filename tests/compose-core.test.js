import test from 'node:test';
import assert from 'node:assert/strict';
import { composeReply, createAdapter, makePrompt, registerComposeBackground, validateResult } from '../extensions/compose/core.js';
import { waitFor } from './helpers.js';

function setup() {
  const calls = { prepare: [], request: 0, apply: [] };
  let draft = 'decline politely, suggest Tuesday', respond;
  const adapter = {
    capture: async () => ({
      snapshot: `snap:${draft}`,
      subject: 'Re: Budget Q4',
      from: 'Alice <alice@example.org>',
      to: 'me@example.org',
      date: 'Fri, 24 Oct 2026 10:00:00 +0000',
      attachments: ['budget.pdf'],
      draft,
      context: 'quoted',
    }),
    prepare: async request => {
      calls.prepare.push(request);
      return { endpoint: 'https://example.test/v1/responses', model: 'm', body: request.prompt, apiKey: 'k' };
    },
    request: (prepared, signal) => {
      calls.request++;
      return new Promise((resolve, reject) => {
        respond = resolve;
        signal?.addEventListener('abort', () => reject(new Error('Request cancelled.')));
      });
    },
    apply: async (snapshot, next) => {
      calls.apply.push([snapshot, next]);
      draft = next;
    },
  };
  return { adapter, calls, setDraft: value => { draft = value; }, respond: value => respond(value) };
}

test('composeReply sends the text above the quote and replaces it in place; refinement uses the updated text', async () => {
  const x = setup();
  const first = composeReply(x.adapter);
  await waitFor(() => x.calls.request === 1, 'first request');
  assert.deepEqual(JSON.parse(x.calls.prepare[0].prompt), {
    subject: 'Re: Budget Q4',
    from: 'Alice <alice@example.org>',
    to: 'me@example.org',
    date: 'Fri, 24 Oct 2026 10:00:00 +0000',
    attachments: ['budget.pdf'],
    current_text: 'decline politely, suggest Tuesday',
    quoted_context: 'quoted',
  });
  x.respond('First generated reply');
  assert.equal(await first, 'First generated reply');
  assert.deepEqual(x.calls.apply, [['snap:decline politely, suggest Tuesday', 'First generated reply']]);

  x.setDraft('First generated reply\n\nMake it shorter.');
  const second = composeReply(x.adapter);
  await waitFor(() => x.calls.request === 2, 'second request');
  assert.deepEqual(JSON.parse(x.calls.prepare[1].prompt), {
    subject: 'Re: Budget Q4',
    from: 'Alice <alice@example.org>',
    to: 'me@example.org',
    date: 'Fri, 24 Oct 2026 10:00:00 +0000',
    attachments: ['budget.pdf'],
    current_text: 'First generated reply\n\nMake it shorter.',
    quoted_context: 'quoted',
  });
  x.respond('Shorter reply');
  assert.equal(await second, 'Shorter reply');
  assert.deepEqual(x.calls.apply[1], ['snap:First generated reply\n\nMake it shorter.', 'Shorter reply']);
});

test('empty text above the quote is rejected before calling the provider', async () => {
  const x = setup();
  x.setDraft('   \n  ');
  assert.throws(() => makePrompt({ draft: '  ', context: 'q' }), /Write instructions/);
  assert.doesNotMatch(makePrompt({ draft: 'hi', context: 'q' }), /\n/);
  await assert.rejects(composeReply(x.adapter), /Write instructions/);
  assert.equal(x.calls.request, 0);
});

test('model result must be a non-empty reply text', () => {
  assert.throws(() => validateResult(' \n'));
  assert.throws(() => validateResult(undefined));
  assert.equal(validateResult('\nHi,\n\nx\n'), 'Hi,\n\nx');
});

test('adapter: HTML and plain-text composers supported, headers/attachments captured, originals inspected without decryption, encrypted originals rejected', async () => {
  const calls = [];
  let details = { isPlainText: false, relatedMessageId: 42, subject: 'Re: Newsletter', from: 'Me <me@example.org>', to: ['Sender <sender@example.org>'] };
  let original = {
    contentType: 'text/html',
    headers: { from: ['Original Sender <sender@example.org>'], to: ['alias@example.org'], date: ['Sat, 1 Jan 2022 00:00:00 +0000'], subject: ['Newsletter'] },
    body: '<p>newsletter</p>',
  };
  let composeAttachments = [{ name: 'reply-note.txt' }];
  const api = {
    compose: {
      getComposeDetails: async () => details,
      listAttachments: async () => composeAttachments,
    },
    messages: { getFull: async (...args) => { calls.push(args); return original; } },
    scripting: { executeScript: async ({ target, args }) => [{ result: { ok: true, tabId: target.tabId, args } }] },
  };
  const adapter = createAdapter(api, 9);
  const firstCapture = await adapter.capture();
  assert.equal(firstCapture.tabId, 9, 'HTML composer is allowed when writing plain text');
  assert.equal(firstCapture.subject, 'Re: Newsletter');
  assert.equal(firstCapture.from, 'Original Sender <sender@example.org>');
  assert.equal(firstCapture.to, 'alias@example.org');
  assert.equal(firstCapture.date, 'Sat, 1 Jan 2022 00:00:00 +0000');
  assert.deepEqual(firstCapture.attachments, ['reply-note.txt']);
  assert.deepEqual(calls, [[42, { decrypt: false }]]);
  original = { contentType: 'multipart/mixed', parts: [{ contentType: 'image/png', name: 'photo.png' }] };
  const secondCapture = await adapter.capture();
  assert.equal(secondCapture.tabId, 9, 'originals without readable text can still be answered');
  assert.equal(secondCapture.from, 'Sender <sender@example.org>', 'falls back to compose To when original headers are absent');
  assert.equal(secondCapture.to, 'Me <me@example.org>', 'falls back to compose From when original headers are absent');
  assert.deepEqual(secondCapture.attachments, ['photo.png', 'reply-note.txt']);
  original = { contentType: 'multipart/mixed', parts: [{ contentType: 'text/plain', body: 'x' }, { contentType: 'application/pkcs7-mime' }] };
  await assert.rejects(adapter.capture(), /ncrypted/);
  original = { contentType: 'multipart/encrypted', parts: [] };
  await assert.rejects(adapter.capture(), /ncrypted/);
  assert.deepEqual((await adapter.apply('s', 'd')).args, [{ action: 'apply', snapshot: 's', draft: 'd' }]);
});

test('background controller replaces text in place, shows inline banner on loading/error, cancels on second press, and opens Settings when key is missing', async t => {
  let body = 'acknowledge receipt', releaseFetch = null, optionsOpened = 0;
  const badges = [], titles = [], banners = [];
  let apiKey = { key: 'k', endpoint: 'https://api.openai.com/v1/responses' };
  const reply = 'Generated reply';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (releaseFetch === false) {
      await new Promise((resolve, reject) => {
        releaseFetch = resolve;
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply }] }] }));
  });
  const api = {
    composeAction: {
      setBadgeText: async ({ tabId, text }) => { badges.push([tabId, text]); },
      setTitle: async ({ tabId, title }) => { titles.push([tabId, title]); },
    },
    runtime: { openOptionsPage: async () => { optionsOpened++; } },
    storage: {
      local: { get: async () => ({}) },
      session: { get: async () => ({ apiKey }) },
    },
    compose: { getComposeDetails: async () => ({ isPlainText: false }) },
    scripting: {
      executeScript: async ({ args: [args] }) => {
        if (args.action === 'banner') { banners.push(args.banner); return [{ result: { ok: true } }]; }
        if (args.action === 'apply') { body = args.draft; return [{ result: { ok: true } }]; }
        return [{ result: { ok: true, snapshot: body, draft: body, context: 'quote' } }];
      },
    },
  };
  const bg = registerComposeBackground(api);

  await bg.onClicked({ id: 7 });
  assert.equal(body, 'Generated reply');
  assert.deepEqual(badges.slice(-2), [[7, '…'], [7, '']]);
  assert.equal(banners.at(-2).state, 'loading');
  assert.equal(banners.at(-1).state, 'clear');

  // Pressing again while in flight cancels the active request.
  releaseFetch = false;
  const pending = bg.onClicked({ id: 7 });
  await waitFor(() => typeof releaseFetch === 'function', 'in-flight request');
  await bg.onClicked({ id: 7 });
  await pending;
  assert.equal(badges.at(-1)[1], '');
  assert.equal(banners.at(-1).state, 'clear');

  // Missing API key shows inline error banner and opens options page.
  apiKey = null;
  await bg.onClicked({ id: 7 });
  assert.equal(badges.at(-1)[1], '!');
  assert.equal(banners.at(-1).state, 'error');
  assert.match(banners.at(-1).message, /API key/);
  assert.equal(optionsOpened, 1);
});
