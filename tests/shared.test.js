import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, loadSettings, loadApiKey, saveSettings } from '../shared/settings.js';
import { prepareRequest, requestJson } from '../shared/provider.js';
import { assertNotEncrypted, extractMessage } from '../shared/mail.js';
import { LIMITS } from '../shared/limits.js';

function storageApi() {
  const data = { local: {}, session: {} };
  const area = name => ({ get: async () => structuredClone(data[name]), set: async values => Object.assign(data[name], structuredClone(values)) });
  return { data, api: { storage: { local: area('local'), session: area('session') } } };
}

const other = { endpoint: 'https://example.org/proxy/v1/responses', model: 'm' };
const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const envelope = text => JSON.stringify({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text }] }] });

test('settings require an HTTPS Responses endpoint and a model', () => {
  for (const endpoint of ['http://example.org/v1/responses', 'https://example.org/v1/chat/completions', 'not a url']) {
    assert.throws(() => validateSettings({ endpoint, model: 'm' }));
  }
  assert.throws(() => validateSettings({ endpoint: DEFAULT_SETTINGS.endpoint, model: ' ' }));
  assert.deepEqual(validateSettings(other), other);
});

test('API key is session-only and bound to the endpoint it was saved with', async () => {
  const { api, data } = storageApi();
  assert.deepEqual(await loadSettings(api), DEFAULT_SETTINGS);
  await saveSettings(DEFAULT_SETTINGS, ' secret ', api);
  assert.equal(await loadApiKey(DEFAULT_SETTINGS.endpoint, api), 'secret');
  assert.doesNotMatch(JSON.stringify(data.local), /secret/);
  await api.storage.local.set({ settings: other });
  assert.equal(await loadApiKey(other.endpoint, api), '');
});

test('prepared request is the exact Responses body with a strict schema', async t => {
  const { api } = storageApi();
  await assert.rejects(prepareRequest({ system: 's', prompt: 'p', schema, schemaName: 'answer' }, api), /API key/);
  await saveSettings(DEFAULT_SETTINGS, 'key', api);
  const prepared = await prepareRequest({ system: 's', prompt: 'mail', schema, schemaName: 'answer' }, api);
  const body = JSON.parse(prepared.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.store, false);
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'answer', strict: true, schema });
  await assert.rejects(prepareRequest({ system: 's', prompt: 'x'.repeat(70000), schema, schemaName: 'answer' }, api), /too large/);

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, DEFAULT_SETTINGS.endpoint);
    assert.equal(init.body, prepared.body);
    assert.equal(init.headers.Authorization, 'Bearer key');
    return new Response(envelope('{"answer":"ok"}'));
  });
  assert.deepEqual(await requestJson(prepared), { answer: 'ok' });
});

test('preparation never pairs its selected endpoint with another endpoint’s key', async () => {
  let reads = 0;
  const api = { storage: {
    local: { get: async () => ({ settings: ++reads === 1 ? DEFAULT_SETTINGS : other }) },
    session: { get: async () => ({ apiKey: { endpoint: other.endpoint, key: 'other-key' } }) },
  } };
  await assert.rejects(prepareRequest({ system: 's', prompt: 'p', schema, schemaName: 'answer' }, api), /API key/);
});

