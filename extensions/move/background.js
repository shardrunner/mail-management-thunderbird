// Classic event-page script: registers listeners synchronously and delegates to core.js.
const ready = import('./core.js').then(({ registerMoveBackground }) => registerMoveBackground(browser));

browser.action.onClicked.addListener(tab => ready.then(bg => bg.onTriggered(tab)));
browser.messageDisplayAction.onClicked.addListener(tab => ready.then(bg => bg.onTriggered(tab)));
browser.commands.onCommand.addListener((command, tab) => {
  if (command === 'move-suggest') return ready.then(bg => bg.onTriggered(tab));
});
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'move-suggest') return ready.then(bg => bg.onTriggered(tab, info.selectedMessages));
});
browser.runtime.onMessage.addListener((message, sender) => ready.then(bg => bg.onMessage(message, sender)));
browser.tabs.onRemoved.addListener(tabId => ready.then(bg => bg.onRemoved(tabId)));
browser.storage.onChanged.addListener((changes, area) => ready.then(bg => bg.onStorageChanged(changes, area)));
browser.runtime.onInstalled.addListener(() => {
  browser.menus.create({ id: 'move-suggest', title: 'Move Suggest', contexts: ['message_list'] });
  browser.runtime.openOptionsPage();
});
