# 007 — Rate Limits

## Context

Extracted from `003-m2-smoke-test.md` §5. Two-tier cost guardrail before the smoke test goes public:

1. **Per-session (`RATE_LIMIT_PER_SESSION`, default 50).** Caps "how much value a single anonymous visitor gets for free." Signal: engagement depth. Not an abuse cap — a session is trivially spun up by clearing cookies.
2. **Per-IP hourly (`RATE_LIMIT_PER_IP_HOURLY`, default 200).** Caps "how much cost a single IP can burn in one hour." Signal: cost containment. Kicks in when someone tries to farm free chats by cookie-cycling.

Neither is bulletproof security. They're economic guardrails matched to the smoke test's threat model: casual abuse, not motivated attackers.

**Persona card scope note.** Task #5 was originally titled "Persona card + rate-limit lib" in the M2 doc. Persona work belongs with the chat handler restructure (M2 doc §6 — persona upgrade), not with rate limiting. Splitting them so rate-limits ship independently.

## Scope

**In:**
- `src/lib/rate-limit.ts` with `checkRateLimits(sessionId, sessionMessageCount, request) → { ok } | { ok: false, reason }`
- `RATE_LIMIT_PER_SESSION` and `RATE_LIMIT_PER_IP_HOURLY` env vars in `env.ts` (with defaults 50 / 200)
- Export `hashClientIp(request)` from `src/lib/session.ts` so both session creation and rate-limit share one implementation
- Wire the check into `src/routes/api/chat.ts` between `getOrCreateSession` and message persistence — 429 short-circuits everything downstream

**Out:**
- Persona card (its own task, bundled with the persona upgrade in the M2 doc)
- Client-side UI for showing "you've hit the limit" — the client already renders a preview-limit card from `MESSAGE_LIMIT=50` (chat.tsx). Server 429 with the same threshold is what the client will now be receiving; UI reconciliation is a nice-to-have follow-up
- Adaptive limits (per-persona, per-time-of-day, etc.) — post-productization
- Rate-limit dashboard / observability — Task #10 ops doc will mention `SELECT ... FROM ip_counters` as the ad-hoc way to peek

## Approach

### 1. Env vars (optional, with defaults)

Extend `src/lib/env.ts` with an `intWithDefault(name, default)` helper — reads `process.env[name]`, returns default if missing/empty, throws on non-integer.

```ts
export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  SESSION_SECRET: required('SESSION_SECRET'),
  RATE_LIMIT_PER_SESSION: intWithDefault('RATE_LIMIT_PER_SESSION', 50),
  RATE_LIMIT_PER_IP_HOURLY: intWithDefault('RATE_LIMIT_PER_IP_HOURLY', 200),
}
```

Update `.env.example` with both variables and their defaults commented — visible but not required.

### 2. Share `hashClientIp` from `session.ts`

Session.ts already has `clientIp(request)` and `ipHashOf(ip)` as private helpers. Export a combined `hashClientIp(request): string` so rate-limit doesn't duplicate the logic. Keeps the "how do we identify a client's network" answer in one file.

### 3. `src/lib/rate-limit.ts`

```ts
export type RateLimitResult = { ok: true } | { ok: false, reason: 'session' | 'ip' }

export async function checkRateLimits(
  sessionCount: number,
  request: Request,
): Promise<RateLimitResult>
```

Logic:
1. `if (sessionCount >= env.RATE_LIMIT_PER_SESSION) return { ok: false, reason: 'session' }` — cheap check on the count we already fetched via `getOrCreateSession`
2. Compute `ipHash = hashClientIp(request)` and current `hourBucket = date_trunc('hour', now())` (JS-side: zero the minutes/seconds/ms of the current Date)
3. Upsert `ip_counters` with `ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` — atomic increment via a single row lock
4. `if (row.count > env.RATE_LIMIT_PER_IP_HOURLY) return { ok: false, reason: 'ip' }`
5. Return `{ ok: true }`

Notes:
- Per-session compares `>=` on the pre-write count (blocks the LIMIT+1-th user turn). Matches M2 doc §5.
- Per-IP compares `>` on the post-write count (also blocks the LIMIT+1-th total request). Matches M2 doc §5.
- Order: session check first, then IP. If session already dead, skip the IP write.

