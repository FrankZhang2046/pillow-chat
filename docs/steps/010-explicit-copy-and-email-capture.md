# 010 — Explicit Landing Copy + Email Capture (Smoke Test)

## Context

The smoke test is live but two gaps limit the demand signal we get from it:

1. **Landing hero mock reads as friend-chat, not adult companion.** The current bubble ("Still thinking about that hiking trail…" at `src/routes/index.tsx:245`) demonstrates memory but misrepresents register — visitors who came for NSFW may bounce before entering, and 18+-only visitors get a misleading first impression of what the product actually is.
2. **We're not capturing anything from the ~99% of visitors who don't complete 50 messages.** `003-m2-smoke-test.md:27` deferred email capture as a login proxy, but the marketing strategy at `docs/marketing-strategy.md:89` calls out "email capture on the free tier from day one (owned audience)" as the SEO-diversification hedge. For a demand smoke test we want both: **wall email = high-intent conversion signal**, **landing email = owned audience for launch broadcast**.

**Intended outcome:** clearer product signal on the hero, and a two-surface email pipeline that feeds one `email_signups` table with source tagging so we can compare intent quality between the surfaces.

## Scope

**In**
- Replace the hiking-trail two-bubble mock with an explicit, memory-continuous exchange
- New `email_signups` table + migration
- `POST /api/email-signup` endpoint (validates, dedupes, per-IP daily cap, logs event)
- Landing-page email capture section (secondary — below the consent gate)
- Rate-limit-wall email capture (primary — swapped into `RateLimitSessionCard`)

**Out (explicit non-goals)**
- Double-opt-in / confirmation email — plaintext insert only; verification comes at productization
- Email sending infrastructure (Postmark/Resend/etc.) — we're collecting, not broadcasting yet
- Unsubscribe / preference center — nothing goes out, so nothing to unsubscribe from
- Email on `RateLimitIpCard` or `ServiceDownCard` — wrong intent (throttle / outage, not demand)
- Any change to the consent gate mechanics — client-side `localStorage.age_confirmed` stays

## Copy changes

### Landing hero mock (`src/routes/index.tsx:245` and the following user bubble at ~line 277)

Label above bubbles stays: **SHE REMEMBERS**.

- Assistant bubble → `still thinking about last night — the way you had me.`
- User bubble → `tell me what you want now`
- Timestamps stay (`YESTERDAY, 11:42 PM` and `JUST NOW`)

### Landing email capture (new section, below the consent gate)

Header: **Still in beta.**
Sub:    Sign up for development updates as memory and new features roll out.
Field:  `your email`
Button: **Sign up**
Success state (inline swap): `Thanks — you're on the list.`

### Rate-limit wall (`RateLimitSessionCard` in `src/routes/chat.tsx:650`)

Replace current body with:
- Line 1: You've hit the beta preview limit.
- Line 2: Sign up for development updates — memory, longer chats, and more coming.
- Field: `your email`
- Button: **Sign up**
- Secondary link (small, muted): `↻ Reload to start over`
- Success state: `Thanks — you're on the list.`

## Backend

### Schema — new table in `src/db/schema.ts`

```ts
export const emailSignups = pgTable(
  'email_signups',
  {
    id: uuid('id').primaryKey().$defaultFn(() => randomUUID()),
    email: text('email').notNull(),
    source: text('source').notNull(),            // 'landing' | 'wall'
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('email_signups_email_idx').on(t.email),
    index('email_signups_source_created_at_idx').on(t.source, t.createdAt),
  ],
)
```

Generate + run migration via existing scripts (`pnpm db:generate` → `pnpm db:migrate`).

### Endpoint — new `src/routes/api/email-signup.ts`

