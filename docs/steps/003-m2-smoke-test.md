# 003 — M2: Public Smoke Test (Demand Signal Capture)

## Context

M0 + M1 answered the two big product questions (summarizer works, chat model holds register). Franklin is now convinced the memory hypothesis will land. The next unknown is **market pull** — will strangers show up, engage, and come back — so we're shipping the M1-state build publicly *while memory work continues behind the scenes* rather than gating the demand test on M3–M5.

**Why:** this milestone bridges "personal localhost demo" → "public smoke test" with the minimum plumbing to (a) not embarrass ourselves, (b) not incinerate the OpenRouter budget to a single bad actor, and (c) capture the chat data we need for both demand analysis and later persona iteration.

**Goal:** a public URL where a first-time visitor lands, clicks through an 18+ gate, and chats with a single hardcoded persona over streaming SSE. Chats persist to Postgres tagged by a signed anonymous session cookie, and per-session and per-IP rate limits keep costs bounded.

Franklin owns the landing-page design separately; this step owns the backend, persistence, gate mechanics, and deployment plumbing.

## Scope

**In:**
- Typed env accessor with runtime validation
- Postgres + Drizzle (sessions, messages, events, ip_counters tables) — details in `004-db-setup-and-schema.md`
- Signed anonymous session cookie (HMAC, HttpOnly, Secure, SameSite=Lax)
- Message persistence hooked into the existing SSE relay
- Per-session message cap + per-IP hourly cap (cost guardrails)
- Upgrade the hardcoded system prompt to a proper persona card (single file, still hardcoded)
- Client-side `localStorage` age gate on the landing page (no server endpoint, no HttpOnly cookie)
- `message_sent` event logging into the events table
- Deployment to a public URL (target: existing DigitalOcean VPS per design doc §2)

**Out (explicitly deferred):**
- Any form of login / email capture — deferred until memory ships (M5+) and there's a product reason to return
- Persona picker, memory summarizer, context assembler — M3–M5
- Payment / paywall — post-productization
- Formal age verification — click-through gate only; upgrade before commercialization
- Server-enforced age gate — click-through is theater at this scale; a scripted bypass would also lie on a checkbox. Revisit at commercialization
- Gate conversion rate metric — needs landing-page analytics we don't have yet; drop-off by message index is the demand signal we do get
- Moderation pipeline — post-productization
- Analytics service (Plausible/Umami) — DIY events into Postgres are enough for the demand signal at this scale
- Encryption key rotation / KMS — key lives in env; rotation is post-smoke-test
- Data retention / purge cron — retain everything for the smoke test. Storage is trivial at this scale and throwing away the dataset before analysis defeats the purpose. Revisit at commercialization (privacy policy + real user promises)
- `/api/health` endpoint and uptime monitoring — 008's FE error handling (`ServiceDownCard` on 502/`service_unavailable`, retry bubble on network death) already surfaces broken state through actual usage. Separate probe adds no value at smoke-test scale; systemd `Restart=on-failure` handles crash recovery. Revisit if CI/CD deploy scripts or third-party monitoring get added

## Approach

Steps ordered so each can be executed and verified before the next.

### 1. Env hygiene

- `.env` stays gitignored and untracked (already the case — verified via `git log --all -- .env`, empty). Local dev: each dev copies `.env.example` → `.env` and fills in their own values. No key rotation needed; the key was never committed.
- Prod secrets live in `/etc/companion-bot.env` on the VPS, loaded by the systemd unit (see §10). If we later move to GitHub Actions deploys, secrets come from repo Actions Secrets and get written to that file at deploy time — either way, never from a committed file.
- Extend `.env.example` with the full variable list (no values). New env vars this milestone adds:
  - `DATABASE_URL` — Postgres
  - `SESSION_SECRET` — 32-byte hex, HMAC signing key for session cookie
  - `RATE_LIMIT_PER_SESSION` — default 50
  - `RATE_LIMIT_PER_IP_HOURLY` — default 200
- Create `src/lib/env.ts` — typed accessor with runtime validation (throw on boot if any required var is missing). All other modules import from here, never `process.env` directly.