test('provider failures and cancellation are reported', async t => {
  const prepared = { endpoint: DEFAULT_SETTINGS.endpoint, body: '{}', apiKey: 'k' };
  const respond = response => t.mock.method(globalThis, 'fetch', async () => response);
  respond(new Response('nope', { status: 401 }));
  await assert.rejects(requestJson(prepared), /HTTP 401/);
  respond(new Response(JSON.stringify({ status: 'incomplete', output: [] })));
  await assert.rejects(requestJson(prepared), /no complete answer/);

  t.mock.method(globalThis, 'fetch', (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
  const controller = new AbortController();
  const pending = requestJson(prepared, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('MIME: plain text preferred, attachments and attached messages excluded', async () => {
  const full = {
    contentType: 'message/rfc822', partName: '', parts: [{
      contentType: 'multipart/mixed', parts: [
        { contentType: 'multipart/alternative', parts: [{ contentType: 'text/html', body: '<b>HTML</b>' }, { contentType: 'text/plain', body: 'plain' }] },
        { contentType: 'text/plain', name: 'notes.txt', body: 'ATTACHED' },
        { contentType: 'message/rfc822', name: 'fwd.eml', parts: [{ contentType: 'text/plain', body: 'ATTACHED' }] },
        { contentType: 'text/plain', headers: { 'content-disposition': ['attachment'] }, body: 'ATTACHED' },
        { contentType: 'text/plain', headers: { 'Content-Disposition': ['attachment'] }, body: 'ATTACHED UPPER' },
        { contentType: 'text/plain', headers: { 'content-disposition': ['inline; filename=x'] }, body: 'inline part' },
      ],
    }],
  };
  assert.deepEqual(await extractMessage(full, async () => 'HTML'), { text: 'plain\n\ninline part', attachmentNames: ['notes.txt', 'fwd.eml'] });
});

test('MIME: both safety paths inspect encrypted and oversized attachment subtrees', async () => {
  let deep = { contentType: 'text/plain', body: 'attached' };
  for (let i = 0; i < LIMITS.mimeDepth; i++) deep = { contentType: 'multipart/mixed', parts: [deep] };
  const wide = { contentType: 'multipart/mixed', parts: Array.from({ length: LIMITS.mimeParts }, () => ({ contentType: 'text/plain' })) };
  for (const [subtree, error] of [
    [{ contentType: 'multipart/encrypted' }, /Encrypted/],
    [deep, /structure/],
    [wide, /structure/],
  ]) {
    const full = { contentType: 'multipart/mixed', parts: [
      { contentType: 'text/html', body: '<p>readable</p>' },
      { contentType: 'message/rfc822', name: 'attached.eml', parts: [subtree] },
    ] };
    assert.throws(() => assertNotEncrypted(full), error);
    await assert.rejects(extractMessage(full, async () => { assert.fail('Must validate before HTML conversion'); }), error);
  }
});

test('MIME: both safety paths enforce the same whole-tree part limit', async () => {
  const full = { contentType: 'multipart/mixed', parts: Array.from({ length: LIMITS.mimeParts - 1 }, () => ({ contentType: 'text/plain', body: 'x' })) };
  assert.doesNotThrow(() => assertNotEncrypted(full));
  await assert.doesNotReject(extractMessage(full));
  full.parts.push({ contentType: 'text/plain', body: 'x' });
  assert.throws(() => assertNotEncrypted(full), /structure/);
  await assert.rejects(extractMessage(full), /structure/);
});

test('MIME: HTML uses the supplied native converter and propagates failures', async () => {
  const full = { contentType: 'text/html', body: '<p>&euro; &mdash; &copy;</p>' };
  assert.equal((await extractMessage(full, async html => {
    assert.equal(html, full.body);
    return '€ — ©';
  })).text, '€ — ©');
  await assert.rejects(extractMessage(full, async () => ' '.repeat(10)), /No readable text/);
  await assert.rejects(extractMessage(full, async () => { throw new Error('Conversion failed'); }), /Conversion failed/);
});

test('MIME: long body and quoted history remain editable before the request size check', async () => {
  const text = `Current message\n${'x'.repeat(70000)}\n> Previous message history`;
  assert.equal((await extractMessage({ contentType: 'text/plain', body: text })).text, text);
});

test('MIME: encrypted, empty and structurally oversized messages are rejected', async () => {
  for (const full of [
    { contentType: 'multipart/encrypted', parts: [] },
    { contentType: 'application/pkcs7-mime' },
    { contentType: 'text/plain', body: 'x', decryptionStatus: 'success' },
    { contentType: 'text/plain', body: ' ' },
    { contentType: 'multipart/mixed', parts: Array.from({ length: 201 }, () => ({ contentType: 'text/plain', body: 'x' })) },
  ]) await assert.rejects(extractMessage(full));
});
