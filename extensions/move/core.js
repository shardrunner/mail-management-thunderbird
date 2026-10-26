// Move Suggest mailbox logic and inline message-pane controller.
import { extractMessage } from '../../shared/mail.js';
import { prepareRequest, requestText } from '../../shared/provider.js';
import { moveBannerOperation } from './banner.js';
import { SYSTEM, makePrompt } from './policy.js';

// Special folders, and everything below them, are never offered as destinations.
const EXCLUDED_ROLES = new Set(['inbox', 'sent', 'drafts', 'templates', 'outbox', 'junk', 'trash']);

export const OUTCOMES = {
  confirmed: 'Moved. Thunderbird confirmed the move.',
  copied: 'Thunderbird reported a copy, not a move. The original may still be in the source folder.',
  uncertain: 'Move sent, but Thunderbird did not confirm it in time. Check the folders before trying again.',
};

function isFilingFolder(folder) {
  return !folder.isVirtual && !folder.isTag && !folder.isUnified
    && !(folder.specialUse ?? []).some(role => EXCLUDED_ROLES.has(role));
}

export async function selectedMessageId(api, tabId, selection) {
  let list = selection ?? await api.mailTabs.getSelectedMessages(tabId);
  const messages = [...list.messages];
  // A page is not the entire selection. Stop as soon as multiple messages are known.
  while (messages.length <= 1 && list.id) {
    list = await api.messages.continueList(list.id);
    messages.push(...list.messages);
  }
  if (list.id) await api.messages.abortList(list.id);
  if (messages.length !== 1) throw new Error('Select exactly one message.');
  return messages[0].id;
}

export async function loadMessage(api, id) {
  const message = await api.messages.get(id);
  if (!message?.folder) throw new Error('Only messages stored in a folder can be moved.');
  const capabilities = await api.folders.getFolderCapabilities(message.folder.id);
  if (!capabilities.canDeleteMessages) throw new Error('Messages cannot be moved out of this folder.');
  return message;
}

// Writable filing folders of the source account, excluding the source itself.
export async function eligibleFolders(api, source) {
  const account = await api.accounts.get(source.accountId, true);
  if (!account) throw new Error('Source account not found.');
  const recent = await api.folders.query({
    accountId: source.accountId, lastUsedAsDestination: { recent: true }, sort: 'lastUsedAsDestination',
  });
  const recentIndexes = new Map(recent.map((folder, index) => [folder.id, index]));
  const rows = [];
  async function visit(folder) {
    for (const child of folder.subFolders ?? []) {
      if (!isFilingFolder(child)) continue;
      if (child.id !== source.id && (await api.folders.getFolderCapabilities(child.id)).canAddMessages) {
        rows.push({
          id: child.id, label: `${account.name}${child.path}`, isFavorite: !!child.isFavorite,
          recentIndex: recentIndexes.get(child.id) ?? null,
        });
      }
      await visit(child);
    }
  }
  await visit(account.rootFolder);
  return rows;
}

export async function readMessageText(api, message) {
  return extractMessage(await api.messages.getFull(message.id, { decrypt: false }),
    html => api.messengerUtilities.convertToPlainText(html, { flowed: false }));
}

// Plain-text answer: the exact folder label on the first line, keywords after it.
export function suggestedFolder(text, rows) {
  const [label = '', ...rest] = text.split('\n').map(line => line.trim()).filter(Boolean);
  const row = rows.find(r => r.label === label);
  if (!row) throw new Error('The model returned an invalid folder.');
  return { label: row.label, rationale: rest.join(' ') };
}

// Suggested first, then favorites, then recent destinations (newest first), then alphabetical.
export function orderedFolders(rows, suggested, search = '') {
  const query = search.toLocaleLowerCase();
  return rows
    .filter(row => row.label.toLocaleLowerCase().includes(query))
    .toSorted((a, b) => (b.label === suggested) - (a.label === suggested)
      || !!b.isFavorite - !!a.isFavorite
      || (a.recentIndex ?? Infinity) - (b.recentIndex ?? Infinity)
      || a.label.localeCompare(b.label));
}

