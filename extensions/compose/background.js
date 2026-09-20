// Classic event-page script: registers listeners synchronously and delegates to core.js.
const ready = import('./core.js').then(({ registerComposeBackground }) => registerComposeBackground(browser));

browser.composeAction.onClicked.addListener(tab => ready.then(bg => bg.onClicked(tab)));
browser.commands.onCommand.addListener((command, tab) => {
  if (command === 'compose-assist') return ready.then(bg => bg.onClicked(tab));
});
browser.runtime.onMessage.addListener((message, sender) => ready.then(bg => bg.onMessage(message, sender)));
browser.tabs.onRemoved.addListener(tabId => ready.then(bg => bg.onRemoved(tabId)));
browser.storage.onChanged.addListener((changes, area) => ready.then(bg => bg.onStorageChanged(changes, area)));
browser.runtime.onInstalled.addListener(() => ready.then(bg => bg.openOptions()));
browser.runtime.onStartup.addListener(() => ready.then(bg => bg.openOptions()));
