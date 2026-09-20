// Self-contained: scripting.executeScript serializes this function without imports.
// No await between snapshot comparison and selective mutation.
export function editorOperation({ action, snapshot, draft, banner }) {
  try {
    const existingBanner = document.getElementById?.('compose-assist-banner');
    if (action === 'banner') {
      existingBanner?.remove();
      if (!banner || banner.state === 'clear' || !document.documentElement) return { ok: true };
      const host = document.createElement('div');
      host.id = 'compose-assist-banner';
      const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      const isError = banner.state === 'error';
      root.innerHTML = `<style>
        .bar { position: fixed; top: 8px; left: 8px; right: 8px; z-index: 2147483647; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.25); background: ${isError ? '#3b1212' : '#1e293b'}; color: #fff; border: 1px solid ${isError ? '#ef4444' : '#475569'}; }
        .msg { flex: 1; overflow-wrap: anywhere; }
        button { font: inherit; padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.1); color: #fff; cursor: pointer; }
      </style><div class="bar" role="${isError ? 'alert' : 'status'}"><span class="msg"></span>${isError ? '<button id="settings" type="button">Settings</button>' : ''}<button id="close" type="button">${isError ? '×' : 'Cancel'}</button></div>`;
      root.querySelector('.msg').textContent = `Compose Assist: ${banner.message}`;
      root.querySelector('#settings')?.addEventListener('click', () => {
        host.remove();
        globalThis.browser?.runtime?.sendMessage?.({ type: 'compose-open-options' });
      });
      root.querySelector('#close')?.addEventListener('click', () => {
        host.remove();
        if (!isError) globalThis.browser?.runtime?.sendMessage?.({ type: 'compose-cancel' });
      });
      if (isError && globalThis.addEventListener) {
        const dismiss = () => host.remove();
        globalThis.addEventListener('keydown', dismiss, { once: true, capture: true });
        globalThis.addEventListener('mousedown', event => { if (event.target !== host) dismiss(); }, { once: true, capture: true });
      }
      document.documentElement.appendChild(host);
      return { ok: true };
    }
    existingBanner?.remove();
    const body = document.body;
    if (!body) throw new Error('Compose editor is unavailable.');
    const nodes = Array.from(body.childNodes);
    const hasProtected = nodes.some(n => n.nodeType === 1 && (
      n.className === 'moz-cite-prefix' || n.className === 'moz-signature'
    ));
    let boundary = nodes.length;
    let protectedStarted = false;
    let quote = false;
    let prefix = false;
    let signature = false;
    let reply = '';
    let context = '';
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const cls = typeof n.className === 'string' ? n.className : '';
      const isPrefix = n.nodeType === 1 && n.tagName === 'DIV' && cls === 'moz-cite-prefix';
      const visibleText = typeof n.innerText === 'string' ? n.innerText : n.textContent;
      // Thunderbird 158 uses a styled span in plaintext mode and blockquote[type=cite] in HTML mode.
      const isPlainQuote = n.nodeType === 1 && prefix && n.tagName === 'SPAN' && n.style?.whiteSpace === 'pre-wrap' && n.style?.display === 'block'
        && Array.from(n.childNodes).every(child => child.nodeType === 3 || (child.nodeType === 1 && child.tagName === 'BR'))
        && visibleText.split('\n').some(line => /^\s*>/.test(line))
        && visibleText.split('\n').every(line => !line.trim() || /^\s*>/.test(line));
      const isHtmlQuote = n.nodeType === 1 && prefix && n.tagName === 'BLOCKQUOTE'
        && (n.getAttribute?.('type') === 'cite' || n.type === 'cite');
      const isQuote = isPlainQuote || isHtmlQuote;
      const isSignature = n.nodeType === 1 && ['PRE', 'DIV'].includes(n.tagName) && cls === 'moz-signature';
      const isBlock = n.nodeType === 1 && (n.tagName === 'P' || (hasProtected && n.tagName === 'DIV')) && !cls
        && Array.from(n.childNodes).every(child => child.nodeType === 3 || (child.nodeType === 1 && child.tagName === 'BR'));
      if (isPrefix || isQuote || isSignature) {
        if ((isPrefix && (prefix || quote)) || (isQuote && quote) || (isSignature && signature)) throw new Error('Ambiguous quote/signature layout.');
        prefix ||= isPrefix; quote ||= isQuote; signature ||= isSignature;
        if (!protectedStarted) boundary = i;
        protectedStarted = true;
        if (!isSignature) context += visibleText + '\n';
      } else if (n.nodeType === 3 || (n.nodeType === 1 && n.tagName === 'BR') || isBlock) {
        const value = n.nodeType === 3 ? n.nodeValue : (isBlock ? visibleText.replace(/\n*$/, '\n') : '\n');
        if (protectedStarted && value.trim()) throw new Error('Inline replies or unrecognized signature layout are unsupported.');
        if (!protectedStarted) reply += value;
      } else throw new Error('Unsupported composer layout; no changes made.');
    }
    if (prefix && !quote) throw new Error('Quote attribution without a recognized quote.');
    if (/^\s*>|^--\s*$/m.test(reply)) throw new Error('Text-only quote/signature boundaries are ambiguous.');
    const current = body.innerHTML;
    if (action === 'capture') return { ok: true, snapshot: current, draft: reply, context };
    if (action !== 'apply' || snapshot !== current) throw new Error('The composer changed since capture. Capture again.');
    // The generated text must not contain control characters or look like a quote or signature.
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(draft) || /^\s*>|^--\s*$/m.test(draft)) {
      throw new Error('Generated reply contains control characters or a quote/signature line.');
    }
    const range = document.createRange();
    range.setStart(body, 0);
    range.setEnd(body, boundary);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Selection changes can invoke synchronous handlers. Check again immediately
    // before the native editor transaction; never await or rebuild protected DOM.
    if (body.innerHTML !== snapshot) throw new Error('The composer changed since capture. Capture again.');
    if (!document.execCommand('insertText', false, draft.replace(/\n+$/, '') + '\n\n')) throw new Error('Editor insertText transaction failed. Inspect the composer before retrying.');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}
