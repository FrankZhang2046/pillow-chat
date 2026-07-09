# 002 — M1: Explicit Chat Spike

## Context

Design doc §9 originally split this into two milestones: M1 "streaming echo, no LLM" and M2 "OpenRouter integration, messages persisted, model picker." We're collapsing them into a single validation spike, mirroring M0's shape.

**Why:** M0 proved the summarizer handles explicit content. This spike proves the *chat model* does — in practice, on live streaming calls, not just synthetic benchmarks or community reputation. If `sao10k/l3.3-euryale-70b` refuses, bowdlerizes, or can't be tamed into texting register (§6 disqualifier), that answer needs to come before any persona work, context assembler, or DB schema gets built around a model that won't ship. It also validates the SSE relay plumbing that M3+ will plug into.

**Goal:** end with (a) a localhost chat where explicit content streams back cleanly from a named default model, (b) side-by-side notes on Euryale vs Magnum vs Stheno, (c) an SSE relay implementation that stays as the foundation for M3+.

## Scope

**In:**
- TanStack Start scaffold, one chat route, one API route
- Real OpenRouter streaming calls (Option B: plain SSE at `/api/chat`)
- Model override via `?model=` query param for cheap A/B in the browser
- Throwaway system prompt (just enough to unlock register)
- Manual chat testing across the three candidate models

**Out (explicitly deferred):**
- Auth — localhost only, no password gate this milestone
- DB — messages live in React state, refresh = fresh chat
- Persona card — throwaway one-liner system prompt only (M4)
- Context assembler / token budgeting — send full growing array, will break ~30+ turns, fine (M3)
- Memory / summarizer — M5
- Deployment / nginx / production streaming concerns — noted for later (see §Notes)

## Approach

### Steps

1. **Scaffold TanStack Start.** `pnpm create @tanstack/router` (or current incantation — verify from docs). Confirm dev server runs at `localhost:3000`.

2. **Env setup.** `.env` with:
   ```
   OPENROUTER_API_KEY=...
   DEFAULT_MODEL=sao10k/l3.3-euryale-70b
   ```
   Add `.env` to `.gitignore` if the scaffold didn't.

3. **API route: `src/routes/api/chat.ts`.** Uses `createAPIFileRoute('/api/chat')`, POST handler:
   - Read `{ messages: {role, content}[], model?: string }` from request JSON
   - `fetch('https://openrouter.ai/api/v1/chat/completions', { stream: true, ... })` with throwaway system prompt prepended
   - Return `new Response(upstream.body, { headers: { 'Content-Type': 'text/event-stream' } })`
   - Handle upstream non-200 by returning the error status/body (don't swallow)

4. **Throwaway system prompt.** Inline in the API handler:
   > You are a flirty, sexually explicit chat partner. Reply in 1-3 sentences like a real text message. No asterisk actions, no novelistic prose. Match the user's register and pacing.

   This is deliberately minimal. Persona work is M4 — the point here is to unlock the register with as little scaffolding as possible so any refusal is model-driven, not prompt-driven.

5. **Chat UI: `src/routes/index.tsx`.**
   - State: `messages: {role, content}[]`, `input: string`, `streaming: boolean`
   - Layout: message list (scrolls), textarea + send button pinned bottom, mobile-viewport-friendly (max-width ~600px, no side chrome)
   - Send handler: append user message → POST to `/api/chat` with full `messages` array → read `response.body.getReader()` in a loop → parse `data: ...\n\n` lines → append `delta.content` to a streaming assistant message
   - Handle `data: [DONE]` as end-of-stream. Handle stream errors by surfacing them in the UI (don't just log).

6. **Model override.** Read `?model=` from URL on page load. If present, pass in POST body; server falls back to `DEFAULT_MODEL` env var if absent. Enables flipping Euryale/Magnum/Stheno without code changes or restarts.

7. **Manual test session — the actual spike.** With the app running:
   - Chat for 10-15 turns per model, escalating register gradually
   - For each candidate (`sao10k/l3.3-euryale-70b`, `anthracite-org/magnum-v4-72b`, `sao10k/l3-8b-stheno-v3.2`), test:
     - **Streaming behavior** — characters appear progressively, not one blob at the end
     - **Refusal/bowdlerization** — does the model produce explicit content, or hedge?
     - **Register discipline** — does `max_tokens: 200` + system-prompt rules actually hold it to texting length, or does it drift into novelistic prose with asterisk actions?
     - **Prose quality** at the register you actually want
   - Note cost per turn from the OpenRouter dashboard

8. **Document findings** as a new §13 in `docs/companion-bot-mvp-design.md`:
   - Which model wins the default slot and why
   - Per-candidate refusal/register/quality observations
   - If Euryale is disqualified: which backup and cost delta
   - Streaming plumbing gotchas encountered (chunk parsing, buffering, disconnect handling)

## Files Touched

- New TanStack Start scaffold (whatever `create` produces)
- `src/routes/index.tsx` — chat UI
- `src/routes/api/chat.ts` — SSE relay to OpenRouter
- `.env`, `.env.example`, `.gitignore`
- `docs/companion-bot-mvp-design.md` — appended §13 with M1 findings
- No DB, no auth, no persona files, no migrations

## Verification

Definition of done:

- **Streaming visibly works.** Open localhost, send a message, watch the response appear character-by-character (not all-at-once after a pause). Confirm via `curl -N -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'` — should see `data:` lines dribble out.
- **Explicit content passes.** Chosen default model produces explicit replies in texting register (~1-3 sentences) without refusals, disclaimers, or "as an AI" hedges, using only the throwaway system prompt.
- **Model swap works.** Adding `?model=sao10k/l3-8b-stheno-v3.2` to the URL visibly changes model behavior on the next turn.
- **Design doc §13 exists** with per-candidate notes and a named default model — or a named backup + cost delta if no candidate passes cleanly.

If Euryale fails the register cap despite `max_tokens: 200` + prompt rules, that's a §6-documented disqualifier — record it and pick the winner from Magnum/Stheno.

## Notes / Deferred Concerns

- **Buffering in production.** SSE gets buffered by default in nginx and some proxies, which makes streaming look broken (30s of nothing, then everything at once). Fix is `proxy_buffering off;` on the location block. Not an M1 concern (localhost only) but flag for whenever this hits the VPS.
- **Disconnect handling.** If the user navigates away mid-stream, the fetch aborts on the client but the upstream OpenRouter call keeps running (and billing) until it finishes. Fine for M1. Wire `AbortController` propagation when it matters — probably M2/M3.
- **Full-array resend cost.** Every turn re-sends the full growing `messages` array. At ~30 turns this starts costing real money per turn and approaches Euryale's context window. Context assembler in M3 fixes both.
- **No auth on localhost is only OK on localhost.** Before this app touches any interface other than `127.0.0.1`, password gate goes in.
