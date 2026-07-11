# 008 — Client-Side Error Handling

## Context

`src/routes/chat.tsx` collapses every fetch failure into a single "Couldn't send · Tap to retry" bubble, regardless of cause. Concrete failure modes we've hit or expect:

- **429 session cap** — user has hit their per-session message limit; retrying won't help until they reload with a fresh session
- **429 IP cap** — user's IP has hit the hourly rate limit; retrying won't help for the rest of the hour
- **402 out of credits** — OpenRouter account balance below the request's cost. Just hit this in dev. Retrying is pointless until an operator tops up.
- **500 no OpenRouter API key** — operator misconfig at deploy time. Retrying pointless until operator fixes.
- **Upstream 5xx from OpenRouter** — transient upstream trouble. Retrying might help in a minute.
- **Network / server 5xx / unknown** — genuinely transient. Retrying should help.
- **400 invalid body** — client bug (unreachable in normal flow). Retrying pointless.

Today users see the same "tap to retry" message for all of these. That fails on two axes: (a) it wastes their attempts on non-retryable conditions, and (b) it makes debugging impossible on the operator side — we can't tell from a demand-signal read whether users bounced because of a real bug or because they legitimately hit a cap or because we were out of credits.

**Why now:** we hit the 402-out-of-credits case in dev today. It surfaces as generic "Couldn't send," which is the exact user-hostile behavior 008 was supposed to fix. Broadening scope from 429-only to cover all the practically-hittable cases before shipping publicly.

## Scope

**In:**
- Server: standardize error responses to `{ error: string, reason?: string, message: string }` with `Content-Type: application/json`
- Server: bucket upstream failures (402, 5xx from OpenRouter) and 500 no-api-key as `service_unavailable` — don't leak upstream details to client
- Client: parse the JSON on non-OK responses, extract error kind
- Client: model per-message `errorKind` as a discriminated union in place of `error: boolean`
- Client: four render states:
  - `'retry'` (network / 500 non-config / unknown) → existing `UserBubbleFailed` with retry button
  - `'rate-limit-session'` → normal user bubble + `RateLimitSessionCard` (reload prompt)
  - `'rate-limit-ip'` → normal user bubble + `RateLimitIpCard` (wait, no reload)
  - `'service-down'` → normal user bubble + `ServiceDownCard` (retry-later, no immediate retry button)

**Out:**
- Redesigning card visual language — reuse existing card styling
- i18n — English hardcoded for M2
- Client-side pre-block on `MESSAGE_LIMIT` — leave as-is (harmless optimistic UI)
- Distinguishing 402 vs 500-no-key in client — both bucketed as `service-down` since they're indistinguishable from user's perspective
- Operator-side alerting on 402/500 — surface these into the events table for later analysis but no push notifications yet

## Approach

### 1. Server error taxonomy

Edit `src/routes/api/chat.ts`. Replace all non-OK responses with structured JSON.

**Buckets:**

| Case | Status | JSON body |
|---|---|---|
| Missing `OPENROUTER_API_KEY` | 500 | `{ error: 'service_unavailable', message: 'Service is temporarily unavailable.' }` |
| Invalid JSON body | 400 | `{ error: 'bad_request', message: 'Invalid request body.' }` |
| Missing/empty last user message | 400 | `{ error: 'bad_request', message: 'Message is required.' }` |
| Rate limit session cap | 429 | `{ error: 'rate_limit', reason: 'session', message: '<session copy>' }` |
| Rate limit IP cap | 429 | `{ error: 'rate_limit', reason: 'ip', message: '<ip copy>' }` |
| Upstream OpenRouter non-OK (any status) | 502 | `{ error: 'service_unavailable', message: 'Service is temporarily unavailable.' }` |

For the upstream case, **log the real upstream status + body server-side** (`console.error`) so operators can debug from logs. The client just sees `service_unavailable`.

Also log a `service_error` event into the events table (kind='service_error', meta={upstream_status, upstream_body_snippet}) so we have a queryable trail of 402/5xx occurrences. Bounded — truncate `upstream_body_snippet` to 500 chars.

### 2. Client error kind

Edit `src/routes/chat.tsx`:

```ts
type ErrorKind = 'retry' | 'rate-limit-session' | 'rate-limit-ip' | 'service-down'

type Message = {
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  errorKind?: ErrorKind
}
```

In `streamAssistantReply`, on `!res.ok`:

