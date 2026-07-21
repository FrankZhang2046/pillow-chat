# Rate Limiting — how it works, what it protects, where it doesn't

**Status:** current as of 2026-07-21 (smoke test). See design in `docs/steps/007-rate-limits.md` and the email-signup addition in `docs/steps/010-explicit-copy-and-email-capture.md`.

## Threat model

The one thing rate limiting has to prevent: **someone burning our OpenRouter budget**. Everything else (fair queueing, brand protection, quota by user tier) is out of scope until productization.

**In scope**
- Casual abuse: someone loops `/api/chat` in a script.
- Cookie-cycling: same attacker clears cookies to farm free "sessions."
- Email flooding: someone loops `/api/email-signup` to spam or DoS our signup table.

**Out of scope (accepted risks — see §Known gaps)**
- Distributed attacks (many IPs, e.g. Tor / botnet / mobile-carrier NAT).
- Motivated attackers who read this doc.
- Token-cost blowup within the message budget (a legit user asking for a 200-token reply 200 times/hour is exactly at cost, by design).

## Enforcement points

All rate limiting is **app-layer**, Postgres-backed. Nginx (`docs/steps/009-vps-deployment.md:198-222`) is a plain `proxy_pass` with **no** `limit_req` directives — the app is the only gate.

### 1. Per-session chat cap

- **Code:** `src/lib/rate-limit.ts:15` — `if (sessionMessageCount >= env.RATE_LIMIT_PER_SESSION)`
- **Called from:** `src/routes/api/chat.ts:54`
- **Limit:** `RATE_LIMIT_PER_SESSION` env var, default `50`
- **State:** `sessions.message_count` — incremented in the same transaction that persists the user turn (`chat.ts:78-97`).
- **Response:** `429 {error:'rate_limit', reason:'session'}` with the "hit the free preview" copy.
- **Purpose:** engagement-depth signal + polite conversion nudge (the rate-limit card is where the email-capture form now lives, per 010). **Not** an abuse control — one `document.cookie = 'sid='` in DevTools resets it.

### 2. Per-IP hourly chat cap