### 2. Postgres + Drizzle wiring

Full details in `004-db-setup-and-schema.md`. In short: Docker Postgres for local dev, `drizzle-orm` + `drizzle-kit` + `postgres.js` + `tsx`, four tables (`sessions`, `messages`, `events`, `ip_counters`), plaintext `messages.content` (encryption dropped for M2 — see 004 §Context), initial migration `0001_initial.sql`, `pnpm db:generate` / `db:migrate` scripts. Execute 004 before any of the downstream steps below.

### 3. Signed anonymous session cookie

- `src/lib/session.ts`:
  - `getOrCreateSession(request)` → reads `sid` cookie, verifies HMAC using `SESSION_SECRET`, returns the session row. If missing/invalid, generates a new UUID, HMAC-signs it, upserts a `sessions` row, returns `{ session, setCookieHeader }`.
  - Cookie format: `sid=<uuid>.<hmac_hex>`, HttpOnly, Secure (prod only), SameSite=Lax, Max-Age = 90d.
- No third-party session lib. Node built-in `crypto.createHmac` + h3's cookie helpers (`getCookie`/`setCookie`), which TanStack Start uses under the hood.

### 4. Persistence hooked into `/api/chat`

- Rewrite `src/routes/api/chat.ts`:
  1. `getOrCreateSession(request)` at entry.
  2. Rate-limit check (step 5) — early return 429 if exceeded.
  3. Insert the user message row (plaintext `content`) before opening the upstream stream.
  4. Tee the upstream body: relay chunks to the client SSE as today, but also buffer the assistant deltas server-side. On stream end (successful or client-abort), insert the full assistant message.
  5. Update `sessions.message_count`, `sessions.last_seen_at`.
  6. Log a `message_sent` event.
- Assistant-message insertion must happen even on client-abort (finally block on the tee-reader), so we capture drop-off cleanly.

### 5. Rate limits

- Per-session: read `sessions.message_count`; if ≥ `RATE_LIMIT_PER_SESSION`, respond `429` with a plain-text body ("You've hit the free-preview limit for this session — thanks for trying it out. Reload to start over."). Not a hard block on new sessions; the *cost signal* here is per-visitor engagement, not per-IP abuse.
- Per-IP hourly: SHA-256 the IP (from `x-forwarded-for` or remote address) into `ip_hash`. Upsert `ip_counters(ip_hash, hour_bucket=date_trunc('hour', now()), count = count + 1)`. If new count > `RATE_LIMIT_PER_IP_HOURLY`, respond `429`.
- Store `ip_hash` (not raw IP) on `sessions` so we can spot patterns without holding PII.

### 6. Persona upgrade

- Replace the inline one-liner in `chat.ts` with a full persona card per design doc §6.
- `src/lib/persona.ts` exports `{ systemPrompt: string, exampleMessages: Array<{role, content}>, params: { temperature, top_p, max_tokens } }`.
- For M2, the file is committed source (no hot-reload, no DB row). Persona iteration cadence is fine at deploy-speed at this stage.
- Wire example messages into the request as design doc §4 assembler describes — this is a light preview of the M3 context assembler and worth doing here since it lifts persona quality noticeably.
- `max_tokens` capped at ~200 per design doc §4.

### 7. Consent gate (client-side only)

- Landing page (`/`): "I am 18+" checkbox + Enter button. On submit, set `localStorage.age_confirmed = '1'` and route to `/chat`.
- `/chat`: client-side effect reads `localStorage.age_confirmed`; if missing, `navigate({ to: '/' })`.
- No server endpoint. No HttpOnly cookie. No server-side redirect. Click-through is theater at this scale — a motivated bypass also lies on a checkbox — so the plumbing tax isn't worth it. Upgrade before commercialization.

### 8. Deployment

- Target: existing DigitalOcean VPS (per design doc §2). Public domain TBD by Franklin.
- Steps:
  - Provision Postgres on the VPS (Docker container is fine for this scale).
  - `pnpm build` produces a Nitro node output; run under `systemd` service or `pm2`.
  - Nginx reverse proxy in front, terminating TLS via Let's Encrypt (certbot).
  - Env vars in `/etc/companion-bot.env`, loaded by the systemd unit.

