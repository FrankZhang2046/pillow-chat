# 003 — M2: Public Smoke Test (Demand Signal Capture)

## Context

M0 + M1 answered the two big product questions (summarizer works, chat model holds register). Franklin is now convinced the memory hypothesis will land. The next unknown is **market pull** — will strangers show up, engage, and come back — so we're shipping the M1-state build publicly *while memory work continues behind the scenes* rather than gating the demand test on M3–M5.

**Why:** this milestone bridges "personal localhost demo" → "public smoke test" with the minimum plumbing to (a) not embarrass ourselves, (b) not incinerate the OpenRouter budget to a single bad actor, and (c) capture the chat data we need for both demand analysis and later persona iteration.

**Goal:** a public URL where a first-time visitor lands, clicks through an 18+ gate, and chats with a single hardcoded persona over streaming SSE. Chats persist to Postgres tagged by a signed anonymous session cookie, message content is encrypted at rest, per-session and per-IP rate limits keep costs bounded, and a retention cron purges data after 90 days.

Franklin owns the landing-page design separately; this step owns the backend, persistence, gate mechanics, and deployment plumbing.

## Scope

**In:**
- Env config cleanup (kill committed key)
- Postgres + Drizzle (sessions, messages, events, ip_counters tables)
- Signed anonymous session cookie (HMAC, HttpOnly, Secure, SameSite=Lax)
- AES-256-GCM encryption of message content at app layer
- Message persistence hooked into the existing SSE relay
- Per-session message cap + per-IP hourly cap (cost guardrails)
- Upgrade the hardcoded system prompt to a proper persona card (single file, still hardcoded)
- `/api/consent` endpoint + `age_confirmed` cookie + server-side redirect gate on `/chat`
- Basic event logging (session_start, gate_accepted, message_sent) into the events table
- 90-day retention script (standalone Node, driven by system cron)
- Deployment to a public URL (target: existing DigitalOcean VPS per design doc §2)

**Out (explicitly deferred):**
- Any form of login / email capture — deferred until memory ships (M5+) and there's a product reason to return
- Persona picker, memory summarizer, context assembler — M3–M5
- Payment / paywall — post-productization
- Formal age verification — click-through gate only; upgrade before commercialization
- Moderation pipeline — post-productization
- Analytics service (Plausible/Umami) — DIY events into Postgres are enough for the demand signal at this scale
- Encryption key rotation / KMS — key lives in env; rotation is post-smoke-test

## Approach

Steps ordered so each can be executed and verified before the next.

### 1. Env hygiene

- Move current `.env` values to `.env.local` (gitignored). Ensure `.env` is not tracked; the committed one contains a real OpenRouter key and must be rotated on OpenRouter.
- Add `.env.example` with the full variable list (no values).
- New env vars this milestone adds:
  - `DATABASE_URL` — Postgres
  - `SESSION_SECRET` — 32-byte hex, HMAC signing key for session cookie
  - `MESSAGE_ENCRYPTION_KEY` — 32-byte hex, AES-256-GCM key
  - `RATE_LIMIT_PER_SESSION` — default 50
  - `RATE_LIMIT_PER_IP_HOURLY` — default 200
- Create `src/lib/env.ts` — typed accessor with runtime validation (throw on boot if any required var is missing). All other modules import from here, never `process.env` directly.

### 2. Postgres + Drizzle wiring

- Install: `drizzle-orm`, `drizzle-kit`, `postgres` (the `postgres` package, not `pg` — smaller, better TS), `tsx`.
- `drizzle.config.ts` at repo root.
- `src/db/index.ts` — connection singleton reading `DATABASE_URL` from `env.ts`.
- `src/db/schema.ts`:

  ```
  sessions      (id uuid pk, created_at, last_seen_at, ip_hash text, user_agent text, message_count int default 0)
  messages      (id uuid pk, session_id fk, role text, content_ciphertext bytea, content_iv bytea, content_tag bytea, model text, created_at)
  events        (id uuid pk, session_id fk nullable, kind text, meta jsonb, created_at)
  ip_counters   (ip_hash text, hour_bucket timestamptz, count int, primary key (ip_hash, hour_bucket))
  ```

- Add `pnpm db:generate` and `pnpm db:migrate` scripts.
- First migration commits as `0001_initial.sql`.

Rationale: `sessions` holds identity + running counter (cheap read for rate-limit check). `ip_counters` uses hour-bucketed rows so cleanup is trivial and reads are `WHERE hour_bucket >= now() - interval '1 hour'`.

### 3. Signed anonymous session cookie

- `src/lib/session.ts`:
  - `getOrCreateSession(request)` → reads `sid` cookie, verifies HMAC using `SESSION_SECRET`, returns the session row. If missing/invalid, generates a new UUID, HMAC-signs it, upserts a `sessions` row, returns `{ session, setCookieHeader }`.
  - Cookie format: `sid=<uuid>.<hmac_hex>`, HttpOnly, Secure (prod only), SameSite=Lax, Max-Age = 90d.
