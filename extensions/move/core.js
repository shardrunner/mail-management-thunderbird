// Move Suggest mailbox logic: selection, folder eligibility, suggestion and move.
import { extractMessage } from '../../shared/mail.js';
import { prepareRequest, requestText } from '../../shared/provider.js';
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

export async function selectedMessageId(api, tabId) {
  let list = await api.mailTabs.getSelectedMessages(tabId);
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

// The popup's window decides the message: the selection in a mail tab, otherwise
// the message shown in a message tab or window.
export async function targetMessageId(api) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.type === 'mail') return selectedMessageId(api, tab.id);
  const message = tab && await api.messageDisplay.getDisplayedMessage(tab.id);
  if (!message) throw new Error('Select exactly one message.');
  return message.id;
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

export async function suggestFolder(api, message, rows) {
  const prompt = makePrompt(message, await readMessageText(api, message), rows);
  return suggestedFolder(await requestText(await prepareRequest({ system: SYSTEM, prompt }, api)), rows);
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
