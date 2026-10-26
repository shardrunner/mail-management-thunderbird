// Classic event-page script: the shortcut opens the same popup as the buttons (popup.js does the work).
// Main window: toolbar button popup. Message tabs/windows: message header button popup.
async function openPopup(tab) {
  if (tab?.type === 'mail' && await browser.action.openPopup({ windowId: tab.windowId })) return;
  if (await browser.messageDisplayAction.openPopup({ windowId: tab?.windowId })) return;
  throw new Error('Move Suggest: no toolbar or message header button to open the popup from.');
}

browser.commands.onCommand.addListener((command, tab) => {
  if (command === 'move-suggest') return openPopup(tab);
});
browser.runtime.onInstalled.addListener(() => browser.runtime.openOptionsPage());
