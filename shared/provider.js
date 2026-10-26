import { LIMITS } from './limits.js';
import { loadSettings, loadApiKey } from './settings.js';

// Builds the Responses API request from current settings and session key.
export async function prepareRequest({ system, prompt }, api = browser) {
  const { endpoint, model } = await loadSettings(api);
  const apiKey = await loadApiKey(endpoint, api);
  if (!apiKey) throw new Error('Set an API key in Settings.');
  const body = JSON.stringify({
    model,
    instructions: system,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    // Measured fastest without loss in quality (docs/ai/model-evaluation.md): plain text
    // instead of a JSON schema, no hidden reasoning, and the Fast service tier.
    reasoning: { effort: 'none' },
    service_tier: 'fast',
    store: false,
    max_output_tokens: 8192,
  });
  if (new Blob([body]).size > LIMITS.requestBytes) throw new Error('Request is too large.');
  return { endpoint, model, body, apiKey };
}

// Sends a prepared request once and returns the model's text answer.
export async function requestText({ endpoint, body, apiKey }, { signal } = {}) {
  const timeout = AbortSignal.timeout(LIMITS.timeoutMs);
  let envelope;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check endpoint, model and key in Settings.`);
    envelope = await response.json();
  } catch (error) {
    if (signal?.aborted) throw new Error('Request cancelled.');
    if (timeout.aborted) throw new Error('Request timed out.');
    if (error instanceof TypeError) throw new Error('Could not reach the endpoint. Save Settings again to grant access, and check the network.');
    throw error;
  }
  const message = envelope.output?.find(item => item.type === 'message');
  const text = message?.content?.find(part => part.type === 'output_text')?.text;
  if (envelope.status !== 'completed' || typeof text !== 'string') throw new Error('The provider returned no complete answer.');
  return text;
}
