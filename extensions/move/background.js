// Classic event-page script: every trigger opens the same popup (popup.js does the work).
// Main window: toolbar button popup. Message tabs/windows: message header button popup.
async function openPopup(tab) {
  if (tab?.type === 'mail' && await browser.action.openPopup({ windowId: tab.windowId })) return;
  if (await browser.messageDisplayAction.openPopup({ windowId: tab?.windowId })) return;
  throw new Error('Move Suggest: no toolbar or message header button to open the popup from.');
}

browser.commands.onCommand.addListener((command, tab) => {
  if (command === 'move-suggest') return openPopup(tab);
});
// Right-clicking a row does not select it; select it so the popup sees it.
browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'move-suggest') return;
  await browser.mailTabs.setSelectedMessages(tab.id, info.selectedMessages.messages.map(message => message.id));
  return openPopup(tab);
});
browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({ id: 'move-suggest', title: 'Move Suggest', contexts: ['message_list'] });
  browser.runtime.openOptionsPage();
});