```ts
let kind: ErrorKind = 'retry'
const parsed = await res.json().catch(() => null)
if (parsed?.error === 'rate_limit') {
  kind = parsed.reason === 'ip' ? 'rate-limit-ip' : 'rate-limit-session'
} else if (parsed?.error === 'service_unavailable') {
  kind = 'service-down'
}
throw Object.assign(new Error('send failed'), { kind })
```

Catch block reads `err.kind` (fallback `'retry'`) and stamps the last user message.

### 3. Render dispatch

In the message loop:
- `m.role === 'user' && m.errorKind === 'retry'` → `UserBubbleFailed` (existing)
- `m.role === 'user'` (any other errorKind or none) → `UserBubble` (existing)
- assistant rendering unchanged

After the message list, compute:
```ts
const lastUser = [...messages].reverse().find(m => m.role === 'user')
const kind = lastUser?.errorKind
const showSessionCard = rateLimitHitByCount || kind === 'rate-limit-session'
const showIpCard = kind === 'rate-limit-ip'
const showServiceDownCard = kind === 'service-down'
```

Render exactly one of the cards conditionally (when `!streaming`).

Input disabled when `streaming || showSessionCard || showIpCard || showServiceDownCard`.

### 4. Card components

- **`RateLimitSessionCard`** — existing `RateLimitCard`, renamed. Copy stays close to today's ("You've hit the free-preview limit for this session — reload to start over.").
- **`RateLimitIpCard`** — new. Copy: "Too many chats from your network right now. Try again in a bit." No reload button (won't help).
- **`ServiceDownCard`** — new. Copy: "Service is temporarily unavailable. We're on it — try again in a bit." No reload, no immediate retry button (the operator has to fix it; user retrying just wastes attempts). Keep visual style consistent with the rate-limit cards.

## Files touched

**Modified:**
- `src/routes/api/chat.ts` — structured JSON on all non-OK responses; log `service_error` event on upstream failure
- `src/routes/chat.tsx` — error kind discrimination, dispatch, three cards

## Verification

Dev server running. Postgres up.

1. **Session cap:** `RATE_LIMIT_PER_SESSION=2 pnpm dev`. Browser: send 2 messages, then 3rd → session card renders. Input disabled. `SELECT kind FROM events WHERE kind='service_error'` — no rows (not a service error).
2. **IP cap:** `RATE_LIMIT_PER_IP_HOURLY=3 pnpm dev`. Cookie-cycle to hit 4th → IP card renders. Different copy, no reload.
3. **Service down (402 simulation):** temporarily edit `chat.ts` to force `max_tokens=1000000` (or overshoot credits deliberately). Browser: send a message → service-down card renders with generic copy. Server console shows the real 402 details. `SELECT kind, meta FROM events WHERE kind='service_error'` — one row with the upstream 402 status.
4. **Service down (missing api key):** unset `OPENROUTER_API_KEY` in the shell, restart dev. Send message → same service-down card (indistinguishable to user by design). Server 500. Restore.
5. **Retry bubble:** stop the dev server mid-send → network error → retry bubble on user message. Restart, tap retry → works.
6. **Normal flow:** no cards, chat streams as before.

## Notes / deferred concerns

- **Copy tone.** Placeholder copy is casual-formal. Real launch copy might want to be more brand-voice — happy to revise before shipping.
- **Retry button on `ServiceDownCard`.** Deliberately none. If we add "retry" and the underlying issue is 402 credits, every retry costs an upstream ping that also fails. Better UX: user notices the card, gives up gracefully, comes back later.
- **Operator alerting on service_error events.** Manual `psql` inspection for M2. Post-M2, wire up a simple email/webhook on new `service_error` rows (or query it from a Grafana panel once we have observability).
- **What about 402 upstream but rate limit not hit?** Bucketed as `service_unavailable`. From the user's perspective it's the same thing: "I can't chat right now, not my fault."
- **Server logging vs event logging.** `console.error` is transient (systemd journal); the `events` row is durable and queryable. Both, so operators have both real-time and historical visibility.
- **`upstream_body_snippet` truncation.** 500 chars is enough for OpenRouter's JSON error bodies. Larger bodies get truncated — a `[...]` marker signals it.
- **Client `MESSAGE_LIMIT` bumping.** We temporarily set this to 10000 during dev today. Restore to 50 before ship (matches server default). Not in scope for this step but flagging.
- **`rateLimitHitByCount` vs server flag.** Kept `rateLimitHitByCount` (client's local `userCount >= MESSAGE_LIMIT`) as a *fallback* trigger for the session card, so if the client counter hits the cap first (before a server round-trip), the card still renders. If server 429s first (env override lower than client's constant), the server flag wins.
