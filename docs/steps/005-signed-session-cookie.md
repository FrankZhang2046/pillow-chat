# 005 — Signed Session Cookie

## Context

Extracted from `003-m2-smoke-test.md` §3. This is the plumbing that gives every anonymous visitor a stable, tamper-resistant identity across requests. Everything downstream that touches "who is this?" — message attribution, per-session rate limit, funnel events — reads the `sessions.id` produced here.

**Why HMAC-signed and not plain UUID:** if the cookie is just `sid=<uuid>`, anyone who knows a session's UUID (leaked log line, XSS-adjacent JS, shoulder-surf) can impersonate that session — send messages that get attributed to it, hit its rate-limit counter, etc. HMAC-signing binds the UUID to a server-side secret; forging a valid cookie requires the secret.

**Why no third-party session lib** (iron-session, next-auth, etc.): the surface area here is small — one UUID, one HMAC, one cookie — and every session lib brings assumptions we don't want (JWT bloat, encryption we don't need, framework coupling). Node built-ins fit cleanly.

**Why now:** Task #6 (chat persistence) and Task #5 (rate limits) both need `getOrCreateSession(request)` as their entry point. Building it first, in isolation, means those downstream tasks become "swap in one function" instead of "invent auth from scratch."

## Scope

**In:**
- `src/lib/session.ts` with `getOrCreateSession(request): Promise<{ session, setCookieHeader? }>`
- `SESSION_SECRET` env var (32-byte hex) added to `env.ts`, `.env`, `.env.example`
- Minimal wire-up in `src/routes/api/chat.ts`: call `getOrCreateSession` at handler entry, attach `setCookieHeader` on the SSE response. No rate-limit or message persistence yet — those land in Tasks #5 + #6.
- IP hashing helper (SHA-256 of the client IP) — small enough to inline in `session.ts`

