export const DEFAULT_SETTINGS = Object.freeze({ endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-6.1-terra' });

export function validateSettings({ endpoint, model }) {
  const url = URL.parse(endpoint);
  if (url?.protocol !== 'https:' || !url.pathname.endsWith('/v1/responses') || !model?.trim()) {
    throw new Error('Use an HTTPS endpoint ending in /v1/responses and a model name.');
  }
  return { endpoint: url.href, model: model.trim() };
}

export async function loadSettings(api = browser) {
  const { settings } = await api.storage.local.get('settings');
  return settings ?? DEFAULT_SETTINGS;
}

// The key lives in exactly one area: session storage by default, or unencrypted
// local storage when the user opts in to remembering it. Either way it is used
// only for the endpoint it was saved with, so changing the endpoint never sends
// the old key elsewhere.
export async function loadApiKey(endpoint, api = browser) {
  const apiKey = (await api.storage.session.get('apiKey')).apiKey ?? (await api.storage.local.get('apiKey')).apiKey;
  return apiKey?.endpoint === endpoint ? apiKey.key : '';
}

export async function isApiKeyRemembered(api = browser) {
  return (await api.storage.local.get('apiKey')).apiKey != null;
}

export async function saveSettings(settings, key, api = browser, { remember = false } = {}) {
  const valid = validateSettings(settings);
  const [keep, drop] = remember ? ['local', 'session'] : ['session', 'local'];
  await api.storage[drop].remove('apiKey');
  if (key.trim()) await api.storage[keep].set({ apiKey: { key: key.trim(), endpoint: valid.endpoint } });
  else await api.storage[keep].remove('apiKey');
  await api.storage.local.set({ settings: valid });
}