// The first matching event determines 'confirmed' or 'copied'; otherwise the
// outcome is 'uncertain' 15 s after dispatch. A resolved move promise is not proof.
export async function moveMessage(api, message, target, timeoutMs = 15000) {
  const current = await api.messages.get(message.id);
  if (current?.folder?.id !== message.folder.id) throw new Error('The message was moved or deleted meanwhile. Reopen Move Suggest.');

  let observed, failed;
  const evidence = new Promise((resolve, reject) => { observed = resolve; failed = reject; });
  const observe = kind => (original, result) => {
    if (original.messages.some(m => m.id === message.id) && result.messages.some(m => m.folder?.id === target.id)) {
      observed(kind);
    }
  };
  const onMoved = observe('confirmed'), onCopied = observe('copied');
  api.messages.onMoved.addListener(onMoved);
  api.messages.onCopied.addListener(onCopied);
  let timer;
  try {
    timer = setTimeout(() => observed('uncertain'), timeoutMs);
    // Do not await the API promise: it must not postpone an event or the deadline.
    // Handle rejection even if it arrives after the event/deadline settled evidence.
    api.messages.move([message.id], target.id, { isUserAction: true }).catch(failed);
    return await evidence;
  } finally {
    clearTimeout(timer);
    api.messages.onMoved.removeListener(onMoved);
    api.messages.onCopied.removeListener(onCopied);
  }
}