**Out (deferred to later steps):**
- Rate-limit reads/writes against `sessions.message_count` (Task #5)
- Message insert/persistence in the chat handler (Task #6)
- `/api/consent` calling `getOrCreateSession` (Task #7 — will re-use this lib unchanged)
- Cookie rotation on IP change / suspicion (out of M2 entirely)
- Encryption of cookie payload (unnecessary — UUID isn't sensitive, HMAC is enough)

## Approach

### 1. Env

- Add `SESSION_SECRET` to `.env.example` (value: `<generate with: openssl rand -hex 32>`)
- Add `SESSION_SECRET` to `.env` — generate a real value locally
- Extend `src/lib/env.ts` to add `SESSION_SECRET: required('SESSION_SECRET')`

### 2. `src/lib/session.ts`

Signature:
```ts
export type Session = typeof sessions.$inferSelect  // Drizzle-inferred row type
export async function getOrCreateSession(request: Request): Promise<{
  session: Session
  setCookieHeader?: string
}>
```

Cookie format: `sid=<uuid>.<hmac_hex>`
Attrs: `HttpOnly; SameSite=Lax; Max-Age=7776000; Path=/` — plus `Secure` when `NODE_ENV === 'production'`.

Logic:
1. Parse `Cookie` header from `request.headers.get('cookie')`. Extract `sid` value.
2. If present, split on `.` into `[uuid, hmac]`.
3. Recompute HMAC-SHA256 of `uuid` using `SESSION_SECRET`, compare in constant time via `crypto.timingSafeEqual`.
4. **On cookie hit:** run `UPDATE sessions SET last_seen_at = now() WHERE id = $uuid RETURNING *`. If a row comes back, return `{ session: row }` with no `setCookieHeader` (browser already has the correct cookie).
5. **On cookie miss** (missing / malformed / bad HMAC / no row found):
   - Generate `uuid = randomUUID()`
   - Compute `ipHash = sha256(clientIp(request))` where `clientIp` reads `x-forwarded-for` (first hop), fallback `x-real-ip`, fallback string `'local'` for dev
   - Extract `userAgent = request.headers.get('user-agent')`
   - `INSERT INTO sessions (id, ip_hash, user_agent) VALUES ($uuid, $ipHash, $userAgent) RETURNING *`
   - Compute `hmac = hmacSha256Hex(SESSION_SECRET, uuid)`
   - Build `setCookieHeader = 'sid=' + uuid + '.' + hmac + '; HttpOnly; SameSite=Lax; Max-Age=7776000; Path=/' + (prod ? '; Secure' : '')`
   - Return `{ session: row, setCookieHeader }`

Node primitives used: `crypto.createHmac`, `crypto.randomUUID`, `crypto.createHash`, `crypto.timingSafeEqual`. No npm dep.

### 3. Wire into `/api/chat`

Minimal, non-invasive edit to `src/routes/api/chat.ts`:
- At top of `POST` handler (after JSON parse), call `const { setCookieHeader } = await getOrCreateSession(request)`. Discard `session` — it's used in Task #5/#6.
- When constructing the final streaming `Response`, merge `Set-Cookie: setCookieHeader` into the headers if present.
- Also merge on the two early-return error responses (400 invalid JSON, 500 no api key, upstream error passthrough) so the cookie lands even on failures.

Note: this is intentionally a shallow wire-up. Task #6 will restructure this handler entirely — the point here is to have session creation working end-to-end and testable.

### 4. Env boot check

After extending env.ts, unset SESSION_SECRET in a shell → `pnpm db:migrate` (or any command that imports env.ts) should throw `Missing required env var: SESSION_SECRET`. Restore.

## Files touched

**New:**
- `src/lib/session.ts`

**Modified:**
- `src/lib/env.ts` — add `SESSION_SECRET`
- `.env` — append `SESSION_SECRET=<64 hex chars>`
- `.env.example` — append `SESSION_SECRET=<placeholder>`
- `src/routes/api/chat.ts` — call `getOrCreateSession`, attach `Set-Cookie` to responses

## Verification

End-to-end:

1. `openssl rand -hex 32` → paste result into `.env` as `SESSION_SECRET=`
2. `pnpm dev` boots without error
3. Fresh browser (incognito), visit `/`, click through consent, send a chat message
4. `docker exec -it pillow-pg psql -U postgres -c 'SELECT id, ip_hash, user_agent, message_count FROM sessions'` → one row with the browser's UA (message_count still 0 — Task #6 will bump it)
5. Browser DevTools → Application → Cookies → `sid` present, HttpOnly ✓, SameSite=Lax ✓, expires ~90 days out
6. Send another message → same session row, `last_seen_at` bumped
7. Clear cookies, send message → new row in `sessions` (count now 2)
8. Manually tamper with cookie in DevTools (change one hex char in the HMAC), send message → new row created (invalid cookie treated as missing), no 500 error
9. Unset `SESSION_SECRET` in `.env` and re-run any `pnpm tsx` script → clear `Missing required env var` error. Restore.
10. `psql -c 'SELECT count(*) FROM sessions'` after all the above → matches expected session count from steps 3–8

## Notes / deferred concerns

- **IP source trust.** Local dev falls back to `'local'` string (hashed) so we don't blow up when no `x-forwarded-for` is present. Prod behind Nginx will have XFF. If the app is ever exposed without Nginx (or a proxy that spoofs XFF), IP-based dedup silently collapses. Flag for `docs/ops/vps-setup.md`.
- **Timing-safe HMAC compare.** Using `crypto.timingSafeEqual` and not string `===`. Overkill at M2 traffic levels, but the cost is one line and future-proofs.
- **Cookie name `sid`.** Short, generic. Low collision risk at M2 scale. If we ever ship third-party libs that use `sid`, rename to `_pillow_sid`.
- **`Max-Age=7776000`** = 90 days. Matches the retention window from 003 §8, so cookies don't outlive their DB rows.
- **Cookie payload is UUID + HMAC, not encrypted.** UUID is not sensitive on its own; HMAC prevents forgery. If we ever add anything actually sensitive into the cookie, revisit.
- **`session.id` type is `string`, not `Buffer`/`Uint8Array`.** Drizzle returns `uuid` columns as string, and we sign the string form. Keep everything as strings end-to-end to avoid encoding footguns.