## Files touched

**New:**
- `src/lib/env.ts`
- `src/lib/session.ts`
- `src/lib/persona.ts`
- `src/lib/rate-limit.ts`
- `src/db/index.ts`
- `src/db/schema.ts`
- `src/db/migrations/0001_initial.sql` (generated)
- `drizzle.config.ts`
- `docs/ops/vps-setup.md`

**Modified:**
- `src/routes/api/chat.ts` — session + rate-limit + persist
- `src/routes/index.tsx` — copy edits per 004 §5; set `localStorage.age_confirmed` on submit and route to `/chat`
- `src/routes/chat.tsx` — client-side gate check (redirect to `/` if `localStorage.age_confirmed` missing)
- `src/routes/__root.tsx` — light meta updates for public site
- `.env.example` — grow with each step's new vars
- `package.json` — DB scripts covered in 004; other steps may add more

## Verification

Definition of done, walked end-to-end against the live VPS deploy:

1. **Gate redirect:** Visiting `/chat` in a fresh browser redirects to `/`. After clicking through the gate, `/chat` renders. Refreshing `/chat` no longer redirects (`localStorage.age_confirmed` persists).
2. **Chat flow:** Sending a message streams tokens progressively (SSE working). No console errors.
3. **Persistence:** After a chat, `psql` into the DB shows a `sessions` row and two `messages` rows (user + assistant). `content` is human-readable plaintext (spot-check ergonomic goal).
4. **Rate limit — per session:** Post 51 messages from a single session, expect `429` on the 51st. Confirmed a fresh session (new cookie) can start over.
5. **Rate limit — per IP:** Simulate 201 messages/hour from the same IP across multiple sessions; expect `429`.
6. **Env safety:** `git ls-files | grep -E '^\.env'` returns only `.env.example` — no real secrets tracked. `src/lib/env.ts` throws on boot if any required var is missing (verified by unsetting one and confirming crash).
7. **Cost sanity:** After ~20 minutes of self-testing, check OpenRouter dashboard — spend should be well under $1 and align with expected per-message token counts from M1.

## Notes / deferred concerns

- **Landing page mechanics ≠ landing page design.** Franklin owns the copy/visuals; this step just specifies "set `localStorage.age_confirmed = '1'` on submit and route to `/chat`." Everything else on the page is negotiable.
- **Why the gate stayed client-side.** Original plan called for `/api/consent` + HttpOnly cookie + server redirect + `age_gate_accepted` events (for a gate-conversion metric). Dropped because (a) click-through is theater the plan already accepts, so bypass-resistance buys nothing legally, and (b) conversion rate needs landing-page analytics we don't have — drop-off by message index is the demand signal we do get from the DB. Revisit at commercialization alongside real age verification.
- **`x-forwarded-for` trust.** Nginx sets it; the app reads it directly. If the app is ever exposed without Nginx in front, IP rate-limiting silently breaks (`x-forwarded-for` becomes spoofable). Flagged for the ops doc.
- **Assistant-message capture on abort.** The tee-buffer + finally-insert pattern needs a real test — dropped connections in the middle of a stream are exactly the drop-off signal we care about, so getting this right is worth extra care during implementation.
- **Encryption at rest is dropped for M2.** Message content is plaintext. Trigger to reintroduce: M6+ (commercialization prep). Details in `004-db-setup-and-schema.md` §Notes.
- **Cost blowup fallback.** If a rate-limit escape hatch is needed mid-test, `RATE_LIMIT_PER_IP_HOURLY=0` in env + restart hard-stops all chats without a deploy. Documented in the ops doc.
- **Demand signal queries** — worth a follow-up scratch pad, but not a blocker for this step: sessions per day, median session length, drop-off distribution by message index, per-model spend, gate-conversion rate. All derivable from the three tables as designed.
- **Persona iteration cadence.** Because persona is a source file, tweaks require a redeploy. Acceptable at this stage — if iteration frequency spikes during the smoke test, promote persona to a DB row in a follow-up (nothing else about this step changes).
