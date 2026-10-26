import { loadSettings, loadApiKey, isApiKeyRemembered, saveSettings, validateSettings } from './settings.js';

const GUIDES = {
  'Compose Assist': [
    'In a reply composer, write plain-text instructions or draft notes above the quote and press Ctrl+Alt+C (or click Compose Assist in the toolbar).',
    'The text above the quote is replaced in place with the generated reply; quotes and your signature stay untouched.',
    'Press Ctrl+Z to undo, or edit the reply and press Ctrl+Alt+C again to refine.',
  ],
  'Move Suggest': [
    'Select one message in the message list (or open a message) and press Ctrl+Alt+M (or click Move Suggest in the toolbar or message header).',
    'A popup opens below the toolbar button with the suggested folder and rationale; keep the Move Suggest button in the main toolbar.',
    'Press Enter to move immediately, type or use Up/Down arrows to pick another folder, or press Esc to close.',
  ],
};

const $ = id => document.getElementById(id);
const name = browser.runtime.getManifest().name;
$('title').textContent = `${name} — Quick Start & Settings`;
const steps = GUIDES[name] ?? [];
if ($('intro') && steps.length) {
  const ul = document.createElement('ul');
  for (const step of steps) {
    const li = document.createElement('li');
    li.textContent = step;
    ul.appendChild(li);
  }
  $('intro').replaceChildren(ul);
}

$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  $('status').textContent = '';
  $('error').textContent = '';
  try {
    const settings = validateSettings({ endpoint: $('endpoint').value, model: $('model').value });
    // Request access before any other await so the click still counts as a user gesture.
    const granted = await browser.permissions.request({ origins: [`${new URL(settings.endpoint).origin}/*`] });
    if (!granted) throw new Error('Access to the endpoint was not granted.');
    await saveSettings(settings, $('api-key').value, browser, { remember: $('remember-key').checked });
    $('status').textContent = 'Saved. No request was sent.';
  } catch (error) {
    $('error').textContent = error.message;
  }
});

const settings = await loadSettings();
$('endpoint').value = settings.endpoint;
$('model').value = settings.model;
$('api-key').value = await loadApiKey(settings.endpoint);
$('remember-key').checked = await isApiKeyRemembered();
