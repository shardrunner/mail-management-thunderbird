// Runs ONLY inside the network-isolated bwrap sandbox created by the runner.
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { connect } from './marionette.mjs';

const report = { ok: false, scope: 'Packaged temporary install/background contexts and exact production adapters on synthetic Thunderbird mail; not provider or complete UI acceptance', checks: {} };
let child, client, server, log;
const watchdog = setTimeout(() => { child?.kill('SIGKILL'); process.exitCode = 1; }, 110_000);
try {
  report.artifacts = {};
  for (const name of ['compose', 'move']) report.artifacts[`${name}.xpi`] = createHash('sha256').update(await readFile(`/work/${name}.xpi`)).digest('hex');
  let resolveProbe;
  const probeResult = new Promise(resolve => { resolveProbe = resolve; });
  server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || !['/result', '/reopen-draft'].includes(request.url)) { response.writeHead(404).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 32768) throw new Error('Probe report too large');
      }
      const result = JSON.parse(body);
      if (request.url === '/reopen-draft') {
        const reopened = await reopenDraft(result.messageId);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reopened));
      } else {
        response.writeHead(200).end('ok');
        resolveProbe(result);
      }
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(8765, '127.0.0.1', resolve));
  log = await open('/work/thunderbird.log', 'w');
  child = spawn(process.env.THUNDERBIRD, ['--headless', '--no-remote', '--profile', '/work/profile', '--marionette', '--remote-allow-system-access', '--offline'], {
    stdio: ['ignore', log.fd, log.fd], env: process.env,
  });
  child.on('error', error => { report.launchError = error.message; });
  client = await connect(2828);
  const session = await client.command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  report.application = session.capabilities || session;
  await client.command('Marionette:SetContext', { value: 'chrome' });
  await client.command('WebDriver:SetTimeouts', { script: 45000 });
  const execute = async script => {
    const result = await client.command('WebDriver:ExecuteAsyncScript', { script, args: [], newSandbox: true, sandbox: 'system', scriptTimeout: 45000 });
    const value = result?.value ?? result;
    if (value?.error) throw new Error(value.error);
    return value;
  };
  // beginNew(messageId) uses Edit As New, not Draft. Reopen through the native draft
  // command in the isolated profile, then return control to the production adapter probe.
  const reopenDraft = messageId => execute(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const probe = ExtensionParent.GlobalManager.getExtension('synthetic-smoke@personal.invalid');
      const message = probe.messageManager.get(${JSON.stringify(messageId)});
      if (!message?.folder.isSpecialFolder(Ci.nsMsgFolderFlags.Drafts, false)) throw new Error('Expected a saved synthetic draft');
      const uri = message.folder.getUriForMsg(message);
      const main = Services.wm.getMostRecentWindow('mail:3pane');
      await main.ComposeMessage(Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompFormat.Default, message.folder, [uri]);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const win = Services.wm.getMostRecentWindow('msgcompose');
        // A reply draft restores its reply compose type; gEditingDraft identifies draft editing.
        if (win?.composeEditorReady && win.gEditingDraft && win.gOriginalMsgURI === uri) {
          return { tabId: probe.tabManager.convert(win).id };
        }
        await new Promise(resolve => main.setTimeout(resolve, 100));
      }
      const win = Services.wm.getMostRecentWindow('msgcompose');
      throw new Error('Reopened draft editor did not become ready: ' + JSON.stringify({
        uri, hasWindow: !!win, ready: win?.composeEditorReady, editingDraft: win?.gEditingDraft,
        original: win?.gOriginalMsgURI, type: win?.gComposeType,
        draftId: win?.gMsgCompose?.compFields.draftId,
      }));
    })().then(done, error => done({ error: String(error) }));
  `);
  report.fixture = await execute(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      if (MailServices.accounts.accounts.length !== 0) throw new Error('Refusing nonempty profile');
      MailServices.accounts.createLocalMailAccount();
      const account = MailServices.accounts.findAccountForServer(MailServices.accounts.localFoldersServer);
      const identity = MailServices.accounts.createIdentity();
      identity.email = 'synthetic@example.invalid'; identity.fullName = 'Synthetic Tester';
      identity.composeHtml = false; identity.replyOnTop = 1; identity.sigBottom = false;
      identity.htmlSigText = 'Synthetic Tester'; identity.htmlSigFormat = false;
      account.addIdentity(identity); account.defaultIdentity = identity;
      const root = account.incomingServer.rootFolder;
      root.createSubfolder('SmokeSource', null); root.createSubfolder('SmokeDestination', null);
      root.createSubfolder('SmokeDrafts', null);
      const drafts = root.getChildNamed('SmokeDrafts');
      drafts.setFlag(Ci.nsMsgFolderFlags.Drafts);
      identity.draftsFolderURI = drafts.URI;
      const source = root.getChildNamed('SmokeSource').QueryInterface(Ci.nsIMsgLocalMailFolder);
      source.addMessage('From synthetic@example.invalid Sat Jan 01 00:00:00 2022\\n' +
        'From: Synthetic <synthetic@example.invalid>\\r\\nTo: receiver@example.invalid\\r\\n' +
        'Subject: Synthetic smoke fixture\\r\\nMessage-ID: <smoke-fixture@example.invalid>\\r\\n' +
        'Date: Sat, 1 Jan 2022 00:00:00 +0000\\r\\nMIME-Version: 1.0\\r\\n' +
        'Content-Type: text/plain; charset=UTF-8\\r\\n\\r\\nSynthetic local-only body.\\r\\n\\r\\n> Earlier message history.\\r\\n');
      root.createSubfolder('SmokeHtml', null);
      root.getChildNamed('SmokeHtml').QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(
        'From synthetic@example.invalid Sat Jan 01 00:00:00 2022\\n' +
        'From: synthetic@example.invalid\\r\\nTo: receiver@example.invalid\\r\\n' +
        'Subject: Synthetic HTML fixture\\r\\nMessage-ID: <smoke-html@example.invalid>\\r\\n' +
        'MIME-Version: 1.0\\r\\nContent-Type: multipart/mixed; boundary=smoke\\r\\n\\r\\n' +
        '--smoke\\r\\nContent-Type: text/html; charset=UTF-8\\r\\n\\r\\n' +
        '<head><title>HIDDEN_TITLE</title><style>HIDDEN_STYLE</style></head>' +
        '<script>HIDDEN_SCRIPT</script><p>Price &euro; &mdash; &copy;</p>' +
        '<p>Next<br>line<img src="https://example.invalid/never-fetch"></p>' +
        '<p>Malformed <b>bold\\r\\n' +
        '--smoke\\r\\nContent-Type: text/html; name="attached.html"\\r\\n' +
        'Content-Disposition: attachment; filename="attached.html"\\r\\n\\r\\n' +
        '<p>ATTACHED_SECRET</p>\\r\\n' +
        '--smoke\\r\\nContent-Type: application/pdf; name="large.pdf"\\r\\n' +
        'Content-Disposition: attachment; filename="large.pdf"\\r\\n' +
        'Content-Transfer-Encoding: base64\\r\\n\\r\\n' + 'QUJD'.repeat(400000) + '\\r\\n--smoke--\\r\\n');
      const now = Math.floor(Date.now() / 1000);
      const destination = root.getChildNamed('SmokeDestination');
      destination.setFlag(Ci.nsMsgFolderFlags.Favorite);
      destination.setStringProperty('MRMTime', String(now - 3600));
      root.getChildNamed('SmokeHtml').setStringProperty('MRMTime', String(now - 7200));
      source.setFlag(Ci.nsMsgFolderFlags.Favorite);
      source.setStringProperty('MRMTime', String(now));
      const main = Services.wm.getMostRecentWindow('mail:3pane');
      const about3Pane = main?.gTabmail?.currentAbout3Pane;
      if (about3Pane) {
        about3Pane.displayFolder(source.URI);
        about3Pane.threadTree.selectedIndex = 0;
      }
      return { account: account.key, identity: identity.key, messages: 2 };
    })().then(done, error => done({ error: String(error) }));
  `);
  report.checks.install = {};
  for (const name of ['compose', 'move']) {
    const installed = await client.command('Addon:Install', { path: `/work/${name}.xpi`, temporary: true });
    const id = installed?.value ?? installed;
    const expected = name === 'compose' ? 'compose-assist@personal.invalid' : 'move-suggest@personal.invalid';
    if (id !== expected) throw new Error(`Unexpected installed ${name} ID`);
    report.checks.install[name] = id;
  }
  await new Promise(resolve => setTimeout(resolve, 2500));
  report.checks.background = await execute(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const checks = {};
      for (const id of ['compose-assist@personal.invalid', 'move-suggest@personal.invalid']) {
        const extension = ExtensionParent.GlobalManager.getExtension(id);
        if (!extension) throw new Error('Packaged extension not active: ' + id);
        await extension.wakeupBackground();
        if (!extension.backgroundContext) throw new Error('No background context: ' + id);
        const errors = Services.console.getMessageArray().filter(message =>
          message instanceof Ci.nsIScriptError && (message.flags & Ci.nsIScriptError.warningFlag) === 0 &&
          message.sourceName?.startsWith(extension.baseURI.spec));
        if (errors.length) throw new Error('Packaged background script errors: ' + id + ' (' + errors.length + ')');
        checks[id] = { context: true, scriptErrors: errors.length };
      }
      return checks;
    })().then(done, error => done({ error: String(error) }));
  `);
  await client.command('Addon:Install', { path: '/work/probe', temporary: true });
  report.checks.probe = await Promise.race([probeResult, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Instrumented extension report timeout')), 45000); timer.unref();
  })]);
  if (!report.checks.probe.ok) throw new Error(`Probe failed: ${report.checks.probe.error}`);
  // The real Ctrl+Alt+C in a composer the probe left open reaches the compose-assist command
  // (recorded only: without an API key the command would open the Settings tab).
  report.checks.composeShortcut = await execute(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const shortcuts = ExtensionParent.GlobalManager.getExtension('compose-assist@personal.invalid').shortcuts;
      const win = Services.wm.getMostRecentWindow('msgcompose');
      if (!win) throw new Error('Compose shortcut: no composer open');
      win.focus();
      for (const deadline = Date.now() + 15000; Services.focus.activeWindow !== win;) {
        if (Date.now() > deadline) throw new Error('Compose shortcut: composer not focused');
        await new Promise(resolve => win.setTimeout(resolve, 100));
      }
      win.document.getElementById('messageEditor').focus();
      const fired = [];
      shortcuts.onCommand = name => fired.push(name);
      try {
        const keys = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
        if (!keys.beginInputTransactionForTests(win)) throw new Error('Compose shortcut: no input transaction');
        const modifiers = [['Control', 'ControlLeft', 17], ['Alt', 'AltLeft', 18]].map(([key, code, keyCode]) => new win.KeyboardEvent('', { key, code, keyCode }));
        const letter = new win.KeyboardEvent('', { key: 'c', code: 'KeyC', keyCode: 67 });
        for (const modifier of modifiers) keys.keydown(modifier);
        keys.keydown(letter); keys.keyup(letter);
        for (const modifier of modifiers.reverse()) keys.keyup(modifier);
        await new Promise(resolve => win.setTimeout(resolve, 500));
      } finally { delete shortcuts.onCommand; }
      if (fired.join() !== 'compose-assist') throw new Error('Compose shortcut: command not fired: ' + JSON.stringify(fired));
      return { fired: true };
    })().then(done, error => done({ error: String(error) }));
  `);
  // Move Suggest popup end to end, without an API key: the probe filed the synthetic message
  // in SmokeDestination. Ctrl+Alt+M opens the toolbar popup without a click; typing
  // a filter and Enter moves the message back, and a confirmed move closes the popup.
  report.checks.movePopup = await execute(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      const { ViewPopup } = ChromeUtils.importESModule('resource:///modules/ExtensionPopups.sys.mjs');
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      const extension = ExtensionParent.GlobalManager.getExtension('move-suggest@personal.invalid');
      const win = Services.wm.getMostRecentWindow('mail:3pane');
      const root = MailServices.accounts.localFoldersServer.rootFolder;
      const source = root.getChildNamed('SmokeSource'), filed = root.getChildNamed('SmokeDestination');
      const until = async (condition, label) => {
        for (const deadline = Date.now() + 15000; !condition();) {
          if (Date.now() > deadline) throw new Error('Move popup: ' + label);
          await new Promise(resolve => win.setTimeout(resolve, 100));
        }
      };
      win.focus(); // the command targets the active tab; the probe left composers open
      await until(() => Services.focus.activeWindow === win, 'main window not focused');
      win.gTabmail.switchToTab(win.gTabmail.tabInfo.find(tab => tab.mode.name === 'mail3PaneTab'));
      const about3Pane = win.gTabmail.currentAbout3Pane;
      about3Pane.displayFolder(filed.URI);
      await until(() => about3Pane.gDBView?.rowCount === 1, 'filed message not listed');
      about3Pane.threadTree.selectedIndex = 0;
      // Press the real shortcut: Alt+Shift+letter is the Linux access-key modifier and never
      // reached the command, which calling shortcuts.onCommand directly did not catch.
      about3Pane.threadTree.focus();
      const keys = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
      if (!keys.beginInputTransactionForTests(win)) throw new Error('Move popup: no input transaction');
      const modifiers = [['Control', 'ControlLeft', 17], ['Alt', 'AltLeft', 18]].map(([key, code, keyCode]) => new win.KeyboardEvent('', { key, code, keyCode }));
      const letter = new win.KeyboardEvent('', { key: 'm', code: 'KeyM', keyCode: 77 });
      for (const modifier of modifiers) keys.keydown(modifier);
      keys.keydown(letter); keys.keyup(letter);
      for (const modifier of modifiers.reverse()) keys.keyup(modifier);
      const popup = () => ViewPopup.for(extension, win);
      await until(() => popup()?.browser?.currentURI?.spec.endsWith('/extensions/move/popup.html'), 'not opened');
      await new Promise(resolve => win.setTimeout(resolve, 2000)); // folders load, key error shown
      popup().browser.focus(); // headless panels do not take focus themselves (manual check)
      await until(() => Services.focus.focusedElement === popup().browser, 'popup not focusable');
      const tip = Cc['@mozilla.org/text-input-processor;1'].createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(win)) throw new Error('Move popup: no input transaction');
      for (const key of [...'SmokeSource', 'Enter']) {
        const event = new win.KeyboardEvent('', key === 'Enter' ? { key, code: 'Enter', keyCode: 13 } : { key });
        tip.keydown(event);
        tip.keyup(event);
      }
      await until(() => source.getTotalMessages(false) === 1 && filed.getTotalMessages(false) === 0, 'keyboard move not filed');
      await until(() => !popup(), 'not closed after a confirmed move');
      return { opened: true, keyboardMoveWithoutKey: true, closedAfterMove: true };
    })().then(done, error => done({ error: String(error) }));
  `);
  report.ok = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await writeFile('/work/result.json', JSON.stringify(report, null, 2) + '\n');
  client?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  server?.closeAllConnections(); server?.close();
  await log?.close();
}