- No third-party session lib. Node built-in `crypto.createHmac` + h3's cookie helpers (`getCookie`/`setCookie`), which TanStack Start uses under the hood.

### 4. Encryption module

- `src/lib/crypto.ts`:
  - `encrypt(plaintext: string): { ciphertext: Buffer, iv: Buffer, tag: Buffer }` using AES-256-GCM with `MESSAGE_ENCRYPTION_KEY`.
  - `decrypt(ciphertext, iv, tag): string`.
  - IV is 12 random bytes per message; tag is the GCM auth tag.
- Node built-in `crypto`, no npm dep.
- Include a self-test on boot in dev (encrypt+decrypt a fixed string, assert roundtrip) so a bad key length fails loudly.

### 5. Persistence hooked into `/api/chat`

- Rewrite `src/routes/api/chat.ts`:
  1. `getOrCreateSession(request)` at entry.
  2. Rate-limit check (step 6) — early return 429 if exceeded.
  3. Encrypt + insert the user message row before opening the upstream stream.
  4. Tee the upstream body: relay chunks to the client SSE as today, but also buffer the assistant deltas server-side. On stream end (successful or client-abort), encrypt + insert the full assistant message.
  5. Update `sessions.message_count`, `sessions.last_seen_at`.
  6. Log a `message_sent` event.
- Assistant-message insertion must happen even on client-abort (finally block on the tee-reader), so we capture drop-off cleanly.

### 6. Rate limits

- Per-session: read `sessions.message_count`; if ≥ `RATE_LIMIT_PER_SESSION`, respond `429` with a plain-text body ("You've hit the free-preview limit for this session — thanks for trying it out. Reload to start over."). Not a hard block on new sessions; the *cost signal* here is per-visitor engagement, not per-IP abuse.
- Per-IP hourly: SHA-256 the IP (from `x-forwarded-for` or remote address) into `ip_hash`. Upsert `ip_counters(ip_hash, hour_bucket=date_trunc('hour', now()), count = count + 1)`. If new count > `RATE_LIMIT_PER_IP_HOURLY`, respond `429`.
- Store `ip_hash` (not raw IP) on `sessions` so we can spot patterns without holding PII.

### 7. Persona upgrade

- Replace the inline one-liner in `chat.ts` with a full persona card per design doc §6.
- `src/lib/persona.ts` exports `{ systemPrompt: string, exampleMessages: Array<{role, content}>, params: { temperature, top_p, max_tokens } }`.
- For M2, the file is committed source (no hot-reload, no DB row). Persona iteration cadence is fine at deploy-speed at this stage.
- Wire example messages into the request as design doc §4 assembler describes — this is a light preview of the M3 context assembler and worth doing here since it lifts persona quality noticeably.
- `max_tokens` capped at ~200 per design doc §4.

### 8. Consent gate