### 4. Wire into `/api/chat`

Between `getOrCreateSession` and the transaction that persists the user turn:

```ts
const rl = await checkRateLimits(session.messageCount, request)
if (!rl.ok) {
  const headers: Record<string, string> = {}
  if (setCookieHeader) headers['Set-Cookie'] = setCookieHeader
  const body =
    rl.reason === 'session'
      ? "You've hit the free-preview limit for this session — thanks for trying it out. Reload to start over."
      : "Too many requests from this network. Please try again in a bit."
  return new Response(body, { status: 429, headers })
}
```

The client's existing `chat.tsx` catches all fetch errors into a single "Couldn't send · Tap to retry" state. That means the 429 body text won't be surfaced to the user right now — the existing client-side `RATE_LIMIT_CARD` renders on `userCount >= 50` and covers the session case. IP-hit will just look like "couldn't send" on the client. Fine for M2; polish later.

## Files touched

**New:**
- `src/lib/rate-limit.ts`

**Modified:**
- `src/lib/env.ts` — add `intWithDefault` helper + two new vars
- `src/lib/session.ts` — export `hashClientIp(request)`
- `src/routes/api/chat.ts` — call `checkRateLimits` between session and persistence, 429 on deny
- `.env.example` — document the two new (optional) rate-limit vars

## Verification

Dev server running. Use reduced limits for testing to avoid burning 50 real API calls per verification pass.

1. **Per-session cap:** restart with `RATE_LIMIT_PER_SESSION=2 pnpm dev`. Fresh cookie, send 2 messages successfully. Send 3rd → 429 body matches session copy. `SELECT message_count FROM sessions` = 2 (didn't advance). Send with fresh cookie → new session, works again.
2. **Per-IP cap:** restart with `RATE_LIMIT_PER_IP_HOURLY=3 pnpm dev`. Send 3 messages (across sessions if needed by clearing cookies each time). 4th → 429 body matches IP copy. `SELECT count FROM ip_counters` = 4 (upsert happened but check denied).
3. **Cookie kept on 429:** the 429 responses include Set-Cookie on the first-request path (new session), so a client can still identify itself for retries.
4. **`ip_counters` cleanup readiness:** manually run `INSERT INTO ip_counters (ip_hash, hour_bucket, count) VALUES ('test', now() - interval '2 days', 999);` — Task #8's retention cron will remove this later; noting only that the row shape is what the cron expects.
5. **Env boot check** for the new optional vars: setting `RATE_LIMIT_PER_SESSION=notanumber` should throw a clear parse error on boot.

## Notes / deferred concerns

- **Client-side 429 handling.** The chat.tsx `RATE_LIMIT_CARD` component currently triggers on `userCount >= 50` client-side. Task #6's persistence rewrite means the server now enforces the same threshold, and if the client's local count and server's `sessions.message_count` diverge (client reload, cookie replay across devices), the client might spam a request that gets 429. Non-critical for M2 — the client will surface a generic error. Follow-up: parse the 429 body and render `RATE_LIMIT_CARD` server-driven.
- **IP-based limits ~= zero effect in dev.** Local dev has no `x-forwarded-for`, so all requests share `ip_hash = sha256('local')`. Fine for testing but means dev sessions all count toward the same bucket. In prod behind Nginx, XFF is populated per-client.
- **Hour bucket boundaries.** JS `Date` zeroed to the hour is UTC unless we explicitly convert. Postgres `timestamptz` stores UTC. Consistent as long as we treat both as UTC — no timezone bugs.
- **Race under concurrent increments.** Postgres's row-level lock on the upsert handles it. Two simultaneous requests won't both see count=X and both write count=X+1 — one waits.
- **`hourBucket` type mismatch pitfall.** Drizzle's `timestamp({withTimezone: true})` maps to JS `Date`. We must pass a `Date` object, not an ISO string, or Drizzle silently produces the wrong SQL binding. Small footgun.
- **50 messages default is a guess.** No data yet on what "engaged" looks like. Task #5 doc leaves the env var so we can tune post-launch without a redeploy.
