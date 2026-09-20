import test from 'node:test';
import assert from 'node:assert/strict';
import { editorOperation } from '../extensions/compose/editor.js';

const text = value => ({ nodeType: 3, nodeValue: value, get textContent() { return this.nodeValue; } });

function element(tag, value = '', cls = '', attrs = {}) {
  return {
    nodeType: 1, tagName: tag, className: cls, textContent: value, innerText: value, childNodes: [text(value)],
    getAttribute: name => attrs[name] ?? null,
    remove() { this.removed = true; },
    ...(tag === 'SPAN' ? {
      style: { whiteSpace: 'pre-wrap', display: 'block' },
    } : {}),
  };
}

// Minimal fake of the compose editor DOM; insertText replaces the selected reply prefix.
function fixture(nodes) {
  const body = {
    childNodes: nodes.map(n => (typeof n === 'string' ? text(n) : element(...n))),
    get innerHTML() { return JSON.stringify(this.childNodes.map(n => [n.nodeType, n.nodeValue, n.tagName, n.textContent, n.className])); },
    commands: 0,
  };
  const docElChildren = [];
  let end;
  globalThis.document = {
    body,
    documentElement: {
      children: docElChildren,
      appendChild(node) { docElChildren.push(node); },
    },
    getElementById: id => docElChildren.find(n => n.id === id) ?? null,
    createElement: tag => ({
      tagName: tag.toUpperCase(),
      id: '',
      dataset: {},
      remove() {
        const idx = docElChildren.indexOf(this);
        if (idx >= 0) docElChildren.splice(idx, 1);
      },
      querySelector: () => ({ textContent: '', addEventListener() {} }),
    }),
    createRange: () => ({
      setStart(node, offset) { assert.equal(node, body); assert.equal(offset, 0); },
      setEnd(node, offset) { assert.equal(node, body); end = offset; },
    }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    execCommand(command, ui, value) {
      assert.equal(command, 'insertText');
      body.commands++;
      body.childNodes.splice(0, end, text(value));
      return true;
    },
  };
  return body;
}

test('repeated applies replace only the reply and keep quote and signature nodes', () => {
  const body = fixture(['old reply', ['BR'], ['DIV', 'On Tuesday, A wrote:', 'moz-cite-prefix'], ['SPAN', '> old mail'], ['PRE', '-- \nAlice Example', 'moz-signature']]);
  const protectedNodes = body.childNodes.slice(2);
  assert.equal(editorOperation({ action: 'capture' }).draft, 'old reply\n');
  for (const draft of ['First reply', 'Refined reply']) {
    const captured = editorOperation({ action: 'capture' });
    assert.match(captured.context, /> old mail/);
    assert.doesNotMatch(captured.draft, /Alice/);
    assert.equal(editorOperation({ action: 'apply', snapshot: captured.snapshot, draft }).ok, true);
    assert.deepEqual(body.childNodes.slice(1), protectedNodes);
  }
  assert.equal(body.commands, 2);
  assert.equal(body.childNodes[0].nodeValue, 'Refined reply\n\n');
});

test('HTML composer with paragraph nodes and blockquote[type=cite] is supported', () => {
  const body = fixture([
    ['P', 'decline politely'],
    ['DIV', 'On Tuesday, A wrote:', 'moz-cite-prefix'],
    ['BLOCKQUOTE', 'Newsletter body text', '', { type: 'cite' }],
    ['DIV', '-- \nAlice Example', 'moz-signature'],
  ]);
  const protectedNodes = body.childNodes.slice(1);
  const captured = editorOperation({ action: 'capture' });
  assert.equal(captured.ok, true);
  assert.equal(captured.draft, 'decline politely\n');
  assert.match(captured.context, /Newsletter body text/);
  assert.equal(editorOperation({ action: 'apply', snapshot: captured.snapshot, draft: 'Generated reply' }).ok, true);
  assert.deepEqual(body.childNodes.slice(1), protectedNodes);
});

test('inline banner attaches outside body and is cleared on capture/apply', () => {
  const body = fixture(['instructions', ['DIV', 'On Tuesday, A wrote:', 'moz-cite-prefix'], ['SPAN', '> quote']]);
  const beforeHTML = body.innerHTML;
  assert.equal(editorOperation({ action: 'banner', banner: { state: 'error', message: 'Problem' } }).ok, true);
  assert.equal(body.innerHTML, beforeHTML, 'Banner must not touch document.body');
  assert.ok(document.getElementById('compose-assist-banner'));
  const captured = editorOperation({ action: 'capture' });
  assert.equal(captured.ok, true);
  assert.equal(document.getElementById('compose-assist-banner'), null, 'Capture removes banner');
});

test('Thunderbird 158 styled quote span after an attribution is recognized', () => {
  const body = fixture([['BR'], ['DIV', 'Synthetic Tester', 'moz-signature'], ['BR'], ['DIV', 'On Tuesday, A wrote:', 'moz-cite-prefix'], ['SPAN', '> first> second'], ['BR']]);
  const span = body.childNodes[4];
  span.style = { whiteSpace: 'pre-wrap', display: 'block' };
  span.innerText = '> first\n> second';
  span.childNodes = [{ nodeType: 3, nodeValue: '> first' }, { nodeType: 1, tagName: 'BR' }, { nodeType: 3, nodeValue: '> second' }];
  const protectedNodes = body.childNodes.slice(1);
  const captured = editorOperation({ action: 'capture' });
  assert.match(captured.context, /> first\n> second/);
  assert.equal(editorOperation({ action: 'apply', snapshot: captured.snapshot, draft: 'new' }).ok, true);
  assert.deepEqual(body.childNodes.slice(1), protectedNodes);
  span.innerText = 'unquoted inline author text';
  assert.equal(editorOperation({ action: 'capture' }).ok, false);
});

test('edits during selection and a failed editor command are reported', () => {
  const body = fixture(['old']);
  const captured = editorOperation({ action: 'capture' });
  document.getSelection = () => ({ removeAllRanges() {}, addRange() { body.childNodes[0].nodeValue = 'typed'; } });
  assert.equal(editorOperation({ action: 'apply', snapshot: captured.snapshot, draft: 'new' }).ok, false);
  assert.equal(body.commands, 0);

  fixture(['old']);
  const next = editorOperation({ action: 'capture' });
  document.execCommand = () => false;
  assert.match(editorOperation({ action: 'apply', snapshot: next.snapshot, draft: 'new' }).error, /transaction failed/);
});

test('typing after capture makes apply fail without changes', () => {
  const body = fixture(['old']);
  const captured = editorOperation({ action: 'capture' });
  body.childNodes[0].nodeValue = 'typing';
  assert.equal(editorOperation({ action: 'apply', snapshot: captured.snapshot, draft: 'new' }).ok, false);
  assert.equal(body.childNodes[0].nodeValue, 'typing');
});

test('ambiguous, inline and text-only quote/signature layouts are rejected', () => {
  const layouts = [
    [['DIV', 'reply']],
    ['reply\n> old'],
    ['reply\n-- \nName'],
    [['BLOCKQUOTE', 'old'], 'inline reply'],
    [['DIV', 'header', 'moz-cite-prefix']],
    [['SPAN', 'quote'], ['SPAN', 'second quote']],
    [['SPAN', 'quote'], 'inline'],
    [['PRE', 'Name', 'moz-signature'], 'reply'],
  ];
  for (const nodes of layouts) {
    fixture(nodes);
    assert.equal(editorOperation({ action: 'capture' }).ok, false);
  }
});
