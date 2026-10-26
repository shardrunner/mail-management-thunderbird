// Model evaluation: runs the extension's exact policy, prompt and schema on synthetic
// cases against several providers, and scores accuracy, latency, cost and reliability.
// Makes real, billed requests with keys from .env; requires --run.
//   npm run evaluate -- --run [--runs=3] [--only=regex] [--out=file.jsonl]
//   npm run evaluate -- --summarize=file.jsonl
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY } from '../extensions/compose/policy.js';
import { makePrompt } from '../extensions/compose/core.js';
import { CASES, COMMON_CHECKS } from './eval-cases.mjs';

// The JSON-schema output format the extension used before 2026-10-26, kept for comparison.
const SCHEMA = { type: 'object', additionalProperties: false, required: ['draft_body'], properties: { draft_body: { type: 'string' } } };
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);

// USD per 1M input/output tokens (output includes reasoning), standard tier, 2026-10-26.
const PRICES = { 'gpt-6-luna': [0.10, 0.50], 'gpt-6.1-terra': [1, 5], 'gpt-6.1-sol': [2, 10], 'gemini-3.8-flash': [0.75, 3.75] };
const TIER = { default: 1, fast: 2, ultrafast: 6 };

// Lane = requests run sequentially; lanes run in parallel (one per provider/model).
const CONFIGS = [
  ...['none', 'low', 'medium', 'high'].map(effort => ({ lane: 'luna', provider: 'openai', model: 'gpt-6-luna', effort })),
  { lane: 'luna', provider: 'openai', model: 'gpt-6-luna', effort: 'none', tier: 'fast' },
  { lane: 'luna', provider: 'openai', model: 'gpt-6-luna', effort: 'none', format: 'text' },
  ...['none', 'low', 'medium', 'high'].map(effort => ({ lane: 'terra', provider: 'openai', model: 'gpt-6.1-terra', effort })),
  { lane: 'terra', provider: 'openai', model: 'gpt-6.1-terra', effort: 'low', tier: 'fast' },
  { lane: 'terra', provider: 'openai', model: 'gpt-6.1-terra', effort: 'none', format: 'text' },
  { lane: 'terra', provider: 'openai', model: 'gpt-6.1-terra', effort: 'none', tier: 'fast', format: 'text' },
  { lane: 'luna', provider: 'openai', model: 'gpt-6-luna', effort: 'none', tier: 'fast', format: 'text' },
  ...['low', 'medium', 'high'].map(effort => ({ lane: 'sol', provider: 'openai', model: 'gpt-6.1-sol', effort, tier: 'ultrafast' })),
  ...['none', 'low', 'medium', 'high'].map(effort => ({ lane: 'openrouter', provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', effort })),
  ...['low', 'medium', 'high'].map(effort => ({ lane: 'gemini', provider: 'gemini', model: 'gemini-3.8-flash', effort })),
  ...['low', 'medium', 'high'].map(effort => ({ lane: 'claude-cli', provider: 'claude-cli', model: 'haiku', effort })),
];
const label = c => `${c.provider}:${c.model} ${c.effort}${c.tier ? ` ${c.tier}` : ''}${c.format ? ` ${c.format}` : ''}`;

// Reads a server-sent event stream and calls onData with each parsed `data:` payload.
async function readSse(response, onData) {
  let buffer = '';
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop();
    for (const event of events) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (data && data !== '[DONE]') onData(JSON.parse(data));
    }
  }
}

async function post(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}

// Each provider returns { text, ttft, inTokens, outTokens, reasoningTokens, cost }.
const PROVIDERS = {
  async openai(c, prompt, start) {
    const text = c.format === 'text' ? { format: { type: 'text' } } : { format: { type: 'json_schema', name: 'compose_reply', strict: true, schema: SCHEMA } };
    const response = await post('https://api.openai.com/v1/responses', { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, {
      model: c.model, instructions: POLICY, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      text, reasoning: { effort: c.effort }, service_tier: c.tier ?? 'default', store: false, max_output_tokens: 8192, stream: true,
    });
    let ttft, final;
    await readSse(response, e => {
      if (e.type === 'response.output_text.delta') ttft ??= performance.now() - start;
      if (e.type === 'response.completed') final = e.response;
      if (e.type === 'response.failed' || e.type === 'error') throw new Error(JSON.stringify(e).slice(0, 300));
    });
    const u = final.usage;
    const [pin, pout] = PRICES[c.model].map(p => p * TIER[c.tier ?? 'default'] / 1e6);
    return {
      text: final.output.find(o => o.type === 'message').content.find(p => p.type === 'output_text').text,
      ttft, inTokens: u.input_tokens, outTokens: u.output_tokens, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
      cost: u.input_tokens * pin + u.output_tokens * pout,
    };
  },

  // Chat Completions via OpenRouter, restricted to zero-data-retention endpoints.
  async openrouter(c, prompt, start) {
    const response = await post('https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, {
      model: c.model, messages: [{ role: 'system', content: POLICY }, { role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'compose_reply', strict: true, schema: SCHEMA } },
      reasoning: { effort: c.effort }, max_tokens: 8192, stream: true, usage: { include: true },
      provider: { zdr: true, data_collection: 'deny', require_parameters: true, sort: 'latency' },
    });
    let ttft, text = '', usage;
    await readSse(response, e => {
      if (e.error) throw new Error(JSON.stringify(e.error).slice(0, 300));
      const delta = e.choices?.[0]?.delta?.content;
      if (delta) { ttft ??= performance.now() - start; text += delta; }
      if (e.usage) usage = e.usage;
    });
    return {
      text, ttft, inTokens: usage.prompt_tokens, outTokens: usage.completion_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0, cost: usage.cost,
    };
  },

  async gemini(c, prompt, start) {
    const response = await post(`https://generativelanguage.googleapis.com/v1beta/models/${c.model}:streamGenerateContent?alt=sse`, { 'x-goog-api-key': process.env.GEMINI_API_KEY }, {
      systemInstruction: { parts: [{ text: POLICY }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: c.effort }, maxOutputTokens: 8192 },
    });
    let ttft, text = '', usage;
    await readSse(response, e => {
      for (const part of e.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) { ttft ??= performance.now() - start; text += part.text; }
      }
      if (e.usageMetadata) usage = e.usageMetadata;
    });
    const out = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    const [pin, pout] = PRICES[c.model].map(p => p / 1e6);
    return { text, ttft, inTokens: usage.promptTokenCount, outTokens: out, reasoningTokens: usage.thoughtsTokenCount ?? 0, cost: usage.promptTokenCount * pin + out * pout };
  },

  // Local Claude Code CLI (subscription auth). Wall time includes CLI startup; no streaming TTFT.
  async 'claude-cli'(c, prompt) {
    const cwd = mkdtempSync(join(tmpdir(), 'compose-eval-'));
    const args = ['-p', '--model', c.model, '--effort', c.effort, '--system-prompt', POLICY, '--json-schema', JSON.stringify(SCHEMA),
      '--tools', '', '--output-format', 'json', '--no-session-persistence'];
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 300)}`))));
      child.stdin.end(prompt);
    });
    const result = JSON.parse(stdout);
    if (result.is_error) throw new Error(result.result);
    const u = result.usage;
    return {
      text: JSON.stringify(result.structured_output), ttft: undefined,
      inTokens: u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens, outTokens: u.output_tokens,
      reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0, cost: result.total_cost_usd,
    };
  },
};

function score(testCase, draft) {
  const checks = { ...testCase.checks, ...COMMON_CHECKS };
  return Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check(draft, testCase)]));
}

async function runOne(c, testCase, run, out) {
  const prompt = makePrompt(testCase.mail);
  const start = performance.now();
  const record = { config: label(c), ...c, case: testCase.id, run };
  try {
    const r = await PROVIDERS[c.provider](c, prompt, start);
    record.ms = Math.round(performance.now() - start);
    record.ttft = r.ttft === undefined ? null : Math.round(r.ttft);
    Object.assign(record, { inTokens: r.inTokens, outTokens: r.outTokens, reasoningTokens: r.reasoningTokens, cost: r.cost });
    const draft = c.format === 'text' ? r.text : JSON.parse(r.text).draft_body;
    if (typeof draft !== 'string' || !draft.trim()) throw new Error('empty draft_body');
    record.draft = draft;
    record.checks = score(testCase, draft);
  } catch (error) {
    record.ms ??= Math.round(performance.now() - start);
    record.error = error.message;
  }
  appendFileSync(out, `${JSON.stringify(record)}\n`);
  const passed = record.checks ? Object.values(record.checks).filter(Boolean).length : 0;
  console.log(`${record.config.padEnd(52)} ${testCase.id.padEnd(17)} ${String(record.ms).padStart(6)} ms ${record.error ? `ERROR ${record.error}` : `${passed}/${Object.keys(record.checks).length}`}`);
}

const pct = (values, p) => {
  const sorted = values.filter(v => v != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
};
const sec = ms => (ms == null ? '–' : (ms / 1000).toFixed(2));

// Re-scores stored drafts with the current checks, so checks can be fixed without new requests.
export function summarize(records) {
  const cases = new Map(CASES.map(c => [c.id, c]));
  for (const r of records) if (r.draft) r.checks = score(cases.get(r.case), r.draft);
  const groups = Map.groupBy(records, r => r.config);
  const rows = [...groups].map(([config, rs]) => {
    const ok = rs.filter(r => !r.error);
    const checks = ok.flatMap(r => Object.values(r.checks));
    return {
      config, n: rs.length, errors: rs.length - ok.length,
      accuracy: checks.length ? checks.filter(Boolean).length / checks.length : 0,
      perfect: ok.filter(r => Object.values(r.checks).every(Boolean)).length / rs.length,
      ttft50: pct(ok.map(r => r.ttft), 0.5), ms50: pct(ok.map(r => r.ms), 0.5), ms90: pct(ok.map(r => r.ms), 0.9),
      costPer1k: ok.length ? ok.reduce((sum, r) => sum + (r.cost ?? 0), 0) / ok.length * 1000 : null,
      reasoning: ok.length ? Math.round(ok.reduce((sum, r) => sum + r.reasoningTokens, 0) / ok.length) : null,
    };
  });
  const lines = [
    '| Configuration | Accuracy (checks) | Perfect drafts | TTFT p50 (s) | Total p50 (s) | Total p90 (s) | USD / 1k drafts | Avg reasoning tokens | Errors |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(r => `| ${r.config} | ${(r.accuracy * 100).toFixed(1)} % | ${(r.perfect * 100).toFixed(0)} % | ${sec(r.ttft50)} | ${sec(r.ms50)} | ${sec(r.ms90)} | ${r.costPer1k == null ? '–' : r.costPer1k.toFixed(2)} | ${r.reasoning ?? '–'} | ${r.errors}/${r.n} |`),
  ];
  const failures = new Map();
  for (const r of records.filter(r => r.checks)) {
    for (const [name, ok] of Object.entries(r.checks)) {
      if (!ok) failures.set(`${r.case}: ${name}`, (failures.get(`${r.case}: ${name}`) ?? 0) + 1);
    }
  }
  lines.push('', '| Most failed checks (all configurations) | Failures |', '|---|---:|',
    ...[...failures].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, n]) => `| ${name} | ${n} |`));
  return lines.join('\n');
}

const summarizeFile = arg('summarize');
if (summarizeFile) {
  console.log(summarize(readFileSync(summarizeFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))));
} else {
  if (!process.argv.includes('--run')) throw new Error('Live, billed provider requests: pass --run to confirm.');
  for (const key of ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) {
    if (!process.env[key]) throw new Error(`${key} is not set in .env`);
  }
  const runs = Number(arg('runs') ?? 3);
  const only = arg('only');
  const out = arg('out') ?? `eval-${new Date().toISOString().slice(0, 19).replaceAll(':', '')}.jsonl`;
  const configs = CONFIGS.filter(c => !only || new RegExp(only).test(label(c)));
  await Promise.all([...Map.groupBy(configs, c => c.lane).values()].map(async lane => {
    for (const c of lane) for (let run = 0; run < runs; run++) for (const testCase of CASES) await runOne(c, testCase, run, out);
  }));
  console.log(`\nRaw results: ${out}\n`);
  console.log(summarize(readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line))));
}