- Franklin owns the landing-page UI/copy; this step owns the mechanics.
- Contract:
  - Landing page (route `/`, Franklin's design): includes an "I am 18+ and consent to logged AI chat" checkbox + "Enter" button. Submit POSTs to `/api/consent`.
  - `/api/consent`: reads a JSON body `{ consent: true }`, sets `age_confirmed=1` cookie (HttpOnly, Secure, SameSite=Lax, Max-Age=90d), logs an `age_gate_accepted` event on the current session (creating one if needed), returns `{ redirect: "/chat" }`.
  - `/chat`: server-side check; if `age_confirmed` cookie missing/invalid → redirect to `/`.
- The existing `src/routes/index.tsx` chat becomes `src/routes/chat.tsx`. New `src/routes/index.tsx` is a scaffold placeholder (Franklin's real design lands separately).

### 9. Retention cron

- `scripts/purge-old-data.ts` — plain Node script (run via `pnpm tsx scripts/purge-old-data.ts`):
  - Delete from `messages` where `created_at < now() - interval '90 days'`.
  - Delete from `events` where `created_at < now() - interval '90 days'`.
  - Delete from `ip_counters` where `hour_bucket < now() - interval '48 hours'`.
  - Delete from `sessions` where `last_seen_at < now() - interval '90 days'` (cascade to any leftover messages).
- Install target: system cron on the VPS, daily at 04:00 UTC. Documented in `docs/ops/vps-setup.md`.
- Dry-run flag (`--dry-run`) prints counts without deleting; use this to sanity-check before enabling the cron.

### 10. Deployment

- Target: existing DigitalOcean VPS (per design doc §2). Public domain TBD by Franklin.
- Steps:
  - Provision Postgres on the VPS (Docker container is fine for this scale).
  - `pnpm build` produces a Nitro node output; run under `systemd` service or `pm2`.
  - Nginx reverse proxy in front, terminating TLS via Let's Encrypt (certbot).
  - Env vars in `/etc/companion-bot.env`, loaded by the systemd unit.
  - System cron entry for the retention script.
- Health check: `GET /api/health` returns `{ ok: true, db: "up" }`. New route, cheap.

## Files touched

**New:**
- `src/lib/env.ts`
- `src/lib/session.ts`
- `src/lib/crypto.ts`
- `src/lib/persona.ts`
- `src/lib/rate-limit.ts`
- `src/db/index.ts`
- `src/db/schema.ts`
- `src/db/migrations/0001_initial.sql` (generated)
- `src/routes/chat.tsx` (moved from `index.tsx`)
- `src/routes/api/consent.ts`
- `src/routes/api/health.ts`
- `scripts/purge-old-data.ts`
- `drizzle.config.ts`
- `.env.example`
- `docs/ops/vps-setup.md`

**Modified:**
- `src/routes/api/chat.ts` — session + rate-limit + persist
- `src/routes/index.tsx` — becomes landing/gate scaffold (Franklin designs the real one)
- `src/routes/__root.tsx` — light meta updates for public site
- `package.json` — add `drizzle-orm`, `drizzle-kit`, `postgres`, `tsx`; add DB scripts
- `.gitignore` — ensure `.env.local` covered

**Deleted / rotated:**
- Committed `.env` — remove from tracking, rotate the OpenRouter key it exposes.

## Verification

Definition of done, walked end-to-end against the live VPS deploy:

1. **Health:** `curl https://<domain>/api/health` returns `{ ok: true, db: "up" }`.
2. **Gate redirect:** Visiting `/chat` in a fresh browser redirects to `/`. After clicking through the gate, `/chat` renders. Refreshing `/chat` no longer redirects (cookie persists).
3. **Chat flow:** Sending a message streams tokens progressively (SSE working). No console errors.
4. **Persistence:** After a chat, `psql` into the DB shows a `sessions` row and two `messages` rows (user + assistant). `content_ciphertext` is bytea and *not* readable — verified by attempting `encode(content_ciphertext, 'escape')` and confirming it's noise.
5. **Roundtrip:** A small admin script (`scripts/dump-session.ts`, dev-only) decrypts a session's messages and prints them, confirming the encryption is not a one-way footgun.
6. **Rate limit — per session:** Post 51 messages from a single session, expect `429` on the 51st. Confirmed a fresh session (new cookie) can start over.
7. **Rate limit — per IP:** Simulate 201 messages/hour from the same IP across multiple sessions; expect `429`.
8. **Retention dry-run:** `pnpm tsx scripts/purge-old-data.ts --dry-run` prints deletion counts (initially zero on a fresh deploy). Insert a row with `created_at = now() - interval '91 days'`, re-run dry-run, confirm count = 1. Run without `--dry-run`, confirm row is gone.
9. **Cron installed:** `crontab -l` on VPS shows the daily entry.
10. **Env safety:** `git log -p .env` shows no live secrets (or, more accurately, that the OpenRouter key from history has been rotated on the OpenRouter side).
11. **Cost sanity:** After ~20 minutes of self-testing, check OpenRouter dashboard — spend should be well under $1 and align with expected per-message token counts from M1.

## Notes / deferred concerns

- **Landing page mechanics ≠ landing page design.** This step specifies the API contract for the consent gate (cookie name, redirect targets, event log) but not the copy or visual design. Franklin's design should drop into `src/routes/index.tsx` and post to `/api/consent` — anything else is negotiable.
- **`x-forwarded-for` trust.** Nginx sets it; the app reads it directly. If the app is ever exposed without Nginx in front, IP rate-limiting silently breaks (`x-forwarded-for` becomes spoofable). Flagged for the ops doc.
- **Assistant-message capture on abort.** The tee-buffer + finally-insert pattern needs a real test — dropped connections in the middle of a stream are exactly the drop-off signal we care about, so getting this right is worth extra care during implementation.
- **Encryption key rotation is not built.** Ciphertext rows are tied to whatever `MESSAGE_ENCRYPTION_KEY` was live at write time. If the key ever changes, old rows become unreadable. Fine for smoke test; add versioned keys before commercialization.
- **Cost blowup fallback.** If a rate-limit escape hatch is needed mid-test, `RATE_LIMIT_PER_IP_HOURLY=0` in env + restart hard-stops all chats without a deploy. Documented in the ops doc.
- **Demand signal queries** — worth a follow-up scratch pad, but not a blocker for this step: sessions per day, median session length, drop-off distribution by message index, per-model spend, gate-conversion rate. All derivable from the three tables as designed.
- **Persona iteration cadence.** Because persona is a source file, tweaks require a redeploy. Acceptable at this stage — if iteration frequency spikes during the smoke test, promote persona to a DB row in a follow-up (nothing else about this step changes).