export function registerMoveBackground(api) {
  const sessions = new Map();

  async function setBadge(tabId, badge, title) {
    if (!tabId || tabId < 0) return;
    for (const action of [api.action, api.messageDisplayAction]) {
      try {
        await action?.setBadgeText?.({ tabId, text: badge });
        await action?.setTitle?.({ tabId, title });
      } catch {
        // Tab closed or action unavailable.
      }
    }
  }

  async function restorePane(session) {
    if (session?.restoreMessagePane && session.tabId > 0) {
      session.restoreMessagePane = false;
      try {
        await api.mailTabs?.update?.(session.tabId, { messagePaneVisible: false });
      } catch {
        // Tab closed or not a mail tab.
      }
    }
  }

  async function showBanner(tabId, payload) {
    if (!tabId || tabId < 0) return false;
    try {
      if (payload?.state !== 'clear') {
        await api.messageDisplay?.getDisplayedMessage?.(tabId)?.catch?.(() => null);
      }
      const [res] = await api.scripting.executeScript({
        target: { tabId },
        func: moveBannerOperation,
        args: [payload],
      });
      return res?.result?.ok === true;
    } catch {
      return false;
    }
  }

  async function onTriggered(tab, selection) {
    if (!tab?.id) {
      [tab] = (await api.tabs?.query?.({ active: true, currentWindow: true })) ?? [];
      if (!tab?.id) return;
    }
    const prev = sessions.get(tab.id);
    prev?.controller?.abort();
    const controller = new AbortController();
    const session = {
      tabId: tab.id,
      controller,
      message: null,
      rows: [],
      moved: false,
      restoreMessagePane: prev?.restoreMessagePane ?? false,
    };
    sessions.set(tab.id, session);

    try {
      const id = await selectedMessageId(api, tab.id, selection);
      if (selection) {
        try { await api.mailTabs?.setSelectedMessages?.(tab.id, [id]); } catch { /* ignore */ }
      }
      try {
        const mailTab = await api.mailTabs?.get?.(tab.id);
        if (mailTab?.messagePaneVisible === false) {
          session.restoreMessagePane = true;
          await api.mailTabs?.update?.(tab.id, { messagePaneVisible: true });
        }
      } catch {
        // Standalone message tab/window or mailTabs unavailable.
      }
      const message = session.message = await loadMessage(api, id);
      const rows = session.rows = await eligibleFolders(api, message.folder);
      if (!rows.length) throw new Error('No eligible destination folders in this account.');

      await setBadge(tab.id, '…', 'Move Suggest — Suggesting folder…');
      await showBanner(tab.id, {
        state: 'loading',
        messageId: message.id,
        rows,
        status: 'Move Suggest: Suggesting folder…',
      });

      const extracted = await readMessageText(api, message);
      controller.signal.throwIfAborted();
      const prompt = makePrompt(message, extracted, rows);
      const prepared = await prepareRequest({ system: SYSTEM, prompt }, api);
      controller.signal.throwIfAborted();
      const answer = await requestText(prepared, { signal: controller.signal });
      controller.signal.throwIfAborted();
      const suggestion = suggestedFolder(answer, rows);
      if (sessions.get(tab.id) !== session || session.moved) return;

      const status = suggestion.rationale
        ? `Suggested: ${suggestion.label} — ${suggestion.rationale}`
        : `Suggested: ${suggestion.label}`;
      await setBadge(tab.id, '', `Move Suggest — ${suggestion.label}`);
      await showBanner(tab.id, {
        state: 'ready',
        messageId: message.id,
        rows,
        suggestion,
        status,
      });
    } catch (error) {
      if (sessions.get(tab.id) !== session || session.moved) return;
      const text = controller.signal.aborted ? 'Request cancelled.' : error.message;
      await setBadge(tab.id, controller.signal.aborted ? '' : '!', `Move Suggest — ${text}`);
      await showBanner(tab.id, {
        state: 'error',
        messageId: session.message?.id ?? 0,
        rows: session.rows,
        error: `Move Suggest: ${text}`,
      });
      if (!controller.signal.aborted && /API key/i.test(error.message)) {
        await api.runtime?.openOptionsPage?.();
      }
    } finally {
      if (sessions.get(tab.id) === session) session.controller = null;
    }
  }

  async function onMessage(msg, sender) {
    if (msg?.type === 'move-open-options') return api.runtime?.openOptionsPage?.();
    const senderTabId = sender?.tab?.id > 0 ? sender.tab.id : null;
    const session = (senderTabId ? sessions.get(senderTabId) : null)
      ?? [...sessions.values()].find(s => s.message?.id === msg?.messageId);
    const tabId = session?.tabId ?? senderTabId;

    if (msg?.type === 'move-cancel') {
      if (session) {
        session.controller?.abort();
        await restorePane(session);
        sessions.delete(session.tabId);
      }
      await setBadge(tabId, '', 'Move Suggest');
      return { ok: true };
    }

    if (msg?.type === 'move-confirm') {
      if (session?.moved) return { ok: false, error: 'Move Suggest: Move already in progress.' };
      if (session) {
        session.moved = true;
        session.controller?.abort();
      }
      try {
        const message = session?.message ?? (msg.messageId ? await loadMessage(api, msg.messageId) : null);
        const target = session?.rows?.find(r => r.label === msg.folderLabel)
          ?? (msg.folderId ? { id: msg.folderId, label: msg.folderLabel } : null);
        if (!message || !target) throw new Error('Select a destination folder.');
        const outcome = await moveMessage(api, message, target);
        await setBadge(tabId, '', 'Move Suggest');
        if (outcome === 'confirmed') {
          await showBanner(tabId, { state: 'clear' });
          await restorePane(session);
          if (session) sessions.delete(session.tabId);
          return { ok: true, outcome };
        }
        await showBanner(tabId, {
          state: 'done',
          messageId: message.id,
          rows: session?.rows ?? [],
          status: OUTCOMES[outcome],
        });
        return { ok: true, outcome, status: OUTCOMES[outcome] };
      } catch (error) {
        if (session) session.moved = false;
        const text = `Move Suggest: ${error.message}`;
        await setBadge(tabId, '!', `Move Suggest — ${error.message}`);
        await showBanner(tabId, {
          state: 'error',
          messageId: session?.message?.id ?? msg.messageId ?? 0,
          rows: session?.rows ?? [],
          error: text,
        });
        return { ok: false, error: text };
      }
    }
  }

  function onRemoved(tabId) {
    sessions.get(tabId)?.controller?.abort();
    sessions.delete(tabId);
  }

  function onStorageChanged(changes, area) {
    if ((area === 'local' && changes.settings) || (area === 'session' && changes.apiKey)) {
      for (const session of sessions.values()) session.controller?.abort();
    }
  }

  return { onTriggered, onMessage, onRemoved, onStorageChanged };
}