Contract:
- `POST /api/email-signup` with `{ email: string, source: 'landing' | 'wall' }`
- Reuses `getOrCreateSession` from `src/lib/session.ts` to attach `session_id` (nullable if cookieless).
- Reuses IP-hash pattern from `src/lib/rate-limit.ts` — SHA-256 the request IP into `ip_hash`.
- Validates: RFC-lite regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, length ≤ 254. Reject with `400 {error:'invalid_email'}`.
- Validates `source ∈ {'landing','wall'}`. Reject with `400 {error:'invalid_source'}`.
- Per-IP daily cap: **20 signups / ip_hash / 24h** (abuse guard). Reuse `ip_counters`-style upsert with a `day_bucket` OR simpler: `SELECT count(*) FROM email_signups WHERE ip_hash = $1 AND created_at > now() - interval '1 day'`. Prefer the SELECT — one table, no schema change; volume is trivially small.
- Insert with `ON CONFLICT (email) DO NOTHING`. Return `200 {ok:true}` regardless (don't leak which emails exist).
- Log `events` row: `kind='email_signup'`, `meta={source, was_new: bool}`.

### Rate-limit note

Do **not** count `/api/email-signup` toward the per-IP hourly chat cap — it's on a separate rate loop (daily). Guard is intentionally generous; the DB will catch actual abuse patterns via `ip_hash` grouping.

## Frontend

### `src/routes/index.tsx`

1. Update the two chat-mock bubbles (see Copy Changes above).
2. Add a new section between CONSENT GATE and FOOTER:
   - Container styled to match existing `background: 'oklch(0.14 0.04 350)'` gate card visually, but muted (lower opacity or darker) so it reads as secondary to the primary CTA.
   - Small `<EmailCaptureForm source="landing" />` local component with three states: `idle` (input+button) / `submitting` (disabled button, "Sending…") / `done` (thank-you text swap). Uses `fetch('/api/email-signup', ...)` — fire-and-forget from the user's POV, but await for state.
   - On network/validation failure: swap button label to `Try again` and keep the input value.

### `src/routes/chat.tsx`

1. Extract the `<EmailCaptureForm>` component to a shared file: `src/routes/-components/email-capture.tsx` (TanStack Router ignores `-` prefixed dirs). Import into both `index.tsx` and `chat.tsx`.
2. `RateLimitSessionCard` gets the new body + `<EmailCaptureForm source="wall" />`. The `↻ Reload chat` action moves to a small tertiary link under the success/idle form (still functional, just visually deprioritized).

## Files touched

**New**
- `src/routes/api/email-signup.ts`
- `src/routes/-components/email-capture.tsx`
- `src/db/migrations/000X_email_signups.sql` (generated)

**Modified**
- `src/db/schema.ts` — add `emailSignups` table
- `src/routes/index.tsx` — bubble copy at ~line 245/277; new email section before footer
- `src/routes/chat.tsx` — `RateLimitSessionCard` body + form
- `docs/steps/003-m2-smoke-test.md` — flip "email capture deferred" line to reference 010

## Verification

Walk end-to-end on the local dev server, then repeat on the VPS after deploy.

1. **Hero copy:** Landing page shows `still thinking about last night — the way you had me.` and `tell me what you want now` under the SHE REMEMBERS label. No hiking-trail text anywhere.
2. **Landing email happy path:** Submit valid email in landing form → success text swap. `psql`: `SELECT source, email FROM email_signups ORDER BY created_at DESC LIMIT 1;` → `('landing', <that email>)`. `SELECT kind, meta FROM events ORDER BY created_at DESC LIMIT 1;` → `email_signup / {source:'landing', was_new:true}`.
3. **Wall email happy path:** Send 50 messages → `RateLimitSessionCard` renders with email form. Submit → same success swap. DB row with `source='wall'`, `session_id` populated (not null). Event row logged.
4. **Duplicate email:** Submit same email again from either surface → still `200 ok`, still success swap, no new row (spot-check row count unchanged). Event row logged with `was_new:false`.
5. **Invalid email:** Submit `not-an-email` → button flips to `Try again`, no DB write, no event.
6. **Per-IP daily cap:** Script 21 signups from same IP → 21st returns `400`. Bucket resets after 24h (spot-check with a manual `UPDATE created_at`).
7. **Ip-limit / service-down cards unchanged:** trigger `429 rate_limit ip` and force `503 service_unavailable` — those cards render without the email form (regression guard).
8. **Reload link still works** on the rate-limit card (tertiary but present).
9. **Age gate untouched:** fresh browser → `/chat` still redirects to `/`.
