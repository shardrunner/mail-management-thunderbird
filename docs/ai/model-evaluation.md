---
summary: Model and configuration evaluation for Compose Assist (accuracy, writing quality, latency, cost, privacy) and the resulting defaults.
read_when:
  - Changing the model, reasoning effort, output format or service tier
  - Comparing providers for reply drafting
---

# Model evaluation

*2026-10-26. Synthetic mail only. Raw results: [`evaluation/`](evaluation/). Reproduce:
`npm run evaluate -- --run`, then `npm run judge -- --run --in=<results>`.*

## Decision

**`gpt-6.1-terra`, reasoning `none`, plain-text output, Fast tier.**

- **Quality:** received the best blind ratings from two judges from different vendors, and
  passed 100 % of the automated checks.
- **Speed:** median draft time is **1.14 s** (p90 1.8 s), down from about 1.9 s for the
  previous setup (`gpt-6-luna`, default reasoning, JSON-schema output).
- **Cost:** **≈ 1.3 USD per 1,000 drafts.** That is negligible for personal use, but
  about 10x the cheapest acceptable option (Luna).
- **Reasoning:** higher effort did not measurably improve these drafts. It only added
  latency, and on Gemini up to 10x.

## Method

Every candidate gets the extension's exact system prompt and request built by `makePrompt`.
There are six synthetic cases, chosen to cover the failure modes that matter for this tool
([`scripts/eval-cases.mjs`](../../scripts/eval-cases.mjs)):

| Case | What it probes |
|---|---|
| `en-accept` | Turning terse English notes into a complete reply |
| `de-formal` | German *Sie* register, five negotiation points to keep |
| `de-informal` | German *du* register with a colleague |
| `en-missing-facts` | Unknown facts must become `[placeholders]`, not invented values |
| `en-injection` | Instructions hidden in the quoted mail must be ignored |
| `de-refine` | Revising an existing draft from an inline edit note |

1. **Accuracy:** 5–10 deterministic checks per draft (54 in total). They cover every
   point in the notes, register, reply language, placeholders instead of invented
   numbers or dates, prompt-injection resistance, no invented signature or sender name,
   and no quoted lines. The checks re-score stored drafts, so a fix to a check needs no
   new requests. Each check was validated against real outputs: three false alarms were
   fixed before scoring.
2. **Writing quality:** the checks saturate near 100 %, so they cannot separate good
   drafts from excellent ones. For each case and run, all candidate drafts were shuffled,
   anonymised and scored 1–5 for faithfulness, tone, naturalness and concision. Two
   judges did this, `gpt-6.1-sol` (high) and `gemini-3.8-flash` (high). Using judges
   from different vendors limits the bias of a model favouring its own vendor's drafts.
3. **Latency:** streamed requests, measuring time to first token (TTFT) and total time,
   reported as median (p50) and p90. Lanes ran in parallel per provider and sequentially
   within each lane. The one surprising result (output format) was re-tested
   head-to-head with both variants running at the same time.
4. **Cost:** calculated from the token usage each provider reported, at list prices on
   2026-10-26, including reasoning tokens.

Each configuration ran 3 times per case (18 drafts). The format comparison ran 5 times
per case (30 drafts). In total that was 540 drafts and 36 judge calls scoring 288 drafts.

## Results

### Accuracy, latency and cost by model and reasoning effort (JSON-schema output, standard tier)

| Model | Effort | Checks passed | TTFT p50 | Total p50 | Total p90 | USD / 1k drafts |
|---|---|---:|---:|---:|---:|---:|
| gpt-6-luna | none | 98.7 % | 0.79 s | 1.48 s | 2.57 s | 0.07 |
| | low | 100 % | 0.79 s | 1.55 s | 2.47 s | 0.08 |
| | medium (model default) | 100 % | 1.42 s | 1.85 s | 3.25 s | 0.10 |
| | high | 100 % | 2.00 s | 2.57 s | 3.72 s | 0.11 |
| gpt-6.1-terra | none | 100 % | 0.79 s | 1.47 s | 2.52 s | 0.75 |
| | low | 100 % | 0.79 s | 1.52 s | 2.30 s | 0.75 |
| | medium | 100 % | 0.82 s | 1.47 s | 2.44 s | 0.82 |
| | high | 100 % | 1.50 s | 2.30 s | 4.32 s | 1.17 |
| gpt-6.1-sol (Ultrafast tier) | low | 100 % | 0.90 s | 1.08 s | 1.65 s | 9.67 |
| | medium | 100 % | 0.87 s | 1.01 s | 1.54 s | 9.81 |
| | high | 100 % | 1.38 s | 1.48 s | 3.31 s | 20.18 |
| gemini-3.8-flash (Gemini API) | low | 100 % | 1.86 s | 2.24 s | 3.23 s | 0.61 |
| | medium (model default) | 100 % | 4.21 s | 4.54 s | 6.66 s | 1.84 |
| | high | 100 % | 10.09 s | 11.31 s | 19.27 s | 5.06 |
| Claude Haiku 5.5 via local `claude -p` | low | 98.7 % | – | 4.16 s | 6.15 s | 0.30 ¹ |
| | medium | 99.3 % | – | 4.37 s | 8.93 s | 0.40 ¹ |
| | high | 99.3 % | – | 4.96 s | 9.89 s | 0.49 ¹ |

¹ This is the list-price equivalent the CLI reports; a Claude subscription covers it.

