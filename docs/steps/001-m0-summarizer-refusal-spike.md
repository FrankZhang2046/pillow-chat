# 001 — M0: Summarizer Refusal Spike

## Context

The companion-bot MVP design (`docs/companion-bot-mvp-design.md`) flags summarizer refusals on explicit transcripts as a known risk in §2's footnote and §10, but doesn't test it until milestone 5 (~day 4 of the build). This is load-bearing: if `deepseek/deepseek-chat` refuses or produces useless bowdlerized summaries, the fallback (chat model summarizing itself, or a separate uncensored small model) changes cost economics and infra choices. Testing it before M1 costs pennies and 30 minutes, and answers the question before any code is written.

**Goal:** end with a named summarizer model that works on explicit content, or a documented fallback plan with cost/quality quantified.

## Approach

Pure curl against OpenRouter. No scaffolding — the repo has nothing but `docs/` right now, and this spike doesn't need any.

### Steps

1. **Confirm OpenRouter API key is available.** Export as `OPENROUTER_API_KEY`.

2. **Draft a synthetic explicit transcript** — ~20-30 messages between "user" and "assistant" (persona). Representative of expected real usage: mildly-to-fairly explicit, with embedded specific facts the summarizer needs to retain (a name, a preference, a running joke, an emotional beat). Save to `/tmp/m0-transcript.json` as a chat-completions-style messages array. Content can be fully fabricated — the goal is tripping the same refusal conditions, not realism.

3. **Write the summarizer prompt** as specified in design §5:
   > Merge the existing relationship summary (if any) with the new transcript into an updated summary. Bias toward durable facts, emotional beats, preferences, running jokes, and relationship progression. Discard play-by-play. Cap at ~500 tokens.

4. **Run the test against candidates, in order:**
   - `deepseek/deepseek-chat` (design doc default)
   - `google/gemini-flash-1.5` (cheap backup)
   - A small uncensored fine-tune (e.g. `sao10k/l3-8b-stheno-v3.2` — same family as the chat model)
   - `sao10k/l3.3-euryale-70b` (chat model itself doing double duty — most expensive fallback)

   Stop at the first clean pass. For each model, capture: response, token counts, cost estimate.

5. **Classify each result:**
   - **Clean pass** — returns a summary that retains the embedded specific facts. Ship it.
   - **Bowdlerized pass** — no refusal, but generic ("the users discussed intimate topics"). Loses facts → fail.
   - **Hard refusal** — "I can't help with that." Fail.

6. **Document findings** as an addendum to `docs/companion-bot-mvp-design.md` (new §12 or update §10):
   - Which model was picked and why
   - Refusal/quality observations per candidate tested
   - If a fallback is required: extra cost per summary vs. DeepSeek baseline, any infra implications

## Files Touched

- `docs/companion-bot-mvp-design.md` — appended addendum with M0 findings (2-4 paragraphs)
- `/tmp/m0-transcript.json` — scratch, delete after
- No new source files, no dependencies

## Verification

- The chosen summarizer produces a summary that:
  - Retains at least one specific fact embedded in the synthetic transcript (name, preference, or running joke)
  - Fits within ~500 tokens
  - Does not include a refusal, disclaimer, or "as an AI" hedge
- If no model passes, the design doc addendum names the fallback and quantifies the cost delta so M1+ starts with the summarizer question closed.