- **Code:** `src/lib/rate-limit.ts:22-37` — upsert into `ip_counters`, then check `count > env.RATE_LIMIT_PER_IP_HOURLY`.
- **Limit:** `RATE_LIMIT_PER_IP_HOURLY` env var, default `200`
- **State:** `ip_counters(ip_hash, hour_bucket, count)` — primary key on `(ip_hash, hour_bucket)` (`src/db/schema.ts:61-72`). Hour bucket is `date_trunc('hour', now())` UTC.
- **Atomicity:** single upsert with `ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` — Postgres row lock prevents lost updates under concurrent requests.
- **Identity:** `hashClientIp(request)` at `src/lib/session.ts:44-46` — SHA-256 of the first `x-forwarded-for` entry, falling back to `x-real-ip`, then the literal string `'local'`.
- **Purpose:** the actual cost containment. This is the line between "engaged users" and "someone farming free chats."
- **Bypass:** none by cookie rotation (IP is what's counted). See §Known gaps for the actual bypasses.

### 3. Per-IP daily email-signup cap

- **Code:** `src/routes/api/email-signup.ts:52-64` — `SELECT count(*) FROM email_signups WHERE ip_hash = $1 AND created_at > now() - interval '1 day'`.
- **Limit:** hardcoded `20` signups per `ip_hash` per rolling 24h (`PER_IP_DAILY_CAP` at line 8).
- **Response:** `429 {error:'rate_limit'}`.
- **Purpose:** stops someone stuffing the signup table (list-poisoning, database bloat, competitor sabotage). Unrelated to the chat budget.
- **Note:** rolling window derived from `created_at`, not a bucket — slightly more expensive query but volume is trivial (few hundred rows/day expected).

## What actually protects the budget

At the intended defaults, a single IP is capped at **200 chat completions/hour**. With `max_tokens: 200` (`chat.ts:114`) and a persona-card + short history in the request, that's roughly:

- ~500 input tokens × 200 msgs = 100k input tokens/hr
- ~200 output tokens × 200 msgs = 40k output tokens/hr

At OpenRouter Magnum-v4-72b list prices, that ceilings at low single-digit dollars per hour **per IP**. Order of magnitude, not exact — check the OpenRouter dashboard for the real number if this matters.

The `sessions.message_count` cap (50) means each cookie is worth ≤50 messages, so a single browser tab can't get past a small fraction of the IP cap without shenanigans.

## Admin bypass

`src/lib/rate-limit.ts:13` — `if (isAdmin(request)) return { ok: true }` short-circuits both checks. Admin identity comes from the `admin_token` cookie compared against `ADMIN_TOKEN` env var (`src/lib/session.ts:59-62`). When unset, `isAdmin()` returns `false` unconditionally, so no accidental bypass. Setup instructions live at `docs/ops/auth-setup.md`.

## Kill switches (operator escape hatches)

Order from "gentle" to "nuclear":

1. **Tighten the IP cap** — edit `/etc/companion-bot.env`, drop `RATE_LIMIT_PER_IP_HOURLY` to (say) `20`, `sudo systemctl restart companion-bot`. Legit users mostly unaffected, attackers throttled.
2. **Kill all chat traffic** — same file, set `RATE_LIMIT_PER_IP_HOURLY=0`, restart. Every request 429s. Documented at `docs/steps/003-m2-smoke-test.md:145` and `009-vps-deployment.md:291`. This is the panic button.
3. **Kill the app** — `sudo systemctl stop companion-bot`. Nginx will return 502; frontend renders `ServiceDownCard`.
4. **Pull the OpenRouter key** — rotate the key in the OpenRouter dashboard, remove/replace in `/etc/companion-bot.env`, restart. Guaranteed spend stops regardless of app bugs.

## Observability (such as it is)

No dashboard, no alerts. Ad-hoc queries:

```sql
-- current-hour spend risk by IP
SELECT ip_hash, count FROM ip_counters
WHERE hour_bucket = date_trunc('hour', now())
ORDER BY count DESC LIMIT 20;

-- IPs that hit the per-hour ceiling in the last 24h
SELECT ip_hash, hour_bucket, count FROM ip_counters
WHERE count > 200 AND hour_bucket > now() - interval '1 day'
ORDER BY hour_bucket DESC;

-- session-cap hits (via events table if wired) or by looking for 50-count sessions:
SELECT count(*) FROM sessions WHERE message_count >= 50;

-- email-signup daily-cap pressure
SELECT ip_hash, count(*) FROM email_signups
WHERE created_at > now() - interval '1 day'
GROUP BY ip_hash ORDER BY count(*) DESC LIMIT 10;
```

The OpenRouter dashboard is the ground truth for spend. Check it daily during the smoke test.

## Known gaps

Ordered by realistic exploit likelihood.

1. **No global spend cap.** Nothing sums across IPs. A distributed attack (100 IPs × 200 msg/hr = 20k msg/hr) is not throttled by anything in this codebase. Mitigation available only via OpenRouter's own per-key spend limits — set a **monthly cap on the key itself** in the OpenRouter dashboard. If we haven't done that, do it now.
2. **XFF trust is nginx-dependent.** `hashClientIp` reads `x-forwarded-for` verbatim (`src/lib/session.ts:37-38`). Nginx sets it correctly. If the app is ever exposed without nginx in front — or if nginx config drifts and stops setting XFF — the header becomes attacker-spoofable and per-IP limits become worthless (every request looks like a new IP). Flagged in `003-m2-smoke-test.md:142`.
3. **Cookie-cycling within the IP cap.** Session cap (50) is worthless against a script; only the IP cap (200/hr) really matters. This is intentional (session cap is a UX/engagement thing) but worth naming: a bad actor gets 200 free messages/hr per IP, not 50.
4. **Nginx has no `limit_req`.** All rate limiting is inside the app, which means the app must accept the connection, parse the JSON, run session lookup, and hit Postgres just to return a 429. A high-QPS flood is a cheap DoS on our compute even if it doesn't reach OpenRouter. Cheap mitigation: add `limit_req_zone $binary_remote_addr zone=chat:10m rate=5r/s` to the nginx config in front of `/api/chat`.
5. **No captcha, no proof-of-work, no fingerprinting.** A headless-browser script defeats every check here. Accepted risk for smoke test — visible in `docs/steps/007-rate-limits.md` §Context ("Neither is bulletproof security").
6. **Assistant tokens count as one "message" regardless of size.** `max_tokens: 200` caps a single reply, but there's no per-hour token-count limit — only a per-hour message-count limit. If we ever raise `max_tokens`, the IP cap protects less than it appears to.

## Recommendations before we widely publicize

Cheap wins, in order:

1. Set an OpenRouter monthly spend cap on the API key (gap #1). **This is the single most important line of defense** and it's outside the app entirely.
2. Add `limit_req` to nginx in front of `/api/chat` (gap #4). Blocks compute exhaustion before it reaches the app.
3. Lower `RATE_LIMIT_PER_IP_HOURLY` from 200 → something like 60 once we have real usage data on what "normal" looks like.
4. Cron a query that pages/emails on any `ip_counters` row where `count > 500` in the last hour (gap #1 detection, not prevention).

Everything else (captcha, fingerprinting, tier limits, token-budget enforcement) is productization work — don't build for it during smoke test.