The errors that occurred were:
- Luna answered an English email in German.
- Haiku signed one email with an invented name ("Max").
- Haiku twice ignored "make it shorter" when refining.
- Haiku once dropped "afternoon" from the proposed meeting slots.

### Writing quality (blind, two judges, mean of 1–5)

| Model, effort | Overall | Judge Sol | Judge Gemini | Faithfulness | Tone | Naturalness | Concision |
|---|---:|---:|---:|---:|---:|---:|---:|
| **gpt-6.1-terra, medium** | **4.97** | 4.99 | 4.96 | 4.94 | 4.97 | 5.00 | 4.97 |
| **gpt-6.1-terra, none** | **4.94** | 4.96 | 4.93 | 4.89 | 4.94 | 4.97 | 4.97 |
| gpt-6.1-terra, low | 4.94 | 4.97 | 4.90 | 4.94 | 4.89 | 4.94 | 4.97 |
| gpt-6-luna, medium | 4.90 | 4.93 | 4.86 | 4.75 | 4.86 | 4.97 | 5.00 |
| gemini-3.8-flash, low | 4.89 | 4.92 | 4.86 | 4.86 | 4.89 | 4.97 | 4.83 |
| gpt-6-luna, none | 4.84 | 4.88 | 4.81 | 4.75 | 4.72 | 4.92 | 4.97 |
| gpt-6.1-sol, low (Ultrafast) | 4.79 | 4.90 | 4.68 | 4.83 | 4.94 | 4.78 | 4.61 |
| Claude Haiku 5.5 (`claude -p`), medium | 4.63 | 4.72 | 4.54 | 4.72 | 4.83 | 4.44 | 4.53 |

Both judges rank the models in nearly the same order. The Gemini judge rates Gemini below
Terra, so the result does not look like a judge favouring its own vendor. Terra's lead over
Luna comes mainly from tone and faithfulness. Sol is precise but scores lower on
concision. Raising Terra's effort from `none` to `medium` changes the score by +0.03,
which is within noise.

### Output format and service tier (same time window, 30 drafts each, reasoning `none`)

| Model | Output | Tier | TTFT p50 | Total p50 | Total p90 | USD / 1k |
|---|---|---|---:|---:|---:|---:|
| gpt-6-luna | JSON schema | standard | 0.77 s | 1.49 s | 2.69 s | 0.08 |
| | plain text | standard | 0.61 s | 1.08 s | 1.78 s | 0.07 |
| | plain text | Fast | 0.62 s | **0.96 s** | 1.34 s | 0.13 |
| gpt-6.1-terra | JSON schema | standard | 0.80 s | 1.56 s | 2.49 s | 0.76 |
| | plain text | standard | 0.77 s | 1.33 s | 2.31 s | 0.66 |
| | plain text | **Fast** | 0.72 s | **1.14 s** | 1.82 s | 1.32 |

Strict JSON-schema output cost 15–27 % in latency without any benefit for a single text
field. The extension now requests plain text. Every draft still passed the checks, and
none of them had preamble or commentary.

## Time to first token

TTFT is the floor on latency: 0.6–0.8 s for OpenAI, even for a "Say ok" request.

| Lever | Result |
|---|---|
| Network | TCP+TLS to `api.openai.com` takes ≈ 50 ms. Pre-warming the connection could save at most that. |
| Plain text instead of a JSON schema | −0.15 s TTFT on Luna (adopted). |
| Reasoning `none` | Avoids the 0.6–1.2 s of reasoning that the default effort sometimes adds (adopted). |
| Fast / Ultrafast tier | Mostly shortens generation; TTFT stays ≈ 0.7–0.9 s. |
| EU regional endpoint | Requires an EU-residency project; this account gets `incorrect_hostname`. |
| Prompt caching | Not applicable: the stable prefix is under the 1,024-token minimum. |
| Responses WebSocket mode | Built for multi-turn agents; no gain for one request per draft. |
| Streaming into the composer | Would hide almost all of the wait, but conflicts with the single snapshot-checked insertion that protects concurrent edits (see [design](design.md)). |

## Alternatives considered

- **Claude Haiku via local `claude -p`:** not suitable. Starting the CLI alone takes
  2.3–3.3 s, and a draft takes 4–5 s. Thunderbird would also need a native-messaging
  host to spawn it. The CLI adds the user's global instructions to the prompt (this
  caused one invented signature), and Haiku had the lowest writing scores.
- **Gemini 3.8 Flash:** good quality, but slow to the first token (1.9 s at `low`) and its
  latency grows sharply with thinking level. On the Gemini API, free-tier data is used
  for product improvement; paid-tier data is not.
- **OpenRouter (Haiku 5.5, gpt-oss-120b on Cerebras):** can be restricted to
  zero-data-retention endpoints with `provider: { zdr: true, data_collection: "deny" }`.
  **Not measured:** the API key returned `401 User not found`. The harness already has
  OpenRouter configurations (`--only=openrouter`).

## Limitations

- Small and synthetic: 6 cases, 3–5 runs each, measured from one location in one
  afternoon. Latency differences under about 0.1 s are within noise.
- The automated checks are near their ceiling; the quality ranking rests on the
  judges, who score near 5 too. The differences are consistent but small.
- LLM judges are a proxy for human preference. They were used blind, with two vendors,
  and the drafts are in the raw results for manual review.
- Prices and model behaviour change. Rerun the evaluation before changing the defaults.
