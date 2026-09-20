export const DEFAULT_SETTINGS = Object.freeze({ endpoint: 'https://api.openai.com/v1/responses', model: 'gpt-6-luna' });

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

// The key is kept only in session storage, and only for the endpoint it was
// saved with, so changing the endpoint never sends the old key elsewhere.
export async function loadApiKey(endpoint, api = browser) {
  const { apiKey } = await api.storage.session.get('apiKey');
  return apiKey?.endpoint === endpoint ? apiKey.key : '';
}

export async function saveSettings(settings, key, api = browser) {
  const valid = validateSettings(settings);
  await api.storage.session.set({ apiKey: { key: key.trim(), endpoint: valid.endpoint } });
  await api.storage.local.set({ settings: valid });
}
