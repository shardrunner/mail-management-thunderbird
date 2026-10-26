// Compose Assist logic: capture the text above the quote, generate a reply, and replace it in place.
import { editorOperation } from './editor.js';
import { POLICY } from './policy.js';
import { assertNotEncrypted } from '../../shared/mail.js';
import { prepareRequest, requestText } from '../../shared/provider.js';

function header(full, name) {
  const values = Object.entries(full?.headers ?? {})
    .find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(values) ? values.filter(Boolean).join(', ') : (values ?? '');
}

function formatList(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(', ') : (value ?? '');
}

export function createAdapter(api, tabId) {
  async function runEditor(args) {
    const [result] = await api.scripting.executeScript({ target: { tabId }, func: editorOperation, args: [args] });
    if (!result?.result?.ok) throw new Error(result?.result?.error ?? 'Compose editor is unavailable.');
    return result.result;
  }
  return {
    async capture() {
      const details = (await api.compose.getComposeDetails(tabId)) ?? {};
      let full, originalAttachments = [];
      if (details.relatedMessageId !== undefined) {
        // Never decrypt; the original's text itself comes from the quote in the editor.
        full = await api.messages.getFull(details.relatedMessageId, { decrypt: false });
        originalAttachments = assertNotEncrypted(full);
      }
      const composeAttachments = (await api.compose.listAttachments?.(tabId)) ?? [];
      const attachments = [...new Set([
        ...originalAttachments,
        ...composeAttachments.map(a => a?.name).filter(Boolean),
      ])];
      const captured = await runEditor({ action: 'capture' });
      return {
        ...captured,
        subject: details.subject || header(full, 'subject') || '',
        from: header(full, 'from') || formatList(details.to) || '',
        to: header(full, 'to') || formatList(details.from) || '',
        date: header(full, 'date') || '',
        attachments,
      };
    },
    apply: (snapshot, draft) => runEditor({ action: 'apply', snapshot, draft }),
    banner: banner => runEditor({ action: 'banner', banner }),
    prepare: request => prepareRequest(request, api),
    request: (prepared, signal) => requestText(prepared, { signal }),
  };
}

export function validateResult(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('The model returned an empty reply.');
  return value.trim();
}

export function makePrompt(editor) {
  const currentText = editor.draft.trim();
  if (!currentText) throw new Error('Write instructions above the quote first.');
  return JSON.stringify({
    subject: editor.subject ?? '',
    from: editor.from ?? '',
    to: editor.to ?? '',
    date: editor.date ?? '',
    attachments: editor.attachments ?? [],
    current_text: currentText,
    quoted_context: editor.context,
  });
}

// Captures the current composer state, requests a reply from the model, and replaces
// the reply region in place only if the editor snapshot is unchanged.
export async function composeReply(adapter, { signal, onLoading } = {}) {
  const captured = await adapter.capture();
  const prompt = makePrompt(captured);
  await onLoading?.();
  const prepared = await adapter.prepare({ system: POLICY, prompt });
  signal?.throwIfAborted();
  const draft = validateResult(await adapter.request(prepared, signal));
  signal?.throwIfAborted();
  await adapter.apply(captured.snapshot, draft);
  return draft;
}

export function registerComposeBackground(api) {
  const inflight = new Map();

  async function openOptions() {
    await api.runtime?.openOptionsPage?.();
    try {
      const [win] = (await api.windows?.getAll?.({ windowTypes: ['normal'] })) ?? [];
      if (win?.id) await api.windows?.update?.(win.id, { focused: true });
    } catch {
      // Ignore if windows API is unavailable.
    }
  }

  async function setStatus(tabId, state, badge, title, bannerMessage) {
    try {
      await api.composeAction?.setBadgeText?.({ tabId, text: badge });
      await api.composeAction?.setTitle?.({ tabId, title });
    } catch {
      // Composer tab was closed.
    }
    if (!state) return;
    try {
      await createAdapter(api, tabId).banner({ state, message: bannerMessage });
    } catch {
      // Editor unavailable or tab closed.
    }
  }

  async function onClicked(tab) {
    if (!tab?.id) {
      [tab] = (await api.tabs?.query?.({ active: true, currentWindow: true, type: 'messageCompose' })) ?? [];
      if (!tab?.id) return;
    }
    if (inflight.has(tab.id)) {
      inflight.get(tab.id).abort();
      return;
    }
    const controller = new AbortController();
    inflight.set(tab.id, controller);
    try {
      await composeReply(createAdapter(api, tab.id), {
        signal: controller.signal,
        onLoading: () => setStatus(
          tab.id,
          'loading',
          '…',
          'Compose Assist — Generating… (press again to cancel)',
          'Generating reply… (press Ctrl+Alt+C to cancel)',
        ),
      });
      if (inflight.get(tab.id) === controller) {
        await setStatus(tab.id, 'clear', '', 'Compose Assist');
      }
    } catch (error) {
      if (inflight.get(tab.id) === controller) {
        if (controller.signal.aborted) {
          await setStatus(tab.id, 'clear', '', 'Compose Assist — Cancelled');
        } else {
          await setStatus(tab.id, 'error', '!', `Compose Assist — ${error.message}`, error.message);
          if (/API key/i.test(error.message)) await openOptions();
        }
      }
    } finally {
      if (inflight.get(tab.id) === controller) inflight.delete(tab.id);
    }
  }

  function onRemoved(tabId) {
    inflight.get(tabId)?.abort();
    inflight.delete(tabId);
  }

  function onStorageChanged(changes, area) {
    if ((area === 'local' && changes.settings) || changes.apiKey) {
      for (const controller of inflight.values()) controller.abort();
    }
  }

  function onMessage(message, sender) {
    if (message?.type === 'compose-open-options') return openOptions();
    if (message?.type === 'compose-cancel') {
      const tabId = sender?.tab?.id;
      if (tabId && inflight.has(tabId)) inflight.get(tabId).abort();
    }
  }

  return { onClicked, onRemoved, onStorageChanged, onMessage, openOptions };
}
