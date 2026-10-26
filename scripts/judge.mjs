// Blind writing-quality rating of evaluated drafts by two judges from different vendors.
// For each case and run, all candidate drafts are shuffled, labelled A, B, … without
// model names, and scored 1–5 per criterion. Makes real, billed requests; requires --run.
//   npm run judge -- --run --in=results.jsonl --out=judged.jsonl
//   npm run judge -- --summarize=judged.jsonl
import { appendFileSync, readFileSync } from 'node:fs';
import { CASES } from './eval-cases.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CANDIDATES = [
  'openai:gpt-6-luna none', 'openai:gpt-6-luna medium', 'openai:gpt-6.1-terra none', 'openai:gpt-6.1-terra low',
  'openai:gpt-6.1-terra medium', 'openai:gpt-6.1-sol low ultrafast', 'gemini:gemini-3.8-flash low', 'claude-cli:haiku medium',
];
const CRITERIA = ['faithfulness', 'tone', 'naturalness', 'concision'];
const RUBRIC = `You are grading email reply drafts written by different assistants from the same author notes. Score each draft 1 (poor) to 5 (excellent):
- faithfulness: covers every point in the author's notes, changes or invents nothing (bracketed placeholders for unknown facts are correct)
- tone: register, formality and language fit the correspondent and the thread
- naturalness: reads like a fluent native speaker wrote it, not like a template
- concision: no filler, no repetition, appropriate length
Judge each draft on its own merits; the order is random. Return JSON only.`;
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scores'],
  properties: { scores: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['label', ...CRITERIA],
    properties: { label: { type: 'string' }, ...Object.fromEntries(CRITERIA.map(c => [c, { type: 'integer' }])) },
  } } },
};

const JUDGES = {
  'gpt-6.1-sol': async prompt => {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-6.1-sol', instructions: RUBRIC, input: prompt, reasoning: { effort: 'high' }, store: false,
        text: { format: { type: 'json_schema', name: 'scores', strict: true, schema: SCHEMA } } }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    return JSON.parse(body.output.find(o => o.type === 'message').content[0].text);
  },
  'gemini-3.8-flash': async prompt => {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: RUBRIC }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'high' } } }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    return JSON.parse(body.candidates[0].content.parts.filter(p => !p.thought).map(p => p.text).join(''));
  },
};

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function summarize(records) {
  const rows = [...Map.groupBy(records, r => r.config)].map(([config, rs]) => {
    const mean = (judge, c) => {
      const v = rs.filter(r => r.judge === judge).map(r => r[c]);
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    const perJudge = Object.keys(JUDGES).map(j => CRITERIA.reduce((s, c) => s + mean(j, c), 0) / CRITERIA.length);
    return { config, perJudge, criteria: CRITERIA.map(c => Object.keys(JUDGES).reduce((s, j) => s + mean(j, c), 0) / Object.keys(JUDGES).length) };
  }).map(r => ({ ...r, overall: r.perJudge.reduce((a, b) => a + b, 0) / r.perJudge.length }))
    .sort((a, b) => b.overall - a.overall);
  return [
    `| Configuration | Overall (1–5) | ${Object.keys(JUDGES).map(j => `Judge ${j}`).join(' | ')} | ${CRITERIA.map(c => c[0].toUpperCase() + c.slice(1)).join(' | ')} |`,
    `|---|---:|${Object.keys(JUDGES).map(() => '---:').join('|')}|${CRITERIA.map(() => '---:').join('|')}|`,
    ...rows.map(r => `| ${r.config} | ${r.overall.toFixed(2)} | ${r.perJudge.map(v => v.toFixed(2)).join(' | ')} | ${r.criteria.map(v => v.toFixed(2)).join(' | ')} |`),
  ].join('\n');
}

const summarizeFile = arg('summarize');
if (summarizeFile) {
  console.log(summarize(readFileSync(summarizeFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))));
} else {
  if (!process.argv.includes('--run')) throw new Error('Live, billed judge requests: pass --run to confirm.');
  const out = arg('out') ?? 'judged.jsonl';
  const results = readFileSync(arg('in'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.draft && CANDIDATES.includes(r.config));
  const tasks = [];
  for (const testCase of CASES) {
    for (const run of new Set(results.map(r => r.run))) {
      const drafts = shuffle(results.filter(r => r.case === testCase.id && r.run === run));
      const labels = drafts.map((_, i) => String.fromCharCode(65 + i));
      const prompt = [
        `Correspondent's email (quoted thread):\n${testCase.mail.context}`,
        `Subject: ${testCase.mail.subject}\nAuthor's notes or draft to turn into the reply:\n${testCase.mail.draft}`,
        ...drafts.map((d, i) => `--- Draft ${labels[i]} ---\n${d.draft}`),
      ].join('\n\n');
      for (const judge of Object.keys(JUDGES)) tasks.push({ judge, prompt, drafts, labels, case: testCase.id, run });
    }
  }
  await Promise.all(Object.keys(JUDGES).map(async judge => {
    for (const t of tasks.filter(t => t.judge === judge)) {
      const { scores } = await JUDGES[judge](t.prompt);
      for (const s of scores) {
        const draft = t.drafts[t.labels.indexOf(s.label.trim().replace(/^Draft\s+/i, ''))];
        if (!draft) throw new Error(`Judge ${judge} returned unknown label ${s.label}`);
        appendFileSync(out, `${JSON.stringify({ judge, case: t.case, run: t.run, config: draft.config, ...Object.fromEntries(CRITERIA.map(c => [c, s[c]])) })}\n`);
      }
      console.log(`${judge} ${t.case} run ${t.run}: ${scores.length} drafts scored`);
    }
  }));
  console.log(`\n${summarize(readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l)))}`);
}
